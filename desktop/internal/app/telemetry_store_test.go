package app

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestFileTelemetryStoreStartsEnabledWithAGeneratedID(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileTelemetryStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	state, err := store.Telemetry()
	if err != nil {
		t.Fatal(err)
	}
	if !state.Enabled {
		t.Fatal("a fresh install reported telemetry disabled")
	}
	if !uuidPattern.MatchString(state.DeviceID) {
		t.Fatalf("deviceId = %q; want a UUIDv4", state.DeviceID)
	}
	if state.ConfigDone || state.LastVersion != "" {
		t.Fatalf("state = %#v; want the zero facts", state)
	}
	info, err := os.Stat(filepath.Join(dir, "telemetry.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("permissions = %o; want 600", perm)
	}
}

func TestFileTelemetryStoreKeepsOneDeviceID(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileTelemetryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.DeviceID()
	if err != nil {
		t.Fatal(err)
	}
	again, err := NewFileTelemetryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := again.DeviceID()
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("deviceId changed across stores: %q then %q", first, second)
	}
}

func TestFileTelemetryStorePersistsTheSwitch(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileTelemetryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetTelemetryEnabled(false); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewFileTelemetryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Enabled() {
		t.Fatal("the opt-out was forgotten across restarts")
	}
	if err := reopened.SetTelemetryEnabled(true); err != nil {
		t.Fatal(err)
	}
	if !reopened.Enabled() {
		t.Fatal("turning telemetry back on was not stored")
	}
}

func TestFileTelemetryStoreRecordsConfigDoneOnce(t *testing.T) {
	store, err := NewFileTelemetryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.MarkConfigDone()
	if err != nil || !first {
		t.Fatalf("MarkConfigDone() = %v, %v; want true, nil", first, err)
	}
	second, err := store.MarkConfigDone()
	if err != nil || second {
		t.Fatalf("MarkConfigDone() again = %v, %v; want false, nil", second, err)
	}
	state, err := store.Telemetry()
	if err != nil || !state.ConfigDone {
		t.Fatalf("state = %#v, %v; want configDone", state, err)
	}
}

func TestFileTelemetryStoreRecordsTheRunningVersion(t *testing.T) {
	store, err := NewFileTelemetryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RecordVersion("0.1.7"); err != nil {
		t.Fatal(err)
	}
	state, err := store.Telemetry()
	if err != nil || state.LastVersion != "0.1.7" {
		t.Fatalf("LastVersion = %q, %v; want 0.1.7", state.LastVersion, err)
	}
}

func TestFileTelemetryStoreFailsClosedOnACorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.json")
	if err := os.WriteFile(path, []byte(`{"disabled": true,`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewFileTelemetryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if store.Enabled() {
		t.Fatal("a corrupt file re-enabled reporting for an opted-out user")
	}
	// Repairing the file keeps the opt-out: a decode failure is not consent.
	if err := store.SetTelemetryEnabled(false); err != nil {
		t.Fatal(err)
	}
	state, err := store.Telemetry()
	if err != nil {
		t.Fatal(err)
	}
	if state.Enabled || !uuidPattern.MatchString(state.DeviceID) {
		t.Fatalf("state = %#v; want a fresh id and the opt-out kept", state)
	}
	// The switch can still be turned back on deliberately.
	if err := store.SetTelemetryEnabled(true); err != nil {
		t.Fatal(err)
	}
	if !store.Enabled() {
		t.Fatal("the user could not turn telemetry back on")
	}
}

func TestFileTelemetryStoreReportsDisabledWhenItCannotRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })

	store, err := NewFileTelemetryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if store.Enabled() {
		t.Fatal("an unreadable file reported telemetry enabled")
	}
}

func TestFileTelemetryStoreRejectsAnEmptyDir(t *testing.T) {
	if _, err := NewFileTelemetryStore("  "); err == nil {
		t.Fatal("an empty app data directory was accepted")
	}
}
