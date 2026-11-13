// Package container manages one bot container on an SSH host. It reads the
// remote .env and compose files, reports the runtime status, and later installs
// and publishes configuration through the same small Host interface.
package container

import (
	"context"
	_ "embed"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/sshhost"
)

// Host is the subset of sshhost.Client the container service needs. Tests
// inject a fake so no network is required.
type Host interface {
	Run(ctx context.Context, command string, stdin []byte) (sshhost.Result, error)
	ReadFile(ctx context.Context, path string) ([]byte, error)
	WriteFileAtomic(ctx context.Context, path string, data []byte, mode os.FileMode) error
}

// Dialer returns a host client for target.
type Dialer func(target domain.Target) (Host, error)

// ImageRepository is the registry path the compose file pulls from.
const ImageRepository = "ghcr.io/deskwand/bot"

const commandTimeout = 30 * time.Second

// Options configures the container service.
type Options struct {
	Dial    Dialer
	Version string                                           // release version bundled with the client
	Sleep   func(ctx context.Context, d time.Duration) error // defaults to a context-aware wait
	Locale  func() string                                    // "zh" | "en"
}

// Service implements snapshot, status, preflight, install, and publish against
// a Host.
type Service struct {
	options Options
	// mu serializes operations that write the remote container.
	mu sync.Mutex
}

// New constructs a container service.
func New(options Options) *Service {
	return &Service{options: options}
}

func (s *Service) sleep(ctx context.Context, d time.Duration) error {
	if s.options.Sleep != nil {
		return s.options.Sleep(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *Service) dial(target domain.Target) (Host, error) {
	return s.options.Dial(target)
}

//go:embed env-allowlist.txt
var allowlistData []byte

var (
	allowedKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	allowlistExact    = make(map[string]bool)
	allowlistPrefixes []string
)

var plainVars = map[string]bool{
	"DESKWAND_CONFIG": true,
	"ACTIVE_CHANNEL":  true,
	"PUBLIC_BASE_URL": true,
}

func init() {
	for _, line := range strings.Split(string(allowlistData), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if prefix, ok := strings.CutSuffix(line, "*"); ok {
			allowlistPrefixes = append(allowlistPrefixes, prefix)
			continue
		}
		allowlistExact[line] = true
	}
}

// Allowed reports whether name may appear in the remote .env.
func Allowed(name string) bool {
	if !allowedKeyPattern.MatchString(name) {
		return false
	}
	if allowlistExact[name] {
		return true
	}
	for _, prefix := range allowlistPrefixes {
		if len(name) > len(prefix) && strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// IsPlainVar reports whether the .env key carries a non-secret value.
func IsPlainVar(name string) bool {
	return plainVars[name]
}
