package backup

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
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

// exportDeps keeps its signature: the endpoint now comes from a resolver built
// on the same fixture, so no call site changes.
func exportDeps(t *testing.T, snapshot domain.Snapshot, token string, readyTimeout time.Duration) (Deps, *fakePublisher) {
	t.Helper()
	snapshots := &fakeSnapshots{queue: []domain.Snapshot{snapshot}}
	publisher := &fakePublisher{result: domain.Result{State: deployment.StatePublished}}
	deps := Deps{
		Endpoints:    &fakeResolver{baseURL: PublicBaseURL(snapshot.SettingsJSON), token: token},
		Snapshots:    snapshots,
		Now:          func() time.Time { return time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC) },
		ReadyTimeout: readyTimeout,
	}
	return deps, publisher
}

// fakeResolver satisfies EndpointResolver: this package cannot import
// adminendpoint, so the interface speaks in plain values.
type fakeResolver struct {
	baseURL string
	token   string
	err     error
	calls   int
	freshen []string
}

func (f *fakeResolver) ResolveEndpoint(context.Context, domain.Target) (string, string, *http.Client, error) {
	f.calls++
	return f.baseURL, f.token, nil, f.err
}

// fakeRefresher is a resolver that can replace a rejected credential, like the
// Cloudflare one. A container resolver cannot, which the 401 tests rely on.
type fakeRefresher struct {
	fakeResolver
	fresh     string
	refreshed int
}

func (f *fakeRefresher) RefreshEndpoint(context.Context, domain.Target) (string, string, *http.Client, error) {
	f.refreshed++
	return f.baseURL, f.fresh, nil, nil
}

