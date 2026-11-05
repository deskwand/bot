package deployment

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
)

func TestUpgradeCarriesLocale(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelWeChat, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.releaseVersion = "1.0.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}
	f.Lifecycle.Locale = func() string { return "en" }

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if len(f.API.creates) != 1 {
		t.Fatalf("create calls = %d", len(f.API.creates))
	}
	if !bytes.Contains(f.API.creates[0].Plan.ConfigJSON, []byte(`"locale":"en"`)) {
		t.Fatalf("upgraded config has no locale: %s", f.API.creates[0].Plan.ConfigJSON)
	}
}

func TestSameConfigWithLocale(t *testing.T) {
	const (
		base   = `{"schemaVersion":1,"owner":{"telegramUserIds":[]},"models":{"butler":{"provider":"p","id":"m"},"task":{"provider":"p","id":"m"}},"mcpServers":[]}`
		withEn = `{"schemaVersion":1,"owner":{"telegramUserIds":[]},"models":{"butler":{"provider":"p","id":"m"},"task":{"provider":"p","id":"m"}},"mcpServers":[],"locale":"en"}`
		withFr = `{"schemaVersion":1,"owner":{"telegramUserIds":[]},"models":{"butler":{"provider":"p","id":"m"},"task":{"provider":"p","id":"m"}},"mcpServers":[],"locale":"fr"}`
		withZh = `{"schemaVersion":1,"owner":{"telegramUserIds":[]},"models":{"butler":{"provider":"p","id":"m"},"task":{"provider":"p","id":"m"}},"mcpServers":[],"locale":"zh"}`
	)
	cases := []struct {
		name   string
		before string
		after  string
		want   bool
	}{
		{"adds en", base, withEn, true},
		{"rejects fr", base, withFr, false},
		{"rejects other changes", base, strings.Replace(withEn, `"telegramUserIds":[]`, `"telegramUserIds":[1]`, 1), false},
		{"replaces zh with en", withZh, withEn, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := sameConfigWithLocale([]byte(testCase.before), []byte(testCase.after)); got != testCase.want {
				t.Fatalf("sameConfigWithLocale() = %v, want %v", got, testCase.want)
			}
		})
	}
}
