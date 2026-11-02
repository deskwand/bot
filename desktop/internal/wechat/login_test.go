package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const fixtureTokenSentinel = "fixture-bot-token-7d3a"

type recordedRequest struct {
	path    string
	headers http.Header
}

type fakeILink struct {
	mu        sync.Mutex
	requests  []recordedRequest
	qr        map[string]any
	statuses  []map[string]any
	qrCount   int
	statuses_ int
	onStatus  func()
}

func (f *fakeILink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, recordedRequest{path: r.URL.RequestURI(), headers: r.Header.Clone()})
	switch r.URL.Path {
	case "/ilink/bot/get_bot_qrcode":
		f.qrCount++
		body := f.qr
		if body == nil {
			body = map[string]any{
				"qrcode":             fmt.Sprintf("qr-%d", f.qrCount),
				"qrcode_img_content": fmt.Sprintf("https://weixin.qq.com/qr/%d", f.qrCount),
			}
		}
		f.mu.Unlock()
		writeJSON(w, body)
	case "/ilink/bot/get_qrcode_status":
		f.statuses_++
		var body map[string]any
		if len(f.statuses) > 0 {
			body = f.statuses[0]
			f.statuses = f.statuses[1:]
		}
		hook := f.onStatus
		f.mu.Unlock()
		if hook != nil {
			hook()
		}
		if body == nil {
			body = map[string]any{"status": QRWait}
		}
		writeJSON(w, body)
	default:
		f.mu.Unlock()
		http.NotFound(w, r)
	}
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func loadFixture(t *testing.T) map[string]any {
	t.Helper()
	path := filepath.Join("..", "..", "..", "contracts", "fixtures", "ilink-qr.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fixture map[string]any
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode shared fixture: %v", err)
	}
	return fixture
}

func testClient(server *httptest.Server) *Client {
	return newClient(server.URL, server.Client(), func(string) bool { return true })
}

func TestLoginStatusesAndSharedFixtureCredentials(t *testing.T) {
	fixture := loadFixture(t)
	server := httptest.NewServer(&fakeILink{
		qr: map[string]any{
			"qrcode":             fixture["qrcode"],
			"qrcode_img_content": fixture["qrcode_img_content"],
		},
		statuses: []map[string]any{
			{"status": QRWait},
			{"status": QRScanned},
			fixture,
		},
	})
	defer server.Close()

	var statuses []LoginStatus
	var delays []time.Duration
	credentials, err := loginWith(context.Background(), testClient(server), func(_ context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return nil
	}, func(status LoginStatus) {
		statuses = append(statuses, status)
	})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	want := Credentials{
		Token:     fixture["bot_token"].(string),
		BaseURL:   fixture["baseurl"].(string),
		AccountID: fixture["ilink_bot_id"].(string),
		UserID:    fixture["ilink_user_id"].(string),
	}
	if credentials != want {
		t.Fatalf("credentials = %#v, want %#v", credentials, want)
	}
	if len(delays) != 3 {
		t.Fatalf("poll delays = %v, want three 2s polls", delays)
	}
	for _, delay := range delays {
		if delay != 2*time.Second {
			t.Fatalf("poll delay = %v, want 2s", delay)
		}
	}

	states := make([]string, len(statuses))
	for index, status := range statuses {
		states[index] = status.State
		if status.OperationID == "" {
			t.Fatal("status has no operation id")
		}
		if strings.Contains(status.Message, fixtureTokenSentinel) || strings.Contains(status.QRContent, fixtureTokenSentinel) {
			t.Fatalf("status leaked token: %#v", status)
		}
	}
	for _, state := range []string{LoginWaiting, LoginScanned, LoginConfirmed} {
		if !contains(states, state) {
			t.Fatalf("states %v do not include %q", states, state)
		}
	}
}

func TestRepeatedWaitStatusIsNotReEmitted(t *testing.T) {
	fixture := loadFixture(t)
	server := httptest.NewServer(&fakeILink{statuses: []map[string]any{
		{"status": QRWait},
		{"status": QRWait},
		{"status": QRWait},
		fixture,
	}})
	defer server.Close()

	var states []string
	_, err := loginWith(context.Background(), testClient(server), func(context.Context, time.Duration) error {
		return nil
	}, func(status LoginStatus) {
		states = append(states, status.State)
	})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	waitCount := 0
	for _, state := range states {
		if state == LoginWaiting {
			waitCount++
		}
	}
	if waitCount != 1 {
		t.Fatalf("wait states = %d in %v, want only the initial QR state", waitCount, states)
	}
}

