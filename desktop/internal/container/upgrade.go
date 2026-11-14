package container

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

// VersionState is the upgrade status the Updates page shows for a container.
type VersionState struct {
	Current string // tag read from the manifest
	Target  string // release version bundled with this client
	State   string // one of the Version* constants
}

const (
	VersionUpgradable   = "upgradable"
	VersionCurrent      = "current"
	VersionClientBehind = "client-behind"
	VersionUnknown      = "unknown"
	// VersionManifestPending means the manifest already names a version the
	// running container has not picked up, usually an upgrade that stopped
	// between the manifest write and the restart.
	VersionManifestPending = "manifest-pending"
)

// versionPattern is the only shape a version may have before it reaches a
// remote file or a shell command.
var versionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func validVersion(version string) bool {
	return versionPattern.MatchString(version)
}

// UpgradeAvailable reads the installed tag and compares it with the bundled
// release. A tag the manifest does not hold, or one that cannot be compared,
// is Unknown: the page then offers no button instead of guessing.
func (s *Service) UpgradeAvailable(ctx context.Context, target domain.Target) (VersionState, error) {
	if !target.IsContainer() {
		return VersionState{}, domain.Error{Code: domain.TARGET_UNSUPPORTED}
	}
	host, err := s.dial(target)
	if err != nil {
		return VersionState{}, err
	}
	readCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	current, err := s.engine(target).ReadVersion(readCtx, host, target.Host.Dir)
	if err != nil {
		// An unreadable manifest is a broken install, not an upgrade the page
		// can offer; report it as unknown so the button stays disabled.
		var coded domain.Error
		if errors.As(err, &coded) && coded.Code == domain.ENV_FILE_INVALID {
			return s.versionState(""), nil
		}
		return VersionState{}, err
	}
	state := s.versionState(current)
	if state.State == VersionCurrent || state.State == VersionUpgradable {
		pending, err := s.manifestAhead(ctx, target, host, current)
		if err != nil {
			return VersionState{}, err
		}
		if pending {
			state.State = VersionManifestPending
		}
	}
	return state, nil
}

// manifestAhead reports whether the running container still uses a different
// tag than the manifest names. A stopped container or an unreadable status is
// not evidence of a half-finished upgrade.
func (s *Service) manifestAhead(ctx context.Context, target domain.Target, host Host, manifestVersion string) (bool, error) {
	statusCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	status, err := s.engine(target).Status(statusCtx, host, target.Host.Dir)
	if err != nil || !status.Running {
		return false, nil
	}
	running := imageTag(status.Image)
	return validVersion(running) && running != manifestVersion, nil
}

// imageTag is the version part of an image reference. Digest-pinned references
// have no comparable tag, so they report "".
func imageTag(image string) string {
	if image == "" || strings.Contains(image, "@") {
		return ""
	}
	return image[strings.LastIndex(image, ":")+1:]
}

func (s *Service) versionState(current string) VersionState {
	state := VersionState{Current: current, Target: s.options.Version, State: VersionUnknown}
	if !validVersion(current) || !validVersion(s.options.Version) {
		return state
	}
	comparison, comparable := release.CompareVersions(current, s.options.Version)
	if !comparable {
		return state
	}
	switch {
	case comparison < 0:
		state.State = VersionUpgradable
	case comparison == 0:
		state.State = VersionCurrent
	default:
		state.State = VersionClientBehind
	}
	return state
}

// codeOf and messageOf read a stable code out of a coded error while keeping
// the error it came from usable for the message.
func codeOf(err error, fallback string) string {
	var coded domain.Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return fallback
}

func messageOf(err error) string {
	var coded domain.Error
	if errors.As(err, &coded) {
		return coded.Message
	}
	return err.Error()
}

