// Package platform adapts operating-system services used by the desktop
// client while keeping the rest of the code testable with small interfaces.
package platform

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

var (
	// ErrCredentialNotFound means no credential is stored under the key.
	ErrCredentialNotFound = errors.New("platform: credential not found")
	// ErrCredentialStoreUnavailable means the operating system has no usable
	// credential store, for example a Linux session without a Secret Service.
	ErrCredentialStoreUnavailable = errors.New("platform: credential store unavailable")
)

// CredentialStore keeps small secrets in the operating system credential
// store. Implementations never return a stored value in an error message.
type CredentialStore interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key, value string) error
	Delete(ctx context.Context, key string) error
}

const maxCredentialKeyBytes = 256

type secretBackend interface {
	Get(key string) ([]byte, error)
	Set(key string, value []byte) error
	Delete(key string) error
}

type mygoSecretBackend struct {
	module mygo.SecretsModule
}

func (b mygoSecretBackend) Get(key string) ([]byte, error) { return b.module.Get(key) }
func (b mygoSecretBackend) Set(key string, value []byte) error {
	return b.module.Set(key, value)
}
func (b mygoSecretBackend) Delete(key string) error { return b.module.Delete(key) }

type systemCredentialStore struct {
	backend secretBackend
}

// NewSystemCredentialStore returns a credential store backed by the MyGo
// system secret service for service. An empty service uses MyGo's app
// identifier. Keys are kept together in one "vault" item so macOS asks for
// Keychain access at most once per launch; keys under PassthroughKeyPrefix
// keep their own items. Items stored per key by earlier versions move into
// the vault when first read. The whole vault and each pass-through value are
// limited to mygo.MaxSecretSize bytes, and keys to 256 bytes, matching the
// Windows Credential Manager's portable limits.
func NewSystemCredentialStore(service string) CredentialStore {
	return newVaultCredentialStore(newSystemCredentialStore(service, mygoSecretBackend{module: mygo.Secrets.Service(service)}))
}

func newSystemCredentialStore(_ string, backend secretBackend) CredentialStore {
	return &systemCredentialStore{backend: backend}
}

func (s *systemCredentialStore) Get(ctx context.Context, key string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := checkCredentialKey(key); err != nil {
		return "", err
	}
	value, err := s.backend.Get(key)
	if err != nil {
		return "", mapCredentialError(err)
	}
	return string(value), nil
}

func (s *systemCredentialStore) Set(ctx context.Context, key, value string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := checkCredentialKey(key); err != nil {
		return err
	}
	if len(value) > mygo.MaxSecretSize {
		return fmt.Errorf("platform: credential value is %d bytes, more than %d", len(value), mygo.MaxSecretSize)
	}
	return mapCredentialError(s.backend.Set(key, []byte(value)))
}

func (s *systemCredentialStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := checkCredentialKey(key); err != nil {
		return err
	}
	err := s.backend.Delete(key)
	if errors.Is(err, mygo.ErrSecretNotFound) {
		return nil
	}
	return mapCredentialError(err)
}

func checkCredentialKey(key string) error {
	switch {
	case key == "":
		return errors.New("platform: credential key is empty")
	case len(key) > maxCredentialKeyBytes:
		return fmt.Errorf("platform: credential key is %d bytes, more than %d", len(key), maxCredentialKeyBytes)
	case strings.ContainsRune(key, 0):
		return errors.New("platform: credential key contains NUL")
	default:
		return nil
	}
}

func mapCredentialError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, mygo.ErrSecretNotFound):
		return ErrCredentialNotFound
	case errors.Is(err, errors.ErrUnsupported):
		return ErrCredentialStoreUnavailable
	default:
		return fmt.Errorf("platform: credential store: %w", err)
	}
}

// MemoryCredentialStore is an in-memory CredentialStore for tests. It follows
// the same limits and not-found semantics as the system store.
type MemoryCredentialStore struct {
	mu     sync.Mutex
	values map[string]string
	fail   error
}

// NewMemoryCredentialStore returns an empty in-memory credential store.
func NewMemoryCredentialStore() *MemoryCredentialStore {
	return &MemoryCredentialStore{values: map[string]string{}}
}

// FailWith makes every subsequent operation fail with err. It is intended for
// tests; pass nil to restore normal operation.
func (m *MemoryCredentialStore) FailWith(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fail = err
}

func (m *MemoryCredentialStore) Get(ctx context.Context, key string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := checkCredentialKey(key); err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return "", m.fail
	}
	value, ok := m.values[key]
	if !ok {
		return "", ErrCredentialNotFound
	}
	return value, nil
}

func (m *MemoryCredentialStore) Set(ctx context.Context, key, value string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := checkCredentialKey(key); err != nil {
		return err
	}
	if len(value) > mygo.MaxSecretSize {
		return fmt.Errorf("platform: credential value is %d bytes, more than %d", len(value), mygo.MaxSecretSize)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return m.fail
	}
	m.values[key] = value
	return nil
}

func (m *MemoryCredentialStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := checkCredentialKey(key); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return m.fail
	}
	delete(m.values, key)
	return nil
}
