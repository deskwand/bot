// Package lifeadmin calls the Worker's authenticated /admin/life/vitals
// route. It reuses the backup flow's ADMIN_TOKEN, like walletadmin.
package lifeadmin

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
	CodeUnsupported   = "LIFE_VITALS_UNSUPPORTED"
	CodeRequestFailed = "LIFE_VITALS_FAILED"
)

const (
	vitalsPath      = "/admin/life/vitals"
	defaultTimeout  = 20 * time.Second
	maxResponseSize = 1 << 20
)

// Source is one entry in the spend ranking.
type Source struct {
	Source string  `json:"source"`
	USD    float64 `json:"usd"`
}

// Vitals is the deployed life ledger's read-only state. RunwayDays is nil
// when the average daily spend is zero.
type Vitals struct {
	BalanceUSD        float64  `json:"balanceUsd"`
	DailySpendUSD     float64  `json:"dailySpendUsd"`
	RunwayDays        *float64 `json:"runwayDays"`
	Tier              string   `json:"tier"`
	MetabolismStarted bool     `json:"metabolismStarted"`
	Unpriced          bool     `json:"unpriced"`
	TopSources        []Source `json:"topSources"`
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

// Vitals asks the deployed Worker for the life ledger's vitals.
func (c *Client) Vitals(ctx context.Context) (Vitals, error) {
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, c.baseURL+vitalsPath, nil)
	if err != nil {
		return Vitals{}, fmt.Errorf("lifeadmin: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Vitals{}, ctxErr
		}
		return Vitals{}, c.unreachable()
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize))
	if err != nil {
		return Vitals{}, fmt.Errorf("lifeadmin: read vitals response: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return Vitals{}, domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("lifeadmin.unauthorized")}
	}
	if response.StatusCode == http.StatusNotFound {
		return Vitals{}, c.unsupported()
	}
	if response.StatusCode == http.StatusOK {
		var vitals Vitals
		if err := json.Unmarshal(raw, &vitals); err != nil {
			return Vitals{}, domain.Error{Code: CodeRequestFailed, Message: c.t("lifeadmin.invalidResponse")}
		}
		return vitals, nil
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
	return Vitals{}, domain.Error{Code: code, Message: c.redact(failureMessage)}
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
	return domain.Error{Code: CodeRequestFailed, Message: c.t("lifeadmin.unreachable")}
}

func (c *Client) unsupported() error {
	return domain.Error{Code: CodeUnsupported, Message: c.t("lifeadmin.unsupported")}
}
