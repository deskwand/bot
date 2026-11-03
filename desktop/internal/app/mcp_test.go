package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
)

const testMcpAdminToken = "mcp-admin-token-sentinel"
const testMcpSecret = "ghp_MCP_SENTINEL_0123456789"

type mcpFixture struct {
	*serviceFixture
	credentials *platform.MemoryCredentialStore
	server      *httptest.Server
}

func newMcpFixture(t *testing.T, serversJSON string, secretNames []string, handler http.Handler) *mcpFixture {
	t.Helper()
	if handler == nil {
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			http.NotFound(w, r)
		})
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	base := newServiceFixture(t)
	credentials := platform.NewMemoryCredentialStore()
	snapshot := mcpSnapshot(server.URL, serversJSON, secretNames)
	base.snapshots = &fakeSnapshots{snapshot: snapshot}
	base.service = NewService(ServiceOptions{
		Auth: base.auth, Publish: base.publish, Lifecycle: base.lifecycle,
		Entries: base.entries, Diagnostics: base.diagnostics, Snapshots: base.snapshots,
		Scripts: base.scripts, Journal: base.journal, Store: base.store, Browser: base.browser,
		McpBrowser:  base.browser,
		Credentials: credentials,
		Release:     base.release,
		EmitLoginStatus: func(LoginStatusDTO) {
		},
		NewOperationID: func() (string, error) { return "login-op", nil },
		Now:            func() time.Time { return time.Unix(1700000000, 0).UTC() },
	})
	if err := credentials.Set(context.Background(), backup.AdminTokenKey(snapshot.Target), testMcpAdminToken); err != nil {
		t.Fatal(err)
	}
	return &mcpFixture{serviceFixture: base, credentials: credentials, server: server}
}

func mcpSnapshot(baseURL, serversJSON string, secretNames []string) domain.Snapshot {
	settings, _ := json.Marshal(map[string]any{
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": baseURL},
		},
	})
	config := fmt.Sprintf(`{
		"schemaVersion": 1,
		"owner": {"telegramUserIds": [42]},
		"models": {
			"butler": {"provider": "anthropic", "id": "claude-sonnet-5-5"},
			"task": {"provider": "anthropic", "id": "claude-sonnet-5-5"}
		},
		"mcpServers": %s
	}`, serversJSON)
	return domain.Snapshot{
		Target:       domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
		DeploymentID: "deployment-1",
		VersionID:    "version-1",
		Fingerprint:  "fingerprint-mcp",
		ConfigJSON:   []byte(config),
		SettingsJSON: settings,
		SecretNames:  secretNames,
	}
}

func TestMcpCatalogIncludesCatalogFields(t *testing.T) {
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, nil)
	entries, err := f.service.McpCatalog()
	if err != nil {
		t.Fatal(err)
	}
	var github *McpCatalogEntryDTO
	for i := range entries {
		if entries[i].ID == "github" {
			github = &entries[i]
		}
	}
	if github == nil {
		t.Fatal("catalog has no github entry")
	}
	if github.Name != "GitHub" || github.Category == "" || github.Description == "" || len(github.Fields) != 1 {
		t.Fatalf("github entry = %#v", github)
	}
	if github.Fields[0].Key != "token" || github.Fields[0].HelpURL == "" {
		t.Fatalf("github field = %#v", github.Fields[0])
	}
}