func TestConnectUsesTheEndpointResolver(t *testing.T) {
	resolver := &fakeResolver{baseURL: "http://worker.test", token: "tok"}
	snapshots := &fakeSnapshots{queue: []domain.Snapshot{{ReleaseVersion: "1.2.3"}}}
	deps := Deps{Endpoints: resolver, Snapshots: snapshots}

	client, snapshot, err := connect(context.Background(), deps, backupTestTarget, "op-1")
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if resolver.calls != 1 {
		t.Fatalf("resolver calls = %d, want 1", resolver.calls)
	}
	if client == nil || snapshot.ReleaseVersion != "1.2.3" {
		t.Fatalf("client = %v, snapshot = %+v", client, snapshot)
	}
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
	worker.botIDs = []string{"b1"}

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
	worker.setDO(DORef{DO: "bot", ID: "b1"}, DBSchema{
		Tables: []TableSchema{{Name: "meta", Create: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`}},
	}, map[string][]json.RawMessage{
		"meta": {json.RawMessage(`{"__rowid":1,"key":"status","value":"active"}`)},
	})
	worker.setDO(DORef{DO: "life"}, DBSchema{
		Tables: []TableSchema{
			{Name: "spend", Create: `CREATE TABLE spend (call_id TEXT PRIMARY KEY, usd REAL)`},
			{Name: "credit", Create: `CREATE TABLE credit (id INTEGER PRIMARY KEY AUTOINCREMENT, usd REAL)`},
		},
	}, map[string][]json.RawMessage{
		"spend": {
			json.RawMessage(`{"__rowid":1,"call_id":"c1","usd":{"$real":"0.25"}}`),
			json.RawMessage(`{"__rowid":2,"call_id":"c2","usd":{"$real":"0.5"}}`),
		},
		"credit": {
			json.RawMessage(`{"__rowid":1,"id":1,"usd":20}`),
		},
	})
	worker.setDO(DORef{DO: "wallet"}, DBSchema{
		Tables: []TableSchema{
			{Name: "remittances", Create: `CREATE TABLE remittances (id TEXT PRIMARY KEY, usdc TEXT, status TEXT)`},
		},
	}, map[string][]json.RawMessage{
		"remittances": {
			json.RawMessage(`{"__rowid":1,"id":"r1","usdc":"32000000","status":"confirmed"}`),
		},
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
	if len(manifest.DurableObjects) != 7 {
		t.Fatalf("durable objects = %d", len(manifest.DurableObjects))
	}
	var butler *DOManifest
	var order []string
	for i := range manifest.DurableObjects {
		object := &manifest.DurableObjects[i]
		order = append(order, object.DO+"/"+object.ID)
		if object.DO == "butler" {
			butler = object
		}
	}
	if want := []string{"task/t1", "task/t2", "bot/b1", "life/", "wallet/", "channel/", "butler/"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("export order = %v, want %v", order, want)
	}
	if butler == nil || butler.Rows["memories"] != 2 || butler.Rows["schedules"] != 1 {
		t.Fatalf("butler manifest = %+v", butler)
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
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "life"}, "credit"),
		worker.rowsOf(DORef{DO: "life"})["credit"])
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "wallet"}, "remittances"),
		worker.rowsOf(DORef{DO: "wallet"})["remittances"])
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

func TestExportRefsOrdersBotsAfterTasks(t *testing.T) {
	refs := exportRefs([]string{"t1", "t2"}, []string{"b1", "b2"}, []string{"m" + "a" + strings.Repeat("0", 31)})
	var got []string
	for _, ref := range refs {
		got = append(got, ref.DO+"/"+ref.ID)
	}
	member := "m" + "a" + strings.Repeat("0", 31)
	want := []string{"task/t1", "task/t2", "bot/b1", "bot/b2", "butler/" + member, "life/", "wallet/", "channel/", "butler/"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("export order = %v, want %v", got, want)
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
	// Fail the second chunk read, so one table entry already exists when the
	// export dies: the archive must still be discarded.
	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })
	worker.failRoute("POST", chunkPath, "", "", 2, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("export succeeded despite an injected failure")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("archive exists after a failure: %v", err)
	}
	if left, err := os.ReadDir(filepath.Dir(path)); err != nil || len(left) != 0 {
		t.Fatalf("a failed export left files behind: %v %v", left, err)
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

func TestExportPaginatesTablesAndObjects(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"

	rows := make([]json.RawMessage, 5)
	for i := range rows {
		rows[i] = json.RawMessage(fmt.Sprintf(`{"__rowid":%d,"id":"v%d"}`, i+1, i+1))
	}
	worker.setDO(DORef{DO: "butler"}, DBSchema{
		Tables: []TableSchema{{Name: "memories", Create: `CREATE TABLE memories (id TEXT)`}},
	}, map[string][]json.RawMessage{"memories": rows})
	for i := 0; i < 5; i++ {
		worker.addObject(fmt.Sprintf("a/%d.bin", i), "application/octet-stream", []byte{byte(i)})
	}

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatal(err)
	}
	var butler *DOManifest
	for i := range manifest.DurableObjects {
		if manifest.DurableObjects[i].DO == "butler" {
			butler = &manifest.DurableObjects[i]
		}
	}
	if butler == nil || butler.Rows["memories"] != 5 {
		t.Fatalf("butler manifest = %#v", butler)
	}
	if len(manifest.R2.Objects) != 5 {
		t.Fatalf("objects = %d, want 5", len(manifest.R2.Objects))
	}
	if got := worker.requestCount("POST", chunkPath); got < 3 {
		t.Fatalf("chunk calls = %d, want at least 3", got)
	}
	if got := worker.requestCount("GET", objectListPath); got < 3 {
		t.Fatalf("list calls = %d, want at least 3", got)
	}
	reader, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "butler"}, "memories"), rows)
}

func TestExportRenewsLeaseForLargeObjects(t *testing.T) {
	previous := renewEveryBytes
	renewEveryBytes = 4
	defer func() { renewEveryBytes = previous }()

	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.addObject("big.bin", "application/octet-stream", []byte("12345"))
	worker.addObject("small.bin", "application/octet-stream", []byte("123"))

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatal(err)
	}
	// Renewal must never use Acquire: only the initial readiness uses it.
	if got := worker.requestCount("POST", acquirePath); got != 1 {
		t.Fatalf("acquire calls = %d, want 1", got)
	}
	if got := worker.requestCount("GET", infoPath); got < 2 {
		t.Fatalf("info calls = %d, want a lease renewal", got)
	}
}

func TestWaitForAdminRetriesTransientErrors(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.failRoute("GET", infoPath, "", "", 1, 503)

	deps := Deps{ReadyTimeout: time.Second}
	client := NewAdminClient(worker.URL(), "tok", "op-1", nil)
	if err := WaitForAdmin(context.Background(), deps, client); err != nil {
		t.Fatal(err)
	}
	if got := worker.requestCount("GET", infoPath); got != 2 {
		t.Fatalf("info calls = %d, want 2", got)
	}
}

func TestExportStopsAfterSecondUnauthorized(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.failRoute("POST", acquirePath, "", "", 1, 401)
	worker.failRoute("POST", acquirePath, "", "", 2, 401)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	refresher := &fakeRefresher{fakeResolver: fakeResolver{baseURL: worker.URL(), token: "tok"}, fresh: "tok2"}
	deps.Endpoints = refresher
	path := filepath.Join(t.TempDir(), "backup.zip")

	_, err := Export(context.Background(), deps, backupTestTarget, path)
	if code := adminErrorCode(t, err); code != CodeAdminUnauthorized {
		t.Fatalf("code = %q", code)
	}
	if refresher.refreshed != 1 {
		t.Fatalf("refresh calls = %d, want 1", refresher.refreshed)
	}
	if got := worker.requestCount("POST", acquirePath); got != 2 {
		t.Fatalf("acquire calls = %d, want 2", got)
	}
}

func TestExportReleasesLeaseWhenCancelled(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	rows := make([]json.RawMessage, 5)
	for i := range rows {
		rows[i] = json.RawMessage(fmt.Sprintf(`{"__rowid":%d}`, i+1))
	}
	worker.setDO(DORef{DO: "butler"}, DBSchema{
		Tables: []TableSchema{{Name: "memories", Create: `CREATE TABLE memories (id TEXT)`}},
	}, map[string][]json.RawMessage{"memories": rows})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	cancelled := false
	deps.Progress = func(progress Progress) {
		if !cancelled && progress.Phase == PhaseDatabase && progress.Rows > 0 {
			cancelled = true
			cancel()
		}
	}
	path := filepath.Join(t.TempDir(), "backup.zip")

	_, err := Export(ctx, deps, backupTestTarget, path)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if worker.hasLease() {
		t.Fatal("the lease was not released")
	}
	if worker.requestCount("POST", releasePath) == 0 {
		t.Fatal("the Worker saw no release request")
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("archive exists after a cancellation: %v", statErr)
	}
}

func TestRenewLeaseDoesNotReacquireExpiredLease(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	client := NewAdminClient(worker.URL(), "tok", "op-renew", worker.server.Client())
	if err := client.Acquire(context.Background(), "export"); err != nil {
		t.Fatal(err)
	}
	worker.expireLease()

	err := renewLease(context.Background(), client)
	if code := adminErrorCode(t, err); code != CodeMaintenanceRequired {
		t.Fatalf("code = %q, want %q", code, CodeMaintenanceRequired)
	}
	if worker.hasLease() {
		t.Fatal("an expired lease was silently reacquired")
	}
}

func TestLeaseHeartbeatCancelsWhenRenewalFails(t *testing.T) {
	previous := leaseHeartbeatInterval
	leaseHeartbeatInterval = 5 * time.Millisecond
	defer func() { leaseHeartbeatInterval = previous }()

	worker := newFakeWorker(t)
	worker.token = "tok"
	client := NewAdminClient(worker.URL(), "tok", "op-heartbeat", worker.server.Client())
	if err := client.Acquire(context.Background(), "export"); err != nil {
		t.Fatal(err)
	}
	worker.expireLease()

	err := withLeaseHeartbeat(context.Background(), client, func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	if code := adminErrorCode(t, err); code != CodeMaintenanceRequired {
		t.Fatalf("code = %q, want %q", code, CodeMaintenanceRequired)
	}
}

func TestObjectEntryLimitKeepsSixDigits(t *testing.T) {
	if got := ObjectEntry(maxArchivedObjects); got != "r2/999999" {
		t.Fatalf("last entry = %q", got)
	}
	if _, err := checkedObjectEntry(maxArchivedObjects + 1); err == nil {
		t.Fatal("one million artifacts were accepted")
	}
}

func TestExportSkipsLifeBeforeTheWorkerIsUpdated(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.botIDs = []string{"b1"}
	worker.noLife = true
	worker.setDO(DORef{DO: "butler"}, DBSchema{}, nil)
	worker.setDO(DORef{DO: "channel"}, DBSchema{}, nil)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range manifest.DurableObjects {
		if object.DO == "life" {
			t.Fatal("a worker without a ledger exported a life object")
		}
	}

	reader, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, object := range reader.Manifest().DurableObjects {
		if object.DO == "life" {
			t.Fatal("the archive contains a life object")
		}
	}
}

func TestExportFailsOnLifeServerError(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.setDO(DORef{DO: "butler"}, DBSchema{}, nil)
	worker.setDO(DORef{DO: "channel"}, DBSchema{}, nil)
	worker.failRoute("GET", schemaPath, "life", "", 0, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	_, err := Export(context.Background(), deps, backupTestTarget, path)
	if code := adminErrorCode(t, err); code != CodeBackupInvalid {
		t.Fatalf("code = %q", code)
	}
}

func TestExportSkipsWalletBeforeTheWorkerIsUpdated(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.versionID = "version-1"
	worker.botIDs = []string{"b1"}
	worker.noWallet = true
	worker.setDO(DORef{DO: "butler"}, DBSchema{}, nil)
	worker.setDO(DORef{DO: "channel"}, DBSchema{}, nil)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	path := filepath.Join(t.TempDir(), "backup.zip")

	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range manifest.DurableObjects {
		if object.DO == "wallet" {
			t.Fatal("a worker without a wallet exported a wallet object")
		}
	}

	reader, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, object := range reader.Manifest().DurableObjects {
		if object.DO == "wallet" {
			t.Fatal("the archive contains a wallet object")
		}
	}
}

func TestExportLogsOneLinePerRequest(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.setDO(
		DORef{DO: "task", ID: "t1"},
		DBSchema{Tables: []TableSchema{
			{Name: "notes", Create: `CREATE TABLE notes (id INTEGER)`},
		}},
		map[string][]json.RawMessage{
			"notes": {json.RawMessage(`{"id":1}`), json.RawMessage(`{"id":2}`)},
		},
	)
	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", 50*time.Millisecond)

	var lines []string
	deps.Logf = func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	}
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatalf("Export: %v", err)
	}

	want := "chunk do=task id=t1 chunks=1 rows=2"
	found := false
	for _, line := range lines {
		if strings.Contains(line, want) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("log lines = %q, want one containing %q", lines, want)
	}
}

func TestExportReadsTablesInBatches(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.pageRows = 10

	schema := DBSchema{}
	rows := map[string][]json.RawMessage{}
	for i := 0; i < 6; i++ {
		name := fmt.Sprintf("t%d", i)
		schema.Tables = append(schema.Tables, TableSchema{
			Name:   name,
			Create: fmt.Sprintf(`CREATE TABLE %s (n INTEGER)`, name),
		})
		rows[name] = []json.RawMessage{json.RawMessage(fmt.Sprintf(`{"n":%d}`, i))}
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", 50*time.Millisecond)
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	pageCalls, chunkCalls := 0, 0
	for _, request := range worker.requests {
		switch request.Path {
		case pagePath:
			pageCalls++
		case chunkPath:
			chunkCalls++
		}
	}
	if pageCalls != 0 {
		t.Fatalf("page requests = %d, want 0: the export should batch", pageCalls)
	}
	if chunkCalls > 2 {
		t.Fatalf("chunk requests = %d, want <= 2 for six small tables", chunkCalls)
	}

	var recorded map[string]int64
	for _, object := range manifest.DurableObjects {
		if object.DO == "task" && object.ID == "t1" {
			recorded = object.Rows
		}
	}
	if len(recorded) != 6 {
		t.Fatalf("rows recorded for %d tables, want 6", len(recorded))
	}

	reader, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	for i := 0; i < 6; i++ {
		name := fmt.Sprintf("t%d", i)
		assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "task", ID: "t1"}, name), rows[name])
	}
}

func TestExportFallsBackWhenChunkRouteIsMissing(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.noChunk = true

	schema := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{
		"a": {json.RawMessage(`{"n":1}`)},
		"b": {json.RawMessage(`{"n":2}`), json.RawMessage(`{"n":3}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", 50*time.Millisecond)
	var lines []string
	deps.Logf = func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	}
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatalf("Export: %v", err)
	}

	pageCalls := 0
	for _, request := range worker.requests {
		if request.Path == pagePath {
			pageCalls++
		}
	}
	if pageCalls == 0 {
		t.Fatal("the fallback did not use the page route")
	}
	var logged bool
	for _, line := range lines {
		if strings.Contains(line, "page do=task id=t1 table=a rows=1") {
			logged = true
		}
	}
	if !logged {
		t.Fatalf("log lines = %q, want one for the paged fallback", lines)
	}

	reader, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "task", ID: "t1"}, "b"), rows["b"])
}

