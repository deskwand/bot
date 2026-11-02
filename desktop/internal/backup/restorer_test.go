package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

var restoreTestRefs = []DORef{
	{DO: "butler"},
	{DO: "task", ID: "t1"},
	{DO: "task", ID: "t2"},
	{DO: "channel"},
}

// seedRestoreWorker fills a fake Worker with one Butler, two tasks and a
// channel hub, plus two artifacts. Every table has more rows than one fake
// page, so a restore has to page through them.
func seedRestoreWorker(t *testing.T) *fakeWorker {
	t.Helper()
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.taskIDs = []string{"t1", "t2"}
	worker.setDO(DORef{DO: "butler"}, DBSchema{
		Tables: []TableSchema{
			{Name: "memories", Create: `CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)`},
			{Name: "tasks", Create: `CREATE TABLE tasks (id TEXT PRIMARY KEY)`},
		},
		Indexes: []string{`CREATE INDEX memories_text ON memories (text)`},
	}, map[string][]json.RawMessage{
		"memories": {
			json.RawMessage(`{"__rowid":1,"id":"m1","text":"喜欢绿茶"}`),
			json.RawMessage(`{"__rowid":2,"id":"m2","text":"住杭州"}`),
			json.RawMessage(`{"__rowid":3,"id":"m3","text":"用 python"}`),
		},
		"tasks": {
			json.RawMessage(`{"__rowid":1,"id":"t1"}`),
			json.RawMessage(`{"__rowid":2,"id":"t2"}`),
		},
	})
	worker.setDO(DORef{DO: "task", ID: "t1"}, DBSchema{
		Tables: []TableSchema{{Name: "meta", Create: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`}},
	}, map[string][]json.RawMessage{
		"meta": {
			json.RawMessage(`{"__rowid":1,"key":"state","value":"done"}`),
			json.RawMessage(`{"__rowid":2,"key":"title","value":"买牛奶"}`),
		},
	})
	worker.setDO(DORef{DO: "task", ID: "t2"}, DBSchema{
		Tables: []TableSchema{{Name: "meta", Create: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`}},
	}, map[string][]json.RawMessage{
		"meta": {json.RawMessage(`{"__rowid":1,"key":"state","value":"running"}`)},
	})
	worker.setDO(DORef{DO: "channel"}, DBSchema{
		Tables: []TableSchema{{Name: "__kv", WithoutRowid: true}},
	}, map[string][]json.RawMessage{
		"__kv": {
			json.RawMessage(`{"key":"schema_version","value":"3"}`),
			json.RawMessage(`{"key":"owner","value":"u1"}`),
			json.RawMessage(`{"key":"cursor","value":"abc"}`),
		},
	})
	worker.addObject("artifacts/a b.png", "image/png", []byte("png-bytes"))
	worker.addObject("notes/readme.txt", "text/plain", []byte("hello"))
	return worker
}

type capturedObject struct {
	body        string
	contentType string
}

func captureRows(t *testing.T, worker *fakeWorker, refs []DORef) map[string]map[string][]json.RawMessage {
	t.Helper()
	captured := make(map[string]map[string][]json.RawMessage, len(refs))
	for _, ref := range refs {
		captured[doKey(ref)] = worker.rowsOf(ref)
	}
	return captured
}

func captureObjects(t *testing.T, worker *fakeWorker) map[string]capturedObject {
	t.Helper()
	captured := map[string]capturedObject{}
	for _, key := range worker.objectKeys() {
		body, contentType, ok := worker.object(key)
		if !ok {
			t.Fatalf("object %s is missing", key)
		}
		captured[key] = capturedObject{body: string(body), contentType: contentType}
	}
	return captured
}

