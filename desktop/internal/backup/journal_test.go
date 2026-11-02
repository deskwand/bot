package backup

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestJournalPendingWithoutRecord(t *testing.T) {
	journal, err := NewRestoreJournal(filepath.Join(t.TempDir(), "restore"))
	if err != nil {
		t.Fatal(err)
	}
	record, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if record != nil {
		t.Fatalf("pending = %+v, want nil", record)
	}
}

func TestJournalRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "restore")
	journal, err := NewRestoreJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	record := RestoreRecord{
		OperationID:  "op-1",
		Target:       domain.Target{AccountID: "acc", ScriptName: "deskwand-bot"},
		BackupPath:   "/backups/backup.zip",
		SnapshotPath: "/backups/pre-restore-20261102-100000.zip",
		State:        "running",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := journal.Save(record); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "restore.json")); err != nil {
		t.Fatalf("journal file is missing: %v", err)
	}

	pending, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending == nil || *pending != record {
		t.Fatalf("pending = %+v, want %+v", pending, record)
	}

	record.State = "failed"
	record.FailureCode = CodeBackupInvalid
	record.UpdatedAt = now.Add(time.Minute)
	if err := journal.Save(record); err != nil {
		t.Fatal(err)
	}
	pending, err = journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending == nil || *pending != record {
		t.Fatalf("pending after update = %+v, want %+v", pending, record)
	}

	if err := journal.Clear(); err != nil {
		t.Fatal(err)
	}
	pending, err = journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("pending after clear = %+v, want nil", pending)
	}
	// Clearing twice is harmless so a successful retry cannot fail on cleanup.
	if err := journal.Clear(); err != nil {
		t.Fatal(err)
	}
}

func TestJournalCorruptRecordHasDedicatedCode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "restore")
	journal, err := NewRestoreJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "restore.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Pending(); err == nil {
		t.Fatal("a corrupt journal was accepted")
	} else if code := adminErrorCode(t, err); code != CodeRestoreJournalCorrupt {
		t.Fatalf("code = %q", code)
	}
}

func TestJournalClearWorksWithCorruptRecord(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "restore")
	journal, err := NewRestoreJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "restore.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Clear must not decode the record first: a corrupt journal still has to
	// be abandonable from the UI.
	if err := journal.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("corrupt journal still exists: %v", err)
	}
}
