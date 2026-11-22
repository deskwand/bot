// Package memberadmin calls the Worker's /admin/members routes. It reuses the
// backup flow's ADMIN_TOKEN, like botadmin and owneradmin do.
package memberadmin

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
	CodeUnsupported   = "MEMBERS_UNSUPPORTED"
	CodeNotFound      = "MEMBERS_NOT_FOUND"
	CodeMaintenance   = "MEMBERS_MAINTENANCE"
	CodePinExhausted  = "MEMBERS_PIN_EXHAUSTED"
	CodeInvitePending = "MEMBERS_INVITE_PENDING"
	CodeWrongStage    = "MEMBERS_WRONG_STAGE"
	CodeInvalidLabel  = "MEMBERS_INVALID_LABEL"
	CodeRequestFailed = "MEMBERS_REQUEST_FAILED"
)

const (
	membersPath     = "/admin/members"
	invitesPath     = "/admin/members/invites"
	defaultTimeout  = 20 * time.Second
	maxResponseSize = 1 << 20
)

// User is one row of the directory as the console shows it.
type User struct {
	MemberID   string  `json:"memberId"`
	Label      string  `json:"label"`
	Role       string  `json:"role"`
	Status     string  `json:"status"`
	Connection string  `json:"connection"`
	InviteID   *string `json:"inviteId"`
}

// Invite is a created or pending invitation. BindURL is never shown.
type Invite struct {
	InviteID  string `json:"inviteId"`
	Label     string `json:"label,omitempty"`
	Kind      string `json:"kind,omitempty"`
	MemberID  *string `json:"memberId,omitempty"`
	ExpiresAt int64  `json:"expiresAt"`
	BindURL   string `json:"bindUrl,omitempty"`
}

// InviteState is one invitation's stage; capability strings stay in memory.
type InviteState struct {
	InviteID         string  `json:"inviteId"`
	Label            string  `json:"label"`
	Status           string  `json:"status"`
	Stage            string  `json:"stage"`
	ExpiresAt        int64   `json:"expiresAt"`
	RealnameDeadline *int64  `json:"realnameDeadline,omitempty"`
	RealnameURL      *string `json:"realnameUrl,omitempty"`
	QRContent        *string `json:"qrContent,omitempty"`
	Failure          *string `json:"failure,omitempty"`
}

// Client talks to one deployment's member routes.
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
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    httpClient,
	}
}

// List reads every user, the owner included.
func (c *Client) List(ctx context.Context) ([]User, error) {
	raw, status, err := c.do(ctx, http.MethodGet, membersPath, nil)
	if err != nil {
		return nil, err
	}
	if err := c.check(status, raw); err != nil {
		return nil, err
	}
	var payload struct {
		Users []User `json:"users"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, c.invalid()
	}
	if payload.Users == nil {
		payload.Users = []User{}
	}
	return payload.Users, nil
}

// PendingInvites reads the invitations the wizard can resume.
func (c *Client) PendingInvites(ctx context.Context) ([]Invite, error) {
	raw, status, err := c.do(ctx, http.MethodGet, invitesPath, nil)
	if err != nil {
		return nil, err
	}
	if err := c.check(status, raw); err != nil {
		return nil, err
	}
	var payload struct {
		Invites []Invite `json:"invites"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, c.invalid()
	}
	if payload.Invites == nil {
		payload.Invites = []Invite{}
	}
	return payload.Invites, nil
}

// CreateInvite starts a new-user invitation.
func (c *Client) CreateInvite(ctx context.Context, label string) (Invite, error) {
	raw, status, err := c.do(ctx, http.MethodPost, invitesPath, map[string]string{"label": label})
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

// InviteState reads one invitation's stage.
func (c *Client) InviteState(ctx context.Context, id string) (InviteState, error) {
	raw, status, err := c.do(ctx, http.MethodGet, invitesPath+"/"+id, nil)
	if err != nil {
		return InviteState{}, err
	}
	if err := c.check(status, raw); err != nil {
		return InviteState{}, err
	}
	return decodeState(raw, c.invalid())
}

// SubmitPin hands the PIN WeChat showed on the invitee's phone.
func (c *Client) SubmitPin(ctx context.Context, id, pin string) (InviteState, error) {
	raw, status, err := c.do(ctx, http.MethodPost, invitesPath+"/"+id+"/pin", map[string]string{"pin": pin})
	if err != nil {
		return InviteState{}, err
	}
	if err := c.check(status, raw); err != nil {
		return InviteState{}, err
	}
	return decodeState(raw, c.invalid())
}

// CancelInvite closes a pending invitation.
func (c *Client) CancelInvite(ctx context.Context, id string) error {
	raw, status, err := c.do(ctx, http.MethodDelete, invitesPath+"/"+id, nil)
	if err != nil {
		return err
	}
	return c.check(status, raw)
}

// Rebind starts a replacement invitation for one existing user.
func (c *Client) Rebind(ctx context.Context, memberID string) (Invite, error) {
	raw, status, err := c.do(ctx, http.MethodPost, membersPath+"/"+memberID+"/rebind", nil)
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

// Revoke removes one user's access and credentials.
func (c *Client) Revoke(ctx context.Context, memberID string) error {
	raw, status, err := c.do(ctx, http.MethodDelete, membersPath+"/"+memberID, nil)
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
	requestCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
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
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize))
	if err != nil {
		return nil, 0, domain.Error{Code: CodeRequestFailed, Message: c.t("memberadmin.unreachable")}
	}
	return raw, response.StatusCode, nil
}

// check turns one response status into a fixed error. A 404 without a code is
// a missing route (older deployment), not missing data.
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
	case "WRONG_STAGE":
		return domain.Error{Code: CodeWrongStage, Message: c.t("memberadmin.wrongStage")}
	case "INVALID_LABEL":
		return domain.Error{Code: CodeInvalidLabel, Message: c.t("memberadmin.invalidLabel")}
	case "INVITE_NOT_FOUND", "MEMBER_NOT_FOUND", "NOT_REBINDABLE", "OWNER_IMMUTABLE", "INVITE_CLOSED":
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
