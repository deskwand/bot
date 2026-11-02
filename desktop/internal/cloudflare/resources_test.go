package cloudflare_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/cloudflare/cloudflaretest"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

const resourceAccountID = "0123456789abcdef0123456789abcdef"

func resourceManifest(t *testing.T) release.Manifest {
	t.Helper()
	compatibility := release.Compatibility{Date: "2026-11-01", Flags: []string{"nodejs_compat"}}
	migrations := []release.Migration{
		{Tag: "v1", NewSQLiteClasses: []string{"ButlerDO", "TaskDO"}},
		{Tag: "v2", NewSQLiteClasses: []string{"ChannelDO"}},
	}
	return release.Manifest{
		ManifestVersion:     1,
		KeyID:               "test-key",
		Version:             "1.0.0",
		Entrypoint:          "index.js",
		CompressedSize:      10,
		ConfigSchemaVersion: 1,
		Compatibility:       compatibility,
		ResourceTemplate: release.ResourceTemplate{
			SchemaVersion:   1,
			Entrypoint:      "index.js",
			Compatibility:   compatibility,
			DurableObjects:  []release.DOBinding{{Name: "BUTLER", ClassName: "ButlerDO"}, {Name: "TASK", ClassName: "TaskDO"}, {Name: "CHANNELS", ClassName: "ChannelDO"}},
			R2Buckets:       []release.R2Binding{{Name: "ARTIFACTS", ParameterKey: "r2BucketName"}},
			VersionMetadata: release.BindingRef{Name: "CF_VERSION_METADATA"},
			ConfigBinding:   release.ConfigBinding{Name: "DESKWAND_CONFIG", Type: "json", SchemaVersion: 1},
			SecretNames:     []string{"WECHAT_CREDENTIALS"},
			PlainVars:       []string{"ACTIVE_CHANNEL", "PUBLIC_BASE_URL"},
			Crons:           []string{"*/5 * * * *"},
			Vars:            []release.VarBinding{{Name: "PUBLIC_BASE_URL", ParameterKey: "PUBLIC_BASE_URL"}},
			Migrations:      migrations,
			InstallParams: []release.InstallParameter{
				{Key: "workerName", Source: "user"},
				{Key: "r2BucketName", Source: "user"},
				{Key: "PUBLIC_BASE_URL", Source: "user"},
				{Key: "owner", Source: "DESKWAND_CONFIG"},
			},
		},
		Migrations: migrations,
		Upgrade:    release.Upgrade{MinFromVersion: "1.0.0", IrreversibleMigrations: []string{}},
	}
}

type uploadedScript struct {
	metadata map[string]any
	modules  map[string]string
}

