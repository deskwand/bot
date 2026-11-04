package backup

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
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
	// A valid archive always carries exactly one Butler and one Channel.
	for _, ref := range []DORef{{DO: "butler"}, {DO: "channel"}} {
		if _, ok := positions[ref]; ok {
			continue
		}
		manifest.DurableObjects = append(manifest.DurableObjects, DOManifest{
			DORef: ref,
			Rows:  map[string]int64{},
		})
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
	if len(manifest.DurableObjects) != 2 {
		t.Fatalf("durable objects = %#v", manifest.DurableObjects)
	}
	butlerObject := manifest.DurableObjects[0]
	if butlerObject.DO != "butler" || len(butlerObject.Schema.Tables) != 2 {
		t.Fatalf("durable objects = %#v", manifest.DurableObjects)
	}
	if butlerObject.Rows["memories"] != int64(len(rows)) {
		t.Fatalf("rows = %#v", butlerObject.Rows)
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
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("abort left files behind: %v", entries)
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

type rawEntry struct {
	name string
	data []byte
}

// writeRawArchive writes entries without Writer validation, so tests can
// describe archives a strict reader must refuse.
func writeRawArchive(t *testing.T, path string, manifest Manifest, entries []rawEntry) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	all := append([]rawEntry{{name: manifestEntry, data: manifestData}}, entries...)
	for _, entry := range all {
		entryWriter, err := writer.Create(entry.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entryWriter.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func minimalManifest() Manifest {
	return Manifest{
		Format:     FormatVersion,
		ExportedAt: time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC),
		Release:    "1.2.0",
		VersionID:  "version-1",
		WorkerName: "deskwand-bot",
		DurableObjects: []DOManifest{
			{DORef: DORef{DO: "butler"}, Rows: map[string]int64{}},
			{DORef: DORef{DO: "channel"}, Rows: map[string]int64{}},
		},
	}
}

func TestOpenRejectsInvalidJSONRow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.DurableObjects = []DOManifest{{
		DORef:  DORef{DO: "butler"},
		Schema: DBSchema{Tables: []TableSchema{{Name: "memories"}}},
		Rows:   map[string]int64{"memories": 1},
	}}
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/butler/memories.jsonl",
		data: []byte("not-json\n"),
	}})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsBlankLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.DurableObjects = []DOManifest{{
		DORef:  DORef{DO: "butler"},
		Schema: DBSchema{Tables: []TableSchema{{Name: "memories"}}},
		Rows:   map[string]int64{"memories": 1},
	}}
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/butler/memories.jsonl",
		data: []byte("{\"__rowid\":1}\n\n"),
	}})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsBadObjectEntryName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.R2.Objects = []R2Item{{Key: "x.png", Entry: "r2/1", Size: 1, ContentType: "image/png"}}
	writeRawArchive(t, path, manifest, []rawEntry{{name: "r2/1", data: []byte("a")}})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsDuplicateObjectEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.R2.Objects = []R2Item{
		{Key: "a.png", Entry: ObjectEntry(1), Size: 1, ContentType: "image/png"},
		{Key: "b.png", Entry: ObjectEntry(1), Size: 1, ContentType: "image/png"},
	}
	writeRawArchive(t, path, manifest, []rawEntry{{name: ObjectEntry(1), data: []byte("a")}})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsDuplicateZipEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.DurableObjects = []DOManifest{{
		DORef:  DORef{DO: "butler"},
		Schema: DBSchema{Tables: []TableSchema{{Name: "memories"}}},
		Rows:   map[string]int64{"memories": 1},
	}}
	entry := rawEntry{name: "do/butler/memories.jsonl", data: []byte("{\"__rowid\":1}\n")}
	writeRawArchive(t, path, manifest, []rawEntry{entry, entry})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsUnknownDOKind(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.DurableObjects = []DOManifest{{
		DORef:  DORef{DO: "mystery"},
		Schema: DBSchema{Tables: []TableSchema{{Name: "memories"}}},
		Rows:   map[string]int64{"memories": 1},
	}}
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/mystery//memories.jsonl",
		data: []byte("{\"__rowid\":1}\n"),
	}})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsTaskWithoutID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.DurableObjects = []DOManifest{{
		DORef:  DORef{DO: "task"},
		Schema: DBSchema{Tables: []TableSchema{{Name: "events"}}},
		Rows:   map[string]int64{"events": 1},
	}}
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/task//events.jsonl",
		data: []byte("{\"__rowid\":1}\n"),
	}})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestValidateDORefRequiresBotID(t *testing.T) {
	if err := validateDORef(DORef{DO: "bot"}); err == nil {
		t.Fatal("a bot without an id was accepted")
	}
	if err := validateDORef(DORef{DO: "bot", ID: "b1"}); err != nil {
		t.Fatalf("a bot with an id was rejected: %v", err)
	}
}

func TestOpenRejectsObjectSizeMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := minimalManifest()
	manifest.R2.Objects = []R2Item{{Key: "a.png", Entry: ObjectEntry(1), Size: 4, ContentType: "image/png"}}
	writeRawArchive(t, path, manifest, []rawEntry{{name: ObjectEntry(1), data: []byte("abc")}})

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsOversizedManifest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create(manifestEntry)
	if err != nil {
		t.Fatal(err)
	}
	// Only the declared uncompressed size has to exceed the cap.
	if _, err := entry.Write(make([]byte, maxManifestBytes+1)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	_, err = Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestWriterObjectRejectsSizeMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	writer, err := NewWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort()
	err = writer.Object(R2Item{Key: "a.png", Entry: ObjectEntry(1), Size: 4}, bytes.NewReader([]byte("abc")))
	if err == nil {
		t.Fatal("expected size mismatch error")
	}
}

func TestWriterTableRejectsTraversalName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	writer, err := NewWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort()
	for _, name := range []string{"a/b", "..", "x..y"} {
		if _, err := writer.Table(DORef{DO: "butler"}, name); err == nil {
			t.Fatalf("table name %q was accepted", name)
		}
	}
}

func TestLargeRowRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	payload := strings.Repeat("x", 2<<20)
	row, err := json.Marshal(map[string]string{"payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	butler := DORef{DO: "butler"}
	writeTestArchive(t, path, []testTable{{
		ref:    butler,
		schema: TableSchema{Name: "memories", Create: "CREATE TABLE memories (payload TEXT)"},
		rows:   []json.RawMessage{row},
	}}, nil, nil)

	reader, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var got []json.RawMessage
	if err := reader.Rows(butler, "memories", 1<<20, func(batch []json.RawMessage) error {
		got = append(got, batch...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("rows = %d, want 1", len(got))
	}
	if !bytes.Equal(got[0], row) {
		t.Fatalf("large row did not round-trip")
	}
}

func TestFinishWritesEmptyArrays(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	writeTestArchive(t, path, nil, nil, nil)

	archive, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	var data []byte
	for _, file := range archive.File {
		if file.Name != manifestEntry {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err = io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if data == nil {
		t.Fatal("manifest.json is missing")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	text := compact.String()
	for _, want := range []string{`"objects":[]`, `"oversized":[]`} {
		if !strings.Contains(text, want) {
			t.Fatalf("manifest = %s, want %s", text, want)
		}
	}
}

func manifestWithTables(tables ...DOManifest) Manifest {
	m := minimalManifest()
	m.DurableObjects = append(m.DurableObjects, tables...)
	return m
}

func TestOpenRejectsMissingRequiredDOs(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{
			name: "missing butler",
			mutate: func(m *Manifest) {
				var kept []DOManifest
				for _, object := range m.DurableObjects {
					if object.DO != "butler" {
						kept = append(kept, object)
					}
				}
				m.DurableObjects = kept
			},
		},
		{
			name: "missing channel",
			mutate: func(m *Manifest) {
				var kept []DOManifest
				for _, object := range m.DurableObjects {
					if object.DO != "channel" {
						kept = append(kept, object)
					}
				}
				m.DurableObjects = kept
			},
		},
		{
			name: "duplicate task id",
			mutate: func(m *Manifest) {
				m.DurableObjects = append(m.DurableObjects,
					DOManifest{DORef: DORef{DO: "task", ID: "t1"}, Rows: map[string]int64{}},
					DOManifest{DORef: DORef{DO: "task", ID: "t1"}, Rows: map[string]int64{}},
				)
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "backup.zip")
			writeTestArchive(t, path, nil, nil, testCase.mutate)
			_, err := Open(path)
			requireCode(t, err, CodeBackupInvalid)
		})
	}
}

func TestOpenRejectsMalformedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := manifestWithTables(DOManifest{
		DORef: DORef{DO: "butler"},
		Schema: DBSchema{Tables: []TableSchema{{
			Name:   "broken",
			Create: "CREATE TABLE broken (",
		}}},
		Rows: map[string]int64{"broken": 1},
	})
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/butler/broken.jsonl",
		data: []byte("{\"__rowid\":1}\n"),
	}})
	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsMalformedBlob(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := manifestWithTables(DOManifest{
		DORef: DORef{DO: "butler"},
		Schema: DBSchema{Tables: []TableSchema{{
			Name:   "blobs",
			Create: "CREATE TABLE blobs (b BLOB)",
		}}},
		Rows: map[string]int64{"blobs": 1},
	})
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/butler/blobs.jsonl",
		data: []byte("{\"__rowid\":1,\"b\":{\"$blob\":\"!!!\"}}\n"),
	}})
	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func TestOpenRejectsMalformedKVValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	manifest := manifestWithTables(DOManifest{
		DORef:  DORef{DO: "channel"},
		Schema: DBSchema{Tables: []TableSchema{{Name: "__kv", WithoutRowid: true}}},
		Rows:   map[string]int64{"__kv": 1},
	})
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/channel/__kv.jsonl",
		data: []byte("{\"key\":\"x\",\"value\":\"{not json\"}\n"),
	}})
	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func corruptZipEntry(t *testing.T, path, name string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	for _, file := range archive.File {
		if file.Name != name {
			continue
		}
		offset, err := file.DataOffset()
		if err != nil {
			t.Fatal(err)
		}
		if offset < 0 || offset >= int64(len(data)) {
			t.Fatalf("invalid data offset %d", offset)
		}
		data[offset] ^= 0xff
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	t.Fatalf("entry %s not found", name)
}

func TestOpenRejectsObjectCRCMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	body := []byte("artifact bytes")
	item := R2Item{Key: "a.png", Entry: ObjectEntry(1), Size: int64(len(body)), ContentType: "image/png"}
	writeTestArchive(t, path, nil, []testObject{{item: item, body: body}}, nil)
	corruptZipEntry(t, path, item.Entry)

	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}

