package container

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

// agentTarget addresses the launchd agent of the logged-in user. The double
// quotes let launchd expand the uid inside every command.
const agentTarget = `"gui/$(id -u)/` + agentLabel + `"`

const (
	appleHomeCommand    = `printf '%s\n%s\n' "$HOME" "$(command -v container)"`
	appleVersionCommand = `container --version`
	appleStatusCommand  = `container system status`
	appleInspectCommand = `container inspect ` + appleContainerName
	appleListCommand    = `container ls --format json`
	appleLogsCommand    = `container logs -n 50 ` + appleContainerName
	appleHealthCommand  = `curl -fsS --max-time 5 http://127.0.0.1:8787/healthz`
)

var appleVersionPattern = regexp.MustCompile(`version (\d+)\.`)

// appleTagPattern is the only shape a release tag may take. The tag is read
// out of a file and written back unquoted into a shell line, so anything else
// has to be refused.
var appleTagPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// appleEngine runs the bot with Apple's container tool on this Mac. There is
// no compose file: the instance is a run script kept alive by a launchd agent.
type appleEngine struct {
	text    func(id string, ok bool) string
	message func(key string) string // one message verbatim, without an ok/fail pair
}

func (e *appleEngine) Dialect() envfile.Dialect { return envfile.Plain }

func (e *appleEngine) StepIDs() (manifest, apply string) { return "write-agent", "register" }

// WriteManifest writes the run script and the launchd agent. The run script
// must hold an absolute directory, because launchd starts it from /.
func (e *appleEngine) WriteManifest(ctx context.Context, host Host, dir, version string) error {
	home, containerBin, err := e.home(ctx, host)
	if err != nil {
		return err
	}
	absDir := expandHome(dir, home)
	// launchd opens the log files before it runs the script, and it does not
	// create parent directories: a missing logs directory makes the spawn
	// fail, which KeepAlive then retries forever.
	if _, err := runOnHost(ctx, host, "mkdir -p "+hostexec.QuotePath(absDir+"/logs")); err != nil {
		return err
	}
	if err := host.WriteFileAtomic(ctx, runScriptPath(dir),
		appleRunScript(absDir, containerBin, appleImageRef(version)), 0o700); err != nil {
		return err
	}
	return host.WriteFileAtomic(ctx, agentPlistPath, appleAgentPlist(absDir), 0o644)
}

// home runs the probe that resolves both the home directory and the container
// binary in one round trip. A missing binary cannot be written into a script.
func (e *appleEngine) home(ctx context.Context, host Host) (string, string, error) {
	result, err := runOnHost(ctx, host, appleHomeCommand)
	if err != nil {
		return "", "", err
	}
	lines := strings.Split(strings.TrimRight(string(result.Stdout), "\n"), "\n")
	if len(lines) < 2 {
		return "", "", domain.Error{Code: domain.LOCAL_RUNTIME_MISSING}
	}
	home := strings.TrimSpace(lines[0])
	containerBin := strings.TrimSpace(lines[1])
	if result.ExitCode != 0 || home == "" || containerBin == "" || strings.Contains(containerBin, "'") {
		return "", "", domain.Error{Code: domain.LOCAL_RUNTIME_MISSING}
	}
	return home, containerBin, nil
}

// expandHome makes dir absolute with the home directory from the host.
func expandHome(dir, home string) string {
	rest, ok := strings.CutPrefix(dir, "~/")
	if !ok {
		return dir
	}
	return home + "/" + rest
}

// ReadVersion reads the release version out of the run script.
func (e *appleEngine) ReadVersion(ctx context.Context, host Host, dir string) (string, error) {
	script, err := readFileOnHost(ctx, host, runScriptPath(dir))
	if err != nil {
		return "", envFileError("the launch script is missing")
	}
	version := appleReadVersion(script)
	if version == "" {
		return "", envFileError("the launch script names no image")
	}
	if !appleTagPattern.MatchString(version) {
		return "", envFileError("the launch script names an invalid image tag")
	}
	return version, nil
}

