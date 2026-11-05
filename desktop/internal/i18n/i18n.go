package i18n

import (
	"fmt"
	"strings"
)

// The stored language sources. Only zh and en reach Resolve's output; system
// follows the operating system's preferred language.
const (
	ZH     = "zh"
	EN     = "en"
	System = "system"
)

// Normalize returns the stored form of a language source, or ok=false when
// source is not one of the three.
func Normalize(source string) (string, bool) {
	switch source {
	case System, ZH, EN:
		return source, true
	}
	return "", false
}

// Resolve turns a stored source into zh or en. A missing or unknown source
// follows the system, and a failed system lookup falls back to en.
func Resolve(source string, systemLanguage func() (string, error)) string {
	if source == ZH || source == EN {
		return source
	}
	tag, err := systemLanguage()
	if err != nil {
		return EN
	}
	if strings.HasPrefix(strings.ToLower(tag), "zh") {
		return ZH
	}
	return EN
}

// T returns the localized text for key. It uses the locale table, then the
// Chinese table, then the key itself, and formats the result when args are
// given.
func T(locale, key string, args ...any) string {
	format, ok := table(locale)[key]
	if !ok {
		format, ok = zh[key]
	}
	if !ok {
		format = key
	}
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

func table(locale string) map[string]string {
	if locale == EN {
		return en
	}
	return zh
}
