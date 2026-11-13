package lifeadmin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/deskwand/bot/desktop/internal/adminendpoint"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func codeOf(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) {
		t.Fatalf("error is not a domain.Error: %v", err)
	}
	return domainErr.Code
}

func TestVitalsDecodesThePayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != vitalsPath {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Fatal("missing bearer token")
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"balanceUsd":42.5,"dailySpendUsd":1.85,"runwayDays":23,"tier":"ample","metabolismStarted":true,"unpriced":false,"topSources":[{"source":"butler","usd":6.1}]}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	vitals, err := client.Vitals(context.Background())
	if err != nil {
		t.Fatalf("Vitals: %v", err)
	}
	if vitals.BalanceUSD != 42.5 || vitals.DailySpendUSD != 1.85 {
		t.Fatalf("vitals = %#v", vitals)
	}
	if vitals.RunwayDays == nil || *vitals.RunwayDays != 23 {
		t.Fatalf("runwayDays = %#v", vitals.RunwayDays)
	}
	if vitals.Tier != "ample" || !vitals.MetabolismStarted || vitals.Unpriced {
		t.Fatalf("vitals = %#v", vitals)
	}
	if len(vitals.TopSources) != 1 || vitals.TopSources[0].Source != "butler" || vitals.TopSources[0].USD != 6.1 {
		t.Fatalf("topSources = %#v", vitals.TopSources)
	}
}

func TestVitalsKeepsANullRunway(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"balanceUsd":0,"dailySpendUsd":0,"runwayDays":null,"tier":"ample","metabolismStarted":false,"unpriced":false,"topSources":[]}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	vitals, err := client.Vitals(context.Background())
	if err != nil {
		t.Fatalf("Vitals: %v", err)
	}
	if vitals.RunwayDays != nil {
		t.Fatalf("runwayDays = %#v", vitals.RunwayDays)
	}
}

func TestVitalsMapsNotFoundToUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	_, err := client.Vitals(context.Background())
	if got := codeOf(t, err); got != CodeUnsupported {
		t.Fatalf("code = %q, want %q", got, CodeUnsupported)
	}
}

func TestVitalsMapsUnauthorizedToTokenRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	_, err := client.Vitals(context.Background())
	if got := codeOf(t, err); got != adminendpoint.CodeTokenRejected {
		t.Fatalf("code = %q, want %q", got, adminendpoint.CodeTokenRejected)
	}
}

func TestVitalsPassesTheWorkerCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"LIFE_VITALS_FAILED"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", server.Client())
	_, err := client.Vitals(context.Background())
	if got := codeOf(t, err); got != CodeRequestFailed {
		t.Fatalf("code = %q, want %q", got, CodeRequestFailed)
	}
}

func TestVitalsRedactsTheToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"boom token-sentinel"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token-sentinel", server.Client())
	_, err := client.Vitals(context.Background())
	if err == nil {
		t.Fatal("500 must be an error")
	}
	got := err.Error()
	if containsToken(got) {
		t.Fatalf("error leaked the token: %q", got)
	}
	if want := "<redacted>"; !containsText(got, want) {
		t.Fatalf("error is not redacted: %q", got)
	}
}

func containsToken(text string) bool { return containsText(text, "token-sentinel") }

func containsText(text, part string) bool {
	for i := 0; i+len(part) <= len(text); i++ {
		if text[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
