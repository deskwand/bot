package app

import (
	"context"
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
	SaveBackup(defaultName string) (path string, err error)
	OpenBackup() (path string, err error)
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

// ExportData exports the managed deployment to a file the user picks.
func (s *Service) ExportData() (*BackupSummaryDTO, error) {
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
	if s.backup == nil || s.dialogs == nil {
		return nil, serviceUnavailable()
	}
	defaultName := "deskwand-backup-" + target.ScriptName + "-" + s.now().UTC().Format("20060102-150405") + ".zip"
	path, err := s.dialogs.SaveBackup(defaultName)
	if err != nil {
		return nil, safeAppError(err)
	}
	if path == "" {
		return nil, nil
	}
	manifest, err := s.backup.Export(ctx, target, path)
	if err != nil {
		return nil, safeAppError(err)
	}
	summary := backupSummary(path, manifest)
	return &summary, nil
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
	// A new choice replaces the remembered path before Inspect, so a failed
	// inspection cannot leave an older file selected for RestoreData.
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
