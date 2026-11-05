package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// defaultBackupDirName is the folder the client creates under Documents.
const defaultBackupDirName = "DeskWand 备份" // i18n-ignore: folder name on disk

// The choices the page offers. A hand-edited file cannot pick anything else,
// so the scheduler can never be made to run every minute.
var (
	allowedBackupIntervals = []int{1, 6, 24}
	allowedBackupKeep      = []int{1, 5, 10}
)

const (
	defaultBackupIntervalHours = 24
	defaultBackupKeep          = 5
)

// BackupSettingsDTO is the backup configuration the page reads and writes.
// LastSuccessAt is the last attempt that produced a file. LastAttemptAt is the
// last attempt of any kind and drives the schedule, so a failure waits a full
// interval instead of hammering every tick. LastErrorCode and LastErrorMessage
// describe that attempt and stay empty after a success.
type BackupSettingsDTO struct {
	Dir              string `json:"dir"`
	Auto             bool   `json:"auto"`
	IntervalHours    int    `json:"intervalHours"`
	Keep             int    `json:"keep"`
	LastSuccessAt    string `json:"lastSuccessAt"`
	LastSuccessPath  string `json:"lastSuccessPath"`
	LastAttemptAt    string `json:"lastAttemptAt"`
	LastErrorCode    string `json:"lastErrorCode"`
	LastErrorMessage string `json:"lastErrorMessage"`
}

// BackupSettingsEditDTO replaces the editable half of BackupSettingsDTO.
type BackupSettingsEditDTO struct {
	Dir           string `json:"dir"`
	Auto          bool   `json:"auto"`
	IntervalHours int    `json:"intervalHours"`
	Keep          int    `json:"keep"`
}

// BackupSettingsStore persists the backup configuration.
type BackupSettingsStore interface {
	Settings() (BackupSettingsDTO, error)
	Save(input BackupSettingsEditDTO) (BackupSettingsDTO, error)
	RecordRun(at time.Time, path string, runErr error) (BackupSettingsDTO, error)
}

// backupSettingsFile is the on-disk shape. It is not the DTO: the file keeps
// the raw values so a hand edit that an older client wrote is normalized on
// read instead of being rejected at startup.
type backupSettingsFile struct {
	Dir           string          `json:"dir"`
	Auto          bool            `json:"auto"`
	IntervalHours int             `json:"intervalHours"`
	Keep          int             `json:"keep"`
	LastRun       backupRunRecord `json:"lastRun"`
	LastAttempt   backupRunRecord `json:"lastAttempt"`
}

type backupRunRecord struct {
	At    string `json:"at"`
	Path  string `json:"path"`
	Code  string `json:"code"`
	Error string `json:"error"`
}

// FileBackupSettings stores the backup configuration as JSON in the app data
// directory. It contains no secret: only a local folder path and counters.
type FileBackupSettings struct {
	path        string
	fallbackDir string
	mu          sync.Mutex
	// Locale supplies the language for validation messages; nil means zh.
	Locale func() string
}

func (s *FileBackupSettings) lang() string {
	if s.Locale == nil {
		return i18n.ZH
	}
	return s.Locale()
}

// NewFileBackupSettings creates the app data directory if needed and returns a
// store at <appDir>/backup.json. fallbackDir is used when the user's home
// directory cannot be resolved.
func NewFileBackupSettings(appDir, fallbackDir string) (*FileBackupSettings, error) {
	if strings.TrimSpace(appDir) == "" {
		return nil, errors.New("app: app data directory is empty")
	}
	if err := os.MkdirAll(appDir, 0o700); err != nil {
		return nil, fmt.Errorf("app: create app data directory: %w", err)
	}
	return &FileBackupSettings{
		path:        filepath.Join(appDir, "backup.json"),
		fallbackDir: fallbackDir,
	}, nil
}

// Settings returns the stored configuration, or the defaults when the file is
// missing, unreadable or undecodable: such a file is replaced by the next save
// and until then the client behaves as if nothing was configured.
func (s *FileBackupSettings) Settings() (BackupSettingsDTO, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.decodeLocked()
	if err != nil {
		return BackupSettingsDTO{}, err
	}
	return settingsFromFile(file, s.fallbackDir), nil
}

