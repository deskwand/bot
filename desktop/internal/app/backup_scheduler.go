package app

import (
	"context"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
)

// backupSchedulerTick is how often the scheduler looks at the clock. It only
// decides whether an export is due; the interval itself comes from settings.
const backupSchedulerTick = 5 * time.Minute

// skippedRunCodes are failures that say nothing about the backup itself: not
// logged in yet, no deployment selected yet, or another backup is already
// running. They are not recorded, so the page keeps showing the last real
// outcome instead of "备份失败" on a client that simply has nothing to back up.
var skippedRunCodes = map[string]bool{
	CodeAuthRequired:           true,
	CodeTargetNotSelected:      true,
	backup.CodeMaintenanceBusy: true,
}

// BackupScheduler exports a backup on the interval the settings ask for. It
// only runs while the client is open: the cloud data lives on, but nothing can
// drive a local write when the process is gone.
type BackupScheduler struct {
	settings BackupSettingsStore
	export   func(context.Context) error
	now      func() time.Time
	tick     time.Duration
}

// NewBackupScheduler returns a scheduler that calls export when a backup is
// due. export is the service's ExportData, so it shares the backup slot with
// the manual buttons.
func NewBackupScheduler(settings BackupSettingsStore, export func(context.Context) error) *BackupScheduler {
	return &BackupScheduler{
		settings: settings,
		export:   export,
		now:      time.Now,
		tick:     backupSchedulerTick,
	}
}

// Run steps the scheduler until ctx is done. The first step runs immediately:
// a client that stayed closed overnight backs up soon after it starts.
func (s *BackupScheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.tick)
	defer ticker.Stop()
	s.Step(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Step(ctx)
		}
	}
}

// Step exports once when the settings ask for it. A failure keeps the previous
// successful run in place and is recorded for the page; the next interval
// retries.
func (s *BackupScheduler) Step(ctx context.Context) {
	settings, err := s.settings.Settings()
	if err != nil {
		return
	}
	if !dueForAutoBackup(settings, s.now()) {
		return
	}
	if err := s.export(ctx); err != nil {
		if skippedRunCodes[appErrorCode(err)] {
			return
		}
		_, _ = s.settings.RecordRun(s.now(), "", err)
	}
}

// dueForAutoBackup reports whether the settings ask for an export at now. The
// interval is measured from the last attempt of any kind: a failed backup waits
// a full interval before it retries, instead of running every tick.
func dueForAutoBackup(settings BackupSettingsDTO, now time.Time) bool {
	if !settings.Auto || settings.IntervalHours <= 0 {
		return false
	}
	reference := settings.LastAttemptAt
	if reference == "" {
		reference = settings.LastSuccessAt
	}
	if reference == "" {
		return true
	}
	last, err := time.Parse(time.RFC3339, reference)
	if err != nil {
		return true
	}
	return !now.Before(last.Add(time.Duration(settings.IntervalHours) * time.Hour))
}
