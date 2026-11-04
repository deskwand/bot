package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const tokenSentinel = "123456:SECRET-token-sentinel"

type recordedCall struct {
	method string
	path   string
	body   map[string]any
}

func fakeTelegram(t *testing.T, response any, status int, calls *[]recordedCall) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		*calls = append(*calls, recordedCall{method: r.Method, path: r.URL.Path, body: body})
		if response == nil {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(response)
	}))
}

func TestNewClientUsesFixedOriginAndDefaultTransport(t *testing.T) {
	client := NewClient(tokenSentinel)
	if client.baseURL != APIBaseURL {
		t.Fatalf("base URL = %q, want %q", client.baseURL, APIBaseURL)
	}
	if client.http.Transport != nil {
		t.Fatal("client set a custom transport; HTTPS_PROXY would be ignored")
	}
}

func TestGetMe(t *testing.T) {
	var calls []recordedCall
	server := fakeTelegram(t, map[string]any{
		"ok": true,
		"result": map[string]any{
			"id":         42,
			"is_bot":     true,
			"first_name": "DeskWand",
			"username":   "deskwand_bot",
		},
	}, http.StatusOK, &calls)
	defer server.Close()

	client := newClient(server.URL, tokenSentinel, server.Client())
	user, err := client.GetMe(context.Background())
	if err != nil {
		t.Fatalf("GetMe: %v", err)
	}
	if user.ID != 42 || !user.IsBot || user.Username != "deskwand_bot" {
		t.Fatalf("user = %#v", user)
	}
	if len(calls) != 1 || calls[0].method != http.MethodGet || calls[0].path != "/bot"+tokenSentinel+"/getMe" {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestDeleteWebhookPostsEmptyBody(t *testing.T) {
	var calls []recordedCall
	server := fakeTelegram(t, map[string]any{"ok": true, "result": true}, http.StatusOK, &calls)
	defer server.Close()

	client := newClient(server.URL, tokenSentinel, server.Client())
	if err := client.DeleteWebhook(context.Background()); err != nil {
		t.Fatalf("DeleteWebhook: %v", err)
	}
	if len(calls) != 1 || calls[0].method != http.MethodPost || calls[0].path != "/bot"+tokenSentinel+"/deleteWebhook" {
		t.Fatalf("calls = %#v", calls)
	}
	if calls[0].body == nil || len(calls[0].body) != 0 {
		t.Fatalf("body = %#v, want an empty object", calls[0].body)
	}
}

func TestErrorsNeverContainToken(t *testing.T) {
	var calls []recordedCall
	server := fakeTelegram(t, map[string]any{
		"ok":          false,
		"description": "bad token " + tokenSentinel,
	}, http.StatusUnauthorized, &calls)
	defer server.Close()

	client := newClient(server.URL, tokenSentinel, server.Client())
	_, err := client.GetMe(context.Background())
	if err == nil {
		t.Fatal("GetMe succeeded despite an API error")
	}
	if strings.Contains(err.Error(), tokenSentinel) {
		t.Fatalf("error leaked token: %v", err)
	}
	if !strings.Contains(err.Error(), RedactedToken) {
		t.Fatalf("error did not mark redaction: %v", err)
	}
}

func TestNetworkErrorNeverContainsToken(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	serverURL := server.URL
	server.Close()

	client := newClient(serverURL, tokenSentinel, server.Client())
	_, err := client.GetMe(context.Background())
	if err == nil {
		t.Fatal("GetMe succeeded against a closed server")
	}
	if strings.Contains(err.Error(), tokenSentinel) {
		t.Fatalf("network error leaked token: %v", err)
	}
}

func TestClientFormattingRedactsToken(t *testing.T) {
	client := NewClient(tokenSentinel)
	representations := []string{
		client.String(),
		fmt.Sprintf("%v", client),
		fmt.Sprintf("%+v", client),
		fmt.Sprintf("%#v", client),
		fmt.Sprintf("%s", client),
	}
	for _, representation := range representations {
		if strings.Contains(representation, tokenSentinel) {
			t.Fatalf("representation leaked token: %s", representation)
		}
	}
}

func TestRedirectsAreNotFollowed(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Redirect(w, r, "https://evil.example/steal", http.StatusFound)
	}))
	defer server.Close()

	client := newClient(server.URL, tokenSentinel, server.Client())
	_, err := client.GetMe(context.Background())
	if err == nil {
		t.Fatal("GetMe succeeded through a redirect")
	}
	if calls != 1 {
		t.Fatalf("requests = %d, redirect target was contacted", calls)
	}
	if strings.Contains(err.Error(), tokenSentinel) {
		t.Fatalf("redirect error leaked token: %v", err)
	}
}

func TestEmptyTokenMakesNoRequest(t *testing.T) {
	client := NewClient("")
	if _, err := client.GetMe(context.Background()); err != ErrInvalidToken {
		t.Fatalf("GetMe error = %v, want ErrInvalidToken", err)
	}
}
