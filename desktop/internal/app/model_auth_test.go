package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestModelAuthStatusMapsTheWorkerPayload(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/admin/models/auth" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"providers":[{"id":"openai-codex","connected":true}]}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	status, err := fixture.service.ModelAuthStatus()
	if err != nil {
		t.Fatalf("ModelAuthStatus: %v", err)
	}
	if len(status) != 1 || status[0].Provider != "openai-codex" || !status[0].Connected {
		t.Fatalf("status = %#v", status)
	}
}

func TestStartModelDeviceLoginOpensTheVerificationPage(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/models/auth/openai-codex/start" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"deviceAuthId":"device-1","userCode":"ABCD-1234","verificationUrl":"https://auth.openai.com/codex/device","intervalSeconds":5}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	login, err := fixture.service.StartModelDeviceLogin()
	if err != nil {
		t.Fatalf("StartModelDeviceLogin: %v", err)
	}
	if login.Method != "device" || login.UserCode != "ABCD-1234" || login.IntervalSeconds != 5 {
		t.Fatalf("login = %#v", login)
	}
	if len(fixture.browser.opened) != 1 || fixture.browser.opened[0] != "https://auth.openai.com/codex/device" {
		t.Fatalf("opened = %#v", fixture.browser.opened)
	}
	// The handle stays in Go and never appears in the returned DTO.
	if encoded, _ := json.Marshal(login); strings.Contains(string(encoded), "device-1") {
		t.Fatalf("DTO leaked the device handle: %s", encoded)
	}
}

// browserLoginFixture starts a browser login on a free local port and answers
// the deployment's browser routes.
func browserLoginFixture(t *testing.T, port int, complete func(body map[string]string)) *mcpFixture {
	t.Helper()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/admin/models/auth/openai-codex/browser/start":
			_, _ = w.Write([]byte(`{"authorizeUrl":"https://auth.openai.com/oauth/authorize?state=probe","state":"0123456789abcdef0123456789abcdef","codeVerifier":"verifier-1"}`))
		case "/admin/models/auth/openai-codex/start":
			_, _ = w.Write([]byte(`{"deviceAuthId":"device-1","userCode":"ABCD-1234","verificationUrl":"https://auth.openai.com/codex/device","intervalSeconds":5}`))
		case "/admin/models/auth/openai-codex/poll":
			_, _ = w.Write([]byte(`{"status":"pending"}`))
		case "/admin/models/auth/openai-codex/browser/complete":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if complete != nil {
				complete(body)
			}
			_, _ = w.Write([]byte(`{"status":"done"}`))
		default:
			http.NotFound(w, r)
		}
	})
	return newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
}

// freePort reserves and releases a loopback port, so the fixed 1455 in
// production never collides with a parallel test or a busy runner.
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port
}

// withBrowserPort points the loopback at a free port for one test.
func withBrowserPort(t *testing.T) int {
	t.Helper()
	oldPort, oldTimeout := browserLoginPort, browserLoginTimeout
	port := freePort(t)
	browserLoginPort = port
	t.Cleanup(func() {
		browserLoginPort, browserLoginTimeout = oldPort, oldTimeout
	})
	return port
}

func callbackURL(port int, query string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/auth/callback?%s", port, query)
}

func getCallback(t *testing.T, url string) *http.Response {
	t.Helper()
	response, err := http.Get(url)
	if err != nil {
		t.Fatalf("loopback callback: %v", err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func loginState(t *testing.T, service *Service) string {
	t.Helper()
	service.modelLoginMu.Lock()
	defer service.modelLoginMu.Unlock()
	if service.modelLogin == nil {
		t.Fatal("no pending login")
	}
	return service.modelLogin.state
}

func TestBrowserLoginCompletesThroughTheLoopback(t *testing.T) {
	port := withBrowserPort(t)
	var completed map[string]string
	fixture := browserLoginFixture(t, port, func(body map[string]string) {
		completed = body
	})

	login, err := fixture.service.StartModelLogin()
	if err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}
	if login.Method != "browser" || login.UserCode != "" {
		t.Fatalf("login = %#v", login)
	}
	if len(fixture.browser.opened) != 1 ||
		!strings.HasPrefix(fixture.browser.opened[0], "https://auth.openai.com/oauth/authorize") {
		t.Fatalf("opened = %#v", fixture.browser.opened)
	}

	// Still waiting: the browser has not come back yet.
	if status, err := fixture.service.PollModelLogin(); err != nil || status != "pending" {
		t.Fatalf("first poll = %q, %v", status, err)
	}

	state := loginState(t, fixture.service)
	response := getCallback(t, callbackURL(port, "code=code-1&state="+state))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("callback status = %d", response.StatusCode)
	}

	status, err := fixture.service.PollModelLogin()
	if err != nil {
		t.Fatalf("PollModelLogin: %v", err)
	}
	if status != "done" {
		t.Fatalf("status = %q", status)
	}
	if completed["code"] != "code-1" || completed["codeVerifier"] != "verifier-1" ||
		completed["state"] != state {
		t.Fatalf("completed = %#v", completed)
	}
	// The finished login is forgotten.
	if _, err := fixture.service.PollModelLogin(); err == nil {
		t.Fatal("poll after done = nil error, want a failure")
	}
}

func TestBrowserLoginIgnoresAStrayCallback(t *testing.T) {
	port := withBrowserPort(t)
	fixture := browserLoginFixture(t, port, nil)
	if _, err := fixture.service.StartModelLogin(); err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}

	// A wrong state, a missing code and an error with no state all come from
	// somewhere other than this login; none may end it.
	stray := []string{
		"code=code-1&state=wrong",
		"error=access_denied",
		"",
	}
	for _, query := range stray {
		if response := getCallback(t, callbackURL(port, query)); response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", query, response.StatusCode)
		}
	}
	if status, err := fixture.service.PollModelLogin(); err != nil || status != "pending" {
		t.Fatalf("poll after stray callbacks = %q, %v", status, err)
	}

	// The real callback still finishes it.
	state := loginState(t, fixture.service)
	getCallback(t, callbackURL(port, "code=code-1&state="+state))
	if status, err := fixture.service.PollModelLogin(); err != nil || status != "done" {
		t.Fatalf("poll after the real callback = %q, %v", status, err)
	}
}

