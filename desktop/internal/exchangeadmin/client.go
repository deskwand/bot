// Package exchangeadmin calls the Worker's authenticated /admin/exchange/probe
// route. It reuses the backup flow's ADMIN_TOKEN so the page works before the
// user ever opens the backup page.
package exchangeadmin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/exchangesync"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Error codes returned in domain.Error.Code by this package.
const (
	CodeAdminUnavailable = "EXCHANGE_ADMIN_UNAVAILABLE"
	CodeRequestFailed    = "EXCHANGE_FAILED"
)

const (
	probePath       = "/admin/exchange/probe"
	snapshotPath    = "/admin/exchange/snapshot"
	defaultTimeout  = 20 * time.Second
	maxResponseSize = 1 << 20
)

// Probe is one account's health check. A refusal (ok=false) is a result the
// page renders, not an error.
type Probe struct {
	OK         bool     `json:"ok"`
	Venue      string   `json:"venue,omitempty"`
	Currencies int      `json:"currencies,omitempty"`
	Total      *float64 `json:"total,omitempty"`
	Code       string   `json:"code,omitempty"`
	Message    string   `json:"message,omitempty"`
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

// Probe asks the deployed Worker to read one account.
func (c *Client) Probe(ctx context.Context, account string) (Probe, error) {
	return c.post(ctx, probePath, struct {
		Account string `json:"account"`
	}{Account: account})
}

// PushSnapshot hands the raw Binance bundle to the Worker, which replays it
// through the same adapter. The account id is the local mapping's id, not a
// key: the pushed bundle never carries credentials.
func (c *Client) PushSnapshot(ctx context.Context, account string, bundle exchangesync.Bundle) (Probe, error) {
	return c.post(ctx, snapshotPath, struct {
		Account   string                  `json:"account"`
		FetchedAt int64                   `json:"fetchedAt"`
		Responses []exchangesync.Response `json:"responses"`
	}{
		Account:   account,
		FetchedAt: bundle.FetchedAt,
		Responses: bundle.Responses,
	})
}

// post sends one authenticated exchange request. 200 means the Worker did
// what was asked and 400 means the venue (or the push) was refused; both are
// results the page renders. Anything else is a gateway problem.
func (c *Client) post(ctx context.Context, path string, payload any) (Probe, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Probe{}, fmt.Errorf("exchangeadmin: encode request: %w", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, c.baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return Probe{}, fmt.Errorf("exchangeadmin: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Probe{}, ctxErr
		}
		return Probe{}, c.unreachable()
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize))
	if err != nil {
		return Probe{}, fmt.Errorf("exchangeadmin: read response: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return Probe{}, domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("exchangeadmin.unauthorized")}
	}
	if response.StatusCode == http.StatusNotFound {
		return Probe{}, c.unavailable()
	}

	var probe Probe
	if err := json.Unmarshal(raw, &probe); err != nil {
		return Probe{}, domain.Error{Code: CodeRequestFailed, Message: c.t("exchangeadmin.invalidResponse")}
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusBadRequest {
		code := probe.Code
		if code == "" {
			code = CodeRequestFailed
		}
		message := probe.Message
		if message == "" {
			message = fmt.Sprintf("admin request returned HTTP %d", response.StatusCode)
		}
		return Probe{}, domain.Error{Code: code, Message: c.redact(message)}
	}
	return probe, nil
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
	return domain.Error{Code: CodeRequestFailed, Message: c.t("exchangeadmin.unreachable")}
}

func (c *Client) unavailable() error {
	return domain.Error{Code: CodeAdminUnavailable, Message: c.t("exchangeadmin.unavailable")}
}
