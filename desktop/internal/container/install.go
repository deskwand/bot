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
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/sshhost"
)

// Check is one preflight result.
type Check struct {
	ID     string // "docker" | "compose" | "permission" | "arch" | "port" | "dir"
	OK     bool
	Detail string // one localized sentence
	Fix    string // a copyable repair command; empty when there is none
}

// PreflightReport lists the preflight checks in a fixed order.
type PreflightReport struct {
	Checks   []Check // docker, compose, permission, arch, port, dir
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

func (s *Service) run(ctx context.Context, host Host, command string) (sshhost.Result, error) {
	commandCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return host.Run(commandCtx, command, nil)
}

const (
	dockerVersionCommand  = `docker version --format '{{.Server.Version}}'`
	composeVersionCommand = `docker compose version --short`
	archCommand           = `uname -m`
	portCommand           = `ss -ltnH 'sport = :8787' 2>/dev/null || true`
)

// Preflight checks that the host can run the container. It never installs
// anything and never writes to the remote directory.
func (s *Service) Preflight(ctx context.Context, target domain.Target) (PreflightReport, error) {
	host, err := s.dial(target)
	if err != nil {
		return PreflightReport{}, err
	}
	dir := target.Host.Dir
	quoted := sshhost.QuotePath(dir)

	version, err := s.run(ctx, host, dockerVersionCommand)
	if err != nil {
		return PreflightReport{}, err
	}
	permissionDenied := strings.Contains(strings.ToLower(string(version.Stderr)), "permission denied")
	notFound := version.ExitCode == 127 || strings.Contains(strings.ToLower(string(version.Stderr)), "not found")
	docker := Check{ID: "docker"}
	permission := Check{ID: "permission"}
	switch {
	case permissionDenied:
		docker.OK = true
		docker.Detail = s.text("docker", true)
		permission.Detail = s.text("permission", false)
		permission.Fix = "sudo usermod -aG docker $USER"
	case notFound:
		docker.Detail = s.text("docker", false)
		docker.Fix = "curl -fsSL https://get.docker.com | sh"
		permission.OK = true
		permission.Detail = s.text("permission", true)
	default:
		docker.OK = version.ExitCode == 0
		docker.Detail = s.text("docker", docker.OK)
		if !docker.OK {
			// Installed but not answering: the daemon is stopped.
			docker.Fix = "sudo systemctl start docker"
		}
		permission.OK = true
		permission.Detail = s.text("permission", true)
	}

	compose := Check{ID: "compose"}
	if !docker.OK || !permission.OK {
		compose.Detail = s.text("compose", false)
	} else {
		composeResult, err := s.run(ctx, host, composeVersionCommand)
		if err != nil {
			return PreflightReport{}, err
		}
		compose.OK = composeResult.ExitCode == 0
		compose.Detail = s.text("compose", compose.OK)
		if !compose.OK {
			compose.Fix = "sudo apt-get install -y docker-compose-plugin"
		}
	}

	arch := Check{ID: "arch"}
	archResult, err := s.run(ctx, host, archCommand)
	if err != nil {
		return PreflightReport{}, err
	}
	machine := strings.TrimSpace(string(archResult.Stdout))
	arch.OK = archResult.ExitCode == 0 && (machine == "x86_64" || machine == "aarch64")
	arch.Detail = s.text("arch", arch.OK)

	dirCheck := Check{ID: "dir"}
	existing := false
	dirResult, err := s.run(ctx, host, fmt.Sprintf("mkdir -p %s && test -w %s", quoted, quoted))
	if err != nil {
		return PreflightReport{}, err
	}
	if dirResult.ExitCode != 0 {
		dirCheck.Detail = s.text("dir", false)
	} else {
		composeData, readErr := s.readFile(ctx, host, composePath(dir))
		switch {
		case errors.Is(readErr, sshhost.ErrNotExist):
			dirCheck.OK = true
			dirCheck.Detail = s.text("dir", true)
		case readErr != nil:
			return PreflightReport{}, readErr
		case !strings.Contains(string(composeData), ImageRepository):
			dirCheck.Detail = s.text("dir", false)
		default:
			if _, envErr := s.readFile(ctx, host, envPath(dir)); envErr == nil {
				dirCheck.OK = true
				dirCheck.Detail = s.text("dir", true)
				existing = true
			} else if errors.Is(envErr, sshhost.ErrNotExist) {
				dirCheck.Detail = s.text("dir", false)
			} else {
				return PreflightReport{}, envErr
			}
		}
	}

	port := Check{ID: "port"}
	if existing {
		port.OK = true
		port.Detail = s.text("port", true)
	} else {
		portResult, err := s.run(ctx, host, portCommand)
		if err != nil {
			return PreflightReport{}, err
		}
		port.OK = strings.TrimSpace(string(portResult.Stdout)) == ""
		port.Detail = s.text("port", port.OK)
	}

	return PreflightReport{
		Checks:   []Check{docker, compose, permission, arch, port, dirCheck},
		Existing: existing,
	}, nil
}

func (s *Service) readFile(ctx context.Context, host Host, path string) ([]byte, error) {
	readCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return host.ReadFile(readCtx, path)
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
			if !check.OK {
				return domain.Result{}, domain.Error{
					Code:    domain.DOCKER_UNAVAILABLE,
					Message: check.ID + ": " + check.Detail,
				}
			}
		}
	}
	if report.Existing {
		return domain.Result{}, invalidRequest(i18n.T(s.locale(), "container.installExisting"))
	}

	envData, err := s.installEnv(request)
	if err != nil {
		return domain.Result{}, err
	}

	host, err := s.dial(target)
	if err != nil {
		return domain.Result{}, err
	}
	dir := target.Host.Dir
	quoted := sshhost.QuotePath(dir)

	s.beginStep(onStep, "write-compose")
	if err := host.WriteFileAtomic(ctx, composePath(dir), ComposeFile(s.options.Version), 0o644); err != nil {
		s.endStep(onStep, "write-compose", "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, "write-compose", "completed")

	s.beginStep(onStep, "write-env")
	if err := host.WriteFileAtomic(ctx, envPath(dir), envData, 0o600); err != nil {
		s.endStep(onStep, "write-env", "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, "write-env", "completed")

	s.beginStep(onStep, "pull")
	pullCtx, cancelPull := context.WithTimeout(ctx, 10*time.Minute)
	pull, err := host.Run(pullCtx, fmt.Sprintf("cd %s && docker compose pull", quoted), nil)
	cancelPull()
	if err != nil {
		s.endStep(onStep, "pull", "failed")
		return domain.Result{}, err
	}
	if pull.ExitCode != 0 {
		s.endStep(onStep, "pull", "failed")
		return domain.Result{}, dockerError(pull)
	}
	s.endStep(onStep, "pull", "completed")

	s.beginStep(onStep, "up")
	upCtx, cancelUp := context.WithTimeout(ctx, commandTimeout)
	up, err := host.Run(upCtx, fmt.Sprintf("cd %s && docker compose up -d", quoted), nil)
	cancelUp()
	if err != nil {
		s.endStep(onStep, "up", "failed")
		return domain.Result{}, err
	}
	if up.ExitCode != 0 {
		s.endStep(onStep, "up", "failed")
		return domain.Result{}, dockerError(up)
	}
	s.endStep(onStep, "up", "completed")

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
	"write-env":     "writeEnv",
	"pull":          "pull",
	"up":            "up",
	"healthy":       "healthy",
	"restart":       "restart",
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

func dockerError(result sshhost.Result) error {
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
	logsCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	logs, err := host.Run(logsCtx, fmt.Sprintf(
		"cd %s && docker compose logs --no-color --tail 50 bot", sshhost.QuotePath(target.Host.Dir)), nil)
	if err != nil {
		return err
	}
	message := string(logs.Stdout)
	if message == "" {
		message = string(logs.Stderr)
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
func (s *Service) installEnv(request InstallRequest) ([]byte, error) {
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

	file, err := envfile.Parse(nil)
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
	} {
		if err := set(entry.name, entry.value); err != nil {
			return nil, err
		}
	}
	return file.Bytes(), nil
}
