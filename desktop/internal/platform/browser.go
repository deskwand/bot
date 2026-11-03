package platform

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/egoist/mygo"
)

// BrowserOpener opens a URL in the user's default browser.
type BrowserOpener interface {
	Open(url string) error
}

// allowedBrowserPrefixes are the only destinations the client may open. The
// single caller is the OAuth authorize URL, so the allowlist is exactly that
// endpoint: a caller cannot turn this into an arbitrary-URL opener.
var allowedBrowserPrefixes = []string{
	"https://dash.cloudflare.com/oauth2/auth",
}

type systemBrowserOpener struct {
	open func(string) error
}

// NewSystemBrowserOpener returns a BrowserOpener backed by MyGo's external
// browser support, restricted to Cloudflare's OAuth authorize endpoint.
func NewSystemBrowserOpener() BrowserOpener {
	return newBrowserOpener(mygo.Shell.OpenExternal)
}

func newBrowserOpener(open func(string) error) BrowserOpener {
	return systemBrowserOpener{open: open}
}

func (o systemBrowserOpener) Open(rawURL string) error {
	if !allowedBrowserURL(rawURL) {
		return fmt.Errorf("platform: refusing to open disallowed browser URL %q", rawURL)
	}
	return o.open(rawURL)
}

func allowedBrowserURL(rawURL string) bool {
	if rawURL == "" || strings.ContainsAny(rawURL, "\x00\r\n") {
		return false
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Host == "" {
		return false
	}
	for _, prefix := range allowedBrowserPrefixes {
		if strings.HasPrefix(rawURL, prefix) {
			return true
		}
	}
	return false
}

// NewMcpOAuthBrowserOpener returns a BrowserOpener for an MCP provider's
// consent page. Provider consent URLs vary, so any https origin is accepted,
// but only for a URL returned by the authenticated admin route.
func NewMcpOAuthBrowserOpener() BrowserOpener {
	return newConsentBrowserOpener(mygo.Shell.OpenExternal)
}

type consentBrowserOpener struct {
	open func(string) error
}

func newConsentBrowserOpener(open func(string) error) BrowserOpener {
	return consentBrowserOpener{open: open}
}

func (o consentBrowserOpener) Open(rawURL string) error {
	if !allowedConsentURL(rawURL) {
		return fmt.Errorf("platform: refusing to open disallowed consent URL %q", rawURL)
	}
	return o.open(rawURL)
}

func allowedConsentURL(rawURL string) bool {
	if rawURL == "" || strings.ContainsAny(rawURL, "\x00\r\n") {
		return false
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return parsed.Scheme == "https" && parsed.User == nil && parsed.Host != ""
}
