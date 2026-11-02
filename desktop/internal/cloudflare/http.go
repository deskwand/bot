// Package cloudflare is a fixed-origin HTTP client for the Cloudflare API v4.
// It deliberately has no public option for changing the origin: callers can
// only make requests to https://api.cloudflare.com/client/v4.
package cloudflare

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// DefaultOrigin is the only production API origin.
	DefaultOrigin = "https://api.cloudflare.com/client/v4"
	// DefaultVersion is used in the User-Agent when Options.Version is empty.
	DefaultVersion = "0.1.0"

	apiPathPrefix = "/client/v4"

	requestTimeout   = 60 * time.Second
	maxAttempts      = 3
	maxRetryDelay    = 30 * time.Second
	maxErrorRunes    = 300
	maxResponseBytes = 8 << 20
)

var (
	errCrossOriginRedirect = errors.New("cloudflare: refusing cross-origin redirect")
	errMutationRedirect    = errors.New("cloudflare: refusing to follow redirect")
	errRedirectOutsideAPI  = errors.New("cloudflare: refusing redirect outside the API prefix")
	errTooManyRedirects    = errors.New("cloudflare: too many redirects")
)

// TokenSource returns the bearer token for a request. Implementations should
// read the system credential store and must not log the returned value.
type TokenSource func(ctx context.Context) (string, error)

// Options configures a Client. The origin is intentionally not configurable.
type Options struct {
	Token   TokenSource
	Version string
}

// Part is one field or file in a multipart request.
type Part struct {
	Name        string
	FileName    string
	ContentType string
	Data        []byte
}

// Response contains a successful Cloudflare envelope. Result and ResultInfo
// are the raw JSON values so callers decode only what they need.
type Response struct {
	StatusCode int
	Header     http.Header
	Result     json.RawMessage
	ResultInfo json.RawMessage
}

// APIError is a safe, redacted Cloudflare API failure.
type APIError struct {
	Status     int
	Code       int
	Message    string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e == nil {
		return "cloudflare: <nil>"
	}
	switch {
	case e.Status > 0 && e.Code > 0 && e.Message != "":
		return fmt.Sprintf("cloudflare: HTTP %d (code %d): %s", e.Status, e.Code, e.Message)
	case e.Status > 0 && e.Message != "":
		return fmt.Sprintf("cloudflare: HTTP %d: %s", e.Status, e.Message)
	case e.Message != "":
		return "cloudflare: " + e.Message
	default:
		return "cloudflare: request failed"
	}
}

// Client sends requests only to Cloudflare's fixed API origin.
type Client struct {
	token     TokenSource
	baseURL   *url.URL
	http      *http.Client
	sleep     func(context.Context, time.Duration) error
	userAgent string

	redactedMu sync.RWMutex
	redacted   []string
}

// RegisterRedacted adds a value that must never appear in an API error
// message. The bearer token is always redacted automatically.
func (c *Client) RegisterRedacted(value string) {
	if value == "" {
		return
	}
	c.redactedMu.Lock()
	defer c.redactedMu.Unlock()
	for _, existing := range c.redacted {
		if existing == value {
			return
		}
	}
	c.redacted = append(c.redacted, value)
}

// New returns a Cloudflare client for the fixed production origin.
func New(opts Options) *Client {
	return newClient(opts, DefaultOrigin, nil, defaultSleep)
}

func newClient(opts Options, origin string, httpClient *http.Client, sleep func(context.Context, time.Duration) error) *Client {
	baseURL, err := url.Parse(origin)
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		panic("cloudflare: invalid internal API origin")
	}
	if sleep == nil {
		sleep = defaultSleep
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
	} else {
		copyClient := *httpClient
		if copyClient.Timeout == 0 {
			copyClient.Timeout = requestTimeout
		}
		httpClient = &copyClient
	}
	version := opts.Version
	if version == "" {
		version = DefaultVersion
	}

	client := &Client{
		token:     opts.Token,
		baseURL:   baseURL,
		http:      httpClient,
		sleep:     sleep,
		userAgent: "DeskWandBot/" + version,
	}
	httpClient.CheckRedirect = client.checkRedirect
	return client
}

