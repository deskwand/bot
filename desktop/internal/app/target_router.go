package app

import (
	"context"
	"fmt"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// PublishRouter sends each target to the implementation that owns its kind.
// Resume and Abandon stay on Cloudflare: container publishes are not journaled
// and therefore never resume.
type PublishRouter struct {
	Cloudflare PublishService
	Container  EntryPublisher
}

// Preview describes a publish for the target's kind.
func (r *PublishRouter) Preview(ctx context.Context, target domain.Target, change domain.Change) ([]domain.Step, error) {
	if target.IsContainer() {
		if r.Container == nil {
			return nil, fmt.Errorf("app: container publisher is not wired")
		}
		return r.Container.Preview(ctx, target, change)
	}
	if r.Cloudflare == nil {
		return nil, fmt.Errorf("app: cloudflare publisher is not wired")
	}
	return r.Cloudflare.Preview(ctx, target, change)
}

// Apply publishes the change through the target's implementation.
func (r *PublishRouter) Apply(ctx context.Context, target domain.Target, change domain.Change) (domain.Result, error) {
	if target.IsContainer() {
		if r.Container == nil {
			return domain.Result{}, fmt.Errorf("app: container publisher is not wired")
		}
		return r.Container.Apply(ctx, target, change)
	}
	if r.Cloudflare == nil {
		return domain.Result{}, fmt.Errorf("app: cloudflare publisher is not wired")
	}
	return r.Cloudflare.Apply(ctx, target, change)
}

// Resume continues a journaled Cloudflare operation.
func (r *PublishRouter) Resume(ctx context.Context, operationID string) (domain.Result, error) {
	if r.Cloudflare == nil {
		return domain.Result{}, fmt.Errorf("app: cloudflare publisher is not wired")
	}
	return r.Cloudflare.Resume(ctx, operationID)
}

// Abandon closes a journaled Cloudflare operation.
func (r *PublishRouter) Abandon(ctx context.Context, operationID string) (domain.Result, error) {
	if r.Cloudflare == nil {
		return domain.Result{}, fmt.Errorf("app: cloudflare publisher is not wired")
	}
	return r.Cloudflare.Abandon(ctx, operationID)
}

// SnapshotRouter reads the snapshot from the target's implementation.
type SnapshotRouter struct {
	Cloudflare SnapshotReader
	Container  SnapshotReader
}

// ReadSnapshot reads the current target state.
func (r *SnapshotRouter) ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error) {
	if target.IsContainer() {
		if r.Container == nil {
			return domain.Snapshot{}, fmt.Errorf("app: container snapshot reader is not wired")
		}
		return r.Container.ReadSnapshot(ctx, target)
	}
	if r.Cloudflare == nil {
		return domain.Snapshot{}, fmt.Errorf("app: cloudflare snapshot reader is not wired")
	}
	return r.Cloudflare.ReadSnapshot(ctx, target)
}

// StatusRouter reads diagnostics from the target's implementation.
type StatusRouter struct {
	Cloudflare StatusService
	Container  StatusService
}

// Status returns the evidence-based status for the target's kind.
func (r *StatusRouter) Status(ctx context.Context, target domain.Target) (DiagnosticsReport, error) {
	service, err := r.pick(target)
	if err != nil {
		return DiagnosticsReport{}, err
	}
	return service.Status(ctx, target)
}

// ExportDiagnostics returns the sanitized export for the target's kind.
func (r *StatusRouter) ExportDiagnostics(ctx context.Context, target domain.Target) ([]byte, error) {
	service, err := r.pick(target)
	if err != nil {
		return nil, err
	}
	return service.ExportDiagnostics(ctx, target)
}

func (r *StatusRouter) pick(target domain.Target) (StatusService, error) {
	if target.IsContainer() {
		if r.Container == nil {
			return nil, fmt.Errorf("app: container diagnostics are not wired")
		}
		return r.Container, nil
	}
	if r.Cloudflare == nil {
		return nil, fmt.Errorf("app: cloudflare diagnostics are not wired")
	}
	return r.Cloudflare, nil
}
