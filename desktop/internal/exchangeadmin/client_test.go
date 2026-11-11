package exchangeadmin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
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

func TestProbeMapsUnauthorizedToUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	if _, err := client.Probe(context.Background(), "okx-main"); err == nil {
		t.Fatal("401 must be an error")
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
