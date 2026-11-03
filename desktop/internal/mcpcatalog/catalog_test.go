package mcpcatalog

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/config"
	"github.com/deskwand/bot/desktop/internal/domain"
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
	if len(All()) == 0 {
		t.Fatal("catalog is empty")
	}
	for _, entry := range All() {
		t.Run(entry.ID, func(t *testing.T) {
			values := map[string]string{}
			for _, field := range entry.Fields {
				values[field.Key] = "placeholder-" + field.Key
			}
			server, secrets, err := Build(entry, entry.ID, values)
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
	for _, entry := range All() {
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
	entry, ok := Lookup("github")
	if !ok {
		t.Fatal("github entry is missing")
	}
	server, secrets, err := Build(entry, "github", map[string]string{"token": "abc"})
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

func TestBuildURLField(t *testing.T) {
	entry, ok := Lookup("amap")
	if !ok {
		t.Fatal("amap entry is missing")
	}
	server, secrets, err := Build(entry, "amap", map[string]string{"key": "abc"})
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
	entry, ok := Lookup("github")
	if !ok {
		t.Fatal("github entry is missing")
	}
	_, _, err := Build(entry, "github", map[string]string{})
	if err == nil {
		t.Fatal("Build() = nil, want an error")
	}
	if strings.Contains(err.Error(), "abc") {
		t.Fatalf("error contains a secret value: %v", err)
	}
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
