package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo"
)

func newTestVault(b *fakeSecretBackend) *vaultCredentialStore {
	return newVaultCredentialStore(newSystemCredentialStore("svc", b))
}

func vaultItems(t *testing.T, b *fakeSecretBackend) map[string]string {
	t.Helper()
	raw, ok := b.values[vaultKey]
	if !ok {
		t.Fatalf("backend has no %q item", vaultKey)
	}
	var doc struct {
		V     int               `json:"v"`
		Items map[string]string `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode vault: %v", err)
	}
	if doc.V != 1 {
		t.Fatalf("vault version = %d, want 1", doc.V)
	}
	return doc.Items
}

func TestVaultReadsKeychainOnce(t *testing.T) {
	b := &fakeSecretBackend{values: map[string][]byte{
		vaultKey: []byte(`{"v":1,"items":{"cloudflare.account-id":"acc","cloudflare.api-token":"tok"}}`),
	}}
	store := newTestVault(b)
	ctx := context.Background()

	if got, err := store.Get(ctx, "cloudflare.account-id"); err != nil || got != "acc" {
		t.Fatalf("Get account-id = %q, %v", got, err)
	}
	if got, err := store.Get(ctx, "cloudflare.api-token"); err != nil || got != "tok" {
		t.Fatalf("Get api-token = %q, %v", got, err)
	}
	if b.getCalls != 1 || !reflect.DeepEqual(b.getKeys, []string{vaultKey}) {
		t.Fatalf("backend Get calls = %d %v, want one read of %q", b.getCalls, b.getKeys, vaultKey)
	}
}

func TestVaultSetPersistsWholeItem(t *testing.T) {
	b := &fakeSecretBackend{}
	store := newTestVault(b)
	ctx := context.Background()

	if err := store.Set(ctx, "a", "1"); err != nil {
		t.Fatalf("Set a: %v", err)
	}
	if err := store.Set(ctx, "b", "2"); err != nil {
		t.Fatalf("Set b: %v", err)
	}
	if got := vaultItems(t, b); !reflect.DeepEqual(got, map[string]string{"a": "1", "b": "2"}) {
		t.Fatalf("vault items = %v", got)
	}
	if _, ok := b.values["a"]; ok {
		t.Fatal("key a was stored as its own item")
	}
	if _, ok := b.values["b"]; ok {
		t.Fatal("key b was stored as its own item")
	}
	if b.getCalls != 1 {
		t.Fatalf("backend Get calls = %d, want 1", b.getCalls)
	}
}

func TestVaultPassthroughKeysBypassVault(t *testing.T) {
	b := &fakeSecretBackend{}
	store := newTestVault(b)
	ctx := context.Background()
	key := PassthroughKeyPrefix + "op1.SECRET"

	if err := store.Set(ctx, key, "v"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if string(b.values[key]) != "v" {
		t.Fatalf("backend[%q] = %q, want v", key, b.values[key])
	}
	if _, ok := b.values[vaultKey]; ok {
		t.Fatal("pass-through key created the vault item")
	}
	if got, err := store.Get(ctx, key); err != nil || got != "v" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if err := store.Delete(ctx, key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := b.values[key]; ok {
		t.Fatal("Delete left the pass-through item")
	}
}

func TestVaultSetFailureKeepsCache(t *testing.T) {
	b := &fakeSecretBackend{values: map[string][]byte{vaultKey: []byte(`{"v":1,"items":{"a":"old"}}`)}}
	store := newTestVault(b)
	ctx := context.Background()

	if _, err := store.Get(ctx, "a"); err != nil {
		t.Fatalf("Get: %v", err)
	}
	b.setErr = errors.New("denied")
	if err := store.Set(ctx, "a", "new"); err == nil {
		t.Fatal("Set succeeded, want error")
	}
	if got, err := store.Get(ctx, "a"); err != nil || got != "old" {
		t.Fatalf("Get after failed Set = %q, %v; want old", got, err)
	}
	if got := vaultItems(t, b); !reflect.DeepEqual(got, map[string]string{"a": "old"}) {
		t.Fatalf("vault items = %v", got)
	}
}

func TestVaultUnreadableIsNeverOverwritten(t *testing.T) {
	for name, raw := range map[string]string{
		"invalid json":    `not json`,
		"unknown version": `{"v":2,"items":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			b := &fakeSecretBackend{values: map[string][]byte{vaultKey: []byte(raw)}}
			store := newTestVault(b)
			ctx := context.Background()

			if _, err := store.Get(ctx, "a"); !errors.Is(err, errVaultUnreadable) {
				t.Fatalf("Get = %v, want errVaultUnreadable", err)
			}
			if err := store.Set(ctx, "a", "x"); !errors.Is(err, errVaultUnreadable) {
				t.Fatalf("Set = %v, want errVaultUnreadable", err)
			}
			if string(b.values[vaultKey]) != raw {
				t.Fatalf("vault item changed to %q", b.values[vaultKey])
			}
			if b.setCalls != 0 {
				t.Fatalf("backend Set calls = %d, want 0", b.setCalls)
			}
		})
	}
}

