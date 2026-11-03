package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileThemeStoreDefaultsToSystem(t *testing.T) {
	store, err := NewFileThemeStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.Theme()
	if err != nil || source != ThemeSystem {
		t.Fatalf("Theme() = %q, %v; want %q, nil", source, err, ThemeSystem)
	}
}

func TestFileThemeStorePersistsTheme(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileThemeStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetTheme(ThemeDark); err != nil {
		t.Fatal(err)
	}
	source, err := store.Theme()
	if err != nil || source != ThemeDark {
		t.Fatalf("Theme() = %q, %v; want %q, nil", source, err, ThemeDark)
	}
	path := filepath.Join(dir, "preferences.json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("permissions = %o, want 600", perm)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"theme": "dark"`) {
		t.Fatalf("preferences = %s", data)
	}
}

func TestFileThemeStoreRejectsUnknownTheme(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileThemeStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetTheme("sepia"); err == nil {
		t.Fatal("unknown theme was accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "preferences.json")); !os.IsNotExist(err) {
		t.Fatalf("a rejected theme still wrote the file: %v", err)
	}
}

func TestFileThemeStoreFallsBackToSystem(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileThemeStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "preferences.json")
	for _, content := range []string{`{"theme":"`, `{"theme":"sepia"}`, `{}`, `null`} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		source, err := store.Theme()
		if err != nil || source != ThemeSystem {
			t.Fatalf("Theme() with %s = %q, %v; want %q, nil", content, source, err, ThemeSystem)
		}
	}
}
