// Package auth manages the Cloudflare API token used by the deployment
// client. v1 uses a user-created API token, not OAuth: Cloudflare has no
// public OAuth client registration for third-party desktop applications.
package auth

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/platform"
)

const (
	// KeyAPIToken is the credential-store key holding the Cloudflare token.
	KeyAPIToken = "cloudflare.api-token"
	// KeyAccountID is the credential-store key holding the selected account.
	KeyAccountID = "cloudflare.account-id"
)

const (
	// StateConnected means both local credentials are present.
	StateConnected = "connected"
	// StateDisconnected means no local Cloudflare credentials are stored.
	StateDisconnected = "disconnected"
	// StateUnavailable means the system credential store cannot be read.
	StateUnavailable = "unavailable"
)

// Fixed error codes returned to the UI. Messages are safe to display and never
// contain the API token.
const (
	ErrCodeInvalidToken               = "AUTH_INVALID_TOKEN"
	ErrCodeInvalidAccountID           = "AUTH_INVALID_ACCOUNT_ID"
	ErrCodeVerifyFailed               = "AUTH_VERIFY_FAILED"
	ErrCodeAccountLookupFailed        = "AUTH_ACCOUNT_LOOKUP_FAILED"
	ErrCodeCredentialStoreUnavailable = "CREDENTIAL_STORE_UNAVAILABLE"
	ErrCodeCredentialStoreFailure     = "CREDENTIAL_STORE_FAILURE"
	ErrCodeNotConnected               = "AUTH_NOT_CONNECTED"
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
	if e.Message != "" {
		return "auth: " + e.Message
	}
	if e.Err != nil {
		return "auth: " + e.Err.Error()
	}
	return "auth: " + e.Code
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

// Account identifies the Cloudflare account selected by the token.
type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Connection is the non-secret local connection state. It never contains the
// API token.
type Connection struct {
	State     string `json:"state"`
	AccountID string `json:"accountId,omitempty"`
}

type cloudflareAPI interface {
	GetJSON(ctx context.Context, path string, query url.Values, out any) error
}

// TokenService validates and stores the Cloudflare API token. The token is
// written only to the operating system credential store; callers and the
// frontend only receive Account and Connection values.
//
// Required token permissions (account scope; dashboard label / API group):
// Workers Scripts:Edit / Workers Scripts Write, Workers R2 Storage:Edit /
// Workers R2 Storage Write, Account Settings:Read / Account Settings Read.
// Task 9 diagnostics may additionally need Workers Observability:Read.
// https://developers.cloudflare.com/fundamentals/api/reference/permissions/
type TokenService struct {
	mu     sync.Mutex
	store  platform.CredentialStore
	newAPI func(token string) cloudflareAPI
}

// NewTokenService returns a service backed by the system credential store and
// the fixed-origin Cloudflare client.
func NewTokenService(store platform.CredentialStore) *TokenService {
	return &TokenService{
		store: store,
		newAPI: func(token string) cloudflareAPI {
			return cloudflare.New(cloudflare.Options{
				Token: func(context.Context) (string, error) { return token, nil },
			})
		},
	}
}

type tokenVerify struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type accountResult struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Connect validates accountID and token with Cloudflare, requires an active
// token, reads the account name, and stores the token and account ID. No
// credential is stored when validation fails.
func (s *TokenService) Connect(ctx context.Context, accountID, token string) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateAccountID(accountID); err != nil {
		return Account{}, &Error{Code: ErrCodeInvalidAccountID, Message: "account ID must be exactly 32 hexadecimal characters"}
	}
	accountID = strings.ToLower(accountID)
	token = strings.TrimSpace(token)
	if err := validateToken(token); err != nil {
		return Account{}, &Error{Code: ErrCodeInvalidToken, Message: err.Error()}
	}
	if ctx.Err() != nil {
		return Account{}, ctx.Err()
	}

	previous, err := s.previousCredentials(ctx)
	if err != nil {
		return Account{}, credentialStoreError(err)
	}

	api := s.newAPI(token)
	if err := verifyToken(ctx, api, accountID, token); err != nil {
		return Account{}, err
	}
	account, err := readAccount(ctx, api, accountID, token)
	if err != nil {
		return Account{}, err
	}

	// Account ID first, then the token. If either write fails, put the local
	// credentials back exactly as they were before this attempt.
	if err := s.store.Set(ctx, KeyAccountID, accountID); err != nil {
		return Account{}, errors.Join(credentialStoreError(err), s.rollbackCredentials(ctx, previous))
	}
	if err := s.store.Set(ctx, KeyAPIToken, token); err != nil {
		return Account{}, errors.Join(credentialStoreError(err), s.rollbackCredentials(ctx, previous))
	}
	return account, nil
}

