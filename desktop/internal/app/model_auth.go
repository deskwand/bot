package app

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/modelauth"
)

// subscriptionProvider is the one provider whose credential is an OAuth
// subscription login. A second one would make these methods take a provider.
const subscriptionProvider = "openai-codex"

// pendingLogin is a started device-code login. The device handle is a one-time
// secret for the poll, so it stays in Go and never reaches the webview.
type pendingLogin struct {
	deviceAuthID string
	userCode     string
}

// ModelAuthStatus lists the subscription providers and whether they are signed in.
func (s *Service) ModelAuthStatus() ([]ModelAuthDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return []ModelAuthDTO{}, err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return []ModelAuthDTO{}, safeAppError(err)
	}
	providers, err := client.Status(ctx)
	if err != nil {
		return []ModelAuthDTO{}, s.adminFailure(err)
	}
	out := make([]ModelAuthDTO, 0, len(providers))
	for _, provider := range providers {
		out = append(out, ModelAuthDTO{Provider: provider.ID, Connected: provider.Connected})
	}
	return out, nil
}

// StartModelLogin asks the deployment for a device code and opens the page
// where the owner enters it. The returned code is the only thing the UI needs.
func (s *Service) StartModelLogin() (ModelLoginDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ModelLoginDTO{}, err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return ModelLoginDTO{}, safeAppError(err)
	}
	login, err := client.Start(ctx, subscriptionProvider)
	if err != nil {
		return ModelLoginDTO{}, s.adminFailure(err)
	}

	s.modelLoginMu.Lock()
	s.modelLogin = &pendingLogin{deviceAuthID: login.DeviceAuthID, userCode: login.UserCode}
	s.modelLoginMu.Unlock()

	opener := s.mcpBrowser
	if opener == nil {
		opener = s.browser
	}
	if opener == nil {
		return ModelLoginDTO{}, s.serviceUnavailable()
	}
	if err := opener.Open(login.VerificationURL); err != nil {
		return ModelLoginDTO{}, domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.browserOpenFailed")}
	}

	return ModelLoginDTO{
		UserCode:        login.UserCode,
		VerificationURL: login.VerificationURL,
		IntervalSeconds: login.IntervalSeconds,
	}, nil
}

// PollModelLogin reports the state of the login started by StartModelLogin:
// pending, slow_down or done.
func (s *Service) PollModelLogin() (string, error) {
	s.modelLoginMu.Lock()
	pending := s.modelLogin
	s.modelLoginMu.Unlock()
	if pending == nil {
		return "", domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.modelLoginNotStarted")}
	}

	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return "", err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return "", safeAppError(err)
	}
	result, err := client.Poll(ctx, subscriptionProvider, pending.deviceAuthID, pending.userCode)
	if err != nil {
		return "", s.adminFailure(err)
	}
	if result.Status == "done" {
		s.modelLoginMu.Lock()
		s.modelLogin = nil
		s.modelLoginMu.Unlock()
	}
	return result.Status, nil
}

// DisconnectModel forgets the deployment's subscription credential.
func (s *Service) DisconnectModel() error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return safeAppError(err)
	}
	if err := client.Disconnect(ctx, subscriptionProvider); err != nil {
		return s.adminFailure(err)
	}
	s.modelLoginMu.Lock()
	s.modelLogin = nil
	s.modelLoginMu.Unlock()
	return nil
}

func (s *Service) modelAuthClient(ctx context.Context, target domain.Target) (*modelauth.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := modelauth.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}
