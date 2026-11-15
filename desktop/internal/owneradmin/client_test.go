package owneradmin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStatusSendsBearerAndDecodes(t *testing.T) {
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"mode":"claimed","ownerUserId":"111","windowOpenedAt":10,"windowClosesAt":20}`))
	}))
	defer server.Close()

	status, err := NewClient(server.URL, "secret-token", server.Client()).Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if gotPath != "/admin/owner/status" || gotAuth != "Bearer secret-token" {
		t.Errorf("request = %q %q", gotPath, gotAuth)
	}
	if status.Mode != "claimed" || status.OwnerUserID != "111" {
		t.Errorf("status = %#v", status)
	}
}

func TestOpenAndRevokeUsePost(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		_, _ = w.Write([]byte(`{"mode":"claimable","ownerUserId":"","windowOpenedAt":1,"windowClosesAt":2}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "t", server.Client())
	if _, err := client.Open(context.Background()); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := client.Revoke(context.Background()); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	want := []string{"POST /admin/owner/open", "POST /admin/owner/revoke"}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("call %d = %q, want %q", i, calls[i], want[i])
		}
	}
}

func TestStatusMapsNotFoundToOldDeployment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	_, err := NewClient(server.URL, "t", server.Client()).Status(context.Background())
	if err == nil {
		t.Fatal("want an error for a deployment without the endpoint")
	}
}
