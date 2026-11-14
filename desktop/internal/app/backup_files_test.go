package app

import (
	"github.com/deskwand/bot/desktop/internal/domain"

	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackupFileNameUsesTheResidenceName(t *testing.T) {
	now := time.Date(2026, 11, 14, 9, 30, 0, 0, time.UTC)
	if name := backupFileName(domain.Target{ScriptName: "deskwand-bot"}, now); name != "deskwand-backup-deskwand-bot-20261114-093000.zip" {
		t.Fatalf("worker name = %q", name)
	}
	box := domain.Target{Kind: domain.TargetContainer, Host: domain.HostRef{Address: "10.0.0.5", Dir: "/home/bot/deskwand"}}
	if name := backupFileName(box, now); name != "deskwand-backup-10.0.0.5-20261114-093000.zip" {
		t.Fatalf("container name = %q", name)
	}
	local := domain.Target{Kind: domain.TargetContainer, Host: domain.HostRef{Transport: domain.TransportLocal, Engine: domain.EngineCompose, Dir: "/tmp/deskwand"}}
	if name := backupFileName(local, now); name != "deskwand-backup-local-20261114-093000.zip" {
		t.Fatalf("local name = %q", name)
	}
}

func TestBackupFileName(t *testing.T) {
	now := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	if got, want := backupFileName(domain.Target{ScriptName: "deskwand-bot"}, now), "deskwand-backup-deskwand-bot-20261104-100000.zip"; got != want {
		t.Fatalf("backupFileName = %q, want %q", got, want)
	}
}

func TestBackupFilesListsNewestFirst(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{
		"deskwand-backup-b-20261101-000000.zip",
		"deskwand-backup-b-20261103-000000.zip",
		"deskwand-backup-b-20261102-000000.zip",
		"notes.txt",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "deskwand-backup-dir.zip"), 0o700); err != nil {
		t.Fatal(err)
	}

	names, err := backupFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"deskwand-backup-b-20261103-000000.zip",
		"deskwand-backup-b-20261102-000000.zip",
		"deskwand-backup-b-20261101-000000.zip",
	}
	if len(names) != len(want) {
		t.Fatalf("backupFiles = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("backupFiles = %v, want %v", names, want)
		}
	}
}

func TestBackupFilesMissingDirIsEmpty(t *testing.T) {
	names, err := backupFiles(filepath.Join(t.TempDir(), "absent"))
	if err != nil {
		t.Fatalf("missing dir returned %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("missing dir returned %v", names)
	}
}

func TestPruneBackupsOnlyRemovesOwnFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{
		"deskwand-backup-b-20261101-000000.zip",
		"deskwand-backup-b-20261102-000000.zip",
		"deskwand-backup-b-20261103-000000.zip",
		"pre-restore-20261101-000000.zip",
		"notes.txt",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := pruneBackups(dir, 2); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{
		"deskwand-backup-b-20261103-000000.zip",
		"deskwand-backup-b-20261102-000000.zip",
		"pre-restore-20261101-000000.zip",
		"notes.txt",
	} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s was removed: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "deskwand-backup-b-20261101-000000.zip")); !os.IsNotExist(err) {
		t.Fatalf("oldest backup survived prune: %v", err)
	}
}
