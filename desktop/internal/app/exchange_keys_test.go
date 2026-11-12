package app

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/exchangesync"
	"github.com/deskwand/bot/desktop/internal/platform"
)

// countingCredentialStore counts vault writes so a test can tell "left the
// mapping alone" from "rewrote the same mapping".
type countingCredentialStore struct {
	*platform.MemoryCredentialStore
	sets    int
	deletes int
}

func newCountingCredentialStore() *countingCredentialStore {
	return &countingCredentialStore{MemoryCredentialStore: platform.NewMemoryCredentialStore()}
}

func (c *countingCredentialStore) Set(ctx context.Context, key, value string) error {
	c.sets++
	return c.MemoryCredentialStore.Set(ctx, key, value)
}

func (c *countingCredentialStore) Delete(ctx context.Context, key string) error {
	c.deletes++
	return c.MemoryCredentialStore.Delete(ctx, key)
}

func (c *countingCredentialStore) writes() int { return c.sets + c.deletes }

func exchangeKeysFixture(t *testing.T) (*serviceFixture, *Service, *countingCredentialStore) {
	t.Helper()
	base := newServiceFixture(t)
	snapshot := base.snapshots.snapshot
	snapshot.ConfigJSON = []byte(exchangeConfigDocument)
	base.snapshots = &fakeSnapshots{snapshot: snapshot}
	store := newCountingCredentialStore()
	base.credentials = store
	base.publish.applyResult = domain.Result{State: deployment.StatePublished}
	return base, base.buildService(), store
}

func binanceSecret(name, key, secret string) SecretEditDTO {
	return SecretEditDTO{
		Name:      name,
		Operation: domain.SecretReplace,
		Value:     fmt.Sprintf(`{"key":%q,"secret":%q}`, key, secret),
	}
}

func TestRememberStoresABinanceKey(t *testing.T) {
	_, svc, _ := exchangeKeysFixture(t)
	accounts := []ExchangeAccountDTO{
		{ID: "bn-main", Venue: "binance"},
	}
	secrets := []SecretEditDTO{binanceSecret("EXCHANGE_SECRET_BN_MAIN", "key-1", "secret-1")}
	if err := svc.rememberExchangeKeys(context.Background(), accounts, true, secrets); err != nil {
		t.Fatalf("rememberExchangeKeys: %v", err)
	}
	keys, err := svc.loadExchangeKeys(context.Background())
	if err != nil {
		t.Fatalf("loadExchangeKeys: %v", err)
	}
	got := keys["bn-main"]
	if got.Key != "key-1" || got.Secret != "secret-1" {
		t.Fatalf("stored credentials = %#v", got)
	}
	raw, err := svc.credentials.Get(context.Background(), exchangeKeysCredential)
	if err != nil {
		t.Fatalf("read raw vault item: %v", err)
	}
	if raw != `{"bn-main":{"key":"key-1","secret":"secret-1"}}` {
		t.Fatalf("stored value = %s", raw)
	}
}

