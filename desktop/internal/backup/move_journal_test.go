package backup

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func newMoveJournal(t *testing.T) *MoveJournal {
	t.Helper()
	journal, err := NewMoveJournal(filepath.Join(t.TempDir(), "move.json"))
	if err != nil {
		t.Fatalf("NewMoveJournal: %v", err)
	}
	return journal
}

func TestMoveJournalStartsEmpty(t *testing.T) {
	record, err := newMoveJournal(t).Read()
	if err != nil || record != nil {
		t.Fatalf("Read() = %+v, %v; want nil, nil", record, err)
	}
}

func TestMoveJournalRoundTrips(t *testing.T) {
	journal := newMoveJournal(t)
	want := MoveRecord{
		Phase:       MoveMuting,
		ArchivePath: "/tmp/deskwand-backup-box-20261114-093000.zip",
		From:        domain.Target{AccountID: "0123456789abcdef0123456789abcdef", ScriptName: "deskwand-bot"},
		FromChannel: "telegram",
		Summary:     ManifestBrief{Release: "0.1.51", ExportedAt: "2026-11-14T09:30:00Z", Bytes: 4096},
	}
	if err := journal.Write(want); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, err := journal.Read()
	if err != nil || got == nil {
		t.Fatalf("Read() = %+v, %v", got, err)
	}
	if got.Phase != want.Phase || got.ArchivePath != want.ArchivePath || got.From != want.From ||
		got.FromChannel != want.FromChannel || got.Summary != want.Summary {
		t.Fatalf("record = %+v, want %+v", *got, want)
	}
	if got.UpdatedAt.IsZero() {
		t.Fatal("UpdatedAt is zero")
	}
}

func TestMoveJournalRoundTripsAContainerResidence(t *testing.T) {
	journal := newMoveJournal(t)
	want := domain.Target{Kind: domain.TargetContainer, Host: domain.HostRef{
		Transport: domain.TransportSSH, Engine: domain.EngineCompose,
		Address: "10.0.0.5", Port: 2222, User: "bot", Auth: domain.SSHAuthKey,
		KeyPath: "/home/me/.ssh/id_ed25519", Dir: "/home/bot/deskwand",
	}}
	if err := journal.Write(MoveRecord{Phase: MoveMuting, From: want}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, err := journal.Read()
	if err != nil || got == nil {
		t.Fatalf("Read() = %+v, %v", got, err)
	}
	if got.From != want {
		t.Fatalf("From = %+v, want %+v", got.From, want)
	}
}

func TestMoveJournalRejectsCorruptFile(t *testing.T) {
	j := newMoveJournal(t)
	if err := os.WriteFile(j.path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write corrupt file: %v", err)
	}
	if _, err := j.Read(); err == nil {
		t.Fatal("Read() must reject a corrupt journal")
	}
}

func TestMoveJournalClearRemovesTheRecord(t *testing.T) {
	j := newMoveJournal(t)
	if err := j.Write(MoveRecord{Phase: MovePacking}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := j.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if record, err := j.Read(); err != nil || record != nil {
		t.Fatalf("Read() = %+v, %v; want nil, nil", record, err)
	}
}
