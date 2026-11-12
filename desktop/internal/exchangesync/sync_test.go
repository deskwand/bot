package exchangesync

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	testKey       = "test-binance-key"
	testSecret    = "test-binance-secret"
	testTimestamp = int64(1700000000000)
)

func testFetcher(client *http.Client, hosts map[string]string) Fetcher {
	return Fetcher{
		HTTP:  client,
		Hosts: hosts,
		Now:   func() time.Time { return time.UnixMilli(testTimestamp) },
	}
}

func TestEndpointsMatchContract(t *testing.T) {
	contract, err := os.ReadFile("../../../contracts/exchange-binance-endpoints.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(contract) != string(embeddedEndpoints) {
		t.Fatal("endpoints.json differs from contracts/exchange-binance-endpoints.json")
	}
}

func TestSignMatchesTheWorkerVector(t *testing.T) {
	query := "timestamp=1700000000000&recvWindow=5000&omitZeroBalances=true"
	const want = "fff769b435ccbb9ec8bdae742a4d817bb94b861bb257e97f5f070b1c896efcce"
	if got := Sign(testSecret, query); got != want {
		t.Fatalf("Sign() = %q, want %q", got, want)
	}
}

// signTestServer records every request and answers with a body the adapter
// would accept: arrays for the ticker and position endpoints, objects for the
// rest.
func signTestServer(t *testing.T, seen *[]*http.Request) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clone := r.Clone(context.Background())
		*seen = append(*seen, clone)
		switch r.URL.Path {
		case "/api/v3/ticker/price", "/fapi/v3/positionRisk":
			_, _ = w.Write([]byte("[]"))
		default:
			_, _ = w.Write([]byte("{}"))
		}
	}))
}

func TestFetchSignsEveryRequestInOrder(t *testing.T) {
	var seen []*http.Request
	server := signTestServer(t, &seen)
	defer server.Close()

	fetcher := testFetcher(nil, map[string]string{
		"api": server.URL, "fapi": server.URL, "dapi": server.URL,
	})
	bundle, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret})
	if err != nil {
		t.Fatalf("Fetch() = %v", err)
	}
	if bundle.FetchedAt != testTimestamp {
		t.Fatalf("FetchedAt = %d, want %d", bundle.FetchedAt, testTimestamp)
	}

	endpoints := Endpoints()
	if len(seen) != len(endpoints) {
		t.Fatalf("sent %d requests, want %d", len(seen), len(endpoints))
	}
	for index, endpoint := range endpoints {
		request := seen[index]
		if request.Method != endpoint.Method {
			t.Fatalf("%s: method = %s, want %s", endpoint.Path, request.Method, endpoint.Method)
		}
		if request.URL.Path != endpoint.Path {
			t.Fatalf("path = %s, want %s", request.URL.Path, endpoint.Path)
		}
		if !endpoint.signed() {
			if request.URL.RawQuery != "" {
				t.Fatalf("%s: query = %q, want none", endpoint.Path, request.URL.RawQuery)
			}
			if got := request.Header.Get("X-MBX-APIKEY"); got != "" {
				t.Fatalf("%s: X-MBX-APIKEY = %q, want none", endpoint.Path, got)
			}
			continue
		}
		if got := request.Header.Get("X-MBX-APIKEY"); got != testKey {
			t.Fatalf("%s: X-MBX-APIKEY = %q", endpoint.Path, got)
		}
		wantQuery := wantSignedQuery(t, testTimestamp, endpoint.Params)
		wantQuery += "&signature=" + Sign(testSecret, wantQuery)
		if request.URL.RawQuery != wantQuery {
			t.Fatalf("%s: query = %q, want %q", endpoint.Path, request.URL.RawQuery, wantQuery)
		}
	}
}

// A public endpoint rejects the signed parameters with -1104, so the bundle
// would carry a 400 where the adapter expects a price list.
func TestFetchLeavesPublicEndpointsUnsigned(t *testing.T) {
	var seen []*http.Request
	server := signTestServer(t, &seen)
	defer server.Close()

	fetcher := testFetcher(nil, map[string]string{
		"api": server.URL, "fapi": server.URL, "dapi": server.URL,
	})
	if _, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret}); err != nil {
		t.Fatalf("Fetch() = %v", err)
	}

	for _, request := range seen {
		if request.URL.Path != "/api/v3/ticker/price" {
			continue
		}
		if request.URL.RawQuery != "" {
			t.Fatalf("ticker query = %q, want none", request.URL.RawQuery)
		}
		if got := request.Header.Get("X-MBX-APIKEY"); got != "" {
			t.Fatalf("ticker X-MBX-APIKEY = %q, want none", got)
		}
		return
	}
	t.Fatal("/api/v3/ticker/price was not requested")
}

