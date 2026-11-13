package hostexec

import "testing"

func TestQuotePath(t *testing.T) {
	cases := map[string]string{
		"~/deskwand": `"$HOME"/'deskwand'`,
		"/srv/bot":   `'/srv/bot'`,
		"~":          `'~'`,
	}
	for path, want := range cases {
		if got := QuotePath(path); got != want {
			t.Errorf("QuotePath(%q) = %s, want %s", path, got, want)
		}
	}
}

func TestQuotePathKeepsSpaces(t *testing.T) {
	if got, want := QuotePath("~/Library/Application Support/x"), `"$HOME"/'Library/Application Support/x'`; got != want {
		t.Errorf("QuotePath() = %s, want %s", got, want)
	}
}
