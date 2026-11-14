package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// Move phases, in order. A record exists from packing until done or abandoned.
const (
	MovePacking   = "packing"
	MoveMuting    = "muting"
	MoveHoming    = "homing"
	MoveUnloading = "unloading"
	MoveDone      = "done"
	MoveAbandoned = "abandoned"
)

// CodeMoveJournalCorrupt reports a move.json this client cannot read.
const CodeMoveJournalCorrupt = "MOVE_JOURNAL_CORRUPT"

// ManifestBrief is the part of a Manifest the move page shows without opening
// the archive again.
type ManifestBrief struct {
	Release    string `json:"release"`
	ExportedAt string `json:"exportedAt"`
	Bytes      int64  `json:"bytes"`
}

// MoveRecord is the state of one move. From is the old residence; the new one
// lives in settings.json because the ordinary deploy flow writes it there.
type MoveRecord struct {
	Phase       string        `json:"phase"`
	ArchivePath string        `json:"archivePath"`
	From        domain.Target `json:"-"`
	FromJSON    targetJSON    `json:"from"`
	FromChannel string        `json:"fromChannel"`
	Summary     ManifestBrief `json:"summary"`
	UpdatedAt   time.Time     `json:"updatedAt"`
}

// MoveJournal stores the in-flight move beside restore.json.
type MoveJournal struct {
	path string
	mu   sync.Mutex
	Now  func() time.Time
}

// NewMoveJournal returns a journal at path. The file may not exist yet.
func NewMoveJournal(path string) (*MoveJournal, error) {
	if path == "" {
		return nil, errors.New("backup: move journal path is empty")
	}
	return &MoveJournal{path: path}, nil
}

// Read returns the recorded move, or nil when none is recorded.
func (j *MoveJournal) Read() (*MoveRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	data, err := os.ReadFile(j.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("backup: read move journal: %w", err)
	}
	var record MoveRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, domain.Error{Code: CodeMoveJournalCorrupt, Message: "move.json cannot be decoded"}
	}
	record.From = record.FromJSON.target()
	return &record, nil
}

// Write replaces the record atomically and stamps UpdatedAt.
func (j *MoveJournal) Write(record MoveRecord) error {
	now := time.Now
	if j.Now != nil {
		now = j.Now
	}
	record.UpdatedAt = now().UTC()
	record.FromJSON = newTargetJSON(record.From)
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return fmt.Errorf("backup: encode move journal: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(j.path), 0o700); err != nil {
		return fmt.Errorf("backup: create move journal directory: %w", err)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return writeJournalFileAtomic(j.path, append(data, '\n'))
}

// Clear forgets the record.
func (j *MoveJournal) Clear() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := os.Remove(j.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("backup: remove move journal: %w", err)
	}
	return nil
}

// targetJSON is domain.Target in its persisted form; Target itself carries no
// JSON tags because it never crosses the bridge.
type targetJSON struct {
	Kind       string    `json:"kind,omitempty"`
	AccountID  string    `json:"accountId,omitempty"`
	ScriptName string    `json:"scriptName,omitempty"`
	Host       *hostJSON `json:"host,omitempty"`
}

type hostJSON struct {
	Transport string `json:"transport,omitempty"`
	Engine    string `json:"engine,omitempty"`
	Address   string `json:"address"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	Auth      string `json:"auth"`
	KeyPath   string `json:"keyPath,omitempty"`
	Dir       string `json:"dir"`
}

func newTargetJSON(target domain.Target) targetJSON {
	out := targetJSON{Kind: target.Kind, AccountID: target.AccountID, ScriptName: target.ScriptName}
	if target.IsContainer() {
		out.Host = &hostJSON{
			Transport: target.Host.Transport, Engine: target.Host.Engine,
			Address: target.Host.Address, Port: target.Host.Port, User: target.Host.User,
			Auth: target.Host.Auth, KeyPath: target.Host.KeyPath, Dir: target.Host.Dir,
		}
	}
	return out
}

func (t targetJSON) target() domain.Target {
	out := domain.Target{Kind: t.Kind, AccountID: t.AccountID, ScriptName: t.ScriptName}
	if t.Host != nil {
		out.Host = domain.HostRef{
			Transport: t.Host.Transport, Engine: t.Host.Engine,
			Address: t.Host.Address, Port: t.Host.Port, User: t.Host.User,
			Auth: t.Host.Auth, KeyPath: t.Host.KeyPath, Dir: t.Host.Dir,
		}
	}
	return out
}

// writeJournalFileAtomic writes data through a temporary file in the same
// directory, so a crash never leaves a half-written journal.
func writeJournalFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".move-*")
	if err != nil {
		return fmt.Errorf("backup: create temporary move journal: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("backup: write temporary move journal: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("backup: close temporary move journal: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("backup: replace move journal: %w", err)
	}
	return nil
}
