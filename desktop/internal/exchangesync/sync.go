// Package exchangesync signs and fetches the Binance endpoints the Worker's
// adapter reads. It runs on the user's machine so the requests leave from the
// local network address, then hands the raw responses to the Worker for
// replay. It never parses a Binance payload: error classification lives in
// TypeScript.
package exchangesync

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed endpoints.json
var embeddedEndpoints []byte

const (
	defaultAPIHost   = "https://api.binance.com"
	defaultFAPIHost  = "https://fapi.binance.com"
	defaultDAPIHost  = "https://dapi.binance.com"
	defaultTimeout   = 10 * time.Second
	maxBodySize      = 1 << 20
	maxBundleSize    = 1900 * 1024 // encoded responses; leaves room under the Worker's 2MB cap
	primaryPath      = "/api/v3/account"
	redactedValue    = "<redacted>"
	recvWindowMillis = 5000
)

// Endpoint is one request in the shared contract. Params are the non-signature
// parameters; timestamp, recvWindow and signature are added by the fetcher.
type Endpoint struct {
	Method string            `json:"method"`
	Path   string            `json:"path"`
	Params map[string]string `json:"params"`
}

// Response is one raw response, exactly as the Worker replays it.
type Response struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// Bundle is the push payload for one account. FetchedAt is Unix milliseconds
// taken before the primary request.
type Bundle struct {
	FetchedAt int64
	Responses []Response
}

// Credentials holds the account's API key and secret. Every formatting verb
// prints <redacted>, matching SecretEditDTO.
type Credentials struct {
	Key    string
	Secret string
}

func (c Credentials) safeString() string { return redactedValue }

func (c Credentials) String() string { return c.safeString() }

func (c Credentials) GoString() string { return c.safeString() }

// Format covers %v, %+v, %#v and %s alike.
func (c Credentials) Format(state fmt.State, _ rune) {
	fmt.Fprint(state, c.safeString())
}

func (c Credentials) LogValue() slog.Value {
	return slog.StringValue(c.safeString())
}

// Fetcher issues the requests. Zero values mean the Binance hosts, the default
// 10 second timeout and time.Now.
type Fetcher struct {
	HTTP  *http.Client
	Hosts map[string]string
	Now   func() time.Time
}

// Failure means nothing should be pushed. Code is EXCHANGE_NETWORK when the
// primary endpoint could not be reached at all and EXCHANGE_SYNC_TOO_LARGE
// when the encoded bundle would approach the Worker's 2MB cap.
type Failure struct {
	Code string
}

func (f *Failure) Error() string { return f.Code }

type contract struct {
	Endpoints []Endpoint `json:"endpoints"`
}

var parsedEndpoints = mustEndpoints()

func mustEndpoints() []Endpoint {
	var value contract
	if err := json.Unmarshal(embeddedEndpoints, &value); err != nil {
		panic("exchangesync: parse embedded endpoints: " + err.Error())
	}
	if len(value.Endpoints) == 0 || value.Endpoints[0].Path != primaryPath {
		panic("exchangesync: embedded endpoints must start with " + primaryPath)
	}
	return value.Endpoints
}

// Endpoints returns the shared contract in request order.
func Endpoints() []Endpoint {
	out := make([]Endpoint, 0, len(parsedEndpoints))
	for _, endpoint := range parsedEndpoints {
		params := make(map[string]string, len(endpoint.Params))
		for key, value := range endpoint.Params {
			params[key] = value
		}
		out = append(out, Endpoint{Method: endpoint.Method, Path: endpoint.Path, Params: params})
	}
	return out
}

// Sign returns the HMAC-SHA256 of query as lowercase hex, the way Binance
// expects it.
func Sign(secret, query string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(query))
	return hex.EncodeToString(mac.Sum(nil))
}

// Fetch signs and sends every endpoint in contract order. A primary endpoint
// that answers with any HTTP status is pushed as a one-response bundle so the
// Worker can classify it; only a transport failure (or an oversized primary
// body) stops the push.
func (f Fetcher) Fetch(ctx context.Context, creds Credentials) (Bundle, error) {
	client := f.HTTP
	if client == nil {
		client = &http.Client{Timeout: defaultTimeout}
	}
	now := f.Now
	if now == nil {
		now = time.Now
	}

	fetchedAt := now().UnixMilli()
	endpoints := Endpoints()
	bundle := Bundle{FetchedAt: fetchedAt, Responses: make([]Response, 0, len(endpoints))}

	for index, endpoint := range endpoints {
		primary := index == 0
		// Each request carries its own timestamp: Binance rejects one older than
		// recvWindow, and ten sequential requests can take longer than that.
		status, body, err := f.send(ctx, client, creds, endpoint, now().UnixMilli())
		if err != nil || len(body) > maxBodySize {
			if primary {
				return Bundle{}, &Failure{Code: "EXCHANGE_NETWORK"}
			}
			bundle.Responses = append(bundle.Responses, Response{
				Method: endpoint.Method,
				Path:   endpoint.Path,
				Status: 0,
			})
			continue
		}
		bundle.Responses = append(bundle.Responses, Response{
			Method: endpoint.Method,
			Path:   endpoint.Path,
			Status: status,
			Body:   string(body),
		})
		if primary && (status < 200 || status > 299) {
			return bundle, nil
		}
	}

	// Measure what goes on the wire: JSON escaping can make the pushed payload
	// much larger than the raw bodies, and the Worker caps the encoded size.
	encoded, err := json.Marshal(bundle.Responses)
	if err != nil || len(encoded) > maxBundleSize {
		return Bundle{}, &Failure{Code: "EXCHANGE_SYNC_TOO_LARGE"}
	}
	return bundle, nil
}

func (f Fetcher) send(
	ctx context.Context,
	client *http.Client,
	creds Credentials,
	endpoint Endpoint,
	timestamp int64,
) (int, []byte, error) {
	query := signedQuery(timestamp, endpoint.Params, creds.Secret)
	request, err := http.NewRequestWithContext(ctx, endpoint.Method, f.host(endpoint.Path)+endpoint.Path+"?"+query, nil)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("X-MBX-APIKEY", creds.Key)

	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()

	// Read one byte past the cap so an oversized payload is detectable.
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBodySize+1))
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, body, nil
}

// signedQuery builds timestamp, recvWindow, then params sorted by key, and
// finally the signature over that whole string.
func signedQuery(timestamp int64, params map[string]string, secret string) string {
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var builder strings.Builder
	builder.WriteString("timestamp=")
	builder.WriteString(strconv.FormatInt(timestamp, 10))
	builder.WriteString("&recvWindow=")
	builder.WriteString(strconv.Itoa(recvWindowMillis))
	for _, key := range keys {
		builder.WriteString("&")
		builder.WriteString(url.QueryEscape(key))
		builder.WriteString("=")
		builder.WriteString(url.QueryEscape(params[key]))
	}

	query := builder.String()
	return query + "&signature=" + Sign(secret, query)
}

// host follows the same prefix rules as http.ts: futures and coin-margined
// futures get their own hosts, everything else uses spot.
func (f Fetcher) host(path string) string {
	key := "api"
	switch {
	case strings.HasPrefix(path, "/fapi/"):
		key = "fapi"
	case strings.HasPrefix(path, "/dapi/"):
		key = "dapi"
	}
	if host := f.Hosts[key]; host != "" {
		return strings.TrimRight(host, "/")
	}
	switch key {
	case "fapi":
		return defaultFAPIHost
	case "dapi":
		return defaultDAPIHost
	default:
		return defaultAPIHost
	}
}
