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

// Host transports and container engines.
const (
	TransportSSH   = "ssh"
	TransportLocal = "local"
	EngineCompose  = "compose"
	EngineApple    = "apple"
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

	LOCAL_RUNTIME_MISSING = "LOCAL_RUNTIME_MISSING"
	LOCAL_RUNTIME_STOPPED = "LOCAL_RUNTIME_STOPPED"
	LOCAL_AGENT_FAILED    = "LOCAL_AGENT_FAILED"
	LOCAL_PULL_FAILED     = "LOCAL_PULL_FAILED"
)

// Container defaults.
const (
	DefaultRemoteDir = "~/deskwand"
	DefaultSSHPort   = 22
	DefaultLocalDir  = "~/Library/Application Support/DeskWand/local"
)

// codeInvalidRequest mirrors deployment.CodeInvalidRequest. domain cannot
// import deployment, which depends on domain.
const codeInvalidRequest = "INVALID_REQUEST"

var (
	hostAddressPattern = regexp.MustCompile(`^[A-Za-z0-9.:-]+$`)
	hostUserPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)
	remoteDirPattern   = regexp.MustCompile(`^[A-Za-z0-9._/~-]+$`)
	localDirPattern    = regexp.MustCompile(`^[A-Za-z0-9._/~ -]+$`)
)

// HostRef identifies one host and the directory the container runs in. A
// local host fills only Dir; an SSH host fills the connection fields too. It
// holds only scalars so Target stays comparable.
type HostRef struct {
	Address   string
	Port      int
	User      string
	Auth      string // SSHAuthKey | SSHAuthAgent | SSHAuthPassword
	KeyPath   string // only when Auth == SSHAuthKey
	Dir       string
	Transport string // empty means ssh
	Engine    string // empty means compose
}

// IsLocal reports whether the container runs on this Mac.
func (h HostRef) IsLocal() bool {
	return h.Transport == TransportLocal
}

// EngineName returns the container engine, reading an empty value as compose.
func (h HostRef) EngineName() string {
	if h.Engine == "" {
		return EngineCompose
	}
	return h.Engine
}

// Validate checks the fields that reach a command line.
func (h HostRef) Validate() error {
	invalid := func(message string) error {
		return Error{Code: codeInvalidRequest, Message: message}
	}
	switch h.Transport {
	case TransportLocal:
		switch h.EngineName() {
		case EngineCompose, EngineApple:
		default:
			return invalid("invalid container engine")
		}
		if !localDirPattern.MatchString(h.Dir) {
			return invalid("invalid local directory")
		}
		if !isAbsoluteOrHome(h.Dir) {
			return invalid("invalid local directory")
		}
		return nil
	case "", TransportSSH:
	default:
		return invalid("invalid transport")
	}
	if h.Engine != "" && h.Engine != EngineCompose {
		return invalid("invalid container engine")
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
	if !isAbsoluteOrHome(h.Dir) {
		return invalid("invalid remote directory")
	}
	return nil
}

// isAbsoluteOrHome requires an absolute or home-relative path, with ~ nowhere
// but the start: the directory is quoted into commands and must not read as an
// option.
func isAbsoluteOrHome(dir string) bool {
	rest, home := strings.CutPrefix(dir, "~/")
	if !home && !strings.HasPrefix(dir, "/") || strings.Contains(rest, "~") {
		return false
	}
	return true
}

// IsContainer reports whether the target is a container deployment, whether on
// this Mac or on an SSH host.
func (t Target) IsContainer() bool {
	return t.Kind == TargetContainer
}

// DisplayName is the host address for container targets and the Worker script
// name otherwise. A local target has no address; the app layer supplies the
// localized name.
func (t Target) DisplayName() string {
	if t.IsContainer() {
		if t.Host.IsLocal() {
			return ""
		}
		return t.Host.Address
	}
	return t.ScriptName
}
