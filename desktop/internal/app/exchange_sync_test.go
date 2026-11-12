package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/exchangeadmin"
	"github.com/deskwand/bot/desktop/internal/exchangesync"
)

// fakeBinance answers every endpoint the contract asks for. Never a real
// payload: the fetcher only forwards bytes.
func fakeBinance(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	if handler == nil {
		handler = func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "application/json")
			switch r.URL.Path {
			case "/api/v3/ticker/price", "/fapi/v3/positionRisk":
				_, _ = w.Write([]byte(`[]`))
			default:
				_, _ = w.Write([]byte(`{}`))
			}
		}
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

// snapshotRecorder is the fake Worker's /admin/exchange/snapshot route.
type snapshotRecorder struct {
	mu     sync.Mutex
	bodies [][]byte
	status int
	body   string
}

func (r *snapshotRecorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/admin/exchange/snapshot" {
		http.NotFound(w, req)
		return
	}
	raw, _ := io.ReadAll(req.Body)
	r.mu.Lock()
	r.bodies = append(r.bodies, raw)
	r.mu.Unlock()
	w.Header().Set("content-type", "application/json")
	if r.status != 0 {
		w.WriteHeader(r.status)
	}
	_, _ = w.Write([]byte(r.body))
}

func (r *snapshotRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.bodies)
}

func (r *snapshotRecorder) last() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.bodies) == 0 {
		return nil
	}
	return r.bodies[len(r.bodies)-1]
}

func newExchangeSyncFixture(t *testing.T, admin http.Handler, binanceURL string) *mcpFixture {
	t.Helper()
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, admin)
	if binanceURL != "" {
		f.service.exchangeFetcher = exchangesync.Fetcher{Hosts: map[string]string{
			"api":  binanceURL,
			"fapi": binanceURL,
			"dapi": binanceURL,
		}}
	}
	return f
}

// withExchangeAccounts puts an exchange section into the fixture's deployed
// config, the way a published config document carries it.
func withExchangeAccounts(t *testing.T, f *mcpFixture, accounts string) {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(f.snapshots.snapshot.ConfigJSON, &document); err != nil {
		t.Fatalf("decode fixture config: %v", err)
	}
	var list any
	if err := json.Unmarshal([]byte(accounts), &list); err != nil {
		t.Fatalf("decode accounts: %v", err)
	}
	document["exchange"] = map[string]any{"accounts": list}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode fixture config: %v", err)
	}
	f.snapshots.snapshot.ConfigJSON = encoded
}

func seedExchangeKeys(t *testing.T, f *mcpFixture, value string) {
	t.Helper()
	if err := f.credentials.Set(context.Background(), exchangeKeysCredential, value); err != nil {
		t.Fatalf("seed exchange keys: %v", err)
	}
}

