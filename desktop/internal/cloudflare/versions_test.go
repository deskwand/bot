package cloudflare_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/cloudflare/cloudflaretest"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

const (
	versionSecretSentinel = "version-SECRET-must-not-leak"
	versionBaseID         = "version-base"
)

func versionSettings() []byte {
	raw, _ := json.Marshal(map[string]any{
		"bindings": []any{
			map[string]any{"type": "durable_object_namespace", "name": "BUTLER", "class_name": "OldClass"},
			map[string]any{"type": "r2_bucket", "name": "ARTIFACTS", "bucket_name": "my-bucket"},
			map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": "https://bot.example"},
			map[string]any{"type": "plain_text", "name": "ACTIVE_CHANNEL", "text": "telegram"},
			map[string]any{"type": "plain_text", "name": "UNKNOWN_VAR", "text": "keep-me"},
			map[string]any{"type": "secret_text", "name": "KEEP"},
			map[string]any{"type": "secret_text", "name": "REPLACE"},
			map[string]any{"type": "secret_text", "name": "CLEAR"},
			map[string]any{"type": "json", "name": "EXTRA_CONFIG", "json": map[string]any{"keep": true}},
			map[string]any{"type": "ai", "name": "AI"},
		},
	})
	return raw
}

func versionManifest(t *testing.T) release.Manifest {
	t.Helper()
	return release.Manifest{
		ManifestVersion: 1,
		KeyID:           "test",
		Version:         "2.0.0",
		Entrypoint:      "index.js",
		CompressedSize:  10,
		Compatibility:   release.Compatibility{Date: "2026-11-01", Flags: []string{"nodejs_compat"}},
		ResourceTemplate: release.ResourceTemplate{
			SchemaVersion: 1,
			Entrypoint:    "index.js",
			Compatibility: release.Compatibility{Date: "2026-11-01", Flags: []string{"nodejs_compat"}},
			DurableObjects: []release.DOBinding{
				{Name: "BUTLER", ClassName: "ButlerDO"},
				{Name: "TASK", ClassName: "TaskDO"},
			},
			R2Buckets:       []release.R2Binding{{Name: "ARTIFACTS", ParameterKey: "r2BucketName"}},
			AIBindings:      []release.AIBinding{{Name: "AI"}},
			VersionMetadata: release.BindingRef{Name: "CF_VERSION_METADATA"},
			ConfigBinding:   release.ConfigBinding{Name: "DESKWAND_CONFIG", Type: "json", SchemaVersion: 1},
			SecretNames:     []string{"KEEP", "REPLACE", "CLEAR"},
			PlainVars:       []string{"ACTIVE_CHANNEL", "PUBLIC_BASE_URL"},
		},
	}
}

func versionBase() domain.Snapshot {
	return domain.Snapshot{
		Target:          domain.Target{AccountID: testAccountID, ScriptName: "worker-1"},
		VersionID:       versionBaseID,
		LatestVersionID: versionBaseID,
		SecretNames:     []string{"CLEAR", "KEEP", "REPLACE"},
		SettingsJSON:    versionSettings(),
		ConfigJSON:      []byte(`{"schemaVersion":1}`),
	}
}

type capturedVersionUpload struct {
	query    string
	metadata map[string]any
	parts    map[string][]byte
}

func versionServer(t *testing.T, latest string, uploads *[]capturedVersionUpload) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/versions"):
			writeResult(t, w, map[string]any{"items": []any{map[string]any{"id": latest}}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/versions"):
			mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
				t.Errorf("content type = %q: %v", r.Header.Get("Content-Type"), err)
			}
			reader := multipart.NewReader(r.Body, params["boundary"])
			upload := capturedVersionUpload{query: r.URL.RawQuery, parts: map[string][]byte{}}
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Errorf("read multipart: %v", err)
					break
				}
				data, _ := io.ReadAll(part)
				upload.parts[part.FormName()] = data
				if part.FormName() == "metadata" {
					if err := json.Unmarshal(data, &upload.metadata); err != nil {
						t.Errorf("decode metadata: %v", err)
					}
				}
			}
			*uploads = append(*uploads, upload)
			writeResult(t, w, map[string]any{"id": "version-new"})
		default:
			http.NotFound(w, r)
		}
	})
}

