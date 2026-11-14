package container

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
)

// Engine runs the container runtime commands for one target. The flow code
// (preflight, install, publish, snapshot) talks to it instead of a runtime
// command line, so a second runtime can be added without touching the flows.
type Engine interface {
	Preflight(ctx context.Context, host Host, dir string) (PreflightReport, error)
	WriteManifest(ctx context.Context, host Host, dir, version string) error
	ReadVersion(ctx context.Context, host Host, dir string) (string, error)
	Pull(ctx context.Context, host Host, dir string) error
	Apply(ctx context.Context, host Host, dir string) error
	// Stop stops the container and its supervisor, keeping the data volume and
	// the .env file. Start brings the same volume back up.
	Stop(ctx context.Context, host Host, dir string) error
	Start(ctx context.Context, host Host, dir string) error
	// Status fills Running, Health, StartedAt and Image. An error whose code
	// starts with SSH_ or LOCAL_RUNTIME_ means the runtime is unreachable.
	Status(ctx context.Context, host Host, dir string) (RuntimeStatus, error)
	Logs(ctx context.Context, host Host, dir string) (string, error)
	Remove(ctx context.Context, host Host, dir string) error
	Dialect() envfile.Dialect
	StepIDs() (manifest, apply string)
}

// engine returns the engine that serves target. A local target runs compose on
// this Mac, or Apple's container tool when the directory was installed that
// way.
func (s *Service) engine(target domain.Target) Engine {
	if target.Host.EngineName() == domain.EngineApple {
		return &appleEngine{text: s.text, message: s.message}
	}
	return &composeEngine{
		local:   target.Host.IsLocal() && target.Host.EngineName() == domain.EngineCompose,
		text:    s.text,
		message: s.message,
	}
}
