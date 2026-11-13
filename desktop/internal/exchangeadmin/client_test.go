package exchangeadmin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/exchangesync"
)

func TestProbeReturnsSuccessPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != probePath {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Fatal("missing bearer token")
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"venue":"okx","currencies":3,"total":12.5}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	probe, err := client.Probe(context.Background(), "okx-main")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if !probe.OK || probe.Venue != "okx" || probe.Currencies != 3 {
		t.Fatalf("probe = %#v", probe)
	}
	if probe.Total == nil || *probe.Total != 12.5 {
		t.Fatalf("total = %#v", probe.Total)
	}
}

func TestProbeReadsRefusalFrom400(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"ok":false,"code":"EXCHANGE_REGION_BLOCKED","message":"restricted"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	probe, err := client.Probe(context.Background(), "bn-main")
	if err != nil {
		t.Fatalf("a refusal is a result, not an error: %v", err)
	}
	if probe.OK || probe.Code != "EXCHANGE_REGION_BLOCKED" || probe.Message != "restricted" {
		t.Fatalf("probe = %#v", probe)
	}
}

func TestProbeMapsUnauthorizedToTokenRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	_, err := client.Probe(context.Background(), "okx-main")
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != adminendpoint.CodeTokenRejected {
		t.Fatalf("error = %v, want %s", err, adminendpoint.CodeTokenRejected)
	}
}

func TestProbeMapsAMissingRouteToUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	_, err := client.Probe(context.Background(), "okx-main")
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != CodeAdminUnavailable {
		t.Fatalf("error = %v, want %s", err, CodeAdminUnavailable)
	}
}

func TestProbeRedactsTheAdminToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"boom token-sentinel"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token-sentinel", server.Client())
	_, err := client.Probe(context.Background(), "okx-main")
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

func TestPushSnapshotPostsTheBundle(t *testing.T) {
	var got struct {
		Account   string                  `json:"account"`
		FetchedAt int64                   `json:"fetchedAt"`
		Responses []exchangesync.Response `json:"responses"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != snapshotPath {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			return
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Error("missing bearer token")
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"currencies":2,"total":12.5}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	probe, err := client.PushSnapshot(context.Background(), "bn-main", exchangesync.Bundle{
		FetchedAt: 1700000000123,
		Responses: []exchangesync.Response{
			{Method: "GET", Path: "/api/v3/account", Status: 200, Body: `{"balances":[]}`},
		},
	})
	if err != nil {
		t.Fatalf("PushSnapshot: %v", err)
	}
	if !probe.OK || probe.Currencies != 2 || probe.Total == nil || *probe.Total != 12.5 {
		t.Fatalf("probe = %#v", probe)
	}
	if got.Account != "bn-main" || got.FetchedAt != 1700000000123 {
		t.Fatalf("body = %#v", got)
	}
	if len(got.Responses) != 1 || got.Responses[0].Status != 200 || got.Responses[0].Path != "/api/v3/account" {
		t.Fatalf("responses = %#v", got.Responses)
	}
}

func TestPushSnapshotReturnsARefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"ok":false,"code":"EXCHANGE_ACCOUNT_UNKNOWN"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	probe, err := client.PushSnapshot(context.Background(), "bn-main", exchangesync.Bundle{})
	if err != nil {
		t.Fatalf("a refusal is a result, not an error: %v", err)
	}
	if probe.OK || probe.Code != "EXCHANGE_ACCOUNT_UNKNOWN" {
		t.Fatalf("probe = %#v", probe)
	}
}
