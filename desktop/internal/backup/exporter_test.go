package backup

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
)

var backupTestTarget = domain.Target{AccountID: "acc", ScriptName: "deskwand-bot"}

func exportSnapshot(baseURL, release string, withToken bool) domain.Snapshot {
	snapshot := domain.Snapshot{
		ReleaseVersion: release,
		SettingsJSON: []byte(fmt.Sprintf(
			`{"bindings":[{"type":"plain_text","name":"PUBLIC_BASE_URL","text":%q}]}`,
			baseURL,
		)),
	}
	if withToken {
		snapshot.SecretNames = []string{AdminTokenSecret}
	}
	return snapshot
}

func exportDeps(t *testing.T, snapshot domain.Snapshot, storedToken string, readyTimeout time.Duration) (Deps, *fakePublisher) {
	t.Helper()
	snapshots := &fakeSnapshots{queue: []domain.Snapshot{snapshot}}
	publisher := &fakePublisher{result: domain.Result{State: deployment.StatePublished}}
	credentials := platform.NewMemoryCredentialStore()
	if storedToken != "" {
		if err := credentials.Set(context.Background(), AdminTokenKey(backupTestTarget), storedToken); err != nil {
			t.Fatal(err)
		}
	}
	deps := Deps{
		Token: TokenDeps{
			Snapshots:   snapshots,
			Publisher:   publisher,
			Credentials: credentials,
			Random:      rand.Reader,
		},
		Now:          func() time.Time { return time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC) },
		ReadyTimeout: readyTimeout,
	}
	return deps, publisher
}

func assertRowsEqual(t *testing.T, got, want []json.RawMessage) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("rows = %d, want %d", len(got), len(want))
	}
	for i := range want {
		var gotValue, wantValue any
		if err := json.Unmarshal(got[i], &gotValue); err != nil {
			t.Fatalf("row %d: %v", i, err)
		}
		if err := json.Unmarshal(want[i], &wantValue); err != nil {
			t.Fatalf("row %d: %v", i, err)
		}
		if !reflect.DeepEqual(gotValue, wantValue) {
			t.Fatalf("row %d = %s, want %s", i, got[i], want[i])
		}
	}
}

func readTableRows(t *testing.T, reader *Reader, ref DORef, table string) []json.RawMessage {
	t.Helper()
	var rows []json.RawMessage
	err := reader.Rows(ref, table, 1<<20, func(batch []json.RawMessage) error {
		rows = append(rows, batch...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestExportWritesEveryDOAndObject(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.taskIDs = []string{"t1", "t2"}

	butlerRows := map[string][]json.RawMessage{
		"memories": {
			json.RawMessage(`{"__rowid":1,"id":"m1","text":"喜欢绿茶"}`),
			json.RawMessage(`{"__rowid":2,"id":"m2","text":"住杭州"}`),
		},
		"schedules": {
			json.RawMessage(`{"__rowid":1,"id":"s1","due":{"$int":"9007199254740993"}}`),
		},
	}
	worker.setDO(DORef{DO: "butler"}, DBSchema{
		Tables: []TableSchema{
			{Name: "memories", Create: `CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)`},
			{Name: "schedules", Create: `CREATE TABLE schedules (id TEXT PRIMARY KEY, due INTEGER)`},
		},
		Indexes: []string{`CREATE INDEX memories_text ON memories (text)`},
	}, butlerRows)
	worker.setDO(DORef{DO: "task", ID: "t1"}, DBSchema{
		Tables: []TableSchema{{Name: "meta", Create: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`}},
	}, map[string][]json.RawMessage{
		"meta": {json.RawMessage(`{"__rowid":1,"key":"state","value":"done"}`)},
	})
	worker.setDO(DORef{DO: "task", ID: "t2"}, DBSchema{
		Tables: []TableSchema{{Name: "meta", Create: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`}},
	}, map[string][]json.RawMessage{
		"meta": {json.RawMessage(`{"__rowid":1,"key":"state","value":"running"}`)},
	})
	worker.setDO(DORef{DO: "channel"}, DBSchema{
		Tables: []TableSchema{{Name: "__kv", WithoutRowid: true}},
	}, map[string][]json.RawMessage{
		"__kv": {json.RawMessage(`{"key":"schema_version","value":"3"}`)},
	})
	worker.addObject("artifacts/a b.png", "image/png", []byte("png-bytes"))
	worker.addObject("notes/readme.txt", "text/plain", []byte("hello"))
	worker.addObject("a/b c?.json", "application/json", []byte(`{"ok":true}`))

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Format != FormatVersion {
		t.Fatalf("format = %d", manifest.Format)
	}
	if manifest.Release != "1.2.3" || manifest.VersionID != "version-1" || manifest.WorkerName != "deskwand-bot" {
		t.Fatalf("manifest identity = %+v", manifest)
	}
	if got := manifest.ExportedAt; got != deps.Now() {
		t.Fatalf("exportedAt = %v", got)
	}
	if len(manifest.DurableObjects) != 4 {
		t.Fatalf("durable objects = %d", len(manifest.DurableObjects))
	}
	butler := manifest.DurableObjects[0]
	if butler.DORef != (DORef{DO: "butler"}) || butler.Rows["memories"] != 2 || butler.Rows["schedules"] != 1 {
		t.Fatalf("butler manifest = %+v", butler)
	}
	if got := manifest.DurableObjects[1].DORef; got != (DORef{DO: "task", ID: "t1"}) {
		t.Fatalf("second object = %+v", got)
	}
	if got := manifest.DurableObjects[3].DORef; got != (DORef{DO: "channel"}) {
		t.Fatalf("last object = %+v", got)
	}
	if len(manifest.R2.Objects) != 3 || len(manifest.R2.Oversized) != 0 {
		t.Fatalf("r2 manifest = %+v", manifest.R2)
	}
	var bytes int64
	for _, item := range manifest.R2.Objects {
		bytes += item.Size
	}
	if manifest.R2.Bytes != bytes {
		t.Fatalf("r2 bytes = %d, want %d", manifest.R2.Bytes, bytes)
	}

	reader, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "butler"}, "memories"), butlerRows["memories"])
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "butler"}, "schedules"), butlerRows["schedules"])
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "task", ID: "t1"}, "meta"),
		worker.rowsOf(DORef{DO: "task", ID: "t1"})["meta"])
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "channel"}, "__kv"),
		worker.rowsOf(DORef{DO: "channel"})["__kv"])

	for _, item := range manifest.R2.Objects {
		body, err := reader.Object(item)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(body)
		body.Close()
		if err != nil {
			t.Fatalf("read object: %v", err)
		}
		want, _, ok := worker.object(item.Key)
		if !ok || string(data) != string(want) {
			t.Fatalf("object %s bytes mismatch", item.Key)
		}
	}
}

