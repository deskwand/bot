// Package navigation contains the URL allowlists for the desktop window. The
// privileged WebView may only stay on the bundled frontend; external http(s)
// links open in the system browser instead.
package navigation

import (
	"net/url"
	"strings"
)

// DevOrigin is the Vite dev server origin declared by desktop/mygo.json. It is
// allowed only in development builds.
const DevOrigin = "http://localhost:5173"

const devPort = "5173"

// IsBundledFrontendURL reports whether the window may navigate to rawURL
// itself. Production allows only the bundled frontend origins; development
// also allows the dev server origin.
func IsBundledFrontendURL(rawURL string, dev bool) bool {
	if rawURL == "" {
		return true
	}
	if strings.ContainsAny(rawURL, "\x00\r\n") {
		return false
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.User != nil {
		return false
	}
	switch parsed.Scheme {
	case "":
		return true
	case "about":
		return rawURL == "about:blank"
	case "mygo":
		return parsed.Hostname() == "localhost" && parsed.Port() == ""
	case "http":
		host := strings.ToLower(parsed.Hostname())
		switch host {
		case "mygo.localhost":
			return parsed.Port() == ""
		case "localhost", "127.0.0.1":
			return dev && parsed.Port() == devPort
		default:
			return false
		}
	default:
		return false
	}
}

// IsExternalHTTPURL reports whether rawURL is a normal http(s) URL that the
// system browser may open. It never allows credentials in the URL.
func IsExternalHTTPURL(rawURL string) bool {
	if rawURL == "" || strings.ContainsAny(rawURL, "\x00\r\n") {
		return false
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.User != nil || parsed.Host == "" {
		return false
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}
