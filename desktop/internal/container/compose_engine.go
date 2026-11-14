package container

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

// composeEngine runs docker compose on a host reached over SSH, or on this Mac
// when local is set.
type composeEngine struct {
	local   bool
	text    func(id string, ok bool) string
	message func(key string) string // one message verbatim, without an ok/fail pair
}

const (
	dockerVersionCommand  = `docker version --format '{{.Server.Version}}'`
	composeVersionCommand = `docker compose version --short`
	archCommand           = `uname -m`
	portCommand           = `ss -ltnH 'sport = :8787' 2>/dev/null || true`
	localPortCommand      = `lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null || true`
)

// runScriptPath is the Apple container instance's start file. A directory that
// holds one belongs to the Apple engine.
func runScriptPath(dir string) string { return dir + "/run.sh" }

// runtimeError returns a coded error whose message is the command output.
func runtimeError(code string, result hostexec.Result) error {
	message := lastLines(result.Stderr, 20)
	if message == "" {
		message = lastLines(result.Stdout, 20)
	}
	return domain.Error{Code: code, Message: message}
}

func (e *composeEngine) Dialect() envfile.Dialect { return envfile.Compose }

func (e *composeEngine) StepIDs() (manifest, apply string) { return "write-compose", "up" }

// Preflight checks that the host can run the container. It never installs
// anything and never writes to the remote directory.
func (e *composeEngine) Preflight(ctx context.Context, host Host, dir string) (PreflightReport, error) {
	if e.local {
		return e.preflightLocal(ctx, host, dir)
	}
	version, err := runOnHost(ctx, host, dockerVersionCommand)
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
		docker.Detail = e.text("docker", true)
		permission.Detail = e.text("permission", false)
		permission.Fix = "sudo usermod -aG docker $USER"
	case notFound:
		docker.Detail = e.text("docker", false)
		docker.Fix = "curl -fsSL https://get.docker.com | sh"
		permission.OK = true
		permission.Detail = e.text("permission", true)
	default:
		docker.OK = version.ExitCode == 0
		docker.Detail = e.text("docker", docker.OK)
		if !docker.OK {
			// Installed but not answering: the daemon is stopped.
			docker.Fix = "sudo systemctl start docker"
		}
		permission.OK = true
		permission.Detail = e.text("permission", true)
	}

	compose := Check{ID: "compose"}
	if !docker.OK || !permission.OK {
		compose.Detail = e.text("compose", false)
	} else {
		composeResult, err := runOnHost(ctx, host, composeVersionCommand)
		if err != nil {
			return PreflightReport{}, err
		}
		compose.OK = composeResult.ExitCode == 0
		compose.Detail = e.text("compose", compose.OK)
		if !compose.OK {
			compose.Fix = "sudo apt-get install -y docker-compose-plugin"
		}
	}

	arch := Check{ID: "arch"}
	archResult, err := runOnHost(ctx, host, archCommand)
	if err != nil {
		return PreflightReport{}, err
	}
	machine := strings.TrimSpace(string(archResult.Stdout))
	arch.OK = archResult.ExitCode == 0 && (machine == "x86_64" || machine == "aarch64")
	arch.Detail = e.text("arch", arch.OK)

	dirCheck, existing, err := checkDir(ctx, host, dir, composePath(dir), nil)
	if err != nil {
		return PreflightReport{}, err
	}
	dirCheck.Detail = e.text("dir", dirCheck.OK)

	port := Check{ID: "port"}
	if existing {
		port.OK = true
		port.Detail = e.text("port", true)
	} else {
		portResult, err := runOnHost(ctx, host, portCommand)
		if err != nil {
			return PreflightReport{}, err
		}
		port.OK = strings.TrimSpace(string(portResult.Stdout)) == ""
		port.Detail = e.text("port", port.OK)
	}

	return PreflightReport{
		Checks:   []Check{docker, compose, permission, arch, port, dirCheck},
		Existing: existing,
	}, nil
}

