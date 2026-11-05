package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const mergeSecretSentinel = "merge-SENTINEL-secret-never-export"

const baseConfigDocument = `{"schemaVersion":1,"owner":{"telegramUserIds":[42]},"models":{"butler":{"provider":"opencode-go","id":"deepseek-v4.1-flash"},"task":{"provider":"opencode-go","id":"kimi-k3"}},"mcpServers":[{"name":"notion","url":"https://mcp.example.com","headers":{"Authorization":"env:MCP_TOKEN"}}],"advanced":{"retryLimit":3}}`

func canonicalBaseDocument(t *testing.T) []byte {
	t.Helper()
	canonical, err := domain.CanonicalizeJSON([]byte(baseConfigDocument))
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

func baseSnapshot(t *testing.T) domain.Snapshot {
	t.Helper()
	return domain.Snapshot{
		Target:       domain.Target{AccountID: "account", ScriptName: "worker"},
		DeploymentID: "deployment",
		VersionID:    "version-1",
		ConfigJSON:   canonicalBaseDocument(t),
		SecretNames:  []string{"TELEGRAM_BOT_TOKEN"},
		Fingerprint:  "current-fingerprint",
	}
}

func rawModel(t *testing.T, value string) *json.RawMessage {
	t.Helper()
	raw := json.RawMessage(value)
	if !json.Valid(raw) {
		t.Fatalf("invalid model fixture: %s", value)
	}
	return &raw
}

func TestRejectStaleDraft(t *testing.T) {
	base := domain.Snapshot{Fingerprint: "new"}
	_, err := Merge(base, domain.Change{BaseFingerprint: "old"})
	if err == nil {
		t.Fatal("stale draft overwrote current settings")
	}
	assertMergeCode(t, err, domain.CONFIG_CONFLICT)
}

func TestMergeEmptyPatchIsCanonicalAndLossless(t *testing.T) {
	base := baseSnapshot(t)
	plan, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(plan.ConfigJSON, base.ConfigJSON) {
		t.Fatalf("all-nil patch changed the document:\n got %s\nwant %s", plan.ConfigJSON, base.ConfigJSON)
	}
	if plan.BaseVersionID != base.VersionID {
		t.Fatalf("BaseVersionID = %q, want %q", plan.BaseVersionID, base.VersionID)
	}

	var document map[string]any
	if err := json.Unmarshal(plan.ConfigJSON, &document); err != nil {
		t.Fatal(err)
	}
	advanced, ok := document["advanced"].(map[string]any)
	if !ok || advanced["retryLimit"] != float64(3) {
		t.Fatalf("unknown advanced field was dropped: %#v", document["advanced"])
	}
	servers, ok := document["mcpServers"].([]any)
	if !ok || len(servers) != 1 {
		t.Fatalf("MCP servers were not preserved: %#v", document["mcpServers"])
	}
}

func TestMergeAppliesOwnerPatchAndPreservesUnknownFields(t *testing.T) {
	base := baseSnapshot(t)
	ids := []int64{7, 9007199254740991}
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{TelegramUserIDs: &ids},
	})
	if err != nil {
		t.Fatal(err)
	}

	var document struct {
		Owner struct {
			TelegramUserIDs []int64 `json:"telegramUserIds"`
		} `json:"owner"`
		Models  map[string]json.RawMessage `json:"models"`
		Advance map[string]any             `json:"advanced"`
	}
	if err := json.Unmarshal(plan.ConfigJSON, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Owner.TelegramUserIDs) != 2 || document.Owner.TelegramUserIDs[0] != 7 || document.Owner.TelegramUserIDs[1] != 9007199254740991 {
		t.Fatalf("owner patch = %#v", document.Owner.TelegramUserIDs)
	}
	if document.Advance["retryLimit"] != float64(3) {
		t.Fatalf("advanced field dropped: %#v", document.Advance)
	}
	if _, ok := document.Models["butler"]; !ok {
		t.Fatal("untouched model was dropped")
	}
}

func TestMergeRejectsVariableOutsideTemplatePlainVars(t *testing.T) {
	base := baseSnapshot(t)
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Vars:            map[string]string{"AUTH_BYPASS": "1"},
	})
	assertMergeCode(t, err, domain.INVALID_VAR)
}

