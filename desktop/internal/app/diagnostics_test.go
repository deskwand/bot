package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/domain"
)

type fakeDiagnosticsSnapshot struct {
	snapshot domain.Snapshot
	err      error
}

func (f fakeDiagnosticsSnapshot) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	return f.snapshot, f.err
}

type fakeChannelEventReader struct {
	events []domain.Evidence
	err    error
	calls  int
	since  time.Duration
}

func (f *fakeChannelEventReader) QueryChannelEvents(_ context.Context, _ domain.Target, since time.Duration) ([]domain.Evidence, error) {
	f.calls++
	f.since = since
	return f.events, f.err
}

const diagnosticsConfigSentinel = "CONFIG-SENTINEL-should-not-be-exported"

func diagnosticsSnapshot() domain.Snapshot {
	return domain.Snapshot{
		Target:    domain.Target{AccountID: "0123456789abcdef0123456789abcdef", ScriptName: "deskwand-bot"},
		VersionID: "version-current",
		SecretNames: []string{
			"WECHAT_CREDENTIALS",
			"TELEGRAM_BOT_TOKEN",
			"TELEGRAM_WEBHOOK_SECRET",
			"MODEL_KEY_ANTHROPIC",
			"MODEL_KEY_OPENCODE_GO",
		},
		ConfigJSON: []byte(`{"schemaVersion":1,"models":{"butler":{"provider":"anthropic","id":"claude-sonnet-5-5"},"task":{"provider":"opencode-go","id":"deepseek-v4.1-flash"}},"_note":"` + diagnosticsConfigSentinel + `"}`),
	}
}

func fixedClock() time.Time {
	return time.Date(2026, 11, 2, 10, 30, 0, 0, time.UTC)
}

func newTestDiagnostics(snapshot domain.Snapshot, events *fakeChannelEventReader) *DiagnosticsService {
	return NewDiagnosticsServiceWithOptions(
		fakeDiagnosticsSnapshot{snapshot: snapshot},
		events,
		DiagnosticsOptions{Now: fixedClock, Window: 3 * time.Hour},
	)
}

func TestStatusCombinesConfiguredStateAndMissingLogs(t *testing.T) {
	reader := &fakeChannelEventReader{}
	service := newTestDiagnostics(diagnosticsSnapshot(), reader)

	report, err := service.Status(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatal(err)
	}
	if reader.calls != 1 || reader.since != 3*time.Hour {
		t.Fatalf("query calls=%d since=%v", reader.calls, reader.since)
	}
	if report.AccountID != "0123456789abcdef0123456789abcdef" || report.WorkerName != "deskwand-bot" {
		t.Fatalf("report target = %+v", report)
	}
	if report.VersionID != "version-current" || report.ObservedAt != fixedClock().Format(time.RFC3339Nano) {
		t.Fatalf("report metadata = %+v", report)
	}

	states := map[string]string{}
	for _, item := range report.Items {
		states[item.Kind] = item.State
	}
	if states["wechat"] != diagnostics.StateConfigured || states["telegram"] != diagnostics.StateConfigured ||
		states["model"] != diagnostics.StateConfigured {
		t.Fatalf("states = %v", states)
	}
	if len(report.Warnings) == 0 || !strings.Contains(strings.Join(report.Warnings, " "), "未找到") {
		t.Fatalf("warnings = %v", report.Warnings)
	}
}

func TestConfiguredRequiresRequiredSecrets(t *testing.T) {
	snapshot := diagnosticsSnapshot()
	snapshot.SecretNames = []string{"WECHAT_CREDENTIALS", "TELEGRAM_BOT_TOKEN"}
	reader := &fakeChannelEventReader{}
	service := newTestDiagnostics(snapshot, reader)

	report, err := service.Status(context.Background(), snapshot.Target)
	if err != nil {
		t.Fatal(err)
	}
	if item := findItem(t, report.Items, "telegram"); item.State != diagnostics.StateUnknown {
		t.Fatalf("telegram without webhook secret = %+v", item)
	}
	if item := findItem(t, report.Items, "model"); item.State != diagnostics.StateUnknown {
		t.Fatalf("model without provider secret = %+v", item)
	}
	if item := findItem(t, report.Items, "wechat"); item.State != diagnostics.StateConfigured {
		t.Fatalf("wechat = %+v", item)
	}
}