func TestAddMcpServerGitHubPublishesReferenceAndSecret(t *testing.T) {
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, nil)
	result, err := f.service.AddMcpServer(McpAddInput{
		CatalogID: "github",
		Name:      "github",
		Values:    map[string]string{"token": testMcpSecret},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.State == "" {
		t.Fatalf("result = %#v", result)
	}
	change := f.publish.lastChange()
	if change.BaseFingerprint != "fingerprint-mcp" {
		t.Fatalf("base fingerprint = %q", change.BaseFingerprint)
	}
	if change.Patch.McpServers == nil {
		t.Fatal("change has no mcpServers patch")
	}
	var servers []map[string]any
	if err := json.Unmarshal(*change.Patch.McpServers, &servers); err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 {
		t.Fatalf("servers = %#v", servers)
	}
	server := servers[0]
	if server["name"] != "github" || server["catalogId"] != "github" || server["approvalPolicy"] != "writes" {
		t.Fatalf("server = %#v", server)
	}
	headers, _ := server["headers"].(map[string]any)
	if headers["Authorization"] != "env:MCP_GITHUB_TOKEN" {
		t.Fatalf("headers = %#v", headers)
	}
	if len(change.Secrets) != 1 {
		t.Fatalf("secrets = %#v", change.Secrets)
	}
	secret := change.Secrets[0]
	if secret.Name != "MCP_GITHUB_TOKEN" || secret.Operation != domain.SecretReplace || secret.Value() != "Bearer "+testMcpSecret {
		t.Fatalf("secret = %#v", secret)
	}
}

func TestAddMcpServerRejectsDuplicateAndInvalidNames(t *testing.T) {
	existing := `[{"name":"github","url":"https://api.githubcopilot.com/mcp/"}]`
	f := newMcpFixture(t, existing, []string{"ADMIN_TOKEN"}, nil)
	_, err := f.service.AddMcpServer(McpAddInput{CatalogID: "github", Name: "github"})
	if err == nil || !strings.Contains(err.Error(), "已存在同名服务") {
		t.Fatalf("duplicate error = %v", err)
	}
	_, err = f.service.AddMcpServer(McpAddInput{CatalogID: "github", Name: "GitHub!"})
	if err == nil || !strings.Contains(err.Error(), "小写字母") {
		t.Fatalf("invalid name error = %v", err)
	}
	if len(f.publish.changes) != 0 {
		t.Fatalf("invalid add published %d changes", len(f.publish.changes))
	}
}

func TestAddCustomMcpServerStoresSecretHeader(t *testing.T) {
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, nil)
	_, err := f.service.AddMcpServer(McpAddInput{
		Name: "custom",
		Custom: &McpCustomInput{
			URL: "https://custom.example/mcp",
			Headers: []McpHeaderInput{
				{Name: "Authorization", Value: "Bearer " + testMcpSecret, Secret: true},
				{Name: "X-Plain", Value: "visible"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	change := f.publish.lastChange()
	var servers []map[string]any
	if err := json.Unmarshal(*change.Patch.McpServers, &servers); err != nil {
		t.Fatal(err)
	}
	headers, _ := servers[0]["headers"].(map[string]any)
	if headers["Authorization"] != "env:MCP_CUSTOM_AUTHORIZATION" || headers["X-Plain"] != "visible" {
		t.Fatalf("headers = %#v", headers)
	}
	if servers[0]["approvalPolicy"] != "writes" {
		t.Fatalf("server = %#v", servers[0])
	}
	if len(change.Secrets) != 1 || change.Secrets[0].Name != "MCP_CUSTOM_AUTHORIZATION" {
		t.Fatalf("secrets = %#v", change.Secrets)
	}
}

func TestAddMcpServerDoesNotLeakSecretValue(t *testing.T) {
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, nil)
	f.publish.applyErr = fmt.Errorf("provider rejected %s", testMcpSecret)
	_, err := f.service.AddMcpServer(McpAddInput{
		CatalogID: "github",
		Name:      "github",
		Values:    map[string]string{"token": testMcpSecret},
	})
	if err == nil {
		t.Fatal("expected publish error")
	}
	if strings.Contains(err.Error(), testMcpSecret) {
		t.Fatalf("error leaked secret: %v", err)
	}
}

func TestUpdateMcpServerReplacesOneEntry(t *testing.T) {
	existing := `[
		{"name":"github","url":"https://api.githubcopilot.com/mcp/","x-extra":1},
		{"name":"deepwiki","url":"https://mcp.deepwiki.com/mcp/"}
	]`
	f := newMcpFixture(t, existing, []string{"ADMIN_TOKEN"}, nil)
	replacement := json.RawMessage(`{"name":"deepwiki","url":"https://mcp.deepwiki.com/mcp/","autoApprove":["read_wiki"]}`)
	_, err := f.service.UpdateMcpServer("deepwiki", replacement, nil)
	if err != nil {
		t.Fatal(err)
	}
	change := f.publish.lastChange()
	var servers []map[string]any
	if err := json.Unmarshal(*change.Patch.McpServers, &servers); err != nil {
		t.Fatal(err)
	}
	if len(servers) != 2 || servers[0]["x-extra"] != float64(1) {
		t.Fatalf("servers = %#v", servers)
	}
	autoApprove, _ := servers[1]["autoApprove"].([]any)
	if len(autoApprove) != 1 || autoApprove[0] != "read_wiki" {
		t.Fatalf("replacement = %#v", servers[1])
	}
}

func TestUpdateMcpServerRejectsRenamedEntry(t *testing.T) {
	f := newMcpFixture(t, `[{"name":"github","url":"https://api.githubcopilot.com/mcp/"}]`, []string{"ADMIN_TOKEN"}, nil)
	_, err := f.service.UpdateMcpServer("github", json.RawMessage(`{"name":"renamed","url":"https://x.example/"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "名称必须与原名一致") {
		t.Fatalf("error = %v", err)
	}
}

func TestRemoveMcpServerDeletesOnlyOrphanedSecrets(t *testing.T) {
	existing := `[
		{"name":"old","url":"https://old.example/mcp?key={env:MCP_SHARED}","headers":{"Authorization":"env:MCP_OLD_TOKEN"}},
		{"name":"keep","url":"https://keep.example/mcp?key={env:MCP_SHARED}"}
	]`
	f := newMcpFixture(t, existing, []string{"ADMIN_TOKEN", "MCP_SHARED", "MCP_OLD_TOKEN"}, nil)
	_, err := f.service.RemoveMcpServer("old")
	if err != nil {
		t.Fatal(err)
	}
	change := f.publish.lastChange()
	if len(change.Secrets) != 1 {
		t.Fatalf("secrets = %#v", change.Secrets)
	}
	if change.Secrets[0].Name != "MCP_OLD_TOKEN" || change.Secrets[0].Operation != domain.SecretClear {
		t.Fatalf("secret = %#v", change.Secrets[0])
	}
	var servers []map[string]any
	if err := json.Unmarshal(*change.Patch.McpServers, &servers); err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 || servers[0]["name"] != "keep" {
		t.Fatalf("servers = %#v", servers)
	}
}

func TestRemoveOAuthMcpServerRevokesAfterPublish(t *testing.T) {
	var mu sync.Mutex
	var deleted []string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		deleted = append(deleted, r.Method+" "+r.URL.Path)
		mu.Unlock()
		if r.Method == http.MethodDelete && r.URL.Path == "/admin/mcp/oauth/notion" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.NotFound(w, r)
	})
	f := newMcpFixture(t, `[{"name":"notion","url":"https://mcp.notion.com/mcp","oauth":true}]`, []string{"ADMIN_TOKEN"}, handler)
	if _, err := f.service.RemoveMcpServer("notion"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(deleted) != 1 || deleted[0] != "DELETE /admin/mcp/oauth/notion" {
		t.Fatalf("revoke calls = %#v", deleted)
	}
}

func TestStartMcpOAuthOpensReturnedURL(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/admin/mcp/oauth/start" {
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://auth.example/authorize?state=1"})
			return
		}
		http.NotFound(w, r)
	})
	f := newMcpFixture(t, `[{"name":"notion","url":"https://mcp.notion.com/mcp","oauth":true}]`, []string{"ADMIN_TOKEN"}, handler)
	if err := f.service.StartMcpOAuth("notion"); err != nil {
		t.Fatal(err)
	}
	if len(f.browser.opened) != 1 || f.browser.opened[0] != "https://auth.example/authorize?state=1" {
		t.Fatalf("opened = %#v", f.browser.opened)
	}
}

func TestProbeMcpMapsWorkerProbe(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/admin/mcp/probe" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":    true,
				"tools": []map[string]string{{"name": "search", "description": "search", "mode": "auto"}},
			})
			return
		}
		http.NotFound(w, r)
	})
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
	probe, err := f.service.ProbeMcp("github")
	if err != nil {
		t.Fatal(err)
	}
	if !probe.OK || len(probe.Tools) != 1 || probe.Tools[0].Mode != "auto" {
		t.Fatalf("probe = %#v", probe)
	}
}

func TestMcpStatusMapsStates(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/admin/mcp/status" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"servers": []map[string]string{{"name": "notion", "state": "needs_reauth"}},
			})
			return
		}
		http.NotFound(w, r)
	})
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
	statuses, err := f.service.McpStatus()
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 1 || statuses[0].Name != "notion" || statuses[0].State != "needs_reauth" {
		t.Fatalf("statuses = %#v", statuses)
	}
}
