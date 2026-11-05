package app

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// LocaleStore is the persisted language choice. Locale always returns one of
// the three sources, whatever the file holds.
type LocaleStore interface {
	Locale() (string, error)
	SetLocale(source string) error
}

// Locale returns the stored source, or i18n.System when the file is missing
// and also when it cannot be decoded or holds an unknown value.
func (s *FileThemeStore) Locale() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readPreferences()
	if err != nil {
		return i18n.System, fmt.Errorf("app: read preferences: %w", err)
	}
	if source, ok := i18n.Normalize(file.Locale); ok {
		return source, nil
	}
	return i18n.System, nil
}

// SetLocale writes the source atomically with owner-only permissions, keeping
// the appearance. A source this client does not know is rejected before
// anything is written.
func (s *FileThemeStore) SetLocale(source string) error {
	normalized, ok := i18n.Normalize(source)
	if !ok {
		return domain.Error{Code: deployment.CodeInvalidRequest, Message: i18n.T(i18n.System, "locale.invalid")}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, _ := s.readPreferences()
	file.Locale = normalized
	return s.writePreferences(file)
}

// LocaleState is the language choice in memory: the stored source and the
// zh/en locale it resolves to. Service exposes it to the frontend; the type
// itself is not bound.
type LocaleState struct {
	mu       sync.RWMutex
	store    LocaleStore
	system   func() (string, error)
	source   string
	resolved string
}

// NewLocaleState reads the store once and resolves it. A nil store keeps the
// choice in memory for this run; a nil system lookup uses the operating
// system's preferred language.
func NewLocaleState(store LocaleStore, system func() (string, error)) *LocaleState {
	if system == nil {
		system = i18n.SystemLanguage
	}
	source := i18n.System
	if store != nil {
		if stored, err := store.Locale(); err == nil {
			if normalized, ok := i18n.Normalize(stored); ok {
				source = normalized
			}
		}
	}
	return &LocaleState{
		store:    store,
		system:   system,
		source:   source,
		resolved: i18n.Resolve(source, system),
	}
}

// Current returns the resolved locale, zh or en. It never fails: a broken
// preference follows the system.
func (l *LocaleState) Current() string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.resolved
}

// Get returns the stored source and the locale it resolves to.
func (l *LocaleState) Get() LocaleDTO {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return LocaleDTO{Source: l.source, Resolved: l.resolved}
}

// Set switches the language. The memory changes before the disk is written,
// so a failed save still applies to this run; the returned DTO is the new
// state and the error only reports that the choice will not survive a restart.
func (l *LocaleState) Set(source string) (LocaleDTO, error) {
	normalized, ok := i18n.Normalize(source)
	if !ok {
		return l.Get(), domain.Error{Code: deployment.CodeInvalidRequest, Message: i18n.T(l.Current(), "locale.invalid")}
	}
	resolved := i18n.Resolve(normalized, l.system)
	l.mu.Lock()
	l.source = normalized
	l.resolved = resolved
	l.mu.Unlock()
	result := LocaleDTO{Source: normalized, Resolved: resolved}
	if l.store != nil {
		if err := l.store.SetLocale(normalized); err != nil {
			slog.Error("app: save language", "error", err)
			return result, domain.Error{Code: CodeLocaleSaveFailed, Message: i18n.T(resolved, "locale.saveFailed")}
		}
	}
	return result, nil
}
