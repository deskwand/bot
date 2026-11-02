package cloudflare_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/cloudflare/cloudflaretest"
	"github.com/deskwand/bot/desktop/internal/domain"
)

const (
	snapshotSecretSentinel = "snapshot-SECRET-value-must-not-appear"
	testAccountID          = "0123456789abcdef0123456789abcdef"
)

func writeResult(t *testing.T, w http.ResponseWriter, result any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"success": true,
		"errors":  []any{},
		"result":  result,
	})
	if err != nil {
		t.Fatalf("encode fixture response: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(payload)
}

func fixtureClient(t *testing.T, settings, deployments, versions any) *cloudflare.Client {
	t.Helper()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/settings"):
			writeResult(t, w, settings)
		case strings.HasSuffix(r.URL.Path, "/deployments"):
			writeResult(t, w, deployments)
		case strings.HasSuffix(r.URL.Path, "/versions"):
			writeResult(t, w, versions)
		default:
			http.NotFound(w, r)
		}
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)
	return client
}

func baseSettings() map[string]any {
	return map[string]any{
		"bindings": []any{
			map[string]any{"type": "durable_object_namespace", "name": "BUTLER", "class_name": "ButlerDO"},
			map[string]any{"type": "r2_bucket", "name": "ARTIFACTS", "bucket_name": "bucket"},
			map[string]any{"type": "version_metadata", "name": "CF_VERSION_METADATA"},
			map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": "https://example.com"},
			map[string]any{"type": "json", "name": "DESKWAND_CONFIG", "json": map[string]any{
				"schemaVersion": 1,
				"owner":         map[string]any{"telegramUserIds": []any{}},
				"models": map[string]any{
					"butler": map[string]any{"provider": "opencode-go", "id": "model-b"},
					"task":   map[string]any{"provider": "opencode-go", "id": "model-t"},
				},
				"mcpServers": []any{},
				"advanced":   map[string]any{"retryLimit": 3},
			}},
			map[string]any{"type": "secret_text", "name": "WECHAT_CREDENTIALS", "text": snapshotSecretSentinel},
			map[string]any{"type": "secret_text", "name": "ANTHROPIC_API_KEY"},
		},
		"compatibility_date": "2026-11-01",
		"annotations":        map[string]any{"workers/tag": "1.2.3", "workers/message": "deploy"},
		"limits":             map[string]any{"cpu_ms": 50},
		"advanced":           map[string]any{"unknown": true},
	}
}

func baseDeployments(versions ...map[string]any) map[string]any {
	return map[string]any{
		"deployments": []any{
			map[string]any{"id": "deployment-1", "versions": versions},
		},
	}
}

func activeVersion(id string, percentage float64) map[string]any {
	return map[string]any{"version_id": id, "percentage": percentage}
}

func baseVersions(latest string) map[string]any {
	return map[string]any{"items": []any{map[string]any{"id": latest, "number": 7}}}
}

