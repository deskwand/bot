package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
)

type fakeBackup struct {
	exportManifest backup.Manifest
	exportErr      error
	exportTarget   domain.Target
	exportPath     string
	exportCalls    int

	inspectManifest backup.Manifest
	inspectErr      error
	inspectPath     string
	inspectCalls    int

	checkErr    error
	checkCalls  int
	checkedWith backup.Manifest

	restoreErr    error
	restoreTarget domain.Target
	restorePath   string
	restoreCalls  int
	// exportWaitContext makes Export block until the service deadline fires,
	// proving the busy guard is released on timeout.
	exportWaitContext bool

	abandonCalls int
	abandonErr   error
	// restoreStarted and restoreBlock let a test hold a restore open while it
	// probes the busy guard. Both are optional.
	restoreStarted chan struct{}
	restoreBlock   chan struct{}

	retryErr         error
	retryUseSnapshot bool
	retryCalls       int

	pending    *backup.RestoreRecord
	pendingErr error
}

func (f *fakeBackup) Export(ctx context.Context, target domain.Target, path string) (backup.Manifest, error) {
	f.exportCalls++
	f.exportTarget = target
	f.exportPath = path
	if f.exportWaitContext {
		<-ctx.Done()
		return backup.Manifest{}, ctx.Err()
	}
	return f.exportManifest, f.exportErr
}

func (f *fakeBackup) Inspect(path string) (backup.Manifest, error) {
	f.inspectCalls++
	f.inspectPath = path
	return f.inspectManifest, f.inspectErr
}

func (f *fakeBackup) CheckVersion(m backup.Manifest, _ domain.Snapshot) error {
	f.checkCalls++
	f.checkedWith = m
	return f.checkErr
}

func (f *fakeBackup) Restore(_ context.Context, target domain.Target, path string) error {
	f.restoreCalls++
	f.restoreTarget = target
	f.restorePath = path
	if f.restoreStarted != nil {
		f.restoreStarted <- struct{}{}
	}
	if f.restoreBlock != nil {
		<-f.restoreBlock
	}
	return f.restoreErr
}

func (f *fakeBackup) Retry(_ context.Context, useSnapshot bool) error {
	f.retryCalls++
	f.retryUseSnapshot = useSnapshot
	return f.retryErr
}

func (f *fakeBackup) Pending() (*backup.RestoreRecord, error) {
	return f.pending, f.pendingErr
}

func (f *fakeBackup) Abandon() error {
	f.abandonCalls++
	return f.abandonErr
}

type fakeFileDialogs struct {
	openPath  string
	openErr   error
	openCalls int

	dirPath  string
	dirErr   error
	dirCalls int
}

func (f *fakeFileDialogs) ChooseBackupDir() (string, error) {
	f.dirCalls++
	return f.dirPath, f.dirErr
}

func (f *fakeFileDialogs) OpenBackup() (string, error) {
	f.openCalls++
	return f.openPath, f.openErr
}

type backupFixture struct {
	*serviceFixture
	backup   *fakeBackup
	dialogs  *fakeFileDialogs
	settings *FileBackupSettings
	appDir   string
	opened   []string
}

