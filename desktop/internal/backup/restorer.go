package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// restorePageBytes bounds one restore request, matching the export page size.
const restorePageBytes = 1 << 20

// Inspect validates a backup archive and returns its manifest without touching
// the deployment.
func Inspect(path string) (Manifest, error) {
	reader, err := Open(path)
	if err != nil {
		return Manifest{}, err
	}
	defer reader.Close()
	return reader.Manifest(), nil
}

// CheckVersion reports whether m may be restored onto snapshot. Both releases
// must be known and equal, and the archive must not contain objects too large
// for the Worker to accept back.
func CheckVersion(m Manifest, snapshot domain.Snapshot) error {
	if len(m.R2.Oversized) > 0 {
		return domain.Error{
			Code: CodeBackupObjectTooLarge,
			Message: fmt.Sprintf(
				"backup contains %d artifacts larger than %d bytes: %s",
				len(m.R2.Oversized), MaxR2ObjectBytes, strings.Join(m.R2.Oversized, ", "),
			),
		}
	}
	if !knownRelease(m.Release) || !knownRelease(snapshot.ReleaseVersion) || m.Release != snapshot.ReleaseVersion {
		return domain.Error{
			Code: CodeBackupVersionMismatch,
			Message: fmt.Sprintf(
				"backup release %q does not match deployment release %q",
				m.Release, snapshot.ReleaseVersion,
			),
		}
	}
	return nil
}

func knownRelease(release string) bool {
	return release != "" && release != unknownRelease
}

// Restore replaces the deployment's data with the contents of backupPath. It
// first writes a snapshot of the current data to snapshotDir; a failure while
// writing the backup leaves the cloud untouched and keeps no journal record.
// A failure after the snapshot keeps a "failed" record so Retry can finish the
// job.
func Restore(ctx context.Context, deps Deps, journal *RestoreJournal, target domain.Target, backupPath, snapshotDir string) error {
	pending, err := journal.Pending()
	if err != nil {
		return err
	}
	if pending != nil {
		return pendingRestoreError()
	}

	deps.report(Progress{Op: "restore", Phase: PhasePreparing})
	manifest, err := Inspect(backupPath)
	if err != nil {
		return err
	}

	opID, err := deps.newOpID()
	if err != nil {
		return err
	}
	// Establish the admin token before taking the shared target lock: the
	// publish flow used by EnsureAdminToken/RepublishAdminToken takes the same
	// non-reentrant lock.
	client, snapshot, published, err := connect(ctx, deps, target, opID)
	if err != nil {
		return err
	}
	if err := CheckVersion(manifest, snapshot); err != nil {
		return err
	}
	client, err = acquireLease(ctx, deps, target, client, published, "restore")
	if err != nil {
		return err
	}
	defer func() { _ = releaseLease(client) }()

	unlock, err := lockTarget(ctx, deps, target)
	if err != nil {
		return err
	}
	defer unlock()

	if err := os.MkdirAll(snapshotDir, 0o700); err != nil {
		return fmt.Errorf("backup: create snapshot directory: %w", err)
	}
	now := deps.now()
	snapshotPath := filepath.Join(snapshotDir, "pre-restore-"+now.Format("20060102-150405")+".zip")
	var snapshotManifest Manifest
	err = withLeaseHeartbeat(ctx, client, func(heartbeatCtx context.Context) error {
		var snapshotErr error
		snapshotManifest, snapshotErr = writeSnapshot(heartbeatCtx, deps, client, snapshot, target, snapshotPath)
		return snapshotErr
	})
	if err != nil {
		return domain.Error{Code: CodeRestoreSnapshotFailed, Message: err.Error()}
	}
	if len(snapshotManifest.R2.Oversized) > 0 {
		// An oversized artifact means the snapshot cannot be restored, so it
		// is not a safety net. Discard it before the write-back starts.
		_ = os.Remove(snapshotPath)
		return domain.Error{
			Code: CodeRestoreSnapshotFailed,
			Message: fmt.Sprintf(
				"snapshot is incomplete because these artifacts exceed %d bytes: %s",
				MaxR2ObjectBytes, strings.Join(snapshotManifest.R2.Oversized, ", "),
			),
		}
	}

	// Re-read the deployment and check the release immediately before the
	// first destructive call. The shared lock stops this client's publish path,
	// and the recheck closes the window where another device upgraded during
	// the snapshot.
	current, err := deps.Token.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return err
	}
	if err := CheckVersion(manifest, current); err != nil {
		return err
	}

	reader, err := Open(backupPath)
	if err != nil {
		return err
	}
	defer reader.Close()

	record := RestoreRecord{
		OperationID:  opID,
		Target:       target,
		BackupPath:   backupPath,
		SnapshotPath: snapshotPath,
		State:        restoreStateRun,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := journal.Save(record); err != nil {
		return err
	}
	progress := Progress{Op: "restore", Phase: PhaseDatabase}
	deps.report(progress)
	err = withLeaseHeartbeat(ctx, client, func(heartbeatCtx context.Context) error {
		return restoreData(heartbeatCtx, deps, client, reader, manifest, &progress)
	})
	if err != nil {
		record.State = restoreStateFailed
		record.FailureCode = failureCode(err)
		record.UpdatedAt = deps.now()
		// The running record is already on disk; if this update is lost the
		// restore stays pending either way.
		_ = journal.Save(record)
		return err
	}
	progress.Phase = PhaseFinishing
	deps.report(progress)
	return journal.Clear()
}

