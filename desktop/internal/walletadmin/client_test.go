package walletadmin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestStatusParsesConfiguredPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != walletStatusPath {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Fatal("missing bearer token")
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"configured":true,"address":"0x2222222222222222222222222222222222222222","valueUsd":12.5}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if !status.Configured || status.Address != "0x2222222222222222222222222222222222222222" {
		t.Fatalf("status = %#v", status)
	}
	if status.ValueUSD == nil || *status.ValueUSD != 12.5 {
		t.Fatalf("valueUsd = %#v", status.ValueUSD)
	}
}

func TestStatusParsesUnavailableValue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"configured":true,"address":"0x2222222222222222222222222222222222222222","valueUsd":null}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if !status.Configured || status.Address == "" || status.ValueUSD != nil {
		t.Fatalf("status = %#v", status)
	}
}

func TestStatusParsesUnconfiguredPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"configured":false}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Configured || status.Address != "" || status.ValueUSD != nil {
		t.Fatalf("status = %#v", status)
	}
}

func TestStatusMapsUnauthorizedToTokenRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	_, err := client.Status(context.Background())
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != adminendpoint.CodeTokenRejected {
		t.Fatalf("error = %v, want %s", err, adminendpoint.CodeTokenRejected)
	}
}

func TestStatusMapsAMissingRouteToUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	_, err := client.Status(context.Background())
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != CodeAdminUnavailable {
		t.Fatalf("error = %v, want %s", err, CodeAdminUnavailable)
	}
}

func TestStatusRedactsTheAdminToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"boom token-sentinel"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token-sentinel", server.Client())
	_, err := client.Status(context.Background())
	if err == nil {
		t.Fatal("500 must be an error")
	}
	if got := err.Error(); got == "" || containsToken(got) {
		t.Fatalf("error leaked the token: %q", got)
	}
}

func containsToken(text string) bool {
	return len(text) >= 14 && (func() bool {
		for i := 0; i+14 <= len(text); i++ {
			if text[i:i+14] == "token-sentinel" {
				return true
			}
		}
		return false
	})()
}
