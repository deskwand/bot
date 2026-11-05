package mcpcatalog

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/config"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
)

var (
	secretNamePattern = regexp.MustCompile(`^MCP_[A-Z0-9_]{1,64}$`)
	entryIDPattern    = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
)

func minimalConfig(server map[string]any) map[string]any {
	return map[string]any{
		"schemaVersion": 1,
		"owner":         map[string]any{"telegramUserIds": []any{}},
		"models": map[string]any{
			"butler": map[string]any{"provider": "opencode-go", "id": "deepseek-v4.1-flash"},
			"task":   map[string]any{"provider": "opencode-go", "id": "deepseek-v4.1-flash"},
		},
		"mcpServers": []any{server},
	}
}

func TestCatalogEntriesBuildValidConfig(t *testing.T) {
	if len(All("zh")) == 0 {
		t.Fatal("catalog is empty")
	}
	for _, entry := range All("zh") {
		t.Run(entry.ID, func(t *testing.T) {
			values := map[string]string{}
			for _, field := range entry.Fields {
				values[field.Key] = "placeholder-" + field.Key
			}
			server, secrets, err := Build("zh", entry, entry.ID, values)
			if err != nil {
				t.Fatalf("Build() = %v", err)
			}
			for _, secret := range secrets {
				if !secretNamePattern.MatchString(secret.Name) {
					t.Fatalf("secret name %q does not match the MCP pattern", secret.Name)
				}
				if secret.Operation != domain.SecretReplace {
					t.Fatalf("secret %q operation = %q, want %q", secret.Name, secret.Operation, domain.SecretReplace)
				}
				if secret.Value() == "" {
					t.Fatalf("secret %q has an empty value", secret.Name)
				}
			}
			raw, err := json.Marshal(minimalConfig(server))
			if err != nil {
				t.Fatal(err)
			}
			if err := config.Validate(raw); err != nil {
				t.Fatalf("generated config does not validate: %v", err)
			}
		})
	}
}

func TestCatalogIDsUniqueAndNamesValid(t *testing.T) {
	seen := map[string]bool{}
	for _, entry := range All("zh") {
		if !entryIDPattern.MatchString(entry.ID) {
			t.Fatalf("entry ID %q does not match the name pattern", entry.ID)
		}
		if seen[entry.ID] {
			t.Fatalf("duplicate entry ID %q", entry.ID)
		}
		seen[entry.ID] = true
		if entry.Name == "" || entry.Category == "" || entry.Description == "" || entry.URL == "" {
			t.Fatalf("entry %q has an empty required string", entry.ID)
		}
		for _, field := range entry.Fields {
			if field.Key == "" || field.Label == "" || field.Help == "" || field.HelpURL == "" {
				t.Fatalf("entry %q field %q has an empty required string", entry.ID, field.Key)
			}
			switch field.Placement {
			case "header":
				if field.HeaderName == "" {
					t.Fatalf("entry %q header field %q has no header name", entry.ID, field.Key)
				}
			case "url":
				if !strings.Contains(entry.URL, "{field:"+field.Key+"}") {
					t.Fatalf("entry %q url does not reference field %q", entry.ID, field.Key)
				}
			default:
				t.Fatalf("entry %q field %q has placement %q", entry.ID, field.Key, field.Placement)
			}
		}
	}
}

func TestBuildHeaderPrefixStoresFullValue(t *testing.T) {
	entry, ok := Lookup("zh", "github")
	if !ok {
		t.Fatal("github entry is missing")
	}
	server, secrets, err := Build("zh", entry, "github", map[string]string{"token": "abc"})
	if err != nil {
		t.Fatalf("Build() = %v", err)
	}
	headers, ok := server["headers"].(map[string]any)
	if !ok {
		t.Fatalf("headers = %#v", server["headers"])
	}
	if got := headers["Authorization"]; got != "env:MCP_GITHUB_TOKEN" {
		t.Fatalf("Authorization = %#v, want env:MCP_GITHUB_TOKEN", got)
	}
	if len(secrets) != 1 {
		t.Fatalf("secrets = %#v, want one edit", secrets)
	}
	if secrets[0].Name != "MCP_GITHUB_TOKEN" || secrets[0].Value() != "Bearer abc" {
		t.Fatalf("secret = %s, want MCP_GITHUB_TOKEN with the prefixed value", secrets[0])
	}
	raw, err := json.Marshal(server)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "abc") {
		t.Fatal("generated server config contains the secret value")
	}
}