// preflightLocal checks this Mac. There is no sudo, no systemd, and no package
// manager to repair, so the local checks carry no Fix, and the permission check
// has nothing to check.
func (e *composeEngine) preflightLocal(ctx context.Context, host Host, dir string) (PreflightReport, error) {
	version, err := runOnHost(ctx, host, dockerVersionCommand)
	if err != nil {
		return PreflightReport{}, err
	}
	docker := Check{ID: "docker"}
	switch {
	case version.ExitCode == 127:
		docker.Detail = e.message("docker.localMissing")
	case version.ExitCode != 0:
		docker.Detail = e.message("docker.localStopped")
	default:
		docker.OK = true
		docker.Detail = e.text("docker", true)
	}

	compose := Check{ID: "compose"}
	if !docker.OK {
		compose.Detail = e.text("compose", false)
	} else {
		composeResult, err := runOnHost(ctx, host, composeVersionCommand)
		if err != nil {
			return PreflightReport{}, err
		}
		compose.OK = composeResult.ExitCode == 0
		compose.Detail = e.text("compose", compose.OK)
	}

	arch := Check{ID: "arch"}
	archResult, err := runOnHost(ctx, host, archCommand)
	if err != nil {
		return PreflightReport{}, err
	}
	machine := strings.TrimSpace(string(archResult.Stdout))
	arch.OK = archResult.ExitCode == 0 && (machine == "x86_64" || machine == "arm64")
	if arch.OK {
		arch.Detail = e.text("arch", true)
	} else {
		// SSH accepts aarch64, while a local engine reports arm64.
		arch.Detail = e.message("arch.localFail")
	}

	dirCheck, existing, err := checkDir(ctx, host, dir, composePath(dir), []string{runScriptPath(dir)})
	if err != nil {
		return PreflightReport{}, err
	}
	if !dirCheck.OK {
		switch script, runErr := readFileOnHost(ctx, host, runScriptPath(dir)); {
		// Only a run script this client wrote marks the directory as the
		// Apple engine's; any other run.sh is just an unrelated file.
		case runErr == nil && strings.Contains(string(script), appleScriptMarker):
			dirCheck.Detail = e.message("dir.otherEngine")
		case runErr != nil && !errors.Is(runErr, hostexec.ErrNotExist):
			return PreflightReport{}, runErr
		}
	}
	if dirCheck.Detail == "" {
		dirCheck.Detail = e.text("dir.local", dirCheck.OK)
	}

	port := Check{ID: "port"}
	if existing {
		port.OK = true
		port.Detail = e.text("port", true)
	} else {
		portResult, err := runOnHost(ctx, host, localPortCommand)
		if err != nil {
			return PreflightReport{}, err
		}
		port.OK = strings.TrimSpace(string(portResult.Stdout)) == ""
		port.Detail = e.text("port", port.OK)
	}

	return PreflightReport{
		Checks:   []Check{docker, compose, arch, port, dirCheck},
		Existing: existing,
	}, nil
}

func (e *composeEngine) WriteManifest(ctx context.Context, host Host, dir, version string) error {
	return host.WriteFileAtomic(ctx, composePath(dir), ComposeFile(version), 0o644)
}

// ReadVersion reads the release version out of the compose file. A missing or
// unreadable file has no version.
func (e *composeEngine) ReadVersion(ctx context.Context, host Host, dir string) (string, error) {
	compose, err := readFileOnHost(ctx, host, composePath(dir))
	if err != nil {
		return "", nil
	}
	if match := imageLinePattern.FindSubmatch(compose); match != nil {
		return string(match[1]), nil
	}
	return "", nil
}

