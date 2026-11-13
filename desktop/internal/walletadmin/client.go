// Package walletadmin calls the Worker's authenticated /admin/wallet/status
// route. It reuses the backup flow's ADMIN_TOKEN, like exchangeadmin.
package walletadmin

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
	CodeAdminUnavailable = "WALLET_ADMIN_UNAVAILABLE"
	CodeRequestFailed    = "WALLET_FAILED"
)

const (
	walletStatusPath = "/admin/wallet/status"
	defaultTimeout   = 20 * time.Second
	maxResponseSize  = 1 << 20
)

// Status is the deployed wallet's public state. ValueUSD is nil when the
// address is known but the valuation could not be read.
type Status struct {
	Configured bool     `json:"configured"`
	Address    string   `json:"address,omitempty"`
	ValueUSD   *float64 `json:"valueUsd,omitempty"`
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

// Status asks the deployed Worker for the wallet's public state.
func (c *Client) Status(ctx context.Context) (Status, error) {
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, c.baseURL+walletStatusPath, nil)
	if err != nil {
		return Status{}, fmt.Errorf("walletadmin: build request: %w", err)
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
		return Status{}, fmt.Errorf("walletadmin: read status response: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return Status{}, domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("walletadmin.unauthorized")}
	}
	if response.StatusCode == http.StatusNotFound {
		return Status{}, c.unavailable()
	}

	var status Status
	if err := json.Unmarshal(raw, &status); err != nil {
		return Status{}, domain.Error{Code: CodeRequestFailed, Message: c.t("walletadmin.invalidResponse")}
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Code == "" && failure.Message == "" {
			return Status{}, domain.Error{Code: CodeRequestFailed, Message: c.redact(fmt.Sprintf("admin request returned HTTP %d", response.StatusCode))}
		}
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
	return status, nil
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
	return domain.Error{Code: CodeRequestFailed, Message: c.t("walletadmin.unreachable")}
}

func (c *Client) unavailable() error {
	return domain.Error{Code: CodeAdminUnavailable, Message: c.t("walletadmin.unavailable")}
}
