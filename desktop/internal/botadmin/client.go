// Package botadmin calls the Worker's read-only /admin/bots routes. It reuses
// the backup flow's ADMIN_TOKEN, like walletadmin and lifeadmin.
package botadmin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Error codes returned in domain.Error.Code by this package.
const (
	CodeUnsupported   = "BOTS_UNSUPPORTED"
	CodeNotFound      = "BOTS_NOT_FOUND"
	CodeRequestFailed = "BOTS_READ_FAILED"
)

const (
	listPath        = "/admin/bots"
	detailPrefix    = "/admin/bots/"
	defaultTimeout  = 20 * time.Second
	maxResponseSize = 1 << 20
)

// BotMeta is the bot's own state. Absent optional fields stay nil so the UI can
// tell "not set" from a zero value.
type BotMeta struct {
	BotID               string   `json:"botId"`
	Name                string   `json:"name"`
	Mission             string   `json:"mission"`
	Status              string   `json:"status"`
	NextWakeAt          *int64   `json:"nextWakeAt"`
	DefaultIntervalMs   int64    `json:"defaultIntervalMs"`
	CurrentTaskID       *string  `json:"currentTaskId"`
	ConsecutiveFailures int      `json:"consecutiveFailures"`
	WakesDay            *string  `json:"wakesDay"`
	WakesCount          int      `json:"wakesCount"`
	PendingSteer        []string `json:"pendingSteer"`
	Earner              bool     `json:"earner"`
	ManualWakeAt        *int64   `json:"manualWakeAt"`
	FinishReason        *string  `json:"finishReason"`
}

// BotRun is one entry of the bot's own run log.
type BotRun struct {
	TaskID    string  `json:"taskId"`
	StartedAt int64   `json:"startedAt"`
	EndedAt   *int64  `json:"endedAt"`
	Outcome   *string `json:"outcome"`
	Summary   *string `json:"summary"`
	Note      *string `json:"note"`
}

// BotDoc is one read-only document the bot keeps.
type BotDoc struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// Bot is one row of the list: the index row plus the bot's own state.
type Bot struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	CreatedAt   int64    `json:"createdAt"`
	Meta        *BotMeta `json:"meta"`
	LastRun     *BotRun  `json:"lastRun"`
	Unavailable bool     `json:"unavailable"`
}

// Detail is one bot's full read-only state.
type Detail struct {
	Meta *BotMeta `json:"meta"`
	Docs []BotDoc `json:"docs"`
	Runs []BotRun `json:"runs"`
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

// List reads every bot the deployment's butler keeps.
func (c *Client) List(ctx context.Context) ([]Bot, error) {
	raw, status, err := c.get(ctx, listPath)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		return nil, domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("botsadmin.unauthorized")}
	}
	if status == http.StatusNotFound {
		return nil, c.unsupported()
	}
	if status != http.StatusOK {
		return nil, c.failed(raw, status)
	}
	var payload struct {
		Bots []Bot `json:"bots"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, domain.Error{Code: CodeRequestFailed, Message: c.t("botsadmin.invalidResponse")}
	}
	if payload.Bots == nil {
		payload.Bots = []Bot{}
	}
	return payload.Bots, nil
}

// Detail reads one bot's state, documents and recent runs.
func (c *Client) Detail(ctx context.Context, id string) (Detail, error) {
	raw, status, err := c.get(ctx, detailPrefix+id)
	if err != nil {
		return Detail{}, err
	}
	if status == http.StatusUnauthorized {
		return Detail{}, domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("botsadmin.unauthorized")}
	}
	if status == http.StatusNotFound {
		// A 404 with a code means this bot has no record; without one the route
		// itself is missing, which is a version problem, not a data problem.
		if failureCode(raw) == CodeNotFound {
			return Detail{}, domain.Error{Code: CodeNotFound, Message: c.t("botsadmin.notFound")}
		}
		return Detail{}, c.unsupported()
	}
	if status != http.StatusOK {
		return Detail{}, c.failed(raw, status)
	}
	var detail Detail
	if err := json.Unmarshal(raw, &detail); err != nil {
		return Detail{}, domain.Error{Code: CodeRequestFailed, Message: c.t("botsadmin.invalidResponse")}
	}
	if detail.Docs == nil {
		detail.Docs = []BotDoc{}
	}
	if detail.Runs == nil {
		detail.Runs = []BotRun{}
	}
	return detail, nil
}

func (c *Client) get(ctx context.Context, path string) ([]byte, int, error) {
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("botadmin: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, 0, ctxErr
		}
		return nil, 0, domain.Error{Code: CodeRequestFailed, Message: c.t("botsadmin.unreachable")}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize))
	if err != nil {
		return nil, 0, fmt.Errorf("botadmin: read response: %w", err)
	}
	return raw, response.StatusCode, nil
}

func (c *Client) failed(raw []byte, status int) error {
	code := failureCode(raw)
	if code == "" {
		code = CodeRequestFailed
	}
	// The body is never echoed: it comes from the deployment and the fixed
	// sentence already names what happened.
	return domain.Error{
		Code:    code,
		Message: c.t("botsadmin.requestFailed") + " (HTTP " + strconv.Itoa(status) + ")",
	}
}

func failureCode(raw []byte) string {
	var failure struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &failure)
	return failure.Code
}

func (c *Client) lang() string {
	if c.Locale == nil {
		return i18n.ZH
	}
	return c.Locale()
}

func (c *Client) t(key string) string { return i18n.T(c.lang(), key) }

func (c *Client) unsupported() error {
	return domain.Error{Code: CodeUnsupported, Message: c.t("botsadmin.unsupported")}
}
