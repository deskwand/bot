// Package auth manages the Cloudflare credentials used by the deployment
// client. It signs in with OAuth 2.0 Authorization Code + PKCE against
// Cloudflare's public client, keeps the rotating refresh token in the system
// credential store, and hands the Cloudflare API client a fresh access token.
// https://developers.cloudflare.com/fundamentals/oauth/
package auth

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/platform"
)

const (
	// KeyRefreshToken is the rotating OAuth refresh token.
	KeyRefreshToken = "cloudflare.oauth.refresh-token"
	// KeyAccountID is the selected Cloudflare account.
	KeyAccountID = "cloudflare.oauth.account-id"
	// KeyAccountName is the account display name. It is not a secret.
	KeyAccountName = "cloudflare.oauth.account-name"
)

// legacyKeys are the pre-OAuth credential items. They are deleted on startup.
var legacyKeys = []string{"cloudflare.api-token", "cloudflare.account-id"}

const (
	// StateConnected means local credentials are present and usable.
	StateConnected = "connected"
	// StateReauthRequired means the refresh token is no longer accepted.
	StateReauthRequired = "reauth_required"
	// StateDisconnected means no local Cloudflare credentials are stored.
	StateDisconnected = "disconnected"
	// StateUnavailable means the system credential store cannot be read.
	StateUnavailable = "unavailable"
)

// Fixed error codes returned to the UI. Messages are safe to display and never
// contain a token.
const (
	ErrCodeVerifyFailed               = "AUTH_VERIFY_FAILED"
	ErrCodeCredentialStoreUnavailable = "CREDENTIAL_STORE_UNAVAILABLE"
	ErrCodeCredentialStoreFailure     = "CREDENTIAL_STORE_FAILURE"
	ErrCodeNotConnected               = "AUTH_NOT_CONNECTED"

	// OAuth login and session lifetime.
	ErrCodeOAuthDenied         = "AUTH_OAUTH_DENIED"
	ErrCodeOAuthTimeout        = "AUTH_OAUTH_TIMEOUT"
	ErrCodeOAuthPortBusy       = "AUTH_OAUTH_PORT_BUSY"
	ErrCodeOAuthStateMismatch  = "AUTH_OAUTH_STATE_MISMATCH"
	ErrCodeOAuthExchangeFailed = "AUTH_OAUTH_EXCHANGE_FAILED"
	ErrCodeNoAccount           = "AUTH_NO_ACCOUNT"
	ErrCodeReauthRequired      = "AUTH_REAUTH_REQUIRED"
)

// Error is a safe authorization error with a stable machine-readable code.
type Error struct {
	Code    string
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e == nil {
		return "auth: <nil>"
	}
	// Lead with the stable code, like domain.Error, so the UI can map it
	// after the error crosses the MyGo bridge as plain text.
	if e.Message != "" {
		return e.Code + ": " + e.Message
	}
	if e.Err != nil {
		return e.Code + ": " + e.Err.Error()
	}
	return e.Code
}

func (e *Error) Unwrap() error { return e.Err }

