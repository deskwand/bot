package cloudflare_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func deploymentHandler(t *testing.T, targetVersion string, failFirstPolls int) (http.Handler, *int) {
	t.Helper()
	polls := 0
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/deployments"):
			var body struct {
				Versions []struct {
					VersionID  string  `json:"version_id"`
					Percentage float64 `json:"percentage"`
				} `json:"versions"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode deployment body: %v", err)
			}
			if len(body.Versions) != 1 || body.Versions[0].VersionID != targetVersion || body.Versions[0].Percentage != 100 {
				t.Errorf("deployment body = %#v", body)
			}
			writeResult(t, w, map[string]any{"id": "deployment-new"})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/deployments"):
			polls++
			active := "version-old"
			if polls > failFirstPolls {
				active = targetVersion
			}
			writeResult(t, w, map[string]any{"deployments": []any{map[string]any{
				"id":       "deployment-new",
				"versions": []any{map[string]any{"version_id": active, "percentage": 100}},
			}}})
		default:
			http.NotFound(w, r)
		}
	}), &polls
}

func TestActivateVersionConfirmsFromDeploymentList(t *testing.T) {
	handler, polls := deploymentHandler(t, "version-new", 2)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := cloudflare.NewTestClient(cloudflare.Options{
		Token: func(context.Context) (string, error) { return "token", nil },
	}, server.URL+"/client/v4", server.Client(), func(context.Context, time.Duration) error { return nil })

	result, err := client.ActivateVersion(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"}, "version-new")
	if err != nil {
		t.Fatal(err)
	}
	if result.DeploymentID != "deployment-new" || result.VersionID != "version-new" {
		t.Fatalf("result = %#v", result)
	}
	if *polls != 3 {
		t.Fatalf("polls = %d, want 3", *polls)
	}
}

func TestActivateVersionIsBounded(t *testing.T) {
	handler, _ := deploymentHandler(t, "version-new", 1_000_000)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := cloudflare.NewTestClient(cloudflare.Options{
		Token: func(context.Context) (string, error) { return "token", nil },
	}, server.URL+"/client/v4", server.Client(), func(context.Context, time.Duration) error { return nil })

	if _, err := client.ActivateVersion(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"}, "version-new"); err == nil {
		t.Fatal("unactivated deployment returned success")
	}
}

func TestActivateVersionRejectsEmptyVersion(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	t.Cleanup(server.Close)
	client := cloudflare.NewTestClient(cloudflare.Options{
		Token: func(context.Context) (string, error) { return "token", nil },
	}, server.URL+"/client/v4", server.Client(), func(context.Context, time.Duration) error { return nil })

	if _, err := client.ActivateVersion(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"}, " "); err == nil {
		t.Fatal("empty version accepted")
	}
	if called {
		t.Fatal("empty version made a request")
	}
}

func TestCurrentDeploymentReportsSplitAsNoActiveVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeResult(t, w, map[string]any{"deployments": []any{map[string]any{
			"id": "d",
			"versions": []any{
				map[string]any{"version_id": "a", "percentage": 50},
				map[string]any{"version_id": "b", "percentage": 50},
			},
		}}})
	}))
	t.Cleanup(server.Close)
	client := cloudflare.NewTestClient(cloudflare.Options{
		Token: func(context.Context) (string, error) { return "token", nil },
	}, server.URL+"/client/v4", server.Client(), func(context.Context, time.Duration) error { return nil })

	state, err := client.CurrentDeployment(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"})
	if err != nil {
		t.Fatal(err)
	}
	if state.ActiveVersionID() != "" {
		t.Fatalf("split deployment active version = %q", state.ActiveVersionID())
	}
}