func TestRememberNeverStoresOKX(t *testing.T) {
	_, svc, store := exchangeKeysFixture(t)
	accounts := []ExchangeAccountDTO{
		{ID: "okx-main", Venue: "okx"},
		{ID: "bn-main", Venue: "binance"},
	}
	secrets := []SecretEditDTO{{
		Name:      "EXCHANGE_SECRET_OKX_MAIN",
		Operation: domain.SecretReplace,
		Value:     `{"key":"key-1","secret":"secret-1","passphrase":"passphrase-1"}`,
	}}
	if err := svc.rememberExchangeKeys(context.Background(), accounts, true, secrets); err != nil {
		t.Fatalf("rememberExchangeKeys: %v", err)
	}
	if writes := store.writes(); writes != 0 {
		t.Fatalf("vault writes = %d, want 0", writes)
	}
	keys, err := svc.loadExchangeKeys(context.Background())
	if err != nil {
		t.Fatalf("loadExchangeKeys: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("stored keys = %#v", keys)
	}
}

// Review Focus 2: the owner refilled the key without touching the account
// list, so the frontend sends no exchangeAccounts. The venue still comes from
// the stored config.
func TestRememberUsesConfigVenueWhenAccountsUnchanged(t *testing.T) {
	_, svc, _ := exchangeKeysFixture(t)
	input := ConfigEditDTO{
		Secrets: []SecretEditDTO{binanceSecret("EXCHANGE_SECRET_BN_MAIN", "key-1", "secret-1")},
	}
	if _, err := svc.PublishConfig(input); err != nil {
		t.Fatalf("PublishConfig: %v", err)
	}
	keys, err := svc.loadExchangeKeys(context.Background())
	if err != nil {
		t.Fatalf("loadExchangeKeys: %v", err)
	}
	if got := keys["bn-main"]; got.Key != "key-1" || got.Secret != "secret-1" {
		t.Fatalf("stored credentials = %#v", keys)
	}
	if len(keys) != 1 {
		t.Fatalf("stored keys = %#v", keys)
	}
}

// Review Focus 5: an account removed from the config must lose its local copy.
func TestRememberPrunesRemovedAccounts(t *testing.T) {
	_, svc, _ := exchangeKeysFixture(t)
	ctx := context.Background()
	seed := map[string]exchangesync.Credentials{
		"bn-old": {Key: "old-key", Secret: "old-secret"},
	}
	if err := svc.storeExchangeKeys(ctx, seed); err != nil {
		t.Fatalf("storeExchangeKeys: %v", err)
	}
	accounts := []ExchangeAccountDTO{
		{ID: "bn-main", Venue: "binance"},
	}
	if err := svc.rememberExchangeKeys(ctx, accounts, true, nil); err != nil {
		t.Fatalf("rememberExchangeKeys: %v", err)
	}
	keys, err := svc.loadExchangeKeys(ctx)
	if err != nil {
		t.Fatalf("loadExchangeKeys: %v", err)
	}
	if _, ok := keys["bn-old"]; ok {
		t.Fatalf("stored keys still contain bn-old: %#v", keys)
	}
}

func TestRememberKeepsKeysOnLabelOnlyEdit(t *testing.T) {
	_, svc, store := exchangeKeysFixture(t)
	ctx := context.Background()
	if err := svc.storeExchangeKeys(ctx, map[string]exchangesync.Credentials{
		"bn-main": {Key: "key-1", Secret: "secret-1"},
	}); err != nil {
		t.Fatalf("storeExchangeKeys: %v", err)
	}
	writes := store.writes()
	accounts := []ExchangeAccountDTO{
		{ID: "bn-main", Venue: "binance", Label: "renamed"},
	}
	if err := svc.rememberExchangeKeys(ctx, accounts, true, nil); err != nil {
		t.Fatalf("rememberExchangeKeys: %v", err)
	}
	if got := store.writes(); got != writes {
		t.Fatalf("vault writes = %d, want %d", got, writes)
	}
	keys, err := svc.loadExchangeKeys(ctx)
	if err != nil {
		t.Fatalf("loadExchangeKeys: %v", err)
	}
	if got := keys["bn-main"]; got.Key != "key-1" || got.Secret != "secret-1" {
		t.Fatalf("stored credentials = %#v", keys)
	}
}

func TestStoreDeletesWhenEmpty(t *testing.T) {
	_, svc, store := exchangeKeysFixture(t)
	ctx := context.Background()
	if err := svc.storeExchangeKeys(ctx, map[string]exchangesync.Credentials{
		"bn-main": {Key: "key-1", Secret: "secret-1"},
	}); err != nil {
		t.Fatalf("storeExchangeKeys: %v", err)
	}
	if err := svc.storeExchangeKeys(ctx, map[string]exchangesync.Credentials{}); err != nil {
		t.Fatalf("storeExchangeKeys empty: %v", err)
	}
	if _, err := svc.credentials.Get(ctx, exchangeKeysCredential); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("vault item still present: %v", err)
	}
	// Deleting again is not an error even when a store reports not found.
	if err := svc.storeExchangeKeys(ctx, nil); err != nil {
		t.Fatalf("storeExchangeKeys nil: %v", err)
	}
	if store.deletes != 2 {
		t.Fatalf("deletes = %d, want 2", store.deletes)
	}
}

func TestPublishConfigRemembersOnlyAfterSuccess(t *testing.T) {
	base, svc, store := exchangeKeysFixture(t)
	base.publish.applyErr = fmt.Errorf("upload failed")
	accounts := []ExchangeAccountDTO{
		{ID: "bn-main", Venue: "binance"},
	}
	input := ConfigEditDTO{
		ExchangeAccounts: &accounts,
		Secrets:          []SecretEditDTO{binanceSecret("EXCHANGE_SECRET_BN_MAIN", "key-1", "secret-1")},
	}
	if _, err := svc.PublishConfig(input); err == nil {
		t.Fatal("expected publish error")
	}
	if writes := store.writes(); writes != 0 {
		t.Fatalf("vault writes = %d, want 0", writes)
	}
}