func TestCreateVersionBuildsPreservingMetadata(t *testing.T) {
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, versionBaseID, &uploads))

	manifestJSON, err := json.Marshal(versionManifest(t))
	if err != nil {
		t.Fatal(err)
	}
	plan := domain.PublishPlan{
		BaseVersionID: versionBaseID,
		ConfigJSON:    []byte(`{"schemaVersion":1,"owner":{"telegramUserIds":[]}}`),
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("REPLACE", domain.SecretReplace, versionSecretSentinel),
			domain.NewSecretEdit("CLEAR", domain.SecretClear, ""),
		},
	}
	modules := map[string][]byte{
		"index.js":        []byte("export default {};"),
		"chunks/extra.js": []byte("export const extra = 1;"),
	}

	id, err := client.CreateVersion(context.Background(), versionBase(), manifestJSON, modules, plan, cloudflare.PreservePolicy{
		SecretNames: []string{"KEEP"},
		OperationID: "op-123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if id != "version-new" {
		t.Fatalf("id = %q", id)
	}
	if len(uploads) != 1 {
		t.Fatalf("uploads = %d", len(uploads))
	}
	upload := uploads[0]
	if upload.query != "bindings_inherit=strict" {
		t.Fatalf("query = %q", upload.query)
	}
	if upload.metadata["main_module"] != "index.js" || upload.metadata["compatibility_date"] != "2026-11-01" {
		t.Fatalf("metadata = %#v", upload.metadata)
	}
	if _, ok := upload.metadata["migrations"]; ok {
		t.Fatal("version upload carried migrations")
	}
	annotations := upload.metadata["annotations"].(map[string]any)
	if annotations["workers/message"] != "DeskWand Bot publish op-123" || annotations["workers/tag"] != "2.0.0" {
		t.Fatalf("annotations = %#v", annotations)
	}

	bindings := upload.metadata["bindings"].([]any)
	byName := map[string]map[string]any{}
	var plainNames []string
	for _, raw := range bindings {
		binding := raw.(map[string]any)
		byName[binding["name"].(string)] = binding
		if binding["type"] == "plain_text" {
			plainNames = append(plainNames, binding["name"].(string))
		}
	}
	if byName["BUTLER"]["class_name"] != "ButlerDO" || byName["TASK"]["class_name"] != "TaskDO" {
		t.Fatalf("DO bindings = %#v", byName)
	}
	if byName["ARTIFACTS"]["bucket_name"] != "my-bucket" {
		t.Fatalf("R2 binding = %#v", byName["ARTIFACTS"])
	}
	if byName["AI"]["type"] != "ai" {
		t.Fatalf("AI binding = %#v", byName["AI"])
	}
	if byName["CF_VERSION_METADATA"]["type"] != "version_metadata" {
		t.Fatalf("version metadata binding = %#v", byName["CF_VERSION_METADATA"])
	}
	if byName["EXTRA_CONFIG"]["type"] != "json" {
		t.Fatalf("extra json binding was not preserved: %#v", byName["EXTRA_CONFIG"])
	}
	extraJSON, ok := byName["EXTRA_CONFIG"]["json"].(map[string]any)
	if !ok || extraJSON["keep"] != true {
		t.Fatalf("extra json binding value = %#v", byName["EXTRA_CONFIG"])
	}
	if !strings.Contains(string(upload.parts["metadata"]), `"owner":{"telegramUserIds":[]}`) {
		t.Fatalf("config binding = %#v", byName["DESKWAND_CONFIG"])
	}
	if byName["REPLACE"]["type"] != "secret_text" || byName["REPLACE"]["text"] != versionSecretSentinel {
		t.Fatalf("replaced secret = %#v", byName["REPLACE"])
	}
	if byName["KEEP"]["type"] != "inherit" {
		t.Fatalf("kept secret = %#v", byName["KEEP"])
	}
	if _, ok := byName["CLEAR"]; ok {
		t.Fatalf("cleared secret is still present: %#v", byName["CLEAR"])
	}
	for _, name := range []string{"PUBLIC_BASE_URL", "ACTIVE_CHANNEL", "UNKNOWN_VAR"} {
		if byName[name] == nil || byName[name]["type"] != "plain_text" {
			t.Fatalf("plain var %s = %#v", name, byName[name])
		}
	}
	if byName["ACTIVE_CHANNEL"]["text"] != "telegram" || byName["UNKNOWN_VAR"]["text"] != "keep-me" {
		t.Fatalf("plain vars were not preserved: %#v", plainNames)
	}
	if !bytes.Contains(upload.parts["chunks/extra.js"], []byte("extra")) || !bytes.Contains(upload.parts["index.js"], []byte("export")) {
		t.Fatalf("module parts = %#v", upload.parts)
	}
}

