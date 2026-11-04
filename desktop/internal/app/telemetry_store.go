package app

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// TelemetryState is everything the client keeps about anonymous reporting. It
// holds no credential and no identifier but the random device id.
type TelemetryState struct {
	DeviceID    string
	Enabled     bool
	ConfigDone  bool
	LastVersion string
}

// TelemetryStore is the persisted anonymous telemetry state: the device id the
// API groups rows by, the opt-out switch, and two one-shot facts (setup
// completed, and the version that ran last).
type TelemetryStore interface {
	Telemetry() (TelemetryState, error)
	Enabled() bool
	DeviceID() (string, error)
	SetTelemetryEnabled(enabled bool) error
	MarkConfigDone() (bool, error)
	RecordVersion(version string) error
}

// FileTelemetryStore persists the state as JSON in the app data directory.
type FileTelemetryStore struct {
	path string
	mu   sync.Mutex
}

// telemetryFile is the on-disk shape. Disabled is stored rather than Enabled so
// a file written before the switch existed, or half-written by hand, means
// "reporting on" — which is what the client did before the switch shipped.
type telemetryFile struct {
	DeviceID    string `json:"deviceId,omitempty"`
	Disabled    bool   `json:"disabled,omitempty"`
	ConfigDone  bool   `json:"configDone,omitempty"`
	LastVersion string `json:"lastVersion,omitempty"`
}

func (f telemetryFile) state() TelemetryState {
	return TelemetryState{
		DeviceID:    f.DeviceID,
		Enabled:     !f.Disabled,
		ConfigDone:  f.ConfigDone,
		LastVersion: f.LastVersion,
	}
}

// NewFileTelemetryStore creates the app data directory if needed and returns a
// store at <dir>/telemetry.json.
func NewFileTelemetryStore(dir string) (*FileTelemetryStore, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("app: app data directory is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("app: create app data directory: %w", err)
	}
	return &FileTelemetryStore{path: filepath.Join(dir, "telemetry.json")}, nil
}

// Telemetry returns the stored state, generating and saving a device id when
// the file has none. A file that cannot be decoded is treated as absent: the
// client must start, and a fresh id costs only one lost device's history.
func (s *FileTelemetryStore) Telemetry() (TelemetryState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked()
	if err != nil {
		return TelemetryState{}, err
	}
	if file.DeviceID != "" {
		return file.state(), nil
	}
	id, err := newDeviceID()
	if err != nil {
		return TelemetryState{}, err
	}
	file.DeviceID = id
	if err := s.writeLocked(file); err != nil {
		return TelemetryState{}, err
	}
	return file.state(), nil
}

// Enabled reports the switch. It answers false when the file cannot be read:
// an unknown switch must never result in a report.
func (s *FileTelemetryStore) Enabled() bool {
	state, err := s.Telemetry()
	if err != nil {
		return false
	}
	return state.Enabled
}

// DeviceID returns the anonymous id, creating it on first use.
func (s *FileTelemetryStore) DeviceID() (string, error) {
	state, err := s.Telemetry()
	if err != nil {
		return "", err
	}
	return state.DeviceID, nil
}

// SetTelemetryEnabled stores the switch.
func (s *FileTelemetryStore) SetTelemetryEnabled(enabled bool) error {
	return s.update(func(file *telemetryFile) { file.Disabled = !enabled })
}

// MarkConfigDone records that setup completed. It returns true only the first
// time, so the caller can report the funnel step exactly once.
func (s *FileTelemetryStore) MarkConfigDone() (bool, error) {
	first := false
	err := s.update(func(file *telemetryFile) {
		if !file.ConfigDone {
			file.ConfigDone = true
			first = true
		}
	})
	return first, err
}

// RecordVersion stores the version that ran, so the next launch can tell that
// an update was installed.
func (s *FileTelemetryStore) RecordVersion(version string) error {
	return s.update(func(file *telemetryFile) { file.LastVersion = version })
}

func (s *FileTelemetryStore) update(change func(*telemetryFile)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked()
	if err != nil {
		return err
	}
	change(&file)
	return s.writeLocked(file)
}

// readLocked reads the file, treating a missing or undecodable one as empty.
// s.mu is held.
func (s *FileTelemetryStore) readLocked() (telemetryFile, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return telemetryFile{}, nil
	}
	if err != nil {
		return telemetryFile{}, fmt.Errorf("app: read telemetry state: %w", err)
	}
	var file telemetryFile
	if err := json.Unmarshal(data, &file); err != nil {
		// An undecodable file must not quietly re-enable reporting for someone
		// who turned it off. Keep the opt-out, and leave the switch to rewrite
		// the file when the user changes it.
		return telemetryFile{Disabled: true}, nil
	}
	return file, nil
}

// writeLocked replaces the file atomically. s.mu is held.
func (s *FileTelemetryStore) writeLocked(file telemetryFile) error {
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("app: encode telemetry state: %w", err)
	}
	if err := writeFileAtomic(s.path, append(data, '\n')); err != nil {
		return fmt.Errorf("app: save telemetry state: %w", err)
	}
	return nil
}

// newDeviceID returns a random UUIDv4: it identifies an installation, and
// nothing about the machine or the person using it.
func newDeviceID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("app: generate device id: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