// Code returns the stable error code in err, or "" when err is not an auth
// Error.
func Code(err error) string {
	var target *Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

// Account identifies one Cloudflare account the authorization can act on.
type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Connection is the non-secret local connection state. It never contains a
// token.
type Connection struct {
	State       string `json:"state"`
	AccountID   string `json:"accountId,omitempty"`
	AccountName string `json:"accountName,omitempty"`
}

type cloudflareAPI interface {
	GetJSON(ctx context.Context, path string, query url.Values, out any) error
}

// tokenSkew refreshes the access token before it actually expires.
const tokenSkew = 120 * time.Second

// TokenService owns Cloudflare OAuth credentials. The refresh token is written
// only to the operating system credential store; the access token lives in
// memory and never reaches the frontend.
//
// The OAuth client requests these permissions (see RequiredScopes): Workers
// Scripts, Workers R2 Storage, Workers Observability, Workers Observability
// Telemetry and Account Settings.
type TokenService struct {
	mu        sync.Mutex
	refreshMu sync.Mutex
	store     platform.CredentialStore
	newAPI    func(token string) cloudflareAPI
	http      *http.Client
	endpoints OAuthEndpoints
	listen    listenerFunc
	now       func() time.Time

	access    string
	expiresAt time.Time
	reauth    bool
}

// NewTokenService returns a service backed by the system credential store and
// the fixed-origin Cloudflare client.
func NewTokenService(store platform.CredentialStore) *TokenService {
	service := &TokenService{
		store: store,
		newAPI: func(token string) cloudflareAPI {
			return cloudflare.New(cloudflare.Options{
				Token: func(context.Context) (string, error) { return token, nil },
			})
		},
		http:      &http.Client{Timeout: oauthTimeout},
		endpoints: CloudflareOAuthEndpoints,
		listen:    defaultListen,
		now:       time.Now,
	}
	// API-token credentials from before OAuth are dead weight; drop them at
	// startup so a stale key can never look like a working connection.
	service.cleanupLegacy(context.Background())
	return service
}

// Status reports whether local credentials are present. It does not return or
// log the refresh token.
func (s *TokenService) Status(ctx context.Context) (Connection, error) {
	refresh, err := s.store.Get(ctx, KeyRefreshToken)
	if errors.Is(err, platform.ErrCredentialNotFound) {
		return Connection{State: StateDisconnected}, nil
	}
	if err != nil {
		return Connection{State: StateUnavailable}, credentialStoreError(err)
	}
	if refresh == "" {
		return Connection{State: StateDisconnected}, nil
	}
	accountID, _ := s.store.Get(ctx, KeyAccountID)
	accountName, _ := s.store.Get(ctx, KeyAccountName)
	if accountID == "" {
		// A refresh token without an account cannot drive any operation.
		return Connection{State: StateDisconnected}, nil
	}

	s.mu.Lock()
	reauth := s.reauth
	s.mu.Unlock()

	state := StateConnected
	if reauth {
		state = StateReauthRequired
	}
	return Connection{State: state, AccountID: accountID, AccountName: accountName}, nil
}

// Token returns a valid access token for the Cloudflare client. It refreshes at
// most once per expiry window and persists the rotated refresh token before
// returning, because Cloudflare invalidates the old one immediately.
func (s *TokenService) Token(ctx context.Context) (string, error) {
	if token, ok := s.cachedToken(); ok {
		return token, nil
	}
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if token, ok := s.cachedToken(); ok {
		return token, nil
	}

	refresh, err := s.store.Get(ctx, KeyRefreshToken)
	if errors.Is(err, platform.ErrCredentialNotFound) || (err == nil && refresh == "") {
		return "", &Error{Code: ErrCodeNotConnected, Message: "no Cloudflare account is connected"}
	}
	if err != nil {
		return "", credentialStoreError(err)
	}

	set, err := refreshAccess(ctx, s.http, s.endpoints, refresh)
	if errors.Is(err, errInvalidGrant) {
		s.markReauthRequired()
		return "", &Error{Code: ErrCodeReauthRequired, Message: "Cloudflare no longer accepts this authorization; sign in again"}
	}
	if err != nil {
		return "", err
	}
	// Persist first: a lost rotation would strand the user with a dead token.
	if err := s.store.Set(ctx, KeyRefreshToken, set.Refresh); err != nil {
		return "", credentialStoreError(err)
	}

	s.mu.Lock()
	s.access = set.Access
	s.expiresAt = s.now().Add(time.Duration(set.ExpiresIn) * time.Second)
	s.reauth = false
	s.mu.Unlock()
	return set.Access, nil
}

func (s *TokenService) cachedToken() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.access == "" || s.reauth {
		return "", false
	}
	if s.now().Add(tokenSkew).After(s.expiresAt) {
		return "", false
	}
	return s.access, true
}

func (s *TokenService) markReauthRequired() {
	s.mu.Lock()
	s.reauth = true
	s.access = ""
	s.expiresAt = time.Time{}
	s.mu.Unlock()
}

