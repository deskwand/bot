package cloudflare

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

// releaseUploadBytes is the measured size of a real version upload: index.js
// 9,720,242 + photon wasm 1,880,773 + quickjs wasm 637,405 bytes. Cloudflare's
// version endpoint receives the bundle uncompressed.
const releaseUploadBytes = 12_238_420

// measuredSlowUplinkBytesPerSecond is the slowest sustained uplink observed on
// a real client that still carried traffic: 12.2 MB needs about 322s there,
// which a flat 60s budget can never cover.
const measuredSlowUplinkBytesPerSecond = 38_000

// TestRequestBudgetCoversASlowReleaseUpload pins the timeout policy: a request
// may take at least as long as pushing one release bundle over the slowest
// uplink we have measured, while requests without a body keep the short budget.
func TestRequestBudgetCoversASlowReleaseUpload(t *testing.T) {
	client := New(Options{})

	if got := client.requestBudgetFor(0); got != requestTimeout {
		t.Fatalf("budget without a body = %v, want %v", got, requestTimeout)
	}
	if got := client.requestBudgetFor(4096); got > requestTimeout+2*time.Second {
		t.Fatalf("budget for a 4 KB body = %v, want no meaningful inflation over %v", got, requestTimeout)
	}

	need := time.Duration(releaseUploadBytes/measuredSlowUplinkBytesPerSecond) * time.Second
	if got := client.requestBudgetFor(releaseUploadBytes); got < need {
		t.Fatalf("budget for %d bytes = %v, want at least %v (a release needs that long at %d B/s)",
			releaseUploadBytes, got, need, measuredSlowUplinkBytesPerSecond)
	}
}

// TestSendMultipartQueryOutlivesASlowUpload reproduces the reported failure
// shape without a slow network: the server drains the body at roughly 200 KB/s
// so the upload needs about 2.6s, while the base budget is only 200ms.
func TestSendMultipartQueryOutlivesASlowUpload(t *testing.T) {
	const bodyBytes = 512 * 1024
	const readChunk = 16 * 1024
	const readPause = 80 * time.Millisecond // ~200 KB/s

	var received int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buffer := make([]byte, readChunk)
		for {
			n, err := r.Body.Read(buffer)
			if n > 0 {
				atomic.AddInt64(&received, int64(n))
				time.Sleep(readPause)
			}
			if err != nil {
				break
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"success":true,"errors":[],"result":{"id":"550e8400-e29b-41d4-a716-446655440000"}}`)
	}))
	defer srv.Close()

	client := testClient(t, srv, nil)
	client.baseTimeout = 200 * time.Millisecond

	var result struct {
		ID string `json:"id"`
	}
	err := client.SendMultipartQuery(
		context.Background(),
		http.MethodPost,
		"/accounts/abc/workers/scripts/bot/versions",
		url.Values{"bindings_inherit": {"strict"}},
		[]Part{{Name: "metadata", ContentType: "application/json", Data: make([]byte, bodyBytes)}},
		&result,
	)
	if err != nil {
		t.Fatalf("slow upload failed: %v", err)
	}
	if result.ID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("result id = %q", result.ID)
	}
	if got := atomic.LoadInt64(&received); got < bodyBytes {
		t.Fatalf("server received %d of %d bytes", got, bodyBytes)
	}
}

// TestClientHasNoBlanketRequestTimeout guards the regression directly: an
// http.Client.Timeout covers the whole exchange, including writing a 12 MB
// body, and is what turned a slow uplink into "context deadline exceeded".
func TestClientHasNoBlanketRequestTimeout(t *testing.T) {
	client := New(Options{Token: func(context.Context) (string, error) { return testToken, nil }})
	if client.http.Timeout != 0 {
		t.Fatalf("http.Client.Timeout = %v, want 0 (deadlines are per request)", client.http.Timeout)
	}
}