func TestMergeRejectsVariableBoundAsNonPlainText(t *testing.T) {
	base := baseSnapshot(t)
	settings, _ := json.Marshal(map[string]any{
		"bindings": []any{
			map[string]any{"type": "secret_text", "name": "ACTIVE_CHANNEL"},
		},
	})
	base.SettingsJSON = settings
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Vars:            map[string]string{"ACTIVE_CHANNEL": "wechat"},
	})
	assertMergeCode(t, err, domain.INVALID_VAR)
}

func TestMergeAcceptsDeclaredPlainVariable(t *testing.T) {
	base := baseSnapshot(t)
	settings, _ := json.Marshal(map[string]any{
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "ACTIVE_CHANNEL", "text": "telegram"},
		},
	})
	base.SettingsJSON = settings
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Vars:            map[string]string{"ACTIVE_CHANNEL": "wechat"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Vars["ACTIVE_CHANNEL"] != "wechat" {
		t.Fatalf("plan vars = %#v", plan.Vars)
	}
}

func TestMergeExplicitEmptyOwnerClearsAllowlist(t *testing.T) {
	base := baseSnapshot(t)
	empty := []int64{}
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{TelegramUserIDs: &empty},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Owner struct {
			TelegramUserIDs []int64 `json:"telegramUserIds"`
		} `json:"owner"`
	}
	if err := json.Unmarshal(plan.ConfigJSON, &document); err != nil {
		t.Fatal(err)
	}
	if document.Owner.TelegramUserIDs == nil || len(document.Owner.TelegramUserIDs) != 0 {
		t.Fatalf("explicit empty owner was not preserved: %#v", document.Owner.TelegramUserIDs)
	}
	if !bytes.Contains(plan.ConfigJSON, []byte(`"telegramUserIds":[]`)) {
		t.Fatalf("canonical output does not show an empty owner array: %s", plan.ConfigJSON)
	}
}

