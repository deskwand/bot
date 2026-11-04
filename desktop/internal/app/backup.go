package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// hiddenSecretName is the Worker secret the client manages on its own. It is
// never listed in the configuration UI and cannot be edited there.
const hiddenSecretName = backup.AdminTokenSecret

// backupOperationTimeout bounds one export or restore end to end. Each HTTP
// request has its own shorter timeout; this is the outer guard that lets the
// local busy flag clear even if a dependency misbehaves.
var backupOperationTimeout = 30 * time.Minute

func (s *Service) backupContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), backupOperationTimeout)
}

func visibleSecretNames(names []string) []string {
	visible := make([]string, 0, len(names))
	for _, name := range names {
		if name == hiddenSecretName {
			continue
		}
		visible = append(visible, name)
	}
	return visible
}

// BackupProgressEvent carries export and restore progress to the frontend.
// `mygo generate` turns it into `events.backupProgress`.
var BackupProgressEvent = mygo.NewEvent[backup.Progress]("backup-progress")

// FileDialogs opens the native file dialogs the backup flow needs. A cancelled
// dialog returns an empty path and a nil error.
type FileDialogs interface {
	OpenBackup() (path string, err error)
	ChooseBackupDir() (path string, err error)
}

// BackupService runs the backup flows. *BackupRunner implements it in
// production; tests substitute a fake.
type BackupService interface {
	Export(ctx context.Context, target domain.Target, path string) (backup.Manifest, error)
	Inspect(path string) (backup.Manifest, error)
	CheckVersion(m backup.Manifest, snapshot domain.Snapshot) error
	Restore(ctx context.Context, target domain.Target, path string) error
	Retry(ctx context.Context, useSnapshot bool) error
	Pending() (*backup.RestoreRecord, error)
	Abandon() error
}

// BackupSummaryDTO describes one backup file without exposing its contents.
type BackupSummaryDTO struct {
	Path       string   `json:"path"`
	ExportedAt string   `json:"exportedAt"`
	Release    string   `json:"release"`
	Rows       int64    `json:"rows"`
	Tasks      int      `json:"tasks"`
	Objects    int      `json:"objects"`
	Bytes      int64    `json:"bytes"`
	Oversized  []string `json:"oversized"`
}

// BackupPreviewDTO is the manifest summary shown before a restore. Problem is
// the error code that blocks the restore, empty when the backup is usable.
type BackupPreviewDTO struct {
	Summary        BackupSummaryDTO `json:"summary"`
	CurrentRelease string           `json:"currentRelease"`
	Problem        string           `json:"problem,omitempty"`
}

// PendingRestoreDTO describes an unfinished restore found at startup.
type PendingRestoreDTO struct {
	OperationID  string `json:"operationId"`
	BackupPath   string `json:"backupPath"`
	SnapshotPath string `json:"snapshotPath"`
	State        string `json:"state"`
	FailureCode  string `json:"failureCode"`
}

// beginBackupOperation takes the single backup slot. It rejects a second
// export or restore while one is running.
func (s *Service) beginBackupOperation() error {
	s.backupMu.Lock()
	defer s.backupMu.Unlock()
	if s.backupBusy {
		return domain.Error{Code: backup.CodeMaintenanceBusy, Message: "已有备份或恢复任务在进行"}
	}
	s.backupBusy = true
	return nil
}

func (s *Service) endBackupOperation() {
	s.backupMu.Lock()
	s.backupBusy = false
	s.backupMu.Unlock()
}

// unrecordedFailureCodes are failures that say nothing about the backup itself:
// not logged in yet, no deployment selected yet, or another backup already
// running. They are not stored, so the page keeps showing the last real outcome
// instead of "备份失败" on a client that simply has nothing to back up.
var unrecordedFailureCodes = map[string]bool{
	CodeAuthRequired:           true,
	CodeTargetNotSelected:      true,
	backup.CodeMaintenanceBusy: true,
}

// recordsExportFailure reports whether a failed export should be stored for the
// page. An unclassified error still counts: the user asked for a backup and did
// not get one.
func recordsExportFailure(err error) bool {
	code := appErrorCode(err)
	if code == "" {
		return true
	}
	return !unrecordedFailureCodes[code]
}