// Preflight checks that this Mac can run the bot under Apple container.
func (e *appleEngine) Preflight(ctx context.Context, host Host, dir string) (PreflightReport, error) {
	versionResult, err := runOnHost(ctx, host, appleVersionCommand)
	if err != nil {
		return PreflightReport{}, err
	}
	runtimeCheck := Check{ID: "container"}
	// The releases URL lives in the version message, so the check offers no
	// separate copyable fix: an update is not a command this client can run.
	versionCheck := Check{ID: "version"}
	serviceCheck := Check{ID: "service", Fix: "container system start"}
	if versionResult.ExitCode == 127 {
		runtimeCheck.Detail = e.text("container", false)
		versionCheck.Detail = e.text("version", false)
		serviceCheck.Detail = e.text("service", false)
	} else {
		runtimeCheck.OK = true
		runtimeCheck.Detail = e.text("container", true)

		major := -1
		if match := appleVersionPattern.FindSubmatch(versionResult.Stdout); match != nil {
			if parsed, convErr := strconv.Atoi(string(match[1])); convErr == nil {
				major = parsed
			}
		}
		versionCheck.OK = versionResult.ExitCode == 0 && major >= 1
		versionCheck.Detail = e.text("version", versionCheck.OK)
		if versionCheck.OK {
			versionCheck.Fix = ""
			status, err := runOnHost(ctx, host, appleStatusCommand)
			if err != nil {
				return PreflightReport{}, err
			}
			serviceCheck.OK = status.ExitCode == 0 && strings.Contains(string(status.Stdout), "running")
			serviceCheck.Detail = e.text("service", serviceCheck.OK)
			if serviceCheck.OK {
				serviceCheck.Fix = ""
			}
		} else {
			// The service cannot answer when the tool itself is too old, and
			// it was never probed, so there is no fix to offer for it.
			serviceCheck.Detail = e.text("service", false)
			serviceCheck.Fix = ""
		}
	}

	arch := Check{ID: "arch"}
	archResult, err := runOnHost(ctx, host, archCommand)
	if err != nil {
		return PreflightReport{}, err
	}
	arch.OK = archResult.ExitCode == 0 && strings.TrimSpace(string(archResult.Stdout)) == "arm64"
	if arch.OK {
		arch.Detail = e.text("arch", true)
	} else {
		arch.Detail = e.message("arch.appleFail")
	}

	dirCheck, existing, err := checkDir(ctx, host, dir, runScriptPath(dir), []string{composePath(dir)})
	if err != nil {
		return PreflightReport{}, err
	}
	if !dirCheck.OK {
		switch compose, composeErr := readFileOnHost(ctx, host, composePath(dir)); {
		// Only a compose file that pulls our image proves the directory
		// belongs to the Docker-compatible engine.
		case composeErr == nil && strings.Contains(string(compose), ImageRepository):
			dirCheck.Detail = e.message("dir.otherEngineCompose")
		case composeErr != nil && !errors.Is(composeErr, hostexec.ErrNotExist):
			return PreflightReport{}, composeErr
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
		listen, err := runOnHost(ctx, host, localPortCommand)
		if err != nil {
			return PreflightReport{}, err
		}
		port.OK = strings.TrimSpace(string(listen.Stdout)) == ""
		port.Detail = e.text("port", port.OK)
		if !port.OK {
			owner, err := applePortOwner(ctx, host)
			if err != nil {
				return PreflightReport{}, err
			}
			if owner != "" {
				port.Fix = "container stop " + owner
			}
		}
	}

	return PreflightReport{
		Checks:   []Check{runtimeCheck, versionCheck, serviceCheck, arch, port, dirCheck},
		Existing: existing,
	}, nil
}

// applePortOwner names the container that publishes port 8787, if any.
func applePortOwner(ctx context.Context, host Host) (string, error) {
	list, err := runOnHost(ctx, host, appleListCommand)
	if err != nil {
		return "", err
	}
	if list.ExitCode != 0 {
		return "", nil
	}
	var containers []struct {
		ID            string `json:"id"`
		Configuration struct {
			PublishedPorts []struct {
				HostPort int `json:"hostPort"`
			} `json:"publishedPorts"`
		} `json:"configuration"`
	}
	if err := json.Unmarshal(list.Stdout, &containers); err != nil {
		return "", nil
	}
	for _, container := range containers {
		for _, published := range container.Configuration.PublishedPorts {
			if published.HostPort == 8787 {
				return container.ID, nil
			}
		}
	}
	return "", nil
}

// Pull fetches the image the run script names, unless it is already here.
func (e *appleEngine) Pull(ctx context.Context, host Host, dir string) error {
	version, err := e.ReadVersion(ctx, host, dir)
	if err != nil {
		return err
	}
	image := appleImageRef(version)
	pullCtx, cancelPull := context.WithTimeout(ctx, 10*time.Minute)
	defer cancelPull()
	result, err := host.Run(pullCtx, fmt.Sprintf(
		"container image inspect %s >/dev/null 2>&1 || container image pull %s", image, image), nil)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return domain.Error{Code: domain.LOCAL_PULL_FAILED, Message: outputMessage(result)}
	}
	return nil
}