func TestMergeReplacesModelRawJSON(t *testing.T) {
	base := baseSnapshot(t)
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch: domain.EditablePatch{
			ButlerModel: rawModel(t, `{"provider":"anthropic","id":"claude-sonnet-4-5","thinking":{"effort":"low"}}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Models struct {
			Butler struct {
				Provider string         `json:"provider"`
				ID       string         `json:"id"`
				Thinking map[string]any `json:"thinking"`
			} `json:"butler"`
			Task struct {
				ID string `json:"id"`
			} `json:"task"`
		} `json:"models"`
	}
	if err := json.Unmarshal(plan.ConfigJSON, &document); err != nil {
		t.Fatal(err)
	}
	if document.Models.Butler.Provider != "anthropic" || document.Models.Butler.ID != "claude-sonnet-4-5" {
		t.Fatalf("butler model = %#v", document.Models.Butler)
	}
	if document.Models.Butler.Thinking["effort"] != "low" {
		t.Fatalf("model advanced fields were dropped: %#v", document.Models.Butler.Thinking)
	}
	if document.Models.Task.ID != "kimi-k3" {
		t.Fatalf("task model changed unexpectedly: %#v", document.Models.Task)
	}
}

func TestMergeWritesCustomProviders(t *testing.T) {
	base := baseSnapshot(t)
	providers := rawModel(t, `[{"id":"my-proxy","name":"My Proxy","api":"openai-completions","baseUrl":"https://proxy.example.com/v1","models":[{"id":"gpt-5.6"}]}]`)
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{CustomProviders: providers},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Models struct {
			CustomProviders []struct {
				ID string `json:"id"`
			} `json:"customProviders"`
		} `json:"models"`
	}
	if err := json.Unmarshal(plan.ConfigJSON, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Models.CustomProviders) != 1 || document.Models.CustomProviders[0].ID != "my-proxy" {
		t.Fatalf("customProviders = %#v", document.Models.CustomProviders)
	}
}

func TestMergeRejectsCustomProviderWithBuiltinID(t *testing.T) {
	base := baseSnapshot(t)
	providers := rawModel(t, `[{"id":"deepseek","api":"openai-completions","baseUrl":"https://proxy.example.com/v1","models":[{"id":"gpt-5.6"}]}]`)
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{CustomProviders: providers},
	})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
	if !strings.Contains(err.Error(), "deepseek") {
		t.Fatalf("error does not name the conflicting provider: %v", err)
	}
}

func TestMergeRejectsInvalidCustomProvidersPatch(t *testing.T) {
	tests := []struct {
		name  string
		patch string
	}{
		{name: "null", patch: `null`},
		{name: "object", patch: `{}`},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			base := baseSnapshot(t)
			_, err := Merge(base, domain.Change{
				BaseFingerprint: base.Fingerprint,
				Patch:           domain.EditablePatch{CustomProviders: rawModel(t, testCase.patch)},
			})
			assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
		})
	}
}

func TestMergeRejectsRemovingReferencedCustomProvider(t *testing.T) {
	base := baseSnapshot(t)
	document := `{"schemaVersion":1,"owner":{"telegramUserIds":[42]},"models":{"butler":{"provider":"my-proxy","id":"gpt-5.6"},"task":{"provider":"my-proxy","id":"gpt-5.6"},"customProviders":[{"id":"my-proxy","api":"openai-completions","baseUrl":"https://proxy.example.com/v1","models":[{"id":"gpt-5.6"}]}]},"mcpServers":[]}`
	canonical, err := domain.CanonicalizeJSON([]byte(document))
	if err != nil {
		t.Fatal(err)
	}
	base.ConfigJSON = canonical
	_, err = Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{CustomProviders: rawModel(t, `[]`)},
	})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
}

func TestMergeSurfacesUnavailableBuiltinModel(t *testing.T) {
	base := baseSnapshot(t)
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch: domain.EditablePatch{
			ButlerModel: rawModel(t, `{"provider":"deepseek","id":"not-in-catalog"}`),
		},
	})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v, want domain.Error", err)
	}
	const want = "模型 deepseek/not-in-catalog 不可用，请在桌面端模型页重新选择"
	if coded.Message != want {
		t.Fatalf("message = %q, want %q", coded.Message, want)
	}
}

func TestMergeNilConfigRequiresOwnerAndModels(t *testing.T) {
	base := domain.Snapshot{VersionID: "v1", Fingerprint: "fp"}
	_, err := Merge(base, domain.Change{BaseFingerprint: "fp"})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
	if !strings.Contains(err.Error(), "owner") || !strings.Contains(err.Error(), "models") {
		t.Fatalf("error does not explain the missing configuration: %v", err)
	}

	owner := []int64{}
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: "fp",
		Patch: domain.EditablePatch{
			TelegramUserIDs: &owner,
			ButlerModel:     rawModel(t, `{"provider":"opencode-go","id":"deepseek-v4.1-flash"}`),
			TaskModel:       rawModel(t, `{"provider":"opencode-go","id":"kimi-k3"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(plan.ConfigJSON, &document); err != nil {
		t.Fatal(err)
	}
	if document["schemaVersion"] != float64(1) {
		t.Fatalf("schemaVersion = %#v", document["schemaVersion"])
	}
	if _, ok := document["mcpServers"]; !ok {
		t.Fatal("seeded configuration has no mcpServers")
	}
}

func TestMergeSecretEdits(t *testing.T) {
	base := baseSnapshot(t)
	tests := []struct {
		name    string
		edit    domain.SecretEdit
		wantErr bool
	}{
		{name: "keep existing", edit: domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretKeep, "")},
		{name: "keep missing", edit: domain.NewSecretEdit("ANTHROPIC_API_KEY", domain.SecretKeep, ""), wantErr: true},
		{name: "keep with value", edit: domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretKeep, "x"), wantErr: true},
		{name: "replace existing", edit: domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, "new")},
		{name: "replace new template secret", edit: domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretReplace, "new")},
		{name: "replace model key without suffix", edit: domain.NewSecretEdit("MODEL_KEY_", domain.SecretReplace, "new"), wantErr: true},
		{name: "replace lowercase model key", edit: domain.NewSecretEdit("model_key_x", domain.SecretReplace, "new"), wantErr: true},
		{name: "replace without value", edit: domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, ""), wantErr: true},
		{name: "replace undeclared name", edit: domain.NewSecretEdit("UNKNOWN_SECRET", domain.SecretReplace, "x"), wantErr: true},
		{name: "clear existing", edit: domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretClear, "")},
		{name: "clear with value", edit: domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretClear, "x"), wantErr: true},
		{name: "clear missing", edit: domain.NewSecretEdit("WECHAT_CREDENTIALS", domain.SecretClear, ""), wantErr: true},
		{name: "unknown operation", edit: domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", "rotate", ""), wantErr: true},
		{name: "empty name", edit: domain.NewSecretEdit("", domain.SecretKeep, ""), wantErr: true},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Merge(base, domain.Change{
				BaseFingerprint: base.Fingerprint,
				Secrets:         []domain.SecretEdit{testCase.edit},
			})
			if testCase.wantErr {
				assertMergeCode(t, err, domain.INVALID_SECRET_EDIT)
				return
			}
			if err != nil {
				t.Fatalf("Merge() = %v, want nil", err)
			}
		})
	}
}