func TestReadSnapshotSingleVersion(t *testing.T) {
	client := fixtureClient(t, baseSettings(), baseDeployments(activeVersion("version-100", 100)), baseVersions("version-100"))
	target := domain.Target{AccountID: testAccountID, ScriptName: "worker-1"}

	snapshot, err := client.ReadSnapshot(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Target != target {
		t.Fatalf("target = %#v", snapshot.Target)
	}
	if snapshot.DeploymentID != "deployment-1" || snapshot.VersionID != "version-100" {
		t.Fatalf("deployment/version = %q/%q", snapshot.DeploymentID, snapshot.VersionID)
	}
	if snapshot.LatestVersionID != "version-100" {
		t.Fatalf("LatestVersionID = %q", snapshot.LatestVersionID)
	}
	if snapshot.ActiveVersionCount != 1 {
		t.Fatalf("ActiveVersionCount = %d", snapshot.ActiveVersionCount)
	}
	if snapshot.ReleaseVersion != "1.2.3" {
		t.Fatalf("ReleaseVersion = %q", snapshot.ReleaseVersion)
	}
	if len(snapshot.SecretNames) != 2 || snapshot.SecretNames[0] != "ANTHROPIC_API_KEY" || snapshot.SecretNames[1] != "WECHAT_CREDENTIALS" {
		t.Fatalf("SecretNames = %#v", snapshot.SecretNames)
	}

	wantConfig := `{"advanced":{"retryLimit":3},"mcpServers":[],"models":{"butler":{"id":"model-b","provider":"opencode-go"},"task":{"id":"model-t","provider":"opencode-go"}},"owner":{"telegramUserIds":[]},"schemaVersion":1}`
	if string(snapshot.ConfigJSON) != wantConfig {
		t.Fatalf("ConfigJSON = %s\nwant %s", snapshot.ConfigJSON, wantConfig)
	}

	settingsText := string(snapshot.SettingsJSON)
	if strings.Contains(settingsText, snapshotSecretSentinel) {
		t.Fatalf("SettingsJSON leaked a secret value: %s", settingsText)
	}
	if !strings.Contains(settingsText, `"WECHAT_CREDENTIALS"`) || !strings.Contains(settingsText, `"advanced":{"unknown":true}`) {
		t.Fatalf("SettingsJSON did not preserve names or advanced fields: %s", settingsText)
	}
	var reduced struct {
		Bindings []map[string]any `json:"bindings"`
	}
	if err := json.Unmarshal(snapshot.SettingsJSON, &reduced); err != nil {
		t.Fatal(err)
	}
	for _, binding := range reduced.Bindings {
		if binding["type"] == "secret_text" {
			if _, ok := binding["text"]; ok {
				t.Fatalf("secret binding kept a text field: %#v", binding)
			}
		}
	}
	if snapshot.Fingerprint == "" {
		t.Fatal("fingerprint is empty")
	}
}

func TestReadSnapshotRejectsMultipleActiveVersions(t *testing.T) {
	client := fixtureClient(t,
		baseSettings(),
		baseDeployments(activeVersion("v1", 50), activeVersion("v2", 50)),
		baseVersions("v2"),
	)

	_, err := client.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "w"})
	assertDomainCode(t, err, domain.MULTI_VERSION_DEPLOYMENT)
}

func TestReadSnapshotRejectsUnknownBinding(t *testing.T) {
	settings := baseSettings()
	settings["bindings"] = append(settings["bindings"].([]any), map[string]any{"type": "kv_namespace", "name": "LEGACY_KV"})
	client := fixtureClient(t, settings, baseDeployments(activeVersion("v1", 100)), baseVersions("v1"))

	_, err := client.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "w"})
	assertDomainCode(t, err, domain.UNSUPPORTED_BINDING)
	if !strings.Contains(err.Error(), "LEGACY_KV") {
		t.Fatalf("error does not name the binding: %v", err)
	}
}

func TestReadSnapshotMissingConfigBinding(t *testing.T) {
	settings := baseSettings()
	settings["bindings"] = settings["bindings"].([]any)[:4]
	client := fixtureClient(t, settings, baseDeployments(activeVersion("v1", 100)), baseVersions("v1"))

	snapshot, err := client.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "w"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ConfigJSON != nil {
		t.Fatalf("ConfigJSON = %s, want nil", snapshot.ConfigJSON)
	}
}

func TestReadSnapshotIgnoresUnrelatedSecretText(t *testing.T) {
	settings := map[string]any{
		"bindings": []any{
			map[string]any{"type": "secret_text", "name": "TELEGRAM_BOT_TOKEN"},
		},
	}
	client := fixtureClient(t, settings, baseDeployments(activeVersion("v1", 100)), baseVersions("v99"))

	snapshot, err := client.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "w"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.LatestVersionID != "v99" {
		t.Fatalf("LatestVersionID = %q", snapshot.LatestVersionID)
	}
	if snapshot.ConfigJSON != nil {
		t.Fatalf("ConfigJSON = %s, want nil", snapshot.ConfigJSON)
	}
}

