// Package container manages one bot container on an SSH host. It reads the
// remote .env and compose files, reports the runtime status, and later installs
// and publishes configuration through the same small Host interface.
package container

import (
	"context"
	_ "embed"
	"errors"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

// Host is the subset of the host clients the container service needs. Tests
// inject a fake so no network is required.
type Host interface {
	Run(ctx context.Context, command string, stdin []byte) (hostexec.Result, error)
	ReadFile(ctx context.Context, path string) ([]byte, error)
	WriteFileAtomic(ctx context.Context, path string, data []byte, mode os.FileMode) error
}

// Dialer returns a host client for target.
type Dialer func(target domain.Target) (Host, error)

// ImageRepository is the registry path the compose file pulls from.
const ImageRepository = "ghcr.io/deskwand/bot"

const commandTimeout = 30 * time.Second

// lockWait bounds how long a deploy waits for a backup or restore of the same
// target before telling the user to come back later.
const lockWait = 60 * time.Second

// Locker serializes an operation that rewrites a target against a backup or a
// restore of the same target. *deployment.TargetLocker implements it.
type Locker interface {
	Lock(ctx context.Context, target domain.Target) (func(), error)
}

// Options configures the container service.
type Options struct {
	Dial    Dialer
	Version string                                           // release version bundled with the client
	Sleep   func(ctx context.Context, d time.Duration) error // defaults to a context-aware wait
	Locale  func() string                                    // "zh" | "en"
	Locker  Locker                                           // nil means no serialization with backups
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

// lockTarget waits for the target lock so a deploy cannot recreate the
// container in the middle of a backup or a restore of the same target. A
// restore can hold it for its whole run, so the wait is bounded: an operation
// that cannot start within lockWait reports why instead of hanging for half an
// hour.
func (s *Service) lockTarget(ctx context.Context, target domain.Target) (func(), error) {
	if s.options.Locker == nil {
		return func() {}, nil
	}
	waitCtx, cancel := context.WithTimeout(ctx, lockWait)
	defer cancel()
	unlock, err := s.options.Locker.Lock(waitCtx, target)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			return nil, domain.Error{
				Code:    backup.CodeMaintenanceBusy,
				Message: "a backup or restore of this deployment is running; try again when it finishes",
			}
		}
		return nil, err
	}
	return unlock, nil
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

// StopTarget stops the container, keeping its volume and .env.
func (s *Service) StopTarget(ctx context.Context, target domain.Target) error {
	unlock, err := s.lockTarget(ctx, target)
	if err != nil {
		return err
	}
	defer unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	host, err := s.dial(target)
	if err != nil {
		return err
	}
	return s.engine(target).Stop(ctx, host, target.Host.Dir)
}

// StartTarget brings a stopped container back up.
func (s *Service) StartTarget(ctx context.Context, target domain.Target) error {
	unlock, err := s.lockTarget(ctx, target)
	if err != nil {
		return err
	}
	defer unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	host, err := s.dial(target)
	if err != nil {
		return err
	}
	return s.engine(target).Start(ctx, host, target.Host.Dir)
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
