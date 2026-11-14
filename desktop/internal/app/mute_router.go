package app

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// ContainerTargets is the container lifecycle the mute router needs. It is
// spelled out here so this package does not depend on the container service.
type ContainerTargets interface {
	StopTarget(ctx context.Context, target domain.Target) error
	StartTarget(ctx context.Context, target domain.Target) error
}

// EntryMuter silences and revives a Worker's entry. *EntryService implements it.
type EntryMuter interface {
	MuteEntry(ctx context.Context, target domain.Target) (domain.Result, error)
	ReviveEntry(ctx context.Context, target domain.Target, channel string) (domain.Result, error)
}

// MuteRouter silences whichever residence a target names: a container is
// stopped, a Worker drops its entry selection. Both keep credentials, so a
// move back needs no new secret.
type MuteRouter struct {
	Containers ContainerTargets
	Entries    EntryMuter
}

func (r *MuteRouter) Mute(ctx context.Context, target domain.Target) error {
	if target.IsContainer() {
		return r.Containers.StopTarget(ctx, target)
	}
	_, err := r.Entries.MuteEntry(ctx, target)
	return err
}

func (r *MuteRouter) Revive(ctx context.Context, target domain.Target, channel string) error {
	if target.IsContainer() {
		return r.Containers.StartTarget(ctx, target)
	}
	_, err := r.Entries.ReviveEntry(ctx, target, channel)
	return err
}
