package app

import (
	"errors"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/deployment"
)

// fakeThemeStore is the persisted preference as the service sees it. saveErr
// makes the disk refuse writes, as a read-only home directory would.
type fakeThemeStore struct {
	source  string
	saveErr error
	writes  []string
}

func (f *fakeThemeStore) Theme() (string, error) {
	if f.source == "" {
		return ThemeSystem, nil
	}
	return f.source, nil
}

func (f *fakeThemeStore) SetTheme(source string) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.source = source
	f.writes = append(f.writes, source)
	return nil
}

func newThemeService(store ThemeStore, applied *[]string) *Service {
	return NewService(ServiceOptions{
		Theme: store,
		ApplyTheme: func(source string) {
			*applied = append(*applied, source)
		},
	})
}

func TestServiceThemeDefaultsToSystem(t *testing.T) {
	var applied []string
	service := newThemeService(&fakeThemeStore{}, &applied)
	if got := service.Theme(); got != ThemeSystem {
		t.Fatalf("Theme() = %q; want %q", got, ThemeSystem)
	}
	if len(applied) != 0 {
		t.Fatalf("reading the theme applied %v", applied)
	}
}

func TestServiceSetThemeStoresAndApplies(t *testing.T) {
	store := &fakeThemeStore{}
	var applied []string
	service := newThemeService(store, &applied)
	if err := service.SetTheme(ThemeDark); err != nil {
		t.Fatal(err)
	}
	if len(store.writes) != 1 || store.writes[0] != ThemeDark {
		t.Fatalf("writes = %v; want [%q]", store.writes, ThemeDark)
	}
	if len(applied) != 1 || applied[0] != ThemeDark {
		t.Fatalf("applied = %v; want [%q]", applied, ThemeDark)
	}
	if got := service.Theme(); got != ThemeDark {
		t.Fatalf("Theme() = %q; want %q", got, ThemeDark)
	}
}

func TestServiceSetThemeRejectsUnknownSource(t *testing.T) {
	store := &fakeThemeStore{}
	var applied []string
	service := newThemeService(store, &applied)
	err := service.SetTheme("sepia")
	if err == nil {
		t.Fatal("unknown theme was accepted")
	}
	if !hasCode(err, deployment.CodeInvalidRequest) {
		t.Fatalf("error = %v; want code %s", err, deployment.CodeInvalidRequest)
	}
	if len(applied) != 0 || len(store.writes) != 0 {
		t.Fatalf("rejected theme applied = %v, writes = %v", applied, store.writes)
	}
}

func TestServiceSetThemeKeepsAppearanceWhenStoreFails(t *testing.T) {
	store := &fakeThemeStore{saveErr: errors.New("read-only file system")}
	var applied []string
	service := newThemeService(store, &applied)
	if err := service.SetTheme(ThemeLight); err == nil {
		t.Fatal("a failed save was reported as success")
	}
	if len(applied) != 0 {
		t.Fatalf("applied = %v after a failed save", applied)
	}
	if got := service.Theme(); got != ThemeSystem {
		t.Fatalf("Theme() = %q; want %q", got, ThemeSystem)
	}
}

func TestServiceSetThemeReportsSaveFailureCode(t *testing.T) {
	store := &fakeThemeStore{saveErr: errors.New("read-only file system")}
	var applied []string
	service := newThemeService(store, &applied)
	err := service.SetTheme(ThemeLight)
	if err == nil {
		t.Fatal("a failed save was reported as success")
	}
	if !hasCode(err, CodeThemeSaveFailed) {
		t.Fatalf("error = %v; want code %s", err, CodeThemeSaveFailed)
	}
	// The raw disk error carries a home-directory path; the sidebar renders the
	// message verbatim, so only the coded line may cross the bridge.
	if strings.Contains(err.Error(), "read-only") {
		t.Fatalf("error echoes the disk failure: %v", err)
	}
}
