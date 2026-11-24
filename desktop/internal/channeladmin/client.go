// Package channeladmin calls the Worker's /admin/channels routes. Authority is
// the deployment's ADMIN_TOKEN, the same one the backup flow uses.
package channeladmin

import (
	"bytes"
	"context"
	"encoding/json"
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
	CodeUnsupported   = "CHANNELS_UNSUPPORTED"
	CodeNotFound      = "CHANNELS_NOT_FOUND"
	CodeMaintenance   = "CHANNELS_MAINTENANCE"
	CodePinExhausted  = "CHANNELS_PIN_EXHAUSTED"
	CodeInvitePending = "CHANNELS_INVITE_PENDING"
	CodeInvalidLabel  = "CHANNELS_INVALID_LABEL"
	CodeImmutable     = "CHANNELS_IMMUTABLE"
	CodeRebindNeeded  = "CHANNELS_REBIND_REQUIRED"
	CodeRequestFailed = "CHANNELS_REQUEST_FAILED"
)

const (
	channelsPath = "/admin/channels"
	bindingsPath = "/admin/channels/bindings"
	requestTime  = 20 * time.Second
	maxResponse  = 1 << 20
)

// Channel is one channel row as the console shows it.
type Channel struct {
	ChannelID     string  `json:"channelId"`
	Label         string  `json:"label"`
	Account       *string `json:"account"`
	State         string  `json:"state"`
	LastErrorCode *string `json:"lastErrorCode"`
	Teen          bool    `json:"teen"`
}

// Invite is a created or pending binding.
type Invite struct {
	InviteID  string  `json:"inviteId"`
	Label     string  `json:"label,omitempty"`
	Kind      string  `json:"kind,omitempty"`
	MemberID  *string `json:"channelId,omitempty"`
	ExpiresAt int64   `json:"expiresAt"`
}

// InviteState is one binding's stage; capability strings stay in memory.
type InviteState struct {
	InviteID         string  `json:"inviteId"`
	Label            string  `json:"label"`
	Status           string  `json:"status"`
	Stage            string  `json:"stage"`
	ExpiresAt        int64   `json:"expiresAt"`
	RealnameDeadline *int64  `json:"realnameDeadline"`
	RealnameURL      *string `json:"realnameUrl"`
	QRContent        *string `json:"qrContent"`
	Failure          *string `json:"failure"`
}

// Client talks to one deployment's channel routes.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
	// Locale resolves the UI language for fixed sentences.
	Locale func() string
}

// NewClient builds a client for one deployment endpoint.
func NewClient(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTime}
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    httpClient,
	}
}

// Channels lists every channel, the first one included.
func (c *Client) Channels(ctx context.Context) ([]Channel, error) {
	raw, status, err := c.do(ctx, http.MethodGet, channelsPath, nil)
	if err != nil {
		return nil, err
	}
	if err := c.check(status, raw); err != nil {
		return nil, err
	}
	var payload struct {
		Channels []Channel `json:"channels"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, c.invalid()
	}
	if payload.Channels == nil {
		payload.Channels = []Channel{}
	}
	return payload.Channels, nil
}

// CreateInvite starts a binding for a new channel.
func (c *Client) CreateInvite(ctx context.Context, label string, teen bool) (Invite, error) {
	raw, status, err := c.do(ctx, http.MethodPost, channelsPath,
		map[string]any{"label": label, "teen": teen})
	if err != nil {
		return Invite{}, err
	}
	if err := c.check(status, raw); err != nil {
		return Invite{}, err
	}
	var invite Invite
	if err := json.Unmarshal(raw, &invite); err != nil {
		return Invite{}, c.invalid()
	}
	return invite, nil
}

// PendingBindings lists bindings a wizard can resume.
func (c *Client) PendingBindings(ctx context.Context) ([]Invite, error) {
	raw, status, err := c.do(ctx, http.MethodGet, bindingsPath, nil)
	if err != nil {
		return nil, err
	}
	if err := c.check(status, raw); err != nil {
		return nil, err
	}
	var payload struct {
		Bindings []Invite `json:"bindings"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, c.invalid()
	}
	if payload.Bindings == nil {
		payload.Bindings = []Invite{}
	}
	return payload.Bindings, nil
}

// InviteState reads one binding's stage.
func (c *Client) InviteState(ctx context.Context, id string) (InviteState, error) {
	raw, status, err := c.do(ctx, http.MethodGet, bindingsPath+"/"+id, nil)
	if err != nil {
		return InviteState{}, err
	}
	if err := c.check(status, raw); err != nil {
		return InviteState{}, err
	}
	return decodeState(raw, c.invalid())
}

// SubmitPin relays the PIN WeChat showed on the invitee's phone.
func (c *Client) SubmitPin(ctx context.Context, id, pin string) (InviteState, error) {
	raw, status, err := c.do(ctx, http.MethodPost, bindingsPath+"/"+id+"/pin", map[string]string{"pin": pin})
	if err != nil {
		return InviteState{}, err
	}
	if err := c.check(status, raw); err != nil {
		return InviteState{}, err
	}
	return decodeState(raw, c.invalid())
}

