package navigation

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestIsBundledFrontendURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		dev  bool
		want bool
	}{
		{name: "empty", url: "", dev: false, want: true},
		{name: "relative", url: "/settings?tab=entries", dev: false, want: true},
		{name: "about blank", url: "about:blank", dev: false, want: true},
		{name: "about srcdoc", url: "about:srcdoc", dev: false, want: false},
		{name: "file", url: "file:///etc/passwd", dev: false, want: false},
		{name: "javascript", url: "javascript:alert(1)", dev: false, want: false},
		{name: "mygo localhost", url: "mygo://localhost/", dev: false, want: true},
		{name: "mygo localhost path", url: "mygo://localhost/settings?x=1", dev: false, want: true},
		{name: "mygo other host", url: "mygo://evil.example/", dev: false, want: false},
		{name: "mygo with port", url: "mygo://localhost:1234/", dev: false, want: false},
		{name: "windows bundle", url: "http://mygo.localhost/", dev: false, want: true},
		{name: "windows bundle with port", url: "http://mygo.localhost:8080/", dev: false, want: false},
		{name: "https bundle", url: "https://mygo.localhost/", dev: false, want: false},
		{name: "dev vite localhost", url: "http://localhost:5173/", dev: true, want: true},
		{name: "dev vite loopback", url: "http://127.0.0.1:5173/src/main.tsx", dev: true, want: true},
		{name: "dev vite production build", url: "http://localhost:5173/", dev: false, want: false},
		{name: "dev loopback production build", url: "http://127.0.0.1:5173/", dev: false, want: false},
		{name: "localhost other port", url: "http://localhost:5174/", dev: true, want: false},
		{name: "localhost no port", url: "http://localhost/", dev: true, want: false},
		{name: "lookalike host", url: "http://localhost.evil.com/", dev: true, want: false},
		{name: "userinfo", url: "http://user@localhost:5173/", dev: true, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := IsBundledFrontendURL(test.url, test.dev); got != test.want {
				t.Fatalf("IsBundledFrontendURL(%q, %v) = %v, want %v", test.url, test.dev, got, test.want)
			}
		})
	}
}

func TestIsExternalHTTPURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{url: "https://example.com/docs", want: true},
		{url: "http://example.com/", want: true},
		{url: "http://localhost:5173/", want: true},
		{url: "mailto:user@example.com", want: false},
		{url: "javascript:alert(1)", want: false},
		{url: "file:///etc/passwd", want: false},
		{url: "data:text/html,hi", want: false},
		{url: "http://user@example.com/", want: false},
		{url: "http://example.com/\n", want: false},
		{url: "", want: false},
	}
	for _, test := range tests {
		if got := IsExternalHTTPURL(test.url); got != test.want {
			t.Fatalf("IsExternalHTTPURL(%q) = %v, want %v", test.url, got, test.want)
		}
	}
}

func TestDevOriginMatchesMyGoConfiguration(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "mygo.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		DevURL string `json:"devUrl"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	devURL, err := url.Parse(config.DevURL)
	if err != nil {
		t.Fatal(err)
	}
	origin := devURL.Scheme + "://" + devURL.Host
	if origin != DevOrigin {
		t.Fatalf("mygo.json devUrl origin = %q, navigation.DevOrigin = %q", origin, DevOrigin)
	}
	if port := devURL.Port(); port != devPort {
		t.Fatalf("mygo.json devUrl port = %q, want %q", port, devPort)
	}
}