func newBackupFixture(t *testing.T) *backupFixture {
	t.Helper()
	base := newServiceFixture(t)
	appDir := t.TempDir()
	settings, err := NewFileBackupSettings(appDir, filepath.Join(appDir, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	f := &backupFixture{
		serviceFixture: base,
		backup:         &fakeBackup{},
		dialogs:        &fakeFileDialogs{},
		settings:       settings,
		appDir:         appDir,
	}
	base.service = NewService(ServiceOptions{
		Auth: base.auth, Publish: base.publish, Lifecycle: base.lifecycle,
		Entries: base.entries, Diagnostics: base.diagnostics, Snapshots: base.snapshots,
		Scripts: base.scripts, Journal: base.journal, Store: base.store, Browser: base.browser,
		Release:        base.release,
		Backup:         f.backup,
		FileDialogs:    f.dialogs,
		BackupSettings: settings,
		OpenPath: func(path string) error {
			f.opened = append(f.opened, path)
			return nil
		},
		EmitLoginStatus: func(LoginStatusDTO) {
		},
		NewOperationID: func() (string, error) { return "login-op", nil },
		Now:            func() time.Time { return time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC) },
	})
	return f
}

func TestExportDataWritesToConfiguredDirWithoutDialog(t *testing.T) {
	f := newBackupFixture(t)
	dir := t.TempDir()
	if _, err := f.settings.Save(BackupSettingsEditDTO{
		Dir: dir, Auto: false, IntervalHours: 24, Keep: 5,
	}); err != nil {
		t.Fatal(err)
	}
	f.backup.exportManifest = backup.Manifest{
		ExportedAt: time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC),
		Release:    "1.0.0",
		DurableObjects: []backup.DOManifest{
			{DORef: backup.DORef{DO: "butler"}, Rows: map[string]int64{"memories": 3}},
			{DORef: backup.DORef{DO: "task", ID: "t1"}, Rows: map[string]int64{"meta": 1}},
		},
		R2: backup.R2Manifest{
			Objects: []backup.R2Item{{Key: "a.png", Entry: "r2/000001", Size: 42}},
			Bytes:   42,
		},
	}

	summary, err := f.service.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, "deskwand-backup-deskwand-bot-20261102-100000.zip")
	if summary.Path != want || summary.Release != "1.0.0" {
		t.Fatalf("summary = %#v", summary)
	}
	if summary.Rows != 4 || summary.Tasks != 1 || summary.Objects != 1 || summary.Bytes != 42 {
		t.Fatalf("summary counts = %#v", summary)
	}
	if f.backup.exportTarget != f.store.target || f.backup.exportPath != want {
		t.Fatalf("export target/path = %#v %q", f.backup.exportTarget, f.backup.exportPath)
	}
	if f.dialogs.openCalls != 0 || f.dialogs.dirCalls != 0 {
		t.Fatalf("export opened a dialog: open=%d dir=%d", f.dialogs.openCalls, f.dialogs.dirCalls)
	}
	settings, err := f.settings.Settings()
	if err != nil {
		t.Fatal(err)
	}
	if settings.LastSuccessAt != "2026-11-02T10:00:00Z" || settings.LastSuccessPath != want {
		t.Fatalf("last run = %#v", settings)
	}
}

func TestChooseBackupReportsVersionProblem(t *testing.T) {
	f := newBackupFixture(t)
	f.dialogs.openPath = "/tmp/backup.zip"
	f.snapshots.snapshot.ReleaseVersion = "1.3.0"
	f.backup.inspectManifest = backup.Manifest{Release: "1.2.0"}
	f.backup.checkErr = domain.Error{Code: backup.CodeBackupVersionMismatch, Message: "version"}

	preview, err := f.service.ChooseBackup()
	if err != nil {
		t.Fatalf("ChooseBackup error = %v, want nil", err)
	}
	if preview.Problem != backup.CodeBackupVersionMismatch {
		t.Fatalf("problem = %q", preview.Problem)
	}
	if preview.Summary.Release != "1.2.0" || preview.CurrentRelease != "1.3.0" {
		t.Fatalf("preview = %#v", preview)
	}
	if f.backup.inspectPath != "/tmp/backup.zip" {
		t.Fatalf("inspect path = %q", f.backup.inspectPath)
	}
}

func TestRestoreDataRequiresChosenBackup(t *testing.T) {
	f := newBackupFixture(t)

	err := f.service.RestoreData()
	if !hasCode(err, backup.CodeBackupInvalid) {
		t.Fatalf("RestoreData error = %v, want %s", err, backup.CodeBackupInvalid)
	}
	if f.backup.restoreCalls != 0 {
		t.Fatalf("restore called %d times without a chosen backup", f.backup.restoreCalls)
	}
}

