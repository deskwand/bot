package backup

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// FormatVersion is the only archive format this client reads or writes.
const FormatVersion = 1

const (
	manifestEntry = "manifest.json"
	// scannerLimit accommodates a single row larger than the Worker's 1 MiB
	// page size without rejecting a valid backup.
	scannerLimit = 64 << 20
	// maxManifestBytes bounds the manifest read so a corrupt archive cannot
	// exhaust memory through a huge compressed entry.
	maxManifestBytes = 64 << 20
)

var objectEntryPattern = regexp.MustCompile(`^r2/[0-9]{6}$`)

// TableSchema describes one exported SQLite table. Create is empty for the
// DO KV pseudo-table.
type TableSchema struct {
	Name         string `json:"name"`
	Create       string `json:"create"`
	WithoutRowid bool   `json:"withoutRowid"`
}

// DBSchema is the structure of one Durable Object's SQLite database.
type DBSchema struct {
	Tables  []TableSchema `json:"tables"`
	Indexes []string      `json:"indexes"`
}

// DORef identifies one Durable Object. DO is "butler", "task" or "channel";
// ID is set only for task objects.
type DORef struct {
	DO string `json:"do"`
	ID string `json:"id"`
}

// DOManifest records one Durable Object's schema and row count per table.
type DOManifest struct {
	DORef
	Schema DBSchema         `json:"schema"`
	Rows   map[string]int64 `json:"rows"`
}

