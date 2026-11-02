package app

import (
	"context"
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
	savePath    string
	saveErr     error
	saveDefault string
	saveCalls   int

	openPath  string
	openErr   error
	openCalls int
}

func (f *fakeFileDialogs) SaveBackup(defaultName string) (string, error) {
	f.saveCalls++
	f.saveDefault = defaultName
	return f.savePath, f.saveErr
}

func (f *fakeFileDialogs) OpenBackup() (string, error) {
	f.openCalls++
	return f.openPath, f.openErr
}

type backupFixture struct {
	*serviceFixture
	backup  *fakeBackup
	dialogs *fakeFileDialogs
}

func newBackupFixture(t *testing.T) *backupFixture {
	t.Helper()
	base := newServiceFixture(t)
	f := &backupFixture{
		serviceFixture: base,
		backup:         &fakeBackup{},
		dialogs:        &fakeFileDialogs{},
	}
	base.service = NewService(ServiceOptions{
		Auth: base.auth, Publish: base.publish, Lifecycle: base.lifecycle,
		Entries: base.entries, Diagnostics: base.diagnostics, Snapshots: base.snapshots,
		Scripts: base.scripts, Journal: base.journal, Store: base.store, Browser: base.browser,
		Release:     base.release,
		Backup:      f.backup,
		FileDialogs: f.dialogs,
		EmitLoginStatus: func(LoginStatusDTO) {
		},
		NewOperationID: func() (string, error) { return "login-op", nil },
		Now:            func() time.Time { return time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC) },
	})
	return f
}

func TestExportDataCancelledDialogReturnsNil(t *testing.T) {
	f := newBackupFixture(t)
	f.dialogs.savePath = ""

	summary, err := f.service.ExportData()
	if err != nil || summary != nil {
		t.Fatalf("ExportData = %#v, %v; want nil, nil", summary, err)
	}
	if f.backup.exportCalls != 0 {
		t.Fatalf("cancelled export called backup %d times", f.backup.exportCalls)
	}
}

func TestExportDataUsesDefaultFileName(t *testing.T) {
	f := newBackupFixture(t)
	f.dialogs.savePath = "/tmp/backup.zip"
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
	if want := "deskwand-backup-deskwand-bot-20261102-100000.zip"; f.dialogs.saveDefault != want {
		t.Fatalf("default name = %q, want %q", f.dialogs.saveDefault, want)
	}
	if summary.Path != "/tmp/backup.zip" || summary.Release != "1.0.0" {
		t.Fatalf("summary = %#v", summary)
	}
	if summary.Rows != 4 || summary.Tasks != 1 || summary.Objects != 1 || summary.Bytes != 42 {
		t.Fatalf("summary counts = %#v", summary)
	}
	if f.backup.exportTarget != f.store.target || f.backup.exportPath != "/tmp/backup.zip" {
		t.Fatalf("export target/path = %#v %q", f.backup.exportTarget, f.backup.exportPath)
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

	saveCalls := f.dialogs.saveCalls
	openCalls := f.dialogs.openCalls

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
	if f.dialogs.saveCalls != saveCalls || f.dialogs.openCalls != openCalls {
		t.Fatalf("busy guard opened a dialog: save=%d open=%d", f.dialogs.saveCalls, f.dialogs.openCalls)
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
	f.dialogs.savePath = "/tmp/backup.zip"
	f.backup.exportWaitContext = true

	if _, err := f.service.ExportData(); err == nil {
		t.Fatal("expected the timed-out export to fail")
	}

	f.backup.exportWaitContext = false
	f.dialogs.savePath = "/tmp/second.zip"
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
