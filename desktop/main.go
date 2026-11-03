package main

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
	"github.com/deskwand/bot/desktop/internal/app"
	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/navigation"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
)

// appVersion is the client version reported in the Cloudflare User-Agent. Keep
// it in sync with desktop/mygo.json.
const appVersion = "0.1.3"

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
	restoreJournal, err := backup.NewRestoreJournal(filepath.Join(dataDir, "restore"))
	if err != nil {
		log.Fatal(err)
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
	entries := app.NewEntryService(app.EntryOptions{
		Publisher:   publish,
		Snapshots:   api,
		Selector:    app.NewActiveChannelSelector(publish, api),
		Credentials: credentials,
		PublicBaseURLFor: func(ctx context.Context, target domain.Target) (string, error) {
			snapshot, err := api.ReadSnapshot(ctx, target)
			if err != nil {
				return "", err
			}
			return app.ReadPlainVar(snapshot.SettingsJSON, "PUBLIC_BASE_URL"), nil
		},
	})

	service := app.NewService(app.ServiceOptions{
		Auth:        tokens,
		Publish:     publish,
		Lifecycle:   lifecycle,
		Entries:     entries,
		Diagnostics: app.NewDiagnosticsService(api, api),
		Snapshots:   api,
		Scripts:     api,
		Journal:     journal,
		Store:       targets,
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
		FileDialogs: mygoFileDialogs{},
	})

	mygo.Bind(service)

	var window *mygo.Window
	mygo.App.OnSecondInstance(func(args []string, workingDir string) {
		if window != nil {
			window.Restore()
			window.Focus()
		}
	})
	mygo.App.WhenReady(func() {
		window = mygo.NewWindow(mygo.WindowOptions{
			Title:     "DeskWand Bot",
			Width:     1024,
			Height:    720,
			MinWidth:  640,
			MinHeight: 480,
			StateKey:  "main",
			URL:       "/",
		})
		restrictNavigation(window)
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
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

func (mygoFileDialogs) SaveBackup(defaultName string) (string, error) {
	return mygo.Dialog.Save(mygo.SaveDialogOptions{
		Title:             "保存数据备份",
		DefaultPath:       defaultName,
		Filters:           backupFilters,
		CreateDirectories: true,
	})
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
