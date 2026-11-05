// Package i18ntest provides assertions for localized text in tests.
package i18ntest

import (
	"regexp"
	"testing"
)

var han = regexp.MustCompile(`\p{Han}`)

// NoHan fails the test when text contains a Han character.
func NoHan(t testing.TB, label, text string) {
	t.Helper()
	if han.MatchString(text) {
		t.Errorf("%s contains Chinese: %q", label, text)
	}
}