func writeNumericArchive(t *testing.T, path, columnType, value string) {
	t.Helper()
	manifest := minimalManifest()
	manifest.DurableObjects = []DOManifest{
		{
			DORef:  DORef{DO: "butler"},
			Schema: DBSchema{Tables: []TableSchema{{Name: "counts", Create: "CREATE TABLE counts (n " + columnType + ")"}}},
			Rows:   map[string]int64{"counts": 1},
		},
		{DORef: DORef{DO: "channel"}, Rows: map[string]int64{}},
	}
	writeRawArchive(t, path, manifest, []rawEntry{{
		name: "do/butler/counts.jsonl",
		data: []byte(`{"__rowid":1,"n":` + value + "}\n"),
	}})
}

func TestOpenRejectsUnsafeBareInteger(t *testing.T) {
	for _, value := range []string{"9007199254740993", "-9007199254740993"} {
		t.Run(value, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "backup.zip")
			writeNumericArchive(t, path, "INTEGER", value)
			_, err := Open(path)
			requireCode(t, err, CodeBackupInvalid)
		})
	}
}

func TestOpenRejectsTaggedIntegerOutsideInt64(t *testing.T) {
	for _, value := range []string{
		`{"$int":"9223372036854775808"}`,
		`{"$int":"-9223372036854775809"}`,
	} {
		t.Run(value, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "backup.zip")
			writeNumericArchive(t, path, "INTEGER", value)
			_, err := Open(path)
			requireCode(t, err, CodeBackupInvalid)
		})
	}
}

func TestOpenAcceptsSafeAndTaggedIntegers(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"bare safe max", "9007199254740991"},
		{"bare safe min", "-9007199254740991"},
		{"tagged above safe", `{"$int":"9007199254740993"}`},
		{"tagged int64 max", `{"$int":"9223372036854775807"}`},
		{"tagged int64 min", `{"$int":"-9223372036854775808"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "backup.zip")
			writeNumericArchive(t, path, "INTEGER", testCase.raw)
			reader, err := Open(path)
			if err != nil {
				t.Fatalf("Open rejected %s: %v", testCase.raw, err)
			}
			_ = reader.Close()
		})
	}
}

func TestArchiveValuePreservesIntegerBoundaries(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		value string
	}{
		{"bare safe max", "9007199254740991", "9007199254740991"},
		{"bare safe min", "-9007199254740991", "-9007199254740991"},
		{"tagged above safe", `{"$int":"9007199254740993"}`, "9007199254740993"},
		{"tagged int64 max", `{"$int":"9223372036854775807"}`, "9223372036854775807"},
		{"tagged int64 min", `{"$int":"-9223372036854775808"}`, "-9223372036854775808"},
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE counts (n INTEGER)"); err != nil {
		t.Fatal(err)
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			value, placeholder, err := archiveValue(json.RawMessage(testCase.raw))
			if err != nil {
				t.Fatalf("archiveValue(%s): %v", testCase.raw, err)
			}
			if value != testCase.value {
				t.Fatalf("binding = %v, want %s", value, testCase.value)
			}
			if placeholder != "CAST(? AS INTEGER)" {
				t.Fatalf("placeholder = %q, want CAST(? AS INTEGER)", placeholder)
			}
			if _, err := db.Exec("INSERT INTO counts (n) VALUES ("+placeholder+")", value); err != nil {
				t.Fatalf("insert %s: %v", testCase.value, err)
			}
			var stored string
			if err := db.QueryRow("SELECT CAST(n AS TEXT) FROM counts ORDER BY rowid DESC LIMIT 1").Scan(&stored); err != nil {
				t.Fatal(err)
			}
			if stored != testCase.value {
				t.Fatalf("stored = %s, want %s", stored, testCase.value)
			}
		})
	}
}

func TestOpenAcceptsTaggedInfiniteReal(t *testing.T) {
	for _, value := range []string{`{"$real":"9.0e+999"}`, `{"$real":"-9.0e+999"}`} {
		t.Run(value, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "backup.zip")
			writeNumericArchive(t, path, "REAL", value)
			reader, err := Open(path)
			if err != nil {
				t.Fatalf("Open rejected %s: %v", value, err)
			}
			_ = reader.Close()
		})
	}
}

func TestOpenRejectsTaggedNaNReal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup.zip")
	writeNumericArchive(t, path, "REAL", `{"$real":"NaN"}`)
	_, err := Open(path)
	requireCode(t, err, CodeBackupInvalid)
}