func TestExportKeepsOneEntryPerTableAcrossBatches(t *testing.T) {
	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })

	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.pageRows = 1

	schema := DBSchema{Tables: []TableSchema{
		{Name: "big", Create: `CREATE TABLE big (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{
		"big": {json.RawMessage(`{"n":1}`), json.RawMessage(`{"n":2}`), json.RawMessage(`{"n":3}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", 50*time.Millisecond)
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatalf("Export: %v", err)
	}

	archive, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	defer archive.Close()
	counts := map[string]int{}
	for _, file := range archive.File {
		counts[file.Name]++
	}
	if got := counts[TableEntry(DORef{DO: "task", ID: "t1"}, "big")]; got != 1 {
		t.Fatalf("entries for table big = %d, want 1 (names: %v)", got, counts)
	}
	reader, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "task", ID: "t1"}, "big"), rows["big"])
}

func TestExportFailsWhenTheServerClaimsDoneEarly(t *testing.T) {
	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })

	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.chunkDoneEarly = true

	schema := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{
		"a": {json.RawMessage(`{"n":1}`)},
		"b": {json.RawMessage(`{"n":2}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", 50*time.Millisecond)
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("export succeeded with a table missing from the archive")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("archive exists after a failure: %v", err)
	}
}

func TestExportFallsBackOnAJSON404(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.noChunk = true
	worker.chunkNotFoundJSON = true

	schema := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{"a": {json.RawMessage(`{"n":1}`)}}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", 50*time.Millisecond)
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatalf("Export: %v", err)
	}

	reader, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "task", ID: "t1"}, "a"), rows["a"])
}

func TestExportResumesWithoutRereadingFinishedTables(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}

	schema := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER)`},
		{Name: "c", Create: `CREATE TABLE c (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{
		"a": {json.RawMessage(`{"n":1}`)},
		"b": {json.RawMessage(`{"n":2}`)},
		"c": {json.RawMessage(`{"n":3}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })
	// The first run dies while reading the second table.
	worker.failRoute("POST", chunkPath, "", "", 2, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	deps.ResumeDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("the first run should fail")
	}

	// The resumed run reads only b and c: one chunk each with batchBytes = 1.
	worker.clearFailures()
	before := worker.requestCount("POST", chunkPath)
	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatalf("resumed Export: %v", err)
	}
	if served := worker.requestCount("POST", chunkPath) - before; served != 2 {
		t.Fatalf("the resumed run made %d chunk requests, want 2 (b and c)", served)
	}
	if !manifest.Resumed {
		t.Fatal("the resumed run is not flagged in the manifest")
	}
	var task *DOManifest
	for i := range manifest.DurableObjects {
		if manifest.DurableObjects[i].DO == "task" {
			task = &manifest.DurableObjects[i]
		}
	}
	if task == nil || len(task.Rows) != 3 {
		t.Fatalf("task manifest = %+v", task)
	}

	reader, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	for name, want := range rows {
		assertRowsEqual(t, readTableRows(t, reader, DORef{DO: "task", ID: "t1"}, name), want)
	}
}

