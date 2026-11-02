package cloudflare

import (
	"net/url"
	"strings"
)

// NewForTesting is a test-only constructor. It returns a client pointed at a
// loopback test server so internal test helpers can exercise the real
// production request path; callers must not use it with a remote or
// user-controlled origin. The caller supplies the /client/v4 suffix so paths
// and redirect rules match production.
//
// NewForTesting panics unless the base URL's host is 127.0.0.1 or localhost.
func NewForTesting(baseURL string, opts Options) *Client {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		panic("cloudflare: NewForTesting requires a valid base URL")
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "127.0.0.1" && host != "localhost" {
		panic("cloudflare: NewForTesting only allows a loopback base URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		panic("cloudflare: NewForTesting requires an http or https base URL")
	}
	return newClient(opts, baseURL, nil, defaultSleep)
}
