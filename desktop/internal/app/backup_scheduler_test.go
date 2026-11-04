package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
)

type fakeSettingsStore struct {
	settings BackupSettingsDTO
	readErr  error
	// frozen keeps LastAttemptAt unchanged after RecordRun, as a settings file
	// that cannot be written would.
	frozen bool
	runs   []recordedRun
}

type recordedRun struct {
	at   time.Time
	path string
	err  error
}

func (f *fakeSettingsStore) Settings() (BackupSettingsDTO, error) {
	if f.readErr != nil {
		return BackupSettingsDTO{}, f.readErr
	}
	return f.settings, nil
}

func (f *fakeSettingsStore) Save(BackupSettingsEditDTO) (BackupSettingsDTO, error) {
	return f.settings, nil
}

func (f *fakeSettingsStore) RecordRun(at time.Time, path string, runErr error) (BackupSettingsDTO, error) {
	f.runs = append(f.runs, recordedRun{at: at, path: path, err: runErr})
	if f.frozen {
		return f.settings, nil
	}
	if runErr == nil {
		f.settings.LastSuccessAt = at.UTC().Format(time.RFC3339)
		f.settings.LastSuccessPath = path
	}
	f.settings.LastAttemptAt = at.UTC().Format(time.RFC3339)
	return f.settings, nil
}

func newScheduler(settings *fakeSettingsStore, export func(context.Context) error, now time.Time) *BackupScheduler {
	scheduler := NewBackupScheduler(settings, export)
	scheduler.now = func() time.Time { return now }
	return scheduler
}

func TestDueForAutoBackup(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	base := BackupSettingsDTO{Auto: true, IntervalHours: 6, Keep: 5}

	if !dueForAutoBackup(base, now, time.Time{}) {
		t.Fatal("never-run settings must be due")
	}
	on := base
	on.LastSuccessAt = "2026-11-04T08:00:00Z"
	if dueForAutoBackup(on, now, time.Time{}) {
		t.Fatal("four hours after a six-hour run must not be due")
	}
	if !dueForAutoBackup(on, now.Add(2*time.Hour), time.Time{}) {
		t.Fatal("six hours after the last run must be due")
	}
	off := base
	off.Auto = false
	off.LastSuccessAt = "2026-11-01T00:00:00Z"
	if dueForAutoBackup(off, now, time.Time{}) {
		t.Fatal("auto off must never be due")
	}
	corrupt := base
	corrupt.LastSuccessAt = "not a time"
	if !dueForAutoBackup(corrupt, now, time.Time{}) {
		t.Fatal("an unreadable timestamp must be treated as due")
	}
	// A failed attempt counts: the interval starts over instead of retrying
	// on the next tick.
	retried := base
	retried.LastSuccessAt = "2026-11-04T00:00:00Z"
	retried.LastAttemptAt = "2026-11-04T11:00:00Z"
	retried.LastErrorCode = "BACKUP_FAILED"
	if dueForAutoBackup(retried, now, time.Time{}) {
		t.Fatal("a recent failed attempt must not be due")
	}
	if !dueForAutoBackup(retried, now.Add(5*time.Hour), time.Time{}) {
		t.Fatal("an old failed attempt must be due")
	}
}

func TestSchedulerDoesNotRepeatWithinInterval(t *testing.T) {
	settings := &fakeSettingsStore{settings: BackupSettingsDTO{
		Auto: true, IntervalHours: 24, Keep: 5, LastSuccessAt: "2026-11-04T00:00:00Z",
	}}
	calls := 0
	scheduler := newScheduler(settings, func(context.Context) error {
		calls++
		return nil
	}, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC))

	scheduler.Step(context.Background())
	scheduler.Step(context.Background())
	if calls != 0 {
		t.Fatalf("exported %d times inside the interval", calls)
	}
	if len(settings.runs) != 0 {
		t.Fatalf("recorded %d runs while idle", len(settings.runs))
	}
}

func TestSchedulerExportsWhenDue(t *testing.T) {
	settings := &fakeSettingsStore{settings: BackupSettingsDTO{
		Auto: true, IntervalHours: 6, Keep: 5, LastSuccessAt: "2026-11-04T00:00:00Z",
	}}
	calls := 0
	scheduler := newScheduler(settings, func(context.Context) error {
		calls++
		return nil
	}, time.Date(2026, 11, 4, 6, 0, 0, 0, time.UTC))

	scheduler.Step(context.Background())
	if calls != 1 {
		t.Fatalf("exported %d times, want 1", calls)
	}
}

func TestSchedulerRetriesSkippedFailures(t *testing.T) {
	for _, code := range []string{CodeAuthRequired, backup.CodeMaintenanceBusy, CodeTargetNotSelected} {
		settings := &fakeSettingsStore{settings: BackupSettingsDTO{Auto: true, IntervalHours: 6, Keep: 5}}
		calls := 0
		now := time.Date(2026, 11, 4, 6, 0, 0, 0, time.UTC)
		scheduler := newScheduler(settings, func(context.Context) error {
			calls++
			return domain.Error{Code: code, Message: "skip"}
		}, now)

		scheduler.Step(context.Background())
		// A skip is not an attempt: the next tick must try again instead of
		// waiting a whole interval.
		scheduler.Step(context.Background())
		if calls != 2 {
			t.Fatalf("%s: exported %d times, want 2", code, calls)
		}
		if len(settings.runs) != 0 {
			t.Fatalf("%s was recorded as a failure", code)
		}
	}
}

func TestSchedulerWaitsAfterFailure(t *testing.T) {
	settings := &fakeSettingsStore{settings: BackupSettingsDTO{
		Auto: true, IntervalHours: 24, Keep: 5,
		LastSuccessAt: "2026-11-01T00:00:00Z",
		LastAttemptAt: "2026-11-04T09:00:00Z",
		LastErrorCode: "BACKUP_FAILED",
	}}
	calls := 0
	scheduler := newScheduler(settings, func(context.Context) error {
		calls++
		return nil
	}, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC))

	scheduler.Step(context.Background())
	if calls != 0 {
		t.Fatalf("retried %d times an hour after a failure with a 24h interval", calls)
	}
}

func TestSchedulerDoesNotRepeatWhenTheAttemptCannotBeStored(t *testing.T) {
	// backup.json is unwritable, so the stored attempt never advances. The
	// scheduler must still keep to the interval instead of exporting every tick.
	settings := &fakeSettingsStore{
		settings: BackupSettingsDTO{Auto: true, IntervalHours: 6, Keep: 5},
		frozen:   true,
	}
	calls := 0
	now := time.Date(2026, 11, 4, 6, 0, 0, 0, time.UTC)
	scheduler := newScheduler(settings, func(context.Context) error {
		calls++
		return nil
	}, now)

	scheduler.Step(context.Background())
	scheduler.Step(context.Background())
	if calls != 1 {
		t.Fatalf("exported %d times with a frozen settings file, want 1", calls)
	}
}

func TestSchedulerIgnoresUnreadableSettings(t *testing.T) {
	settings := &fakeSettingsStore{readErr: errors.New("broken")}
	calls := 0
	scheduler := newScheduler(settings, func(context.Context) error {
		calls++
		return nil
	}, time.Date(2026, 11, 4, 6, 0, 0, 0, time.UTC))

	scheduler.Step(context.Background())
	if calls != 0 {
		t.Fatalf("exported %d times after a settings read failure", calls)
	}
}
