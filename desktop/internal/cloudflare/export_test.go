package cloudflare

import (
	"context"
	"net/http"
	"time"
)

// NewTestClient lets tests point the client at an httptest server and inject
// a deterministic sleep. It is compiled only for tests.
func NewTestClient(opts Options, origin string, httpClient *http.Client, sleep func(context.Context, time.Duration) error) *Client {
	if sleep == nil {
		sleep = defaultSleep
	}
	return newClient(opts, origin, httpClient, sleep)
}
