// Package telemetry reports anonymous, content-free usage events to the
// DeskWand API. Nothing here may affect the client: every report is
// best-effort, bounded, and silent when it fails.
package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"runtime"
	"sync"
	"time"
)

// Product is the name the API groups this client's rows under.
const Product = "bot"

// Feature names one thing the user did in the desktop app. The API rejects a
// name it does not know, so this list must match its BOT_FEATURES.
const (
	FeatureInstall     = "install"
	FeatureImport      = "import"
	FeatureUpgrade     = "upgrade"
	FeaturePublish     = "publish"
	FeatureBackup      = "backup"
	FeatureRestore     = "restore"
	FeatureDiagnostics = "diagnostics"
	FeatureMcp         = "mcp"
)

var features = map[string]bool{
	FeatureInstall:     true,
	FeatureImport:      true,
	FeatureUpgrade:     true,
	FeaturePublish:     true,
	FeatureBackup:      true,
	FeatureRestore:     true,
	FeatureDiagnostics: true,
	FeatureMcp:         true,
}

// gates are the use counts reported once each. A gate turns "was it used" into
// a coarse intensity signal instead of one row per click.
var gates = []int{1, 5, 20, 100}

const (
	heartbeat      = time.Hour
	requestTimeout = 5 * time.Second
	maxInFlight    = 4
)

// Store is the persisted side of telemetry: the anonymous device id and the
// user's opt-out switch. Both are read before every send, so turning telemetry
// off stops the next report rather than the next launch.
type Store interface {
	Enabled() bool
	DeviceID() (string, error)
}

// Options configures a Reporter. Every field but BaseURL and Store has a
// working default.
type Options struct {
	BaseURL string
	Version string
	Store   Store
	// Client defaults to one with requestTimeout. It uses http.DefaultTransport,
	// which netproxy.Install has pointed at the system proxy.
	Client *http.Client
	// Now defaults to time.Now; tests use it to roll the UTC day over.
	Now func() time.Time
	// Platform overrides runtime.GOOS; empty means "derive it".
	Platform string
	// Dispatch runs one report. Tests pass a synchronous function; the default
	// runs it in its own goroutine.
	Dispatch func(func())
}

// Reporter sends the client's anonymous events.
type Reporter struct {
	baseURL  string
	version  string
	platform string
	store    Store
	client   *http.Client
	now      func() time.Time
	dispatch func(func())
	slots    chan struct{}

	mu   sync.Mutex
	day  string
	seen map[string]*gateState
}

type gateState struct {
	uses     int
	reported int
}

// New returns a Reporter. A reporter with no platform never sends anything.
func New(opts Options) *Reporter {
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: requestTimeout}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	dispatch := opts.Dispatch
	if dispatch == nil {
		dispatch = func(fn func()) { go fn() }
	}
	platform := opts.Platform
	if platform == "" {
		platform = platformName(runtime.GOOS)
	}
	return &Reporter{
		baseURL:  opts.BaseURL,
		version:  opts.Version,
		platform: platform,
		store:    opts.Store,
		client:   client,
		now:      now,
		dispatch: dispatch,
		slots:    make(chan struct{}, maxInFlight),
		seen:     map[string]*gateState{},
	}
}

// platformName maps a GOOS to the value the API accepts. Empty means the
// platform is not reported: the API only knows three, and guessing would make
// the dashboard lie.
func platformName(goos string) string {
	switch goos {
	case "darwin":
		return "darwin"
	case "windows":
		return "win32"
	case "linux":
		return "linux"
	}
	return ""
}

// Start reports once, then on every heartbeat until ctx is canceled. Run it in
// its own goroutine.
func (r *Reporter) Start(ctx context.Context) {
	r.Ping()
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.Ping()
		}
	}
}

// Ping reports that this installation is still in use.
func (r *Reporter) Ping() {
	r.send("/v1/telemetry/ping", r.base(), nil)
}

// ConfigDone reports that setup is complete. onSent runs only when the server
// accepted the report, so the caller can persist the one-shot fact without
// losing it to a dropped or rejected send. Nil onSent is allowed.
func (r *Reporter) ConfigDone(onSent func()) {
	r.send("/v1/telemetry/event", eventBody{pingBody: r.base(), Event: "config_done"}, onSent)
}

// UpdateInstalled reports that this launch runs a different version than the
// previous one, which is the only update outcome the client can observe.
func (r *Reporter) UpdateInstalled() {
	r.send("/v1/telemetry/event", eventBody{pingBody: r.base(), Event: "update_result", Code: "downloaded"}, nil)
}

// Feature counts one successful use and reports it when it crosses a gate.
func (r *Reporter) Feature(name string) {
	if !features[name] {
		return
	}
	r.mu.Lock()
	r.rollDayLocked()
	state := r.seen[name]
	if state == nil {
		state = &gateState{}
		r.seen[name] = state
	}
	state.uses++
	count := 0
	for _, gate := range gates {
		if state.uses >= gate && state.reported < gate {
			state.reported = gate
			count = gate
		}
	}
	r.mu.Unlock()
	if count == 0 {
		return
	}
	r.send("/v1/telemetry/event", eventBody{
		pingBody: r.base(),
		Event:    "feature_use",
		Feature:  name,
		Count:    &count,
	}, nil)
}

// rollDayLocked drops yesterday's counters so every gate can be reported once
// per UTC day. r.mu is held.
func (r *Reporter) rollDayLocked() {
	today := r.now().UTC().Format("2006-01-02")
	if today == r.day {
		return
	}
	r.day = today
	r.seen = map[string]*gateState{}
}

func (r *Reporter) base() pingBody {
	deviceID, err := r.store.DeviceID()
	if err != nil || deviceID == "" {
		return pingBody{}
	}
	return pingBody{
		DeviceID: deviceID,
		Version:  r.version,
		Platform: r.platform,
		Product:  Product,
	}
}

// send posts one payload without blocking the caller. Under pressure the report
// is dropped: under-reporting never matters, a slow operation always does.
func (r *Reporter) send(path string, body payload, onSent func()) {
	if r.platform == "" || r.baseURL == "" {
		return
	}
	if !body.ready() || !r.store.Enabled() {
		return
	}
	select {
	case r.slots <- struct{}{}:
	default:
		return
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		<-r.slots
		return
	}
	r.dispatch(func() {
		defer func() { <-r.slots }()
		req, err := http.NewRequest(http.MethodPost, r.baseURL+path, bytes.NewReader(encoded))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := r.client.Do(req)
		if err != nil {
			slog.Debug("telemetry: send failed", "path", path, "error", err)
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		// Accepted means the row exists. A 400 (a server that does not know this
		// product yet) or a 5xx must leave onSent uncalled so the caller can try
		// again rather than record a report that never landed.
		if resp.StatusCode < 200 || resp.StatusCode > 299 || onSent == nil {
			return
		}
		onSent()
	})
}

// payload is one report body: ready false means there is nothing worth sending.
type payload interface {
	ready() bool
}

// pingBody is what both endpoints carry.
type pingBody struct {
	DeviceID string `json:"deviceId"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Product  string `json:"product"`
}

func (p pingBody) ready() bool { return p.DeviceID != "" && p.Version != "" }

// eventBody adds the event fields to the same envelope.
type eventBody struct {
	pingBody
	Event   string `json:"event"`
	Feature string `json:"feature,omitempty"`
	Code    string `json:"code,omitempty"`
	Count   *int   `json:"count,omitempty"`
}

func (e eventBody) ready() bool { return e.pingBody.ready() }