func defaultSleep(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Client) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	origin := via[0]
	if origin.Method != http.MethodGet {
		return fmt.Errorf("%w for %s", errMutationRedirect, origin.Method)
	}
	if len(via) >= 10 {
		return errTooManyRedirects
	}
	if !strings.EqualFold(req.URL.Host, origin.URL.Host) || req.URL.Scheme != origin.URL.Scheme {
		return fmt.Errorf("%w to %s", errCrossOriginRedirect, req.URL.Host)
	}
	if req.URL.Path != apiPathPrefix && !strings.HasPrefix(req.URL.Path, apiPathPrefix+"/") {
		return fmt.Errorf("%w to %s", errRedirectOutsideAPI, req.URL.Path)
	}
	return nil
}

// GetJSON sends a GET request and decodes result into out when out is non-nil.
// path must be /accounts, start with /accounts/ or start with /user/, and
// contain unescaped segments; the client rejects schemes, hosts, queries,
// fragments and parent segments.
func (c *Client) GetJSON(ctx context.Context, path string, query url.Values, out any) error {
	resp, err := c.do(ctx, http.MethodGet, path, query, nil, "")
	if err != nil {
		return err
	}
	return decodeResult(resp, out, resp.StatusCode)
}

// GetJSONWithResultInfo is GetJSON with the raw result_info object returned as
// well, for paginated list endpoints.
func (c *Client) GetJSONWithResultInfo(ctx context.Context, path string, query url.Values, out any) (json.RawMessage, error) {
	resp, err := c.do(ctx, http.MethodGet, path, query, nil, "")
	if err != nil {
		return nil, err
	}
	if err := decodeResult(resp, out, resp.StatusCode); err != nil {
		return nil, err
	}
	return resp.ResultInfo, nil
}

// SendJSON sends method with an optional JSON request body and decodes the
// response result into out. path follows the same unescaped-segment rules as
// GetJSON.
func (c *Client) SendJSON(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		encoded, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("cloudflare: encode request body: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	resp, err := c.do(ctx, method, path, nil, body, "application/json")
	if err != nil {
		return err
	}
	return decodeResult(resp, out, resp.StatusCode)
}

// SendMultipart sends method with a multipart/form-data body and decodes the
// response result into out. path follows the same unescaped-segment rules as
// GetJSON.
func (c *Client) SendMultipart(ctx context.Context, method, path string, parts []Part, out any) error {
	return c.SendMultipartQuery(ctx, method, path, nil, parts, out)
}

// SendMultipartQuery is SendMultipart with query parameters, used by the
// version upload where bindings_inherit=strict is required.
func (c *Client) SendMultipartQuery(ctx context.Context, method, path string, query url.Values, parts []Part, out any) error {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, part := range parts {
		if part.Name == "" {
			return errors.New("cloudflare: multipart part has no name")
		}
		header := make(textproto.MIMEHeader)
		disposition := fmt.Sprintf(`form-data; name="%s"`, escapeQuotes(part.Name))
		if part.FileName != "" {
			disposition += fmt.Sprintf(`; filename="%s"`, escapeQuotes(part.FileName))
		}
		header.Set("Content-Disposition", disposition)
		contentType := part.ContentType
		if contentType == "" && part.FileName != "" {
			contentType = "application/octet-stream"
		}
		if contentType != "" {
			header.Set("Content-Type", contentType)
		}
		destination, err := writer.CreatePart(header)
		if err != nil {
			return fmt.Errorf("cloudflare: create multipart part: %w", err)
		}
		if _, err := destination.Write(part.Data); err != nil {
			return fmt.Errorf("cloudflare: write multipart part: %w", err)
		}
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("cloudflare: finish multipart body: %w", err)
	}

	resp, err := c.do(ctx, method, path, query, bytes.NewReader(buffer.Bytes()), writer.FormDataContentType())
	if err != nil {
		return err
	}
	return decodeResult(resp, out, resp.StatusCode)
}

func escapeQuotes(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, `\"`).Replace(value)
}