func TestBrowserLoginSurvivesADoubleCallback(t *testing.T) {
	port := withBrowserPort(t)
	fixture := browserLoginFixture(t, port, nil)
	if _, err := fixture.service.StartModelLogin(); err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}
	state := loginState(t, fixture.service)

	// A refresh of the callback page must not panic the handler or the timer.
	if response := getCallback(t, callbackURL(port, "code=code-1&state="+state)); response.StatusCode != http.StatusOK {
		t.Fatalf("first callback status = %d", response.StatusCode)
	}
	if response := getCallback(t, callbackURL(port, "code=code-2&state="+state)); response.StatusCode != http.StatusOK {
		t.Fatalf("second callback status = %d", response.StatusCode)
	}

	// The first code wins; the second close is a no-op.
	if status, err := fixture.service.PollModelLogin(); err != nil || status != "done" {
		t.Fatalf("poll = %q, %v", status, err)
	}
}

func TestBrowserLoginRejectsTheAuthorizationError(t *testing.T) {
	port := withBrowserPort(t)
	fixture := browserLoginFixture(t, port, nil)
	if _, err := fixture.service.StartModelLogin(); err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}
	state := loginState(t, fixture.service)
	getCallback(t, callbackURL(port, "error=access_denied&state="+state))

	if _, err := fixture.service.PollModelLogin(); err == nil {
		t.Fatal("PollModelLogin = nil error, want the denial to surface")
	}
}

func TestBrowserLoginTimesOut(t *testing.T) {
	port := withBrowserPort(t)
	browserLoginTimeout = 50 * time.Millisecond
	fixture := browserLoginFixture(t, port, nil)
	if _, err := fixture.service.StartModelLogin(); err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := fixture.service.PollModelLogin(); err != nil {
			return
		}
	}
	t.Fatal("PollModelLogin never reported the timeout")
}

func TestBrowserLoginFreesThePortWhenCancelled(t *testing.T) {
	port := withBrowserPort(t)
	fixture := browserLoginFixture(t, port, nil)
	if _, err := fixture.service.StartModelLogin(); err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}
	if err := fixture.service.CancelModelLogin(); err != nil {
		t.Fatalf("CancelModelLogin: %v", err)
	}

	if _, err := fixture.service.PollModelLogin(); err == nil {
		t.Fatal("PollModelLogin after cancel = nil error, want a failure")
	}
	// The listener is closed, so a restart binds the same port again.
	fixture2 := browserLoginFixture(t, port, nil)
	if _, err := fixture2.service.StartModelLogin(); err != nil {
		t.Fatalf("StartModelLogin after cancel: %v", err)
	}
	// And a device login started afterwards owns the pending slot.
	if _, err := fixture2.service.StartModelDeviceLogin(); err != nil {
		t.Fatalf("StartModelDeviceLogin: %v", err)
	}
	if status, err := fixture2.service.PollModelLogin(); err != nil || status != "pending" {
		t.Fatalf("device poll = %q, %v", status, err)
	}
}

func TestPollModelLoginForwardsTheDevicePair(t *testing.T) {
	var polls int
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/admin/models/auth/openai-codex/start":
			_, _ = w.Write([]byte(`{"deviceAuthId":"device-1","userCode":"ABCD-1234","verificationUrl":"https://auth.openai.com/codex/device","intervalSeconds":5}`))
		case "/admin/models/auth/openai-codex/poll":
			polls++
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["deviceAuthId"] != "device-1" || body["userCode"] != "ABCD-1234" {
				t.Errorf("body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"status":"done"}`))
		default:
			http.NotFound(w, r)
		}
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
	if _, err := fixture.service.StartModelDeviceLogin(); err != nil {
		t.Fatalf("StartModelDeviceLogin: %v", err)
	}

	status, err := fixture.service.PollModelLogin()
	if err != nil {
		t.Fatalf("PollModelLogin: %v", err)
	}
	if status != "done" || polls != 1 {
		t.Fatalf("status = %q, polls = %d", status, polls)
	}
	// The finished login is forgotten, so a stray poll cannot resurrect it.
	if _, err := fixture.service.PollModelLogin(); err == nil {
		t.Fatal("PollModelLogin after done = nil error, want a failure")
	}
}

func TestPollModelLoginWithoutAStartedLoginFails(t *testing.T) {
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, nil)

	_, err := fixture.service.PollModelLogin()
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v, want a domain.Error", err)
	}
}

func TestModelAuthUnsupportedDeploymentSaysSo(t *testing.T) {
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, http.NotFoundHandler())

	_, err := fixture.service.ModelAuthStatus()
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != "MODEL_AUTH_ADMIN_UNAVAILABLE" {
		t.Fatalf("error = %v, want MODEL_AUTH_ADMIN_UNAVAILABLE", err)
	}
}