func TestRestoreDataUsesRememberedPath(t *testing.T) {
	f := newBackupFixture(t)
	f.dialogs.openPath = "/tmp/chosen.zip"
	f.backup.inspectManifest = backup.Manifest{Release: "1.0.0"}
	if _, err := f.service.ChooseBackup(); err != nil {
		t.Fatal(err)
	}

	if err := f.service.RestoreData(); err != nil {
		t.Fatal(err)
	}
	if f.backup.restorePath != "/tmp/chosen.zip" || f.backup.restoreTarget != f.store.target {
		t.Fatalf("restore target/path = %#v %q", f.backup.restoreTarget, f.backup.restorePath)
	}
}

func TestPendingRestoreMapsRecord(t *testing.T) {
	f := newBackupFixture(t)
	f.backup.pending = &backup.RestoreRecord{
		OperationID:  "op-restore",
		BackupPath:   "/tmp/backup.zip",
		SnapshotPath: "/tmp/pre-restore.zip",
		State:        "failed",
		FailureCode:  backup.CodeRestoreSnapshotFailed,
	}

	pending, err := f.service.PendingRestore()
	if err != nil {
		t.Fatal(err)
	}
	want := PendingRestoreDTO{
		OperationID:  "op-restore",
		BackupPath:   "/tmp/backup.zip",
		SnapshotPath: "/tmp/pre-restore.zip",
		State:        "failed",
		FailureCode:  backup.CodeRestoreSnapshotFailed,
	}
	if pending == nil || *pending != want {
		t.Fatalf("pending = %#v, want %#v", pending, want)
	}
}

func TestSecretStatusesHideAdminToken(t *testing.T) {
	f := newBackupFixture(t)
	f.snapshots.snapshot = serviceSnapshot()
	f.snapshots.snapshot.ReleaseVersion = "1.3.0"
	f.snapshots.snapshot.SecretNames = append(f.snapshots.snapshot.SecretNames, backup.AdminTokenSecret)
	f.release.manifest.ResourceTemplate.SecretNames = append(
		f.release.manifest.ResourceTemplate.SecretNames, backup.AdminTokenSecret)

	config, err := f.service.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, secret := range config.Secrets {
		found[secret.Name] = true
	}
	if found[backup.AdminTokenSecret] {
		t.Fatalf("ADMIN_TOKEN leaked into the secret list: %#v", config.Secrets)
	}
	if !found["ANTHROPIC_API_KEY"] {
		t.Fatalf("other secrets were filtered out: %#v", config.Secrets)
	}
}

func TestPublishConfigRejectsAdminTokenEdit(t *testing.T) {
	f := newBackupFixture(t)

	_, err := f.service.PublishConfig(ConfigEditDTO{
		BaseFingerprint: "fingerprint-1",
		Secrets: []SecretEditDTO{{
			Name:      backup.AdminTokenSecret,
			Operation: domain.SecretReplace,
			Value:     "manual",
		}},
	})
	if !hasCode(err, domain.INVALID_SECRET_EDIT) {
		t.Fatalf("PublishConfig error = %v, want %s", err, domain.INVALID_SECRET_EDIT)
	}
	if len(f.publish.changes) != 0 {
		t.Fatalf("rejected edit reached publish: %#v", f.publish.changes)
	}
}

