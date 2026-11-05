package app

import (
	"errors"
	"testing"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// fakeLocaleStore is the persisted language as LocaleState sees it. saveErr
// makes the disk refuse writes, as a read-only home directory would.
type fakeLocaleStore struct {
	source  string
	saveErr error
}

func (f *fakeLocaleStore) Locale() (string, error) {
	if f.source == "" {
		return i18n.System, nil
	}
	return f.source, nil
}

func (f *fakeLocaleStore) SetLocale(source string) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.source = source
	return nil
}

func systemLanguage(tag string) func() (string, error) {
	return func() (string, error) { return tag, nil }
}

func TestLocaleStateResolvesSystem(t *testing.T) {
	state := NewLocaleState(&fakeLocaleStore{source: i18n.System}, systemLanguage("zh-Hans"))
	want := LocaleDTO{Source: i18n.System, Resolved: i18n.ZH}
	if got := state.Get(); got != want {
		t.Fatalf("Get() = %#v; want %#v", got, want)
	}
}

func TestServiceSetLocale(t *testing.T) {
	service := NewService(ServiceOptions{
		Locale: NewLocaleState(&fakeLocaleStore{source: i18n.System}, systemLanguage("en-US")),
	})
	got, err := service.SetLocale(i18n.EN)
	if err != nil {
		t.Fatal(err)
	}
	want := LocaleDTO{Source: i18n.EN, Resolved: i18n.EN}
	if got != want {
		t.Fatalf("SetLocale() = %#v; want %#v", got, want)
	}
	if resolved := service.Locale().Resolved; resolved != i18n.EN {
		t.Fatalf("Locale().Resolved = %q; want %q", resolved, i18n.EN)
	}
}

func TestServiceSetLocaleSaveFailure(t *testing.T) {
	state := NewLocaleState(
		&fakeLocaleStore{saveErr: errors.New("read-only file system")},
		systemLanguage("zh-CN"),
	)
	service := NewService(ServiceOptions{Locale: state})
	got, err := service.SetLocale(i18n.EN)
	if err == nil {
		t.Fatal("a failed save was reported as success")
	}
	if !hasCode(err, CodeLocaleSaveFailed) {
		t.Fatalf("error = %v; want code %s", err, CodeLocaleSaveFailed)
	}
	want := LocaleDTO{Source: i18n.EN, Resolved: i18n.EN}
	if got != want {
		t.Fatalf("SetLocale() = %#v; want %#v", got, want)
	}
	if current := state.Current(); current != i18n.EN {
		t.Fatalf("Current() = %q; want %q", current, i18n.EN)
	}
}

func TestServiceSetLocaleInvalid(t *testing.T) {
	state := NewLocaleState(&fakeLocaleStore{source: i18n.ZH}, systemLanguage("en-US"))
	service := NewService(ServiceOptions{Locale: state})
	if _, err := service.SetLocale("fr"); !hasCode(err, deployment.CodeInvalidRequest) {
		t.Fatalf("error = %v; want code %s", err, deployment.CodeInvalidRequest)
	}
	want := LocaleDTO{Source: i18n.ZH, Resolved: i18n.ZH}
	if got := service.Locale(); got != want {
		t.Fatalf("Locale() = %#v; want %#v", got, want)
	}
}