// CancelInvite abandons a pending binding.
func (c *Client) CancelInvite(ctx context.Context, id string) error {
	raw, status, err := c.do(ctx, http.MethodDelete, bindingsPath+"/"+id, nil)
	if err != nil {
		return err
	}
	return c.check(status, raw)
}

// SetTeen flips one channel's minor-mode flag.
func (c *Client) SetTeen(ctx context.Context, channelID string, teen bool) error {
	raw, status, err := c.do(ctx, http.MethodPost, channelsPath+"/"+channelID+"/teen",
		map[string]bool{"teen": teen})
	if err != nil {
		return err
	}
	return c.check(status, raw)
}

// Rebind starts a replacement binding for one existing channel (same account).
func (c *Client) Rebind(ctx context.Context, channelID string) (Invite, error) {
	raw, status, err := c.do(ctx, http.MethodPost, channelsPath+"/"+channelID+"/rebind", nil)
	if err != nil {
		return Invite{}, err
	}
	if err := c.check(status, raw); err != nil {
		return Invite{}, err
	}
	var invite Invite
	if err := json.Unmarshal(raw, &invite); err != nil {
		return Invite{}, c.invalid()
	}
	return invite, nil
}

// Restart re-arms one channel's chains. An expired session is refused.
func (c *Client) Restart(ctx context.Context, channelID string) error {
	raw, status, err := c.do(ctx, http.MethodPost, channelsPath+"/"+channelID+"/restart", nil)
	if err != nil {
		return err
	}
	return c.check(status, raw)
}

// Remove deletes one channel and frees its WeChat account.
func (c *Client) Remove(ctx context.Context, channelID string) error {
	raw, status, err := c.do(ctx, http.MethodDelete, channelsPath+"/"+channelID, nil)
	if err != nil {
		return err
	}
	return c.check(status, raw)
}

func decodeState(raw []byte, invalid error) (InviteState, error) {
	var state InviteState
	if err := json.Unmarshal(raw, &state); err != nil {
		return InviteState{}, invalid
	}
	return state, nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTime)
	defer cancel()
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, 0, c.invalid()
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(requestCtx, method, c.baseURL+path, payload)
	if err != nil {
		return nil, 0, domain.Error{Code: CodeRequestFailed, Message: c.t("memberadmin.unreachable")}
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, 0, ctxErr
		}
		return nil, 0, domain.Error{Code: CodeRequestFailed, Message: c.t("memberadmin.unreachable")}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponse))
	if err != nil {
		return nil, 0, domain.Error{Code: CodeRequestFailed, Message: c.t("memberadmin.unreachable")}
	}
	return raw, response.StatusCode, nil
}

// check turns one response status into a fixed error. A 404 without a code is a
// missing route (older deployment), not missing data.
func (c *Client) check(status int, raw []byte) error {
	switch status {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent:
		return nil
	case http.StatusUnauthorized:
		return domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("memberadmin.unauthorized")}
	case http.StatusNotFound:
		if failureCode(raw) == "" {
			return domain.Error{Code: CodeUnsupported, Message: c.t("memberadmin.unsupported")}
		}
		return domain.Error{Code: CodeNotFound, Message: c.t("memberadmin.notFound")}
	}
	switch failureCode(raw) {
	case "MAINTENANCE_ACTIVE":
		return domain.Error{Code: CodeMaintenance, Message: c.t("memberadmin.maintenance")}
	case "INVITE_PENDING":
		return domain.Error{Code: CodeInvitePending, Message: c.t("memberadmin.invitePending")}
	case "PIN_ATTEMPTS_EXHAUSTED":
		return domain.Error{Code: CodePinExhausted, Message: c.t("memberadmin.pinExhausted")}
	case "INVALID_LABEL":
		return domain.Error{Code: CodeInvalidLabel, Message: c.t("memberadmin.invalidLabel")}
	case "CHANNEL_IMMUTABLE":
		return domain.Error{Code: CodeImmutable, Message: c.t("memberadmin.immutable")}
	case "REBIND_REQUIRED":
		return domain.Error{Code: CodeRebindNeeded, Message: c.t("memberadmin.rebindNeeded")}
	case "CHANNEL_NOT_FOUND", "INVITE_NOT_FOUND", "NOT_REBINDABLE", "INVITE_CLOSED":
		return domain.Error{Code: CodeNotFound, Message: c.t("memberadmin.notFound")}
	}
	return domain.Error{
		Code:    CodeRequestFailed,
		Message: c.t("memberadmin.requestFailed") + " (HTTP " + strconv.Itoa(status) + ")",
	}
}

func failureCode(raw []byte) string {
	var failure struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &failure)
	return failure.Code
}

func (c *Client) invalid() error {
	return domain.Error{Code: CodeRequestFailed, Message: c.t("memberadmin.invalidResponse")}
}

func (c *Client) t(key string) string {
	if c.Locale == nil {
		return i18n.T(i18n.EN, key)
	}
	return i18n.T(c.Locale(), key)
}