func decodeResult(resp *Response, out any, status int) error {
	if out == nil || len(resp.Result) == 0 || string(resp.Result) == "null" {
		return nil
	}
	if err := json.Unmarshal(resp.Result, out); err != nil {
		return &APIError{Status: status, Message: "invalid result JSON"}
	}
	return nil
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body io.Reader, contentType string) (*Response, error) {
	if err := validateMethod(method); err != nil {
		return nil, err
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if c.token == nil {
		return nil, errors.New("cloudflare: no token source configured")
	}
	token, err := c.token(ctx)
	if err != nil {
		return nil, fmt.Errorf("cloudflare: read API token: %w", err)
	}
	if token == "" {
		return nil, errors.New("cloudflare: empty API token")
	}

	var payload []byte
	if body != nil {
		payload, err = io.ReadAll(body)
		if err != nil {
			return nil, fmt.Errorf("cloudflare: read request body: %w", err)
		}
	}

	endpoint := c.endpoint(path, query)
	retryable := method == http.MethodGet
	var lastErr error

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		var requestBody io.Reader
		if payload != nil {
			requestBody = bytes.NewReader(payload)
		}
		request, err := http.NewRequestWithContext(ctx, method, endpoint, requestBody)
		if err != nil {
			return nil, fmt.Errorf("cloudflare: create request: %w", err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", c.userAgent)
		if payload != nil && contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}

		httpResponse, requestErr := c.http.Do(request)
		if requestErr != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if errors.Is(requestErr, errCrossOriginRedirect) || errors.Is(requestErr, errMutationRedirect) || errors.Is(requestErr, errRedirectOutsideAPI) || errors.Is(requestErr, errTooManyRedirects) {
				return nil, requestErr
			}
			lastErr = &APIError{Message: truncateMessage(c.redact(requestErr.Error(), token))}
			if retryable && isRetryableTransportError(requestErr) && attempt < maxAttempts {
				if err := c.sleep(ctx, retryDelay(attempt, 0)); err != nil {
					return nil, err
				}
				continue
			}
			return nil, lastErr
		}

		response, apiErr := c.parseResponse(httpResponse, token)
		if apiErr == nil {
			return response, nil
		}
		lastErr = apiErr
		if retryable && isRetryableStatus(apiErr.Status) && attempt < maxAttempts {
			if err := c.sleep(ctx, retryDelay(attempt, apiErr.RetryAfter)); err != nil {
				return nil, err
			}
			continue
		}
		return nil, apiErr
	}
	return nil, lastErr
}

func (c *Client) endpoint(path string, query url.Values) string {
	target := *c.baseURL
	target.Path = strings.TrimRight(c.baseURL.Path, "/") + path
	target.RawPath = ""
	target.RawQuery = ""
	target.Fragment = ""
	if query != nil {
		target.RawQuery = query.Encode()
	}
	return target.String()
}

func validAPIPath(path string) bool {
	return path == "/accounts" || strings.HasPrefix(path, "/accounts/") || strings.HasPrefix(path, "/user/")
}

func validateMethod(method string) error {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return nil
	default:
		return fmt.Errorf("cloudflare: method %q is not allowed", method)
	}
}

