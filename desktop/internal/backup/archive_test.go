package backup

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

type testTable struct {
	ref    DORef
	schema TableSchema
	rows   []json.RawMessage
}

type testObject struct {
	item R2Item
	body []byte
}

// writeTestArchive writes a valid archive and lets the caller adjust the
// manifest before it is stored, so tests can describe malformed backups.
func writeTestArchive(t *testing.T, path string, tables []testTable, objects []testObject, mutate func(*Manifest)) Manifest {
	t.Helper()
	writer, err := NewWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		Format:     FormatVersion,
		ExportedAt: time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC),
		Release:    "1.2.0",
		VersionID:  "version-1",
		WorkerName: "deskwand-bot",
	}
	positions := map[DORef]int{}
	for _, table := range tables {
		position, ok := positions[table.ref]
		if !ok {
			position = len(manifest.DurableObjects)
			positions[table.ref] = position
			manifest.DurableObjects = append(manifest.DurableObjects, DOManifest{
				DORef: table.ref,
				Rows:  map[string]int64{},
			})
		}
		tableWriter, err := writer.Table(table.ref, table.schema.Name)
		if err != nil {
			t.Fatal(err)
		}
		if len(table.rows) > 0 {
			if err := tableWriter.Append(table.rows); err != nil {
				t.Fatal(err)
			}
		}
		manifest.DurableObjects[position].Schema.Tables = append(manifest.DurableObjects[position].Schema.Tables, table.schema)
		manifest.DurableObjects[position].Rows[table.schema.Name] = tableWriter.Rows()
	}
	for _, object := range objects {
		if err := writer.Object(object.item, bytes.NewReader(object.body)); err != nil {
			t.Fatal(err)
		}
		manifest.R2.Objects = append(manifest.R2.Objects, object.item)
		manifest.R2.Bytes += int64(len(object.body))
	}
	if mutate != nil {
		mutate(&manifest)
	}
	if err := writer.Finish(manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %s, got nil", code)
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) {
		t.Fatalf("expected domain.Error, got %T: %v", err, err)
	}
	if domainErr.Code != code {
		t.Fatalf("code = %s, want %s (%v)", domainErr.Code, code, err)
	}
}

func TestWriterReaderRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	butler := DORef{DO: "butler"}
	rows := []json.RawMessage{
		json.RawMessage(`{"__rowid":1,"content":"first"}`),
		json.RawMessage(`{"__rowid":2,"content":"second"}`),
		json.RawMessage(`{"__rowid":3,"content":"third"}`),
	}
	kvRows := []json.RawMessage{
		json.RawMessage(`{"key":"probe-kv","value":"{\"n\":1}"}`),
	}
	objectBody := []byte("artifact bytes")
	object := R2Item{Key: "a/b c?.png", Entry: ObjectEntry(1), Size: int64(len(objectBody)), ContentType: "image/png"}
	written := writeTestArchive(t, path, []testTable{
		{ref: butler, schema: TableSchema{Name: "memories", Create: "CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT)"}, rows: rows},
		{ref: butler, schema: TableSchema{Name: "__kv", Create: "", WithoutRowid: true}, rows: kvRows},
	}, []testObject{{item: object, body: objectBody}}, nil)

	reader, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	manifest := reader.Manifest()
	if manifest.Format != FormatVersion || manifest.Release != "1.2.0" || manifest.VersionID != "version-1" {
		t.Fatalf("manifest = %#v", manifest)
	}
	if len(manifest.DurableObjects) != 1 || len(manifest.DurableObjects[0].Schema.Tables) != 2 {
		t.Fatalf("durable objects = %#v", manifest.DurableObjects)
	}
	if manifest.DurableObjects[0].Rows["memories"] != int64(len(rows)) {
		t.Fatalf("rows = %#v", manifest.DurableObjects[0].Rows)
	}
	if manifest.R2.Bytes != int64(len(objectBody)) || len(manifest.R2.Objects) != 1 {
		t.Fatalf("r2 = %#v", manifest.R2)
	}
	if written.R2.Objects[0] != object {
		t.Fatalf("written r2 = %#v", written.R2.Objects)
	}

	var got []json.RawMessage
	batches := 0
	if err := reader.Rows(butler, "memories", 40, func(batch []json.RawMessage) error {
		batches++
		got = append(got, batch...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if batches < 2 {
		t.Fatalf("batches = %d, want more than one", batches)
	}
	if len(got) != len(rows) {
		t.Fatalf("rows = %d, want %d", len(got), len(rows))
	}
	for i := range rows {
		if !bytes.Equal(got[i], rows[i]) {
			t.Fatalf("row %d = %s, want %s", i, got[i], rows[i])
		}
	}

	body, err := reader.Object(object)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	read, err := io.ReadAll(body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(read, objectBody) {
		t.Fatalf("object = %q, want %q", read, objectBody)
	}
}

func TestOpenRejectsRowCountMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	butler := DORef{DO: "butler"}
	writeTestArchive(t, path, []testTable{{
		ref:    butler,
		schema: TableSchema{Name: "memories", Create: "CREATE TABLE memories (id INTEGER PRIMARY KEY)"},
		rows: []json.RawMessage{
			json.RawMessage(`{"__rowid":1}`),
			json.RawMessage(`{"__rowid":2}`),
		},
	}}, nil, func(m *Manifest) {
		m.DurableObjects[0].Rows["memories"] = 3
	})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsMissingEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	butler := DORef{DO: "butler"}
	writeTestArchive(t, path, []testTable{{
		ref:    butler,
		schema: TableSchema{Name: "memories", Create: "CREATE TABLE memories (id INTEGER PRIMARY KEY)"},
		rows:   []json.RawMessage{json.RawMessage(`{"__rowid":1}`)},
	}}, nil, func(m *Manifest) {
		m.DurableObjects[0].Schema.Tables = append(m.DurableObjects[0].Schema.Tables, TableSchema{Name: "ghost", Create: "CREATE TABLE ghost (id INTEGER PRIMARY KEY)"})
		m.DurableObjects[0].Rows["ghost"] = 0
	})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsUnknownFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	writeTestArchive(t, path, nil, nil, func(m *Manifest) {
		m.Format = 2
	})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsMissingObject(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	writeTestArchive(t, path, nil, nil, func(m *Manifest) {
		m.R2.Objects = append(m.R2.Objects, R2Item{Key: "ghost.png", Entry: ObjectEntry(1), Size: 1, ContentType: "image/png"})
		m.R2.Bytes = 1
	})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestAbortLeavesNoFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "backup.zip")
	writer, err := NewWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	tableWriter, err := writer.Table(DORef{DO: "butler"}, "memories")
	if err != nil {
		t.Fatal(err)
	}
	if err := tableWriter.Append([]json.RawMessage{json.RawMessage(`{"__rowid":1}`)}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Abort(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{path, path + ".tmp"} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatalf("%s exists after abort: %v", name, err)
		}
	}
}

func TestTableEntryNames(t *testing.T) {
	cases := []struct {
		ref   DORef
		table string
		want  string
	}{
		{DORef{DO: "butler", ID: ""}, "memories", "do/butler/memories.jsonl"},
		{DORef{DO: "task", ID: "t-1"}, "events", "do/task/t-1/events.jsonl"},
		{DORef{DO: "channel", ID: ""}, "wechat_state", "do/channel/wechat_state.jsonl"},
	}
	for _, testCase := range cases {
		if got := TableEntry(testCase.ref, testCase.table); got != testCase.want {
			t.Fatalf("TableEntry(%#v, %q) = %q, want %q", testCase.ref, testCase.table, got, testCase.want)
		}
	}
	if got := ObjectEntry(1); got != "r2/000001" {
		t.Fatalf("ObjectEntry(1) = %q", got)
	}
	if got := ObjectEntry(12); got != "r2/000012" {
		t.Fatalf("ObjectEntry(12) = %q", got)
	}
}