// Retry resumes the unfinished restore in journal. With useSnapshot it writes
// the pre-restore snapshot back instead of the original backup file. The
// operation id of the failed attempt is reused so it renews the lease that
// attempt left in place.
func Retry(ctx context.Context, deps Deps, journal *RestoreJournal, useSnapshot bool) error {
	record, err := journal.Pending()
	if err != nil {
		return err
	}
	if record == nil {
		return domain.Error{Code: CodeBackupInvalid, Message: "there is no unfinished restore to retry"}
	}
	path := record.BackupPath
	if useSnapshot {
		path = record.SnapshotPath
	}
	if path == "" {
		return domain.Error{Code: CodeBackupInvalid, Message: "the unfinished restore does not name a backup file"}
	}

	deps.report(Progress{Op: "restore", Phase: PhasePreparing})
	manifest, err := Inspect(path)
	if err != nil {
		return err
	}

	opID := record.OperationID
	if opID == "" {
		opID, err = deps.newOpID()
		if err != nil {
			return err
		}
	}
	client, snapshot, published, err := connect(ctx, deps, record.Target, opID)
	if err != nil {
		return err
	}
	if err := CheckVersion(manifest, snapshot); err != nil {
		return err
	}
	client, err = acquireLease(ctx, deps, record.Target, client, published, "restore")
	if err != nil {
		return err
	}
	defer func() { _ = releaseLease(client) }()

	unlock, err := lockTarget(ctx, deps, record.Target)
	if err != nil {
		return err
	}
	defer unlock()

	// Retry has no new snapshot, so the immediate pre-destructive recheck is
	// the only guard against an upgrade that happened while this attempt was
	// waiting for the lock.
	current, err := deps.Token.Snapshots.ReadSnapshot(ctx, record.Target)
	if err != nil {
		return err
	}
	if err := CheckVersion(manifest, current); err != nil {
		return err
	}

	reader, err := Open(path)
	if err != nil {
		return err
	}
	defer reader.Close()

	record.OperationID = opID
	record.State = restoreStateRun
	record.FailureCode = ""
	record.UpdatedAt = deps.now()
	if err := journal.Save(*record); err != nil {
		return err
	}
	progress := Progress{Op: "restore", Phase: PhaseDatabase}
	deps.report(progress)
	err = withLeaseHeartbeat(ctx, client, func(heartbeatCtx context.Context) error {
		return restoreData(heartbeatCtx, deps, client, reader, manifest, &progress)
	})
	if err != nil {
		record.State = restoreStateFailed
		record.FailureCode = failureCode(err)
		record.UpdatedAt = deps.now()
		// The running record is already on disk; if this update is lost the
		// restore stays pending either way.
		_ = journal.Save(*record)
		return err
	}
	progress.Phase = PhaseFinishing
	deps.report(progress)
	return journal.Clear()
}

