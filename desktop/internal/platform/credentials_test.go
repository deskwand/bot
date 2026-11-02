package platform

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

type fakeSecretBackend struct {
	values    map[string][]byte
	err       error
	setErr    error
	deleteErr map[string]error

	getCalls    int
	setCalls    int
	deleteCalls int
	lastSetKey  string
	lastSetVal  []byte
	getKeys     []string
}

func (f *fakeSecretBackend) Get(key string) ([]byte, error) {
	f.getCalls++
	f.getKeys = append(f.getKeys, key)
	if f.err != nil {
		return nil, f.err
	}
	value, ok := f.values[key]
	if !ok {
		return nil, mygo.ErrSecretNotFound
	}
	return append([]byte(nil), value...), nil
}

func (f *fakeSecretBackend) Set(key string, value []byte) error {
	f.setCalls++
	f.lastSetKey = key
	f.lastSetVal = append([]byte(nil), value...)
	if f.err != nil {
		return f.err
	}
	if f.setErr != nil {
		return f.setErr
	}
	if f.values == nil {
		f.values = map[string][]byte{}
	}
	f.values[key] = append([]byte(nil), value...)
	return nil
}

func (f *fakeSecretBackend) Delete(key string) error {
	f.deleteCalls++
	if f.err != nil {
		return f.err
	}
	if err := f.deleteErr[key]; err != nil {
		return err
	}
	if _, ok := f.values[key]; !ok {
		return mygo.ErrSecretNotFound
	}
	delete(f.values, key)
	return nil
}

func TestSystemCredentialStoreMapsErrors(t *testing.T) {
	t.Run("not found", func(t *testing.T) {
		store := newSystemCredentialStore("test-service", &fakeSecretBackend{})
		if _, err := store.Get(context.Background(), "missing"); !errors.Is(err, ErrCredentialNotFound) {
			t.Fatalf("Get missing = %v, want ErrCredentialNotFound", err)
		}
	})

	t.Run("unavailable", func(t *testing.T) {
		store := newSystemCredentialStore("test-service", &fakeSecretBackend{err: errors.ErrUnsupported})
		if _, err := store.Get(context.Background(), "key"); !errors.Is(err, ErrCredentialStoreUnavailable) {
			t.Fatalf("Get = %v, want ErrCredentialStoreUnavailable", err)
		}
		if err := store.Set(context.Background(), "key", "value"); !errors.Is(err, ErrCredentialStoreUnavailable) {
			t.Fatalf("Set = %v, want ErrCredentialStoreUnavailable", err)
		}
		if err := store.Delete(context.Background(), "key"); !errors.Is(err, ErrCredentialStoreUnavailable) {
			t.Fatalf("Delete = %v, want ErrCredentialStoreUnavailable", err)
		}
	})

	t.Run("delete missing is not an error", func(t *testing.T) {
		store := newSystemCredentialStore("test-service", &fakeSecretBackend{})
		if err := store.Delete(context.Background(), "missing"); err != nil {
			t.Fatalf("Delete missing = %v, want nil", err)
		}
	})
}

func TestSystemCredentialStoreEnforcesLimits(t *testing.T) {
	backend := &fakeSecretBackend{}
	store := newSystemCredentialStore("test-service", backend)
	ctx := context.Background()

	if err := store.Set(ctx, "", "value"); err == nil {
		t.Fatal("empty key accepted")
	}
	if err := store.Set(ctx, strings.Repeat("k", 257), "value"); err == nil {
		t.Fatal("oversized key accepted")
	}
	if err := store.Set(ctx, "key\x00", "value"); err == nil {
		t.Fatal("key containing NUL accepted")
	}
	if err := store.Set(ctx, "key", strings.Repeat("v", mygo.MaxSecretSize+1)); err == nil {
		t.Fatal("oversized value accepted")
	}
	if backend.setCalls != 0 {
		t.Fatalf("backend Set called %d times for invalid input", backend.setCalls)
	}

	secret := "credential-value-sentinel"
	if err := store.Set(ctx, "key", secret); err != nil {
		t.Fatalf("Set valid value: %v", err)
	}
	if backend.lastSetKey != "key" {
		t.Fatalf("backend key = %q, want key", backend.lastSetKey)
	}
	if string(backend.lastSetVal) != secret {
		t.Fatal("backend did not receive the exact value")
	}
}

func TestSystemCredentialStoreErrorsDoNotIncludeValues(t *testing.T) {
	backend := &fakeSecretBackend{err: errors.ErrUnsupported}
	store := newSystemCredentialStore("test-service", backend)
	secret := "credential-value-sentinel"
	err := store.Set(context.Background(), "key", secret)
	if err == nil {
		t.Fatal("Set succeeded unexpectedly")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error contains secret value: %v", err)
	}
}

func TestMemoryCredentialStore(t *testing.T) {
	store := NewMemoryCredentialStore()
	ctx := context.Background()

	if _, err := store.Get(ctx, "key"); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("Get missing = %v, want ErrCredentialNotFound", err)
	}
	if err := store.Set(ctx, "key", "value"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := store.Get(ctx, "key")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != "value" {
		t.Fatalf("Get = %q, want value", got)
	}
	if err := store.Delete(ctx, "key"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Get(ctx, "key"); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("Get after Delete = %v, want ErrCredentialNotFound", err)
	}
	if err := store.Delete(ctx, "key"); err != nil {
		t.Fatalf("Delete missing = %v, want nil", err)
	}
}

func TestMemoryCredentialStoreUnavailable(t *testing.T) {
	store := NewMemoryCredentialStore()
	store.FailWith(ErrCredentialStoreUnavailable)
	if _, err := store.Get(context.Background(), "key"); !errors.Is(err, ErrCredentialStoreUnavailable) {
		t.Fatalf("Get = %v, want ErrCredentialStoreUnavailable", err)
	}
}

func TestCredentialStoreHonoursCancellation(t *testing.T) {
	store := NewMemoryCredentialStore()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Get(ctx, "key"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Get = %v, want context.Canceled", err)
	}
}