// R2Item records one artifact stored in the archive.
type R2Item struct {
	Key         string `json:"key"`
	Entry       string `json:"entry"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

// R2Manifest records the artifacts in the archive. Oversized holds keys that
// exceed MaxR2ObjectBytes; they are listed in the manifest but their bytes are
// not stored, so a restore refuses the archive instead of truncating them.
type R2Manifest struct {
	Objects   []R2Item `json:"objects"`
	Bytes     int64    `json:"bytes"`
	Oversized []string `json:"oversized"`
}

// Manifest is the archive's manifest.json document.
type Manifest struct {
	Format         int          `json:"format"`
	ExportedAt     time.Time    `json:"exportedAt"`
	Release        string       `json:"release"`
	VersionID      string       `json:"versionId"`
	WorkerName     string       `json:"workerName"`
	DurableObjects []DOManifest `json:"durableObjects"`
	R2             R2Manifest   `json:"r2"`
}

// TableEntry returns the archive path for one table's JSONL rows.
func TableEntry(ref DORef, table string) string {
	switch ref.DO {
	case "butler":
		return "do/butler/" + table + ".jsonl"
	case "channel":
		return "do/channel/" + table + ".jsonl"
	default:
		return "do/" + ref.DO + "/" + ref.ID + "/" + table + ".jsonl"
	}
}

// ObjectEntry returns the archive path for the artifact at index, counting
// from one.
func ObjectEntry(index int) string {
	return fmt.Sprintf("r2/%06d", index)
}

// checkedObjectEntry rejects the index that would break the six-digit format.
func checkedObjectEntry(index int) (string, error) {
	if index < 1 || index > maxArchivedObjects {
		return "", invalidBackupf("artifact index %d is outside 1..%d", index, maxArchivedObjects)
	}
	return ObjectEntry(index), nil
}

// Writer writes a backup archive through a temporary file in the destination
// directory and renames it into place on Finish.
type Writer struct {
	finalPath string
	tempPath  string
	file      *os.File
	zip       *zip.Writer
	table     *TableWriter
	closed    bool
}

// NewWriter creates a writer for finalPath. The temporary file is created
// next to it so Finish can rename atomically.
func NewWriter(finalPath string) (*Writer, error) {
	if finalPath == "" {
		return nil, fmt.Errorf("backup: archive path is empty")
	}
	tempPath := finalPath + ".tmp"
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("backup: create archive: %w", err)
	}
	return &Writer{
		finalPath: finalPath,
		tempPath:  tempPath,
		file:      file,
		zip:       zip.NewWriter(file),
	}, nil
}

// Table starts a new JSONL entry and closes the previous one.
func (w *Writer) Table(ref DORef, table string) (*TableWriter, error) {
	if w.closed {
		return nil, fmt.Errorf("backup: archive is closed")
	}
	if strings.Contains(table, "/") || strings.Contains(table, "..") {
		return nil, fmt.Errorf("backup: invalid table name %q", table)
	}
	if err := w.closeTable(); err != nil {
		return nil, err
	}
	entry, err := w.zip.Create(TableEntry(ref, table))
	if err != nil {
		return nil, fmt.Errorf("backup: create table entry: %w", err)
	}
	w.table = &TableWriter{writer: entry}
	return w.table, nil
}

// Object writes one artifact entry and closes the current table entry.
func (w *Writer) Object(item R2Item, body io.Reader) error {
	if w.closed {
		return fmt.Errorf("backup: archive is closed")
	}
	if item.Entry == "" {
		return fmt.Errorf("backup: object entry is empty")
	}
	if err := w.closeTable(); err != nil {
		return err
	}
	entry, err := w.zip.Create(item.Entry)
	if err != nil {
		return fmt.Errorf("backup: create object entry: %w", err)
	}
	written, err := io.Copy(entry, body)
	if err != nil {
		return fmt.Errorf("backup: write object entry: %w", err)
	}
	if written != item.Size {
		return fmt.Errorf("backup: object %s has %d bytes, manifest says %d", item.Entry, written, item.Size)
	}
	return nil
}

// Finish writes manifest.json, syncs and renames the archive into place.
func (w *Writer) Finish(manifest Manifest) (err error) {
	if w.closed {
		return fmt.Errorf("backup: archive is closed")
	}
	defer func() {
		if err != nil {
			_ = w.zip.Close()
			_ = w.file.Close()
			_ = os.Remove(w.tempPath)
			w.closed = true
		}
	}()

	if err := w.closeTable(); err != nil {
		return err
	}
	if manifest.R2.Objects == nil {
		manifest.R2.Objects = []R2Item{}
	}
	if manifest.R2.Oversized == nil {
		manifest.R2.Oversized = []string{}
	}
	for i := range manifest.DurableObjects {
		if manifest.DurableObjects[i].Schema.Tables == nil {
			manifest.DurableObjects[i].Schema.Tables = []TableSchema{}
		}
		if manifest.DurableObjects[i].Schema.Indexes == nil {
			manifest.DurableObjects[i].Schema.Indexes = []string{}
		}
	}
	entry, err := w.zip.Create(manifestEntry)
	if err != nil {
		return fmt.Errorf("backup: create manifest: %w", err)
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("backup: encode manifest: %w", err)
	}
	data = append(data, '\n')
	if _, err := entry.Write(data); err != nil {
		return fmt.Errorf("backup: write manifest: %w", err)
	}
	if err := w.zip.Close(); err != nil {
		return fmt.Errorf("backup: close archive: %w", err)
	}
	if err := w.file.Sync(); err != nil {
		return fmt.Errorf("backup: sync archive: %w", err)
	}
	if err := w.file.Close(); err != nil {
		return fmt.Errorf("backup: close archive file: %w", err)
	}
	if err := os.Rename(w.tempPath, w.finalPath); err != nil {
		return fmt.Errorf("backup: replace archive: %w", err)
	}
	w.closed = true
	// Once the final file exists the archive is complete; syncing the
	// directory is best-effort durability on crash.
	_ = syncDir(filepath.Dir(w.finalPath))
	return nil
}

// Abort discards the temporary archive.
func (w *Writer) Abort() error {
	if w.closed {
		return nil
	}
	w.closed = true
	_ = w.zip.Close()
	_ = w.file.Close()
	if err := os.Remove(w.tempPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("backup: remove temporary archive: %w", err)
	}
	return nil
}

func (w *Writer) closeTable() error {
	if w.table == nil {
		return nil
	}
	table := w.table
	w.table = nil
	return table.close()
}

// TableWriter appends rows to one JSONL archive entry.
type TableWriter struct {
	writer io.Writer
	rows   int64
	closed bool
}

// Append writes each row as one compact JSON line.
func (t *TableWriter) Append(rows []json.RawMessage) error {
	if t.closed {
		return fmt.Errorf("backup: table entry is closed")
	}
	for _, row := range rows {
		var compact bytes.Buffer
		if err := json.Compact(&compact, row); err != nil {
			return fmt.Errorf("backup: encode row: %w", err)
		}
		if compact.Len() >= scannerLimit {
			return fmt.Errorf("backup: row is larger than %d bytes", scannerLimit-1)
		}
		compact.WriteByte('\n')
		if _, err := t.writer.Write(compact.Bytes()); err != nil {
			return fmt.Errorf("backup: write row: %w", err)
		}
		t.rows++
	}
	return nil
}

// Rows returns the number of rows appended so far.
func (t *TableWriter) Rows() int64 { return t.rows }

func (t *TableWriter) close() error {
	if t.closed {
		return nil
	}
	t.closed = true
	return nil
}

// Reader reads a validated backup archive.
type Reader struct {
	archive  *zip.ReadCloser
	manifest Manifest
	files    map[string]*zip.File
}

// Open opens the archive and validates its manifest against its entries.
func Open(path string) (*Reader, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return nil, invalidBackupf("open archive: %v", err)
	}
	files := make(map[string]*zip.File, len(archive.File))
	for _, file := range archive.File {
		if _, exists := files[file.Name]; exists {
			_ = archive.Close()
			return nil, invalidBackupf("duplicate zip entry %s", file.Name)
		}
		files[file.Name] = file
	}
	manifestFile, ok := files[manifestEntry]
	if !ok {
		_ = archive.Close()
		return nil, invalidBackupf("manifest.json is missing")
	}
	data, err := readManifestFile(manifestFile)
	if err != nil {
		_ = archive.Close()
		return nil, invalidBackupf("read manifest: %v", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		_ = archive.Close()
		return nil, invalidBackupf("decode manifest: %v", err)
	}
	if manifest.Format != FormatVersion {
		_ = archive.Close()
		return nil, invalidBackupf("unsupported format %d", manifest.Format)
	}
	if err := validateManifestStructure(manifest); err != nil {
		_ = archive.Close()
		return nil, invalidBackupf("%v", err)
	}
	for _, object := range manifest.DurableObjects {
		// Execute the schema and every row against a scratch database before
		// any destructive RPC. This catches broken CREATE SQL, constraint
		// violations and unknown columns while the deployment is untouched.
		if err := preflightObject(object, files); err != nil {
			_ = archive.Close()
			return nil, invalidBackupf("%s: %v", object.DO+" "+object.ID, err)
		}
	}
	seenObjects := make(map[string]struct{}, len(manifest.R2.Objects))
	seenKeys := make(map[string]struct{}, len(manifest.R2.Objects))
	for _, object := range manifest.R2.Objects {
		if !objectEntryPattern.MatchString(object.Entry) {
			_ = archive.Close()
			return nil, invalidBackupf("object entry %s is invalid", object.Entry)
		}
		if object.Key == "" {
			_ = archive.Close()
			return nil, invalidBackupf("object entry %s has an empty key", object.Entry)
		}
		if _, exists := seenObjects[object.Entry]; exists {
			_ = archive.Close()
			return nil, invalidBackupf("object entry %s is duplicated", object.Entry)
		}
		if _, exists := seenKeys[object.Key]; exists {
			_ = archive.Close()
			return nil, invalidBackupf("object key %s is duplicated", object.Key)
		}
		seenObjects[object.Entry] = struct{}{}
		seenKeys[object.Key] = struct{}{}
		file, ok := files[object.Entry]
		if !ok {
			_ = archive.Close()
			return nil, invalidBackupf("object entry %s is missing", object.Entry)
		}
		if object.Size < 0 || uint64(object.Size) != file.UncompressedSize64 {
			_ = archive.Close()
			return nil, invalidBackupf("object entry %s has %d bytes, manifest says %d", object.Entry, file.UncompressedSize64, object.Size)
		}
		// Read through EOF so zip verifies the CRC before a restore deletes
		// the current artifacts. Merely opening the entry does not.
		body, err := file.Open()
		if err != nil {
			_ = archive.Close()
			return nil, invalidBackupf("open object entry %s: %v", object.Entry, err)
		}
		_, readErr := io.Copy(io.Discard, body)
		closeErr := body.Close()
		if readErr != nil {
			_ = archive.Close()
			return nil, invalidBackupf("verify object entry %s: %v", object.Entry, readErr)
		}
		if closeErr != nil {
			_ = archive.Close()
			return nil, invalidBackupf("verify object entry %s: %v", object.Entry, closeErr)
		}
	}
	return &Reader{archive: archive, manifest: manifest, files: files}, nil
}

// Manifest returns the archive's manifest.
func (r *Reader) Manifest() Manifest { return r.manifest }

// Rows replays one table's rows in batches accumulated up to maxBytes.
func (r *Reader) Rows(ref DORef, table string, maxBytes int, fn func(batch []json.RawMessage) error) error {
	entry := TableEntry(ref, table)
	file, ok := r.files[entry]
	if !ok {
		return invalidBackupf("table entry %s is missing", entry)
	}
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	reader, err := file.Open()
	if err != nil {
		return invalidBackupf("open table entry %s: %v", entry, err)
	}
	defer reader.Close()

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), scannerLimit)
	var batch []json.RawMessage
	size := 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := fn(batch); err != nil {
			return err
		}
		batch = nil
		size = 0
		return nil
	}
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			return invalidBackupf("table entry %s contains a blank line", entry)
		}
		if !json.Valid(line) {
			return invalidBackupf("table entry %s contains invalid JSON", entry)
		}
		row := make([]byte, len(line))
		copy(row, line)
		if len(batch) > 0 && size+len(row) > maxBytes {
			if err := flush(); err != nil {
				return err
			}
		}
		batch = append(batch, json.RawMessage(row))
		size += len(row)
	}
	if err := scanner.Err(); err != nil {
		return invalidBackupf("read table entry %s: %v", entry, err)
	}
	return flush()
}

// Object opens one artifact's bytes. The caller closes it.
func (r *Reader) Object(item R2Item) (io.ReadCloser, error) {
	file, ok := r.files[item.Entry]
	if !ok {
		return nil, invalidBackupf("object entry %s is missing", item.Entry)
	}
	reader, err := file.Open()
	if err != nil {
		return nil, invalidBackupf("open object entry %s: %v", item.Entry, err)
	}
	return reader, nil
}

// Close closes the underlying archive.
func (r *Reader) Close() error { return r.archive.Close() }

func readManifestFile(file *zip.File) ([]byte, error) {
	if file.UncompressedSize64 > maxManifestBytes {
		return nil, fmt.Errorf("manifest is larger than %d bytes", maxManifestBytes)
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, maxManifestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxManifestBytes {
		return nil, fmt.Errorf("manifest is larger than %d bytes", maxManifestBytes)
	}
	return data, nil
}

func validateDORef(ref DORef) error {
	switch ref.DO {
	case "butler", "channel":
		return nil
	case "task":
		if ref.ID == "" {
			return fmt.Errorf("task id is empty")
		}
		return nil
	default:
		return fmt.Errorf("unknown durable object %q", ref.DO)
	}
}

func invalidBackupf(format string, args ...any) domain.Error {
	return domain.Error{Code: CodeBackupInvalid, Message: fmt.Sprintf(format, args...)}
}

func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}
