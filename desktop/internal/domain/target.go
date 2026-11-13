package domain

import (
	"regexp"
	"strings"
)

// Target kinds. An empty Kind is read as TargetCloudflare.
const (
	TargetCloudflare = "cloudflare"
	TargetContainer  = "container"
)

// SSH authentication methods.
const (
	SSHAuthKey      = "key"
	SSHAuthAgent    = "agent"
	SSHAuthPassword = "password"
)

// Stable error codes for the container target.
const (
	SSH_UNREACHABLE      = "SSH_UNREACHABLE"
	SSH_AUTH_FAILED      = "SSH_AUTH_FAILED"
	SSH_HOST_KEY_CHANGED = "SSH_HOST_KEY_CHANGED"
	SSH_HOST_KEY_UNKNOWN = "SSH_HOST_KEY_UNKNOWN"
	DOCKER_UNAVAILABLE   = "DOCKER_UNAVAILABLE"
	CONTAINER_UNHEALTHY  = "CONTAINER_UNHEALTHY"
	ENV_FILE_INVALID     = "ENV_FILE_INVALID"
	TARGET_UNSUPPORTED   = "TARGET_UNSUPPORTED"
)

// Container defaults.
const (
	DefaultRemoteDir = "~/deskwand"
	DefaultSSHPort   = 22
)

// codeInvalidRequest mirrors deployment.CodeInvalidRequest. domain cannot
// import deployment, which depends on domain.
const codeInvalidRequest = "INVALID_REQUEST"

var (
	hostAddressPattern = regexp.MustCompile(`^[A-Za-z0-9.:-]+$`)
	hostUserPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)
	remoteDirPattern   = regexp.MustCompile(`^[A-Za-z0-9._/~-]+$`)
)

// HostRef identifies one SSH host and the remote directory the container runs
// in. It holds only scalars so Target stays comparable.
type HostRef struct {
	Address string
	Port    int
	User    string
	Auth    string // SSHAuthKey | SSHAuthAgent | SSHAuthPassword
	KeyPath string // only when Auth == SSHAuthKey
	Dir     string
}

// Validate checks the fields that reach a remote command line.
func (h HostRef) Validate() error {
	invalid := func(message string) error {
		return Error{Code: codeInvalidRequest, Message: message}
	}
	if !hostAddressPattern.MatchString(h.Address) {
		return invalid("invalid SSH host address")
	}
	if h.Port < 1 || h.Port > 65535 {
		return invalid("invalid SSH port")
	}
	if !hostUserPattern.MatchString(h.User) {
		return invalid("invalid SSH user")
	}
	switch h.Auth {
	case SSHAuthKey:
		if h.KeyPath == "" {
			return invalid("an SSH key path is required")
		}
	case SSHAuthAgent, SSHAuthPassword:
	default:
		return invalid("invalid SSH authentication method")
	}
	if !remoteDirPattern.MatchString(h.Dir) {
		return invalid("invalid remote directory")
	}
	// Absolute or home-relative only, with ~ nowhere but the start: the
	// directory is quoted into remote commands and must not read as an option.
	rest, home := strings.CutPrefix(h.Dir, "~/")
	if !home && !strings.HasPrefix(h.Dir, "/") || strings.Contains(rest, "~") {
		return invalid("invalid remote directory")
	}
	return nil
}

// IsContainer reports whether the target is served from an SSH host.
func (t Target) IsContainer() bool {
	return t.Kind == TargetContainer
}

// DisplayName is the host address for container targets and the Worker script
// name otherwise.
func (t Target) DisplayName() string {
	if t.IsContainer() {
		return t.Host.Address
	}
	return t.ScriptName
}
