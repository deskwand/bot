package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func newBackupSettings(t *testing.T) (*FileBackupSettings, string) {
	t.Helper()
	appDir := t.TempDir()
	store, err := NewFileBackupSettings(appDir, filepath.Join(appDir, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	return store, appDir
}

func TestFileBackupSettingsDefaultsToDocuments(t *testing.T) {
	store, _ := newBackupSettings(t)

	settings, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	if want := defaultBackupDir(filepath.Join(t.TempDir(), "backups")); settings.Dir != want {
		t.Fatalf("dir = %q, want %q", settings.Dir, want)
	}
	if !filepath.IsAbs(settings.Dir) {
		t.Fatalf("default dir is not absolute: %q", settings.Dir)
	}
	if settings.Auto || settings.IntervalHours != 24 || settings.Keep != 5 {
		t.Fatalf("defaults = %#v", settings)
	}
	if settings.LastSuccessAt != "" {
		t.Fatalf("LastSuccessAt = %q, want empty", settings.LastSuccessAt)
	}
}

func TestSettingsFromFileNormalizesBadValues(t *testing.T) {
	settings := settingsFromFile(backupSettingsFile{
		Dir: "relative/path", Auto: true, IntervalHours: 2, Keep: 3,
	}, "/fallback")
	if settings.Dir != defaultBackupDir("/fallback") {
		t.Fatalf("dir = %q, want the default folder", settings.Dir)
	}
	if settings.IntervalHours != 24 || settings.Keep != 5 {
		t.Fatalf("normalized = %#v", settings)
	}
	if !settings.Auto {
		t.Fatalf("normalizing cleared the auto flag: %#v", settings)
	}
}

func TestFileBackupSettingsRejectsUnwritableDir(t *testing.T) {
	store, _ := newBackupSettings(t)
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := store.Save(BackupSettingsEditDTO{
		Dir: filepath.Join(blocker, "child"), Auto: true, IntervalHours: 6, Keep: 3,
	})
	if !hasCode(err, backup.CodeBackupSettingsInvalid) {
		t.Fatalf("Save error = %v, want %s", err, backup.CodeBackupSettingsInvalid)
	}
	settings, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	if settings.Auto || settings.Dir == filepath.Join(blocker, "child") {
		t.Fatalf("rejected settings were stored: %#v", settings)
	}
}

func TestFileBackupSettingsRejectsBadChoices(t *testing.T) {
	store, _ := newBackupSettings(t)
	dir := t.TempDir()
	for name, input := range map[string]BackupSettingsEditDTO{
		"empty dir":    {Dir: "", IntervalHours: 24, Keep: 5},
		"relative dir": {Dir: "backups", IntervalHours: 24, Keep: 5},
		"interval":     {Dir: dir, IntervalHours: 2, Keep: 5},
		"keep":         {Dir: dir, IntervalHours: 24, Keep: 3},
	} {
		if _, err := store.Save(input); !hasCode(err, backup.CodeBackupSettingsInvalid) {
			t.Fatalf("%s: %v, want %s", name, err, backup.CodeBackupSettingsInvalid)
		}
	}
}

func TestFileBackupSettingsRoundTrips(t *testing.T) {
	store, appDir := newBackupSettings(t)
	dir := t.TempDir()

	saved, err := store.Save(BackupSettingsEditDTO{
		Dir: dir, Auto: true, IntervalHours: 6, Keep: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Dir != dir || !saved.Auto || saved.IntervalHours != 6 || saved.Keep != 10 {
		t.Fatalf("saved = %#v", saved)
	}
	// A fresh store reads the same file back.
	again, err := NewFileBackupSettings(appDir, filepath.Join(appDir, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := again.Settings()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded != saved {
		t.Fatalf("reloaded = %#v, want %#v", reloaded, saved)
	}
}

func TestFileBackupSettingsRecordRun(t *testing.T) {
	store, _ := newBackupSettings(t)
	at := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)

	settings, err := store.RecordRun(at, "/tmp/a.zip", nil)
	if err != nil {
		t.Fatal(err)
	}
	if settings.LastSuccessAt != "2026-11-04T10:00:00Z" || settings.LastSuccessPath != "/tmp/a.zip" {
		t.Fatalf("success record = %#v", settings)
	}
	if settings.LastAttemptAt != "2026-11-04T10:00:00Z" {
		t.Fatalf("success did not record the attempt: %#v", settings)
	}
	if settings.LastErrorCode != "" || settings.LastErrorMessage != "" {
		t.Fatalf("success record kept an error: %#v", settings)
	}

	settings, err = store.RecordRun(at.Add(time.Hour), "", domain.Error{
		Code: backup.CodeBackupFailed, Message: "备份失败",
	})
	if err != nil {
		t.Fatal(err)
	}
	// The failure moves the attempt forward but leaves the last success alone.
	if settings.LastAttemptAt != "2026-11-04T11:00:00Z" {
		t.Fatalf("failure did not record the attempt: %#v", settings)
	}
	if settings.LastSuccessAt != "2026-11-04T10:00:00Z" || settings.LastSuccessPath != "/tmp/a.zip" {
		t.Fatalf("failure replaced the last success: %#v", settings)
	}
	if settings.LastErrorCode != backup.CodeBackupFailed || settings.LastErrorMessage != "备份失败" {
		t.Fatalf("failure record = %#v", settings)
	}
}

func TestFileBackupSettingsSurvivesCorruptFile(t *testing.T) {
	store, appDir := newBackupSettings(t)
	if err := os.WriteFile(filepath.Join(appDir, "backup.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	settings, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	if settings.IntervalHours != 24 || settings.Keep != 5 {
		t.Fatalf("corrupt file did not fall back: %#v", settings)
	}

	// A save replaces the unreadable file instead of failing forever.
	if _, err := store.Save(BackupSettingsEditDTO{Dir: t.TempDir(), IntervalHours: 1, Keep: 1}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(appDir, "backup.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file backupSettingsFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("rewritten file is not JSON: %v", err)
	}
	if file.IntervalHours != 1 || file.Keep != 1 {
		t.Fatalf("rewritten file = %#v", file)
	}
}

func TestEnsureWritableDirKeepsExistingFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".deskwand-write-probe"), 0o700); err != nil {
		t.Fatal(err)
	}
	kept := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(kept, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ensureWritableDir(dir); err != nil {
		t.Fatalf("ensureWritableDir = %v, want nil", err)
	}
	if data, err := os.ReadFile(kept); err != nil || string(data) != "keep me" {
		t.Fatalf("existing file changed: %q %v", data, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != "notes.txt" && entry.Name() != ".deskwand-write-probe" {
			t.Fatalf("probe file was left behind: %s", entry.Name())
		}
	}
}
