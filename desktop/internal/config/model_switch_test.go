package config

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestMergeGuardsButlerWindow(t *testing.T) {
	for _, tc := range []struct {
		name              string
		before, after     int
		sameID, wantError bool
	}{
		{"large shrink rejected", 128000, 16000, false, true},
		{"fourfold shrink allowed", 128000, 32000, false, false},
		{"million to common GPT", 1000000, 272000, false, false},
		{"million to 128k rejected", 1000000, 128000, false, true},
		{"quarter boundary allowed", 1000000, 250000, false, false},
		{"below quarter rejected", 1000000, 249999, false, true},
		{"equal", 32000, 32000, false, false},
		{"larger", 32000, 128000, false, false},
		{"same ID large shrink", 128000, 16000, true, true},
		{"same ID moderate shrink", 1000000, 272000, true, false},
		{"same ID unchanged", 32000, 32000, true, false},
		{"omitted window defaults to 128k", 0, 16000, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := baseSnapshot(t)
			base.ConfigJSON = []byte(`{"schemaVersion":1,"owner":{"telegramUserIds":[42]},"models":{"butler":{"provider":"private","id":"old"},"task":{"provider":"opencode-go","id":"kimi-k3"},"customProviders":[{"id":"private","api":"openai-completions","baseUrl":"https://example.com/v1","models":[{"id":"old","contextWindow":` + strconv.Itoa(tc.before) + `}]}]},"mcpServers":[]}`)
			if tc.before == 0 {
				base.ConfigJSON = bytes.ReplaceAll(base.ConfigJSON, []byte(`,"contextWindow":0`), nil)
			}
			id := "new"
			if tc.sameID {
				id = "old"
			}
			departing := ""
			if !tc.sameID {
				previousWindow := tc.before
				if previousWindow == 0 {
					previousWindow = 128000
				}
				departing = `{"id":"old","contextWindow":` + strconv.Itoa(previousWindow) + `},`
			}
			providers := json.RawMessage(`[{"id":"private","api":"openai-completions","baseUrl":"https://example.com/v1","models":[` + departing + `{"id":"` + id + `","contextWindow":` + strconv.Itoa(tc.after) + `}]}]`)
			patch := domain.EditablePatch{CustomProviders: &providers}
			if !tc.sameID {
				patch.ButlerModel = rawModel(t, `{"provider":"private","id":"`+id+`"}`)
			}
			plan, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint, Patch: patch})
			if tc.wantError {
				if err == nil {
					t.Fatal("smaller context window was accepted")
				}
				if len(plan.ConfigJSON) > 0 {
					t.Fatal("rejection produced a publish plan")
				}
				before := tc.before
				if before == 0 {
					before = 128000
				}
				if !strings.Contains(err.Error(), strconv.Itoa(tc.after)) || !strings.Contains(err.Error(), strconv.Itoa(before)) {
					t.Fatalf("missing window sizes: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMergeRejectsBuiltinWindowDowngrade(t *testing.T) {
	base := baseSnapshot(t)
	_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint, Patch: domain.EditablePatch{ButlerModel: rawModel(t, `{"provider":"anthropic","id":"claude-haiku-4-5"}`)}})
	if err == nil {
		t.Fatal("builtin downgrade accepted")
	}
	if !strings.Contains(err.Error(), "1000000") || !strings.Contains(err.Error(), "200000") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMergeWindowGuardAllowsTaskDefaults(t *testing.T) {
	base := baseSnapshot(t)
	_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint, Patch: domain.EditablePatch{TaskModel: rawModel(t, `{"provider":"anthropic","id":"claude-haiku-4-5"}`)}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMergeWindowGuardRejectsUnknownSourceSwitch(t *testing.T) {
	base := baseSnapshot(t)
	base.ConfigJSON = bytes.ReplaceAll(base.ConfigJSON, []byte(`"id":"deepseek-v4.1-flash"`), []byte(`"id":"unknown-old-model"`))
	_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint, Patch: domain.EditablePatch{ButlerModel: rawModel(t, `{"provider":"anthropic","id":"claude-haiku-4-5"}`)}})
	if err == nil {
		t.Fatal("unverifiable switch was accepted")
	}
}

func TestMergeWindowGuardEnglishNotice(t *testing.T) {
	base := baseSnapshot(t)
	locale := "en"
	_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint, Patch: domain.EditablePatch{Locale: &locale, ButlerModel: rawModel(t, `{"provider":"anthropic","id":"claude-haiku-4-5"}`)}})
	assertMergeCode(t, err, domain.MODEL_SWITCH_REJECTED)
	if !strings.Contains(err.Error(), "Cannot switch the Butler model") {
		t.Fatalf("unexpected notice: %v", err)
	}
}

func TestMergeAllowsCommonGPTFromMillionWindow(t *testing.T) {
	for _, id := range []string{"gpt-6-sol", "gpt-5.2"} {
		t.Run(id, func(t *testing.T) {
			base := baseSnapshot(t)
			_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint, Patch: domain.EditablePatch{ButlerModel: rawModel(t, `{"provider":"openai","id":"`+id+`"}`)}})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMergeRetainsResolvableDepartingCustomModel(t *testing.T) {
	for _, tc := range []struct {
		name          string
		oldDefinition string
		wantError     bool
	}{
		{"removed", "", true},
		{"changed window", `{"id":"old","contextWindow":1000000},`, true},
		{"retained", `{"id":"old","contextWindow":128000},`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := baseSnapshot(t)
			base.ConfigJSON = []byte(`{"schemaVersion":1,"owner":{"telegramUserIds":[42]},"models":{"butler":{"provider":"private","id":"old"},"task":{"provider":"opencode-go","id":"kimi-k3"},"customProviders":[{"id":"private","api":"openai-completions","baseUrl":"https://example.com/v1","models":[{"id":"old","contextWindow":128000}]}]},"mcpServers":[]}`)
			providers := json.RawMessage(`[{"id":"private","api":"openai-completions","baseUrl":"https://example.com/v1","models":[` + tc.oldDefinition + `{"id":"new","contextWindow":128000}]}]`)
			_, err := Merge(base, domain.Change{BaseFingerprint: base.Fingerprint, Patch: domain.EditablePatch{ButlerModel: rawModel(t, `{"provider":"private","id":"new"}`), CustomProviders: &providers}})
			if tc.wantError {
				if err == nil {
					t.Fatal("published an unresolvable departing model")
				}
				assertMergeCode(t, err, domain.MODEL_SWITCH_REJECTED)
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}