func uploadScriptHandler(t *testing.T, captured *uploadedScript) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/client/v4/accounts/"+resourceAccountID+"/workers/scripts/deskwand-bot" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		reader, err := r.MultipartReader()
		if err != nil {
			t.Fatalf("multipart reader: %v", err)
		}
		captured.modules = map[string]string{}
		for {
			part, err := reader.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Fatalf("next part: %v", err)
			}
			data, err := io.ReadAll(part)
			if err != nil {
				t.Fatalf("read part: %v", err)
			}
			if part.FormName() == "metadata" {
				decoder := json.NewDecoder(strings.NewReader(string(data)))
				decoder.UseNumber()
				if err := decoder.Decode(&captured.metadata); err != nil {
					t.Fatalf("decode metadata: %v", err)
				}
				continue
			}
			captured.modules[part.FormName()] = string(data)
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{"id":"script-1","migration_tag":"v2"}}`)
	})
}

func TestUploadScriptFirstInstallMetadata(t *testing.T) {
	var captured uploadedScript
	client, _ := cloudflaretest.NewServerClient(t, uploadScriptHandler(t, &captured))
	manifest := resourceManifest(t)
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	config := json.RawMessage(`{"schemaVersion":1,"owner":{"telegramUserIds":[]},"models":{"butler":{"provider":"opencode-go","id":"m"},"task":{"provider":"opencode-go","id":"m"}},"mcpServers":[]}`)
	result, err := client.UploadScript(context.Background(), domain.Target{AccountID: resourceAccountID, ScriptName: "deskwand-bot"}, manifestJSON, map[string][]byte{
		"index.js": []byte("export default {};\n"),
	}, cloudflare.ScriptUploadPlan{
		ConfigJSON: config,
		BucketName: "deskwand-probe-bucket",
		PlainVars: map[string]string{
			"ACTIVE_CHANNEL":  "telegram",
			"PUBLIC_BASE_URL": "https://deskwand-bot.example.workers.dev",
		},
		Message: "DeskWand Bot install op-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ScriptID != "script-1" || result.MigrationTag != "v2" {
		t.Fatalf("result = %#v", result)
	}

	expected := map[string]any{
		"main_module":         "index.js",
		"compatibility_date":  "2026-11-01",
		"compatibility_flags": []any{"nodejs_compat"},
		"keep_bindings":       []any{"secret_text"},
		"bindings": []any{
			map[string]any{"type": "durable_object_namespace", "name": "BUTLER", "class_name": "ButlerDO"},
			map[string]any{"type": "durable_object_namespace", "name": "TASK", "class_name": "TaskDO"},
			map[string]any{"type": "durable_object_namespace", "name": "CHANNELS", "class_name": "ChannelDO"},
			map[string]any{"type": "r2_bucket", "name": "ARTIFACTS", "bucket_name": "deskwand-probe-bucket"},
			map[string]any{"type": "version_metadata", "name": "CF_VERSION_METADATA"},
			map[string]any{"type": "json", "name": "DESKWAND_CONFIG", "json": map[string]any{
				"schemaVersion": json.Number("1"),
				"owner":         map[string]any{"telegramUserIds": []any{}},
				"models": map[string]any{
					"butler": map[string]any{"provider": "opencode-go", "id": "m"},
					"task":   map[string]any{"provider": "opencode-go", "id": "m"},
				},
				"mcpServers": []any{},
			}},
			map[string]any{"type": "plain_text", "name": "ACTIVE_CHANNEL", "text": "telegram"},
			map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": "https://deskwand-bot.example.workers.dev"},
		},
		"migrations": map[string]any{
			"new_tag": "v2",
			"steps": []any{
				map[string]any{"new_sqlite_classes": []any{"ButlerDO", "TaskDO"}},
				map[string]any{"new_sqlite_classes": []any{"ChannelDO"}},
			},
		},
		"annotations": map[string]any{
			"workers/tag":     "1.0.0",
			"workers/message": "DeskWand Bot install op-1",
		},
	}
	if !reflect.DeepEqual(captured.metadata, expected) {
		t.Fatalf("metadata mismatch\n got: %#v\nwant: %#v", captured.metadata, expected)
	}
	if captured.modules["index.js"] != "export default {};\n" {
		t.Fatalf("modules = %#v", captured.modules)
	}
}

func TestUploadScriptUpgradeMetadataUsesSingleStep(t *testing.T) {
	var captured uploadedScript
	client, _ := cloudflaretest.NewServerClient(t, uploadScriptHandler(t, &captured))
	manifest := resourceManifest(t)
	manifestJSON, _ := json.Marshal(manifest)

	_, err := client.UploadScript(context.Background(), domain.Target{AccountID: resourceAccountID, ScriptName: "deskwand-bot"}, manifestJSON, map[string][]byte{"index.js": []byte("x")}, cloudflare.ScriptUploadPlan{
		ConfigJSON: json.RawMessage(`{"schemaVersion":1}`),
		BucketName: "deskwand-probe-bucket",
		PlainVars:  map[string]string{"ACTIVE_CHANNEL": "wechat"},
		BaseTag:    "v1",
		Message:    "upgrade",
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{
		"old_tag":            "v1",
		"new_tag":            "v2",
		"new_sqlite_classes": []any{"ChannelDO"},
	}
	if !reflect.DeepEqual(captured.metadata["migrations"], expected) {
		t.Fatalf("migrations = %#v", captured.metadata["migrations"])
	}
}

func TestUploadScriptOmitsMigrationsWhenLiveTagIsLatest(t *testing.T) {
	var captured uploadedScript
	client, _ := cloudflaretest.NewServerClient(t, uploadScriptHandler(t, &captured))
	manifest := resourceManifest(t)
	manifestJSON, _ := json.Marshal(manifest)
	_, err := client.UploadScript(context.Background(), domain.Target{AccountID: resourceAccountID, ScriptName: "deskwand-bot"}, manifestJSON, map[string][]byte{"index.js": []byte("x")}, cloudflare.ScriptUploadPlan{
		ConfigJSON: json.RawMessage(`{"schemaVersion":1}`),
		BucketName: "deskwand-probe-bucket",
		PlainVars:  map[string]string{"ACTIVE_CHANNEL": "wechat"},
		BaseTag:    "v2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := captured.metadata["migrations"]; ok {
		t.Fatalf("metadata = %#v, want no migrations", captured.metadata)
	}
}

func TestUploadScriptRejectsUnknownLiveTagBeforeRequest(t *testing.T) {
	called := false
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	manifest := resourceManifest(t)
	manifestJSON, _ := json.Marshal(manifest)
	_, err := client.UploadScript(context.Background(), domain.Target{AccountID: resourceAccountID, ScriptName: "deskwand-bot"}, manifestJSON, map[string][]byte{"index.js": []byte("x")}, cloudflare.ScriptUploadPlan{
		ConfigJSON: json.RawMessage(`{"schemaVersion":1}`),
		BucketName: "deskwand-probe-bucket",
		BaseTag:    "v9",
	})
	if err == nil {
		t.Fatal("unknown live migration tag was accepted")
	}
	if !strings.Contains(err.Error(), "MIGRATION_HISTORY_MISMATCH") {
		t.Fatalf("error = %v", err)
	}
	if called {
		t.Fatal("invalid migration history made a request")
	}
}

func TestUploadScriptRejectsInvalidBucketNameBeforeRequest(t *testing.T) {
	called := false
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	manifest := resourceManifest(t)
	manifestJSON, _ := json.Marshal(manifest)
	_, err := client.UploadScript(context.Background(), domain.Target{AccountID: resourceAccountID, ScriptName: "deskwand-bot"}, manifestJSON, map[string][]byte{"index.js": []byte("x")}, cloudflare.ScriptUploadPlan{
		ConfigJSON: json.RawMessage(`{"schemaVersion":1}`),
		BucketName: "Bad Bucket",
	})
	if err == nil || called {
		t.Fatalf("err=%v called=%v", err, called)
	}
}

func TestWorkersSubdomain(t *testing.T) {
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/client/v4/accounts/"+resourceAccountID+"/workers/subdomain" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{"subdomain":"example-sub"}}`)
	}))
	subdomain, err := client.WorkersSubdomain(context.Background(), resourceAccountID)
	if err != nil {
		t.Fatal(err)
	}
	if subdomain != "example-sub" {
		t.Fatalf("subdomain = %q", subdomain)
	}
}