// settingsWithoutAI drops the AI binding an older deployment would not have,
// so the only way it can appear in the upload is the template rebuild.
func settingsWithoutAI(t *testing.T) []byte {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(versionSettings(), &document); err != nil {
		t.Fatal(err)
	}
	bindings := document["bindings"].([]any)
	kept := make([]any, 0, len(bindings))
	for _, raw := range bindings {
		if raw.(map[string]any)["type"] == "ai" {
			continue
		}
		kept = append(kept, raw)
	}
	document["bindings"] = kept
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestCreateVersionAddsAMissingAIBinding(t *testing.T) {
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, versionBaseID, &uploads))

	manifestJSON, err := json.Marshal(versionManifest(t))
	if err != nil {
		t.Fatal(err)
	}
	base := versionBase()
	base.SettingsJSON = settingsWithoutAI(t)

	if _, err := client.CreateVersion(
		context.Background(),
		base,
		manifestJSON,
		map[string][]byte{"index.js": []byte("export default {};")},
		domain.PublishPlan{BaseVersionID: versionBaseID, ConfigJSON: []byte(`{"schemaVersion":1}`)},
		cloudflare.PreservePolicy{SecretNames: []string{"KEEP"}, OperationID: "op-ai"},
	); err != nil {
		t.Fatal(err)
	}
	if len(uploads) != 1 {
		t.Fatalf("uploads = %d", len(uploads))
	}

	for _, raw := range uploads[0].metadata["bindings"].([]any) {
		binding := raw.(map[string]any)
		if binding["name"] == "AI" {
			if binding["type"] != "ai" {
				t.Fatalf("AI binding = %#v", binding)
			}
			return
		}
	}
	t.Fatalf("AI binding was not added: %#v", uploads[0].metadata["bindings"])
}

func TestCreateVersionAppliesPlainVarOverrides(t *testing.T) {
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, versionBaseID, &uploads))
	manifestJSON, _ := json.Marshal(versionManifest(t))

	_, err := client.CreateVersion(context.Background(), versionBase(), manifestJSON, map[string][]byte{"index.js": []byte("x")}, domain.PublishPlan{
		BaseVersionID: versionBaseID,
		ConfigJSON:    []byte(`{"schemaVersion":1}`),
		Vars:          map[string]string{"ACTIVE_CHANNEL": "wechat"},
	}, cloudflare.PreservePolicy{OperationID: "op-vars"})
	if err != nil {
		t.Fatal(err)
	}
	if len(uploads) != 1 {
		t.Fatalf("uploads = %d", len(uploads))
	}
	byName := map[string]map[string]any{}
	for _, raw := range uploads[0].metadata["bindings"].([]any) {
		binding := raw.(map[string]any)
		byName[binding["name"].(string)] = binding
	}
	if byName["ACTIVE_CHANNEL"]["text"] != "wechat" {
		t.Fatalf("ACTIVE_CHANNEL = %#v", byName["ACTIVE_CHANNEL"])
	}
	if byName["PUBLIC_BASE_URL"]["text"] != "https://bot.example" ||
		byName["UNKNOWN_VAR"]["text"] != "keep-me" {
		t.Fatalf("unrelated plain vars changed: %#v", byName)
	}
}

func TestCreateVersionRejectsVarOutsideTemplateAllowlist(t *testing.T) {
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, versionBaseID, &uploads))
	manifestJSON, _ := json.Marshal(versionManifest(t))

	_, err := client.CreateVersion(context.Background(), versionBase(), manifestJSON, map[string][]byte{"index.js": []byte("x")}, domain.PublishPlan{
		BaseVersionID: versionBaseID,
		ConfigJSON:    []byte(`{"schemaVersion":1}`),
		Vars:          map[string]string{"AUTH_BYPASS": "1"},
	}, cloudflare.PreservePolicy{OperationID: "op-vars"})
	assertDomainCode(t, err, domain.NOT_SENT)
	if len(uploads) != 0 {
		t.Fatalf("disallowed var still uploaded %d versions", len(uploads))
	}
}

func TestCreateVersionRefusesWhenLatestChanged(t *testing.T) {
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, "version-someone-else", &uploads))
	manifestJSON, _ := json.Marshal(versionManifest(t))

	_, err := client.CreateVersion(context.Background(), versionBase(), manifestJSON, map[string][]byte{"index.js": []byte("x")}, domain.PublishPlan{
		BaseVersionID: versionBaseID,
		ConfigJSON:    []byte(`{"schemaVersion":1}`),
	}, cloudflare.PreservePolicy{OperationID: "op-1"})
	assertDomainCode(t, err, domain.LATEST_NOT_BASE)
	if len(uploads) != 0 {
		t.Fatalf("LATEST_NOT_BASE still uploaded %d versions", len(uploads))
	}
}

