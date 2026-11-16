package backup

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openCheckpoint(t *testing.T, dir string) *Checkpoint {
	t.Helper()
	checkpoint, err := OpenCheckpoint(dir, "acc/deskwand-bot")
	if err != nil {
		t.Fatalf("OpenCheckpoint: %v", err)
	}
	return checkpoint
}

func TestCheckpointSkipsATableThatFinished(t *testing.T) {
	dir := t.TempDir()
	checkpoint := openCheckpoint(t, dir)
	ref := DORef{DO: "task", ID: "t1"}

	if checkpoint.HasTable(ref, "notes") {
		t.Fatal("a table is complete before anything was written")
	}
	if err := checkpoint.AppendTable(ref, "notes", []json.RawMessage{
		json.RawMessage(`{"n":1}`),
		json.RawMessage(`{"n":2}`),
	}, true); err != nil {
		t.Fatalf("AppendTable: %v", err)
	}
	if !checkpoint.HasTable(ref, "notes") {
		t.Fatal("a written table is not reported complete")
	}
	if got := checkpoint.TableRows(ref, "notes"); got != 2 {
		t.Fatalf("rows = %d, want 2", got)
	}

	reopened := openCheckpoint(t, dir)
	if !reopened.HasTable(ref, "notes") {
		t.Fatal("a reopened checkpoint lost the completed table")
	}
	if got := reopened.TableRows(ref, "notes"); got != 2 {
		t.Fatalf("rows after reopen = %d, want 2", got)
	}
	body, err := reopened.ReadTable(ref, "notes")
	if err != nil {
		t.Fatalf("ReadTable: %v", err)
	}
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if want := "{\"n\":1}\n{\"n\":2}\n"; string(raw) != want {
		t.Fatalf("rows = %q, want %q", raw, want)
	}
}

func TestCheckpointTracksTablesOfObjectsWithoutAnID(t *testing.T) {
	// Butler, channel, life and wallet have no object id; their keys must not
	// pick up a stray separator.
	checkpoint := openCheckpoint(t, t.TempDir())
	ref := DORef{DO: "butler"}

	if err := checkpoint.AppendTable(ref, "memories", []json.RawMessage{
		json.RawMessage(`{"n":1}`),
		json.RawMessage(`{"n":2}`),
	}, true); err != nil {
		t.Fatalf("AppendTable: %v", err)
	}
	reopened := openCheckpoint(t, checkpoint.Dir())
	if !reopened.HasTable(ref, "memories") {
		t.Fatal("a finished table of an object without an id is not reported complete")
	}
	if got := reopened.TableRows(ref, "memories"); got != 2 {
		t.Fatalf("rows = %d, want 2", got)
	}
}

func TestCheckpointAppendsBatchesToATable(t *testing.T) {
	checkpoint := openCheckpoint(t, t.TempDir())
	ref := DORef{DO: "task", ID: "t1"}

	if err := checkpoint.AppendTable(ref, "notes", []json.RawMessage{json.RawMessage(`{"n":1}`)}, false); err != nil {
		t.Fatalf("AppendTable: %v", err)
	}
	if checkpoint.HasTable(ref, "notes") {
		t.Fatal("an unfinished table is reported complete")
	}
	if err := checkpoint.AppendTable(ref, "notes", []json.RawMessage{json.RawMessage(`{"n":2}`)}, true); err != nil {
		t.Fatalf("AppendTable: %v", err)
	}

	body, err := checkpoint.ReadTable(ref, "notes")
	if err != nil {
		t.Fatalf("ReadTable: %v", err)
	}
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if want := "{\"n\":1}\n{\"n\":2}\n"; string(raw) != want {
		t.Fatalf("rows = %q, want %q", raw, want)
	}
}

