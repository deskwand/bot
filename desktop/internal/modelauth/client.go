// Package modelauth calls the Worker's authenticated /admin/models/auth routes:
// the device-code login used by subscription providers (today openai-codex).
package modelauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Error codes returned in domain.Error.Code by this package.
const (
	CodeAdminUnavailable = "MODEL_AUTH_ADMIN_UNAVAILABLE"
	CodeRequestFailed    = "MODEL_AUTH_FAILED"
)

const (
	authPath        = "/admin/models/auth"
	defaultTimeout  = 20 * time.Second
	maxResponseSize = 1 << 20
)

// Provider is one subscription provider's login state.
type Provider struct {
	ID        string `json:"id"`
	Connected bool   `json:"connected"`
}

// Login is a started device-code login. DeviceAuthID is a one-time handle for
// the poll; it never reaches the UI or a log.
type Login struct {
	DeviceAuthID    string `json:"deviceAuthId"`
	UserCode        string `json:"userCode"`
	VerificationURL string `json:"verificationUrl"`
	IntervalSeconds int    `json:"intervalSeconds"`
}

// PollResult is one poll: pending, slow_down or done.
type PollResult struct {
	Status string `json:"status"`
}

// BrowserStart is one started browser (authorization code + PKCE) login. The
// verifier and state go back with the code; only the deployment exchanges it.
type BrowserStart struct {
	AuthorizeURL string `json:"authorizeUrl"`
	State        string `json:"state"`
	CodeVerifier string `json:"codeVerifier"`
}

type Client struct {
	baseURL string
	token   string
	http    *http.Client
	Locale  func() string
}

func NewClient(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    httpClient,
	}
}

// Status lists the subscription providers and whether they are signed in.
func (c *Client) Status(ctx context.Context) ([]Provider, error) {
	var body struct {
		Providers []Provider `json:"providers"`
	}
	if err := c.call(ctx, http.MethodGet, authPath, nil, &body); err != nil {
		return nil, err
	}
	return body.Providers, nil
}

// Start asks the deployment for a device code.
func (c *Client) Start(ctx context.Context, provider string) (Login, error) {
	var login Login
	path := authPath + "/" + url.PathEscape(provider) + "/start"
	if err := c.call(ctx, http.MethodPost, path, nil, &login); err != nil {
		return Login{}, err
	}
	return login, nil
}

// StartBrowser asks the deployment for an authorize URL and its PKCE pair.
func (c *Client) StartBrowser(ctx context.Context, provider string) (BrowserStart, error) {
	var started BrowserStart
	path := authPath + "/" + url.PathEscape(provider) + "/browser/start"
	if err := c.call(ctx, http.MethodPost, path, nil, &started); err != nil {
		return BrowserStart{}, err
	}
	return started, nil
}

// CompleteBrowser hands the loopback code back so the deployment can exchange
// it and store the credential.
func (c *Client) CompleteBrowser(ctx context.Context, provider, code, codeVerifier, state string) error {
	body := map[string]string{
		"code":         code,
		"codeVerifier": codeVerifier,
		"state":        state,
	}
	path := authPath + "/" + url.PathEscape(provider) + "/browser/complete"
	return c.call(ctx, http.MethodPost, path, body, nil)
}

// Poll reports the login state for a started device code.
func (c *Client) Poll(ctx context.Context, provider, deviceAuthID, userCode string) (PollResult, error) {
	var result PollResult
	body := map[string]string{"deviceAuthId": deviceAuthID, "userCode": userCode}
	path := authPath + "/" + url.PathEscape(provider) + "/poll"
	if err := c.call(ctx, http.MethodPost, path, body, &result); err != nil {
		return PollResult{}, err
	}
	return result, nil
}

// Disconnect removes the stored credential.
func (c *Client) Disconnect(ctx context.Context, provider string) error {
	return c.call(ctx, http.MethodDelete, authPath+"/"+url.PathEscape(provider), nil, nil)
}

func (c *Client) call(ctx context.Context, method, path string, body, out any) error {
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("modelauth: encode request: %w", err)
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(requestCtx, method, c.baseURL+path, payload)
	if err != nil {
		return fmt.Errorf("modelauth: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return domain.Error{Code: CodeRequestFailed, Message: c.t("modelauth.unreachable")}
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize))
	if err != nil {
		return fmt.Errorf("modelauth: read response: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("modelauth.unauthorized")}
	}
	if response.StatusCode == http.StatusNotFound {
		// Either the deployment predates these routes or it does not know the
		// provider; keep the two apart so only the first suggests an update.
		var failure struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Code == "MODEL_AUTH_UNKNOWN_PROVIDER" {
			return domain.Error{Code: failure.Code, Message: c.t("modelauth.unknownProvider")}
		}
		return domain.Error{Code: CodeAdminUnavailable, Message: c.t("modelauth.unavailable")}
	}
	if response.StatusCode >= 400 {
		var failure struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &failure)
		code := failure.Code
		if code == "" {
			code = CodeRequestFailed
		}
		message := failure.Message
		if message == "" {
			message = fmt.Sprintf("admin request returned HTTP %d", response.StatusCode)
		}
		return domain.Error{Code: code, Message: c.redact(message)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return domain.Error{Code: CodeRequestFailed, Message: c.t("modelauth.invalidResponse")}
	}
	return nil
}

// redact keeps the admin token out of an error surfaced to the user or a log.
func (c *Client) redact(text string) string {
	if c.token == "" || !strings.Contains(text, c.token) {
		return text
	}
	return strings.ReplaceAll(text, c.token, "<redacted>")
}

func (c *Client) lang() string {
	if c.Locale == nil {
		return i18n.ZH
	}
	return c.Locale()
}

func (c *Client) t(key string) string { return i18n.T(c.lang(), key) }