func TestExportWritesTheSameArchiveFromACheckpoint(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.setDO(DORef{DO: "task", ID: "t1"}, DBSchema{
		Tables: []TableSchema{{Name: "notes", Create: `CREATE TABLE notes (n INTEGER)`}},
	}, map[string][]json.RawMessage{"notes": {json.RawMessage(`{"n":1}`)}})
	worker.addObject("a/1.bin", "application/octet-stream", []byte{1, 2, 3})

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	deps.ResumeDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatalf("Export: %v", err)
	}

	entries, err := os.ReadDir(deps.ResumeDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("resume directory = %+v, want empty", entries)
	}

	reader, err := Open(path) // rejects a duplicate entry
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	if reader.Manifest().Format != FormatVersion {
		t.Fatalf("format = %d", reader.Manifest().Format)
	}
	if len(reader.Manifest().R2.Objects) != 1 {
		t.Fatalf("objects = %+v", reader.Manifest().R2.Objects)
	}
}

func TestExportReportsAQuotaExhaustionAndKeepsItsProgress(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}

	schema := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{
		"a": {json.RawMessage(`{"n":1}`)},
		"b": {json.RawMessage(`{"n":2}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })
	worker.failRouteBody("POST", chunkPath, 2, 500,
		"Exceeded allowed rows read in Durable Objects free tier")

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	deps.ResumeDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "backup.zip")

	_, err := Export(context.Background(), deps, backupTestTarget, path)
	if code := errorCode(err); code != CodeBackupQuota {
		t.Fatalf("code = %q, want %q (err: %v)", code, CodeBackupQuota, err)
	}
	if !strings.Contains(err.Error(), "00:00 UTC") {
		t.Fatalf("message = %q, want the reset hint", err.Error())
	}
	entries, err := os.ReadDir(deps.ResumeDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("the checkpoint was discarded after a quota failure")
	}
}

func TestExportRereadsTablesWhoseShapeChanged(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}
	worker.pageRows = 10

	schema := functionTablesSchema("n INTEGER")
	rows := map[string][]json.RawMessage{
		"a": {json.RawMessage(`{"n":1}`)},
		"b": {json.RawMessage(`{"n":2}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })
	worker.failRoute("POST", chunkPath, "", "", 2, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	deps.ResumeDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("the first run should fail")
	}

	// The deployment migrates table a before the next attempt.
	worker.setDO(DORef{DO: "task", ID: "t1"}, functionTablesSchema("n INTEGER, extra TEXT"), rows)
	worker.clearFailures()

	before := worker.requestCount("POST", chunkPath)
	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	// Both tables are read again: the shape changed, so nothing may be reused.
	if served := worker.requestCount("POST", chunkPath) - before; served != 2 {
		t.Fatalf("the second run made %d chunk requests, want 2 (a and b re-read)", served)
	}
	if manifest.Resumed {
		t.Fatal("a run after a schema change reports itself as resumed")
	}
}

