package platform

import "testing"

func TestBrowserURLAllowlist(t *testing.T) {
	allowed := []string{
		"https://dash.cloudflare.com/",
		"https://dash.cloudflare.com/profile/api-tokens",
		"https://developers.cloudflare.com/fundamentals/api/reference/permissions/",
	}
	for _, raw := range allowed {
		if !allowedBrowserURL(raw) {
			t.Errorf("allowedBrowserURL(%q) = false, want true", raw)
		}
	}

	rejected := []string{
		"",
		"http://dash.cloudflare.com/",
		"https://dash.cloudflare.com",
		"https://dash.cloudflare.com.evil.example/",
		"https://evil.example/dash.cloudflare.com/",
		"https://developers.cloudflare.com.evil.example/",
		"https://user:pass@dash.cloudflare.com/",
		"https://dash.cloudflare.com:8443/",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"https://dash.cloudflare.com/\x00",
	}
	for _, raw := range rejected {
		if allowedBrowserURL(raw) {
			t.Errorf("allowedBrowserURL(%q) = true, want false", raw)
		}
	}
}

func TestBrowserOpenerRejectsDisallowedURLBeforeOpening(t *testing.T) {
	calls := 0
	opener := newBrowserOpener(func(string) error {
		calls++
		return nil
	})
	if err := opener.Open("https://evil.example/"); err == nil {
		t.Fatal("disallowed URL was opened")
	}
	if calls != 0 {
		t.Fatalf("open called %d times for disallowed URL", calls)
	}
	if err := opener.Open("https://dash.cloudflare.com/profile/api-tokens"); err != nil {
		t.Fatalf("allowed URL: %v", err)
	}
	if calls != 1 {
		t.Fatalf("open called %d times, want 1", calls)
	}
}
