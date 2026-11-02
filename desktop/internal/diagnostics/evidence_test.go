package diagnostics

import (
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const (
	testCurrentVersion = "version-current"
	testOldVersion     = "version-old"
)

func TestMissingLogsAreUnknown(t *testing.T) {
	got := Summarize([]string{"wechat"}, nil, testCurrentVersion)
	if len(got) != 1 {
		t.Fatalf("got %d items, want 1", len(got))
	}
	if got[0].State != StateUnknown {
		t.Fatalf("state = %q, want %q", got[0].State, StateUnknown)
	}
	if got[0].Source != "" {
		t.Fatalf("source = %q, want empty", got[0].Source)
	}
	if !strings.Contains(got[0].Detail, "未找到") {
		t.Fatalf("detail = %q, want missing-evidence wording", got[0].Detail)
	}
	if got[0].ObservedAt == "" {
		t.Fatal("unknown item has no check timestamp")
	}
	if _, err := time.Parse(time.RFC3339Nano, got[0].ObservedAt); err != nil {
		t.Fatalf("observedAt = %q: %v", got[0].ObservedAt, err)
	}
}

func TestOneItemPerRequestedKindAndKindIsolation(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "telegram", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:00:00Z", Detail: "webhook_ok", VersionID: testCurrentVersion},
		{Kind: "telegram", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:01:00Z", Detail: "send_ok", VersionID: testCurrentVersion},
	}

	got := Summarize([]string{"wechat", "telegram", "wechat"}, events, testCurrentVersion)
	if len(got) != 2 {
		t.Fatalf("got %d items, want 2", len(got))
	}
	if got[0].Kind != "wechat" || got[0].State != StateUnknown {
		t.Fatalf("wechat item = %#v, want unknown from its own evidence only", got[0])
	}
	if got[1].Kind != "telegram" || got[1].State != StateVerified {
		t.Fatalf("telegram item = %#v, want verified", got[1])
	}
	if got[1].ObservedAt != "2026-11-02T10:01:00Z" {
		t.Fatalf("newest event not selected: %#v", got[1])
	}
}

func TestStaleVersionIsUnverifiedNotSuccess(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "wechat", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:00:00Z", Detail: "poll_ok", VersionID: testOldVersion},
	}

	got := Summarize([]string{"wechat"}, events, testCurrentVersion)
	if len(got) != 1 {
		t.Fatalf("got %d items, want 1", len(got))
	}
	if got[0].State != StateUnverified {
		t.Fatalf("state = %q, want %q", got[0].State, StateUnverified)
	}
	if !strings.Contains(got[0].Detail, "旧版本") {
		t.Fatalf("detail = %q, want old-version wording", got[0].Detail)
	}
	if !strings.Contains(got[0].Detail, testOldVersion) {
		t.Fatalf("detail = %q, want the observed old version", got[0].Detail)
	}
	if got[0].Source != SourceCloudLogs {
		t.Fatalf("source = %q", got[0].Source)
	}
}

func TestCloudEvidenceNeedsCurrentVersionID(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "telegram", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:00:00Z", Detail: "webhook_ok"},
	}

	got := Summarize([]string{"telegram"}, events, testCurrentVersion)
	if got[0].State != StateUnverified || !strings.Contains(got[0].Detail, "旧版本") {
		t.Fatalf("missing version id became current: %#v", got[0])
	}
}

func TestCurrentVersionCloudSuccessIsVerified(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "wechat", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:00:00Z", Detail: "poll_ok", VersionID: testCurrentVersion},
	}

	got := Summarize([]string{"wechat"}, events, testCurrentVersion)
	if got[0].State != StateVerified {
		t.Fatalf("state = %q, want verified", got[0].State)
	}
	if got[0].Detail != "poll_ok" {
		t.Fatalf("detail = %q, want original event name", got[0].Detail)
	}
	if got[0].ObservedAt != "2026-11-02T10:00:00Z" {
		t.Fatalf("observedAt = %q", got[0].ObservedAt)
	}
}

func TestPollExpiredAndErrorHaveDistinctStates(t *testing.T) {
	cases := []struct {
		detail string
		want   string
	}{
		{"poll_expired", StateExpired},
		{"poll_error", StateUnavailable},
	}
	for _, tc := range cases {
		events := []domain.Evidence{{
			Kind:       "wechat",
			Source:     SourceCloudLogs,
			ObservedAt: "2026-11-02T10:00:00Z",
			Detail:     tc.detail,
			VersionID:  testCurrentVersion,
		}}
		got := Summarize([]string{"wechat"}, events, testCurrentVersion)
		if got[0].State != tc.want {
			t.Errorf("%s state = %q, want %q", tc.detail, got[0].State, tc.want)
		}
	}
}

