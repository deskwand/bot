// Package telegram implements the small Telegram Bot API surface needed to
// validate a bot token and remove a registered webhook. The bot token is part
// of the request path, so every error and log value is redacted before it
// leaves this package.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// APIBaseURL is the fixed Telegram Bot API origin.
const APIBaseURL = "https://api.telegram.org"

const maxBodyBytes = 1 << 20

// RedactedToken replaces the bot token in textual output.
const RedactedToken = "<redacted>"

// ErrInvalidToken is returned before any request when the token is empty.
var ErrInvalidToken = errors.New("telegram: bot token is empty")

// User is the subset of getMe returned to the application.
type User struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

// Error is a sanitized Telegram API error.
type Error struct {
	Method      string
	Status      int
	Description string
}

func (e Error) Error() string {
	message := e.Description
	if message == "" {
		message = "request failed"
	}
	if e.Status > 0 {
		return fmt.Sprintf("telegram: %s failed (HTTP %d): %s", e.Method, e.Status, message)
	}
	return fmt.Sprintf("telegram: %s failed: %s", e.Method, message)
}

// Client calls the Telegram Bot API. The zero value is not usable; use
// NewClient. The HTTP client leaves Transport nil so Go's default transport,
// and therefore HTTPS_PROXY, is used on this machine.
type Client struct {
	token   string
	baseURL string
	http    *http.Client
}

// NewClient returns a client for token at the fixed Telegram origin.
func NewClient(token string) *Client {
	return &Client{
		token:   token,
		baseURL: APIBaseURL,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

func newClient(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	cloned := *httpClient
	// Never follow a redirect with a token-bearing URL. The caller sees the
	// redirect response as a sanitized API error instead.
	cloned.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{token: token, baseURL: strings.TrimRight(baseURL, "/"), http: &cloned}
}

// GetMe validates the bot token and returns the bot identity.
func (c *Client) GetMe(ctx context.Context) (User, error) {
	var user User
	if err := c.call(ctx, "getMe", http.MethodGet, nil, &user); err != nil {
		return User{}, err
	}
	return user, nil
}

// DeleteWebhook removes any registered webhook so the Worker can receive
// updates with getUpdates. It omits drop_pending_updates so messages queued
// while the webhook was active are still delivered to the first long poll.
func (c *Client) DeleteWebhook(ctx context.Context) error {
	return c.call(ctx, "deleteWebhook", http.MethodPost, map[string]any{}, nil)
}

func (c *Client) call(ctx context.Context, method, httpMethod string, body any, result any) error {
	if c.token == "" {
		return ErrInvalidToken
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	endpoint := c.baseURL + "/bot" + c.token + "/" + method
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("telegram: encode %s request: %w", method, err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, httpMethod, endpoint, reader)
	if err != nil {
		return fmt.Errorf("telegram: build %s request: %s", method, c.redact(err.Error()))
	}
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}

	response, err := c.http.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("telegram: %s request failed: %s", method, c.redact(err.Error()))
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes+1))
	if err != nil {
		return fmt.Errorf("telegram: read %s response failed", method)
	}
	if len(payload) > maxBodyBytes {
		return Error{Method: method, Status: response.StatusCode, Description: "response is too large"}
	}

	var envelope struct {
		OK          bool            `json:"ok"`
		Description string          `json:"description"`
		Result      json.RawMessage `json:"result"`
	}
	decodeErr := json.Unmarshal(payload, &envelope)
	if decodeErr != nil {
		envelope.OK = false
		envelope.Description = ""
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !envelope.OK {
		description := c.redact(envelope.Description)
		return Error{Method: method, Status: response.StatusCode, Description: description}
	}
	if result == nil {
		return nil
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return nil
	}
	if err := json.Unmarshal(envelope.Result, result); err != nil {
		return Error{Method: method, Status: response.StatusCode, Description: "response result is invalid"}
	}
	return nil
}

func (c *Client) redact(value string) string {
	if c.token == "" {
		return value
	}
	value = strings.ReplaceAll(value, c.token, RedactedToken)
	value = strings.ReplaceAll(value, url.PathEscape(c.token), RedactedToken)
	value = strings.ReplaceAll(value, url.QueryEscape(c.token), RedactedToken)
	return value
}

func (c *Client) String() string {
	return fmt.Sprintf("telegram.Client{token=%q baseUrl=%q}", redacted(c.token), c.baseURL)
}

func (c *Client) GoString() string { return c.String() }

func (c *Client) Format(state fmt.State, _ rune) {
	fmt.Fprint(state, c.String())
}

func redacted(token string) string {
	if token == "" {
		return ""
	}
	return RedactedToken
}