// Status reports whether local credentials are present. It does not return or
// log the token.
func (s *TokenService) Status(ctx context.Context) (Connection, error) {
	accountID, err := s.store.Get(ctx, KeyAccountID)
	if errors.Is(err, platform.ErrCredentialNotFound) {
		return Connection{State: StateDisconnected}, nil
	}
	if err != nil {
		return Connection{State: StateUnavailable}, credentialStoreError(err)
	}
	token, err := s.store.Get(ctx, KeyAPIToken)
	if errors.Is(err, platform.ErrCredentialNotFound) {
		return Connection{State: StateDisconnected}, nil
	}
	if err != nil {
		return Connection{State: StateUnavailable}, credentialStoreError(err)
	}
	if accountID == "" || token == "" {
		return Connection{State: StateDisconnected}, nil
	}
	return Connection{State: StateConnected, AccountID: accountID}, nil
}

// Token returns the stored API token for the Cloudflare client. It is not a UI
// DTO; callers must not return, print or log the value.
func (s *TokenService) Token(ctx context.Context) (string, error) {
	token, err := s.store.Get(ctx, KeyAPIToken)
	if errors.Is(err, platform.ErrCredentialNotFound) {
		return "", &Error{Code: ErrCodeNotConnected, Message: "no Cloudflare API token is connected"}
	}
	if err != nil {
		return "", credentialStoreError(err)
	}
	if token == "" {
		return "", &Error{Code: ErrCodeNotConnected, Message: "no Cloudflare API token is connected"}
	}
	return token, nil
}

// Disconnect removes the local token and account ID. It does not change or
// delete the deployment in Cloudflare. A Cloudflare API token cannot revoke
// itself; the user must delete or roll it in the Cloudflare dashboard.
func (s *TokenService) Disconnect(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var failures []error
	for _, key := range []string{KeyAPIToken, KeyAccountID} {
		err := s.store.Delete(ctx, key)
		if err == nil || errors.Is(err, platform.ErrCredentialNotFound) {
			continue
		}
		failures = append(failures, credentialStoreError(err))
	}
	return errors.Join(failures...)
}

