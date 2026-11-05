package app

import (
	"context"
	"errors"
	"testing"

	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
)

// setServiceLocale replaces the language the service resolves for this run.
func setServiceLocale(service *Service, locale string) {
	service.locale = NewLocaleState(&fakeLocaleStore{source: locale}, nil)
}

func domainMessage(t *testing.T, err error) string {
	t.Helper()
	var domainErr domain.Error
	if !errors.As(err, &domainErr) {
		t.Fatalf("error = %v; want a domain.Error", err)
	}
	return domainErr.Message
}

// assertLocalized checks the English text has no Chinese and the Chinese text
// is unchanged from before the migration.
func assertLocalized(t *testing.T, locale, label, zh, got string) {
	t.Helper()
	if got == "" {
		t.Fatalf("%s: empty message", label)
	}
	if locale == i18n.EN {
		i18ntest.NoHan(t, label, got)
		return
	}
	if got != zh {
		t.Fatalf("%s = %q; want %q", label, got, zh)
	}
}

func TestSetThemeErrorFollowsLocale(t *testing.T) {
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		service := NewService(ServiceOptions{})
		setServiceLocale(service, locale)
		message := domainMessage(t, service.SetTheme("bogus"))
		assertLocalized(t, locale, "SetTheme", "外观设置无效", message)
	}
}

func TestBackupSettingsErrorsFollowLocale(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name  string
		input BackupSettingsEditDTO
		zh    string
	}{
		{"empty dir", BackupSettingsEditDTO{Dir: "", IntervalHours: 24, Keep: 5}, "备份目录不能为空"},
		{"relative dir", BackupSettingsEditDTO{Dir: "relative", IntervalHours: 24, Keep: 5}, "备份目录必须是绝对路径"},
		{"interval", BackupSettingsEditDTO{Dir: dir, IntervalHours: 2, Keep: 5}, "备份间隔只能是 1、6 或 24 小时"},
		{"keep", BackupSettingsEditDTO{Dir: dir, IntervalHours: 24, Keep: 3}, "保留份数只能是 1、5 或 10"},
	}
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		for _, test := range cases {
			t.Run(locale+"/"+test.name, func(t *testing.T) {
				appDir := t.TempDir()
				settings, err := NewFileBackupSettings(appDir, appDir)
				if err != nil {
					t.Fatal(err)
				}
				settings.Locale = func() string { return locale }
				service := NewService(ServiceOptions{BackupSettings: settings})
				setServiceLocale(service, locale)

				_, err = service.SaveBackupSettings(test.input)
				assertLocalized(t, locale, test.name, test.zh, domainMessage(t, err))
			})
		}
	}
}

func TestBackupBusyFollowsLocale(t *testing.T) {
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		fixture := newBackupFixture(t)
		setServiceLocale(fixture.service, locale)
		fixture.settings.Locale = func() string { return locale }
		fixture.service.backupBusy = true

		_, err := fixture.service.ExportData()
		assertLocalized(t, locale, "export busy", "已有备份或恢复任务在进行", domainMessage(t, err))
	}
}

func TestDiagnosticsWarningsFollowLocale(t *testing.T) {
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		service := NewDiagnosticsServiceWithOptions(
			&fakeSnapshots{snapshot: serviceSnapshot()},
			nil,
			DiagnosticsOptions{Locale: func() string { return locale }},
		)
		report, err := service.Status(context.Background(), domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName})
		if err != nil {
			t.Fatal(err)
		}
		if len(report.Warnings) != 1 {
			t.Fatalf("warnings = %v", report.Warnings)
		}
		assertLocalized(t, locale, "diagnostics warning", "未连接云端日志查询；状态可能为未知", report.Warnings[0])
	}
}