func assertObjectsEqual(t *testing.T, worker *fakeWorker, want map[string]capturedObject) {
	t.Helper()
	keys := make([]string, 0, len(want))
	for key := range want {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if got := worker.objectKeys(); !reflect.DeepEqual(got, keys) {
		t.Fatalf("object keys = %v, want %v", got, keys)
	}
	for key, object := range want {
		body, contentType, ok := worker.object(key)
		if !ok || string(body) != object.body || contentType != object.contentType {
			t.Fatalf("object %s = %q (%s), want %q (%s)", key, body, contentType, object.body, object.contentType)
		}
	}
}

func assertDORows(t *testing.T, worker *fakeWorker, ref DORef, want map[string][]json.RawMessage) {
	t.Helper()
	got := worker.rowsOf(ref)
	if len(got) != len(want) {
		t.Fatalf("%s has %d tables, want %d", doKey(ref), len(got), len(want))
	}
	for table, rows := range want {
		assertRowsEqual(t, got[table], rows)
	}
}

func makeRestoreBackup(t *testing.T, worker *fakeWorker, release string) string {
	t.Helper()
	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), release, true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatal(err)
	}
	return path
}

func restoreTestDeps(t *testing.T, worker *fakeWorker, release string) Deps {
	t.Helper()
	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), release, true), "tok", time.Second)
	deps.Now = func() time.Time { return time.Date(2026, 11, 2, 10, 5, 0, 0, time.UTC) }
	return deps
}

func newRestoreJournal(t *testing.T) *RestoreJournal {
	t.Helper()
	journal, err := NewRestoreJournal(filepath.Join(t.TempDir(), "restore"))
	if err != nil {
		t.Fatal(err)
	}
	return journal
}

func restoreCalls(worker *fakeWorker) []fakeRequest {
	var calls []fakeRequest
	for _, request := range worker.requestsLog() {
		if strings.HasPrefix(request.Path, "/admin/restore/") {
			calls = append(calls, request)
		}
	}
	return calls
}

func TestRestoreReplacesAllData(t *testing.T) {
	worker := seedRestoreWorker(t)
	original := captureRows(t, worker, restoreTestRefs)
	originalObjects := captureObjects(t, worker)
	path := makeRestoreBackup(t, worker, "1.2.3")

	// Replace the deployment's data with something else, and add an artifact
	// that the backup does not contain.
	worker.setDO(DORef{DO: "butler"}, worker.schemaOf(DORef{DO: "butler"}), map[string][]json.RawMessage{
		"memories": {json.RawMessage(`{"__rowid":1,"id":"other","text":"多余"}`)},
		"tasks":    {json.RawMessage(`{"__rowid":1,"id":"t1"}`)},
	})
	worker.setDO(DORef{DO: "task", ID: "t1"}, worker.schemaOf(DORef{DO: "task", ID: "t1"}), map[string][]json.RawMessage{
		"meta": {json.RawMessage(`{"__rowid":1,"key":"state","value":"stale"}`)},
	})
	worker.addObject("extra.txt", "text/plain", []byte("stale"))

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	snapshotDir := filepath.Join(t.TempDir(), "backups")

	if err := Restore(context.Background(), deps, journal, backupTestTarget, path, snapshotDir); err != nil {
		t.Fatal(err)
	}

	for _, ref := range restoreTestRefs {
		assertDORows(t, worker, ref, original[doKey(ref)])
		if got := worker.resetsOf(ref); got != 2 {
			t.Fatalf("%s resets = %d, want 2", doKey(ref), got)
		}
	}
	for key, want := range originalObjects {
		body, contentType, ok := worker.object(key)
		if !ok || string(body) != want.body || contentType != want.contentType {
			t.Fatalf("object %s was not restored", key)
		}
	}
	if _, _, ok := worker.object("extra.txt"); ok {
		t.Fatal("an artifact outside the backup survived the restore")
	}
	if worker.hasLease() {
		t.Fatal("the lease was not released")
	}
	pending, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("pending = %+v, want nil", pending)
	}
	entries, err := os.ReadDir(snapshotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "pre-restore-20261102-100500.zip" {
		t.Fatalf("snapshot directory = %+v", entries)
	}
}

