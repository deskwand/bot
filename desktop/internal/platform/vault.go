package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

// PassthroughKeyPrefix marks short-lived keys that stay in their own
// credential items instead of the vault. Deployment stores raw secret values
// under it, which can each be close to mygo.MaxSecretSize.
const PassthroughKeyPrefix = "deployment.op."

// vaultKey is the credential item that holds every other key as one JSON
// document, so macOS asks for Keychain access once instead of once per key.
const vaultKey = "vault"

const vaultVersion = 1

var errVaultUnreadable = errors.New("platform: credential vault is unreadable")

type vaultDocument struct {
	V     int               `json:"v"`
	Items map[string]string `json:"items"`
}

// vaultCredentialStore keeps long-lived keys in one credential item, read
// once and cached for the life of the process. Keys under
// PassthroughKeyPrefix go straight to inner.
type vaultCredentialStore struct {
	inner CredentialStore

	mu     sync.Mutex
	loaded bool
	items  map[string]string
}

func newVaultCredentialStore(inner CredentialStore) *vaultCredentialStore {
	return &vaultCredentialStore{inner: inner}
}

func (s *vaultCredentialStore) Get(ctx context.Context, key string) (string, error) {
	if err := checkVaultKey(ctx, key); err != nil {
		return "", err
	}
	if strings.HasPrefix(key, PassthroughKeyPrefix) {
		return s.inner.Get(ctx, key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(ctx); err != nil {
		return "", err
	}
	value, ok := s.items[key]
	if !ok {
		return "", ErrCredentialNotFound
	}
	return value, nil
}

func (s *vaultCredentialStore) Set(ctx context.Context, key, value string) error {
	if err := checkVaultKey(ctx, key); err != nil {
		return err
	}
	if strings.HasPrefix(key, PassthroughKeyPrefix) {
		return s.inner.Set(ctx, key, value)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(ctx); err != nil {
		return err
	}
	next := maps.Clone(s.items)
	next[key] = value
	return s.write(ctx, next)
}

func (s *vaultCredentialStore) Delete(ctx context.Context, key string) error {
	if err := checkVaultKey(ctx, key); err != nil {
		return err
	}
	if strings.HasPrefix(key, PassthroughKeyPrefix) {
		return s.inner.Delete(ctx, key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(ctx); err != nil {
		return err
	}
	if _, ok := s.items[key]; !ok {
		return nil
	}
	next := maps.Clone(s.items)
	delete(next, key)
	return s.write(ctx, next)
}

func checkVaultKey(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := checkCredentialKey(key); err != nil {
		return err
	}
	if key == vaultKey {
		return fmt.Errorf("platform: credential key %q is reserved", vaultKey)
	}
	return nil
}

// load reads the vault item once. A failed read leaves the store unloaded so
// the next call retries. The caller holds s.mu.
func (s *vaultCredentialStore) load(ctx context.Context) error {
	if s.loaded {
		return nil
	}
	raw, err := s.inner.Get(ctx, vaultKey)
	if errors.Is(err, ErrCredentialNotFound) {
		s.items, s.loaded = map[string]string{}, true
		return nil
	}
	if err != nil {
		return err
	}
	var doc vaultDocument
	if err := json.Unmarshal([]byte(raw), &doc); err != nil || doc.V != vaultVersion {
		return errVaultUnreadable
	}
	if doc.Items == nil {
		doc.Items = map[string]string{}
	}
	s.items, s.loaded = doc.Items, true
	return nil
}

// write stores next as the whole vault and replaces the cache only when the
// write succeeds. The caller holds s.mu.
func (s *vaultCredentialStore) write(ctx context.Context, next map[string]string) error {
	raw, err := json.Marshal(vaultDocument{V: vaultVersion, Items: next})
	if err != nil {
		return fmt.Errorf("platform: encode credential vault: %w", err)
	}
	if len(raw) > mygo.MaxSecretSize {
		return fmt.Errorf("platform: credential vault is %d bytes, more than %d", len(raw), mygo.MaxSecretSize)
	}
	if err := s.inner.Set(ctx, vaultKey, string(raw)); err != nil {
		return err
	}
	s.items = next
	return nil
}
