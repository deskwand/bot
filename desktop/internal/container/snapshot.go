package container

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/sshhost"
)

// RuntimeStatus is what the server page shows. A host that cannot be reached
// is a state, not a failure.
type RuntimeStatus struct {
	Reachable  bool   // SSH connection succeeded
	Running    bool   // the container state is running
	Health     string // "healthy" | "starting" | "unhealthy" | ""
	Image      string
	StartedAt  string // RFC 3339, as reported by docker
	CanRestore bool   // the remote directory has a .env.bak
}

var imageLinePattern = regexp.MustCompile(`(?m)^\s*image:\s*` + regexp.QuoteMeta(ImageRepository) + `:([^\s#]+)\s*$`)

func envPath(dir string) string     { return dir + "/.env" }
func backupPath(dir string) string  { return dir + "/.env.bak" }
func composePath(dir string) string { return dir + "/compose.yaml" }

// ReadSnapshot reads the remote .env and compose file. Secret values never
// enter the result; only their names do.
func (s *Service) ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error) {
	host, err := s.dial(target)
	if err != nil {
		return domain.Snapshot{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()

	data, err := host.ReadFile(ctx, envPath(target.Host.Dir))
	if err != nil {
		if errors.Is(err, sshhost.ErrNotExist) {
			return domain.Snapshot{}, envFileError("the remote .env file is missing")
		}
		return domain.Snapshot{}, err
	}
	file, err := envfile.Parse(data)
	if err != nil {
		return domain.Snapshot{}, envFileError("the remote .env file cannot be parsed")
	}
	return s.snapshotFromEnv(ctx, target, host, data, file)
}

// snapshotFromEnv builds the snapshot from .env bytes the caller already read,
// so a publish can merge and rewrite the exact bytes it validated.
func (s *Service) snapshotFromEnv(ctx context.Context, target domain.Target, host Host, data []byte, file *envfile.File) (domain.Snapshot, error) {
	var configJSON []byte
	if value, ok := file.Get("DESKWAND_CONFIG"); ok {
		if !json.Valid([]byte(value)) {
			return domain.Snapshot{}, envFileError("DESKWAND_CONFIG is not valid JSON")
		}
		configJSON = []byte(value)
	}

	var secretNames []string
	for _, name := range file.Keys() {
		if !Allowed(name) || IsPlainVar(name) {
			continue
		}
		if value, _ := file.Get(name); value != "" {
			secretNames = append(secretNames, name)
		}
	}
	sort.Strings(secretNames)

	var releaseVersion string
	if compose, err := host.ReadFile(ctx, composePath(target.Host.Dir)); err == nil {
		if match := imageLinePattern.FindSubmatch(compose); match != nil {
			releaseVersion = string(match[1])
		}
	}

	settingsJSON, err := settingsDocument(file)
	if err != nil {
		return domain.Snapshot{}, err
	}
	versionID := "container:" + releaseVersion
	return domain.Snapshot{
		Target:             target,
		DeploymentID:       versionID,
		VersionID:          versionID,
		ConfigJSON:         configJSON,
		SettingsJSON:       settingsJSON,
		SecretNames:        secretNames,
		Fingerprint:        envfile.Fingerprint(data),
		ActiveVersionCount: 1,
		ReleaseVersion:     releaseVersion,
		LatestVersionID:    versionID,
	}, nil
}

func settingsDocument(file *envfile.File) ([]byte, error) {
	type binding struct {
		Name string `json:"name"`
		Type string `json:"type"`
		Text string `json:"text"`
	}
	bindings := []binding{}
	for _, name := range []string{"ACTIVE_CHANNEL", "PUBLIC_BASE_URL"} {
		if value, ok := file.Get(name); ok {
			bindings = append(bindings, binding{Name: name, Type: "plain_text", Text: value})
		}
	}
	return json.Marshal(struct {
		Bindings []binding `json:"bindings"`
	}{Bindings: bindings})
}

func envFileError(message string) error {
	return domain.Error{Code: domain.ENV_FILE_INVALID, Message: message}
}

const inspectFormat = `{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.Config.Image}}`

// Status reports whether the host and the container are up.
func (s *Service) Status(ctx context.Context, target domain.Target) (RuntimeStatus, error) {
	status := RuntimeStatus{}
	host, err := s.dial(target)
	if err != nil {
		if isSSHError(err) {
			return status, nil
		}
		return status, err
	}
	dir := sshhost.QuotePath(target.Host.Dir)

	inspectCtx, cancelInspect := context.WithTimeout(ctx, commandTimeout)
	result, err := host.Run(inspectCtx, fmt.Sprintf(
		`cd %s && docker inspect --format '%s' "$(docker compose ps -q bot)"`, dir, inspectFormat), nil)
	cancelInspect()
	if err != nil {
		if isSSHError(err) {
			return status, nil
		}
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

	backupCtx, cancelBackup := context.WithTimeout(ctx, commandTimeout)
	backupResult, err := host.Run(backupCtx, "test -e "+sshhost.QuotePath(backupPath(target.Host.Dir)), nil)
	cancelBackup()
	if err != nil {
		if isSSHError(err) {
			return RuntimeStatus{}, nil
		}
		return status, err
	}
	status.CanRestore = backupResult.ExitCode == 0
	return status, nil
}

func isSSHError(err error) bool {
	var coded domain.Error
	if errors.As(err, &coded) {
		return strings.HasPrefix(coded.Code, "SSH_")
	}
	return false
}
