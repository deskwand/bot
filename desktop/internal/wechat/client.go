// Package wechat implements the desktop side of the WeChat iLink QR login.
// It never starts message polling: credentials are handed to the deployment
// publisher, and the Worker remains the only consumer of the bot token.
package wechat

import (
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

// DefaultBaseURL is the fixed iLink login origin. A confirmed login carries a
// base URL that may differ; it is only accepted when the same trusted-origin
// check used by the Worker accepts it.
const DefaultBaseURL = "https://ilinkai.weixin.qq.com"

const (
	botType       = "3"
	clientVersion = "1"
	maxBodyBytes  = 1 << 20
)

// QR status values returned by iLink.
const (
	QRWait      = "wait"
	QRScanned   = "scaned"
	QRConfirmed = "confirmed"
	QRExpired   = "expired"
)

var (
	// ErrRedirect rejects every redirect. The token-bearing caller must never
	// follow a response to a different origin.
	ErrRedirect = errors.New("wechat: redirects are not allowed")
	// ErrUntrustedBaseURL means the returned service origin is not a WeChat
	// service domain or is not served over HTTPS.
	ErrUntrustedBaseURL = errors.New("wechat: service origin is not trusted")
	// ErrCredentialsIncomplete means a confirmed response omitted a required
	// credential field.
	ErrCredentialsIncomplete = errors.New("wechat: login response is missing credential fields")
	// ErrResponseInvalid means the iLink response did not have the documented
	// shape.
	ErrResponseInvalid = errors.New("wechat: iLink response is invalid")
)

// Error is a sanitized iLink API error. It deliberately never carries the
// response body or a token.
type Error struct {
	Message    string
	Code       int
	HTTPStatus int
}

func (e Error) Error() string {
	if e.Message == "" {
		return ErrResponseInvalid.Error()
	}
	return "wechat: " + e.Message
}

// QRCode is one issued login QR code.
type QRCode struct {
	QRCode       string
	ImageContent string
}

// QRStatus is one status observation. Raw is only read internally to assemble
// credentials and is never returned in LoginStatus.
type QRStatus struct {
	State string
	Raw   map[string]any
}

// Client is the iLink QR login client.
type Client struct {
	baseURL    string
	httpClient *http.Client
	trustBase  func(string) bool
}

// NewClient returns a client for the public iLink origin. It uses the default
// HTTP transport and rejects redirects.
func NewClient() *Client {
	return newClient(DefaultBaseURL, nil, IsTrustedBaseURL)
}

func newClient(baseURL string, httpClient *http.Client, trustBase func(string) bool) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	cloned := *httpClient
	cloned.CheckRedirect = func(*http.Request, []*http.Request) error {
		return ErrRedirect
	}
	if trustBase == nil {
		trustBase = IsTrustedBaseURL
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &cloned,
		trustBase:  trustBase,
	}
}

// GetBotQRCode requests a new login QR code.
func (c *Client) GetBotQRCode(ctx context.Context) (QRCode, error) {
	raw, err := c.get(ctx, "/ilink/bot/get_bot_qrcode?bot_type="+botType, nil)
	if err != nil {
		return QRCode{}, err
	}
	qrcode := readString(raw, "qrcode")
	image := readString(raw, "qrcode_img_content")
	if qrcode == "" || image == "" {
		return QRCode{}, ErrResponseInvalid
	}
	return QRCode{QRCode: qrcode, ImageContent: image}, nil
}

// GetQRStatus polls the status of one QR code.
func (c *Client) GetQRStatus(ctx context.Context, qrcode string) (QRStatus, error) {
	raw, err := c.get(ctx, "/ilink/bot/get_qrcode_status?qrcode="+url.QueryEscape(qrcode), map[string]string{
		"iLink-App-ClientVersion": clientVersion,
	})
	if err != nil {
		return QRStatus{}, err
	}
	state := readString(raw, "status")
	switch state {
	case QRWait, QRScanned, QRConfirmed, QRExpired:
		return QRStatus{State: state, Raw: raw}, nil
	default:
		return QRStatus{}, ErrResponseInvalid
	}
}

func (c *Client) get(ctx context.Context, path string, headers map[string]string) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c.trustBase == nil || !c.trustBase(c.baseURL) {
		return nil, ErrUntrustedBaseURL
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, fmt.Errorf("wechat: build request: %w", err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if errors.Is(err, ErrRedirect) {
			return nil, ErrRedirect
		}
		return nil, errors.New("wechat: request failed")
	}
	defer response.Body.Close()
	return parseResponse(response)
}

func parseResponse(response *http.Response) (map[string]any, error) {
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, ErrRedirect
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes+1))
	if err != nil {
		return nil, errors.New("wechat: read response failed")
	}
	if len(body) > maxBodyBytes {
		return nil, ErrResponseInvalid
	}

	var raw map[string]any
	if len(body) > 0 {
		_ = json.Unmarshal(body, &raw)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := readString(raw, "errmsg")
		if message == "" {
			message = fmt.Sprintf("WECHAT_ILINK_HTTP_%d", response.StatusCode)
		}
		return nil, Error{Message: message, Code: readNumericCode(raw), HTTPStatus: response.StatusCode}
	}
	if raw == nil {
		return nil, ErrResponseInvalid
	}
	if code := readNumericCode(raw); code != 0 {
		message := readString(raw, "errmsg")
		if message == "" {
			message = "WECHAT_ILINK_API_ERROR"
		}
		return nil, Error{Message: message, Code: code, HTTPStatus: response.StatusCode}
	}
	return raw, nil
}

func readNumericCode(raw map[string]any) int {
	if raw == nil {
		return 0
	}
	if value, ok := raw["errcode"].(float64); ok {
		return int(value)
	}
	if value, ok := raw["ret"].(float64); ok {
		return int(value)
	}
	return 0
}

func readString(raw map[string]any, key string) string {
	if raw == nil {
		return ""
	}
	value, _ := raw[key].(string)
	return value
}

// IsTrustedBaseURL applies the same allowlist as the Worker iLink client:
// HTTPS only, no credentials or non-default port, and a host under
// weixin.qq.com. Query strings and fragments are rejected because a service
// base URL has no use for them.
func IsTrustedBaseURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if parsed.Scheme != "https" || parsed.User != nil {
		return false
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return false
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	return host == "weixin.qq.com" || strings.HasSuffix(host, ".weixin.qq.com")
}