func TestConfiguredModelAcceptsKeylessProvider(t *testing.T) {
	snapshot := diagnosticsSnapshot()
	snapshot.SecretNames = []string{"WECHAT_CREDENTIALS", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"}
	snapshot.ConfigJSON = []byte(`{"schemaVersion":1,"models":{"butler":{"provider":"workers-ai","id":"@cf/google/gemma-4-26b-a4b-it"},"task":{"provider":"workers-ai","id":"@cf/google/gemma-4-26b-a4b-it"}}}`)
	service := newTestDiagnostics(snapshot, &fakeChannelEventReader{})

	report, err := service.Status(context.Background(), snapshot.Target)
	if err != nil {
		t.Fatal(err)
	}
	if item := findItem(t, report.Items, "model"); item.State != diagnostics.StateConfigured {
		t.Fatalf("model with keyless providers = %+v", item)
	}
}

func TestConfiguredModelIgnoresLegacySecretNames(t *testing.T) {
	snapshot := diagnosticsSnapshot()
	snapshot.SecretNames = []string{
		"WECHAT_CREDENTIALS",
		"TELEGRAM_BOT_TOKEN",
		"TELEGRAM_WEBHOOK_SECRET",
		"ANTHROPIC_API_KEY",
		"OPENCODE_API_KEY",
	}
	service := newTestDiagnostics(snapshot, &fakeChannelEventReader{})

	report, err := service.Status(context.Background(), snapshot.Target)
	if err != nil {
		t.Fatal(err)
	}
	if item := findItem(t, report.Items, "model"); item.State != diagnostics.StateUnknown {
		t.Fatalf("model with only legacy secrets = %+v", item)
	}
}

func TestStatusWarnsOnObservabilityAuthFailure(t *testing.T) {
	reader := &fakeChannelEventReader{err: &cloudflare.APIError{Status: 401, Message: "Authentication error"}}
	service := newTestDiagnostics(diagnosticsSnapshot(), reader)

	report, err := service.Status(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if got := strings.Join(report.Warnings, " "); !strings.Contains(got, "API 令牌无效或已过期") {
		t.Fatalf("warnings = %v", report.Warnings)
	}
}

func TestStatusUsesCurrentVersionCloudEvidence(t *testing.T) {
	reader := &fakeChannelEventReader{events: []domain.Evidence{{
		Kind:       "wechat",
		Source:     diagnostics.SourceCloudLogs,
		ObservedAt: "2026-11-02T10:00:00Z",
		Detail:     "poll_ok",
		VersionID:  "version-current",
	}}}
	service := newTestDiagnostics(diagnosticsSnapshot(), reader)

	report, err := service.Status(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatal(err)
	}
	item := findItem(t, report.Items, "wechat")
	if item.State != diagnostics.StateVerified || item.Source != diagnostics.SourceCloudLogs {
		t.Fatalf("wechat = %+v", item)
	}
	if len(report.Warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", report.Warnings)
	}
}

func TestStatusKeepsOldVersionUnverified(t *testing.T) {
	reader := &fakeChannelEventReader{events: []domain.Evidence{{
		Kind:       "wechat",
		Source:     diagnostics.SourceCloudLogs,
		ObservedAt: "2026-11-02T10:00:00Z",
		Detail:     "poll_ok",
		VersionID:  "version-old",
	}}}
	service := newTestDiagnostics(diagnosticsSnapshot(), reader)

	report, err := service.Status(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatal(err)
	}
	item := findItem(t, report.Items, "wechat")
	if item.State != diagnostics.StateUnverified || !strings.Contains(item.Detail, "旧版本") {
		t.Fatalf("wechat = %+v", item)
	}
}

func TestStatusTreatsObservabilityUnavailableAsUnknownNotFailure(t *testing.T) {
	reader := &fakeChannelEventReader{err: &cloudflare.ObservabilityUnavailableError{Status: 403}}
	service := newTestDiagnostics(diagnosticsSnapshot(), reader)

	report, err := service.Status(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatalf("status failed on unavailable observability: %v", err)
	}
	if got := strings.Join(report.Warnings, " "); !strings.Contains(got, "无法读取云端日志（令牌缺少权限或未开启日志）") {
		t.Fatalf("warnings = %v", report.Warnings)
	}
	if item := findItem(t, report.Items, "wechat"); item.State != diagnostics.StateConfigured {
		t.Fatalf("wechat = %+v", item)
	}
}

func TestStatusTreatsOtherLogErrorsAsUnknownWithWarning(t *testing.T) {
	reader := &fakeChannelEventReader{err: errors.New("network down with SENTINEL")}
	service := newTestDiagnostics(diagnosticsSnapshot(), reader)

	report, err := service.Status(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if !strings.Contains(strings.Join(report.Warnings, " "), "无法读取云端日志") {
		t.Fatalf("warnings = %v", report.Warnings)
	}
	for _, warning := range report.Warnings {
		if strings.Contains(warning, "SENTINEL") {
			t.Fatalf("warning leaked the raw error: %q", warning)
		}
	}
}

func TestStatusWithoutEventReaderWarns(t *testing.T) {
	service := NewDiagnosticsServiceWithOptions(fakeDiagnosticsSnapshot{snapshot: diagnosticsSnapshot()}, nil, DiagnosticsOptions{Now: fixedClock})

	report, err := service.Status(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(report.Warnings, " "), "未连接云端日志查询") {
		t.Fatalf("warnings = %v", report.Warnings)
	}
}

func TestStatusSnapshotFailureIsReturned(t *testing.T) {
	service := NewDiagnosticsServiceWithOptions(
		fakeDiagnosticsSnapshot{err: errors.New("snapshot failed")},
		&fakeChannelEventReader{},
		DiagnosticsOptions{Now: fixedClock},
	)

	if _, err := service.Status(context.Background(), diagnosticsSnapshot().Target); err == nil {
		t.Fatal("expected a snapshot error")
	}
}

func TestExportDiagnosticsUsesAllowlistedRedactedFields(t *testing.T) {
	reader := &fakeChannelEventReader{events: []domain.Evidence{{
		Kind:       "wechat",
		Source:     diagnostics.SourceCloudLogs,
		ObservedAt: "2026-11-02T10:00:00Z",
		Detail:     "https://example.test/cb?token=URL-SENTINEL&ok=1",
		VersionID:  "version-current",
	}}}
	service := newTestDiagnostics(diagnosticsSnapshot(), reader)

	raw, err := service.ExportDiagnostics(context.Background(), diagnosticsSnapshot().Target)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, sentinel := range []string{diagnosticsConfigSentinel, "URL-SENTINEL"} {
		if strings.Contains(text, sentinel) {
			t.Fatalf("export leaked %q: %s", sentinel, text)
		}
	}

	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"schemaVersion", "items", "events"} {
		if _, ok := document[key]; !ok {
			t.Fatalf("export missing %q: %v", key, document)
		}
	}
	if len(document) != 3 {
		t.Fatalf("export has extra top-level fields: %v", document)
	}
}

func findItem(t *testing.T, items []diagnostics.StatusItem, kind string) diagnostics.StatusItem {
	t.Helper()
	for _, item := range items {
		if item.Kind == kind {
			return item
		}
	}
	t.Fatalf("missing %q item in %+v", kind, items)
	return diagnostics.StatusItem{}
}
