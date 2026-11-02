package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const (
	restoreJournalFile = "restore.json"
	restoreStateRun    = "running"
	restoreStateFailed = "failed"
)

// RestoreRecord is the operation journal kept while a restore is unfinished.
// State is "running" until the write-back fails, then "failed" with the
// domain.Error code that stopped it.
type RestoreRecord struct {
	OperationID  string        `json:"operationId"`
	Target       domain.Target `json:"target"`
	BackupPath   string        `json:"backupPath"`
	SnapshotPath string        `json:"snapshotPath"`
	State        string        `json:"state"`
	FailureCode  string        `json:"failureCode,omitempty"`
	CreatedAt    time.Time     `json:"createdAt"`
	UpdatedAt    time.Time     `json:"updatedAt"`
}

// RestoreJournal stores at most one unfinished restore under a directory.
type RestoreJournal struct {
	path string
}

// NewRestoreJournal prepares dir for the restore journal.
func NewRestoreJournal(dir string) (*RestoreJournal, error) {
	if dir == "" {
		return nil, fmt.Errorf("backup: restore journal directory is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("backup: create restore journal directory: %w", err)
	}
	return &RestoreJournal{path: filepath.Join(dir, restoreJournalFile)}, nil
}

// Pending returns the unfinished restore, or nil when there is none.
func (j *RestoreJournal) Pending() (*RestoreRecord, error) {
	data, err := os.ReadFile(j.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("backup: read restore journal: %w", err)
	}
	var record RestoreRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, domain.Error{
			Code:    CodeRestoreJournalCorrupt,
			Message: fmt.Sprintf("decode restore journal: %v", err),
		}
	}
	return &record, nil
}

// Save replaces the journal atomically, so a crash leaves either the old
// record or the new one.
func (j *RestoreJournal) Save(record RestoreRecord) error {
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return fmt.Errorf("backup: encode restore journal: %w", err)
	}
	data = append(data, '\n')
	temp := j.path + ".tmp"
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("backup: create restore journal: %w", err)
	}
	remove := true
	defer func() {
		if remove {
			_ = file.Close()
			_ = os.Remove(temp)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("backup: write restore journal: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("backup: sync restore journal: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("backup: close restore journal: %w", err)
	}
	if err := os.Rename(temp, j.path); err != nil {
		return fmt.Errorf("backup: replace restore journal: %w", err)
	}
	remove = false
	_ = syncDir(filepath.Dir(j.path))
	return nil
}

// Clear removes the journal. It is idempotent.
func (j *RestoreJournal) Clear() error {
	if err := os.Remove(j.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("backup: clear restore journal: %w", err)
	}
	return nil
}