func TestExportReleasesLeaseOnFailure(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.setDO(DORef{DO: "butler"}, DBSchema{
		Tables: []TableSchema{
			{Name: "memories", Create: `CREATE TABLE memories (id TEXT)`},
			{Name: "schedules", Create: `CREATE TABLE schedules (id TEXT)`},
		},
	}, map[string][]json.RawMessage{
		"memories":  {json.RawMessage(`{"__rowid":1,"id":"m1"}`)},
		"schedules": {json.RawMessage(`{"__rowid":1,"id":"s1"}`)},
	})
	worker.failRoute("POST", pagePath, "", "", 2, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("export succeeded despite an injected failure")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("archive exists after a failure: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary archive exists after a failure: %v", err)
	}
	if worker.hasLease() {
		t.Fatal("the lease was not released")
	}
	if worker.requestCount("POST", releasePath) == 0 {
		t.Fatal("the Worker saw no release request")
	}
}

func TestExportMarksUnknownRelease(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Release != "unknown" {
		t.Fatalf("release = %q", manifest.Release)
	}
}

func TestExportRecordsOversizedObjects(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.addObject("small.txt", "text/plain", []byte("tiny"))
	worker.addOversizedObject("huge.bin", "application/octet-stream", MaxR2ObjectBytes+1, []byte("not really that large"))

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.R2.Objects) != 1 || manifest.R2.Objects[0].Key != "small.txt" {
		t.Fatalf("objects = %+v", manifest.R2.Objects)
	}
	if len(manifest.R2.Oversized) != 1 || manifest.R2.Oversized[0] != "huge.bin" {
		t.Fatalf("oversized = %+v", manifest.R2.Oversized)
	}
	if manifest.R2.Bytes != int64(len("tiny")) {
		t.Fatalf("bytes = %d", manifest.R2.Bytes)
	}
	if _, err := Open(path); err != nil {
		t.Fatalf("the archive is invalid: %v", err)
	}
}

func TestExportRepublishesTokenOnUnauthorized(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.failRoute("POST", acquirePath, "", "", 1, 401)

	deps, publisher := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatal(err)
	}
	if len(publisher.changes) != 1 {
		t.Fatalf("publish calls = %d, want 1", len(publisher.changes))
	}
	if got := publisher.changes[0].Secrets[0].Value(); got != "tok" {
		t.Fatalf("republished value = %q", got)
	}
}

func TestExportWaitsForFreshAdminToken(t *testing.T) {
	worker := newFakeWorker(t)
	worker.versionID = "version-1"
	worker.failRoute("POST", acquirePath, "", "", 1, 404)
	worker.failRoute("POST", acquirePath, "", "", 2, 404)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", false), "", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatal(err)
	}
	if got := worker.requestCount("POST", acquirePath); got != 3 {
		t.Fatalf("acquire calls = %d, want 3", got)
	}
}

func TestExportReportsAdminUnavailable(t *testing.T) {
	worker := newFakeWorker(t)
	worker.failAll(404)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", false), "", 100*time.Millisecond)
	path := filepath.Join(t.TempDir(), "backup.zip")

	_, err := Export(context.Background(), deps, backupTestTarget, path)
	if code := adminErrorCode(t, err); code != CodeAdminUnavailable {
		t.Fatalf("code = %q", code)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("archive exists after a failure: %v", statErr)
	}
}
