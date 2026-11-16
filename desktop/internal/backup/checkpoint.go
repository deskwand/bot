package backup

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const checkpointStateFile = "state.json"

// CheckpointTable records one table that is fully written in the checkpoint.
type CheckpointTable struct {
	DO    string `json:"do"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Entry string `json:"entry"`
	Rows  int64  `json:"rows"`
}

// CheckpointR2 records the artifact listing and what was already copied. The
// listing is kept so a resumed run keeps the same entry numbers: an entry is
// named after the artifact's position in the listing.
type CheckpointR2 struct {
	Listed    bool     `json:"listed"`
	Objects   []R2Item `json:"objects"`
	Oversized []string `json:"oversized"`
}

// CheckpointState is the checkpoint's state.json. It holds no row data: the
// schemas are kept so a resumed run can tell whether a table changed shape.
type CheckpointState struct {
	TargetKey  string              `json:"targetKey"`
	VersionID  string              `json:"versionId"`
	Release    string              `json:"release"`
	StartedAt  time.Time           `json:"startedAt"`
	ExportedAt time.Time           `json:"exportedAt"`
	Schemas    map[string]DBSchema `json:"schemas"`
	Tables     []CheckpointTable   `json:"tables"`
	R2         CheckpointR2        `json:"r2"`
}

// Checkpoint is a resumable export directory: one JSONL file per finished
// table, one file per finished artifact, plus state.json.
type Checkpoint struct {
	dir      string
	key      string
	state    CheckpointState
	complete map[string]bool
	counts   map[string]int64
}

// doKeyOf names a Durable Object inside checkpoint keys and state.json.
func doKeyOf(ref DORef) string {
	if ref.ID == "" {
		return ref.DO
	}
	return ref.DO + "/" + ref.ID
}

// tableKey names one table inside the checkpoint. index() and the lookups must
// agree on it, or a table that finished is invisible to the next run.
func tableKey(ref DORef, table string) string {
	return doKeyOf(ref) + "/" + table
}

// checkpointPath names the checkpoint directory for one deployment and the key
// that ties the directory to it. One function, so the two cannot disagree.
func checkpointPath(resumeDir string, target domain.Target) (dir, targetKey string) {
	// The account is part of the name: one backup folder can hold several
	// deployments, and two of them must not share a checkpoint directory.
	slug := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		default:
			return '-'
		}
	}, strings.Trim(target.AccountID+"-"+target.ScriptName, "-"))
	if slug == "" {
		slug = "residence"
	}
	return filepath.Join(resumeDir, ".resume-"+slug), target.AccountID + "/" + target.ScriptName
}

// OpenCheckpoint opens dir, discarding state written for another target.
func OpenCheckpoint(dir, targetKey string) (*Checkpoint, error) {
	if targetKey == "" {
		return nil, fmt.Errorf("backup: checkpoint target key is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("backup: create checkpoint: %w", err)
	}
	checkpoint := &Checkpoint{dir: dir, key: targetKey}
	state, err := readCheckpointState(filepath.Join(dir, checkpointStateFile))
	if err == nil && state.TargetKey == targetKey {
		checkpoint.state = state
		checkpoint.index()
		return checkpoint, nil
	}
	// Missing, unreadable or another target's: start over. Entry files left by
	// the previous state are removed so a stale file cannot be mistaken for a
	// finished table.
	if err := os.RemoveAll(dir); err != nil {
		return nil, fmt.Errorf("backup: reset checkpoint: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("backup: reset checkpoint: %w", err)
	}
	checkpoint.state = CheckpointState{TargetKey: targetKey, Schemas: map[string]DBSchema{}}
	checkpoint.index()
	return checkpoint, nil
}

func readCheckpointState(path string) (CheckpointState, error) {
	var state CheckpointState
	raw, err := os.ReadFile(path)
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, err
	}
	return state, nil
}

func (c *Checkpoint) index() {
	c.complete = map[string]bool{}
	c.counts = map[string]int64{}
	for _, table := range c.state.Tables {
		key := tableKey(DORef{DO: table.DO, ID: table.ID}, table.Name)
		c.complete[key] = true
		c.counts[key] = table.Rows
	}
	if c.state.Schemas == nil {
		c.state.Schemas = map[string]DBSchema{}
	}
}

// Forget drops everything recorded for one Durable Object: its finished
// tables, its files, and its schema. Drift is per object, so the rest of the
// checkpoint stays usable.
func (c *Checkpoint) Forget(ref DORef) (int, int64, error) {
	state := c.state
	kept := make([]CheckpointTable, 0, len(state.Tables))
	tables := 0
	var rows int64
	for _, table := range state.Tables {
		if table.DO == ref.DO && table.ID == ref.ID {
			tables++
			rows += table.Rows
			continue
		}
		kept = append(kept, table)
	}
	state.Tables = kept
	delete(state.Schemas, doKeyOf(ref))
	if err := c.Save(state); err != nil {
		return 0, 0, err
	}
	// The object's files go once the state no longer mentions them. A leftover
	// file only wastes space; a file kept by state is what must not happen.
	_ = os.RemoveAll(c.doDir(ref))
	return tables, rows, nil
}

// doDir is the directory holding one object's table files.
func (c *Checkpoint) doDir(ref DORef) string {
	return filepath.Dir(c.entryPath(TableEntry(ref, "table")))
}

// NeedsReset reports whether a table that already finished no longer has the
// same definition. A resumed archive may mix data from different runs, but it
// must never mix table shapes: restoring that is unsound. Tables that never
// finished have no history to compare against.
func (c *Checkpoint) NeedsReset(ref DORef, schema DBSchema) bool {
	recorded, seen := c.state.Schemas[doKeyOf(ref)]
	if !seen {
		return false
	}
	previous := make(map[string]string, len(recorded.Tables))
	for _, table := range recorded.Tables {
		previous[table.Name] = table.Create
	}
	for name, create := range previous {
		known, present := findTable(schema, name)
		if !present || known != create {
			return true
		}
	}
	return false
}

func findTable(schema DBSchema, name string) (string, bool) {
	for _, table := range schema.Tables {
		if table.Name == name {
			return table.Create, true
		}
	}
	return "", false
}

// Dir is the checkpoint directory.
func (c *Checkpoint) Dir() string { return c.dir }

// State is the checkpoint's current state.
func (c *Checkpoint) State() CheckpointState { return c.state }

// Save writes state.json atomically.
func (c *Checkpoint) Save(state CheckpointState) error {
	c.state = state
	c.index()
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("backup: encode checkpoint state: %w", err)
	}
	temp := filepath.Join(c.dir, checkpointStateFile+".tmp")
	if err := os.WriteFile(temp, raw, 0o600); err != nil {
		return fmt.Errorf("backup: write checkpoint state: %w", err)
	}
	if err := os.Rename(temp, filepath.Join(c.dir, checkpointStateFile)); err != nil {
		return fmt.Errorf("backup: commit checkpoint state: %w", err)
	}
	return nil
}

// HasTable reports whether a table finished in an earlier run and its file is
// still there. state.json alone is not enough: a file removed by hand or by a
// crash must not be reported as backed up.
func (c *Checkpoint) HasTable(ref DORef, table string) bool {
	if !c.complete[tableKey(ref, table)] {
		return false
	}
	_, err := os.Stat(c.entryPath(TableEntry(ref, table)))
	return err == nil
}

// TableRows reports how many rows a finished table holds.
func (c *Checkpoint) TableRows(ref DORef, table string) int64 {
	return c.counts[tableKey(ref, table)]
}

func (c *Checkpoint) entryPath(entry string) string {
	return filepath.Join(c.dir, filepath.FromSlash(entry))
}

// AppendTable appends one batch of rows to a table's JSONL file and renames the
// file into place once the table is complete. Batches are appended, not
// buffered: a large table never has to fit in memory.
func (c *Checkpoint) AppendTable(ref DORef, table string, rows []json.RawMessage, done bool) error {
	path := c.entryPath(TableEntry(ref, table))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("backup: create table directory: %w", err)
	}
	key := tableKey(ref, table)
	// The first batch truncates whatever a killed run left behind; later
	// batches append to it.
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if c.counts[key] == 0 {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	file, err := os.OpenFile(path+".part", flags, 0o600)
	if err != nil {
		return fmt.Errorf("backup: open table file: %w", err)
	}
	writer := bufio.NewWriter(file)
	for _, row := range rows {
		var compact bytes.Buffer
		if err := json.Compact(&compact, row); err != nil {
			_ = file.Close()
			return fmt.Errorf("backup: encode row: %w", err)
		}
		if _, err := writer.Write(compact.Bytes()); err != nil {
			_ = file.Close()
			return fmt.Errorf("backup: write row: %w", err)
		}
		if err := writer.WriteByte('\n'); err != nil {
			_ = file.Close()
			return fmt.Errorf("backup: write row: %w", err)
		}
	}
	if err := writer.Flush(); err != nil {
		_ = file.Close()
		return fmt.Errorf("backup: flush table: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("backup: close table: %w", err)
	}
	c.counts[key] += int64(len(rows))
	if !done {
		return nil
	}
	if err := os.Rename(path+".part", path); err != nil {
		return fmt.Errorf("backup: commit table: %w", err)
	}
	// Recording completion here, rather than leaving it to the caller, keeps
	// HasTable honest: a table on disk is a table in state.json.
	state := c.state
	state.Tables = append(state.Tables, CheckpointTable{
		DO: ref.DO, ID: ref.ID, Name: table,
		Entry: TableEntry(ref, table), Rows: c.counts[key],
	})
	return c.Save(state)
}

// ReadTable opens one finished table's JSONL file.
func (c *Checkpoint) ReadTable(ref DORef, table string) (io.ReadCloser, error) {
	return os.Open(c.entryPath(TableEntry(ref, table)))
}

// HasObject reports whether an artifact's bytes are already stored.
func (c *Checkpoint) HasObject(entry string) bool {
	_, err := os.Stat(c.entryPath(entry))
	return err == nil
}

// WriteObject copies one artifact's body into the checkpoint. A short body is
// an error: a truncated file would otherwise look present and fail validation
// on every later run.
func (c *Checkpoint) WriteObject(entry string, body io.Reader, size int64) error {
	path := c.entryPath(entry)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("backup: create artifact directory: %w", err)
	}
	file, err := os.Create(path + ".part")
	if err != nil {
		return fmt.Errorf("backup: create artifact file: %w", err)
	}
	written, err := io.Copy(file, body)
	if err != nil {
		_ = file.Close()
		return fmt.Errorf("backup: write artifact: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("backup: close artifact: %w", err)
	}
	if written != size {
		_ = os.Remove(path + ".part")
		return fmt.Errorf("backup: artifact %s has %d bytes, the listing says %d", entry, written, size)
	}
	if err := os.Rename(path+".part", path); err != nil {
		return fmt.Errorf("backup: commit artifact: %w", err)
	}
	return nil
}

// ReadObject opens one stored artifact.
func (c *Checkpoint) ReadObject(entry string) (io.ReadCloser, error) {
	return os.Open(c.entryPath(entry))
}

// Discard removes the whole checkpoint directory.
func (c *Checkpoint) Discard() error {
	return os.RemoveAll(c.dir)
}