// ExportData writes a backup into the configured folder. It opens no dialog:
// the folder is a setting, so one click is enough. The attempt is recorded so
// the page can show when the last backup succeeded, and old files beyond the
// configured keep count are removed afterwards.
func (s *Service) ExportData() (*BackupSummaryDTO, error) {
	if err := s.beginBackupOperation(); err != nil {
		return nil, err
	}
	defer s.endBackupOperation()
	if s.backup == nil || s.settings == nil {
		return nil, serviceUnavailable()
	}
	settings, err := s.settings.Settings()
	if err != nil {
		return nil, safeAppError(err)
	}
	ctx, cancel := s.backupContext()
	defer cancel()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return nil, err
	}
	if err := ensureWritableDir(settings.Dir); err != nil {
		return nil, err
	}
	path := filepath.Join(settings.Dir, backupFileName(target.ScriptName, s.now()))
	manifest, err := s.backup.Export(ctx, target, path)
	if err != nil {
		if recordsExportFailure(err) {
			_, _ = s.settings.RecordRun(s.now(), "", err)
		}
		return nil, safeAppError(err)
	}
	_, _ = s.settings.RecordRun(s.now(), path, nil)
	_ = pruneBackups(settings.Dir, settings.Keep)
	summary := backupSummary(path, manifest)
	return &summary, nil
}

// BackupSettings returns the stored folder and schedule. It returns the DTO by
// value: the bridge maps a pointer result to null, and these calls always have
// an answer.
func (s *Service) BackupSettings() (BackupSettingsDTO, error) {
	if s.settings == nil {
		return BackupSettingsDTO{}, serviceUnavailable()
	}
	settings, err := s.settings.Settings()
	if err != nil {
		return BackupSettingsDTO{}, safeAppError(err)
	}
	return settings, nil
}

// SaveBackupSettings stores the folder and schedule the page edited.
func (s *Service) SaveBackupSettings(input BackupSettingsEditDTO) (BackupSettingsDTO, error) {
	if s.settings == nil {
		return BackupSettingsDTO{}, serviceUnavailable()
	}
	previous, err := s.settings.Settings()
	if err != nil {
		return BackupSettingsDTO{}, safeAppError(err)
	}
	next, err := s.settings.Save(input)
	if err != nil {
		return BackupSettingsDTO{}, safeAppError(err)
	}
	s.forgetSelectionInOtherFolder(previous.Dir, next.Dir)
	return next, nil
}

// forgetSelectionInOtherFolder drops the remembered restore file when the
// folder changes: a preview from the old folder must not stay restorable from
// the new one.
func (s *Service) forgetSelectionInOtherFolder(before, after string) {
	if filepath.Clean(before) == filepath.Clean(after) {
		return
	}
	s.backupMu.Lock()
	s.backupPath = ""
	s.backupMu.Unlock()
}

// ChooseBackupDir asks for a folder with the native dialog and stores it. A
// cancelled dialog returns the unchanged settings and no error.
func (s *Service) ChooseBackupDir() (BackupSettingsDTO, error) {
	if s.settings == nil || s.dialogs == nil {
		return BackupSettingsDTO{}, serviceUnavailable()
	}
	path, err := s.dialogs.ChooseBackupDir()
	if err != nil {
		return BackupSettingsDTO{}, safeAppError(err)
	}
	settings, err := s.settings.Settings()
	if err != nil {
		return BackupSettingsDTO{}, safeAppError(err)
	}
	if path == "" {
		return settings, nil
	}
	next, err := s.settings.Save(BackupSettingsEditDTO{
		Dir:           path,
		Auto:          settings.Auto,
		IntervalHours: settings.IntervalHours,
		Keep:          settings.Keep,
	})
	if err != nil {
		return BackupSettingsDTO{}, safeAppError(err)
	}
	s.forgetSelectionInOtherFolder(settings.Dir, next.Dir)
	return next, nil
}

// OpenBackupFolder reveals the configured folder, creating it first so the
// click always lands somewhere.
func (s *Service) OpenBackupFolder() error {
	if s.settings == nil || s.openPath == nil {
		return serviceUnavailable()
	}
	settings, err := s.settings.Settings()
	if err != nil {
		return safeAppError(err)
	}
	if err := ensureWritableDir(settings.Dir); err != nil {
		return err
	}
	if err := s.openPath(settings.Dir); err != nil {
		return domain.Error{Code: backup.CodeBackupSettingsInvalid, Message: "无法打开备份目录，请手动打开"}
	}
	return nil
}

