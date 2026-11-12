package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
	"github.com/deskwand/bot/desktop/internal/app"
	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/navigation"
	"github.com/deskwand/bot/desktop/internal/netproxy"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
	"github.com/deskwand/bot/desktop/internal/telemetry"
)

// appVersion is the client version reported in the Cloudflare User-Agent. Keep
// it in sync with desktop/mygo.json.
const appVersion = "0.1.49"

// telemetryBaseURL is the API that receives the client's anonymous usage
// events. It lives in the code rather than in a build flag: a release once
// shipped without the endpoint compiled in, and every report after that
// vanished without a trace. -X main.telemetryBaseURL still overrides it for a
// build pointed at a local server. Development builds report nothing (see main).
var telemetryBaseURL = "https://api.deskwand.com"

const (
	credentialService    = "com.deskwand.bot"
	devCredentialService = "com.deskwand.bot.dev"
	appDataName          = "DeskWand Bot"
	devAppDataName       = "DeskWand Bot Dev"
)

func main() {
	// One process owns the credential vault cache. A second instance would
	// write back its stale copy and erase what the first one stored.
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	// Before any HTTP client is used: a Finder launch has no proxy variables,
	// so follow the system proxy instead.
	netproxy.Install()
	dev := mygo.IsDev()
	dataDir, err := appDataDir(dev)
	if err != nil {
		log.Fatal(err)
	}
	journal, err := deployment.NewJournal(filepath.Join(dataDir, "journal"))
	if err != nil {
		log.Fatal(err)
	}
	targets, err := app.NewFileTargetStore(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	themes, err := app.NewFileThemeStore(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	locale := app.NewLocaleState(themes, nil)
	themes.Language = locale.Current
	targets.Locale = locale.Current
	cache, err := app.NewFileSnapshotCache(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	// Before Run, so the first paint is already in the saved appearance.
	savedTheme, themeErr := themes.Theme()
	if themeErr != nil {
		log.Printf("appearance preference: %v", themeErr)
	}
	mygo.Theme.SetSource(mygo.ThemeSource(savedTheme))
	restoreJournal, err := backup.NewRestoreJournal(filepath.Join(dataDir, "restore"))
	if err != nil {
		log.Fatal(err)
	}
	// Backups default to the app data directory: Documents is a protected folder
	// on macOS, and every upgrade re-signs the bundle, so a default there asks for
	// access again on each update.
	backupSettings, err := app.NewFileBackupSettings(dataDir, filepath.Join(dataDir, "backups"))
	if err != nil {
		log.Fatal(err)
	}
	backupSettings.Locale = locale.Current

	// Anonymous usage reporting. A development build reports nothing: its runs
	// would otherwise look like installs, and its version is not a release.
	var reporter *telemetry.Reporter
	telemetrySettings, telemetryErr := app.NewFileTelemetryStore(dataDir)
	if telemetryErr != nil {
		// Reporting is optional; the client must start without it.
		log.Printf("telemetry state: %v", telemetryErr)
	}
	if telemetrySettings != nil && !dev && telemetryBaseURL != "" {
		reporter = telemetry.New(telemetry.Options{
			BaseURL: telemetryBaseURL,
			Version: appVersion,
			Store:   telemetrySettings,
		})
	}

	credentials := platform.NewSystemCredentialStore(credentialServiceName(dev))
	tokens := auth.NewTokenService(credentials)

	// A missing or untrusted bundle must not prevent the app from starting.
	// Install and Upgrade report RELEASE_NOT_BUNDLED / RELEASE_UNTRUSTED.
	keys, keyErr := release.TrustedReleaseKeys()
	if keyErr != nil {
		// A malformed production key cannot validate any bundle. Treat it
		// like a missing key so the UI receives RELEASE_UNTRUSTED.
		keys = release.TrustedKeys{}
	}
	pkg, releaseErr := release.LoadEmbedded(keys)

	api := cloudflare.New(cloudflare.Options{
		Token:   tokens.Token,
		Version: appVersion,
	})
	locker := deployment.NewTargetLocker()
	lifecycle := deployment.NewLifecycleWithLocker(api, journal, pkg, credentials, nil, locker)
	publish := deployment.NewServiceWithLocker(api, journal, credentials, pkg, nil, locker)
	lifecycle.Locale = locale.Current
	publish.Locale = locale.Current
	entries := app.NewEntryService(app.EntryOptions{
		Publisher:   publish,
		Snapshots:   api,
		Selector:    app.NewActiveChannelSelector(publish, api),
		Credentials: credentials,
		Locale:      locale.Current,
	})

	options := app.ServiceOptions{
		Auth:        tokens,
		Publish:     publish,
		Lifecycle:   lifecycle,
		Entries:     entries,
		Diagnostics: app.NewDiagnosticsServiceWithOptions(api, api, app.DiagnosticsOptions{Locale: locale.Current}),
		Snapshots:   api,
		Scripts:     api,
		Journal:     journal,
		Store:       targets,
		Theme:       themes,
		Locale:      locale,
		Cache:       cache,
		ApplyTheme:  func(source string) { mygo.Theme.SetSource(mygo.ThemeSource(source)) },
		Browser:     platform.NewSystemBrowserOpener(),
		McpBrowser:  platform.NewMcpOAuthBrowserOpener(),
		Credentials: credentials,
		Release:     app.EmbeddedRelease{Pkg: pkg, Err: releaseErr},
		Backup: app.NewBackupRunner(backup.Deps{
			Token: backup.TokenDeps{
				Snapshots:   api,
				Publisher:   publish,
				Credentials: credentials,
			},
			Locker: locker,
			Progress: func(progress backup.Progress) {
				_ = app.BackupProgressEvent.Broadcast(progress)
			},
		}, restoreJournal, filepath.Join(dataDir, "backups")),
		FileDialogs:    mygoFileDialogs{},
		BackupSettings: backupSettings,
	}
	// A typed nil reporter would satisfy the interface and panic on the first
	// report, so a build without one leaves the option itself empty.
	if telemetrySettings != nil {
		options.TelemetrySettings = telemetrySettings
	}
	if reporter != nil {
		options.Telemetry = reporter
	}
	service := app.NewService(options)

	// Auto backup runs on the interval the page configures. It only exists
	// while this process does; the cloud data is untouched when the client is
	// closed, so nothing else can drive it.
	backupScheduler := app.NewBackupScheduler(backupSettings, func(context.Context) error {
		_, err := service.ExportData()
		return err
	})
	go backupScheduler.Run(context.Background())

	// The Binance bundle is only refreshed while the client is open: the
	// requests must leave from this machine's network address.
	exchangeSync := app.NewExchangeSyncScheduler(app.ExchangeSyncStep(service))
	go exchangeSync.Run(context.Background())

	mygo.Use(updater.New(updater.Options{Interval: 6 * time.Hour}))
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: "DeskWand Bot", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout},
			updater.MenuItem(),
			mygo.Separator(),
			{Role: mygo.RoleServices},
			mygo.Separator(),
			{Role: mygo.RoleHide},
			{Role: mygo.RoleHideOthers},
			{Role: mygo.RoleUnhide},
			mygo.Separator(),
			{Role: mygo.RoleQuit},
		}},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleViewMenu},
		{Role: mygo.RoleWindowMenu},
	}))

	mygo.Bind(service)

	// One reporter goroutine for the process lifetime: it pings at startup and
	// every hour after that.
	if reporter != nil {
		go reporter.Start(context.Background())
		if state, err := telemetrySettings.Telemetry(); err == nil {
			if state.LastVersion != "" && state.LastVersion != appVersion {
				reporter.UpdateInstalled()
			}
			if err := telemetrySettings.RecordVersion(appVersion); err != nil {
				log.Printf("telemetry state: %v", err)
			}
		}
	}

	var window *mygo.Window
	mygo.App.OnSecondInstance(func(args []string, workingDir string) {
		if window != nil {
			window.Restore()
			window.Focus()
		}
	})
	mygo.App.WhenReady(func() {
		// The page cannot render without the WebView2 Runtime, and a window
		// that shows nothing is not diagnosable: explain it and quit.
		if guardMissingWebView(runtime.GOOS, platform.Available, func() {
			explainMissingWebView(locale.Current(), mygo.Dialog.Message, mygo.Shell.OpenExternal)
		}, mygo.App.Quit) {
			return
		}
		window = mygo.NewWindow(mygo.WindowOptions{
			Title:     "DeskWand Bot",
			Width:     1024,
			Height:    720,
			MinWidth:  640,
			MinHeight: 480,
			StateKey:  "main",
			URL:       "/",
			// The page follows prefers-color-scheme; its background must match
			// before it paints, or a dark start flashes white.
			BackgroundColor: "light-dark(#ffffff, #0a0a0a)",
		})
		restrictNavigation(window)
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// guardMissingWebView handles the missing runtime before the first window. It
// reports whether it took over the launch: the prompt must be on screen before
// the process ends, so quit runs after prompt returns.
func guardMissingWebView(goos string, available func() bool, prompt, quit func()) bool {
	if goos != "windows" || !platform.NeedsWebViewRuntimePrompt(goos, available()) {
		return false
	}
	// Without the runtime there is no page to show, so the only useful step is
	// to explain why and end the launch: the log says so even when the dialog
	// itself cannot appear.
	log.Printf("WebView2 Runtime is missing on %s; showing the install prompt and quitting", goos)
	defer quit()
	prompt()
	return true
}

// explainMissingWebView offers the download page using injectable native calls.
func explainMissingWebView(locale string, message func(mygo.MessageOptions) (mygo.MessageResult, error), openExternal func(string) error) {
	result, err := message(mygo.MessageOptions{
		Type:    mygo.MessageError,
		Title:   i18n.T(locale, "app.webViewMissingTitle"),
		Message: i18n.T(locale, "app.webViewMissingMessage"),
		Buttons: []string{
			i18n.T(locale, "app.webViewMissingDownload"),
			i18n.T(locale, "app.webViewMissingQuit"),
		},
		DefaultButton: 0,
		CancelButton:  1,
	})
	if err != nil {
		log.Printf("webview prompt: %v", err)
		return
	}
	if result.Button != 0 {
		return
	}
	if err := openExternal(platform.WebViewDownloadURL); err != nil {
		log.Printf("open the WebView2 download page: %v", err)
	}
}

// appDataDir is the per-user application data directory. Development builds
// use a separate directory and credential service so they cannot read or
// change a production installation. Neither file contains credentials.
func appDataDir(dev bool) (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	name := appDataName
	if dev {
		name = devAppDataName
	}
	return filepath.Join(base, name), nil
}

func credentialServiceName(dev bool) string {
	if dev {
		return devCredentialService
	}
	return credentialService
}

// backupFilters limits the backup dialogs to the archive format this client
// writes.
var backupFilters = []mygo.FileFilter{{Name: "DeskWand 备份", Extensions: []string{"zip"}}}

// mygoFileDialogs implements app.FileDialogs with the native dialogs.
type mygoFileDialogs struct{}

func (mygoFileDialogs) ChooseBackupDir() (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Title:             "选择备份目录",
		Directory:         true,
		CreateDirectories: true,
	})
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", nil
	}
	return paths[0], nil
}

func (mygoFileDialogs) OpenBackup() (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Title:   "选择数据备份",
		Filters: backupFilters,
	})
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", nil
	}
	return paths[0], nil
}

// restrictNavigation keeps the privileged window on the bundled frontend. An
// external http(s) link a user clicked opens in the system browser instead of
// loading a remote page that would lose the app's bindings.
func restrictNavigation(window *mygo.Window) {
	page := window.Page()
	dev := mygo.IsDev()
	page.OnWillNavigate(func(event *mygo.NavigateEvent) {
		if navigation.IsBundledFrontendURL(event.URL, dev) {
			return
		}
		event.PreventDefault()
		if event.UserInitiated && navigation.IsExternalHTTPURL(event.URL) {
			target := event.URL
			go func() { _ = mygo.Shell.OpenExternal(target) }()
		}
	})
	page.SetWindowOpenHandler(func(request mygo.WindowOpenRequest) *mygo.WindowOptions {
		if request.UserInitiated && navigation.IsExternalHTTPURL(request.URL) {
			target := request.URL
			go func() { _ = mygo.Shell.OpenExternal(target) }()
		}
		return nil
	})
}
