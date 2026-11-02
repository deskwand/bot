package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// OAuthEndpoints are the Cloudflare OAuth endpoints. They are fields rather
// than constants so tests can point at an httptest server.
// https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
type OAuthEndpoints struct {
	Authorize string
	Token     string
	Revoke    string
}

// CloudflareOAuthEndpoints are the production endpoints.
var CloudflareOAuthEndpoints = OAuthEndpoints{
	Authorize: "https://dash.cloudflare.com/oauth2/auth",
	Token:     "https://dash.cloudflare.com/oauth2/token",
	Revoke:    "https://dash.cloudflare.com/oauth2/revoke",
}

// OAuthClientID is the public PKCE client registered as "DeskWand Bot". A
// public client has no secret, so it is safe to ship inside the app.
const OAuthClientID = "5239a8220739ef587c828904db53d449"

// RequiredScopes must match the scopes configured on the OAuth client. The IDs
// come from GET /client/v4/oauth/scopes; edit them here if Cloudflare renames
// a permission group.
var RequiredScopes = []string{
	"offline_access",
	"workers-scripts.edit",
	"workers-r2.write",
	"workers-observability.write",
	"workers-observability-telemetry.write",
	"account-settings.read",
}

// CallbackPorts are the loopback ports registered as redirect URIs. Cloudflare
// compares redirect URIs exactly, so this set is fixed.
var CallbackPorts = []int{8756, 8757, 8758}

const callbackPath = "/callback"

func base64URL(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

func randomURL(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64URL(buf), nil
}

func codeChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64URL(sum[:])
}

func authorizeURL(ep OAuthEndpoints, redirectURI, state, challenge string) string {
	query := url.Values{}
	query.Set("client_id", OAuthClientID)
	query.Set("redirect_uri", redirectURI)
	query.Set("response_type", "code")
	query.Set("state", state)
	query.Set("scope", strings.Join(RequiredScopes, " "))
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	return ep.Authorize + "?" + query.Encode()
}

// tokenSet is the part of the token response this app keeps.
type tokenSet struct {
	Access    string
	Refresh   string
	ExpiresIn int
}

