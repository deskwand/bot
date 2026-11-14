package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
)

type fakeMover struct {
	exported   domain.Target
	restored   domain.Target
	muted      domain.Target
	revived    string
	failExport bool
}

func (f *fakeMover) Export(_ context.Context, target domain.Target, path string) (backup.Manifest, error) {
	if f.failExport {
		return backup.Manifest{}, domain.Error{Code: backup.CodeAdminUnavailable}
	}
	f.exported = target
	// The real runner writes the archive; the settle step checks it exists.
	if err := os.WriteFile(path, []byte("zip"), 0o600); err != nil {
		return backup.Manifest{}, err
	}
	return backup.Manifest{Format: backup.FormatVersion, Release: "0.1.51"}, nil
}

func (f *fakeMover) Restore(_ context.Context, target domain.Target, path string) error {
	f.restored = target
	return nil
}

func (f *fakeMover) Mute(_ context.Context, target domain.Target) error {
	f.muted = target
	return nil
}

func (f *fakeMover) Revive(_ context.Context, target domain.Target, channel string) error {
	f.revived = channel
	return nil
}

// newMoveService builds a Service with a writable backup folder, a store that
// answers with whatever target the test sets, and a move journal in the same
// temp dir.
func newMoveService(t *testing.T) (*Service, *fakeMover, *fakeStore, *backup.MoveJournal) {
	t.Helper()
	base := newBackupFixture(t)
	dir := t.TempDir()
	settings, err := NewFileBackupSettings(dir, filepath.Join(dir, "backups"))
	if err != nil {
		t.Fatalf("NewFileBackupSettings: %v", err)
	}
	journal, err := backup.NewMoveJournal(filepath.Join(dir, "move.json"))
	if err != nil {
		t.Fatalf("NewMoveJournal: %v", err)
	}
	mover := &fakeMover{}
	base.service = NewService(ServiceOptions{
		Auth: base.auth, Publish: base.publish, Lifecycle: base.lifecycle,
		Entries: base.entries, Diagnostics: base.diagnostics, Snapshots: base.snapshots,
		Scripts: base.scripts, Journal: base.journal, Store: base.store, Browser: base.browser,
		Release:        base.release,
		Backup:         base.backup,
		FileDialogs:    base.dialogs,
		BackupSettings: settings,
		MoveJournal:    journal,
		MoveExporter:   mover,
		MoveMuter:      mover,
		Now:            func() time.Time { return time.Date(2026, 11, 14, 9, 30, 0, 0, time.UTC) },
	})
	return base.service, mover, base.store, journal
}

func TestStartMovePacksThenMutesAndRecords(t *testing.T) {
	service, mover, store, journal := newMoveService(t)
	store.target, store.ok = cloudHouse, true

	dto, err := service.StartMove()
	if err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	if mover.exported != cloudHouse {
		t.Fatalf("exported %+v, want %+v", mover.exported, cloudHouse)
	}
	if mover.muted != cloudHouse {
		t.Fatalf("muted %+v, want %+v", mover.muted, cloudHouse)
	}
	if dto.Phase != backup.MoveHoming {
		t.Fatalf("phase = %q, want %q", dto.Phase, backup.MoveHoming)
	}
	record, err := journal.Read()
	if err != nil || record == nil {
		t.Fatalf("journal.Read() = %+v, %v", record, err)
	}
	if record.FromChannel != EntryTelegram && record.FromChannel != EntryWeChat {
		t.Fatalf("FromChannel = %q, want one of the two entries", record.FromChannel)
	}
	if record.ArchivePath == "" {
		t.Fatal("ArchivePath is empty")
	}
}

func TestStartMoveStopsBeforeMutingWhenPackingFails(t *testing.T) {
	service, mover, store, journal := newMoveService(t)
	store.target, store.ok = cloudHouse, true
	mover.failExport = true

	if _, err := service.StartMove(); err == nil {
		t.Fatal("StartMove must fail when packing fails")
	}
	if record, _ := journal.Read(); record != nil {
		t.Fatalf("journal = %+v, want empty", record)
	}
	if mover.muted != (domain.Target{}) {
		t.Fatalf("the old residence was muted after a failed export")
	}
}

func TestStartMoveRefusesASecondMove(t *testing.T) {
	service, _, store, _ := newMoveService(t)
	store.target, store.ok = cloudHouse, true
	if _, err := service.StartMove(); err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	_, err := service.StartMove()
	if code := appErrorCode(err); code != CodeMoveAlreadyRunning {
		t.Fatalf("code = %q, want %q", code, CodeMoveAlreadyRunning)
	}
}