func TestRestoreRefusesVersionMismatch(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.0")
	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.3.0")

	err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups"))
	if code := adminErrorCode(t, err); code != CodeBackupVersionMismatch {
		t.Fatalf("code = %q", code)
	}
	if got := len(restoreCalls(worker)); got != 0 {
		t.Fatalf("restore calls = %d, want 0", got)
	}
	pending, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("pending = %+v, want nil", pending)
	}
}

func TestRestoreRefusesUnknownRelease(t *testing.T) {
	cases := []struct {
		name    string
		backup  string
		current string
	}{
		{name: "backup unknown", backup: "", current: "1.2.3"},
		{name: "deployment unknown", backup: "1.2.3", current: ""},
		{name: "both unknown", backup: "", current: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			worker := seedRestoreWorker(t)
			path := makeRestoreBackup(t, worker, testCase.backup)
			journal := newRestoreJournal(t)
			deps := restoreTestDeps(t, worker, testCase.current)

			err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups"))
			if code := adminErrorCode(t, err); code != CodeBackupVersionMismatch {
				t.Fatalf("code = %q", code)
			}
			if got := len(restoreCalls(worker)); got != 0 {
				t.Fatalf("restore calls = %d, want 0", got)
			}
		})
	}
}

func TestRestoreRefusesOversizedObjects(t *testing.T) {
	worker := seedRestoreWorker(t)
	worker.addOversizedObject("huge.bin", "application/octet-stream", MaxR2ObjectBytes+1, []byte("tiny"))
	path := makeRestoreBackup(t, worker, "1.2.3")
	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")

	err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups"))
	if code := adminErrorCode(t, err); code != CodeBackupObjectTooLarge {
		t.Fatalf("code = %q", code)
	}
	if got := len(restoreCalls(worker)); got != 0 {
		t.Fatalf("restore calls = %d, want 0", got)
	}
	pending, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("pending = %+v, want nil", pending)
	}
}

func TestRestoreRefusesIncompleteSnapshot(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.3")
	// The deployment gained an artifact that cannot be uploaded back, so the
	// pre-restore snapshot would be unable to undo a restore.
	worker.addOversizedObject("huge.bin", "application/octet-stream", MaxR2ObjectBytes+1, []byte("tiny"))

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	snapshotDir := filepath.Join(t.TempDir(), "backups")

	err := Restore(context.Background(), deps, journal, backupTestTarget, path, snapshotDir)
	if code := adminErrorCode(t, err); code != CodeRestoreSnapshotFailed {
		t.Fatalf("code = %q", code)
	}
	var coded domain.Error
	if !errors.As(err, &coded) || !strings.Contains(coded.Message, "huge.bin") {
		t.Fatalf("error = %v, want the oversized key in the message", err)
	}
	if got := len(restoreCalls(worker)); got != 0 {
		t.Fatalf("restore calls = %d, want 0", got)
	}
	pending, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("pending = %+v, want nil", pending)
	}
	entries, err := os.ReadDir(snapshotDir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("snapshot directory = %+v, want empty", entries)
	}
	if _, _, ok := worker.object("huge.bin"); !ok {
		t.Fatal("the oversized artifact was removed")
	}
}

func TestRestoreStopsWhenSnapshotFails(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.3")
	worker.failRoute("POST", pagePath, "", "", 1, 500)

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	snapshotDir := filepath.Join(t.TempDir(), "backups")

	err := Restore(context.Background(), deps, journal, backupTestTarget, path, snapshotDir)
	if code := adminErrorCode(t, err); code != CodeRestoreSnapshotFailed {
		t.Fatalf("code = %q", code)
	}
	if got := len(restoreCalls(worker)); got != 0 {
		t.Fatalf("restore calls = %d, want 0", got)
	}
	pending, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("pending = %+v, want nil", pending)
	}
	entries, err := os.ReadDir(snapshotDir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("snapshot directory = %+v, want empty", entries)
	}
}

