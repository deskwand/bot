package deployment

import (
	"context"
	"slices"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
	"github.com/deskwand/bot/desktop/internal/release"
)

func assertStepsNoHan(t *testing.T, steps []domain.Step) {
	t.Helper()
	for _, step := range steps {
		i18ntest.NoHan(t, "step "+step.ID, step.Message)
	}
}

func stepMessages(steps []domain.Step) []string {
	messages := make([]string, 0, len(steps))
	for _, step := range steps {
		messages = append(messages, step.Message)
	}
	return messages
}

func applyWithLocale(t *testing.T, locale func() string) []domain.Step {
	t.Helper()
	f := newPublishFixture(t)
	f.Service.Locale = locale
	result, err := f.Service.Apply(context.Background(), f.target(), f.change())
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StatePublished)
	record, err := f.Journal.Load(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	return record.Steps
}

func previewWithLocale(t *testing.T, locale func() string) []domain.Step {
	t.Helper()
	f := newPublishFixture(t)
	f.Service.Locale = locale
	steps, err := f.Service.Preview(context.Background(), f.target(), f.change())
	if err != nil {
		t.Fatal(err)
	}
	return steps
}

func TestStepMessagesFollowLocale(t *testing.T) {
	t.Run("en", func(t *testing.T) {
		assertStepsNoHan(t, applyWithLocale(t, func() string { return "en" }))
		assertStepsNoHan(t, previewWithLocale(t, func() string { return "en" }))
	})
	t.Run("nil", func(t *testing.T) {
		steps := applyWithLocale(t, nil)
		want := []string{"新版本已上传", "100% 流量已指向新版本", "已读取部署确认活动版本"}
		if got := stepMessages(steps); !slices.Equal(got, want) {
			t.Fatalf("apply step messages = %q, want %q", got, want)
		}
	})
}

func TestInstallStepsFollowLocale(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.Lifecycle.Locale = func() string { return "en" }

	result, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	record, err := f.Journal.Load(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertStepsNoHan(t, record.Steps)
}

func TestUpgradeStepsFollowLocale(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "0.9.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	v1Only := pkg.Manifest().ResourceTemplate
	v1Only.DurableObjects = v1Only.DurableObjects[:2]
	f.API.settingsJSON = lifecycleSettings(t, v1Only, f.API.configJSON, ChannelTelegram, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.releaseVersion = "0.9.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v1"}}
	f.Lifecycle.Locale = func() string { return "en" }

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	record, err := f.Journal.Load(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertStepsNoHan(t, record.Steps)
}

func TestImportStepsFollowLocale(t *testing.T) {
	t.Run("confirm", func(t *testing.T) {
		pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
		f := newLifecycleFixture(t, pkg)
		f.API.configJSON = lifecycleConfig(t, "")
		f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelWeChat, true)
		f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
		f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}
		f.Lifecycle.Locale = func() string { return "en" }

		owner := []int64{42}
		result, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{TelegramUserIDs: &owner})
		if err != nil {
			t.Fatal(err)
		}
		assertLifecycleState(t, result, StatePublished)
		record, err := f.Journal.Load(result.OperationID)
		if err != nil {
			t.Fatal(err)
		}
		assertStepsNoHan(t, record.Steps)
	})

	t.Run("legacy warnings", func(t *testing.T) {
		pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
		f := newLifecycleFixture(t, pkg)
		f.API.configJSON = nil
		f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, nil, ChannelWeChat, false)
		f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
		f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}
		f.Lifecycle.Locale = func() string { return "en" }

		preview, err := f.Lifecycle.InspectImport(context.Background(), f.target())
		if err != nil {
			t.Fatal(err)
		}
		if len(preview.Warnings) == 0 {
			t.Fatal("legacy preview has no warnings")
		}
		for _, warning := range preview.Warnings {
			i18ntest.NoHan(t, "import warning", warning)
		}
	})

	t.Run("plaintext warnings", func(t *testing.T) {
		pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
		f := newLifecycleFixture(t, pkg)
		f.API.configJSON = lifecycleConfig(t, "Bearer sk-live-example-value")
		f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
		f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
		f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}
		f.Lifecycle.Locale = func() string { return "en" }

		preview, err := f.Lifecycle.InspectImport(context.Background(), f.target())
		assertCode(t, err, CodePlaintextSecretDetected)
		i18ntest.NoHan(t, "plaintext error", err.Error())
		for _, warning := range preview.Warnings {
			i18ntest.NoHan(t, "import warning", warning)
		}
	})

	t.Run("upgrade first error", func(t *testing.T) {
		pkg := lifecyclePackage(t, "1.0.0", "0.9.0", nil)
		f := newLifecycleFixture(t, pkg)
		f.API.configJSON = lifecycleConfig(t, "")
		f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
		f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
		f.API.releaseVersion = "0.9.0"
		f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v1"}}
		f.Lifecycle.Locale = func() string { return "en" }

		owner := []int64{}
		_, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{TelegramUserIDs: &owner})
		assertCode(t, err, CodeUpgradeRequiredFirst)
		i18ntest.NoHan(t, "upgrade first error", err.Error())
	})
}

func TestReleaseVersionErrorsFollowLocale(t *testing.T) {
	pkg := releasePackageFixture(t)
	cases := []struct {
		name     string
		snapshot domain.Snapshot
		pkg      release.Package
	}{
		{name: "unknown release", snapshot: domain.Snapshot{}, pkg: pkg},
		{name: "missing client version", snapshot: domain.Snapshot{ReleaseVersion: "3.0.0"}, pkg: release.Package{}},
		{name: "incomparable", snapshot: domain.Snapshot{ReleaseVersion: "not-a-version"}, pkg: pkg},
		{name: "newer cloud", snapshot: domain.Snapshot{ReleaseVersion: "4.0.0"}, pkg: pkg},
		{name: "older cloud", snapshot: domain.Snapshot{ReleaseVersion: "2.0.0"}, pkg: pkg},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			service := &Service{pkg: testCase.pkg, Locale: func() string { return "en" }}
			err := service.checkReleaseVersion(testCase.snapshot, false)
			if err == nil {
				t.Fatal("checkReleaseVersion() = nil, want an error")
			}
			i18ntest.NoHan(t, "release version error", err.Error())
		})
	}
}

func TestPublishCancelledMessageFollowsLocale(t *testing.T) {
	cancelledSteps := func(t *testing.T, locale func() string) []domain.Step {
		t.Helper()
		f := newPublishFixture(t)
		f.Service.Locale = locale
		ctx, cancel := context.WithCancel(context.Background())
		f.API.mu.Lock()
		f.API.onCreate = cancel
		f.API.mu.Unlock()
		result, err := f.Service.Apply(ctx, f.target(), f.change())
		if err == nil {
			t.Fatal("cancelled publish returned success")
		}
		assertState(t, result, StateCancelled)
		record, err := f.Journal.Load(result.OperationID)
		if err != nil {
			t.Fatal(err)
		}
		return record.Steps
	}

	t.Run("en", func(t *testing.T) {
		steps := cancelledSteps(t, func() string { return "en" })
		i18ntest.NoHan(t, "cancelled publish step", steps[stepActivate].Message)
	})
	t.Run("nil", func(t *testing.T) {
		steps := cancelledSteps(t, nil)
		if got, want := steps[stepActivate].Message, "发布已取消，未创建新部署"; got != want {
			t.Fatalf("cancelled publish step = %q, want %q", got, want)
		}
	})
}