// functionTablesSchema is the two-table fixture above with a given column list.
func functionTablesSchema(columns string) DBSchema {
	tables := make([]TableSchema, 0, 2)
	for _, name := range []string{"a", "b"} {
		tables = append(tables, TableSchema{
			Name:   name,
			Create: fmt.Sprintf(`CREATE TABLE %s (%s)`, name, columns),
		})
	}
	return DBSchema{Tables: tables}
}

func TestExportDoesNotRescanSchemasOnResume(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1", "t2"}

	schema := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{"a": {json.RawMessage(`{"n":1}`)}}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)
	worker.setDO(DORef{DO: "task", ID: "t2"}, schema, rows)

	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })
	// Die on the second DO, so the first one is finished in the checkpoint.
	worker.failRoute("POST", chunkPath, "task", "t2", 1, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	deps.ResumeDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("the first run should fail")
	}

	worker.clearFailures()
	before := worker.requestCount("GET", schemaPath)
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatalf("resumed Export: %v", err)
	}
	// One schema request per object the run visits: a pre-scan would double it
	// and leave the page showing zeros for minutes.
	served := worker.requestCount("GET", schemaPath) - before
	if served > 6 {
		t.Fatalf("the resumed run made %d schema requests, want one per object (<=6)", served)
	}
}

