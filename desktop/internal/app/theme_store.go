package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// The appearances the client stores. They are mygo.ThemeSource's values, which
// the desktop layer applies; this package keeps no dependency on a running app.
const (
	ThemeSystem = "system"
	ThemeLight  = "light"
	ThemeDark   = "dark"
)

// normalizeTheme returns the stored form of a theme source, or ok=false when
// source is not one of the three.
func normalizeTheme(source string) (string, bool) {
	switch source {
	case ThemeSystem, ThemeLight, ThemeDark:
		return source, true
	}
	return "", false
}

// ThemeStore is the persisted appearance choice. Theme always returns one of
// the three sources, whatever the file holds.
type ThemeStore interface {
	Theme() (string, error)
	SetTheme(source string) error
}

// FileThemeStore persists the appearance as JSON in the app data directory. It
// contains no secret.
type FileThemeStore struct {
	path string
	mu   sync.Mutex
	// Language supplies the language for validation messages; nil means zh.
	// It cannot be called Locale: FileThemeStore.Locale already reads the
	// persisted language source.
	Language func() string
}

func (s *FileThemeStore) lang() string {
	if s.Language == nil {
		return i18n.ZH
	}
	return s.Language()
}

// preferencesFile is the one preferences file. Theme and Locale share it so a
// save of one never drops the other.
type preferencesFile struct {
	Theme  string `json:"theme,omitempty"`
	Locale string `json:"locale,omitempty"`
}

// NewFileThemeStore creates the app data directory if needed and returns a
// store at <dir>/preferences.json.
func NewFileThemeStore(dir string) (*FileThemeStore, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("app: app data directory is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("app: create app data directory: %w", err)
	}
	return &FileThemeStore{path: filepath.Join(dir, "preferences.json")}, nil
}

// Theme returns the stored source, or ThemeSystem when the file is missing and
// also when it cannot be decoded or holds an unknown value: such a file is
// replaced by the next save, and until then the app follows the system rather
// than refusing to start or pinning an appearance nobody chose.
func (s *FileThemeStore) Theme() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readPreferences()
	if err != nil {
		return ThemeSystem, fmt.Errorf("app: read preferences: %w", err)
	}
	if source, ok := normalizeTheme(file.Theme); ok {
		return source, nil
	}
	return ThemeSystem, nil
}

// SetTheme writes the source atomically with owner-only permissions. A source
// this client does not know is rejected before anything is written.
func (s *FileThemeStore) SetTheme(source string) error {
	normalized, ok := normalizeTheme(source)
	if !ok {
		return domain.Error{Code: deployment.CodeInvalidRequest, Message: i18n.T(s.lang(), "app.themeInvalid")}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, _ := s.readPreferences()
	file.Theme = normalized
	return s.writePreferences(file)
}

// readPreferences returns the file's contents. A missing file and one that
// cannot be decoded both yield the zero value: the next save repairs it. The
// caller holds mu.
func (s *FileThemeStore) readPreferences() (preferencesFile, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return preferencesFile{}, nil
	}
	if err != nil {
		return preferencesFile{}, err
	}
	var file preferencesFile
	if err := json.Unmarshal(data, &file); err != nil {
		return preferencesFile{}, nil
	}
	return file, nil
}

// writePreferences encodes and atomically replaces the file. The caller holds
// mu.
func (s *FileThemeStore) writePreferences(file preferencesFile) error {
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("app: encode preferences: %w", err)
	}
	data = append(data, '\n')
	return writeFileAtomic(s.path, data)
}