// ChooseBackup asks the user for a backup file and returns its summary. The
// path is remembered for RestoreData. A version or size problem is reported in
// the preview, not as an error.
func (s *Service) ChooseBackup() (*BackupPreviewDTO, error) {
	if err := s.beginBackupOperation(); err != nil {
		return nil, err
	}
	defer s.endBackupOperation()
	ctx, cancel := s.backupContext()
	defer cancel()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return nil, err
	}
	if s.backup == nil || s.dialogs == nil || s.snapshots == nil {
		return nil, serviceUnavailable()
	}
	path, err := s.dialogs.OpenBackup()
	if err != nil {
		return nil, safeAppError(err)
	}
	if path == "" {
		return nil, nil
	}
	return s.inspectBackup(ctx, target, path)
}

// ChooseBackupAt selects a file the page listed from the backup folder, so
// restoring an earlier backup needs no file dialog. The path must stay inside
// that folder: the binding is callable from the page, so it must not become an
// arbitrary file reader.
func (s *Service) ChooseBackupAt(path string) (*BackupPreviewDTO, error) {
	if err := s.beginBackupOperation(); err != nil {
		return nil, err
	}
	defer s.endBackupOperation()
	if s.backup == nil || s.settings == nil || s.snapshots == nil {
		return nil, serviceUnavailable()
	}
	settings, err := s.settings.Settings()
	if err != nil {
		return nil, safeAppError(err)
	}
	if !insideBackupDir(settings.Dir, path) {
		return nil, domain.Error{Code: backup.CodeBackupInvalid, Message: "只能恢复备份目录里的备份文件"}
	}
	// A symlink inside the folder would send Inspect and Restore to whatever it
	// points at.
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		return nil, domain.Error{Code: backup.CodeBackupInvalid, Message: "只能恢复备份目录里的备份文件"}
	}
	ctx, cancel := s.backupContext()
	defer cancel()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return nil, err
	}
	return s.inspectBackup(ctx, target, path)
}

// inspectBackup validates a file and returns the preview the page shows. It
// forgets any previous selection first, so a failed inspection can never leave
// an older file selected for RestoreData.
func (s *Service) inspectBackup(ctx context.Context, target domain.Target, path string) (*BackupPreviewDTO, error) {
	s.backupMu.Lock()
	s.backupPath = ""
	s.backupMu.Unlock()
	manifest, err := s.backup.Inspect(path)
	if err != nil {
		return nil, safeAppError(err)
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	preview := BackupPreviewDTO{
		Summary:        backupSummary(path, manifest),
		CurrentRelease: snapshot.ReleaseVersion,
	}
	if err := s.backup.CheckVersion(manifest, snapshot); err != nil {
		code := appErrorCode(err)
		if code == "" {
			return nil, safeAppError(err)
		}
		preview.Problem = code
	}
	s.backupMu.Lock()
	s.backupPath = path
	s.backupMu.Unlock()
	return &preview, nil
}

// BackupFileDTO is one backup file the page lists from the configured folder.
type BackupFileDTO struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	ModifiedAt string `json:"modifiedAt"`
	Bytes      int64  `json:"bytes"`
}

// maxListedBackups bounds the local list: the folder keeps at most keep files,
// so a longer list means the user pointed us at an older folder.
const maxListedBackups = 50

// ListBackups lists the backups in the configured folder, newest first.
func (s *Service) ListBackups() ([]BackupFileDTO, error) {
	if s.settings == nil {
		return nil, serviceUnavailable()
	}
	settings, err := s.settings.Settings()
	if err != nil {
		return nil, safeAppError(err)
	}
	names, err := backupFiles(settings.Dir)
	if err != nil {
		return nil, safeAppError(err)
	}
	files := make([]BackupFileDTO, 0, len(names))
	for _, name := range names {
		if len(files) >= maxListedBackups {
			break
		}
		info, err := os.Stat(filepath.Join(settings.Dir, name))
		if err != nil {
			continue
		}
		files = append(files, BackupFileDTO{
			Path:       filepath.Join(settings.Dir, name),
			Name:       name,
			ModifiedAt: formatTime(info.ModTime()),
			Bytes:      info.Size(),
		})
	}
	return files, nil
}

// insideBackupDir reports whether path is one of the client's own backup files
// directly inside dir.
func insideBackupDir(dir, path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	if filepath.Dir(filepath.Clean(path)) != filepath.Clean(dir) {
		return false
	}
	ok, _ := filepath.Match(backupFilePattern, filepath.Base(path))
	return ok
}