func TestCheckpointIgnoresAnUnfinishedTable(t *testing.T) {
	dir := t.TempDir()
	checkpoint := openCheckpoint(t, dir)
	ref := DORef{DO: "task", ID: "t1"}

	if err := os.MkdirAll(filepath.Join(dir, "do", "task", "t1"), 0o700); err != nil {
		t.Fatal(err)
	}
	part := filepath.Join(dir, "do", "task", "t1", "notes.jsonl.part")
	if err := os.WriteFile(part, []byte("{\"n\":1}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if checkpoint.HasTable(ref, "notes") {
		t.Fatal("a half-written table is reported complete")
	}
}

func TestOpenCheckpointDropsStateForAnotherTarget(t *testing.T) {
	dir := t.TempDir()
	first := openCheckpoint(t, dir)
	ref := DORef{DO: "task", ID: "t1"}
	if err := first.AppendTable(ref, "notes", []json.RawMessage{json.RawMessage(`{"n":1}`)}, true); err != nil {
		t.Fatal(err)
	}

	other, err := OpenCheckpoint(dir, "acc/another-worker")
	if err != nil {
		t.Fatalf("OpenCheckpoint: %v", err)
	}
	if other.HasTable(ref, "notes") {
		t.Fatal("a checkpoint from another target was reused")
	}
}

func TestCheckpointDiscardRemovesEverything(t *testing.T) {
	checkpoint := openCheckpoint(t, t.TempDir())
	if err := checkpoint.AppendTable(DORef{DO: "butler"}, "memories", []json.RawMessage{json.RawMessage(`{"n":1}`)}, true); err != nil {
		t.Fatal(err)
	}
	if err := checkpoint.Discard(); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	if _, err := os.Stat(checkpoint.Dir()); !os.IsNotExist(err) {
		t.Fatalf("checkpoint directory still exists: %v", err)
	}
}

func TestCheckpointPathKeepsOneDirectoryPerResidence(t *testing.T) {
	dir, key := checkpointPath("/backups", backupTestTarget)
	if want := filepath.Join("/backups", ".resume-acc-deskwand-bot"); dir != want {
		t.Fatalf("dir = %q, want %q", dir, want)
	}
	if want := "acc/deskwand-bot"; key != want {
		t.Fatalf("key = %q, want %q", key, want)
	}
}

func TestCheckpointIgnoresATableWhoseFileIsGone(t *testing.T) {
	dir := t.TempDir()
	checkpoint := openCheckpoint(t, dir)
	ref := DORef{DO: "task", ID: "t1"}
	if err := checkpoint.AppendTable(ref, "notes", []json.RawMessage{json.RawMessage(`{"n":1}`)}, true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "do", "task", "t1", "notes.jsonl")); err != nil {
		t.Fatal(err)
	}

	reopened := openCheckpoint(t, dir)
	if reopened.HasTable(ref, "notes") {
		t.Fatal("a table whose file is gone is still reported complete")
	}
}

func TestCheckpointRejectsAShortArtifact(t *testing.T) {
	checkpoint := openCheckpoint(t, t.TempDir())
	err := checkpoint.WriteObject("r2/000001", strings.NewReader("abc"), 10)
	if err == nil {
		t.Fatal("a short artifact was accepted")
	}
	if checkpoint.HasObject("r2/000001") {
		t.Fatal("a short artifact is recorded as present")
	}
}

func TestCheckpointForgetKeepsOtherObjects(t *testing.T) {
	dir := t.TempDir()
	checkpoint := openCheckpoint(t, dir)
	kept := DORef{DO: "task", ID: "t1"}
	dropped := DORef{DO: "task", ID: "t2"}
	if err := checkpoint.AppendTable(kept, "notes", []json.RawMessage{json.RawMessage(`{"n":1}`)}, true); err != nil {
		t.Fatal(err)
	}
	if err := checkpoint.AppendTable(dropped, "notes", []json.RawMessage{
		json.RawMessage(`{"n":2}`), json.RawMessage(`{"n":3}`),
	}, true); err != nil {
		t.Fatal(err)
	}
	// A half-written file of the object being forgotten goes too.
	part := filepath.Join(dir, "do", "task", "t2", "other.jsonl.part")
	if err := os.WriteFile(part, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	tables, rows, err := checkpoint.Forget(dropped)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if tables != 1 || rows != 2 {
		t.Fatalf("forgot %d tables / %d rows, want 1 / 2", tables, rows)
	}
	if checkpoint.HasTable(dropped, "notes") {
		t.Fatal("the forgotten object still has its table")
	}
	if _, err := os.Stat(filepath.Join(dir, "do", "task", "t2", "notes.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("the forgotten file still exists: %v", err)
	}
	if _, err := os.Stat(part); !os.IsNotExist(err) {
		t.Fatalf("the forgotten .part file still exists: %v", err)
	}
	if !checkpoint.HasTable(kept, "notes") {
		t.Fatal("forgetting one object dropped another object's table")
	}
	if got := checkpoint.TableRows(kept, "notes"); got != 1 {
		t.Fatalf("kept rows = %d, want 1", got)
	}
}
