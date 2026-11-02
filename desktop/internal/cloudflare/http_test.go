package cloudflare

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "cfut_SENTINEL-token-must-not-leak-0123456789"

func testClient(t *testing.T, srv *httptest.Server, sleep func(context.Context, time.Duration) error) *Client {
	t.Helper()
	if sleep == nil {
		sleep = func(context.Context, time.Duration) error { return nil }
	}
	return NewTestClient(Options{
		Token:   func(context.Context) (string, error) { return testToken, nil },
		Version: "9.9.9",
	}, srv.URL+"/client/v4", nil, sleep)
}

func TestClientSendsTokenAndUserAgent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+testToken {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("User-Agent"); got != "DeskWandBot/9.9.9" {
			t.Errorf("User-Agent = %q, want DeskWandBot/9.9.9", got)
		}
		if got := r.URL.Query().Get("page"); got != "2" {
			t.Errorf("page query = %q, want 2", got)
		}
		if r.URL.Path != "/client/v4/accounts/abc/workers/scripts" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{"ok":true}}`)
	}))
	defer srv.Close()

	var out struct {
		OK bool `json:"ok"`
	}
	err := testClient(t, srv, nil).GetJSON(context.Background(), "/accounts/abc/workers/scripts", url.Values{"page": {"2"}}, &out)
	if err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	if !out.OK {
		t.Fatal("result was not decoded")
	}
}

func TestClientParsesEnvelopeFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"result":null}`)
	}))
	defer srv.Close()

	err := testClient(t, srv, nil).GetJSON(context.Background(), "/user/tokens/verify", nil, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error = %v, want *APIError", err)
	}
	if apiErr.Status != http.StatusForbidden || apiErr.Code != 10000 || apiErr.Message != "Authentication error" {
		t.Fatalf("APIError = %+v", apiErr)
	}
}

func TestClientRejectsNonJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "upstream failure")
	}))
	defer srv.Close()

	err := testClient(t, srv, nil).GetJSON(context.Background(), "/accounts/abc", nil, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error = %v, want *APIError", err)
	}
	if apiErr.Status != http.StatusBadGateway || apiErr.Message != "non-JSON response" {
		t.Fatalf("APIError = %+v", apiErr)
	}
}

func TestClientRetriesGETOnRateLimitAndHonoursRetryAfter(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"success":false,"errors":[{"code":10000,"message":"rate limited"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	defer srv.Close()

	var delays []time.Duration
	client := testClient(t, srv, func(ctx context.Context, d time.Duration) error {
		delays = append(delays, d)
		return nil
	})
	if err := client.GetJSON(context.Background(), "/accounts/abc", nil, nil); err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
	if len(delays) != 1 || delays[0] != 7*time.Second {
		t.Fatalf("delays = %v, want [7s]", delays)
	}
}

func TestClientCapsRetryAfter(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "9223372036854775807")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, `{"success":false,"errors":[{"code":10000,"message":"unavailable"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	defer srv.Close()

	var delays []time.Duration
	client := testClient(t, srv, func(ctx context.Context, d time.Duration) error {
		delays = append(delays, d)
		return nil
	})
	if err := client.GetJSON(context.Background(), "/accounts/abc", nil, nil); err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	if len(delays) != 1 || delays[0] != 30*time.Second {
		t.Fatalf("delays = %v, want [30s]", delays)
	}
}

func TestClientNeverRetriesMutations(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"success":false,"errors":[{"code":10000,"message":"rate limited"}]}`)
	}))
	defer srv.Close()

	var delays []time.Duration
	client := testClient(t, srv, func(ctx context.Context, d time.Duration) error {
		delays = append(delays, d)
		return nil
	})
	err := client.SendJSON(context.Background(), http.MethodPost, "/accounts/abc/workers/scripts", map[string]string{"name": "x"}, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests {
		t.Fatalf("error = %v, want APIError 429", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("mutation calls = %d, want 1", calls.Load())
	}
	if len(delays) != 0 {
		t.Fatalf("mutation slept: %v", delays)
	}
}

func TestClientRejectsCrossOriginRedirect(t *testing.T) {
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationCalls.Add(1)
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	defer destination.Close()

	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/steal", http.StatusFound)
	}))
	defer source.Close()

	err := testClient(t, source, nil).GetJSON(context.Background(), "/accounts/abc", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "cross-origin redirect") {
		t.Fatalf("error = %v, want cross-origin redirect rejection", err)
	}
	if destinationCalls.Load() != 0 {
		t.Fatalf("destination called %d times", destinationCalls.Load())
	}
}

