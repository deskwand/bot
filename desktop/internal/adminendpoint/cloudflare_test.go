package adminendpoint

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
)

type fakeSnapshots struct {
	snapshot domain.Snapshot
	err      error
	calls    int
}

func (f *fakeSnapshots) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	f.calls++
	return f.snapshot, f.err
}

type fakePublisher struct {
	calls  int
	change domain.Change
	err    error
}

func (f *fakePublisher) Apply(_ context.Context, _ domain.Target, change domain.Change) (domain.Result, error) {
	f.calls++
	f.change = change
	if f.err != nil {
		return domain.Result{}, f.err
	}
	return domain.Result{State: "published"}, nil
}

func settingsWithBaseURL(baseURL string) []byte {
	document, _ := json.Marshal(map[string]any{
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": baseURL},
		},
	})
	return document
}

func hasCode(err error, code string) bool {
	var coded domain.Error
	if !errors.As(err, &coded) {
		return false
	}
	return coded.Code == code
}

func TestCloudflareResolveUsesPublicBaseURLAndTheVaultToken(t *testing.T) {
	snapshots := &fakeSnapshots{snapshot: domain.Snapshot{
		Target:       cloudflareTarget(),
		Fingerprint:  "fp",
		SettingsJSON: settingsWithBaseURL("https://desk.example"),
		SecretNames:  []string{"ADMIN_TOKEN"},
	}}
	creds := platform.NewMemoryCredentialStore()
	if err := creds.Set(context.Background(), backup.AdminTokenKey(cloudflareTarget()), "vault-token"); err != nil {
		t.Fatalf("set: %v", err)
	}
	resolver := NewCloudflare(CloudflareDeps{Snapshots: snapshots, Publisher: &fakePublisher{}, Credentials: creds})

	endpoint, err := resolver.Resolve(context.Background(), cloudflareTarget())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if endpoint.BaseURL != "https://desk.example" || endpoint.Token != "vault-token" {
		t.Fatalf("endpoint = %#v", endpoint)
	}
	if endpoint.HTTP != nil {
		t.Fatal("HTTP should stay nil so clients apply their own default")
	}
}

func TestCloudflareResolveRejectsAMissingBaseURL(t *testing.T) {
	resolver := NewCloudflare(CloudflareDeps{
		Snapshots:   &fakeSnapshots{snapshot: domain.Snapshot{Target: cloudflareTarget()}},
		Publisher:   &fakePublisher{},
		Credentials: platform.NewMemoryCredentialStore(),
	})
	_, err := resolver.Resolve(context.Background(), cloudflareTarget())
	if !hasCode(err, CodeAdminUnavailable) {
		t.Fatalf("error = %v, want %s", err, CodeAdminUnavailable)
	}
}

func TestCloudflareResolveWaitsWhenItPublishedTheToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// A 409 already proves the route and the token are live.
		w.WriteHeader(http.StatusConflict)
	}))
	defer server.Close()

	snapshots := &fakeSnapshots{snapshot: domain.Snapshot{
		Target:       cloudflareTarget(),
		Fingerprint:  "fp",
		SettingsJSON: settingsWithBaseURL(server.URL),
		SecretNames:  []string{},
	}}
	publisher := &fakePublisher{}
	resolver := NewCloudflare(CloudflareDeps{
		Snapshots:   snapshots,
		Publisher:   publisher,
		Credentials: platform.NewMemoryCredentialStore(),
		HTTP:        server.Client(),
	})

	endpoint, err := resolver.Resolve(context.Background(), cloudflareTarget())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if publisher.calls != 1 {
		t.Fatalf("publisher calls = %d, want 1", publisher.calls)
	}
	if endpoint.Token == "" {
		t.Fatal("token is empty after publishing")
	}
}