func TestWebhookRejectedIsIgnoredWhenChoosingState(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "telegram", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:00:00Z", Detail: "webhook_ok", VersionID: testCurrentVersion},
		{Kind: "telegram", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:05:00Z", Detail: "webhook_rejected", VersionID: testCurrentVersion},
	}

	got := Summarize([]string{"telegram"}, events, testCurrentVersion)
	if got[0].State != StateVerified || got[0].Detail != "webhook_ok" {
		t.Fatalf("rejected webhook changed the state: %#v", got[0])
	}

	onlyRejected := Summarize([]string{"telegram"}, events[1:], testCurrentVersion)
	if onlyRejected[0].State != StateUnknown {
		t.Fatalf("rejected webhook alone became a failure: %#v", onlyRejected[0])
	}
}

func TestUnknownSourceIsForcedUnverified(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "wechat", Source: "mystery-source", ObservedAt: "2026-11-02T10:00:00Z", Detail: "poll_ok"},
	}

	got := Summarize([]string{"wechat"}, events, testCurrentVersion)
	if got[0].State != StateUnverified {
		t.Fatalf("unknown source became %q, want unverified", got[0].State)
	}
	if !strings.Contains(got[0].Detail, "来源未知") {
		t.Fatalf("detail = %q, want unknown-source wording", got[0].Detail)
	}
}

func TestClassifyMatchesExactEventNames(t *testing.T) {
	for _, detail := range []string{"looks_ok_to_me", "not_poll_error", "webhookish"} {
		state, _ := classify(detail)
		if state == StateVerified || state == StateUnavailable {
			t.Errorf("%q classified as %q", detail, state)
		}
	}
}

func TestHeartbeatIsNotSuccessfulPoll(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "wechat", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:00:00Z", Detail: "heartbeat", VersionID: testCurrentVersion},
	}

	got := Summarize([]string{"wechat"}, events, testCurrentVersion)
	if got[0].State == StateVerified {
		t.Fatalf("heartbeat became a verified poll: %#v", got[0])
	}
	if !strings.Contains(got[0].Detail, "心跳") {
		t.Fatalf("detail = %q, want heartbeat warning", got[0].Detail)
	}
}

func TestLocalModelProbeIsNotCloudVerification(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "model", Source: SourceLocal, ObservedAt: "2026-11-02T10:00:00Z", Detail: "probe_ok"},
	}

	got := Summarize([]string{"model"}, events, testCurrentVersion)
	if got[0].Source != SourceLocal {
		t.Fatalf("source = %q, want local", got[0].Source)
	}
	if got[0].Source == SourceCloudLogs {
		t.Fatal("local probe manufactured cloud evidence")
	}
	if got[0].State == StateVerified {
		t.Fatalf("local probe became a verified cloud state: %#v", got[0])
	}
	if !strings.Contains(got[0].Detail, "本机") {
		t.Fatalf("detail = %q, want local-only wording", got[0].Detail)
	}
}

func TestUserConfirmationIsLabelledUser(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "telegram", Source: SourceUser, ObservedAt: "2026-11-02T10:00:00Z", Detail: "user_confirmed"},
	}

	got := Summarize([]string{"telegram"}, events, testCurrentVersion)
	if got[0].Source != SourceUser {
		t.Fatalf("source = %q, want user", got[0].Source)
	}
	if got[0].State != StateVerified {
		t.Fatalf("state = %q, want verified for a direct user observation", got[0].State)
	}
	if !strings.Contains(got[0].Detail, "用户确认") {
		t.Fatalf("detail = %q, want user wording", got[0].Detail)
	}
}

func TestConfiguredWithoutCurrentLogsStaysConfigured(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "wechat", Source: SourceConfig, ObservedAt: "2026-11-02T10:00:00Z", Detail: "configured"},
	}

	got := Summarize([]string{"wechat"}, events, testCurrentVersion)
	if got[0].State != StateConfigured {
		t.Fatalf("state = %q, want configured", got[0].State)
	}
	if !strings.Contains(got[0].Detail, "尚无") {
		t.Fatalf("detail = %q, want configured-without-logs wording", got[0].Detail)
	}
}

func TestCurrentCloudEvidenceWinsOverLocalAndConfigured(t *testing.T) {
	events := []domain.Evidence{
		{Kind: "model", Source: SourceConfig, ObservedAt: "2026-11-02T11:00:00Z", Detail: "configured"},
		{Kind: "model", Source: SourceLocal, ObservedAt: "2026-11-02T12:00:00Z", Detail: "probe_ok"},
		{Kind: "model", Source: SourceCloudLogs, ObservedAt: "2026-11-02T10:00:00Z", Detail: "poll_ok", VersionID: testCurrentVersion},
	}

	got := Summarize([]string{"model"}, events, testCurrentVersion)
	if got[0].Source != SourceCloudLogs || got[0].State != StateVerified {
		t.Fatalf("cloud evidence did not win: %#v", got[0])
	}
}