func wantSignedQuery(t *testing.T, timestamp int64, params map[string]string) string {
	t.Helper()
	query := "timestamp=" + strconv.FormatInt(timestamp, 10) + "&recvWindow=5000"
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		query += "&" + key + "=" + params[key]
	}
	return query
}

func TestFetchRoutesFuturesHosts(t *testing.T) {
	var apiHits, fapiHits, dapiHits []string
	newServer := func(store *[]string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*store = append(*store, r.URL.Path)
			_, _ = w.Write([]byte("{}"))
		}))
	}
	api := newServer(&apiHits)
	defer api.Close()
	fapi := newServer(&fapiHits)
	defer fapi.Close()
	dapi := newServer(&dapiHits)
	defer dapi.Close()

	fetcher := testFetcher(nil, map[string]string{
		"api": api.URL, "fapi": fapi.URL, "dapi": dapi.URL,
	})
	if _, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret}); err != nil {
		t.Fatalf("Fetch() = %v", err)
	}

	for _, path := range apiHits {
		if strings.HasPrefix(path, "/fapi/") || strings.HasPrefix(path, "/dapi/") {
			t.Fatalf("api host received %s", path)
		}
	}
	for _, path := range fapiHits {
		if !strings.HasPrefix(path, "/fapi/") {
			t.Fatalf("fapi host received %s", path)
		}
	}
	for _, path := range dapiHits {
		if !strings.HasPrefix(path, "/dapi/") {
			t.Fatalf("dapi host received %s", path)
		}
	}
	if len(fapiHits) == 0 || len(dapiHits) == 0 {
		t.Fatalf("futures hosts were not used: fapi=%v dapi=%v", fapiHits, dapiHits)
	}
}

type countingTransport struct {
	calls int
}

func (c *countingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	c.calls++
	return nil, errors.New("connection refused")
}

func TestFetchStopsOnAPrimaryTransportError(t *testing.T) {
	transport := &countingTransport{}
	fetcher := testFetcher(&http.Client{Transport: transport}, nil)
	bundle, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret})

	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != "EXCHANGE_NETWORK" {
		t.Fatalf("Fetch() error = %v, want Failure EXCHANGE_NETWORK", err)
	}
	if len(bundle.Responses) != 0 {
		t.Fatalf("Fetch() returned %d responses, want none", len(bundle.Responses))
	}
	if transport.calls != 1 {
		t.Fatalf("sent %d requests, want 1", transport.calls)
	}
}

func TestFetchSendsOnlyThePrimaryOnNon2xx(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"region", http.StatusUnavailableForLegalReasons, `{"code":-2015,"msg":"restricted"}`},
		{"unauthorized", http.StatusUnauthorized, `{"code":-2015,"msg":"bad key"}`},
		{"refused", http.StatusBadRequest, `{"code":-2015,"msg":"bad key"}`},
		{"rate limited", http.StatusTooManyRequests, `{"code":-1003,"msg":"too many"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(testCase.status)
				_, _ = w.Write([]byte(testCase.body))
			}))
			defer server.Close()

			fetcher := testFetcher(nil, map[string]string{
				"api": server.URL, "fapi": server.URL, "dapi": server.URL,
			})
			bundle, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret})
			if err != nil {
				t.Fatalf("Fetch() = %v, want nil", err)
			}
			if calls != 1 {
				t.Fatalf("server saw %d requests, want 1", calls)
			}
			if len(bundle.Responses) != 1 {
				t.Fatalf("bundle has %d responses, want 1", len(bundle.Responses))
			}
			response := bundle.Responses[0]
			if response.Path != "/api/v3/account" || response.Method != "GET" {
				t.Fatalf("primary response = %+v", response)
			}
			if response.Status != testCase.status {
				t.Fatalf("status = %d, want %d", response.Status, testCase.status)
			}
			if response.Body != testCase.body {
				t.Fatalf("body = %q, want %q", response.Body, testCase.body)
			}
		})
	}
}

func TestFetchRefusesAnOversizedBundle(t *testing.T) {
	// 700KB of quotes per body is only 1.4MB raw, but every quote is escaped
	// on the wire, so the encoded payload is about 2.8MB.
	big := strings.Repeat(`"`, 700*1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sapi/v1/margin/account", "/sapi/v1/margin/isolated/account":
			_, _ = w.Write([]byte(big))
		default:
			_, _ = w.Write([]byte("{}"))
		}
	}))
	defer server.Close()

	fetcher := testFetcher(nil, map[string]string{
		"api": server.URL, "fapi": server.URL, "dapi": server.URL,
	})
	_, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret})

	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != "EXCHANGE_SYNC_TOO_LARGE" {
		t.Fatalf("Fetch() error = %v, want Failure EXCHANGE_SYNC_TOO_LARGE", err)
	}
}

func TestFetchRecordsSubEndpointFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/account":
			_, _ = w.Write([]byte("{}"))
		case "/sapi/v1/margin/account":
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("response writer cannot hijack")
				return
			}
			connection, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			_ = connection.Close()
		case "/fapi/v3/account":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":-1}`))
		default:
			_, _ = w.Write([]byte("{}"))
		}
	}))
	defer server.Close()

	fetcher := testFetcher(nil, map[string]string{
		"api": server.URL, "fapi": server.URL, "dapi": server.URL,
	})
	bundle, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret})
	if err != nil {
		t.Fatalf("Fetch() = %v", err)
	}

	byPath := map[string]Response{}
	for _, response := range bundle.Responses {
		byPath[response.Path] = response
	}
	broken := byPath["/sapi/v1/margin/account"]
	if broken.Status != 0 || broken.Body != "" {
		t.Fatalf("broken sub endpoint = %+v, want status 0 and empty body", broken)
	}
	refused := byPath["/fapi/v3/account"]
	if refused.Status != http.StatusBadRequest || refused.Body != `{"code":-1}` {
		t.Fatalf("refused sub endpoint = %+v", refused)
	}
}

func TestFetchTruncatesOversizedBodies(t *testing.T) {
	oversized := strings.Repeat("a", (1<<20)+1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/dapi/v1/account" {
			_, _ = w.Write([]byte(oversized))
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	fetcher := testFetcher(nil, map[string]string{
		"api": server.URL, "fapi": server.URL, "dapi": server.URL,
	})
	bundle, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret})
	if err != nil {
		t.Fatalf("Fetch() = %v", err)
	}

	for _, response := range bundle.Responses {
		if response.Path == "/dapi/v1/account" {
			if response.Status != 0 || response.Body != "" {
				t.Fatalf("oversized response = %+v, want status 0 and empty body", response)
			}
			return
		}
	}
	t.Fatal("dapi response missing from bundle")
}

func TestCredentialsNeverPrint(t *testing.T) {
	credentials := Credentials{Key: "KEY-SHOULD-NOT-PRINT", Secret: "SECRET-SHOULD-NOT-PRINT"}
	for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
		text := fmt.Sprintf(format, credentials)
		if strings.Contains(text, credentials.Key) || strings.Contains(text, credentials.Secret) {
			t.Fatalf("%s printed the credentials: %s", format, text)
		}
		if !strings.Contains(text, "<redacted>") {
			t.Fatalf("%s = %q, want <redacted>", format, text)
		}
	}
}

func TestFetchSignsEachRequestWithItsOwnTimestamp(t *testing.T) {
	var seen []*http.Request
	server := signTestServer(t, &seen)
	defer server.Close()

	tick := testTimestamp
	fetcher := Fetcher{
		Hosts: map[string]string{"api": server.URL, "fapi": server.URL, "dapi": server.URL},
		Now: func() time.Time {
			current := tick
			tick += 3000
			return time.UnixMilli(current)
		},
	}
	bundle, err := fetcher.Fetch(context.Background(), Credentials{Key: testKey, Secret: testSecret})
	if err != nil {
		t.Fatalf("Fetch() = %v", err)
	}
	if bundle.FetchedAt != testTimestamp {
		t.Fatalf("FetchedAt = %d, want %d", bundle.FetchedAt, testTimestamp)
	}
	last := seen[len(seen)-1].URL.Query().Get("timestamp")
	if last == seen[0].URL.Query().Get("timestamp") {
		t.Fatalf("every request reused timestamp %s; later ones would fall outside recvWindow", last)
	}
	for _, request := range seen {
		query := request.URL.RawQuery
		cut := strings.LastIndex(query, "&signature=")
		if cut < 0 {
			continue // a public endpoint carries no signature to check
		}
		if Sign(testSecret, query[:cut]) != query[cut+len("&signature="):] {
			t.Fatalf("bad signature for %s", request.URL.Path)
		}
	}
}