func TestClientDoesNotFollowRedirectsForMutations(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()

	err := testClient(t, srv, nil).SendJSON(context.Background(), http.MethodPost, "/accounts/abc/workers/scripts", map[string]string{"name": "x"}, nil)
	if err == nil || !strings.Contains(err.Error(), "refusing to follow redirect") {
		t.Fatalf("error = %v, want redirect rejection", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

func TestClientValidatesPaths(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	defer srv.Close()
	client := testClient(t, srv, nil)

	bad := []string{
		"",
		"/accounts",
		"/accounts/../user/tokens/verify",
		"https://evil.example/accounts/abc",
		"//evil.example/accounts/abc",
		"/accounts/abc?x=1",
		"/accounts/abc#fragment",
		"/accounts//abc",
		"/accounts/./abc",
		"/accounts/abc/../def",
		"/zones/abc",
		"accounts/abc",
	}
	for _, path := range bad {
		if err := client.GetJSON(context.Background(), path, nil, nil); err == nil {
			t.Errorf("path %q accepted", path)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("requests made for invalid paths: %d", calls.Load())
	}
	if err := client.GetJSON(context.Background(), "/accounts/abc/workers/scripts/foo..bar", nil, nil); err != nil {
		t.Fatalf("double dots inside a segment should be allowed: %v", err)
	}
}

func TestClientAllowsOnlyExpectedMethods(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	defer srv.Close()
	client := testClient(t, srv, nil)

	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		if err := client.SendJSON(context.Background(), method, "/accounts/abc/workers/scripts", nil, nil); err != nil {
			t.Errorf("%s rejected: %v", method, err)
		}
	}
	for _, method := range []string{http.MethodHead, http.MethodOptions, "TRACE"} {
		if err := client.SendJSON(context.Background(), method, "/accounts/abc/workers/scripts", nil, nil); err == nil {
			t.Errorf("%s accepted", method)
		}
	}
}

func TestClientRejectsSameOriginRedirectOutsideAPIPrefix(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer srv.Close()

	err := testClient(t, srv, nil).GetJSON(context.Background(), "/accounts/abc", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "outside the API prefix") {
		t.Fatalf("error = %v, want API-prefix redirect rejection", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

func TestClientRedactsEveryErrorEntry(t *testing.T) {
	const first = "first-error-sentinel"
	const second = "second-error-sentinel"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprintf(w, `{"success":false,"errors":[{"code":1,"message":"%s"},{"code":2,"message":"%s"}]}`, first, second)
	}))
	defer srv.Close()

	client := testClient(t, srv, nil)
	client.RegisterRedacted(first)
	client.RegisterRedacted(second)
	err := client.GetJSON(context.Background(), "/accounts/abc", nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), first) || strings.Contains(err.Error(), second) {
		t.Fatalf("error entry was not redacted: %v", err)
	}
	if strings.Count(err.Error(), "[REDACTED]") != 2 {
		t.Fatalf("error did not include both redacted entries: %v", err)
	}
}

func TestIsRetryableTransportError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"timeout", timeoutError{}, true},
		{"net op", &net.OpError{Op: "dial", Err: errors.New("refused")}, true},
		{"unexpected EOF", io.ErrUnexpectedEOF, true},
		{"plain EOF", io.EOF, true},
		{"certificate verification", &tls.CertificateVerificationError{Err: errors.New("bad cert")}, false},
		{"unknown authority", x509.UnknownAuthorityError{}, false},
		{"plain error", errors.New("nope"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isRetryableTransportError(tc.err); got != tc.want {
				t.Fatalf("isRetryableTransportError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func TestClientHonoursContextCancellation(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-started
		cancel()
	}()
	err := testClient(t, srv, nil).GetJSON(ctx, "/accounts/abc", nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestClientRedactsTokenAndRegisteredSentinel(t *testing.T) {
	const registered = "registered-secret-sentinel"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		body := fmt.Sprintf(`{"success":false,"errors":[{"code":1000,"message":"bad %s and %s"}]}`, testToken, registered)
		_, _ = io.WriteString(w, body)
	}))
	defer srv.Close()

	client := testClient(t, srv, nil)
	client.RegisterRedacted(registered)
	err := client.GetJSON(context.Background(), "/user/tokens/verify", nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	message := err.Error()
	if strings.Contains(message, testToken) {
		t.Fatalf("error contains API token: %s", message)
	}
	if strings.Contains(message, registered) {
		t.Fatalf("error contains registered sentinel: %s", message)
	}
	if !strings.Contains(message, "[REDACTED]") {
		t.Fatalf("error did not mark redaction: %s", message)
	}
}

func TestClientSendJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q", got)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if body["name"] != "value" {
			t.Errorf("body = %#v", body)
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{"ok":true}}`)
	}))
	defer srv.Close()

	var out struct {
		OK bool `json:"ok"`
	}
	if err := testClient(t, srv, nil).SendJSON(context.Background(), http.MethodPatch, "/accounts/abc/settings", map[string]string{"name": "value"}, &out); err != nil {
		t.Fatalf("SendJSON: %v", err)
	}
	if !out.OK {
		t.Fatal("result was not decoded")
	}
}

func TestClientSendMultipart(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s, want PUT", r.Method)
		}
		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "multipart/form-data" {
			t.Fatalf("Content-Type = %q", r.Header.Get("Content-Type"))
		}
		reader := multipart.NewReader(r.Body, params["boundary"])
		parts := map[string]string{}
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("NextPart: %v", err)
			}
			data, _ := io.ReadAll(part)
			parts[part.FormName()] = string(data)
		}
		if parts["metadata"] != `{"main_module":"index.js"}` {
			t.Errorf("metadata = %q", parts["metadata"])
		}
		if parts["index.js"] != "export default {};" {
			t.Errorf("index.js = %q", parts["index.js"])
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	defer srv.Close()

	err := testClient(t, srv, nil).SendMultipart(context.Background(), http.MethodPut, "/accounts/abc/workers/scripts/name", []Part{
		{Name: "metadata", Data: []byte(`{"main_module":"index.js"}`)},
		{Name: "index.js", FileName: "index.js", ContentType: "application/javascript+module", Data: []byte("export default {};")},
	}, nil)
	if err != nil {
		t.Fatalf("SendMultipart: %v", err)
	}
}

func TestAPIErrorMessageIsRedactedBeforeTruncation(t *testing.T) {
	const registered = "tail-sentinel"
	longPrefix := strings.Repeat("x", 290)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		body := fmt.Sprintf(`{"success":false,"errors":[{"code":1,"message":"%s %s"}]}`, longPrefix, registered)
		_, _ = io.WriteString(w, body)
	}))
	defer srv.Close()

	client := testClient(t, srv, nil)
	client.RegisterRedacted(registered)
	err := client.GetJSON(context.Background(), "/accounts/abc", nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), registered) {
		t.Fatalf("truncation leaked sentinel: %v", err)
	}
}
