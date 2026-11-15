package app

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/owneradmin"
)

// OwnerStatusDTO is the frontend view of the owner-claim state.
type OwnerStatusDTO struct {
	Mode           string `json:"mode"`
	OwnerUserID    string `json:"ownerUserId"`
	WindowOpenedAt int64  `json:"windowOpenedAt"`
	WindowClosesAt int64  `json:"windowClosesAt"`
}

func ownerStatusFrom(status owneradmin.Status) OwnerStatusDTO {
	return OwnerStatusDTO{
		Mode:           status.Mode,
		OwnerUserID:    status.OwnerUserID,
		WindowOpenedAt: status.WindowOpenedAt,
		WindowClosesAt: status.WindowClosesAt,
	}
}

// ownerClient mirrors lifeClient: the ADMIN_TOKEN flow is shared with backups,
// so the Voice page works before the user ever opens the backup page.
func (s *Service) ownerClient(ctx context.Context, target domain.Target) (*owneradmin.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := owneradmin.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}

func (s *Service) ownerCall(
	call func(context.Context, *owneradmin.Client) (owneradmin.Status, error),
) (OwnerStatusDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return OwnerStatusDTO{}, err
	}
	client, err := s.ownerClient(ctx, target)
	if err != nil {
		return OwnerStatusDTO{}, safeAppError(err)
	}
	status, err := call(ctx, client)
	if err != nil {
		return OwnerStatusDTO{}, s.adminFailure(err)
	}
	return ownerStatusFrom(status), nil
}

// OwnerStatus reads the claim state of the managed deployment.
func (s *Service) OwnerStatus() (OwnerStatusDTO, error) {
	return s.ownerCall(func(ctx context.Context, c *owneradmin.Client) (owneradmin.Status, error) {
		return c.Status(ctx)
	})
}

// OpenOwnerClaim reopens the claim window.
func (s *Service) OpenOwnerClaim() (OwnerStatusDTO, error) {
	return s.ownerCall(func(ctx context.Context, c *owneradmin.Client) (owneradmin.Status, error) {
		return c.Open(ctx)
	})
}

// RevokeOwner clears the claim and closes the window.
func (s *Service) RevokeOwner() (OwnerStatusDTO, error) {
	return s.ownerCall(func(ctx context.Context, c *owneradmin.Client) (owneradmin.Status, error) {
		return c.Revoke(ctx)
	})
}
