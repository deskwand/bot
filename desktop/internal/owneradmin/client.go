// Package owneradmin calls the Worker's /admin/owner/* routes. It reuses the
// backup flow's ADMIN_TOKEN, like lifeadmin.
//
// A deployment that predates owner claiming answers 404 here; that surfaces as
// CodeUnsupported so the page can say "upgrade the cloud side".
package owneradmin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Error codes returned in domain.Error.Code by this package.
const (
	CodeUnsupported   = "OWNER_UNSUPPORTED"
	CodeRequestFailed = "OWNER_FAILED"
)

const (
	statusPath      = "/admin/owner/status"
	openPath        = "/admin/owner/open"
	revokePath      = "/admin/owner/revoke"
	defaultTimeout  = 20 * time.Second
	maxResponseSize = 1 << 20
)

// Status is one owner-claim snapshot from the Worker.
type Status struct {
	Mode           string `json:"mode"`
	OwnerUserID    string `json:"ownerUserId"`
	WindowOpenedAt int64  `json:"windowOpenedAt"`
	WindowClosesAt int64  `json:"windowClosesAt"`
}

// Client is bound to one deployment base URL and admin token.
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

// Status reads the current claim state.
func (c *Client) Status(ctx context.Context) (Status, error) {
	return c.call(ctx, http.MethodGet, statusPath)
}

// Open reopens the claim window so a new person can claim the bot.
func (c *Client) Open(ctx context.Context) (Status, error) {
	return c.call(ctx, http.MethodPost, openPath)
}

// Revoke clears the claim and closes the window.
func (c *Client) Revoke(ctx context.Context) (Status, error) {
	return c.call(ctx, http.MethodPost, revokePath)
}

func (c *Client) call(ctx context.Context, method, path string) (Status, error) {
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, method, c.baseURL+path, nil)
	if err != nil {
		return Status{}, fmt.Errorf("owneradmin: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Status{}, ctxErr
		}
		return Status{}, c.unreachable()
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize))
	if err != nil {
		return Status{}, fmt.Errorf("owneradmin: read response: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return Status{}, domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("owneradmin.unauthorized")}
	}
	if response.StatusCode == http.StatusNotFound {
		return Status{}, c.unsupported()
	}
	if response.StatusCode == http.StatusOK {
		var status Status
		if err := json.Unmarshal(raw, &status); err != nil {
			return Status{}, domain.Error{Code: CodeRequestFailed, Message: c.t("owneradmin.invalidResponse")}
		}
		return status, nil
	}

	var failure struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &failure)
	code := failure.Code
	if code == "" {
		code = CodeRequestFailed
	}
	failureMessage := failure.Message
	if failureMessage == "" {
		failureMessage = fmt.Sprintf("admin request returned HTTP %d", response.StatusCode)
	}
	return Status{}, domain.Error{Code: code, Message: c.redact(failureMessage)}
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
		return "zh"
	}
	return c.Locale()
}

func (c *Client) t(key string) string { return i18n.T(c.lang(), key) }

func (c *Client) unreachable() error {
	return domain.Error{Code: CodeRequestFailed, Message: c.t("owneradmin.unreachable")}
}

func (c *Client) unsupported() error {
	return domain.Error{Code: CodeUnsupported, Message: c.t("owneradmin.unsupported")}
}