func TestMergeAllowsExistingLegacySecretName(t *testing.T) {
	base := baseSnapshot(t)
	base.SecretNames = append(base.SecretNames, "ANTHROPIC_API_KEY")
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("ANTHROPIC_API_KEY", domain.SecretReplace, "new"),
		},
	})
	if err != nil {
		t.Fatalf("Merge() = %v, want nil", err)
	}
}

func TestMergeRejectsDuplicateSecretEdits(t *testing.T) {
	base := baseSnapshot(t)
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretKeep, ""),
			domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, "new"),
		},
	})
	assertMergeCode(t, err, domain.INVALID_SECRET_EDIT)
}

func TestMergeNeverExportsNewSecretValue(t *testing.T) {
	base := baseSnapshot(t)
	before := base.Fingerprint
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretReplace, mergeSecretSentinel),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if base.Fingerprint != before {
		t.Fatal("Merge changed the base fingerprint")
	}

	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	for label, output := range map[string]string{
		"json":   string(encoded),
		"%v":     fmt.Sprintf("%v", plan),
		"%+v":    fmt.Sprintf("%+v", plan),
		"%#v":    fmt.Sprintf("%#v", plan),
		"config": string(plan.ConfigJSON),
	} {
		if strings.Contains(output, mergeSecretSentinel) {
			t.Fatalf("%s leaked the new secret value: %s", label, output)
		}
	}
	if !strings.Contains(fmt.Sprintf("%v", plan.Secrets), domain.RedactedValue) {
		t.Fatalf("secret edit value was not marked redacted: %v", plan.Secrets)
	}
	if len(plan.Secrets) != 1 || plan.Secrets[0].Value() != mergeSecretSentinel {
		t.Fatal("Merge did not retain the value in memory for the publish step")
	}
}

func TestMergeRejectsInvalidBaseDocument(t *testing.T) {
	base := baseSnapshot(t)
	base.ConfigJSON = []byte(`{not json`)
	_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
}

func assertMergeCode(t *testing.T, err error, code string) {
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

func TestMergeRejectsEmptyFingerprint(t *testing.T) {
	_, err := Merge(domain.Snapshot{VersionID: "v1"}, domain.Change{})
	assertMergeCode(t, err, domain.CONFIG_CONFLICT)
}

func TestMergeRejectsNoActiveVersion(t *testing.T) {
	base := baseSnapshot(t)
	base.VersionID = ""
	_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint})
	assertMergeCode(t, err, domain.NO_ACTIVE_VERSION)
}

func TestMergeValidatesSecretEditsBeforeSchema(t *testing.T) {
	base := baseSnapshot(t)
	base.ConfigJSON = []byte(`{not json`)
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretKeep, "must-be-rejected"),
		},
	})
	assertMergeCode(t, err, domain.INVALID_SECRET_EDIT)
}

func TestMergeReportsSchemaLocationsWithoutValues(t *testing.T) {
	base := baseSnapshot(t)
	const forbiddenValue = "-424242"
	ids := []int64{-424242}
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{TelegramUserIDs: &ids},
	})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
	if !strings.Contains(err.Error(), "/owner/telegramUserIds") {
		t.Fatalf("schema error does not carry the instance location: %v", err)
	}
	if strings.Contains(err.Error(), forbiddenValue) {
		t.Fatalf("schema error leaked the invalid value: %v", err)
	}
}

func TestReferenceMigrationsAreLockedDown(t *testing.T) {
	validPath := "/mcpServers/0/headers/Authorization"
	validName := "MCP_NOTION_AUTHORIZATION"
	tests := []struct {
		name      string
		reference domain.ConfigReference
		secrets   []domain.SecretEdit
		wantCode  string
	}{
		{
			name:      "valid MCP header reference",
			reference: domain.ConfigReference{Path: validPath, Reference: "env:" + validName},
			secrets:   []domain.SecretEdit{domain.NewSecretEdit(validName, domain.SecretReplace, "value")},
		},
		{
			name:      "non-header path",
			reference: domain.ConfigReference{Path: "/advanced/apiKey", Reference: "env:" + validName},
			secrets:   []domain.SecretEdit{domain.NewSecretEdit(validName, domain.SecretReplace, "value")},
			wantCode:  domain.INVALID_SECRET_EDIT,
		},
		{
			name:      "invalid secret name",
			reference: domain.ConfigReference{Path: validPath, Reference: "env:TOKEN"},
			secrets:   []domain.SecretEdit{domain.NewSecretEdit("TOKEN", domain.SecretReplace, "value")},
			wantCode:  domain.INVALID_SECRET_EDIT,
		},
		{
			name:      "missing replace edit",
			reference: domain.ConfigReference{Path: validPath, Reference: "env:" + validName},
			wantCode:  domain.INVALID_SECRET_EDIT,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			base := baseSnapshot(t)
			plan, err := Merge(base, domain.Change{
				BaseFingerprint: base.Fingerprint,
				Secrets:         testCase.secrets,
				References:      []domain.ConfigReference{testCase.reference},
			})
			if testCase.wantCode != "" {
				assertMergeCode(t, err, testCase.wantCode)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(plan.ConfigJSON, []byte("env:"+validName)) {
				t.Fatalf("reference was not applied: %s", plan.ConfigJSON)
			}
		})
	}
}

