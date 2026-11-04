// Package mcpadmin calls the Worker's authenticated /admin/mcp/* routes. It
// shares the ADMIN_TOKEN handling with the backup flow: the token is created
// and published on first use, so the services page works before the user ever
// opens the backup page.
package mcpadmin

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

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// Error codes returned in domain.Error.Code by this package.
const (
	CodeAdminUnavailable = "MCP_ADMIN_UNAVAILABLE"
	CodeRequestFailed    = "MCP_FAILED"
)

// UnavailableMessage is the user-facing explanation for a deployment that
// cannot serve the admin routes.
const UnavailableMessage = "无法连接云端管理接口，请检查 PUBLIC_BASE_URL 与部署状态"

// NetworkUnreachableMessage explains a request that never got an HTTP answer:
// a timeout or a refused connection points at the network, not the deployment.
const NetworkUnreachableMessage = "无法访问云端管理接口（网络超时或连接失败），请检查网络或代理设置"

const (
	probePath       = "/admin/mcp/probe"
	startPath       = "/admin/mcp/oauth/start"
	statusPath      = "/admin/mcp/status"
	revokePath      = "/admin/mcp/oauth/"
	defaultTimeout  = 20 * time.Second
	maxResponseSize = 1 << 20
)

// Tool is one tool reported by a probe.
type Tool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Mode        string `json:"mode"`
}

// Probe is the /admin/mcp/probe result. Auth is only set when the server
// needs an OAuth login instead of a connection attempt.
type Probe struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	Auth   string `json:"auth,omitempty"`
	Tools  []Tool `json:"tools,omitempty"`
}

// AuthStatus is one server's OAuth state.
type AuthStatus struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

// Deps are the services Connect needs. They mirror the backup flow's token
// dependencies so both surfaces use the same vault entry.
type Deps struct {
	Token        backup.TokenDeps
	HTTP         *http.Client
	ReadyTimeout time.Duration
}

// Client calls the MCP admin routes with one deployment's token.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewClient builds a client for baseURL. A nil httpClient gets the 20 second
// per-request default; an injected client keeps its own policy.
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

// Connect reads the deployment's PUBLIC_BASE_URL, ensures ADMIN_TOKEN exists,
// and waits for it to reach the Worker when this call published it for the
// first time.
func Connect(ctx context.Context, deps Deps, target domain.Target) (*Client, error) {
	snapshot, err := deps.Token.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return nil, err
	}
	baseURL := backup.PublicBaseURL(snapshot.SettingsJSON)
	if baseURL == "" {
		return nil, unavailable()
	}
	token, published, err := backup.EnsureAdminToken(ctx, deps.Token, target)
	if err != nil {
		return nil, err
	}
	client := NewClient(baseURL, token, deps.HTTP)
	if published {
		// Info is lease-checked, so a 409 already proves the route and token
		// are live. This reuses the backup flow's propagation window.
		wait := backup.NewAdminClient(baseURL, token, "", deps.HTTP)
		waitDeps := backup.Deps{HTTP: deps.HTTP, ReadyTimeout: deps.ReadyTimeout}
		if err := backup.WaitForAdmin(ctx, waitDeps, wait); err != nil {
			return nil, unavailable()
		}
	}
	return client, nil
}

// Probe connects to one server and returns its tools or failure reason.
func (c *Client) Probe(ctx context.Context, name string) (Probe, error) {
	var result Probe
	err := c.call(ctx, http.MethodPost, probePath, struct {
		Name string `json:"name"`
	}{Name: name}, &result)
	return result, err
}

// StartOAuth returns the provider's authorization URL.
func (c *Client) StartOAuth(ctx context.Context, name string) (string, error) {
	var result struct {
		URL string `json:"url"`
	}
	if err := c.call(ctx, http.MethodPost, startPath, struct {
		Name string `json:"name"`
	}{Name: name}, &result); err != nil {
		return "", err
	}
	return result.URL, nil
}

// Status lists every configured server's authorization state.
func (c *Client) Status(ctx context.Context) ([]AuthStatus, error) {
	var result struct {
		Servers []AuthStatus `json:"servers"`
	}
	if err := c.call(ctx, http.MethodGet, statusPath, nil, &result); err != nil {
		return nil, err
	}
	return result.Servers, nil
}

// Revoke removes one server's OAuth client and tokens.
func (c *Client) Revoke(ctx context.Context, name string) error {
	return c.call(ctx, http.MethodDelete, revokePath+url.PathEscape(name), nil, nil)
}

func (c *Client) call(ctx context.Context, method, path string, payload, out any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("mcpadmin: encode %s request: %w", path, err)
		}
		body = bytes.NewReader(encoded)
	}
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, method, c.baseURL+path, body)
	if err != nil {
		return fmt.Errorf("mcpadmin: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return unreachable()
	}
	return c.readResponse(response, path, out)
}

func (c *Client) readResponse(response *http.Response, path string, out any) error {
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize))
	if err != nil {
		return fmt.Errorf("mcpadmin: read %s response: %s", path, c.redact(err.Error()))
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusNotFound {
		return unavailable()
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return c.statusError(response.StatusCode, raw)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return domain.Error{Code: CodeRequestFailed, Message: "云端管理接口返回了无法解析的响应"}
	}
	return nil
}

func (c *Client) statusError(status int, raw []byte) error {
	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &payload)
	code := payload.Code
	if code == "" {
		code = CodeRequestFailed
	}
	message := payload.Message
	if message == "" {
		message = fmt.Sprintf("admin request returned HTTP %d", status)
	}
	return domain.Error{Code: code, Message: c.redact(message)}
}

// redact keeps the admin token out of an error surfaced to the user or a log.
func (c *Client) redact(text string) string {
	if c.token == "" || !strings.Contains(text, c.token) {
		return text
	}
	return strings.ReplaceAll(text, c.token, domain.RedactedValue)
}

func unreachable() error {
	return domain.Error{Code: CodeAdminUnavailable, Message: NetworkUnreachableMessage}
}

func unavailable() error {
	return domain.Error{Code: CodeAdminUnavailable, Message: UnavailableMessage}
}