func TestCreateVersionRefusesStaleSnapshotLatest(t *testing.T) {
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, versionBaseID, &uploads))
	manifestJSON, _ := json.Marshal(versionManifest(t))
	base := versionBase()
	base.LatestVersionID = "version-older"

	_, err := client.CreateVersion(context.Background(), base, manifestJSON, map[string][]byte{"index.js": []byte("x")}, domain.PublishPlan{
		BaseVersionID: versionBaseID,
		ConfigJSON:    []byte(`{"schemaVersion":1}`),
	}, cloudflare.PreservePolicy{OperationID: "op-1"})
	assertDomainCode(t, err, domain.LATEST_NOT_BASE)
	if len(uploads) != 0 {
		t.Fatalf("stale snapshot still uploaded %d versions", len(uploads))
	}
}

func TestCreateVersionRequiresOperationID(t *testing.T) {
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, versionBaseID, &uploads))
	manifestJSON, _ := json.Marshal(versionManifest(t))

	_, err := client.CreateVersion(context.Background(), versionBase(), manifestJSON, map[string][]byte{"index.js": []byte("x")}, domain.PublishPlan{
		BaseVersionID: versionBaseID,
		ConfigJSON:    []byte(`{"schemaVersion":1}`),
	}, cloudflare.PreservePolicy{})
	assertDomainCode(t, err, domain.NOT_SENT)
	if len(uploads) != 0 {
		t.Fatalf("missing operation id still uploaded %d versions", len(uploads))
	}
}

func TestCreateVersionRejectsExtraDurableObjectBinding(t *testing.T) {
	settings := map[string]any{
		"bindings": []any{
			map[string]any{"type": "durable_object_namespace", "name": "LEGACY", "class_name": "LegacyDO"},
			map[string]any{"type": "r2_bucket", "name": "ARTIFACTS", "bucket_name": "my-bucket"},
			map[string]any{"type": "version_metadata", "name": "CF_VERSION_METADATA"},
		},
	}
	settingsJSON, _ := json.Marshal(settings)
	base := versionBase()
	base.SettingsJSON = settingsJSON
	var uploads []capturedVersionUpload
	client, _ := cloudflaretest.NewServerClient(t, versionServer(t, versionBaseID, &uploads))
	manifestJSON, _ := json.Marshal(versionManifest(t))

	_, err := client.CreateVersion(context.Background(), base, manifestJSON, map[string][]byte{"index.js": []byte("x")}, domain.PublishPlan{
		BaseVersionID: versionBaseID,
		ConfigJSON:    []byte(`{"schemaVersion":1}`),
	}, cloudflare.PreservePolicy{OperationID: "op-3"})
	assertDomainCode(t, err, domain.UNSUPPORTED_BINDING)
	if len(uploads) != 0 {
		t.Fatalf("unsupported binding still uploaded %d versions", len(uploads))
	}
}

func TestFindVersionByOperationMatchesExactAnnotation(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/versions") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("per_page") != "20" {
			t.Errorf("per_page = %q", r.URL.Query().Get("per_page"))
		}
		writeResult(t, w, map[string]any{"items": []any{
			map[string]any{
				"id":          "version-other",
				"annotations": map[string]any{"workers/message": "DeskWand Bot publish op-other"},
			},
			map[string]any{
				"id":          "version-ours",
				"annotations": map[string]any{"workers/message": "DeskWand Bot publish op-123", "workers/tag": "2.0.0"},
			},
		}})
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	id, isLatest, found, err := client.FindVersionByOperation(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"}, "op-123")
	if err != nil {
		t.Fatal(err)
	}
	if !found || id != "version-ours" || isLatest {
		t.Fatalf("id/latest/found = %q/%v/%v", id, isLatest, found)
	}

	id, isLatest, found, err = client.FindVersionByOperation(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"}, "op-missing")
	if err != nil || found || id != "" || isLatest {
		t.Fatalf("missing = %q/%v/%v/%v", id, isLatest, found, err)
	}
}

func TestFindVersionByOperationReportsLatest(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeResult(t, w, map[string]any{"items": []any{
			map[string]any{"id": "version-ours", "annotations": map[string]any{"workers/message": "DeskWand Bot publish op-123"}},
		}})
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)
	id, isLatest, found, err := client.FindVersionByOperation(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"}, "op-123")
	if err != nil || !found || !isLatest || id != "version-ours" {
		t.Fatalf("id/latest/found/err = %q/%v/%v/%v", id, isLatest, found, err)
	}
}
