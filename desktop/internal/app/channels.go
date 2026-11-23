package app

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/channeladmin"
)

func (s *Service) channelClient(ctx context.Context, target domain.Target) (*channeladmin.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := channeladmin.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}

// Members lists the owner and every channel user with its connection state.
func (s *Service) Channels() (ChannelsDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ChannelsDTO{}, err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return ChannelsDTO{}, err
	}
	users, err := client.Channels(ctx)
	if err != nil {
		return ChannelsDTO{}, s.adminFailure(err)
	}
	out := ChannelsDTO{Channels: make([]ChannelDTO, 0, len(users))}
	for _, row := range users {
		out.Channels = append(out.Channels, ChannelDTO{
			ChannelID:     row.ChannelID,
			Label:         row.Label,
			Account:       row.Account,
			State:         row.State,
			LastErrorCode: row.LastErrorCode,
		})
	}
	return out, nil
}

// MemberInvites lists invitations the wizard can resume.
func (s *Service) ChannelBindings() (ChannelInvitesDTO, error) {
	// The channel list carries no invite ids; a pending binding is resumed from
	// the wizard's own state, so this payload stays empty until Phase 3 wires a
	// dedicated bindings query. Keeping the method avoids a broken UI call.
	out := ChannelInvitesDTO{Bindings: []ChannelInviteDTO{}}
	return out, nil
}

// CreateMemberInvite starts a new-user invite. bindUrl never reaches the UI.
func (s *Service) CreateChannel(label string) (ChannelInviteDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ChannelInviteDTO{}, err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return ChannelInviteDTO{}, err
	}
	invite, err := client.CreateInvite(ctx, label)
	if err != nil {
		return ChannelInviteDTO{}, s.adminFailure(err)
	}
	return channelInviteDTO(invite), nil
}

// MemberInviteState reads one invite's stage.
func (s *Service) ChannelBindingState(id string) (ChannelBindingDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ChannelBindingDTO{}, err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return ChannelBindingDTO{}, err
	}
	state, err := client.InviteState(ctx, id)
	if err != nil {
		return ChannelBindingDTO{}, s.adminFailure(err)
	}
	return channelBindingDTO(state), nil
}

// SubmitMemberPin relays the PIN WeChat showed on the invitee's phone.
func (s *Service) SubmitChannelPin(id, pin string) (ChannelBindingDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ChannelBindingDTO{}, err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return ChannelBindingDTO{}, err
	}
	state, err := client.SubmitPin(ctx, id, pin)
	if err != nil {
		return ChannelBindingDTO{}, s.adminFailure(err)
	}
	return channelBindingDTO(state), nil
}

// CancelMemberInvite closes a pending invite.
func (s *Service) CancelChannelBinding(id string) error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return err
	}
	if err := client.CancelInvite(ctx, id); err != nil {
		return s.adminFailure(err)
	}
	return nil
}

// RebindMember starts a replacement invite for one existing user.
func (s *Service) RebindChannel(id string) (ChannelInviteDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ChannelInviteDTO{}, err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return ChannelInviteDTO{}, err
	}
	invite, err := client.Rebind(ctx, id)
	if err != nil {
		return ChannelInviteDTO{}, s.adminFailure(err)
	}
	return channelInviteDTO(invite), nil
}

// RevokeMember removes one user's access and credentials.
func (s *Service) RemoveChannel(id string) error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return err
	}
	if err := client.Remove(ctx, id); err != nil {
		return s.adminFailure(err)
	}
	return nil
}

func channelInviteDTO(invite channeladmin.Invite) ChannelInviteDTO {
	return ChannelInviteDTO{
		InviteID:  invite.InviteID,
		Label:     invite.Label,
		Kind:      invite.Kind,
		ChannelID: invite.MemberID,
		ExpiresAt: invite.ExpiresAt,
	}
}

func channelBindingDTO(state channeladmin.InviteState) ChannelBindingDTO {
	return ChannelBindingDTO{
		InviteID:         state.InviteID,
		Label:            state.Label,
		Status:           state.Status,
		Stage:            state.Stage,
		ExpiresAt:        state.ExpiresAt,
		RealnameDeadline: state.RealnameDeadline,
		RealnameURL:      state.RealnameURL,
		QRContent:        state.QRContent,
		Failure:          state.Failure,
	}
}

// RestartChannel re-arms one channel's chains without touching its identity.
func (s *Service) RestartChannel(id string) error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.channelClient(ctx, target)
	if err != nil {
		return err
	}
	if err := client.Restart(ctx, id); err != nil {
		return s.adminFailure(err)
	}
	return nil
}

// Deprecated compatibility for the shipped client; see the DTO note.

func (s *Service) Members() (MembersDTO, error) {
	rows, err := s.Channels()
	if err != nil {
		return MembersDTO{}, err
	}
	out := MembersDTO{Users: make([]MemberUserDTO, 0, len(rows.Channels))}
	for _, row := range rows.Channels {
		out.Users = append(out.Users, MemberUserDTO{
			MemberID:   row.ChannelID,
			Label:      row.Label,
			Role:       "member",
			Status:     "active",
			Connection: row.State,
			InviteID:   nil,
		})
	}
	return out, nil
}

func (s *Service) MemberInvites() (MemberInvitesDTO, error) {
	return MemberInvitesDTO{Invites: []MemberInviteDTO{}}, nil
}

func (s *Service) CreateMemberInvite(label string) (MemberInviteDTO, error) {
	invite, err := s.CreateChannel(label)
	if err != nil {
		return MemberInviteDTO{}, err
	}
	return MemberInviteDTO{InviteID: invite.InviteID, Label: invite.Label, ExpiresAt: invite.ExpiresAt}, nil
}

func (s *Service) MemberInviteState(id string) (ChannelBindingDTO, error) {
	return s.ChannelBindingState(id)
}

func (s *Service) SubmitMemberPin(id, pin string) (ChannelBindingDTO, error) {
	return s.SubmitChannelPin(id, pin)
}

func (s *Service) CancelMemberInvite(id string) error { return s.CancelChannelBinding(id) }

func (s *Service) RebindMember(id string) (MemberInviteDTO, error) {
	invite, err := s.RebindChannel(id)
	if err != nil {
		return MemberInviteDTO{}, err
	}
	return MemberInviteDTO{InviteID: invite.InviteID, Label: invite.Label, ExpiresAt: invite.ExpiresAt}, nil
}

func (s *Service) RevokeMember(id string) error { return s.RemoveChannel(id) }