func TestVaultRejectsOversizedItem(t *testing.T) {
	b := &fakeSecretBackend{}
	store := newTestVault(b)
	ctx := context.Background()

	err := store.Set(ctx, "a", strings.Repeat("x", mygo.MaxSecretSize))
	if err == nil || !strings.Contains(err.Error(), "more than 2560") {
		t.Fatalf("Set = %v, want size error", err)
	}
	if _, ok := b.values[vaultKey]; ok {
		t.Fatal("oversized vault was written")
	}
	if _, err := store.Get(ctx, "a"); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("Get = %v, want ErrCredentialNotFound", err)
	}
}

func TestVaultLoadErrorIsRetried(t *testing.T) {
	b := &fakeSecretBackend{err: errors.ErrUnsupported}
	store := newTestVault(b)
	ctx := context.Background()

	if _, err := store.Get(ctx, "a"); !errors.Is(err, ErrCredentialStoreUnavailable) {
		t.Fatalf("Get = %v, want ErrCredentialStoreUnavailable", err)
	}
	b.err = nil
	b.values = map[string][]byte{vaultKey: []byte(`{"v":1,"items":{"a":"1"}}`)}
	if got, err := store.Get(ctx, "a"); err != nil || got != "1" {
		t.Fatalf("Get after recovery = %q, %v", got, err)
	}
}

func TestVaultRejectsReservedKey(t *testing.T) {
	b := &fakeSecretBackend{}
	store := newTestVault(b)
	ctx := context.Background()
	want := `"vault" is reserved`

	if _, err := store.Get(ctx, vaultKey); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Get = %v", err)
	}
	if err := store.Set(ctx, vaultKey, "x"); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Set = %v", err)
	}
	if err := store.Delete(ctx, vaultKey); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Delete = %v", err)
	}
	if b.getCalls+b.setCalls+b.deleteCalls != 0 {
		t.Fatalf("backend touched: get=%d set=%d delete=%d", b.getCalls, b.setCalls, b.deleteCalls)
	}
}

func TestVaultEmptyValueIsStored(t *testing.T) {
	store := newTestVault(&fakeSecretBackend{})
	ctx := context.Background()

	if err := store.Set(ctx, "a", ""); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got, err := store.Get(ctx, "a"); err != nil || got != "" {
		t.Fatalf("Get = %q, %v; want empty string and nil", got, err)
	}
}

func TestVaultConcurrentSetsKeepAllKeys(t *testing.T) {
	b := &fakeSecretBackend{}
	store := newTestVault(b)
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.Set(ctx, fmt.Sprintf("k%d", i), "v"); err != nil {
				t.Errorf("Set k%d: %v", i, err)
			}
		}()
	}
	wg.Wait()
	if got := len(vaultItems(t, b)); got != 50 {
		t.Fatalf("vault has %d keys, want 50", got)
	}
}

func TestVaultValuesRoundTripExactly(t *testing.T) {
	b := &fakeSecretBackend{}
	ctx := context.Background()
	value := "<>&\"\n密钥🔑"

	if err := newTestVault(b).Set(ctx, "a", value); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got, err := newTestVault(b).Get(ctx, "a"); err != nil || got != value {
		t.Fatalf("Get = %q, %v; want %q", got, err, value)
	}
}

func TestVaultCancelledContextSkipsBackend(t *testing.T) {
	b := &fakeSecretBackend{}
	store := newTestVault(b)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := store.Get(ctx, "a"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Get = %v", err)
	}
	if err := store.Set(ctx, "a", "v"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Set = %v", err)
	}
	if err := store.Delete(ctx, "a"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Delete = %v", err)
	}
	if b.getCalls+b.setCalls+b.deleteCalls != 0 {
		t.Fatalf("backend touched: get=%d set=%d delete=%d", b.getCalls, b.setCalls, b.deleteCalls)
	}
}
