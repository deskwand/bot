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
}

type preferencesFile struct {
	Theme string `json:"theme"`
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
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return ThemeSystem, nil
	}
	if err != nil {
		return ThemeSystem, fmt.Errorf("app: read preferences: %w", err)
	}
	var file preferencesFile
	if err := json.Unmarshal(data, &file); err != nil {
		return ThemeSystem, nil
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
		return domain.Error{Code: deployment.CodeInvalidRequest, Message: "外观设置无效"}
	}
	data, err := json.MarshalIndent(preferencesFile{Theme: normalized}, "", "  ")
	if err != nil {
		return fmt.Errorf("app: encode preferences: %w", err)
	}
	data = append(data, '\n')
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeFileAtomic(s.path, data)
}