// RestoreData overwrites the deployment with the backup chosen by ChooseBackup.
func (s *Service) RestoreData() error {
	if err := s.beginBackupOperation(); err != nil {
		return err
	}
	defer s.endBackupOperation()
	ctx, cancel := s.backupContext()
	defer cancel()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	if s.backup == nil {
		return serviceUnavailable()
	}
	// Consume the remembered path: a failed restore leaves a pending record
	// for RetryRestore instead of allowing an accidental second run.
	s.backupMu.Lock()
	path := s.backupPath
	s.backupPath = ""
	s.backupMu.Unlock()
	if path == "" {
		return domain.Error{Code: backup.CodeBackupInvalid, Message: "请先选择一个备份文件"}
	}
	return safeAppError(s.backup.Restore(ctx, target, path))
}

// PendingRestore reports an unfinished restore, or nil when there is none.
func (s *Service) PendingRestore() (*PendingRestoreDTO, error) {
	if s.backup == nil {
		return nil, nil
	}
	record, err := s.backup.Pending()
	if err != nil {
		return nil, safeAppError(err)
	}
	if record == nil {
		return nil, nil
	}
	return &PendingRestoreDTO{
		OperationID:  record.OperationID,
		BackupPath:   record.BackupPath,
		SnapshotPath: record.SnapshotPath,
		State:        record.State,
		FailureCode:  record.FailureCode,
	}, nil
}

// RetryRestore finishes an unfinished restore, either from the original backup
// or from the pre-restore snapshot.
func (s *Service) RetryRestore(useSnapshot bool) error {
	if err := s.beginBackupOperation(); err != nil {
		return err
	}
	defer s.endBackupOperation()
	if s.backup == nil {
		return serviceUnavailable()
	}
	ctx, cancel := s.backupContext()
	defer cancel()
	return safeAppError(s.backup.Retry(ctx, useSnapshot))
}

// AbandonPendingRestore clears the local unfinished-restore record. It does
// not roll back or otherwise change any cloud data; the user is told this in
// the confirmation. Clearing works even when restore.json is unreadable.
func (s *Service) AbandonPendingRestore() error {
	if err := s.beginBackupOperation(); err != nil {
		return err
	}
	defer s.endBackupOperation()
	if s.backup == nil {
		return serviceUnavailable()
	}
	return safeAppError(s.backup.Abandon())
}

func backupSummary(path string, manifest backup.Manifest) BackupSummaryDTO {
	summary := BackupSummaryDTO{
		Path:       path,
		ExportedAt: formatTime(manifest.ExportedAt),
		Release:    manifest.Release,
		Objects:    len(manifest.R2.Objects),
		Bytes:      manifest.R2.Bytes,
		Oversized:  append([]string{}, manifest.R2.Oversized...),
	}
	for _, object := range manifest.DurableObjects {
		if object.DO == "task" {
			summary.Tasks++
		}
		for _, rows := range object.Rows {
			summary.Rows += rows
		}
	}
	return summary
}

// BackupRunner adapts the backup package flows to BackupService. It owns the
// restore journal and the pre-restore snapshot directory.
type BackupRunner struct {
	Deps        backup.Deps
	Journal     *backup.RestoreJournal
	SnapshotDir string
}

// NewBackupRunner composes the production backup flows.
func NewBackupRunner(deps backup.Deps, journal *backup.RestoreJournal, snapshotDir string) *BackupRunner {
	return &BackupRunner{Deps: deps, Journal: journal, SnapshotDir: snapshotDir}
}

// Export writes every Durable Object table and artifact to path.
func (r *BackupRunner) Export(ctx context.Context, target domain.Target, path string) (backup.Manifest, error) {
	return backup.Export(ctx, r.Deps, target, path)
}

// Inspect validates a backup file and returns its manifest.
func (r *BackupRunner) Inspect(path string) (backup.Manifest, error) {
	return backup.Inspect(path)
}

// CheckVersion reports whether the backup may be restored onto snapshot.
func (r *BackupRunner) CheckVersion(m backup.Manifest, snapshot domain.Snapshot) error {
	return backup.CheckVersion(m, snapshot)
}

// Restore overwrites the deployment after snapshotting its current data.
func (r *BackupRunner) Restore(ctx context.Context, target domain.Target, path string) error {
	return backup.Restore(ctx, r.Deps, r.Journal, target, path, r.SnapshotDir)
}

// Retry finishes the unfinished restore in the journal.
func (r *BackupRunner) Retry(ctx context.Context, useSnapshot bool) error {
	return backup.Retry(ctx, r.Deps, r.Journal, useSnapshot)
}

// Pending returns the unfinished restore record, or nil.
func (r *BackupRunner) Pending() (*backup.RestoreRecord, error) {
	return r.Journal.Pending()
}

// Abandon removes the journal without decoding it, so a corrupt record can
// still be cleared.
func (r *BackupRunner) Abandon() error {
	return r.Journal.Clear()
}