func TestFingerprintIgnoresVolatileFieldsAndKeyOrder(t *testing.T) {
	settingsA := baseSettings()
	settingsB := map[string]any{
		"annotations":        map[string]any{"workers/message": "deploy", "workers/tag": "1.2.3"},
		"limits":             map[string]any{"cpu_ms": 50},
		"advanced":           map[string]any{"unknown": true},
		"last_analyzed_at":   "2026-11-02T00:00:00Z",
		"compatibility_date": "2026-11-01",
		"bindings": []any{
			map[string]any{"type": "secret_text", "name": "ANTHROPIC_API_KEY"},
			map[string]any{"type": "secret_text", "name": "WECHAT_CREDENTIALS", "text": snapshotSecretSentinel},
			map[string]any{"type": "json", "name": "DESKWAND_CONFIG", "json": map[string]any{
				"schemaVersion": 1,
				"owner":         map[string]any{"telegramUserIds": []any{}},
				"models": map[string]any{
					"task":   map[string]any{"provider": "opencode-go", "id": "model-t"},
					"butler": map[string]any{"provider": "opencode-go", "id": "model-b"},
				},
				"mcpServers": []any{},
				"advanced":   map[string]any{"retryLimit": 3},
			}},
			map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": "https://example.com"},
			map[string]any{"type": "version_metadata", "name": "CF_VERSION_METADATA"},
			map[string]any{"type": "r2_bucket", "name": "ARTIFACTS", "bucket_name": "bucket"},
			map[string]any{"type": "durable_object_namespace", "name": "BUTLER", "class_name": "ButlerDO"},
		},
	}

	clientA := fixtureClient(t, settingsA, baseDeployments(activeVersion("v1", 100)), baseVersions("v1"))
	clientB := fixtureClient(t, settingsB, baseDeployments(activeVersion("v1", 100)), baseVersions("v1"))

	snapshotA, err := clientA.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "w"})
	if err != nil {
		t.Fatal(err)
	}
	snapshotB, err := clientB.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "w"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshotA.Fingerprint != snapshotB.Fingerprint {
		t.Fatalf("fingerprint changed with key order or a volatile field:\n%s\n%s", snapshotA.Fingerprint, snapshotB.Fingerprint)
	}

	clientC := fixtureClient(t, settingsA, baseDeployments(activeVersion("v1", 100)), baseVersions("v2"))
	snapshotC, err := clientC.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "w"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshotC.Fingerprint == snapshotA.Fingerprint {
		t.Fatal("fingerprint ignored the latest uploaded version")
	}
}

func assertDomainCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got nil", code)
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) {
		t.Fatalf("error %v is not a domain.Error", err)
	}
	if domainErr.Code != code {
		t.Fatalf("error code = %s, want %s (%v)", domainErr.Code, code, err)
	}
}

func readFingerprint(t *testing.T, settings, deployments, versions any) string {
	t.Helper()
	client := fixtureClient(t, settings, deployments, versions)
	snapshot, err := client.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot.Fingerprint
}

func TestFingerprintIgnoresPlacementLastAnalyzedAt(t *testing.T) {
	settingsA := baseSettings()
	settingsA["placement"] = map[string]any{"mode": "smart", "last_analyzed_at": "2026-11-02T00:00:00Z"}
	settingsB := baseSettings()
	settingsB["placement"] = map[string]any{"mode": "smart", "last_analyzed_at": "2026-11-03T12:34:56Z"}

	fingerprintA := readFingerprint(t, settingsA, baseDeployments(activeVersion("v1", 100)), baseVersions("v1"))
	fingerprintB := readFingerprint(t, settingsB, baseDeployments(activeVersion("v1", 100)), baseVersions("v1"))
	if fingerprintA != fingerprintB {
		t.Fatalf("placement.last_analyzed_at changed the fingerprint:\n%s\n%s", fingerprintA, fingerprintB)
	}
}