func (e *composeEngine) Pull(ctx context.Context, host Host, dir string) error {
	pullCtx, cancelPull := context.WithTimeout(ctx, 10*time.Minute)
	pull, err := host.Run(pullCtx, fmt.Sprintf("cd %s && docker compose pull", hostexec.QuotePath(dir)), nil)
	cancelPull()
	if err != nil {
		return err
	}
	if pull.ExitCode != 0 {
		if e.local {
			return runtimeError(domain.LOCAL_PULL_FAILED, pull)
		}
		return dockerError(pull)
	}
	return nil
}

func (e *composeEngine) Apply(ctx context.Context, host Host, dir string) error {
	upCtx, cancelUp := context.WithTimeout(ctx, commandTimeout)
	up, err := host.Run(upCtx, fmt.Sprintf("cd %s && docker compose up -d", hostexec.QuotePath(dir)), nil)
	cancelUp()
	if err != nil {
		return err
	}
	if up.ExitCode != 0 {
		if e.local {
			return runtimeError(domain.LOCAL_RUNTIME_STOPPED, up)
		}
		return dockerError(up)
	}
	return nil
}

func (e *composeEngine) Stop(ctx context.Context, host Host, dir string) error {
	return e.composeVerb(ctx, host, dir, "stop")
}

func (e *composeEngine) Start(ctx context.Context, host Host, dir string) error {
	return e.composeVerb(ctx, host, dir, "start")
}

// composeVerb runs one docker compose subcommand in dir, mapping failures the
// way Apply does.
func (e *composeEngine) composeVerb(ctx context.Context, host Host, dir, verb string) error {
	verbCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	result, err := host.Run(verbCtx, fmt.Sprintf("cd %s && docker compose %s", hostexec.QuotePath(dir), verb), nil)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		if e.local {
			return runtimeError(domain.LOCAL_RUNTIME_STOPPED, result)
		}
		return dockerError(result)
	}
	return nil
}

func (e *composeEngine) Status(ctx context.Context, host Host, dir string) (RuntimeStatus, error) {
	var status RuntimeStatus
	if e.local {
		version, err := runOnHost(ctx, host, dockerVersionCommand)
		if err != nil {
			return status, err
		}
		if version.ExitCode != 0 {
			code := domain.LOCAL_RUNTIME_STOPPED
			if version.ExitCode == 127 {
				code = domain.LOCAL_RUNTIME_MISSING
			}
			return status, runtimeError(code, version)
		}
	}
	inspectCtx, cancelInspect := context.WithTimeout(ctx, commandTimeout)
	result, err := host.Run(inspectCtx, fmt.Sprintf(
		`cd %s && docker inspect --format '%s' "$(docker compose ps -q bot)"`, hostexec.QuotePath(dir), inspectFormat), nil)
	cancelInspect()
	if err != nil {
		return status, err
	}
	status.Reachable = true
	if result.ExitCode == 0 {
		parts := strings.Split(strings.TrimSpace(string(result.Stdout)), "|")
		if len(parts) == 4 {
			status.Running = parts[0] == "running"
			status.Health = parts[1]
			status.StartedAt = parts[2]
			status.Image = parts[3]
		}
	}
	return status, nil
}

func (e *composeEngine) Logs(ctx context.Context, host Host, dir string) (string, error) {
	logsCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	logs, err := host.Run(logsCtx, fmt.Sprintf(
		"cd %s && docker compose logs --no-color --tail 50 bot", hostexec.QuotePath(dir)), nil)
	if err != nil {
		return "", err
	}
	message := string(logs.Stdout)
	if message == "" {
		message = string(logs.Stderr)
	}
	return message, nil
}

func (e *composeEngine) Remove(ctx context.Context, host Host, dir string) error {
	downCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	down, err := host.Run(downCtx, fmt.Sprintf("cd %s && docker compose down", hostexec.QuotePath(dir)), nil)
	if err != nil {
		return err
	}
	if down.ExitCode != 0 {
		if e.local {
			return runtimeError(domain.LOCAL_RUNTIME_STOPPED, down)
		}
		return dockerError(down)
	}
	return nil
}