func TestMergeAllowsUnknownBuiltinModelWhenReleaseChanges(t *testing.T) {
	base := baseSnapshot(t)
	plan, err := Merge(base, domain.Change{
		BaseFingerprint:    base.Fingerprint,
		AllowReleaseChange: true,
		Patch: domain.EditablePatch{
			ButlerModel: rawModel(t, `{"provider":"deepseek","id":"not-in-catalog"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(plan.ConfigJSON, []byte(`"id":"not-in-catalog"`)) {
		t.Fatalf("unknown built-in model was not preserved: %s", plan.ConfigJSON)
	}
}

func TestMergeStillRejectsUnknownProviderWhenReleaseChanges(t *testing.T) {
	base := baseSnapshot(t)
	_, err := Merge(base, domain.Change{
		BaseFingerprint:    base.Fingerprint,
		AllowReleaseChange: true,
		Patch: domain.EditablePatch{
			ButlerModel: rawModel(t, `{"provider":"ghost","id":"any-model"}`),
		},
	})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
	if !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("error does not name the unknown provider: %v", err)
	}
}

func TestMergePreservesUnknownCustomProviderFields(t *testing.T) {
	base := baseSnapshot(t)
	document := `{"schemaVersion":1,"owner":{"telegramUserIds":[42]},"models":{"butler":{"provider":"my-proxy","id":"gpt-5.6"},"task":{"provider":"my-proxy","id":"gpt-5.6"},"customProviders":[{"id":"my-proxy","name":"Old Proxy","api":"openai-completions","baseUrl":"https://proxy.example.com/v1","headers":{"X-Tenant":"tenant-a"},"models":[{"id":"gpt-5.6","contextWindow":64000,"compat":{"reasoning":true}}]}]},"mcpServers":[]}`
	canonical, err := domain.CanonicalizeJSON([]byte(document))
	if err != nil {
		t.Fatal(err)
	}
	base.ConfigJSON = canonical
	providers := rawModel(t, `[{"id":"my-proxy","name":"Renamed Proxy","api":"openai-completions","baseUrl":"https://proxy.example.com/v1","models":[{"id":"gpt-5.6","contextWindow":64000}]}]`)
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{CustomProviders: providers},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"Renamed Proxy"`, `"headers"`, `"X-Tenant"`, `"compat"`, `"reasoning"`} {
		if !bytes.Contains(plan.ConfigJSON, []byte(want)) {
			t.Fatalf("merged configuration dropped %s: %s", want, plan.ConfigJSON)
		}
	}
}

func TestMergeReplacesMcpServers(t *testing.T) {
	base := baseSnapshot(t)
	servers := rawModel(t, `[{"name":"github","url":"https://mcp.github.test/","headers":{"Authorization":"env:MCP_GITHUB_TOKEN"},"x-extra":1},{"name":"deepwiki","url":"https://mcp.deepwiki.test/"}]`)
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{McpServers: servers},
	})
	if err != nil {
		t.Fatal(err)
	}

	decoded, err := domain.DecodeJSON(plan.ConfigJSON)
	if err != nil {
		t.Fatal(err)
	}
	document, ok := decoded.(map[string]any)
	if !ok {
		t.Fatalf("merged configuration is not an object: %s", plan.ConfigJSON)
	}
	want, err := domain.DecodeJSON(*servers)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(document["mcpServers"], want) {
		t.Fatalf("mcpServers = %#v, want %#v", document["mcpServers"], want)
	}
	if bytes.Contains(plan.ConfigJSON, []byte(`"notion"`)) {
		t.Fatalf("replaced MCP server survived: %s", plan.ConfigJSON)
	}
}

func TestMergeRejectsNonArrayMcpServers(t *testing.T) {
	base := baseSnapshot(t)
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{McpServers: rawModel(t, `{"name":"github"}`)},
	})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
}