// Upgrade rewrites the manifest to the release bundled with this client,
// restarts the container and waits until it is healthy. A version that never
// becomes healthy is rolled back automatically. The .env and the data volumes
// are never read or written.
func (s *Service) Upgrade(ctx context.Context, target domain.Target, onStep func(domain.Step)) (domain.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !target.IsContainer() {
		return domain.Result{}, domain.Error{Code: domain.TARGET_UNSUPPORTED}
	}
	host, err := s.dial(target)
	if err != nil {
		return domain.Result{}, err
	}
	dir := target.Host.Dir
	engine := s.engine(target)

	readCtx, cancelRead := context.WithTimeout(ctx, commandTimeout)
	current, err := engine.ReadVersion(readCtx, host, dir)
	cancelRead()
	if err != nil {
		return domain.Result{}, err
	}
	state := s.versionState(current)
	switch state.State {
	case VersionCurrent:
		return domain.Result{State: "published", VersionID: "container:" + current}, nil
	case VersionClientBehind:
		return domain.Result{}, domain.Error{Code: domain.CONTAINER_CLIENT_BEHIND}
	case VersionUnknown:
		return domain.Result{}, domain.Error{Code: domain.CONTAINER_VERSION_UNKNOWN}
	}

	newVersion := s.options.Version
	unchanged, err := engine.ManifestUnchanged(ctx, host, dir, current)
	if err != nil {
		return domain.Result{}, err
	}
	if !unchanged {
		return domain.Result{}, domain.Error{Code: domain.CONTAINER_MANIFEST_MODIFIED}
	}
	manifestID, applyID := engine.StepIDs()

	s.beginStep(onStep, manifestID)
	if err := engine.WriteManifest(ctx, host, dir, newVersion); err != nil {
		s.endStep(onStep, manifestID, "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, manifestID, "completed")

	s.beginStep(onStep, "pull")
	if err := engine.Pull(ctx, host, dir); err != nil {
		s.endStep(onStep, "pull", "failed")
		// Nothing restarted yet: put the manifest back so the directory keeps
		// describing the container that is actually running.
		if restoreErr := s.restoreManifest(ctx, host, dir, engine, current); restoreErr != nil {
			return domain.Result{}, domain.Error{
				Code:    codeOf(err, domain.NOT_SENT),
				Message: messageOf(err) + "; the manifest still names " + newVersion,
			}
		}
		return domain.Result{}, err
	}
	s.endStep(onStep, "pull", "completed")

	s.beginStep(onStep, applyID)
	if err := engine.Apply(ctx, host, dir); err != nil {
		s.endStep(onStep, applyID, "failed")
		// The manifest already names the new tag while the old container may
		// still be up; put the old tag back without restarting anything. If
		// that also fails the error has to say the manifest is ahead, because
		// the page will otherwise report the container as up to date.
		if restoreErr := s.restoreManifest(ctx, host, dir, engine, current); restoreErr != nil {
			return domain.Result{}, domain.Error{
				Code:    codeOf(err, domain.NOT_SENT),
				Message: messageOf(err) + "; the manifest still names " + newVersion,
			}
		}
		return domain.Result{}, err
	}
	s.endStep(onStep, applyID, "completed")

	s.beginStep(onStep, "healthy")
	if err := s.waitHealthy(ctx, target, nil); err != nil {
		s.endStep(onStep, "healthy", "failed")
		return s.rollback(ctx, target, host, dir, engine, current, messageOf(err), onStep)
	}
	s.endStep(onStep, "healthy", "completed")
	return domain.Result{State: "published", VersionID: "container:" + newVersion}, nil
}

// restoreManifest puts previous back into the manifest.
func (s *Service) restoreManifest(ctx context.Context, host Host, dir string, engine Engine, previous string) error {
	writeCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return engine.WriteManifest(writeCtx, host, dir, previous)
}

// rollback runs the previous version again. It is only called after the new
// version failed to become healthy, so the failed version's logs travel with
// the returned error whichever way the rollback ends.
func (s *Service) rollback(ctx context.Context, target domain.Target, host Host, dir string, engine Engine, previous, failedLogs string, onStep func(domain.Step)) (domain.Result, error) {
	fail := func(err error) (domain.Result, error) {
		message := failedLogs
		if note := messageOf(err); note != "" {
			message = strings.TrimSpace(message + "\n" + note)
		}
		// A lost host or a stopped runtime is actionable on its own; reporting
		// it as "the rollback failed" would hide the one code the page knows how
		// to explain.
		code := codeOf(err, domain.UPGRADE_ROLLBACK_FAILED)
		if strings.HasPrefix(code, "SSH_") || strings.HasPrefix(code, "LOCAL_RUNTIME_") {
			return domain.Result{}, domain.Error{Code: code, Message: message}
		}
		return domain.Result{}, domain.Error{Code: domain.UPGRADE_ROLLBACK_FAILED, Message: message}
	}
	s.beginStep(onStep, "rollback")
	if err := s.restoreManifest(ctx, host, dir, engine, previous); err != nil {
		s.endStep(onStep, "rollback", "failed")
		return fail(err)
	}
	// No pull here: the previous image was running minutes ago and is almost
	// certainly still local, so the rollback also works when the registry is
	// unreachable.
	if err := engine.Apply(ctx, host, dir); err != nil {
		s.endStep(onStep, "rollback", "failed")
		return fail(err)
	}
	if err := s.waitHealthy(ctx, target, nil); err != nil {
		s.endStep(onStep, "rollback", "failed")
		return fail(err)
	}
	s.endStep(onStep, "rollback", "completed")
	return domain.Result{}, domain.Error{Code: domain.UPGRADE_ROLLED_BACK, Message: failedLogs}
}
