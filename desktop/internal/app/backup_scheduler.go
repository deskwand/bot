package app

import (
	"context"
	"time"
)

// backupSchedulerTick is how often the scheduler looks at the clock. It only
// decides whether an export is due; the interval itself comes from settings.
const backupSchedulerTick = 5 * time.Minute

// BackupScheduler exports a backup on the interval the settings ask for. It
// only runs while the client is open: the cloud data lives on, but nothing can
// drive a local write when the process is gone.
type BackupScheduler struct {
	settings BackupSettingsStore
	export   func(context.Context) error
	now      func() time.Time
	tick     time.Duration
	// lastAttempt is the in-memory attempt time. It is not redundant with the
	// stored one: when backup.json cannot be written the stored timestamp never
	// advances, and without this the loop would export on every tick instead of
	// once per interval. Step is called from one goroutine only.
	lastAttempt time.Time
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

// Step exports once when the settings ask for it. ExportData records the
// outcome, so a failure keeps the previous successful run in place and is shown
// on the page; the next interval retries.
func (s *BackupScheduler) Step(ctx context.Context) {
	settings, err := s.settings.Settings()
	if err != nil {
		return
	}
	now := s.now()
	if !dueForAutoBackup(settings, now, s.lastAttempt) {
		return
	}
	s.lastAttempt = now
	if err := s.export(ctx); err != nil && unrecordedFailureCodes[appErrorCode(err)] {
		// Nothing was attempted: another backup is running, the client is not
		// logged in, or no deployment is selected. Let the next tick try again
		// instead of waiting a whole interval.
		s.lastAttempt = time.Time{}
	}
}

// dueForAutoBackup reports whether the settings ask for an export at now. The
// interval is measured from the last attempt of any kind: a failed backup waits
// a full interval before it retries, instead of running every tick. attempt is
// the scheduler's own memory of its last run; the later of it and the stored
// timestamps wins.
func dueForAutoBackup(settings BackupSettingsDTO, now, attempt time.Time) bool {
	if !settings.Auto || settings.IntervalHours <= 0 {
		return false
	}
	reference := attempt
	for _, stored := range []string{settings.LastSuccessAt, settings.LastAttemptAt} {
		if stored == "" {
			continue
		}
		parsed, err := time.Parse(time.RFC3339, stored)
		if err != nil {
			// An unreadable timestamp must not pin the schedule; treat it as due.
			return true
		}
		if parsed.After(reference) {
			reference = parsed
		}
	}
	if reference.IsZero() {
		return true
	}
	return !now.Before(reference.Add(time.Duration(settings.IntervalHours) * time.Hour))
}
