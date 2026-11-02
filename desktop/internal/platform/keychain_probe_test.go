package platform_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/egoist/mygo"

	"github.com/deskwand/bot/desktop/internal/platform"
)

const (
	probeService = "com.deskwand.bot.probe"
	probeKey     = "deskwand-probe-sentinel"
)

// TestKeychainProbe verifies the system credential store with a disposable
// sentinel. It is opt-in because the OS may ask the user to unlock the
// keychain. Never put a real OAuth token here.
//
// Run with:
//
//	DESKWAND_KEYCHAIN_PROBE=1 go test ./internal/platform -run TestKeychainProbe -v
func TestKeychainProbe(t *testing.T) {
	if os.Getenv("DESKWAND_KEYCHAIN_PROBE") != "1" {
		t.Skip("credential store probe is opt-in: set DESKWAND_KEYCHAIN_PROBE=1")
	}

	store := mygo.Secrets.Service(probeService)
	t.Cleanup(func() {
		if err := store.Delete(probeKey); err != nil {
			t.Errorf("cleanup: delete sentinel: %v", err)
		}
	})

	// Make the probe independent of a missed earlier cleanup.
	if err := store.Delete(probeKey); err != nil {
		t.Fatalf("pre-clean delete: %v", err)
	}
	if _, err := store.Get(probeKey); !errors.Is(err, mygo.ErrSecretNotFound) {
		t.Fatalf("Get before Set = %v, want ErrSecretNotFound", err)
	}

	value := []byte(fmt.Sprintf("deskwand-probe-sentinel-%d", time.Now().UnixNano()))
	if err := store.Set(probeKey, value); err != nil {
		t.Fatalf("Set: %v", err)
	}

	got, err := store.Get(probeKey)
	if err != nil {
		t.Fatalf("Get after Set: %v", err)
	}
	if !bytes.Equal(got, value) {
		t.Fatalf("Get after Set = %q, want the sentinel value", got)
	}

	if err := store.Delete(probeKey); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Get(probeKey); !errors.Is(err, mygo.ErrSecretNotFound) {
		t.Fatalf("Get after Delete = %v, want ErrSecretNotFound", err)
	}
}

// TestKeychainVaultProbe exercises the vault credential store against the
// real system store with disposable sentinels, including one pass-through
// key. Never put a real token here.
//
// Run with:
//
//	DESKWAND_KEYCHAIN_PROBE=1 go test ./internal/platform -run TestKeychainVaultProbe -v
func TestKeychainVaultProbe(t *testing.T) {
	if os.Getenv("DESKWAND_KEYCHAIN_PROBE") != "1" {
		t.Skip("credential store probe is opt-in: set DESKWAND_KEYCHAIN_PROBE=1")
	}

	raw := mygo.Secrets.Service(probeService)
	passthrough := platform.PassthroughKeyPrefix + "probe.SENTINEL"
	keys := []string{"probe.first", "probe.second", passthrough}
	cleanup := func() {
		for _, key := range append([]string{"vault"}, keys...) {
			if err := raw.Delete(key); err != nil {
				t.Errorf("cleanup: delete %s: %v", key, err)
			}
		}
	}
	cleanup()
	t.Cleanup(cleanup)

	ctx := context.Background()
	store := platform.NewSystemCredentialStore(probeService)
	values := map[string]string{}
	for _, key := range keys {
		values[key] = fmt.Sprintf("deskwand-probe-%s-%d", key, time.Now().UnixNano())
		if err := store.Set(ctx, key, values[key]); err != nil {
			t.Fatalf("Set %s: %v", key, err)
		}
	}

	// A fresh store reads what the first one wrote from the system store.
	fresh := platform.NewSystemCredentialStore(probeService)
	for _, key := range keys {
		got, err := fresh.Get(ctx, key)
		if err != nil {
			t.Fatalf("Get %s: %v", key, err)
		}
		if got != values[key] {
			t.Fatalf("Get %s = %q, want the sentinel value", key, got)
		}
	}
	if _, err := raw.Get(passthrough); err != nil {
		t.Fatalf("pass-through key is not its own item: %v", err)
	}
	if _, err := raw.Get("probe.first"); !errors.Is(err, mygo.ErrSecretNotFound) {
		t.Fatalf("vault key stored as its own item: %v", err)
	}

	for _, key := range keys {
		if err := fresh.Delete(ctx, key); err != nil {
			t.Fatalf("Delete %s: %v", key, err)
		}
	}
	if _, err := raw.Get(passthrough); !errors.Is(err, mygo.ErrSecretNotFound) {
		t.Fatalf("Get pass-through after Delete = %v, want ErrSecretNotFound", err)
	}
	if err := raw.Delete("vault"); err != nil {
		t.Fatalf("delete vault item: %v", err)
	}
	if _, err := raw.Get("vault"); !errors.Is(err, mygo.ErrSecretNotFound) {
		t.Fatalf("Get vault after delete = %v, want ErrSecretNotFound", err)
	}
}