func (s *TokenService) listAccounts(ctx context.Context, access string) ([]Account, error) {
	var accounts []Account
	if err := s.newAPI(access).GetJSON(ctx, "/accounts", nil, &accounts); err != nil {
		return nil, &Error{Code: ErrCodeNoAccount, Message: "could not read the Cloudflare accounts for this authorization", Err: err}
	}
	return accounts, nil
}

// storeLogin persists the authorized account and caches the access token. It
// holds refreshMu so a concurrent refresh cannot interleave its writes.
func (s *TokenService) storeLogin(ctx context.Context, set tokenSet, account Account) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	previous := map[string]credentialSnapshot{}
	for _, key := range []string{KeyRefreshToken, KeyAccountID, KeyAccountName} {
		value, err := s.store.Get(ctx, key)
		switch {
		case err == nil:
			previous[key] = credentialSnapshot{value: value, exists: true}
		case errors.Is(err, platform.ErrCredentialNotFound):
			previous[key] = credentialSnapshot{}
		default:
			return credentialStoreError(err)
		}
	}
	writes := []struct{ key, value string }{
		{KeyRefreshToken, set.Refresh},
		{KeyAccountID, account.ID},
		{KeyAccountName, account.Name},
	}
	for _, write := range writes {
		if err := s.store.Set(ctx, write.key, write.value); err != nil {
			return errors.Join(credentialStoreError(err), s.rollback(ctx, previous))
		}
	}

	s.mu.Lock()
	s.access = set.Access
	s.expiresAt = s.now().Add(time.Duration(set.ExpiresIn) * time.Second)
	s.reauth = false
	s.mu.Unlock()
	return nil
}

// Disconnect revokes the authorization in Cloudflare and deletes the local
// credentials. A rejected revoke is not an error: the user cannot act on it,
// and the local credentials are gone either way.
func (s *TokenService) Disconnect(ctx context.Context) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	refresh, err := s.store.Get(ctx, KeyRefreshToken)
	if err == nil && refresh != "" {
		_ = revokeAccess(ctx, s.http, s.endpoints, refresh)
	}

	s.mu.Lock()
	s.access = ""
	s.expiresAt = time.Time{}
	s.reauth = false
	s.mu.Unlock()

	var failures []error
	for _, key := range []string{KeyRefreshToken, KeyAccountID, KeyAccountName} {
		err := s.store.Delete(context.WithoutCancel(ctx), key)
		if err == nil || errors.Is(err, platform.ErrCredentialNotFound) {
			continue
		}
		failures = append(failures, credentialStoreError(err))
	}
	return errors.Join(failures...)
}

func (s *TokenService) cleanupLegacy(ctx context.Context) {
	for _, key := range legacyKeys {
		_ = s.store.Delete(ctx, key)
	}
}

type credentialSnapshot struct {
	value  string
	exists bool
}

func (s *TokenService) rollback(ctx context.Context, previous map[string]credentialSnapshot) error {
	ctx = context.WithoutCancel(ctx)
	var failures []error
	for key, snapshot := range previous {
		var err error
		if snapshot.exists {
			err = s.store.Set(ctx, key, snapshot.value)
		} else {
			err = s.store.Delete(ctx, key)
			if errors.Is(err, platform.ErrCredentialNotFound) {
				err = nil
			}
		}
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func credentialStoreError(err error) *Error {
	switch {
	case errors.Is(err, platform.ErrCredentialStoreUnavailable):
		return &Error{
			Code:    ErrCodeCredentialStoreUnavailable,
			Message: "the system credential store is unavailable",
			Err:     platform.ErrCredentialStoreUnavailable,
		}
	case errors.Is(err, platform.ErrCredentialNotFound):
		return &Error{Code: ErrCodeNotConnected, Message: "no Cloudflare account is connected"}
	default:
		return &Error{
			Code:    ErrCodeCredentialStoreFailure,
			Message: "cannot access the system credential store",
			Err:     err,
		}
	}
}