func TestRestoreSnapshotProgressReportsRestoreOp(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.3")
	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	var events []Progress
	deps.Progress = func(progress Progress) { events = append(events, progress) }

	if err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups")); err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 {
		t.Fatal("the restore reported no progress")
	}
	phases := map[string]bool{}
	for _, event := range events {
		if event.Op != "restore" {
			t.Fatalf("progress op = %q, want restore", event.Op)
		}
		phases[event.Phase] = true
	}
	// These phases come from the pre-restore snapshot export and must be
	// attributed to the restore.
	for _, phase := range []string{PhasePreparing, PhaseDatabase, PhaseObjects, PhaseFinishing} {
		if !phases[phase] {
			t.Fatalf("missing phase %q in %+v", phase, events)
		}
	}
}

func TestRestoreClearsExtraTaskDOs(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.3")

	// The deployment gained a task after the backup was taken.
	worker.taskIDs = []string{"t1", "t2", "t9"}
	orphan := DORef{DO: "task", ID: "t9"}
	worker.setDO(orphan, DBSchema{
		Tables: []TableSchema{{Name: "meta", Create: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`}},
	}, map[string][]json.RawMessage{
		"meta": {json.RawMessage(`{"__rowid":1,"key":"state","value":"orphan"}`)},
	})

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	if err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups")); err != nil {
		t.Fatal(err)
	}

	calls := restoreCalls(worker)
	var orphanCalls []fakeRequest
	orphanLast := -1
	backupFirst := -1
	for i, call := range calls {
		if call.DO == "task" && call.ID == "t9" {
			orphanCalls = append(orphanCalls, call)
			orphanLast = i
			continue
		}
		if backupFirst < 0 {
			backupFirst = i
		}
	}
	wantPaths := []string{restoreResetPath, restoreBeginPath, restoreResetPath}
	if len(orphanCalls) != len(wantPaths) {
		t.Fatalf("orphan calls = %v", orphanCalls)
	}
	for i, want := range wantPaths {
		if orphanCalls[i].Path != want {
			t.Fatalf("orphan call %d = %s, want %s", i, orphanCalls[i].Path, want)
		}
	}
	if backupFirst < 0 || orphanLast > backupFirst {
		t.Fatalf("orphan calls do not precede the backup objects: %v", calls)
	}
	if got := worker.resetsOf(orphan); got != 2 {
		t.Fatalf("orphan resets = %d, want 2", got)
	}
	if rows := worker.rowsOf(orphan); len(rows) != 0 {
		t.Fatalf("orphan rows = %+v, want none", rows)
	}
}

func TestRestoreDeletesObjectsNotInBackup(t *testing.T) {
	worker := seedRestoreWorker(t)
	original := captureObjects(t, worker)
	path := makeRestoreBackup(t, worker, "1.2.3")
	worker.addObject("extra.txt", "text/plain", []byte("stale"))

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	if err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups")); err != nil {
		t.Fatal(err)
	}

	keys := worker.objectKeys()
	want := make([]string, 0, len(original))
	for key := range original {
		want = append(want, key)
	}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("object keys = %v, want %v", keys, want)
	}
	for key, object := range original {
		body, contentType, ok := worker.object(key)
		if !ok || string(body) != object.body || contentType != object.contentType {
			t.Fatalf("object %s was not restored", key)
		}
	}
}

func TestRestoreOrder(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.3")
	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")

	if err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups")); err != nil {
		t.Fatal(err)
	}

	calls := restoreCalls(worker)
	var groups []string
	groupOf := func(call fakeRequest) string {
		if call.ID == "" {
			return call.DO
		}
		return call.DO + "/" + call.ID
	}
	for _, call := range calls {
		group := groupOf(call)
		if len(groups) == 0 || groups[len(groups)-1] != group {
			groups = append(groups, group)
		}
	}
	wantGroups := []string{"task/t1", "task/t2", "channel", "butler"}
	if !reflect.DeepEqual(groups, wantGroups) {
		t.Fatalf("restore order = %v, want %v", groups, wantGroups)
	}

	index := 0
	for _, group := range wantGroups {
		start := index
		for index < len(calls) && groupOf(calls[index]) == group {
			index++
		}
		groupCalls := calls[start:index]
		if len(groupCalls) < 4 {
			t.Fatalf("%s calls = %v", group, groupCalls)
		}
		if groupCalls[0].Path != restoreResetPath || groupCalls[1].Path != restoreBeginPath {
			t.Fatalf("%s does not start with reset, begin: %v", group, groupCalls)
		}
		if groupCalls[len(groupCalls)-2].Path != restoreCommitPath || groupCalls[len(groupCalls)-1].Path != restoreResetPath {
			t.Fatalf("%s does not end with commit, reset: %v", group, groupCalls)
		}
		for _, call := range groupCalls[2 : len(groupCalls)-2] {
			if call.Path != restorePagePath {
				t.Fatalf("%s has an unexpected call %s between begin and commit", group, call.Path)
			}
		}
	}

	requests := worker.requestsLog()
	lastRestore := -1
	for i, request := range requests {
		if strings.HasPrefix(request.Path, "/admin/restore/") {
			lastRestore = i
		}
	}
	artifactCalls := 0
	for _, request := range requests[lastRestore+1:] {
		switch request.Path {
		case objectListPath, objectPath:
			artifactCalls++
		case releasePath:
		default:
			t.Fatalf("request %s came after the durable objects", request)
		}
	}
	if artifactCalls == 0 {
		t.Fatal("no artifact requests came after the durable objects")
	}
}

func TestRestoreRenewsLeaseForLargeObjects(t *testing.T) {
	worker := seedRestoreWorker(t)
	body := []byte("01234567890123456789")
	worker.addObject("big.bin", "application/octet-stream", body)
	path := makeRestoreBackup(t, worker, "1.2.3")

	previous := renewEveryBytes
	renewEveryBytes = 10
	defer func() { renewEveryBytes = previous }()

	// The current object is small, so only the restore's upload renews the
	// lease; the pre-restore snapshot export does not.
	worker.addObject("big.bin", "application/octet-stream", []byte("123"))

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	before := worker.requestCount("POST", acquirePath)
	if err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups")); err != nil {
		t.Fatal(err)
	}
	// One acquire for the snapshot export, one for the restore, and one
	// renewal after the 20-byte upload.
	if got := worker.requestCount("POST", acquirePath) - before; got != 3 {
		t.Fatalf("acquire calls = %d, want 3", got)
	}
	restored, _, ok := worker.object("big.bin")
	if !ok || string(restored) != string(body) {
		t.Fatalf("big.bin = %q, want %q", restored, body)
	}
}

func TestRetryAfterMidwayFailure(t *testing.T) {
	worker := seedRestoreWorker(t)
	original := captureRows(t, worker, restoreTestRefs)
	path := makeRestoreBackup(t, worker, "1.2.3")
	worker.setDO(DORef{DO: "butler"}, worker.schemaOf(DORef{DO: "butler"}), map[string][]json.RawMessage{
		"memories": {json.RawMessage(`{"__rowid":1,"id":"other","text":"多余"}`)},
		"tasks":    {json.RawMessage(`{"__rowid":1,"id":"t1"}`)},
	})
	worker.failRoute("POST", restorePagePath, "channel", "", 1, 500)

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	snapshotDir := filepath.Join(t.TempDir(), "backups")

	err := Restore(context.Background(), deps, journal, backupTestTarget, path, snapshotDir)
	if code := adminErrorCode(t, err); code != CodeBackupInvalid {
		t.Fatalf("code = %q", code)
	}
	record, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if record == nil {
		t.Fatal("no record was kept after the failure")
	}
	if record.State != "failed" || record.FailureCode != CodeBackupInvalid {
		t.Fatalf("record = %+v", record)
	}
	wantSnapshot := filepath.Join(snapshotDir, "pre-restore-20261102-100500.zip")
	if record.SnapshotPath != wantSnapshot {
		t.Fatalf("snapshot path = %q, want %q", record.SnapshotPath, wantSnapshot)
	}
	operationID := record.OperationID
	if operationID == "" {
		t.Fatal("the record has no operation id")
	}

	start := len(worker.requestsLog())
	if err := Retry(context.Background(), deps, journal, false); err != nil {
		t.Fatal(err)
	}
	for _, request := range worker.requestsLog()[start:] {
		if request.OpID != operationID {
			t.Fatalf("retry request %s used op id %q, want %q", request, request.OpID, operationID)
		}
	}
	for _, ref := range restoreTestRefs {
		assertDORows(t, worker, ref, original[doKey(ref)])
	}
	record, err = journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if record != nil {
		t.Fatalf("pending = %+v, want nil", record)
	}
	if worker.hasLease() {
		t.Fatal("the lease was not released after the retry")
	}
}

func TestRetryFromSnapshot(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.3")

	// Change the deployment after the backup was taken: this state is what the
	// pre-restore snapshot captures.
	worker.setDO(DORef{DO: "butler"}, worker.schemaOf(DORef{DO: "butler"}), map[string][]json.RawMessage{
		"memories": {json.RawMessage(`{"__rowid":1,"id":"current","text":"当前"}`)},
		"tasks":    {json.RawMessage(`{"__rowid":1,"id":"t1"}`)},
	})
	worker.setDO(DORef{DO: "channel"}, worker.schemaOf(DORef{DO: "channel"}), map[string][]json.RawMessage{
		"__kv": {json.RawMessage(`{"key":"schema_version","value":"9"}`)},
	})
	worker.addObject("notes/readme.txt", "text/plain", []byte("changed"))
	worker.addObject("current-only.txt", "text/plain", []byte("current"))
	current := captureRows(t, worker, restoreTestRefs)
	currentObjects := captureObjects(t, worker)

	// Fail on the first artifact upload, after the snapshot is taken and the
	// artifacts outside the backup have been deleted.
	worker.failRoute("PUT", objectPath, "", "", 1, 500)

	journal := newRestoreJournal(t)
	deps := restoreTestDeps(t, worker, "1.2.3")
	snapshotDir := filepath.Join(t.TempDir(), "backups")

	err := Restore(context.Background(), deps, journal, backupTestTarget, path, snapshotDir)
	if code := adminErrorCode(t, err); code != CodeBackupInvalid {
		t.Fatalf("code = %q", code)
	}
	if record, err := journal.Pending(); err != nil || record == nil {
		t.Fatalf("pending = %+v, err = %v", record, err)
	}

	if err := Retry(context.Background(), deps, journal, true); err != nil {
		t.Fatal(err)
	}
	for _, ref := range restoreTestRefs {
		assertDORows(t, worker, ref, current[doKey(ref)])
	}
	assertObjectsEqual(t, worker, currentObjects)
	record, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if record != nil {
		t.Fatalf("pending = %+v, want nil", record)
	}
}

func TestRestoreRefusesWhilePending(t *testing.T) {
	worker := seedRestoreWorker(t)
	path := makeRestoreBackup(t, worker, "1.2.3")
	journal := newRestoreJournal(t)
	if err := journal.Save(RestoreRecord{
		OperationID: "op-old",
		Target:      backupTestTarget,
		BackupPath:  path,
		State:       "running",
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	deps := restoreTestDeps(t, worker, "1.2.3")

	err := Restore(context.Background(), deps, journal, backupTestTarget, path, filepath.Join(t.TempDir(), "backups"))
	if code := adminErrorCode(t, err); code != CodeRestorePending {
		t.Fatalf("code = %q", code)
	}
	if got := len(restoreCalls(worker)); got != 0 {
		t.Fatalf("restore calls = %d, want 0", got)
	}
	record, err := journal.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if record == nil || record.OperationID != "op-old" {
		t.Fatalf("the pending record was changed: %+v", record)
	}
}

func TestRetryWithoutPendingRecord(t *testing.T) {
	journal := newRestoreJournal(t)
	deps := Deps{Now: func() time.Time { return time.Date(2026, 11, 2, 10, 5, 0, 0, time.UTC) }}
	err := Retry(context.Background(), deps, journal, false)
	if code := adminErrorCode(t, err); code != CodeBackupInvalid {
		t.Fatalf("code = %q", code)
	}
}