// errInvalidGrant means the refresh token is gone: the user revoked the app,
// rotated it elsewhere, or it expired. The caller must ask for a new login.
var errInvalidGrant = errors.New("auth: refresh token is no longer valid")

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	TokenType        string `json:"token_type"`
	ExpiresIn        int    `json:"expires_in"`
	Scope            string `json:"scope"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

const (
	oauthTimeout     = 30 * time.Second
	maxOAuthResponse = 64 << 10
	// defaultExpiresIn is used when Cloudflare omits expires_in.
	defaultExpiresIn = 3600
)

func postTokenForm(ctx context.Context, client *http.Client, endpoint string, form url.Values) (tokenResponse, int, error) {
	ctx, cancel := context.WithTimeout(ctx, oauthTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return tokenResponse{}, 0, err
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")
	request.Header.Set("accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return tokenResponse{}, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxOAuthResponse))
	if err != nil {
		return tokenResponse{}, response.StatusCode, err
	}
	var parsed tokenResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return tokenResponse{}, response.StatusCode, fmt.Errorf("auth: decode token response: %w", err)
	}
	return parsed, response.StatusCode, nil
}

func tokenSetFrom(parsed tokenResponse) (tokenSet, error) {
	if parsed.AccessToken == "" {
		return tokenSet{}, errors.New("auth: token response has no access token")
	}
	expiresIn := parsed.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = defaultExpiresIn
	}
	return tokenSet{Access: parsed.AccessToken, Refresh: parsed.RefreshToken, ExpiresIn: expiresIn}, nil
}

func exchangeCode(ctx context.Context, client *http.Client, ep OAuthEndpoints, code, verifier, redirectURI string) (tokenSet, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", OAuthClientID)
	form.Set("code", code)
	form.Set("code_verifier", verifier)
	form.Set("redirect_uri", redirectURI)
	parsed, status, err := postTokenForm(ctx, client, ep.Token, form)
	if err != nil {
		return tokenSet{}, &Error{Code: ErrCodeOAuthExchangeFailed, Message: "could not reach Cloudflare to exchange the authorization code; try again", Err: err}
	}
	if status < 200 || status > 299 || parsed.AccessToken == "" {
		return tokenSet{}, &Error{
			Code:    ErrCodeOAuthExchangeFailed,
			Message: "Cloudflare refused the authorization code: " + describeTokenError(parsed),
		}
	}
	set, err := tokenSetFrom(parsed)
	if err != nil {
		return tokenSet{}, &Error{Code: ErrCodeOAuthExchangeFailed, Message: err.Error()}
	}
	if set.Refresh == "" {
		// Without a refresh token the session dies in an hour. The OAuth client
		// must enable the refresh_token grant and request offline_access.
		return tokenSet{}, &Error{
			Code:    ErrCodeOAuthExchangeFailed,
			Message: "Cloudflare returned no refresh token; the OAuth client is missing the refresh_token grant or offline_access scope",
		}
	}
	return set, nil
}

func refreshAccess(ctx context.Context, client *http.Client, ep OAuthEndpoints, refresh string) (tokenSet, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", OAuthClientID)
	form.Set("refresh_token", refresh)
	parsed, status, err := postTokenForm(ctx, client, ep.Token, form)
	if err != nil {
		return tokenSet{}, &Error{Code: ErrCodeVerifyFailed, Message: "could not reach Cloudflare to refresh the session; try again", Err: err}
	}
	if parsed.Error == "invalid_grant" || parsed.Error == "invalid_request" {
		return tokenSet{}, errInvalidGrant
	}
	if (status == 400 || status == 401 || status == 403) && parsed.AccessToken == "" {
		// A dead authorization answers with a bare status and no error body.
		return tokenSet{}, errInvalidGrant
	}
	if status < 200 || status > 299 || parsed.AccessToken == "" {
		return tokenSet{}, &Error{Code: ErrCodeVerifyFailed, Message: "Cloudflare refused to refresh the session: " + describeTokenError(parsed)}
	}
	set, err := tokenSetFrom(parsed)
	if err != nil {
		return tokenSet{}, &Error{Code: ErrCodeVerifyFailed, Message: err.Error()}
	}
	if set.Refresh == "" {
		return tokenSet{}, &Error{Code: ErrCodeVerifyFailed, Message: "Cloudflare returned no refresh token; a rotation was lost"}
	}
	return set, nil
}

func revokeAccess(ctx context.Context, client *http.Client, ep OAuthEndpoints, token string) error {
	form := url.Values{}
	form.Set("token", token)
	form.Set("client_id", OAuthClientID)
	parsed, status, err := postTokenForm(ctx, client, ep.Revoke, form)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("auth: revoke returned HTTP %d %s", status, parsed.Error)
	}
	return nil
}

// describeTokenError renders Cloudflare's OAuth error fields for display. The
// fields never contain tokens.
func describeTokenError(parsed tokenResponse) string {
	switch {
	case parsed.Error != "" && parsed.ErrorDescription != "":
		return parsed.Error + " (" + parsed.ErrorDescription + ")"
	case parsed.Error != "":
		return parsed.Error
	default:
		return "unexpected response"
	}
}

// LoginResult is what a completed browser authorization yielded.
type LoginResult struct {
	Accounts []Account
}

// LoginSession is one in-flight authorization. The caller owns Cancel and
// decides which account to persist.
type LoginSession interface {
	AuthURL() string
	Wait(ctx context.Context) (LoginResult, error)
	Complete(ctx context.Context, accountID string) error
	Cancel()
}

type loginSession struct {
	service     *TokenService
	listener    net.Listener
	redirectURI string
	verifier    string
	state       string
	authURL     string

	once     sync.Once
	cancel   context.CancelFunc
	finished chan struct{}
	result   LoginResult
	err      error
	tokens   tokenSet
}

// BeginLogin opens a loopback listener and returns a session whose AuthURL the
// caller opens in a browser. Nothing is stored until Complete succeeds.
func (s *TokenService) BeginLogin(ctx context.Context) (LoginSession, error) {
	verifier, err := randomURL(48)
	if err != nil {
		return nil, &Error{Code: ErrCodeOAuthExchangeFailed, Message: "cannot generate PKCE material", Err: err}
	}
	state, err := randomURL(16)
	if err != nil {
		return nil, &Error{Code: ErrCodeOAuthExchangeFailed, Message: "cannot generate the login state", Err: err}
	}
	ln, port, err := listenLoopback(CallbackPorts, s.listen)
	if err != nil {
		return nil, err
	}
	redirectURI := "http://127.0.0.1:" + strconv.Itoa(port) + callbackPath
	sessionCtx, cancel := context.WithCancel(ctx)
	session := &loginSession{
		service:     s,
		listener:    ln,
		redirectURI: redirectURI,
		verifier:    verifier,
		state:       state,
		authURL:     authorizeURL(s.endpoints, redirectURI, state, codeChallenge(verifier)),
		cancel:      cancel,
		finished:    make(chan struct{}),
	}
	go session.run(sessionCtx)
	return session, nil
}

func (l *loginSession) AuthURL() string { return l.authURL }

func (l *loginSession) run(ctx context.Context) {
	defer close(l.finished)
	defer func() { _ = l.listener.Close() }()

	outcome, err := awaitCallback(ctx, l.listener)
	if err != nil {
		switch {
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			l.err = &Error{Code: ErrCodeOAuthTimeout, Message: "the browser did not finish authorizing in time", Err: err}
		default:
			l.err = &Error{Code: ErrCodeOAuthExchangeFailed, Message: "the authorization callback failed", Err: err}
		}
		return
	}
	if outcome.Error != "" {
		l.err = &Error{Code: ErrCodeOAuthDenied, Message: "authorization was not granted: " + outcome.Error + " " + outcome.ErrorDescription}
		return
	}
	if subtle.ConstantTimeCompare([]byte(outcome.State), []byte(l.state)) != 1 {
		l.err = &Error{Code: ErrCodeOAuthStateMismatch, Message: "the authorization response did not match this login attempt"}
		return
	}
	if outcome.Code == "" {
		l.err = &Error{Code: ErrCodeOAuthExchangeFailed, Message: "the authorization response carried no code"}
		return
	}

	set, err := exchangeCode(ctx, l.service.http, l.service.endpoints, outcome.Code, l.verifier, l.redirectURI)
	if err != nil {
		l.err = err
		return
	}
	accounts, err := l.service.listAccounts(ctx, set.Access)
	if err != nil {
		l.err = err
		return
	}
	if len(accounts) == 0 {
		l.err = &Error{Code: ErrCodeNoAccount, Message: "this Cloudflare user has no account to deploy into"}
		return
	}
	l.tokens = set
	l.result = LoginResult{Accounts: accounts}
}

func (l *loginSession) Wait(ctx context.Context) (LoginResult, error) {
	select {
	case <-l.finished:
		return l.result, l.err
	case <-ctx.Done():
		l.Cancel()
		<-l.finished
		if l.err == nil {
			return LoginResult{}, &Error{Code: ErrCodeOAuthTimeout, Message: "the browser did not finish authorizing in time", Err: ctx.Err()}
		}
		return LoginResult{}, l.err
	}
}

func (l *loginSession) Cancel() {
	l.once.Do(func() {
		_ = l.listener.Close()
		l.cancel()
	})
}

func (l *loginSession) Complete(ctx context.Context, accountID string) error {
	if l.tokens.Refresh == "" || len(l.result.Accounts) == 0 {
		return &Error{Code: ErrCodeNotConnected, Message: "this login has not finished authorizing"}
	}
	var chosen *Account
	for i := range l.result.Accounts {
		if l.result.Accounts[i].ID == accountID {
			chosen = &l.result.Accounts[i]
		}
	}
	if chosen == nil {
		return &Error{Code: ErrCodeNoAccount, Message: "the selected account is not in this authorization"}
	}
	return l.service.storeLogin(ctx, l.tokens, *chosen)
}
