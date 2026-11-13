package container

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// LocalRuntimes names the container runtimes this Mac has installed.
type LocalRuntimes struct {
	Apple   bool
	Compose bool
}

// DetectLocal reports which container runtimes are on this Mac's PATH. A
// runtime that is installed but stopped still counts: the preflight is where a
// stopped daemon shows up as a fixable state.
func (s *Service) DetectLocal(ctx context.Context) (LocalRuntimes, error) {
	host, err := s.dial(domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{Transport: domain.TransportLocal},
	})
	if err != nil {
		return LocalRuntimes{}, err
	}
	apple, err := commandPresent(ctx, host, "container")
	if err != nil {
		return LocalRuntimes{}, err
	}
	compose, err := commandPresent(ctx, host, "docker")
	if err != nil {
		return LocalRuntimes{}, err
	}
	return LocalRuntimes{Apple: apple, Compose: compose}, nil
}

// commandPresent reports whether name is on the PATH. Exit code 0 means the
// command exists.
func commandPresent(ctx context.Context, host Host, name string) (bool, error) {
	result, err := runOnHost(ctx, host, "command -v "+name)
	if err != nil {
		return false, err
	}
	return result.ExitCode == 0, nil
}

// AdoptLocal takes over the container that already lives in a local directory.
// A healthy container is left exactly as it is. Otherwise the manifest is
// rewritten from the version already installed and the engine restarts the
// container. The .env is never read or written, because the configuration is
// already there and must survive the takeover.
func (s *Service) AdoptLocal(ctx context.Context, target domain.Target, onStep func(domain.Step)) (domain.Result, error) {
	if !target.IsContainer() || !target.Host.IsLocal() {
		return domain.Result{}, domain.Error{Code: domain.TARGET_UNSUPPORTED}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	status, err := s.Status(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}
	if status.Health == "healthy" {
		return domain.Result{State: "published"}, nil
	}

	host, err := s.dial(target)
	if err != nil {
		return domain.Result{}, err
	}
	dir := target.Host.Dir
	engine := s.engine(target)

	// The version comes from the manifest already in place: an update is a
	// separate flow, and a missing manifest is an error rather than a guess.
	version, err := engine.ReadVersion(ctx, host, dir)
	if err != nil {
		return domain.Result{}, err
	}
	if version == "" {
		// An image reference with an empty tag would end in ":", so refuse
		// before anything is written.
		return domain.Result{}, envFileError("the manifest names no version")
	}

	manifestID, applyID := engine.StepIDs()
	s.beginStep(onStep, manifestID)
	if err := engine.WriteManifest(ctx, host, dir, version); err != nil {
		s.endStep(onStep, manifestID, "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, manifestID, "completed")

	s.beginStep(onStep, applyID)
	if err := engine.Apply(ctx, host, dir); err != nil {
		s.endStep(onStep, applyID, "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, applyID, "completed")

	s.beginStep(onStep, "healthy")
	if err := s.waitHealthy(ctx, target, nil); err != nil {
		s.endStep(onStep, "healthy", "failed")
		return domain.Result{}, err
	}
	s.endStep(onStep, "healthy", "completed")

	return domain.Result{State: "published"}, nil
}

// Remove stops the container that runs on this Mac and deletes its manifest.
// It refuses an SSH host, whose container is removed by the remote flows.
func (s *Service) Remove(ctx context.Context, target domain.Target) error {
	if !target.IsContainer() || !target.Host.IsLocal() {
		return domain.Error{Code: domain.TARGET_UNSUPPORTED}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	host, err := s.dial(target)
	if err != nil {
		return err
	}
	return s.engine(target).Remove(ctx, host, target.Host.Dir)
}