// Apply registers the launchd agent, or restarts it when it is already
// registered.
func (e *appleEngine) Apply(ctx context.Context, host Host, dir string) error {
	command := fmt.Sprintf(
		`if launchctl print %s >/dev/null 2>&1; then launchctl kickstart -k %s; else launchctl bootstrap "gui/$(id -u)" %s; fi`,
		agentTarget, agentTarget, hostexec.QuotePath(agentPlistPath))
	applyCtx, cancelApply := context.WithTimeout(ctx, commandTimeout)
	defer cancelApply()
	result, err := host.Run(applyCtx, command, nil)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return domain.Error{Code: domain.LOCAL_AGENT_FAILED, Message: outputMessage(result)}
	}
	return nil
}

// Stop boots the launchd agent out first: otherwise it would restart run.sh
// while the container is still shutting down. The data volume and .env stay.
func (e *appleEngine) Stop(ctx context.Context, host Host, dir string) error {
	command := "launchctl bootout " + agentTarget + " >/dev/null 2>&1; container stop " + appleContainerName
	stopCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	result, err := runOnHost(stopCtx, host, command)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return domain.Error{Code: domain.LOCAL_AGENT_FAILED, Message: outputMessage(result)}
	}
	return nil
}

// Start re-runs the agent, which rebuilds the container from the same volume
// (see appleRunScript).
func (e *appleEngine) Start(ctx context.Context, host Host, dir string) error {
	return e.Apply(ctx, host, dir)
}

// Status reports the container state, then probes health when it runs.
func (e *appleEngine) Status(ctx context.Context, host Host, dir string) (RuntimeStatus, error) {
	var status RuntimeStatus
	system, err := runOnHost(ctx, host, appleStatusCommand)
	if err != nil {
		return status, err
	}
	code := domain.LOCAL_RUNTIME_STOPPED
	if system.ExitCode == 127 {
		code = domain.LOCAL_RUNTIME_MISSING
	}
	if system.ExitCode != 0 {
		return status, runtimeError(code, system)
	}
	if !strings.Contains(string(system.Stdout), "running") {
		return status, domain.Error{Code: code}
	}

	inspect, err := runOnHost(ctx, host, appleInspectCommand)
	if err != nil {
		return status, err
	}
	status.Reachable = true
	if inspect.ExitCode != 0 {
		return status, nil
	}
	var containers []struct {
		Configuration struct {
			Image struct {
				Reference string `json:"reference"`
			} `json:"image"`
		} `json:"configuration"`
		Status struct {
			State       string `json:"state"`
			StartedDate string `json:"startedDate"`
		} `json:"status"`
	}
	if err := json.Unmarshal(inspect.Stdout, &containers); err != nil || len(containers) == 0 {
		return status, nil
	}
	first := containers[0]
	status.Running = first.Status.State == "running"
	status.StartedAt = first.Status.StartedDate
	status.Image = first.Configuration.Image.Reference
	if !status.Running {
		return status, nil
	}
	health, err := runOnHost(ctx, host, appleHealthCommand)
	if err != nil {
		return status, err
	}
	status.Health = "starting"
	if health.ExitCode == 0 {
		status.Health = "healthy"
	}
	return status, nil
}

// Logs prefers the container log and falls back to the launch agent log.
func (e *appleEngine) Logs(ctx context.Context, host Host, dir string) (string, error) {
	result, err := runOnHost(ctx, host, appleLogsCommand)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		result, err = runOnHost(ctx, host, "tail -n 50 "+hostexec.QuotePath(dir)+"/logs/launchd.log")
		if err != nil {
			return "", err
		}
	}
	message := string(result.Stdout)
	if message == "" {
		message = string(result.Stderr)
	}
	return message, nil
}

// Remove stops the login item and deletes the agent and the container, even
// when the runtime is already gone.
func (e *appleEngine) Remove(ctx context.Context, host Host, dir string) error {
	found, err := runOnHost(ctx, host, "command -v container")
	if err != nil {
		return err
	}
	missing := found.ExitCode != 0 || strings.TrimSpace(string(found.Stdout)) == ""
	command := "launchctl bootout " + agentTarget + " >/dev/null 2>&1; rm -f " + hostexec.QuotePath(agentPlistPath)
	if !missing {
		// No trailing "; true": a failed container removal has to surface,
		// because a surviving instance keeps port 8787 and breaks the next
		// install.
		command += "; container rm -f " + appleContainerName + " >/dev/null 2>&1"
	}
	removed, err := runOnHost(ctx, host, command)
	if err != nil {
		return err
	}
	if removed.ExitCode != 0 {
		return runtimeError(domain.LOCAL_RUNTIME_STOPPED, removed)
	}
	if missing {
		return domain.Error{Code: domain.LOCAL_RUNTIME_MISSING}
	}
	return nil
}
