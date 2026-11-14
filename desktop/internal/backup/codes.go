// Package backup reads and writes the desktop client's cloud data backups.
package backup

// Error codes returned in domain.Error.Code by the export and restore flows.
const (
	CodeAdminUnavailable      = "ADMIN_UNAVAILABLE"
	CodeAdminUnauthorized     = "ADMIN_UNAUTHORIZED"
	CodeMaintenanceRequired   = "MAINTENANCE_REQUIRED"
	CodeMaintenanceBusy       = "MAINTENANCE_BUSY"
	CodeBackupInvalid         = "BACKUP_INVALID"
	CodeBackupVersionMismatch = "BACKUP_VERSION_MISMATCH"
	CodeBackupObjectTooLarge  = "BACKUP_OBJECT_TOO_LARGE"
	CodeRestoreSnapshotFailed = "RESTORE_SNAPSHOT_FAILED"
	CodeRestorePending        = "RESTORE_PENDING"
	CodeRestoreJournalCorrupt = "RESTORE_JOURNAL_CORRUPT"
)

// MaxR2ObjectBytes is the largest artifact the Worker accepts in one request
// body. Larger objects are recorded as oversized and cannot be restored.
const MaxR2ObjectBytes int64 = 100 << 20

// CodeBackupObjectTooLargeForTarget reports a backup whose artifacts exceed
// what the target itself can store.
const CodeBackupObjectTooLargeForTarget = "BACKUP_OBJECT_TOO_LARGE_FOR_TARGET"

// ContainerMaxObjectBytes is the largest artifact the container artifact store
// accepts (container/store/store-do.ts: STORE_MAX_BYTES). The product caps
// artifacts at 15 MiB, so only backups written before that cap reach it.
const ContainerMaxObjectBytes int64 = 16 << 20

// CodeBackupSettingsInvalid reports a backup folder or schedule that cannot
// be stored: empty, relative, unwritable, or outside the offered choices.
const CodeBackupSettingsInvalid = "BACKUP_SETTINGS_INVALID"

// CodeBackupFailed is the recorded code for an export that failed for a
// reason this package did not classify.
const CodeBackupFailed = "BACKUP_FAILED"
