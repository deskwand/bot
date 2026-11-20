package modelauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestStatusListsProviders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != authPath {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Fatal("missing bearer token")
		}
		_, _ = w.Write([]byte(`{"providers":[{"id":"openai-codex","connected":true}]}`))
	}))
	defer server.Close()

	providers, err := NewClient(server.URL, "token", server.Client()).Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(providers) != 1 || providers[0].ID != "openai-codex" || !providers[0].Connected {
		t.Fatalf("providers = %#v", providers)
	}
}

func TestStartPostsToTheProviderPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/models/auth/openai-codex/start" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"deviceAuthId":"device-1","userCode":"ABCD-1234","verificationUrl":"https://auth.openai.com/codex/device","intervalSeconds":5}`))
	}))
	defer server.Close()

	login, err := NewClient(server.URL, "token", server.Client()).Start(context.Background(), "openai-codex")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if login.DeviceAuthID != "device-1" || login.UserCode != "ABCD-1234" || login.IntervalSeconds != 5 {
		t.Fatalf("login = %#v", login)
	}
}

func TestStartBrowserReturnsTheAuthorizeURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/models/auth/openai-codex/browser/start" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"authorizeUrl":"https://auth.openai.com/oauth/authorize?state=s","state":"0123456789abcdef0123456789abcdef","codeVerifier":"verifier-1"}`))
	}))
	defer server.Close()

	started, err := NewClient(server.URL, "token", server.Client()).StartBrowser(context.Background(), "openai-codex")
	if err != nil {
		t.Fatalf("StartBrowser: %v", err)
	}
	if started.CodeVerifier != "verifier-1" || started.State == "" || started.AuthorizeURL == "" {
		t.Fatalf("started = %#v", started)
	}
}

func TestCompleteBrowserPostsTheCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/models/auth/openai-codex/browser/complete" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["code"] != "code-1" || body["codeVerifier"] != "verifier-1" || body["state"] != "state-1" {
			t.Fatalf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"status":"done"}`))
	}))
	defer server.Close()

	err := NewClient(server.URL, "token", server.Client()).
		CompleteBrowser(context.Background(), "openai-codex", "code-1", "verifier-1", "state-1")
	if err != nil {
		t.Fatalf("CompleteBrowser: %v", err)
	}
}

func TestPollSendsTheDevicePair(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/models/auth/openai-codex/poll" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["deviceAuthId"] != "device-1" || body["userCode"] != "ABCD-1234" {
			t.Fatalf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"status":"pending"}`))
	}))
	defer server.Close()

	result, err := NewClient(server.URL, "token", server.Client()).
		Poll(context.Background(), "openai-codex", "device-1", "ABCD-1234")
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if result.Status != "pending" {
		t.Fatalf("status = %q", result.Status)
	}
}

func TestDisconnectUsesDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/admin/models/auth/openai-codex" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	if err := NewClient(server.URL, "token", server.Client()).Disconnect(context.Background(), "openai-codex"); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
}

func TestMissingRouteReadsAsUnavailable(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	_, err := NewClient(server.URL, "token", server.Client()).Status(context.Background())
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != CodeAdminUnavailable {
		t.Fatalf("error = %v, want %s", err, CodeAdminUnavailable)
	}
}

func TestUnknownProviderKeepsItsCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"MODEL_AUTH_UNKNOWN_PROVIDER"}`))
	}))
	defer server.Close()

	_, err := NewClient(server.URL, "token", server.Client()).Start(context.Background(), "openai-codex")
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != "MODEL_AUTH_UNKNOWN_PROVIDER" {
		t.Fatalf("error = %v, want MODEL_AUTH_UNKNOWN_PROVIDER", err)
	}
}

func TestUpstreamFailureKeepsTheCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"code":"MODEL_AUTH_FAILED","message":"model login request failed"}`))
	}))
	defer server.Close()

	_, err := NewClient(server.URL, "token", server.Client()).Start(context.Background(), "openai-codex")
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != CodeRequestFailed {
		t.Fatalf("error = %v, want %s", err, CodeRequestFailed)
	}
}

func TestRejectedTokenIsReportedAsReauth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := NewClient(server.URL, "token", server.Client()).Status(context.Background())
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != adminendpoint.CodeTokenRejected {
		t.Fatalf("error = %v, want %s", err, adminendpoint.CodeTokenRejected)
	}
}
