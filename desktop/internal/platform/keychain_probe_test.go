package platform_test

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/egoist/mygo"
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
