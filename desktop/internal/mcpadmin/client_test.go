package mcpadmin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
)

const testAdminToken = "admin-token-sentinel"

type recordedRequest struct {
	method string
	path   string
	auth   string
	body   map[string]any
}

func TestClientCallsMcpRoutesWithBearer(t *testing.T) {
	var requests []recordedRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorded := recordedRequest{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization")}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&recorded.body)
		}
		requests = append(requests, recorded)

		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/admin/mcp/probe":
			_ = json.NewEncoder(w).Encode(Probe{OK: true, Tools: []Tool{{Name: "search", Description: "search", Mode: "auto"}}})
		case r.Method == http.MethodPost && r.URL.Path == "/admin/mcp/oauth/start":
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://auth.example/authorize?x=1"})
		case r.Method == http.MethodGet && r.URL.Path == "/admin/mcp/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"servers": []AuthStatus{{Name: "github", State: "ok"}}})
		case r.Method == http.MethodDelete && r.URL.Path == "/admin/mcp/oauth/github":
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, testAdminToken, nil)
	ctx := context.Background()

	probe, err := client.Probe(ctx, "github")
	if err != nil {
		t.Fatal(err)
	}
	if !probe.OK || len(probe.Tools) != 1 || probe.Tools[0].Mode != "auto" {
		t.Fatalf("probe = %#v", probe)
	}
	authorizeURL, err := client.StartOAuth(ctx, "github")
	if err != nil {
		t.Fatal(err)
	}
	if authorizeURL != "https://auth.example/authorize?x=1" {
		t.Fatalf("authorize url = %q", authorizeURL)
	}
	status, err := client.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(status) != 1 || status[0].State != "ok" {
		t.Fatalf("status = %#v", status)
	}
	if err := client.Revoke(ctx, "github"); err != nil {
		t.Fatal(err)
	}

	want := []recordedRequest{
		{method: http.MethodPost, path: "/admin/mcp/probe", auth: "Bearer " + testAdminToken, body: map[string]any{"name": "github"}},
		{method: http.MethodPost, path: "/admin/mcp/oauth/start", auth: "Bearer " + testAdminToken, body: map[string]any{"name": "github"}},
		{method: http.MethodGet, path: "/admin/mcp/status", auth: "Bearer " + testAdminToken},
		{method: http.MethodDelete, path: "/admin/mcp/oauth/github", auth: "Bearer " + testAdminToken},
	}
	if len(requests) != len(want) {
		t.Fatalf("requests = %#v", requests)
	}
	for i, expected := range want {
		got := requests[i]
		if got.method != expected.method || got.path != expected.path || got.auth != expected.auth {
			t.Fatalf("request %d = %#v, want %#v", i, got, expected)
		}
		if expected.body != nil && got.body["name"] != expected.body["name"] {
			t.Fatalf("request %d body = %#v", i, got.body)
		}
	}
}

func TestClientMapsUnauthorizedToTokenRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewClient(server.URL, testAdminToken, nil)
	_, err := client.Probe(context.Background(), "github")
	if code := errorCode(err); code != adminendpoint.CodeTokenRejected {
		t.Fatalf("code = %q, want %s (%v)", code, adminendpoint.CodeTokenRejected, err)
	}
	if err == nil || !strings.Contains(err.Error(), i18n.T(i18n.ZH, "mcpadmin.unauthorized")) {
		t.Fatalf("error = %v", err)
	}
}

func TestClientMapsAMissingRouteToUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := NewClient(server.URL, testAdminToken, nil)
	_, err := client.Probe(context.Background(), "github")
	if code := errorCode(err); code != CodeAdminUnavailable {
		t.Fatalf("code = %q, want %s (%v)", code, CodeAdminUnavailable, err)
	}
	if err == nil || !strings.Contains(err.Error(), i18n.T(i18n.ZH, "mcpadmin.unavailable")) {
		t.Fatalf("error = %v", err)
	}
}

func TestClientPreservesWorkerErrorCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "MCP_INVALID", "message": "服务不存在或不需要授权"})
	}))
	defer server.Close()

	client := NewClient(server.URL, testAdminToken, nil)
	_, err := client.StartOAuth(context.Background(), "missing")
	if code := errorCode(err); code != "MCP_INVALID" {
		t.Fatalf("code = %q, want MCP_INVALID (%v)", code, err)
	}
	if !strings.Contains(err.Error(), "服务不存在或不需要授权") {
		t.Fatalf("error = %v", err)
	}
}

func errorCode(err error) string {
	var coded domain.Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return ""
}

func TestAdminErrorsFollowLocale(t *testing.T) {
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()

	hang := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hang
	}))
	defer slow.Close()
	defer close(hang)

	invalid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	}))
	defer invalid.Close()

	clients := map[string]*Client{
		"connection failure": NewClient(closedURL, testAdminToken, nil),
		"timeout":            NewClient(slow.URL, testAdminToken, &http.Client{Timeout: 50 * time.Millisecond}),
		"invalid response":   NewClient(invalid.URL, testAdminToken, nil),
	}
	for name, client := range clients {
		client.Locale = func() string { return i18n.EN }
		_, err := client.Status(context.Background())
		if err == nil {
			t.Fatalf("%s: expected an error", name)
		}
		i18ntest.NoHan(t, name, err.Error())
	}
}

func TestClientReportsNetworkFailureSeparately(t *testing.T) {
	hang := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hang
	}))
	defer slow.Close()
	defer close(hang)

	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()

	cases := map[string]*Client{
		"timeout":            NewClient(slow.URL, testAdminToken, &http.Client{Timeout: 50 * time.Millisecond}),
		"connection refused": NewClient(closedURL, testAdminToken, nil),
	}
	for name, client := range cases {
		_, err := client.Status(context.Background())
		var appErr domain.Error
		if !errors.As(err, &appErr) {
			t.Fatalf("%s: err = %v, want domain.Error", name, err)
		}
		if appErr.Code != CodeAdminUnavailable || appErr.Message != i18n.T(i18n.ZH, "mcpadmin.networkUnreachable") {
			t.Fatalf("%s: err = %#v", name, appErr)
		}
		if strings.Contains(appErr.Message, testAdminToken) {
			t.Fatalf("%s: token leaked", name)
		}
	}
}