func pushedBundle(t *testing.T, raw []byte) struct {
	Account   string                  `json:"account"`
	FetchedAt int64                   `json:"fetchedAt"`
	Responses []exchangesync.Response `json:"responses"`
} {
	t.Helper()
	var body struct {
		Account   string                  `json:"account"`
		FetchedAt int64                   `json:"fetchedAt"`
		Responses []exchangesync.Response `json:"responses"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode pushed bundle: %v", err)
	}
	return body
}

func TestSyncExchangePushesAndRecordsSuccess(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{body: `{"ok":true,"currencies":2,"total":12.5}`}
	f := newExchangeSyncFixture(t, recorder, binance.URL)
	seedExchangeKeys(t, f, `{"bn-main":{"key":"key-1","secret":"secret-1"}}`)

	dto, err := f.service.SyncExchange("bn-main")
	if err != nil {
		t.Fatalf("SyncExchange: %v", err)
	}
	if !dto.OK || dto.Currencies != 2 || dto.Total == nil || *dto.Total != 12.5 {
		t.Fatalf("dto = %#v", dto)
	}
	if dto.AccountID != "bn-main" || dto.At == "" || dto.Code != "" || dto.Message != "" {
		t.Fatalf("dto = %#v", dto)
	}
	if recorder.count() != 1 {
		t.Fatalf("pushes = %d, want 1", recorder.count())
	}
	body := pushedBundle(t, recorder.last())
	if body.Account != "bn-main" || body.FetchedAt == 0 || len(body.Responses) != 10 {
		t.Fatalf("pushed bundle = %#v", body)
	}
	if strings.Contains(string(recorder.last()), "secret-1") {
		t.Fatal("the push body carried the secret")
	}

	statuses, err := f.service.ExchangeSyncStatus()
	if err != nil {
		t.Fatalf("ExchangeSyncStatus: %v", err)
	}
	if len(statuses) != 1 || statuses[0].AccountID != "bn-main" || !statuses[0].OK {
		t.Fatalf("statuses = %#v", statuses)
	}
}

func TestSyncExchangeRecordsALocalFailureWithoutPushing(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	recorder := &snapshotRecorder{}
	f := newExchangeSyncFixture(t, recorder, deadURL)
	seedExchangeKeys(t, f, `{"bn-main":{"key":"key-1","secret":"secret-1"}}`)

	dto, err := f.service.SyncExchange("bn-main")
	if err != nil {
		t.Fatalf("SyncExchange: %v", err)
	}
	if dto.OK || dto.Code != "EXCHANGE_NETWORK" || dto.Message != "" {
		t.Fatalf("dto = %#v", dto)
	}
	if recorder.count() != 0 {
		t.Fatalf("pushes = %d, want 0", recorder.count())
	}
}

func TestSyncExchangeRelaysTheWorkerRefusal(t *testing.T) {
	binance := fakeBinance(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if r.URL.Path == "/api/v3/account" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":-2015}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	})
	recorder := &snapshotRecorder{
		status: http.StatusBadRequest,
		body:   `{"ok":false,"code":"EXCHANGE_UNKNOWN_KEY","message":"bad key"}`,
	}
	f := newExchangeSyncFixture(t, recorder, binance.URL)
	seedExchangeKeys(t, f, `{"bn-main":{"key":"key-1","secret":"secret-1"}}`)

	dto, err := f.service.SyncExchange("bn-main")
	if err != nil {
		t.Fatalf("a Worker refusal is a result, not an error: %v", err)
	}
	if dto.OK || dto.Code != "EXCHANGE_UNKNOWN_KEY" || dto.Message != "bad key" {
		t.Fatalf("dto = %#v", dto)
	}
	if recorder.count() != 1 {
		t.Fatalf("pushes = %d, want 1", recorder.count())
	}
	body := pushedBundle(t, recorder.last())
	if len(body.Responses) != 1 || body.Responses[0].Status != http.StatusUnauthorized {
		t.Fatalf("pushed bundle = %#v", body)
	}
}

func TestSyncExchangeWithoutLocalKey(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{}
	f := newExchangeSyncFixture(t, recorder, binance.URL)

	_, err := f.service.SyncExchange("bn-main")
	if err == nil {
		t.Fatal("expected a missing-key error")
	}
	if code := appErrorCode(err); code != CodeExchangeSyncNoLocalKey {
		t.Fatalf("code = %q, want %q", code, CodeExchangeSyncNoLocalKey)
	}
	if domainMessage(t, err) == "" {
		t.Fatal("missing-key error has no message")
	}
	if recorder.count() != 0 {
		t.Fatalf("pushes = %d, want 0", recorder.count())
	}
}

func TestSyncAllSkipsQuietlyWhenNotConnected(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{}
	f := newExchangeSyncFixture(t, recorder, binance.URL)
	seedExchangeKeys(t, f, `{"bn-main":{"key":"key-1","secret":"secret-1"}}`)
	f.auth.connection = auth.Connection{State: auth.StateDisconnected}

	f.service.syncAllExchanges(context.Background())

	if recorder.count() != 0 {
		t.Fatalf("pushes = %d, want 0", recorder.count())
	}
	f.service.exchangeStatusMu.Lock()
	recorded := len(f.service.exchangeStatus)
	f.service.exchangeStatusMu.Unlock()
	if recorded != 0 {
		t.Fatalf("recorded statuses = %d, want 0", recorded)
	}
}

func TestSyncAllSkipsWithoutAdminToken(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{}
	f := newMcpFixture(t, `[]`, []string{"TELEGRAM_BOT_TOKEN"}, recorder)
	f.service.exchangeFetcher = exchangesync.Fetcher{Hosts: map[string]string{
		"api":  binance.URL,
		"fapi": binance.URL,
		"dapi": binance.URL,
	}}
	seedExchangeKeys(t, f, `{"bn-main":{"key":"key-1","secret":"secret-1"}}`)
	withExchangeAccounts(t, f, `[{"id":"bn-main","venue":"binance"}]`)

	f.service.syncAllExchanges(context.Background())

	f.publish.mu.Lock()
	publishes := len(f.publish.changes)
	f.publish.mu.Unlock()
	if publishes != 0 {
		t.Fatalf("publishes = %d, want 0: the background sync must not publish", publishes)
	}
	if recorder.count() != 0 {
		t.Fatalf("pushes = %d, want 0", recorder.count())
	}
	statuses, err := f.service.ExchangeSyncStatus()
	if err != nil {
		t.Fatalf("ExchangeSyncStatus: %v", err)
	}
	if len(statuses) != 1 || statuses[0].Code != exchangeadmin.CodeAdminUnavailable {
		t.Fatalf("statuses = %#v", statuses)
	}
	// The page shows "waiting" for a status without a time, which would hide
	// why nothing synced.
	if statuses[0].At == "" || statuses[0].Message == "" {
		t.Fatalf("refusal must carry a time and a message: %#v", statuses[0])
	}
}

func TestSyncAllDoesNothingWithoutLocalKeys(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{}
	f := newExchangeSyncFixture(t, recorder, binance.URL)

	f.service.syncAllExchanges(context.Background())

	if f.snapshots.calls != 0 {
		t.Fatalf("snapshot reads = %d, want 0", f.snapshots.calls)
	}
	if recorder.count() != 0 {
		t.Fatalf("pushes = %d, want 0", recorder.count())
	}
	f.publish.mu.Lock()
	publishes := len(f.publish.changes)
	f.publish.mu.Unlock()
	if publishes != 0 {
		t.Fatalf("publishes = %d, want 0", publishes)
	}
	statuses, err := f.service.ExchangeSyncStatus()
	if err != nil {
		t.Fatalf("ExchangeSyncStatus: %v", err)
	}
	if len(statuses) != 0 {
		t.Fatalf("statuses = %#v", statuses)
	}
}

func TestExchangeSyncStatusListsLocalKeysOnly(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{body: `{"ok":true,"currencies":1,"total":5}`}
	f := newExchangeSyncFixture(t, recorder, binance.URL)
	seedExchangeKeys(t, f, `{
		"bn-main":{"key":"key-1","secret":"secret-1"},
		"bn-alt":{"key":"key-2","secret":"secret-2"}
	}`)

	if _, err := f.service.SyncExchange("bn-main"); err != nil {
		t.Fatalf("SyncExchange: %v", err)
	}
	statuses, err := f.service.ExchangeSyncStatus()
	if err != nil {
		t.Fatalf("ExchangeSyncStatus: %v", err)
	}
	if len(statuses) != 2 {
		t.Fatalf("statuses = %#v", statuses)
	}
	if statuses[0].AccountID != "bn-alt" || statuses[1].AccountID != "bn-main" {
		t.Fatalf("order = %#v", statuses)
	}
	if statuses[0].At != "" || statuses[0].OK {
		t.Fatalf("never-synced account = %#v", statuses[0])
	}
	if statuses[1].At == "" || !statuses[1].OK || statuses[1].Currencies != 1 {
		t.Fatalf("synced account = %#v", statuses[1])
	}
}

func TestSyncStatusNeverCarriesSecrets(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{body: `{"ok":true,"currencies":1,"total":5}`}
	f := newExchangeSyncFixture(t, recorder, binance.URL)
	seedExchangeKeys(t, f, `{"bn-main":{"key":"key-SENTINEL","secret":"secret-SENTINEL"}}`)

	if _, err := f.service.SyncExchange("bn-main"); err != nil {
		t.Fatalf("SyncExchange: %v", err)
	}
	statuses, err := f.service.ExchangeSyncStatus()
	if err != nil {
		t.Fatalf("ExchangeSyncStatus: %v", err)
	}
	encoded, err := json.Marshal(statuses)
	if err != nil {
		t.Fatalf("marshal statuses: %v", err)
	}
	if strings.Contains(string(encoded), "SENTINEL") {
		t.Fatalf("status carried a secret: %s", encoded)
	}
}

func TestSyncAllSkipsKeysForAccountsNoLongerConfigured(t *testing.T) {
	binance := fakeBinance(t, nil)
	recorder := &snapshotRecorder{body: `{"ok":true,"venue":"binance","currencies":1,"total":10}`}
	f := newExchangeSyncFixture(t, recorder, binance.URL)
	seedExchangeKeys(t, f, `{"bn-main":{"key":"key-1","secret":"secret-1"},"bn-gone":{"key":"key-2","secret":"secret-2"},"was-binance":{"key":"key-3","secret":"secret-3"}}`)
	withExchangeAccounts(t, f, `[{"id":"bn-main","venue":"binance"},{"id":"was-binance","venue":"okx"}]`)

	f.service.syncAllExchanges(context.Background())

	if recorder.count() != 1 {
		t.Fatalf("pushes = %d, want 1 (only bn-main is still a configured Binance account)", recorder.count())
	}
	if got := pushedBundle(t, recorder.last()).Account; got != "bn-main" {
		t.Fatalf("pushed account = %q, want bn-main", got)
	}
}
