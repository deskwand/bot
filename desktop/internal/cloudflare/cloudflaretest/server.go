// Package cloudflaretest provides a real cloudflare.Client pointed at a
// loopback httptest server. It is intended for tests in sibling packages that
// need to exercise the production HTTP path without network access.
package cloudflaretest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
)

// TestToken is the bearer token used by clients returned from NewServerClient.
const TestToken = "cfut_cloudflaretest-sentinel-token-0123456789"

// NewServerClient starts an httptest server and returns a Cloudflare client
// whose API base is srv.URL/client/v4. The server is closed when the test ends.
func NewServerClient(t *testing.T, handler http.Handler) (*cloudflare.Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := cloudflare.NewForTesting(server.URL+"/client/v4", cloudflare.Options{
		Token: func(context.Context) (string, error) { return TestToken, nil },
	})
	return client, server
}