func TestSelectEntryWarningFollowsLocale(t *testing.T) {
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
		selector := &fakeSelector{}
		service := NewEntryService(EntryOptions{
			Publisher:   publisher,
			Snapshots:   publisher,
			Selector:    selector,
			Credentials: platform.NewMemoryCredentialStore(),
			Telegram:    func(string) TelegramAPI { return &fakeTelegram{} },
			Locale:      func() string { return locale },
		})

		selection, err := service.SelectEntry(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, EntryWeChat)
		if err != nil {
			t.Fatal(err)
		}
		assertLocalized(t, locale, "entry warning", "所选入口尚未配置；选择已保存，但不会自动改用另一个入口。", selection.Warning)
	}
}

func TestInstallOwnerWarningFollowsLocale(t *testing.T) {
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		fixture := newServiceFixture(t)
		service := NewDeploymentsService(fixture.lifecycle, fixture.journal, release.Package{})
		service.Locale = func() string { return locale }

		summary, err := service.InstallDeployment(context.Background(), InstallDeploymentInput{
			AccountID:     serviceAccountID,
			WorkerName:    serviceWorkerName,
			BucketName:    "deskwand-bot",
			ButlerModel:   ModelRefInput{Provider: "anthropic", ID: "claude-sonnet-5-5"},
			TaskModel:     ModelRefInput{Provider: "opencode-go", ID: "kimi-k3"},
			ActiveChannel: EntryTelegram,
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(summary.Warnings) != 1 {
			t.Fatalf("warnings = %v", summary.Warnings)
		}
		assertLocalized(t, locale, "install owner warning", "owner 列表为空：Worker 会忽略所有消息，直到在设置中发布 owner。", summary.Warnings[0])
	}
}

func TestServiceErrorsFollowLocale(t *testing.T) {
	type scenario struct {
		name string
		zh   string
		err  func(t *testing.T, locale string) error
	}
	scenarios := []scenario{
		{
			name: "service unavailable",
			zh:   "应用服务未完成初始化",
			err: func(_ *testing.T, locale string) error {
				service := NewService(ServiceOptions{})
				setServiceLocale(service, locale)
				_, err := service.GetConfig()
				return err
			},
		},
		{
			name: "auth required",
			zh:   "请先连接 Cloudflare 账户",
			err: func(t *testing.T, locale string) error {
				fixture := newServiceFixture(t)
				fixture.auth.connection = auth.Connection{State: auth.StateDisconnected}
				fixture.service = fixture.buildService()
				setServiceLocale(fixture.service, locale)
				_, err := fixture.service.GetConfig()
				return err
			},
		},
		{
			name: "target not selected",
			zh:   "请先选择一个 Worker 部署",
			err: func(t *testing.T, locale string) error {
				fixture := newServiceFixture(t)
				fixture.store.ok = false
				fixture.service = fixture.buildService()
				setServiceLocale(fixture.service, locale)
				_, err := fixture.service.GetConfig()
				return err
			},
		},
		{
			name: "account mismatch",
			zh:   "已选择的部署属于另一个 Cloudflare 账户；请重新选择",
			err: func(t *testing.T, locale string) error {
				fixture := newServiceFixture(t)
				fixture.store.target = domain.Target{AccountID: "another-account", ScriptName: serviceWorkerName}
				fixture.service = fixture.buildService()
				setServiceLocale(fixture.service, locale)
				_, err := fixture.service.GetConfig()
				return err
			},
		},
		{
			name: "release not bundled",
			zh:   "此客户端未内置 Worker 发布包",
			err: func(t *testing.T, locale string) error {
				fixture := newServiceFixture(t)
				fixture.service.release = nil
				setServiceLocale(fixture.service, locale)
				_, err := fixture.service.Upgrade()
				return err
			},
		},
		{
			name: "cloudflare login not found",
			zh:   "没有等待选择账号的登录",
			err: func(_ *testing.T, locale string) error {
				service := NewService(ServiceOptions{})
				setServiceLocale(service, locale)
				return service.ConfirmCloudflareAccount("account")
			},
		},
	}
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		for _, test := range scenarios {
			t.Run(locale+"/"+test.name, func(t *testing.T) {
				err := test.err(t, locale)
				if err == nil {
					t.Fatal("expected an error")
				}
				assertLocalized(t, locale, test.name, test.zh, domainMessage(t, err))
			})
		}
	}
}