func TestBuildTrimsPastedValues(t *testing.T) {
	entry, _ := Lookup("zh", "github")
	_, secrets, err := Build("zh", entry, "github", map[string]string{"token": "  abc\n"})
	if err != nil {
		t.Fatalf("Build() = %v", err)
	}
	if secrets[0].Value() != "Bearer abc" {
		t.Fatalf("secret value was not trimmed: %q", secrets[0].Value())
	}
}

func TestBuildURLField(t *testing.T) {
	entry, ok := Lookup("zh", "amap")
	if !ok {
		t.Fatal("amap entry is missing")
	}
	server, secrets, err := Build("zh", entry, "amap", map[string]string{"key": "abc"})
	if err != nil {
		t.Fatalf("Build() = %v", err)
	}
	if got := server["url"]; got != "https://mcp.amap.com/sse?key={env:MCP_AMAP_KEY}" {
		t.Fatalf("url = %#v", got)
	}
	if len(secrets) != 1 {
		t.Fatalf("secrets = %#v, want one edit", secrets)
	}
	if secrets[0].Name != "MCP_AMAP_KEY" || secrets[0].Value() != "abc" {
		t.Fatalf("secret = %s, want MCP_AMAP_KEY", secrets[0])
	}
	raw, err := json.Marshal(server)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "abc") {
		t.Fatal("generated server config contains the secret value")
	}
}

func TestBuildRejectsMissingValue(t *testing.T) {
	entry, ok := Lookup("zh", "github")
	if !ok {
		t.Fatal("github entry is missing")
	}
	_, _, err := Build("zh", entry, "github", map[string]string{})
	if err == nil {
		t.Fatal("Build() = nil, want an error")
	}
	if strings.Contains(err.Error(), "abc") {
		t.Fatalf("error contains a secret value: %v", err)
	}
}

func TestCatalogEveryTextHasBothLanguages(t *testing.T) {
	for _, entry := range builtin.Entries {
		check := func(label string, text Text) {
			t.Helper()
			if text.Zh == "" || text.En == "" {
				t.Fatalf("%s is missing a language: %#v", label, text)
			}
			i18ntest.NoHan(t, label+" en", text.En)
		}
		check(entry.ID+".category", entry.Category)
		check(entry.ID+".description", entry.Description)
		for _, field := range entry.Fields {
			check(entry.ID+"."+field.Key+".label", field.Label)
			check(entry.ID+"."+field.Key+".help", field.Help)
		}
	}
}

func TestCatalogZhUnchanged(t *testing.T) {
	raw, err := os.ReadFile("testdata/catalog_zh_baseline.json")
	if err != nil {
		t.Fatal(err)
	}
	var baseline struct {
		SchemaVersion int     `json:"schemaVersion"`
		Entries       []Entry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &baseline); err != nil {
		t.Fatal(err)
	}
	got := All("zh")
	if !reflect.DeepEqual(got, baseline.Entries) {
		gotJSON, _ := json.MarshalIndent(got, "", "  ")
		wantJSON, _ := json.MarshalIndent(baseline.Entries, "", "  ")
		t.Fatalf("All(\"zh\") changed:\n got: %s\nwant: %s", gotJSON, wantJSON)
	}
}

func TestBuildMissingFieldFollowsLocale(t *testing.T) {
	entry, ok := Lookup("en", "github")
	if !ok {
		t.Fatal("github entry is missing")
	}
	_, _, err := Build("en", entry, "github", map[string]string{})
	if err == nil {
		t.Fatal("Build() = nil, want an error")
	}
	i18ntest.NoHan(t, "Build error", err.Error())
}

func TestOrphanedKeepsSharedSecrets(t *testing.T) {
	removed := map[string]any{
		"name": "removed",
		"url":  "https://example.test/mcp?key={env:MCP_REMOVED_KEY}",
		"headers": map[string]any{
			"Authorization": "env:MCP_SHARED",
			"X-Literal":     "not-an-env-reference",
		},
	}
	kept := []map[string]any{
		{
			"name":    "kept",
			"url":     "https://example.test/mcp",
			"headers": map[string]string{"Authorization": "env:MCP_SHARED"},
		},
	}
	want := []string{"MCP_REMOVED_KEY"}
	if got := Orphaned(removed, kept); !reflect.DeepEqual(got, want) {
		t.Fatalf("Orphaned() = %#v, want %#v", got, want)
	}
	if got := Orphaned(nil, kept); len(got) != 0 {
		t.Fatalf("Orphaned(nil) = %#v, want no names", got)
	}
}
