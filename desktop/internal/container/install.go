package container

import (
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/hostexec"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Check is one preflight result.
type Check struct {
	// ID names the check. The Docker-compatible engine reports "docker" |
	// "compose" | "permission" | "arch" | "port" | "dir"; the Apple
	// container engine reports "container" | "version" | "service" |
	// "arch" | "port" | "dir". The sets differ per engine, and local mode
	// drops "permission" from the Docker-compatible one.
	ID     string
	OK     bool
	Detail string // one localized sentence
	Fix    string // a copyable repair command; empty when there is none
}

// PreflightReport lists the preflight checks in a fixed order.
type PreflightReport struct {
	Checks   []Check // per engine; see Check.ID
	Existing bool    // the remote directory already holds this project's compose.yaml and .env
}

// Passed reports whether every check succeeded.
func (r PreflightReport) Passed() bool {
	for _, check := range r.Checks {
		if !check.OK {
			return false
		}
	}
	return true
}

//go:embed compose.yaml.tmpl
var composeTemplate []byte

// ComposeFile returns the compose file for the given release version.
func ComposeFile(version string) []byte {
	return []byte(strings.ReplaceAll(string(composeTemplate), "{{VERSION}}", version))
}

func (s *Service) locale() string {
	if s.options.Locale == nil {
		return i18n.ZH
	}
	return s.options.Locale()
}

func (s *Service) text(id string, ok bool) string {
	suffix := ".fail"
	if ok {
		suffix = ".ok"
	}
	return i18n.T(s.locale(), "container.check."+id+suffix)
}

// message returns one container message verbatim, for the texts that are not
// an ok/fail pair.
func (s *Service) message(key string) string {
	return i18n.T(s.locale(), "container.check."+key)
}

func runOnHost(ctx context.Context, host Host, command string) (hostexec.Result, error) {
	commandCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return host.Run(commandCtx, command, nil)
}

func readFileOnHost(ctx context.Context, host Host, path string) ([]byte, error) {
	readCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return host.ReadFile(readCtx, path)
}

// checkDir checks that dir is writable and already holds this project's
// files. other lists another engine's start files: a directory that holds one
// of them belongs to that engine. The caller fills in Detail, because the
// message differs per engine.
func checkDir(ctx context.Context, host Host, dir, manifestPath string, other []string) (Check, bool, error) {
	check := Check{ID: "dir"}
	existing := false
	quoted := hostexec.QuotePath(dir)
	result, err := runOnHost(ctx, host, fmt.Sprintf("mkdir -p %s && test -w %s", quoted, quoted))
	if err != nil {
		return Check{}, false, err
	}
	if result.ExitCode != 0 {
		return check, false, nil
	}
	for _, path := range other {
		if _, err := readFileOnHost(ctx, host, path); err == nil {
			return check, false, nil
		} else if !errors.Is(err, hostexec.ErrNotExist) {
			return Check{}, false, err
		}
	}
	data, err := readFileOnHost(ctx, host, manifestPath)
	switch {
	case errors.Is(err, hostexec.ErrNotExist):
		check.OK = true
	case err != nil:
		return Check{}, false, err
	case !strings.Contains(string(data), ImageRepository):
	default:
		if _, envErr := readFileOnHost(ctx, host, envPath(dir)); envErr == nil {
			check.OK = true
			existing = true
		} else if !errors.Is(envErr, hostexec.ErrNotExist) {
			return Check{}, false, envErr
		}
	}
	return check, existing, nil
}

// Preflight checks that the host can run the container. It never installs
// anything and never writes to the remote directory.
func (s *Service) Preflight(ctx context.Context, target domain.Target) (PreflightReport, error) {
	host, err := s.dial(target)
	if err != nil {
		return PreflightReport{}, err
	}
	return s.engine(target).Preflight(ctx, host, target.Host.Dir)
}

// InstallRequest is the configuration for a fresh container install.
type InstallRequest struct {
	ConfigJSON    []byte              // the complete DESKWAND_CONFIG
	ActiveChannel string              // "telegram" | "wechat"
	Secrets       []domain.SecretEdit // all replace edits; at least one MODEL_KEY_*
}

func invalidRequest(message string) error {
	return domain.Error{Code: "INVALID_REQUEST", Message: message}
}

// Install writes the compose file and .env, then starts the container.
func (s *Service) Install(ctx context.Context, target domain.Target, request InstallRequest, onStep func(domain.Step)) (domain.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	report, err := s.Preflight(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}
	if !report.Passed() {
		for _, check := range report.Checks {
			if check.OK {
				continue
			}
			message := check.ID + ": " + check.Detail
			if target.Host.IsLocal() {
				// A local check names what to fix, so it is a request problem.
				return domain.Result{}, invalidRequest(message)
			}
			return domain.Result{}, domain.Error{Code: domain.DOCKER_UNAVAILABLE, Message: message}
		}
	}
	if report.Existing {
		key := "container.installExisting"
		if target.Host.IsLocal() {
			key = "container.installExisting.local"
		}
		return domain.Result{}, invalidRequest(i18n.T(s.locale(), key))
	}

	engine := s.engine(target)
	envData, err := s.installEnv(request, engine.Dialect())
	if err != nil {
		return domain.Result{}, err
	}

	host, err := s.dial(target)
	if err != nil {
		return domain.Result{}, err
	}
	dir := target.Host.Dir
	manifestID, applyID := engine.StepIDs()

	s.beginStep(onStep, manifestID)
	if err := engine.WriteManifest(ctx, host, dir, s.options.Version); err != nil {
		s.endStep(onStep, manifestID, "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, manifestID, "completed")

	s.beginStep(onStep, "write-env")
	if err := host.WriteFileAtomic(ctx, envPath(dir), envData, 0o600); err != nil {
		s.endStep(onStep, "write-env", "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, "write-env", "completed")

	s.beginStep(onStep, "pull")
	if err := engine.Pull(ctx, host, dir); err != nil {
		s.endStep(onStep, "pull", "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, "pull", "completed")

	s.beginStep(onStep, applyID)
	if err := engine.Apply(ctx, host, dir); err != nil {
		s.endStep(onStep, applyID, "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, applyID, "completed")

	s.beginStep(onStep, "healthy")
	if err := s.waitHealthy(ctx, target, request.Secrets); err != nil {
		s.endStep(onStep, "healthy", "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, "healthy", "completed")

	return domain.Result{State: "published", VersionID: "container:" + s.options.Version}, nil
}

var stepKeys = map[string]string{
	"write-compose": "writeCompose",
	"write-agent":   "writeAgent",
	"write-env":     "writeEnv",
	"pull":          "pull",
	"up":            "up",
	"register":      "register",
	"healthy":       "healthy",
	"restart":       "restart",
	"rollback":      "rollback",
}

func (s *Service) beginStep(onStep func(domain.Step), id string) {
	s.reportStep(onStep, id, "applying")
}

func (s *Service) endStep(onStep func(domain.Step), id, state string) {
	s.reportStep(onStep, id, state)
}

func (s *Service) reportStep(onStep func(domain.Step), id, state string) {
	if onStep == nil {
		return
	}
	onStep(domain.Step{
		ID:      id,
		State:   state,
		Message: i18n.T(s.locale(), "container.step."+stepKeys[id]),
	})
}

func dockerError(result hostexec.Result) error {
	message := lastLines(result.Stderr, 20)
	if message == "" {
		message = lastLines(result.Stdout, 20)
	}
	return domain.Error{Code: domain.DOCKER_UNAVAILABLE, Message: message}
}

func lastLines(data []byte, count int) string {
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, "\n")
}

func (s *Service) waitHealthy(ctx context.Context, target domain.Target, secrets []domain.SecretEdit) error {
	const attempts = 60
	for attempt := 0; attempt < attempts; attempt++ {
		status, err := s.Status(ctx, target)
		if err != nil {
			return err
		}
		if status.Health == "healthy" {
			return nil
		}
		if err := s.sleep(ctx, 3*time.Second); err != nil {
			return err
		}
	}

	host, err := s.dial(target)
	if err != nil {
		return err
	}
	message, err := s.engine(target).Logs(ctx, host, target.Host.Dir)
	if err != nil {
		return err
	}
	for _, secret := range secrets {
		if value := secret.Value(); value != "" {
			message = strings.ReplaceAll(message, value, domain.RedactedValue)
		}
	}
	return domain.Error{Code: domain.CONTAINER_UNHEALTHY, Message: message}
}

// installEnv builds the remote .env. It validates everything before the
// caller writes anything.
func (s *Service) installEnv(request InstallRequest, dialect envfile.Dialect) ([]byte, error) {
	for _, secret := range request.Secrets {
		if !Allowed(secret.Name) || IsPlainVar(secret.Name) {
			return nil, invalidRequest("not a writable secret name: " + secret.Name)
		}
	}
	hasModelKey := false
	for _, secret := range request.Secrets {
		if strings.HasPrefix(secret.Name, "MODEL_KEY_") {
			hasModelKey = true
		}
	}
	if !hasModelKey {
		return nil, domain.Error{Code: domain.MODEL_KEY_MISSING}
	}

	var compact bytes.Buffer
	if err := json.Compact(&compact, request.ConfigJSON); err != nil {
		return nil, invalidRequest("DESKWAND_CONFIG is not valid JSON")
	}

	adminBytes := make([]byte, 32)
	if _, err := rand.Read(adminBytes); err != nil {
		return nil, err
	}
	adminToken := hex.EncodeToString(adminBytes)

	sandboxBytes := make([]byte, 32)
	if _, err := rand.Read(sandboxBytes); err != nil {
		return nil, err
	}
	sandboxToken := hex.EncodeToString(sandboxBytes)

	file, err := envfile.ParseDialect(nil, dialect)
	if err != nil {
		return nil, err
	}
	set := func(name, value string) error {
		if err := file.Set(name, value); err != nil {
			if errors.Is(err, envfile.ErrUnrepresentable) {
				return envFileError("a secret value cannot be written safely")
			}
			return invalidRequest("invalid .env key: " + name)
		}
		return nil
	}
	for _, secret := range request.Secrets {
		if err := set(secret.Name, secret.Value()); err != nil {
			return nil, err
		}
	}
	for _, entry := range []struct{ name, value string }{
		{"ADMIN_TOKEN", adminToken},
		{"ACTIVE_CHANNEL", request.ActiveChannel},
		{"DESKWAND_CONFIG", compact.String()},
		// The sandbox service interpolates SANDBOX_TOKEN out of this file; the
		// bot reads both variables to reach it.
		{"SANDBOX_URL", "http://sandbox:8080"},
		{"SANDBOX_TOKEN", sandboxToken},
	} {
		if err := set(entry.name, entry.value); err != nil {
			return nil, err
		}
	}
	return file.Bytes(), nil
}