func TestEnableWorkersDev(t *testing.T) {
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/client/v4/accounts/"+resourceAccountID+"/workers/scripts/deskwand-bot/subdomain" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(body, map[string]any{"enabled": true}) {
			t.Errorf("body = %#v", body)
		}
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{}}`)
	}))
	if err := client.EnableWorkersDev(context.Background(), domain.Target{AccountID: resourceAccountID, ScriptName: "deskwand-bot"}); err != nil {
		t.Fatal(err)
	}
}

func TestCreateR2BucketMapsAlreadyExists(t *testing.T) {
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/client/v4/accounts/"+resourceAccountID+"/r2/buckets" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["name"] != "deskwand-probe-bucket" {
			t.Errorf("body = %#v", body)
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"success":false,"errors":[{"code":10006,"message":"bucket already exists"}],"result":null}`)
	}))
	err := client.CreateR2Bucket(context.Background(), resourceAccountID, "deskwand-probe-bucket")
	if !errors.Is(err, cloudflare.ErrAlreadyExists) {
		t.Fatalf("error = %v, want ErrAlreadyExists", err)
	}
}

func TestGetR2BucketMapsNotFound(t *testing.T) {
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"success":false,"errors":[{"code":10006,"message":"not found"}],"result":null}`)
	}))
	_, err := client.GetR2Bucket(context.Background(), resourceAccountID, "deskwand-probe-bucket")
	if !errors.Is(err, cloudflare.ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
}

func TestPutAndGetSchedules(t *testing.T) {
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			var body []map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(body, []map[string]any{{"cron": "*/5 * * * *"}}) {
				t.Errorf("body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{"schedules":[{"cron":"*/5 * * * *"}]}}`)
		case http.MethodGet:
			_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{"schedules":[{"cron":"*/5 * * * *"}]}}`)
		default:
			t.Errorf("method = %s", r.Method)
		}
	}))
	target := domain.Target{AccountID: resourceAccountID, ScriptName: "deskwand-bot"}
	if err := client.PutSchedules(context.Background(), target, []string{"*/5 * * * *"}); err != nil {
		t.Fatal(err)
	}
	crons, err := client.GetSchedules(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(crons, []string{"*/5 * * * *"}) {
		t.Fatalf("crons = %#v", crons)
	}
}