func TestFingerprintSensitivity(t *testing.T) {
	base := func() (map[string]any, map[string]any, map[string]any) {
		return baseSettings(), baseDeployments(activeVersion("v1", 100)), baseVersions("v1")
	}
	baseFingerprint := func() string {
		settings, deployments, versions := base()
		return readFingerprint(t, settings, deployments, versions)
	}()

	findBinding := func(settings map[string]any, name string) map[string]any {
		for _, item := range settings["bindings"].([]any) {
			binding := item.(map[string]any)
			if binding["name"] == name {
				return binding
			}
		}
		t.Fatalf("binding %q not found", name)
		return nil
	}

	tests := []struct {
		name string
		run  func() string
	}{
		{
			name: "plain_text var value edited",
			run: func() string {
				settings, deployments, versions := base()
				findBinding(settings, "PUBLIC_BASE_URL")["text"] = "https://changed.example"
				return readFingerprint(t, settings, deployments, versions)
			},
		},
		{
			name: "binding added",
			run: func() string {
				settings, deployments, versions := base()
				settings["bindings"] = append(settings["bindings"].([]any), map[string]any{
					"type": "plain_text", "name": "NEW_VAR", "text": "value",
				})
				return readFingerprint(t, settings, deployments, versions)
			},
		},
		{
			name: "DESKWAND_CONFIG body changed",
			run: func() string {
				settings, deployments, versions := base()
				config := findBinding(settings, "DESKWAND_CONFIG")["json"].(map[string]any)
				models := config["models"].(map[string]any)
				models["butler"].(map[string]any)["id"] = "different-model"
				return readFingerprint(t, settings, deployments, versions)
			},
		},
		{
			name: "secret name added",
			run: func() string {
				settings, deployments, versions := base()
				settings["bindings"] = append(settings["bindings"].([]any), map[string]any{
					"type": "secret_text", "name": "DEEPSEEK_API_KEY",
				})
				return readFingerprint(t, settings, deployments, versions)
			},
		},
		{
			name: "deployment id changed",
			run: func() string {
				settings, _, versions := base()
				deployments := map[string]any{"deployments": []any{
					map[string]any{"id": "deployment-2", "versions": []any{activeVersion("v1", 100)}},
				}}
				return readFingerprint(t, settings, deployments, versions)
			},
		},
		{
			name: "version percentage changed",
			run: func() string {
				settings, _, versions := base()
				return readFingerprint(t, settings, baseDeployments(activeVersion("v1", 99)), versions)
			},
		},
		{
			name: "latest version changed",
			run: func() string {
				settings, deployments, _ := base()
				return readFingerprint(t, settings, deployments, baseVersions("v2"))
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := testCase.run(); got == baseFingerprint {
				t.Fatalf("%s did not change the fingerprint", testCase.name)
			}
		})
	}
}

func TestReadSnapshotRejectsInvalidTargetWithoutRequests(t *testing.T) {
	var calls int
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.NotFound(w, r)
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	targets := []domain.Target{
		{AccountID: "not-hex", ScriptName: "worker-1"},
		{AccountID: testAccountID, ScriptName: "Bad Name"},
		{AccountID: testAccountID, ScriptName: "../escape"},
	}
	for _, target := range targets {
		if _, err := client.ReadSnapshot(context.Background(), target); err == nil {
			t.Errorf("invalid target %#v accepted", target)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid targets made %d requests", calls)
	}
}

func TestReadSnapshotToleratesNonStringAnnotations(t *testing.T) {
	settings := baseSettings()
	settings["annotations"] = map[string]any{"workers/tag": 42, "workers/message": "deploy"}
	client := fixtureClient(t, settings, baseDeployments(activeVersion("v1", 100)), baseVersions("v1"))
	snapshot, err := client.ReadSnapshot(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ReleaseVersion != "" {
		t.Fatalf("ReleaseVersion = %q, want empty for a non-string tag", snapshot.ReleaseVersion)
	}
}
