package platform

import "testing"

func TestNeedsWebViewRuntimePrompt(t *testing.T) {
	cases := []struct {
		name      string
		goos      string
		available bool
		want      bool
	}{
		{"windows with runtime", "windows", true, false},
		{"windows without runtime", "windows", false, true},
		{"darwin without runtime", "darwin", false, false},
		{"linux with runtime", "linux", true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := NeedsWebViewRuntimePrompt(c.goos, c.available); got != c.want {
				t.Fatalf("NeedsWebViewRuntimePrompt(%q, %v) = %v, want %v", c.goos, c.available, got, c.want)
			}
		})
	}
}

func TestAvailableUsesTheProbe(t *testing.T) {
	original := webViewAvailable
	t.Cleanup(func() { webViewAvailable = original })

	webViewAvailable = func() bool { return false }
	if Available() {
		t.Error("Available() = true with a probe that reports no webview")
	}

	webViewAvailable = func() bool { return true }
	if !Available() {
		t.Error("Available() = false with a probe that reports a webview")
	}
}
