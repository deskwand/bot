// Package browseradmin speaks to the Worker's /admin/browser/* routes: status,
// open, the SSE frame stream, input and close. It owns no state; the sandbox
// owns the tab.
package browseradmin

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Stable error codes this package reports through domain.Error.
const (
	CodeUnavailable = "BROWSER_UNAVAILABLE"
	CodeFailed      = "BROWSER_FAILED"
)

const (
	statusPath = "/admin/browser/status"
	openPath   = "/admin/browser/open"
	streamPath = "/admin/browser/mirror"
	inputPath  = "/admin/browser/input"
	closePath  = "/admin/browser/close"
	// A frame is a whole JPEG in base64: a small one is ~10 KB and a 1280x800
	// frame can pass 200 KB, so this reader must not be a default bufio.Scanner.
	readBufferBytes = 1 << 20
	maxBodyBytes    = 4 << 20
)

// Status is what the takeover page needs to know before it draws anything.
type Status struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// Opened is the sandbox's answer to "show me this page".
type Opened struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

// StreamState is either a new URL for the tab ("state") or why the stream is
// over ("end": closed, superseded or timeout).
type StreamState struct {
	Kind   string
	URL    string
	Reason string
}

// Frame is one screen frame, still base64-encoded as the sandbox sent it.
type Frame struct {
	Seq  int    `json:"seq"`
	JPEG string `json:"jpeg"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// Event is one mouse or key action, in frame coordinates.
type Event struct {
	Type   string  `json:"type"`
	Kind   string  `json:"kind"`
	X      int     `json:"x,omitempty"`
	Y      int     `json:"y,omitempty"`
	Button string  `json:"button,omitempty"`
	DeltaY float64 `json:"deltaY,omitempty"`
	Text   string  `json:"text,omitempty"`
	Key    string  `json:"key,omitempty"`
}

// InputResult reports whether the sandbox took the events. A stale frame is
// false with a nil error: that is an expected race, not a failure.
type InputResult struct {
	OK   bool   `json:"ok"`
	Code string `json:"code,omitempty"`
}

// Client talks to one deployment's admin surface.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
	// Locale supplies the language for the two sentences this package owns.
	Locale func() string
}

func (c *Client) lang() string {
	if c.Locale == nil {
		return "zh"
	}
	return c.Locale()
}

func (c *Client) t(key string) string { return i18n.T(c.lang(), key) }

func (c *Client) unreachable() error {
	return domain.Error{Code: CodeUnavailable, Message: c.t("browseradmin.unreachable")}
}

func (c *Client) refused() error {
	return domain.Error{Code: adminendpoint.CodeTokenRejected, Message: c.t("browseradmin.refused")}
}

func (c *Client) broken() error {
	return domain.Error{Code: CodeFailed, Message: c.t("browseradmin.failed")}
}

// NewClient builds a client. A nil httpClient gets a short timeout; the frame
// stream overrides it because a stream outlives any request timeout.
func NewClient(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), token: token, http: httpClient}
}

// Status reads whether the takeover panel can do anything at all.
func (c *Client) Status(ctx context.Context) (Status, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+statusPath, nil)
	if err != nil {
		return Status{}, c.broken()
	}
	request.Header.Set("authorization", "Bearer "+c.token)
	response, err := c.http.Do(request)
	if err != nil {
		return Status{}, c.unreachable()
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return Status{}, c.refused()
	}
	var status Status
	if err := json.NewDecoder(io.LimitReader(response.Body, maxBodyBytes)).Decode(&status); err != nil {
		return Status{}, c.broken()
	}
	return status, nil
}

// Open points the takeover tab at url (or re-opens the current one when empty).
func (c *Client) Open(ctx context.Context, url string) (Opened, error) {
	response, err := c.post(ctx, openPath, map[string]string{"url": url})
	if err != nil {
		return Opened{}, err
	}
	defer func() { _ = response.Body.Close() }()
	var opened Opened
	if err := json.NewDecoder(io.LimitReader(response.Body, maxBodyBytes)).Decode(&opened); err != nil {
		return Opened{}, c.broken()
	}
	return opened, nil
}

// Stream reads the SSE body until the server ends it or the context is
// cancelled. Returning an error from either callback stops the stream.
func (c *Client) Stream(
	ctx context.Context,
	emit func(Frame) error,
	onState func(StreamState) error,
) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+streamPath, nil)
	if err != nil {
		return c.broken()
	}
	request.Header.Set("authorization", "Bearer "+c.token)
	// A stream has no deadline of its own; the context owns the lifetime.
	streaming := *c.http
	streaming.Timeout = 0
	response, err := streaming.Do(request)
	if err != nil {
		return c.unreachable()
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return c.unreachable()
	}

	reader := bufio.NewReaderSize(response.Body, readBufferBytes)
	event := ""
	for {
		line, readErr := reader.ReadString('\n')
		trimmed := strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(trimmed, "event: "):
			event = strings.TrimPrefix(trimmed, "event: ")
		case strings.HasPrefix(trimmed, "data: "):
			payload := strings.TrimPrefix(trimmed, "data: ")
			switch event {
			case "frame":
				var frame Frame
				if err := json.Unmarshal([]byte(payload), &frame); err == nil {
					if err := emit(frame); err != nil {
						return err
					}
				}
			case "state", "end":
				var body struct {
					URL    string `json:"url"`
					Reason string `json:"reason"`
				}
				_ = json.Unmarshal([]byte(payload), &body)
				if err := onState(StreamState{Kind: event, URL: body.URL, Reason: body.Reason}); err != nil {
					return err
				}
			}
			event = ""
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return c.unreachable()
		}
	}
}

// Input forwards mouse and key events for the frame they were drawn on.
func (c *Client) Input(ctx context.Context, seq int, events []Event) (InputResult, error) {
	if events == nil {
		events = []Event{}
	}
	response, err := c.post(ctx, inputPath, map[string]any{"seq": seq, "events": events})
	if err != nil {
		return InputResult{}, err
	}
	defer func() { _ = response.Body.Close() }()
	var result InputResult
	if err := json.NewDecoder(io.LimitReader(response.Body, maxBodyBytes)).Decode(&result); err != nil {
		return InputResult{}, c.broken()
	}
	return result, nil
}

// Close drops the takeover tab.
func (c *Client) Close(ctx context.Context) error {
	response, err := c.post(ctx, closePath, map[string]string{})
	if err != nil {
		return err
	}
	_ = response.Body.Close()
	return nil
}

func (c *Client) post(ctx context.Context, path string, body any) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, c.broken()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, strings.NewReader(string(payload)))
	if err != nil {
		return nil, c.broken()
	}
	request.Header.Set("authorization", "Bearer "+c.token)
	request.Header.Set("content-type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, c.unreachable()
	}
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusUnauthorized {
		_ = response.Body.Close()
		return nil, c.refused()
	}
	if response.StatusCode >= 300 {
		_ = response.Body.Close()
		return nil, c.broken()
	}
	return response, nil
}