// Callers pass path segments unescaped. Percent-encoded input is rejected when
// decoding would introduce a parent segment or otherwise escape the prefix.
func validatePath(path string) error {
	if !validAPIPath(path) {
		return fmt.Errorf("cloudflare: path %q must be /accounts, start with /accounts/ or start with /user/", path)
	}
	parsed, err := url.Parse(path)
	if err != nil {
		return fmt.Errorf("cloudflare: invalid path %q", path)
	}
	if parsed.Scheme != "" || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("cloudflare: path %q must not contain a scheme, host, query or fragment", path)
	}
	for _, candidate := range []string{path, parsed.Path} {
		if !validAPIPath(candidate) {
			return fmt.Errorf("cloudflare: path %q escapes the API prefix", path)
		}
		if strings.Contains(candidate, "//") || strings.Contains(candidate, `\`) {
			return fmt.Errorf("cloudflare: path %q contains an empty or backslash segment", path)
		}
		for _, segment := range strings.Split(candidate, "/") {
			if segment == "." || segment == ".." {
				return fmt.Errorf("cloudflare: path %q contains a dot or parent segment", path)
			}
		}
		for _, r := range candidate {
			if r <= 0x20 || r == 0x7f {
				return fmt.Errorf("cloudflare: path %q contains whitespace or a control character", path)
			}
		}
	}
	return nil
}

type envelope struct {
	Success    bool            `json:"success"`
	Errors     []envelopeError `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo json.RawMessage `json:"result_info"`
}

type envelopeError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (c *Client) parseResponse(response *http.Response, token string) (*Response, *APIError) {
	defer response.Body.Close()

	retryAfter := parseRetryAfter(response.Header)
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, &APIError{
			Status:     response.StatusCode,
			Message:    truncateMessage(c.redact("cannot read response body: "+err.Error(), token)),
			RetryAfter: retryAfter,
		}
	}
	if len(data) > maxResponseBytes {
		return nil, &APIError{
			Status:     response.StatusCode,
			Message:    "response body too large",
			RetryAfter: retryAfter,
		}
	}

	var parsed envelope
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, &APIError{
			Status:     response.StatusCode,
			Message:    "non-JSON response",
			RetryAfter: retryAfter,
		}
	}

	if response.StatusCode >= 200 && response.StatusCode < 300 && parsed.Success {
		return &Response{
			StatusCode: response.StatusCode,
			Header:     response.Header.Clone(),
			Result:     parsed.Result,
			ResultInfo: parsed.ResultInfo,
		}, nil
	}

	apiErr := &APIError{
		Status:     response.StatusCode,
		RetryAfter: retryAfter,
	}
	messages := make([]string, 0, len(parsed.Errors))
	for _, entry := range parsed.Errors {
		if apiErr.Code == 0 {
			apiErr.Code = entry.Code
		}
		if entry.Message != "" {
			messages = append(messages, entry.Message)
		}
	}
	if len(messages) > 0 {
		apiErr.Message = strings.Join(messages, "; ")
	}
	if apiErr.Message == "" {
		apiErr.Message = http.StatusText(response.StatusCode)
	}
	if apiErr.Message == "" {
		apiErr.Message = "request failed"
	}
	apiErr.Message = truncateMessage(c.redact(apiErr.Message, token))
	return nil, apiErr
}

func parseRetryAfter(header http.Header) time.Duration {
	value := strings.TrimSpace(header.Get("Retry-After"))
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds <= 0 {
			return 0
		}
		if seconds > int64(maxRetryDelay/time.Second) {
			return maxRetryDelay
		}
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		delay := time.Until(when)
		if delay <= 0 {
			return 0
		}
		return delay
	}
	return 0
}

func retryDelay(attempt int, retryAfter time.Duration) time.Duration {
	delay := retryAfter
	if delay <= 0 {
		delay = time.Duration(1<<uint(attempt-1)) * time.Second
	}
	if delay > maxRetryDelay {
		delay = maxRetryDelay
	}
	return delay
}

func isRetryableTransportError(err error) bool {
	if err == nil {
		return false
	}
	var certificateErr *tls.CertificateVerificationError
	if errors.As(err, &certificateErr) {
		return false
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return false
	}
	var hostnameErr x509.HostnameError
	if errors.As(err, &hostnameErr) {
		return false
	}
	var invalidCert x509.CertificateInvalidError
	if errors.As(err, &invalidCert) {
		return false
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

func isRetryableStatus(status int) bool {
	switch status {
	case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func (c *Client) redact(message, token string) string {
	c.redactedMu.RLock()
	values := append([]string(nil), c.redacted...)
	c.redactedMu.RUnlock()
	if token != "" {
		values = append(values, token)
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	for _, value := range values {
		if value != "" {
			message = strings.ReplaceAll(message, value, "[REDACTED]")
		}
	}
	return message
}

func truncateMessage(message string) string {
	if utf8.RuneCountInString(message) <= maxErrorRunes {
		return message
	}
	runes := []rune(message)
	return string(runes[:maxErrorRunes])
}
