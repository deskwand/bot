// Package deployment implements the publish state machine and its durable
// operation journal. Secret values never enter the journal: pending values
// live only in the operating-system credential store under keys recorded in
// SecretRefs.
package deployment

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

var operationIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// OperationRecord is one journaled publish operation. ConfigJSON is the
// non-secret merged configuration needed to retry a stage. SecretEdits carry
// only names and operations; SecretRefs name the credential-store keys that
// hold pending values.
type OperationRecord struct {
	OperationID     string              `json:"operationId"`
	Target          domain.Target       `json:"target"`
	State           string              `json:"state"`
	Steps           []domain.Step       `json:"steps"`
	BaseFingerprint string              `json:"baseFingerprint"`
	BaseVersionID   string              `json:"baseVersionId"`
	StagedVersionID string              `json:"stagedVersionId"`
	DeploymentID    string              `json:"deploymentId,omitempty"`
	SecretRefs      []string            `json:"secretRefs"`
	ConfigJSON      json.RawMessage     `json:"configJson,omitempty"`
	SecretEdits     []domain.SecretEdit `json:"secretEdits,omitempty"`
	StageAttempted  bool                `json:"stageAttempted"`
	CleanupPending  bool                `json:"cleanupPending,omitempty"`
	FailureCode     string              `json:"failureCode,omitempty"`
	CreatedAt       time.Time           `json:"createdAt"`
	UpdatedAt       time.Time           `json:"updatedAt"`
}

// Journal stores one JSON file per operation in an injected directory. Writes
// are atomic: temp file, fsync, close, rename.
type Journal struct {
	dir string
}

// NewJournal creates the journal directory if needed.
func NewJournal(dir string) (*Journal, error) {
	if dir == "" {
		return nil, fmt.Errorf("deployment: journal directory is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("deployment: create journal directory: %w", err)
	}
	return &Journal{dir: dir}, nil
}

// Dir returns the journal directory.
func (j *Journal) Dir() string { return j.dir }

// Save writes record atomically. The temporary file has the same permissions
// and content as the final record, so no file in the directory ever contains
// a secret value.
func (j *Journal) Save(record OperationRecord) error {
	if !operationIDPattern.MatchString(record.OperationID) {
		return fmt.Errorf("deployment: invalid operation id")
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return fmt.Errorf("deployment: encode operation: %w", err)
	}
	data = append(data, '\n')

	temp, err := os.CreateTemp(j.dir, ".operation-*.tmp")
	if err != nil {
		return fmt.Errorf("deployment: create temporary operation file: %w", err)
	}
	tempName := temp.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tempName)
		}
	}()

	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("deployment: set operation file permissions: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("deployment: write operation file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("deployment: sync operation file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("deployment: close operation file: %w", err)
	}
	finalName := filepath.Join(j.dir, record.OperationID+".json")
	if err := os.Rename(tempName, finalName); err != nil {
		return fmt.Errorf("deployment: replace operation file: %w", err)
	}
	renamed = true
	if err := syncDirectory(j.dir); err != nil {
		return fmt.Errorf("deployment: sync journal directory: %w", err)
	}
	return nil
}

// Load reads one operation by id.
func (j *Journal) Load(operationID string) (OperationRecord, error) {
	if !operationIDPattern.MatchString(operationID) {
		return OperationRecord{}, fmt.Errorf("deployment: invalid operation id")
	}
	data, err := os.ReadFile(filepath.Join(j.dir, operationID+".json"))
	if err != nil {
		return OperationRecord{}, fmt.Errorf("deployment: read operation: %w", err)
	}
	var record OperationRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return OperationRecord{}, fmt.Errorf("deployment: decode operation: %w", err)
	}
	if record.OperationID != operationID {
		return OperationRecord{}, fmt.Errorf("deployment: operation file id mismatch")
	}
	return record, nil
}

func syncDirectory(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}
