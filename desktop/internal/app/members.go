package app

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/memberadmin"
)

func (s *Service) memberClient(ctx context.Context, target domain.Target) (*memberadmin.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := memberadmin.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}

// Members lists the owner and every channel user with its connection state.
func (s *Service) Members() (MembersDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return MembersDTO{}, err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return MembersDTO{}, err
	}
	users, err := client.List(ctx)
	if err != nil {
		return MembersDTO{}, s.adminFailure(err)
	}
	out := MembersDTO{Users: make([]MemberUserDTO, 0, len(users))}
	for _, user := range users {
		out.Users = append(out.Users, MemberUserDTO{
			MemberID:   user.MemberID,
			Label:      user.Label,
			Role:       user.Role,
			Status:     user.Status,
			Connection: user.Connection,
			InviteID:   user.InviteID,
		})
	}
	return out, nil
}

// MemberInvites lists invitations the wizard can resume.
func (s *Service) MemberInvites() (MemberInvitesDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return MemberInvitesDTO{}, err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return MemberInvitesDTO{}, err
	}
	invites, err := client.PendingInvites(ctx)
	if err != nil {
		return MemberInvitesDTO{}, s.adminFailure(err)
	}
	out := MemberInvitesDTO{Invites: make([]MemberInviteDTO, 0, len(invites))}
	for _, invite := range invites {
		out.Invites = append(out.Invites, memberInviteDTO(invite))
	}
	return out, nil
}

// CreateMemberInvite starts a new-user invite. bindUrl never reaches the UI.
func (s *Service) CreateMemberInvite(label string) (MemberInviteDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return MemberInviteDTO{}, err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return MemberInviteDTO{}, err
	}
	invite, err := client.CreateInvite(ctx, label)
	if err != nil {
		return MemberInviteDTO{}, s.adminFailure(err)
	}
	return memberInviteDTO(invite), nil
}

// MemberInviteState reads one invite's stage.
func (s *Service) MemberInviteState(id string) (MemberInviteStateDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return MemberInviteStateDTO{}, err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return MemberInviteStateDTO{}, err
	}
	state, err := client.InviteState(ctx, id)
	if err != nil {
		return MemberInviteStateDTO{}, s.adminFailure(err)
	}
	return memberInviteStateDTO(state), nil
}

// SubmitMemberPin relays the PIN WeChat showed on the invitee's phone.
func (s *Service) SubmitMemberPin(id, pin string) (MemberInviteStateDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return MemberInviteStateDTO{}, err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return MemberInviteStateDTO{}, err
	}
	state, err := client.SubmitPin(ctx, id, pin)
	if err != nil {
		return MemberInviteStateDTO{}, s.adminFailure(err)
	}
	return memberInviteStateDTO(state), nil
}

// CancelMemberInvite closes a pending invite.
func (s *Service) CancelMemberInvite(id string) error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return err
	}
	if err := client.CancelInvite(ctx, id); err != nil {
		return s.adminFailure(err)
	}
	return nil
}

// RebindMember starts a replacement invite for one existing user.
func (s *Service) RebindMember(id string) (MemberInviteDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return MemberInviteDTO{}, err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return MemberInviteDTO{}, err
	}
	invite, err := client.Rebind(ctx, id)
	if err != nil {
		return MemberInviteDTO{}, s.adminFailure(err)
	}
	return memberInviteDTO(invite), nil
}

// RevokeMember removes one user's access and credentials.
func (s *Service) RevokeMember(id string) error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.memberClient(ctx, target)
	if err != nil {
		return err
	}
	if err := client.Revoke(ctx, id); err != nil {
		return s.adminFailure(err)
	}
	return nil
}

func memberInviteDTO(invite memberadmin.Invite) MemberInviteDTO {
	return MemberInviteDTO{
		InviteID:  invite.InviteID,
		Label:     invite.Label,
		Kind:      invite.Kind,
		MemberID:  invite.MemberID,
		ExpiresAt: invite.ExpiresAt,
	}
}

func memberInviteStateDTO(state memberadmin.InviteState) MemberInviteStateDTO {
	return MemberInviteStateDTO{
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