func TestMergeRejectsMcpServerSchemaViolation(t *testing.T) {
	base := baseSnapshot(t)
	servers := rawModel(t, `[{"name":"github","url":"https://mcp.github.test/","approvalPolicy":"all"}]`)
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{McpServers: servers},
	})
	assertMergeCode(t, err, domain.UNSUPPORTED_SCHEMA)
	if !strings.Contains(err.Error(), "/mcpServers/0/approvalPolicy") {
		t.Fatalf("schema error does not name the field: %v", err)
	}
}

// URL secrets are written as {env:NAME} placeholders by the catalog; a whole-URL
// env:NAME reference would never be resolved by the Worker.
func TestReferenceRejectsMcpURL(t *testing.T) {
	base := baseSnapshot(t)
	name := "MCP_NOTION_URL"
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		References: []domain.ConfigReference{{
			Path: "/mcpServers/0/url", Reference: "env:" + name,
		}},
		Secrets: []domain.SecretEdit{domain.NewSecretEdit(name, domain.SecretReplace, "value")},
	})
	assertMergeCode(t, err, domain.INVALID_SECRET_EDIT)
}

func TestReferenceRejectsOtherPaths(t *testing.T) {
	base := baseSnapshot(t)
	name := "MCP_NOTION_NAME"
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		References: []domain.ConfigReference{{
			Path: "/mcpServers/0/name", Reference: "env:" + name,
		}},
		Secrets: []domain.SecretEdit{domain.NewSecretEdit(name, domain.SecretReplace, "value")},
	})
	assertMergeCode(t, err, domain.INVALID_SECRET_EDIT)
}

func TestSecretEditAllowsMcpNames(t *testing.T) {
	base := baseSnapshot(t)
	if _, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Secrets:         []domain.SecretEdit{domain.NewSecretEdit("MCP_GITHUB_TOKEN", domain.SecretReplace, "value")},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestReservedReferenceNamesIncludeBot(t *testing.T) {
	if !reservedReferenceNames["BOT"] {
		t.Fatal("BOT binding is not reserved for migrated secrets")
	}
}

func TestReservedReferenceNamesIncludeAI(t *testing.T) {
	if !reservedReferenceNames["AI"] {
		t.Fatal("AI binding is not reserved for migrated secrets")
	}
}

func TestMergeWritesLocale(t *testing.T) {
	base := baseSnapshot(t)
	locale := "en"
	plan, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{Locale: &locale},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Locale string `json:"locale"`
	}
	if err := json.Unmarshal(plan.ConfigJSON, &document); err != nil {
		t.Fatal(err)
	}
	if document.Locale != "en" {
		t.Fatalf("locale = %q, want en", document.Locale)
	}
}

func TestMergeKeepsLocaleWhenPatchNil(t *testing.T) {
	base := baseSnapshot(t)
	value, err := domain.DecodeJSON(base.ConfigJSON)
	if err != nil {
		t.Fatal(err)
	}
	document, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("base document is %T", value)
	}
	document["locale"] = "en"
	canonical, err := domain.CanonicalJSON(document)
	if err != nil {
		t.Fatal(err)
	}
	base.ConfigJSON = canonical

	plan, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Locale string `json:"locale"`
	}
	if err := json.Unmarshal(plan.ConfigJSON, &result); err != nil {
		t.Fatal(err)
	}
	if result.Locale != "en" {
		t.Fatalf("locale = %q, want en", result.Locale)
	}
}

func TestMergeEmptyConfigWithOnlyLocaleReportsMissingConfig(t *testing.T) {
	base := domain.Snapshot{
		Target:      domain.Target{AccountID: "account", ScriptName: "worker"},
		VersionID:   "version-1",
		Fingerprint: "empty-fingerprint",
	}
	locale := "en"
	_, err := Merge(base, domain.Change{
		BaseFingerprint: base.Fingerprint,
		Patch:           domain.EditablePatch{Locale: &locale},
	})
	if err == nil {
		t.Fatal("empty config with only a locale patch published")
	}
	if !strings.Contains(err.Error(), "DESKWAND_CONFIG is not set") {
		t.Fatalf("error = %v, want the missing-config hint", err)
	}
}