func TestSettleMoveRecordsTheOldResidenceAndRestores(t *testing.T) {
	service, mover, store, journal := newMoveService(t)
	store.target, store.ok = cloudHouse, true
	if _, err := service.StartMove(); err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	store.target = boxHouse

	if err := service.SettleMove(); err != nil {
		t.Fatalf("SettleMove: %v", err)
	}
	if mover.restored != boxHouse {
		t.Fatalf("restored %+v, want %+v", mover.restored, boxHouse)
	}
	previous, ok, err := store.Previous()
	if err != nil || !ok || previous != cloudHouse {
		t.Fatalf("Previous() = %+v ok %v err %v", previous, ok, err)
	}
	if record, _ := journal.Read(); record == nil || record.Phase != backup.MoveDone {
		t.Fatalf("journal = %+v, want phase %q", record, backup.MoveDone)
	}
}

func TestSettleMoveRefusesMissingArchive(t *testing.T) {
	service, _, store, journal := newMoveService(t)
	store.target, store.ok = cloudHouse, true
	if _, err := service.StartMove(); err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	record, err := journal.Read()
	if err != nil || record == nil {
		t.Fatalf("journal.Read() = %+v, %v", record, err)
	}
	if err := os.Remove(record.ArchivePath); err != nil {
		t.Fatalf("remove archive: %v", err)
	}
	store.target = boxHouse

	if code := appErrorCode(service.SettleMove()); code != CodeMoveArchiveMissing {
		t.Fatalf("code = %q, want %q", code, CodeMoveArchiveMissing)
	}
}

func TestMoveBackSwapsAndRevives(t *testing.T) {
	service, mover, store, journal := newMoveService(t)
	store.target, store.ok = cloudHouse, true
	if _, err := service.StartMove(); err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	store.target = boxHouse
	if err := service.SettleMove(); err != nil {
		t.Fatalf("SettleMove: %v", err)
	}
	record, err := journal.Read()
	if err != nil || record == nil {
		t.Fatalf("journal.Read() = %+v, %v", record, err)
	}
	if err := os.Remove(record.ArchivePath); err != nil {
		t.Fatalf("remove archive: %v", err)
	}

	if err := service.MoveBack(); err != nil {
		t.Fatalf("MoveBack: %v", err)
	}
	if current, _, _ := store.Load(); current != cloudHouse {
		t.Fatalf("current = %+v, want %+v", current, cloudHouse)
	}
	if mover.revived != record.FromChannel {
		t.Fatalf("revived %q, want %q", mover.revived, record.FromChannel)
	}
}

func TestAbandonMoveKeepsTheOldResidenceSilent(t *testing.T) {
	service, mover, store, journal := newMoveService(t)
	store.target, store.ok = cloudHouse, true
	if _, err := service.StartMove(); err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	if err := service.AbandonMove(); err != nil {
		t.Fatalf("AbandonMove: %v", err)
	}
	if record, _ := journal.Read(); record == nil || record.Phase != backup.MoveAbandoned {
		t.Fatalf("journal = %+v, want phase %q", record, backup.MoveAbandoned)
	}
	if mover.revived != "" {
		t.Fatalf("abandoning must not revive anything, revived %q", mover.revived)
	}

	if err := service.ReviveOldHouse(); err != nil {
		t.Fatalf("ReviveOldHouse: %v", err)
	}
	record, _ := journal.Read()
	if mover.revived == "" || (record != nil && mover.revived != record.FromChannel) {
		t.Fatalf("revived %q, want the recorded entry", mover.revived)
	}
}

func TestBootStateReportsTheMoveInProgress(t *testing.T) {
	service, _, store, _ := newMoveService(t)
	store.target, store.ok = cloudHouse, true
	if _, err := service.StartMove(); err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	store.target = boxHouse

	state, err := service.BootState()
	if err != nil {
		t.Fatalf("BootState: %v", err)
	}
	if state.MoveInProgress == nil || state.MoveInProgress.Phase != backup.MoveHoming {
		t.Fatalf("MoveInProgress = %+v", state.MoveInProgress)
	}
	if state.PreviousTarget != nil {
		t.Fatalf("PreviousTarget = %+v, want nil before settling", state.PreviousTarget)
	}
}