func TestBackupRunsOneOperationAtATime(t *testing.T) {
	f := newBackupFixture(t)
	f.dialogs.openPath = "/tmp/chosen.zip"
	f.backup.inspectManifest = backup.Manifest{Release: "1.0.0"}
	if _, err := f.service.ChooseBackup(); err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	unblock := make(chan struct{})
	done := make(chan error, 1)
	f.backup.restoreStarted = started
	f.backup.restoreBlock = unblock
	go func() { done <- f.service.RestoreData() }()
	<-started

	openCalls := f.dialogs.openCalls
	dirCalls := f.dialogs.dirCalls

	if _, err := f.service.ExportData(); !hasCode(err, backup.CodeMaintenanceBusy) {
		t.Fatalf("ExportData while busy = %v, want %s", err, backup.CodeMaintenanceBusy)
	}
	if err := f.service.RestoreData(); !hasCode(err, backup.CodeMaintenanceBusy) {
		t.Fatalf("RestoreData while busy = %v, want %s", err, backup.CodeMaintenanceBusy)
	}
	if err := f.service.RetryRestore(false); !hasCode(err, backup.CodeMaintenanceBusy) {
		t.Fatalf("RetryRestore while busy = %v, want %s", err, backup.CodeMaintenanceBusy)
	}
	if err := f.service.AbandonPendingRestore(); !hasCode(err, backup.CodeMaintenanceBusy) {
		t.Fatalf("AbandonPendingRestore while busy = %v, want %s", err, backup.CodeMaintenanceBusy)
	}
	if _, err := f.service.ChooseBackup(); !hasCode(err, backup.CodeMaintenanceBusy) {
		t.Fatalf("ChooseBackup while busy = %v, want %s", err, backup.CodeMaintenanceBusy)
	}
	if f.dialogs.openCalls != openCalls || f.dialogs.dirCalls != dirCalls {
		t.Fatalf("busy guard opened a dialog: open=%d dir=%d", f.dialogs.openCalls, f.dialogs.dirCalls)
	}

	close(unblock)
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	if err := f.service.RestoreData(); !hasCode(err, backup.CodeBackupInvalid) {
		t.Fatalf("second RestoreData = %v, want %s", err, backup.CodeBackupInvalid)
	}
	if f.backup.restoreCalls != 1 {
		t.Fatalf("restore called %d times, want 1", f.backup.restoreCalls)
	}
}

func TestChooseBackupFailureForgetsPreviousChoice(t *testing.T) {
	f := newBackupFixture(t)
	f.dialogs.openPath = "/tmp/first.zip"
	f.backup.inspectManifest = backup.Manifest{Release: "1.0.0"}
	if _, err := f.service.ChooseBackup(); err != nil {
		t.Fatal(err)
	}

	f.dialogs.openPath = "/tmp/second.zip"
	f.backup.inspectErr = domain.Error{Code: backup.CodeBackupInvalid, Message: "broken"}
	if _, err := f.service.ChooseBackup(); !hasCode(err, backup.CodeBackupInvalid) {
		t.Fatalf("ChooseBackup error = %v, want %s", err, backup.CodeBackupInvalid)
	}

	if err := f.service.RestoreData(); !hasCode(err, backup.CodeBackupInvalid) {
		t.Fatalf("RestoreData after failed Inspect = %v, want %s", err, backup.CodeBackupInvalid)
	}
	if f.backup.restoreCalls != 0 {
		t.Fatalf("restore used a stale path %q", f.backup.restorePath)
	}
}

func TestAbandonPendingRestoreClearsJournal(t *testing.T) {
	f := newBackupFixture(t)
	if err := f.service.AbandonPendingRestore(); err != nil {
		t.Fatal(err)
	}
	if f.backup.abandonCalls != 1 {
		t.Fatalf("abandon calls = %d, want 1", f.backup.abandonCalls)
	}
}

func TestBackupBusyGuardReleasesAfterOperationTimeout(t *testing.T) {
	previous := backupOperationTimeout
	backupOperationTimeout = 50 * time.Millisecond
	defer func() { backupOperationTimeout = previous }()

	f := newBackupFixture(t)
	f.backup.exportWaitContext = true

	if _, err := f.service.ExportData(); err == nil {
		t.Fatal("expected the timed-out export to fail")
	}

	f.backup.exportWaitContext = false
	if _, err := f.service.ExportData(); err != nil {
		t.Fatalf("busy guard stayed set after the timeout: %v", err)
	}
}

func TestVisibleSecretNamesHidesAdminToken(t *testing.T) {
	got := visibleSecretNames([]string{"TELEGRAM_BOT_TOKEN", backup.AdminTokenSecret, "WECHAT_CREDENTIALS"})
	want := []string{"TELEGRAM_BOT_TOKEN", "WECHAT_CREDENTIALS"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("visibleSecretNames = %v, want %v", got, want)
	}
}