// writeSnapshot exports the current deployment through an already-connected
// client that holds the maintenance lease and the shared target lock.
func writeSnapshot(ctx context.Context, deps Deps, client *AdminClient, snapshot domain.Snapshot, target domain.Target, path string) (Manifest, error) {
	writer, err := NewWriter(path)
	if err != nil {
		return Manifest{}, err
	}
	defer writer.Abort()
	snapshotDeps := deps
	snapshotDeps.Progress = func(progress Progress) {
		progress.Op = "restore"
		deps.report(progress)
	}
	manifest, err := exportData(ctx, snapshotDeps, client, snapshot, target, writer)
	if err != nil {
		return Manifest{}, err
	}
	if err := writer.Finish(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func pendingRestoreError() error {
	return domain.Error{
		Code:    CodeRestorePending,
		Message: "an earlier restore is unfinished; retry it before starting another",
	}
}

// failureCode keeps the domain code of err, falling back to BACKUP_INVALID for
// unclassified transport errors.
func failureCode(err error) string {
	if code := errorCode(err); code != "" {
		return code
	}
	return CodeBackupInvalid
}

func restoreData(ctx context.Context, deps Deps, client *AdminClient, reader *Reader, manifest Manifest, progress *Progress) error {
	info, err := client.Info(ctx)
	if err != nil {
		return err
	}

	backupTasks := make(map[string]bool, len(manifest.DurableObjects))
	for _, object := range manifest.DurableObjects {
		if object.DO == "task" {
			backupTasks[object.ID] = true
		}
	}

	// Clear task objects that the backup does not know about before touching
	// any data the backup contains.
	progress.Phase = PhaseClearing
	deps.report(*progress)
	cleared := make(map[string]bool, len(info.TaskIDs))
	for _, id := range info.TaskIDs {
		if backupTasks[id] || cleared[id] {
			continue
		}
		cleared[id] = true
		if err := clearDurableObject(ctx, client, DORef{DO: "task", ID: id}); err != nil {
			return err
		}
	}

	progress.Phase = PhaseDatabase
	deps.report(*progress)
	for _, object := range restoreOrder(manifest.DurableObjects) {
		if err := restoreDurableObject(ctx, deps, client, reader, object, progress); err != nil {
			return err
		}
	}

	return restoreObjects(ctx, deps, client, reader, manifest.R2, progress)
}

// restoreOrder puts tasks first, then the channel hub, and the Butler last so
// its alarm cannot fire before the data it points at exists.
func restoreOrder(objects []DOManifest) []DOManifest {
	ordered := make([]DOManifest, 0, len(objects))
	for _, kind := range []string{"task", "channel", "butler"} {
		for _, object := range objects {
			if object.DO == kind {
				ordered = append(ordered, object)
			}
		}
	}
	return ordered
}

// clearDurableObject empties an object that is not part of the backup. It
// never commits: there is no data to index and no alarm to re-arm.
func clearDurableObject(ctx context.Context, client *AdminClient, ref DORef) error {
	if err := client.RestoreReset(ctx, ref); err != nil {
		return err
	}
	if err := client.RestoreBegin(ctx, ref, DBSchema{Tables: []TableSchema{}, Indexes: []string{}}); err != nil {
		return err
	}
	return client.RestoreReset(ctx, ref)
}

func restoreDurableObject(ctx context.Context, deps Deps, client *AdminClient, reader *Reader, object DOManifest, progress *Progress) error {
	ref := object.DORef
	if err := client.RestoreReset(ctx, ref); err != nil {
		return err
	}
	if err := client.RestoreBegin(ctx, ref, object.Schema); err != nil {
		return err
	}
	for _, table := range object.Schema.Tables {
		err := reader.Rows(ref, table.Name, restorePageBytes, func(batch []json.RawMessage) error {
			return client.RestorePage(ctx, ref, table, batch)
		})
		if err != nil {
			return err
		}
		progress.Rows += object.Rows[table.Name]
		progress.Tables++
		deps.report(*progress)
	}
	if err := client.RestoreCommit(ctx, ref, object.Schema); err != nil {
		return err
	}
	return client.RestoreReset(ctx, ref)
}

func restoreObjects(ctx context.Context, deps Deps, client *AdminClient, reader *Reader, r2 R2Manifest, progress *Progress) error {
	progress.Phase = PhaseClearing
	deps.report(*progress)
	existing, err := client.ListObjects(ctx)
	if err != nil {
		return err
	}
	wanted := make(map[string]bool, len(r2.Objects))
	for _, item := range r2.Objects {
		wanted[item.Key] = true
	}
	for _, object := range existing {
		if wanted[object.Key] {
			continue
		}
		if err := client.DeleteObject(ctx, object.Key); err != nil {
			return err
		}
	}

	progress.Phase = PhaseObjects
	progress.TotalObjects = len(r2.Objects)
	deps.report(*progress)
	for _, item := range r2.Objects {
		body, err := reader.Object(item)
		if err != nil {
			return err
		}
		info := ObjectInfo{Key: item.Key, Size: item.Size, ContentType: item.ContentType}
		err = client.PutObject(ctx, info, body)
		_ = body.Close()
		if err != nil {
			return err
		}
		if item.Size > renewEveryBytes {
			if err := renewLease(ctx, client); err != nil {
				return err
			}
		}
		progress.Objects++
		deps.report(*progress)
	}
	return nil
}