func validateAccountID(accountID string) error {
	if len(accountID) != 32 {
		return errors.New("account ID length")
	}
	if _, err := hex.DecodeString(accountID); err != nil {
		return errors.New("account ID encoding")
	}
	return nil
}

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{20,512}$`)

func validateToken(token string) error {
	token = strings.TrimSpace(token)
	if !tokenPattern.MatchString(token) {
		return errors.New("API token must be 20-512 characters using letters, digits, underscore or hyphen")
	}
	return nil
}

func verifyToken(ctx context.Context, api cloudflareAPI, accountID, token string) error {
	// Endpoints and status field:
	// https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/
	// https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
	// Token prefixes: https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/
	paths := []string{"/user/tokens/verify"}
	if strings.HasPrefix(token, "cfat_") {
		paths = []string{"/accounts/" + accountID + "/tokens/verify"}
	} else {
		paths = append(paths, "/accounts/"+accountID+"/tokens/verify")
	}

	var lastErr error
	for _, path := range paths {
		var result tokenVerify
		err := api.GetJSON(ctx, path, nil, &result)
		if err == nil {
			if result.Status == "active" {
				return nil
			}
			status := result.Status
			if status == "" {
				status = "unknown"
			}
			return &Error{
				Code:    ErrCodeInvalidToken,
				Message: "Cloudflare reports the API token status as " + redactToken(status, token),
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		lastErr = err
	}

	var apiErr *cloudflare.APIError
	if isTokenRejection(lastErr) && errors.As(lastErr, &apiErr) {
		return &Error{
			Code:    ErrCodeInvalidToken,
			Message: fmt.Sprintf("Cloudflare rejected the API token (HTTP %d, code %d)", apiErr.Status, apiErr.Code),
		}
	}
	return &Error{
		Code:    ErrCodeVerifyFailed,
		Message: "could not reach Cloudflare to verify the API token; try again",
	}
}

func readAccount(ctx context.Context, api cloudflareAPI, accountID, token string) (Account, error) {
	var result accountResult
	if err := api.GetJSON(ctx, "/accounts/"+accountID, nil, &result); err != nil {
		if ctx.Err() != nil {
			return Account{}, ctx.Err()
		}
		var apiErr *cloudflare.APIError
		if isTokenRejection(err) && errors.As(err, &apiErr) {
			return Account{}, &Error{
				Code:    ErrCodeInvalidToken,
				Message: fmt.Sprintf("Cloudflare rejected the API token (HTTP %d, code %d)", apiErr.Status, apiErr.Code),
			}
		}
		return Account{}, &Error{
			Code:    ErrCodeAccountLookupFailed,
			Message: "could not reach Cloudflare to read the account; try again",
		}
	}
	if result.ID == "" {
		result.ID = accountID
	}
	return Account{ID: result.ID, Name: result.Name}, nil
}

func isTokenRejection(err error) bool {
	var apiErr *cloudflare.APIError
	if !errors.As(err, &apiErr) || apiErr.Message == "non-JSON response" {
		return false
	}
	return apiErr.Status == 401 || apiErr.Status == 403 || (apiErr.Status == 400 && apiErr.Code != 0)
}

type credentialSnapshot struct {
	value  string
	exists bool
}

func (s *TokenService) previousCredentials(ctx context.Context) (map[string]credentialSnapshot, error) {
	previous := make(map[string]credentialSnapshot, 2)
	for _, key := range []string{KeyAccountID, KeyAPIToken} {
		value, err := s.store.Get(ctx, key)
		switch {
		case err == nil:
			previous[key] = credentialSnapshot{value: value, exists: true}
		case errors.Is(err, platform.ErrCredentialNotFound):
			previous[key] = credentialSnapshot{}
		default:
			return nil, err
		}
	}
	return previous, nil
}

func (s *TokenService) rollbackCredentials(ctx context.Context, previous map[string]credentialSnapshot) error {
	ctx = context.WithoutCancel(ctx)
	var failures []error
	for _, key := range []string{KeyAccountID, KeyAPIToken} {
		snapshot := previous[key]
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
		return &Error{Code: ErrCodeNotConnected, Message: "no Cloudflare API token is connected"}
	default:
		return &Error{
			Code:    ErrCodeCredentialStoreFailure,
			Message: "cannot access the system credential store",
			Err:     err,
		}
	}
}

func redactToken(message, token string) string {
	if token == "" {
		return message
	}
	values := []string{token}
	for _, prefix := range []string{"cfut_", "cfat_"} {
		if strings.HasPrefix(token, prefix) {
			values = append(values, strings.TrimPrefix(token, prefix))
		}
	}
	for _, value := range values {
		if value != "" {
			message = strings.ReplaceAll(message, value, "[REDACTED]")
		}
	}
	return message
}