func TestImportPreviewHidesAdminTokenName(t *testing.T) {
	f := newBackupFixture(t)
	f.lifecycle.inspectPreview = deployment.ImportPreview{
		SecretNames:         []string{"TELEGRAM_BOT_TOKEN", backup.AdminTokenSecret},
		PreserveSecretNames: []string{backup.AdminTokenSecret, "WECHAT_CREDENTIALS"},
	}

	preview, err := f.service.InspectImport()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range append(append([]string{}, preview.SecretNames...), preview.PreserveSecretNames...) {
		if name == backup.AdminTokenSecret {
			t.Fatalf("import preview exposed %s", backup.AdminTokenSecret)
		}
	}
}

func TestExportDataPrunesOldBackups(t *testing.T) {
	f := newBackupFixture(t)
	dir := t.TempDir()
	for _, name := range []string{
		"deskwand-backup-deskwand-bot-20260101-000000.zip",
		"deskwand-backup-deskwand-bot-20260201-000000.zip",
		"deskwand-backup-deskwand-bot-20260301-000000.zip",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.settings.Save(BackupSettingsEditDTO{
		Dir: dir, Auto: true, IntervalHours: 6, Keep: 1,
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := f.service.ExportData(); err != nil {
		t.Fatal(err)
	}

	names, err := backupFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	// The fake writer does not touch the filesystem, so the three files above
	// are what pruning sees: keep=1 leaves the newest of them.
	if len(names) != 1 || names[0] != "deskwand-backup-deskwand-bot-20260301-000000.zip" {
		t.Fatalf("after prune = %v", names)
	}
}

func TestExportDataReportsUnwritableDir(t *testing.T) {
	f := newBackupFixture(t)
	// Write the settings file directly: Save would reject this folder, which is
	// exactly the state a folder that later became read-only leaves behind.
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(blocker, "child")
	data, err := json.Marshal(backupSettingsFile{Dir: broken, IntervalHours: 24, Keep: 5})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.appDir, "backup.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := f.service.ExportData(); !hasCode(err, backup.CodeBackupSettingsInvalid) {
		t.Fatalf("ExportData = %v, want %s", err, backup.CodeBackupSettingsInvalid)
	}
	if f.backup.exportCalls != 0 {
		t.Fatalf("export ran %d times against an unusable folder", f.backup.exportCalls)
	}
}

func TestOpenBackupFolderCreatesAndOpens(t *testing.T) {
	f := newBackupFixture(t)
	dir := filepath.Join(t.TempDir(), "DeskWand 备份")
	if _, err := f.settings.Save(BackupSettingsEditDTO{
		Dir: dir, Auto: false, IntervalHours: 24, Keep: 5,
	}); err != nil {
		t.Fatal(err)
	}

	if err := f.service.OpenBackupFolder(); err != nil {
		t.Fatal(err)
	}
	if len(f.opened) != 1 || f.opened[0] != dir {
		t.Fatalf("opened = %v, want %q", f.opened, dir)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("folder not created: %v", err)
	}
}

func TestChooseBackupDirStoresSelection(t *testing.T) {
	f := newBackupFixture(t)
	dir := t.TempDir()
	f.dialogs.dirPath = dir

	settings, err := f.service.ChooseBackupDir()
	if err != nil {
		t.Fatal(err)
	}
	if settings.Dir != dir {
		t.Fatalf("dir = %q, want %q", settings.Dir, dir)
	}

	// A cancelled dialog keeps the previous value and reports no error.
	f.dialogs.dirPath = ""
	settings, err = f.service.ChooseBackupDir()
	if err != nil {
		t.Fatal(err)
	}
	if settings.Dir != dir {
		t.Fatalf("cancelled dialog changed the dir to %q", settings.Dir)
	}
}

func TestSaveBackupSettingsRejectsBadValues(t *testing.T) {
	f := newBackupFixture(t)
	if _, err := f.service.SaveBackupSettings(BackupSettingsEditDTO{
		Dir: "relative", Auto: true, IntervalHours: 24, Keep: 5,
	}); !hasCode(err, backup.CodeBackupSettingsInvalid) {
		t.Fatalf("SaveBackupSettings = %v, want %s", err, backup.CodeBackupSettingsInvalid)
	}
}
