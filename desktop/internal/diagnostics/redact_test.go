package diagnostics

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const sentinelSecret = "SENTINEL-provider-key-0123456789abcdef"

func TestRedactorStripsRegisteredSecretsAndCredentialShapes(t *testing.T) {
	redactor := NewRedactor(sentinelSecret)
	input := strings.Join([]string{
		"provider error: key=" + sentinelSecret,
		"Authorization: Bearer " + sentinelSecret,
		"x-api-key: " + sentinelSecret,
		"https://api.example.test/v1/chat?token=" + sentinelSecret + "&key=" + sentinelSecret + "&secret=" + sentinelSecret + "&access_token=" + sentinelSecret + "&model=kept",
		"https://api.telegram.org/bot123456789:" + sentinelSecret + "/sendMessage",
		"https://api.telegram.org/bot123456789%3A" + sentinelSecret + "/sendMessage",
		"Authorization: Basic " + sentinelSecret,
		"bare Bearer abcdefghijklmnopqrstuvwxyz",
	}, "\n")

	got := redactor.Redact(input)

	for _, leaked := range []string{sentinelSecret, "abcdefghijklmnopqrstuvwxyz"} {
		if strings.Contains(got, leaked) {
			t.Fatalf("redacted text still contains %q: %q", leaked, got)
		}
	}
	if !strings.Contains(got, "model=kept") {
		t.Fatalf("redactor removed a non-secret query parameter: %q", got)
	}
	if !strings.Contains(got, RedactedValue) {
		t.Fatalf("redacted text has no marker: %q", got)
	}
}

func TestRedactorHandlesCommonPrefixedKeys(t *testing.T) {
	got := NewRedactor().Redact("bad key sk-live-0123456789abcdef and pk-test-0123456789abcdef")

	if strings.Contains(got, "sk-live") || strings.Contains(got, "pk-test") {
		t.Fatalf("prefixed provider key leaked: %q", got)
	}
}

func TestExportUsesOnlyAllowlistedFields(t *testing.T) {
	items := []StatusItem{{
		Kind:       "wechat",
		State:      StateVerified,
		Source:     SourceCloudLogs,
		ObservedAt: "2026-11-02T10:00:00Z",
		Detail:     "poll_ok",
	}}
	events := []domain.Evidence{{
		Kind:       "wechat",
		Source:     SourceCloudLogs,
		ObservedAt: "2026-11-02T10:00:00Z",
		Detail:     "poll_ok",
		VersionID:  testCurrentVersion,
	}}

	raw, err := Export(items, events)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	assertKeys(t, document, "schemaVersion", "items", "events")

	var exportedItems []map[string]json.RawMessage
	if err := json.Unmarshal(document["items"], &exportedItems); err != nil {
		t.Fatal(err)
	}
	if len(exportedItems) != 1 {
		t.Fatalf("items = %d", len(exportedItems))
	}
	assertKeys(t, exportedItems[0], "kind", "state", "source", "observedAt", "detail")

	var exportedEvents []map[string]json.RawMessage
	if err := json.Unmarshal(document["events"], &exportedEvents); err != nil {
		t.Fatal(err)
	}
	if len(exportedEvents) != 1 {
		t.Fatalf("events = %d", len(exportedEvents))
	}
	assertKeys(t, exportedEvents[0], "kind", "source", "observedAt", "detail", "versionId")

	if strings.Contains(string(raw), "SENTINEL") {
		t.Fatalf("export contains a sentinel: %s", raw)
	}
}

func TestExportWithRedactorRemovesSentinelsFromSeedData(t *testing.T) {
	redactor := NewRedactor(sentinelSecret)
	items := []StatusItem{{
		Kind:       "model",
		State:      StateUnavailable,
		Source:     SourceLocal,
		ObservedAt: "2026-11-02T10:00:00Z",
		Detail:     "provider error: Authorization: Bearer " + sentinelSecret,
	}}
	events := []domain.Evidence{
		{
			Kind:       "wechat",
			Source:     SourceCloudLogs,
			ObservedAt: "2026-11-02T10:00:00Z",
			Detail:     "poll_error?token=" + sentinelSecret,
			VersionID:  testCurrentVersion,
		},
		{
			Kind:       "telegram",
			Source:     SourceCloudLogs,
			ObservedAt: "2026-11-02T10:00:00Z",
			Detail:     "https://api.telegram.org/bot987654321:" + sentinelSecret + "/sendMessage",
			VersionID:  testCurrentVersion,
		},
	}

	raw, err := ExportWithRedactor(items, events, redactor)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), sentinelSecret) {
		t.Fatalf("export leaked the registered secret: %s", raw)
	}
	if !strings.Contains(string(raw), "bot987654321:[REDACTED]") {
		t.Fatalf("Telegram bot token was not redacted in place: %s", raw)
	}
}

func TestExportDefaultRedactsCredentialPatterns(t *testing.T) {
	items := []StatusItem{{
		Kind:       "wechat",
		State:      StateUnknown,
		Source:     SourceCloudLogs,
		ObservedAt: "2026-11-02T10:00:00Z",
		Detail:     "https://example.test/cb?secret=SENTINEL-url-secret&ok=1",
	}}

	raw, err := Export(items, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "SENTINEL-url-secret") {
		t.Fatalf("export leaked a query secret: %s", raw)
	}
	if !strings.Contains(string(raw), "ok=1") {
		t.Fatalf("export removed a harmless parameter: %s", raw)
	}
}

func assertKeys(t *testing.T, value map[string]json.RawMessage, want ...string) {
	t.Helper()
	got := make([]string, 0, len(value))
	for key := range value {
		got = append(got, key)
	}
	if len(got) != len(want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	for _, key := range want {
		if _, ok := value[key]; !ok {
			t.Fatalf("missing key %q in %v", key, got)
		}
	}
}
