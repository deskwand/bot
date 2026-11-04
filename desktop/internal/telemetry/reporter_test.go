package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fakeStore is the persisted switch and device id as the reporter sees them.
type fakeStore struct {
	enabled bool
	id      string
	idErr   error
}

func (f *fakeStore) Enabled() bool { return f.enabled }
func (f *fakeStore) DeviceID() (string, error) {
	if f.idErr != nil {
		return "", f.idErr
	}
	return f.id, nil
}

type recorder struct {
	mu     sync.Mutex
	paths  []string
	bodies []map[string]any
	status int
}

func (r *recorder) handler(w http.ResponseWriter, req *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(req.Body).Decode(&body)
	r.mu.Lock()
	r.paths = append(r.paths, req.URL.Path)
	r.bodies = append(r.bodies, body)
	status := r.status
	r.mu.Unlock()
	if status == 0 {
		status = http.StatusNoContent
	}
	w.WriteHeader(status)
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.bodies)
}

func (r *recorder) bodiesCopy() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]any(nil), r.bodies...)
}

func (r *recorder) pathsCopy() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.paths...)
}

// newTestReporter builds a reporter whose requests run inline, so a test never
// waits on a goroutine.
func newTestReporter(t *testing.T, store Store, status int) (*Reporter, *recorder) {
	t.Helper()
	rec := &recorder{status: status}
	server := httptest.NewServer(http.HandlerFunc(rec.handler))
	t.Cleanup(server.Close)
	reporter := New(Options{
		BaseURL:  server.URL,
		Version:  "0.1.8",
		Store:    store,
		Client:   server.Client(),
		Platform: "darwin",
		Dispatch: func(fn func()) { fn() },
	})
	return reporter, rec
}

func TestPingSendsTheBotProduct(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)

	reporter.Ping()

	if got := rec.pathsCopy(); len(got) != 1 || got[0] != "/v1/telemetry/ping" {
		t.Fatalf("paths = %v", got)
	}
	body := rec.bodiesCopy()[0]
	want := map[string]any{
		"deviceId": "device-1",
		"version":  "0.1.8",
		"platform": "darwin",
		"product":  "bot",
	}
	for key, value := range want {
		if body[key] != value {
			t.Fatalf("%s = %v; want %v (body %v)", key, body[key], value, body)
		}
	}
	if _, ok := body["event"]; ok {
		t.Fatalf("a ping carried an event: %v", body)
	}
}

func TestDisabledStoreSendsNothing(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: false, id: "device-1"}, 0)

	reporter.Ping()
	reporter.Feature(FeatureInstall)
	reporter.ConfigDone(nil)
	reporter.UpdateInstalled()

	if rec.count() != 0 {
		t.Fatalf("a disabled client sent %d requests", rec.count())
	}
}

func TestSwitchOffStopsTheNextReport(t *testing.T) {
	store := &fakeStore{enabled: true, id: "device-1"}
	reporter, rec := newTestReporter(t, store, 0)

	reporter.Ping()
	store.enabled = false
	reporter.Ping()

	if rec.count() != 1 {
		t.Fatalf("requests = %d; want only the one sent before the switch moved", rec.count())
	}
}

func TestFeatureReportsEachGateOnce(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)

	for i := 0; i < 25; i++ {
		reporter.Feature(FeatureInstall)
	}

	counts := make([]float64, 0, 3)
	for _, body := range rec.bodiesCopy() {
		if body["event"] != "feature_use" || body["feature"] != "install" {
			t.Fatalf("body = %v", body)
		}
		counts = append(counts, body["count"].(float64))
	}
	if len(counts) != 3 || counts[0] != 1 || counts[1] != 5 || counts[2] != 20 {
		t.Fatalf("gate counts = %v; want [1 5 20]", counts)
	}
}

func TestUnknownFeatureIsIgnored(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)

	reporter.Feature("prompt_text")

	if rec.count() != 0 {
		t.Fatalf("an unknown feature was reported: %v", rec.bodiesCopy())
	}
}

func TestUnknownPlatformSendsNothing(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)
	reporter.platform = ""

	reporter.Ping()

	if rec.count() != 0 {
		t.Fatalf("an unknown platform reported %d requests", rec.count())
	}
}

func TestEmptyVersionSendsNothing(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)
	reporter.version = ""

	reporter.Ping()

	if rec.count() != 0 {
		t.Fatalf("an empty version reported %d requests", rec.count())
	}
}

func TestDeviceIDFailureSendsNothing(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, idErr: errors.New("disk")}, 0)

	reporter.Ping()

	if rec.count() != 0 {
		t.Fatalf("a failed device id still reported %d requests", rec.count())
	}
}

func TestServerFailureDoesNotPanic(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, http.StatusInternalServerError)

	done := make(chan struct{})
	go func() {
		reporter.Ping()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a failing server blocked the caller")
	}
	if rec.count() != 1 {
		t.Fatalf("requests = %d", rec.count())
	}
}

func TestConfigDoneAndUpdateInstalledPayloads(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)

	reporter.ConfigDone(nil)
	reporter.UpdateInstalled()

	bodies := rec.bodiesCopy()
	if len(bodies) != 2 {
		t.Fatalf("requests = %d", len(bodies))
	}
	if bodies[0]["event"] != "config_done" || bodies[0]["product"] != "bot" {
		t.Fatalf("config_done body = %v", bodies[0])
	}
	if bodies[1]["event"] != "update_result" || bodies[1]["code"] != "downloaded" {
		t.Fatalf("update_result body = %v", bodies[1])
	}
}

func TestGatesResetOnTheNextUTCDay(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)
	day := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	reporter.now = func() time.Time { return day }

	reporter.Feature(FeatureBackup)
	day = day.Add(24 * time.Hour)
	reporter.Feature(FeatureBackup)

	bodies := rec.bodiesCopy()
	if len(bodies) != 2 || bodies[0]["count"].(float64) != 1 || bodies[1]["count"].(float64) != 1 {
		t.Fatalf("bodies = %v; want gate 1 on both days", bodies)
	}
}

func TestStartPingsImmediatelyAndStopsWithTheContext(t *testing.T) {
	reporter, rec := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)
	ctx, cancel := context.WithCancel(context.Background())

	go reporter.Start(ctx)
	deadline := time.Now().Add(time.Second)
	for rec.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if rec.count() != 1 {
		t.Fatalf("requests = %d; want the startup ping only", rec.count())
	}
}

func TestConfigDoneRecordsOnlyAfterTheServerAcceptsIt(t *testing.T) {
	recorded := 0
	reporter, _ := newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, http.StatusInternalServerError)
	reporter.ConfigDone(func() { recorded++ })
	if recorded != 0 {
		t.Fatalf("a rejected report recorded %d times", recorded)
	}

	reporter, _ = newTestReporter(t, &fakeStore{enabled: true, id: "device-1"}, 0)
	reporter.ConfigDone(func() { recorded++ })
	if recorded != 1 {
		t.Fatalf("an accepted report recorded %d times; want one", recorded)
	}
}

func TestPlatformNameMapsTheThreeTheAPIAccepts(t *testing.T) {
	for goos, want := range map[string]string{
		"darwin":  "darwin",
		"windows": "win32",
		"linux":   "linux",
		"freebsd": "",
	} {
		if got := platformName(goos); got != want {
			t.Fatalf("platformName(%q) = %q; want %q", goos, got, want)
		}
	}
}