func TestExportShowsTheSavedProgressImmediatelyOnResume(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1"}

	schema := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{
		"a": {json.RawMessage(`{"n":1}`), json.RawMessage(`{"n":2}`)},
		"b": {json.RawMessage(`{"n":3}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, schema, rows)

	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })
	worker.failRoute("POST", chunkPath, "", "", 2, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	deps.ResumeDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("the first run should fail")
	}

	var reported []Progress
	deps.Progress = func(progress Progress) {
		if progress.Phase == PhaseDatabase {
			reported = append(reported, progress)
		}
	}
	worker.clearFailures()
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err != nil {
		t.Fatalf("resumed Export: %v", err)
	}

	if len(reported) == 0 {
		t.Fatal("the resumed run reported no database progress")
	}
	// The first tick must already show the table the earlier run saved, not
	// zero: a page stuck at zero for minutes is what users reported as frozen.
	if reported[0].Tables != 1 || reported[0].Rows != 2 {
		t.Fatalf("first progress = %d tables / %d rows, want 1 / 2", reported[0].Tables, reported[0].Rows)
	}
}

func TestExportForgetsOnlyTheObjectWhoseShapeChanged(t *testing.T) {
	worker := newFakeWorker(t)
	worker.token = "tok"
	worker.taskIDs = []string{"t1", "t2"}
	worker.pageRows = 10

	stable := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER)`},
	}}
	migrating := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER)`},
	}}
	rows := map[string][]json.RawMessage{
		"a": {json.RawMessage(`{"n":1}`)},
		"b": {json.RawMessage(`{"n":2}`)},
	}
	worker.setDO(DORef{DO: "task", ID: "t1"}, stable, rows)
	worker.setDO(DORef{DO: "task", ID: "t2"}, migrating, rows)

	previous := batchBytes
	batchBytes = 1
	t.Cleanup(func() { batchBytes = previous })
	// Die on t2's first chunk, so all of t1 is in the checkpoint.
	worker.failRoute("POST", chunkPath, "task", "t2", 1, 500)

	deps, _ := exportDeps(t, exportSnapshot(worker.URL(), "1.2.3", true), "tok", time.Second)
	deps.ResumeDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "backup.zip")
	if _, err := Export(context.Background(), deps, backupTestTarget, path); err == nil {
		t.Fatal("the first run should fail")
	}

	// Only t2 migrates.
	migrated := DBSchema{Tables: []TableSchema{
		{Name: "a", Create: `CREATE TABLE a (n INTEGER)`},
		{Name: "b", Create: `CREATE TABLE b (n INTEGER, extra TEXT)`},
	}}
	worker.setDO(DORef{DO: "task", ID: "t2"}, migrated, rows)
	worker.clearFailures()

	before := worker.requestCount("POST", chunkPath)
	manifest, err := Export(context.Background(), deps, backupTestTarget, path)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	// t1 is untouched: its two tables are reused, only t2 is read again.
	if served := worker.requestCount("POST", chunkPath) - before; served != 2 {
		t.Fatalf("the resumed run made %d chunk requests, want 2 (t2 only)", served)
	}
	var t1Rows map[string]int64
	for _, object := range manifest.DurableObjects {
		if object.DO == "task" && object.ID == "t1" {
			t1Rows = object.Rows
		}
	}
	if len(t1Rows) != 2 {
		t.Fatalf("t1 rows = %+v, want both tables from the checkpoint", t1Rows)
	}
}
