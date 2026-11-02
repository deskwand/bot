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
)

// MaxR2ObjectBytes is the largest artifact the Worker accepts in one request
// body. Larger objects are recorded as oversized and cannot be restored.
const MaxR2ObjectBytes int64 = 100 << 20