func TestLoginRefreshesAtMostThreeQRCodes(t *testing.T) {
	fake := &fakeILink{statuses: []map[string]any{
		{"status": QRExpired},
		{"status": QRExpired},
		{"status": QRExpired},
	}}
	server := httptest.NewServer(fake)
	defer server.Close()

	_, err := loginWith(context.Background(), testClient(server), func(context.Context, time.Duration) error {
		return nil
	}, nil)
	if !errors.Is(err, ErrQRExpired) {
		t.Fatalf("Login error = %v, want ErrQRExpired", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.qrCount != 3 {
		t.Fatalf("QR requests = %d, want 3", fake.qrCount)
	}
	if fake.statuses_ != 3 {
		t.Fatalf("status requests = %d, want 3", fake.statuses_)
	}
}

func TestLoginRejectsIncompleteCredentials(t *testing.T) {
	server := httptest.NewServer(&fakeILink{statuses: []map[string]any{{
		"status":    QRConfirmed,
		"bot_token": fixtureTokenSentinel,
	}}})
	defer server.Close()

	credentials, err := loginWith(context.Background(), testClient(server), func(context.Context, time.Duration) error {
		return nil
	}, nil)
	if !errors.Is(err, ErrCredentialsIncomplete) {
		t.Fatalf("Login error = %v, want ErrCredentialsIncomplete", err)
	}
	if credentials != (Credentials{}) {
		t.Fatalf("returned credentials after incomplete response: %#v", credentials)
	}
}

func TestLoginRejectsUntrustedBaseURL(t *testing.T) {
	fixture := loadFixture(t)
	fixture["baseurl"] = "https://example.com"
	server := httptest.NewServer(&fakeILink{statuses: []map[string]any{fixture}})
	defer server.Close()

	credentials, err := loginWith(context.Background(), testClient(server), func(context.Context, time.Duration) error {
		return nil
	}, nil)
	if !errors.Is(err, ErrUntrustedBaseURL) {
		t.Fatalf("Login error = %v, want ErrUntrustedBaseURL", err)
	}
	if credentials != (Credentials{}) {
		t.Fatalf("returned credentials for untrusted origin: %#v", credentials)
	}
}

func TestLoginRejectsRedirects(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		http.Redirect(w, r, "https://evil.example/steal", http.StatusFound)
	}))
	defer server.Close()

	_, err := loginWith(context.Background(), testClient(server), func(context.Context, time.Duration) error {
		return nil
	}, nil)
	if !errors.Is(err, ErrRedirect) {
		t.Fatalf("Login error = %v, want ErrRedirect", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if requests != 1 {
		t.Fatalf("requests = %d, redirect target was contacted", requests)
	}
}

func TestCancelledLoginReturnsNoCredentials(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	statusRequested := make(chan struct{})
	release := make(chan struct{})
	fake := &fakeILink{
		statuses: []map[string]any{loadFixture(t)},
		onStatus: func() {
			close(statusRequested)
			<-release
		},
	}
	server := httptest.NewServer(fake)
	defer server.Close()

	type result struct {
		credentials Credentials
		err         error
	}
	done := make(chan result, 1)
	go func() {
		credentials, err := loginWith(ctx, testClient(server), func(context.Context, time.Duration) error {
			return nil
		}, nil)
		done <- result{credentials: credentials, err: err}
	}()

	<-statusRequested
	cancel()
	close(release)

	got := <-done
	if !errors.Is(got.err, context.Canceled) {
		t.Fatalf("Login error = %v, want context.Canceled", got.err)
	}
	if got.credentials != (Credentials{}) {
		t.Fatalf("cancelled login returned credentials: %#v", got.credentials)
	}
}

func TestCredentialsRedactToken(t *testing.T) {
	credentials := Credentials{
		Token:     "SECRET-TOKEN-sentinel",
		BaseURL:   "https://ilinkai.weixin.qq.com",
		AccountID: "account-1",
		UserID:    "user-1",
	}

	representations := []string{
		credentials.String(),
		fmt.Sprintf("%v", credentials),
		fmt.Sprintf("%+v", credentials),
		fmt.Sprintf("%#v", credentials),
		fmt.Sprintf("%s", credentials),
	}
	encoded, err := json.Marshal(credentials)
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	representations = append(representations, string(encoded))

	logged := fmt.Sprint(slog.Group("credentials", slog.Any("value", credentials)))
	representations = append(representations, logged)
	for _, representation := range representations {
		if strings.Contains(representation, credentials.Token) {
			t.Fatalf("representation leaked token: %s", representation)
		}
		if !strings.Contains(representation, RedactedToken) &&
			!strings.Contains(representation, `\u003credacted\u003e`) {
			t.Fatalf("representation did not mark redaction: %s", representation)
		}
	}

	secret, err := credentials.SecretJSON()
	if err != nil {
		t.Fatalf("SecretJSON: %v", err)
	}
	if !strings.Contains(string(secret), credentials.Token) {
		t.Fatalf("SecretJSON did not contain token: %s", secret)
	}
}

func TestIsTrustedBaseURL(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"https://ilinkai.weixin.qq.com", true},
		{"https://ilinkai.weixin.qq.com/", true},
		{"https://weixin.qq.com", true},
		{"https://a.b.weixin.qq.com", true},
		{"http://ilinkai.weixin.qq.com", false},
		{"https://example.com", false},
		{"https://evilweixin.qq.com", false},
		{"https://weixin.qq.com.evil.example", false},
		{"https://user:pass@ilinkai.weixin.qq.com", false},
		{"https://ilinkai.weixin.qq.com:8443", false},
		{"https://ilinkai.weixin.qq.com?next=evil", false},
	}
	for _, testCase := range cases {
		if got := IsTrustedBaseURL(testCase.value); got != testCase.want {
			t.Errorf("IsTrustedBaseURL(%q) = %v, want %v", testCase.value, got, testCase.want)
		}
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