// Save validates input, writes it atomically and returns the stored result.
// Nothing is written when validation fails, so a rejected folder does not
// replace a working one.
func (s *FileBackupSettings) Save(input BackupSettingsEditDTO) (BackupSettingsDTO, error) {
	dir := strings.TrimSpace(input.Dir)
	locale := s.lang()
	if dir == "" {
		return BackupSettingsDTO{}, domain.Error{Code: backup.CodeBackupSettingsInvalid, Message: i18n.T(locale, "app.backupDirRequired")}
	}
	if !filepath.IsAbs(dir) {
		return BackupSettingsDTO{}, domain.Error{Code: backup.CodeBackupSettingsInvalid, Message: i18n.T(locale, "app.backupDirNotAbsolute")}
	}
	if !slices.Contains(allowedBackupIntervals, input.IntervalHours) {
		return BackupSettingsDTO{}, domain.Error{Code: backup.CodeBackupSettingsInvalid, Message: i18n.T(locale, "app.backupIntervalInvalid")}
	}
	if !slices.Contains(allowedBackupKeep, input.Keep) {
		return BackupSettingsDTO{}, domain.Error{Code: backup.CodeBackupSettingsInvalid, Message: i18n.T(locale, "app.backupKeepInvalid")}
	}
	if err := ensureWritableDirIn(locale, dir); err != nil {
		return BackupSettingsDTO{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.decodeLocked()
	if err != nil {
		return BackupSettingsDTO{}, err
	}
	file.Dir = dir
	file.Auto = input.Auto
	file.IntervalHours = input.IntervalHours
	file.Keep = input.Keep
	if err := s.writeLocked(file); err != nil {
		return BackupSettingsDTO{}, err
	}
	return settingsFromFile(file, s.fallbackDir), nil
}

// RecordRun stores one attempt. A nil runErr is a success and clears the
// recorded failure, so the page never shows a stale error next to a fresh
// backup.
func (s *FileBackupSettings) RecordRun(at time.Time, path string, runErr error) (BackupSettingsDTO, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.decodeLocked()
	if err != nil {
		return BackupSettingsDTO{}, err
	}
	file.LastAttempt = backupRunRecord{At: formatTime(at), Path: path}
	if runErr == nil {
		file.LastRun = file.LastAttempt
	} else {
		code := appErrorCode(runErr)
		if code == "" {
			code = backup.CodeBackupFailed
		}
		file.LastAttempt.Path = ""
		file.LastAttempt.Code = code
		file.LastAttempt.Error = runErrorMessage(runErr)
	}
	if err := s.writeLocked(file); err != nil {
		return BackupSettingsDTO{}, err
	}
	return settingsFromFile(file, s.fallbackDir), nil
}

func (s *FileBackupSettings) decodeLocked() (backupSettingsFile, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return backupSettingsFile{}, nil
	}
	if err != nil {
		return backupSettingsFile{}, fmt.Errorf("app: read backup settings: %w", err)
	}
	var file backupSettingsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return backupSettingsFile{}, nil
	}
	return file, nil
}

func (s *FileBackupSettings) writeLocked(file backupSettingsFile) error {
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("app: encode backup settings: %w", err)
	}
	data = append(data, '\n')
	return writeFileAtomic(s.path, data)
}

// settingsFromFile normalizes the stored values into the DTO the page sees.
func settingsFromFile(file backupSettingsFile, fallbackDir string) BackupSettingsDTO {
	settings := BackupSettingsDTO{
		Dir:              strings.TrimSpace(file.Dir),
		Auto:             file.Auto,
		IntervalHours:    file.IntervalHours,
		Keep:             file.Keep,
		LastSuccessAt:    file.LastRun.At,
		LastSuccessPath:  file.LastRun.Path,
		LastAttemptAt:    file.LastAttempt.At,
		LastErrorCode:    file.LastAttempt.Code,
		LastErrorMessage: file.LastAttempt.Error,
	}
	if settings.Dir == "" || !filepath.IsAbs(settings.Dir) {
		settings.Dir = defaultBackupDir(fallbackDir)
	}
	if !slices.Contains(allowedBackupIntervals, settings.IntervalHours) {
		settings.IntervalHours = defaultBackupIntervalHours
	}
	if !slices.Contains(allowedBackupKeep, settings.Keep) {
		settings.Keep = defaultBackupKeep
	}
	return settings
}

// defaultBackupDir is the folder a fresh install backs up to. It does not
// touch the filesystem: the first export creates it.
func defaultBackupDir(fallbackDir string) string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return fallbackDir
	}
	return filepath.Join(home, "Documents", defaultBackupDirName)
}

// ensureWritableDir creates dir and proves it is writable, so an export never
// starts against a folder it cannot finish in. The probe has a random name: a
// fixed one could truncate a file the user keeps there (or be a symlink) and
// would make the folder unusable when a directory happens to have that name.
func ensureWritableDir(dir string) error {
	return ensureWritableDirIn(i18n.ZH, dir)
}

func ensureWritableDirIn(locale, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return domain.Error{Code: backup.CodeBackupSettingsInvalid, Message: i18n.T(locale, "app.backupDirNotCreatable")}
	}
	probe, err := os.CreateTemp(dir, ".deskwand-write-probe-*")
	if err != nil {
		return domain.Error{Code: backup.CodeBackupSettingsInvalid, Message: i18n.T(locale, "app.backupDirNotWritable")}
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return nil
}

// runErrorMessage is the one line stored next to a failed attempt.
func runErrorMessage(err error) string {
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		return domainErr.Message
	}
	return err.Error()
}
