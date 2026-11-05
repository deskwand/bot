package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/deskwand/bot/desktop/internal/i18n"
)

func newLocaleStore(t *testing.T) (*FileThemeStore, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := NewFileThemeStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return store, filepath.Join(dir, "preferences.json")
}

func TestSetThemeKeepsLocale(t *testing.T) {
	store, _ := newLocaleStore(t)
	if err := store.SetLocale(i18n.EN); err != nil {
		t.Fatal(err)
	}
	if err := store.SetTheme(ThemeDark); err != nil {
		t.Fatal(err)
	}
	locale, err := store.Locale()
	if err != nil || locale != i18n.EN {
		t.Fatalf("Locale() = %q, %v; want %q, nil", locale, err, i18n.EN)
	}
	theme, err := store.Theme()
	if err != nil || theme != ThemeDark {
		t.Fatalf("Theme() = %q, %v; want %q, nil", theme, err, ThemeDark)
	}
}

func TestSetLocaleKeepsTheme(t *testing.T) {
	store, _ := newLocaleStore(t)
	if err := store.SetTheme(ThemeLight); err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocale(i18n.ZH); err != nil {
		t.Fatal(err)
	}
	theme, err := store.Theme()
	if err != nil || theme != ThemeLight {
		t.Fatalf("Theme() = %q, %v; want %q, nil", theme, err, ThemeLight)
	}
	locale, err := store.Locale()
	if err != nil || locale != i18n.ZH {
		t.Fatalf("Locale() = %q, %v; want %q, nil", locale, err, i18n.ZH)
	}
}

func TestLocaleFallsBackOnBadFile(t *testing.T) {
	store, path := newLocaleStore(t)
	if err := os.WriteFile(path, []byte(`{"theme":"dark","locale":"fr"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if locale, err := store.Locale(); err != nil || locale != i18n.System {
		t.Fatalf("Locale() = %q, %v; want %q, nil", locale, err, i18n.System)
	}
	if theme, err := store.Theme(); err != nil || theme != ThemeDark {
		t.Fatalf("Theme() = %q, %v; want %q, nil", theme, err, ThemeDark)
	}

	if err := os.WriteFile(path, []byte(`not json`), 0o600); err != nil {
		t.Fatal(err)
	}
	if locale, err := store.Locale(); err != nil || locale != i18n.System {
		t.Fatalf("Locale() = %q, %v; want %q, nil", locale, err, i18n.System)
	}

	if err := store.SetLocale(i18n.ZH); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file preferencesFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if file.Locale != i18n.ZH {
		t.Fatalf("saved locale = %q; want %q", file.Locale, i18n.ZH)
	}
}

func TestSetLocaleRejectsUnknown(t *testing.T) {
	store, path := newLocaleStore(t)
	if err := store.SetLocale("fr"); err == nil {
		t.Fatal("unknown locale was accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("a rejected locale still wrote the file: %v", err)
	}
}
