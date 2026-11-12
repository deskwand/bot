package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/deskwand/bot/desktop/internal/exchangesync"
	"github.com/deskwand/bot/desktop/internal/platform"
)

// exchangeKeysCredential is the one vault item holding every account's
// Binance key. CredentialStore cannot list keys, so pruning a removed account
// needs the whole map in one item.
const exchangeKeysCredential = "exchange.binance.keys"

const exchangeSecretPrefix = "EXCHANGE_SECRET_"

// exchangeKeyPair is the on-disk shape of one account's key, matching the
// Worker secret value. It exists because exchangesync.Credentials has no JSON
// tags.
type exchangeKeyPair struct {
	Key    string `json:"key"`
	Secret string `json:"secret"`
}

// exchangeSecretName mirrors the frontend's providers.ts: `EXCHANGE_SECRET_`
// plus the account id uppercased with `-` replaced by `_`.
func exchangeSecretName(id string) string {
	return exchangeSecretPrefix + strings.ToUpper(strings.ReplaceAll(id, "-", "_"))
}

// loadExchangeKeys returns the locally stored Binance keys. A missing item is
// an empty map, not an error.
func (s *Service) loadExchangeKeys(ctx context.Context) (map[string]exchangesync.Credentials, error) {
	keys := map[string]exchangesync.Credentials{}
	if s.credentials == nil {
		return keys, nil
	}
	value, err := s.credentials.Get(ctx, exchangeKeysCredential)
	if errors.Is(err, platform.ErrCredentialNotFound) {
		return keys, nil
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(value) == "" {
		return keys, nil
	}
	if err := json.Unmarshal([]byte(value), &keys); err != nil {
		// The decode error carries an offset, never the stored bytes.
		return nil, fmt.Errorf("app: decode exchange keys: %w", err)
	}
	return keys, nil
}

// storeExchangeKeys writes the map back, deleting the vault item when the map
// is empty. A missing item is not an error.
func (s *Service) storeExchangeKeys(ctx context.Context, keys map[string]exchangesync.Credentials) error {
	if s.credentials == nil {
		if len(keys) == 0 {
			return nil
		}
		return errors.New("app: credential store is unavailable")
	}
	if len(keys) == 0 {
		err := s.credentials.Delete(ctx, exchangeKeysCredential)
		if errors.Is(err, platform.ErrCredentialNotFound) {
			return nil
		}
		return err
	}
	encoded, err := json.Marshal(exchangeKeyPairs(keys))
	if err != nil {
		return fmt.Errorf("app: encode exchange keys: %w", err)
	}
	return s.credentials.Set(ctx, exchangeKeysCredential, string(encoded))
}

// exchangeKeyPairs converts the fetch credentials into the stored JSON shape.
func exchangeKeyPairs(keys map[string]exchangesync.Credentials) map[string]exchangeKeyPair {
	pairs := make(map[string]exchangeKeyPair, len(keys))
	for id, credentials := range keys {
		pairs[id] = exchangeKeyPair{Key: credentials.Key, Secret: credentials.Secret}
	}
	return pairs
}

// rememberExchangeKeys folds this publish's Binance key edits into the local
// map. accounts is the full account list after the publish when pruning says
// the publish carried one. The map is only written when it actually changed,
// so a label-only edit leaves the vault alone.
func (s *Service) rememberExchangeKeys(
	ctx context.Context,
	accounts []ExchangeAccountDTO,
	pruning bool,
	secrets []SecretEditDTO,
) error {
	if s.credentials == nil {
		return nil
	}
	keys, err := s.loadExchangeKeys(ctx)
	if err != nil {
		return err
	}
	changed := false
	for _, secret := range secrets {
		if strings.TrimSpace(secret.Operation) != "replace" {
			continue
		}
		name := strings.TrimSpace(secret.Name)
		var match *ExchangeAccountDTO
		for index := range accounts {
			account := &accounts[index]
			if account.Venue != "binance" {
				continue
			}
			if exchangeSecretName(account.ID) == name {
				match = account
				break
			}
		}
		if match == nil {
			continue
		}
		credentials, ok := parseExchangeCredentials(secret.Value)
		if !ok {
			continue
		}
		if existing, stored := keys[match.ID]; !stored || existing != credentials {
			keys[match.ID] = credentials
			changed = true
		}
	}
	if pruning {
		keep := make(map[string]bool, len(accounts))
		for _, account := range accounts {
			if account.Venue == "binance" {
				keep[account.ID] = true
			}
		}
		for id := range keys {
			if !keep[id] {
				delete(keys, id)
				changed = true
			}
		}
	}
	if !changed {
		return nil
	}
	return s.storeExchangeKeys(ctx, keys)
}

// parseExchangeCredentials accepts the same `{"key","secret"}` JSON the Worker
// secret uses. OKX payloads carry a passphrase and simply do not match an
// account, never this parser.
func parseExchangeCredentials(value string) (exchangesync.Credentials, bool) {
	var parsed exchangeKeyPair
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return exchangesync.Credentials{}, false
	}
	key := strings.TrimSpace(parsed.Key)
	secret := strings.TrimSpace(parsed.Secret)
	if key == "" || secret == "" {
		return exchangesync.Credentials{}, false
	}
	return exchangesync.Credentials{Key: key, Secret: secret}, true
}

// exchangeAccountsForKeys decides which account list the publish's key edits
// are checked against. A publish that carries the full list prunes against it;
// a secrets-only publish falls back to the stored config, because the page
// omits the list when the owner only refilled a key.
func (s *Service) exchangeAccountsForKeys(input ConfigEditDTO) (accounts []ExchangeAccountDTO, pruning bool, remember bool) {
	if input.ExchangeAccounts != nil {
		trimmed := make([]ExchangeAccountDTO, len(*input.ExchangeAccounts))
		for index, account := range *input.ExchangeAccounts {
			account.ID = strings.TrimSpace(account.ID)
			account.Venue = strings.TrimSpace(account.Venue)
			account.Label = strings.TrimSpace(account.Label)
			account.BaseURL = strings.TrimSpace(account.BaseURL)
			trimmed[index] = account
		}
		return trimmed, true, true
	}
	if !hasExchangeSecretReplace(input.Secrets) {
		return nil, false, false
	}
	config, err := s.GetConfig()
	if err != nil {
		slog.Warn("app: read config for local exchange keys", "error", err)
		return nil, false, false
	}
	return config.ExchangeAccounts, false, true
}

func hasExchangeSecretReplace(secrets []SecretEditDTO) bool {
	for _, secret := range secrets {
		if strings.TrimSpace(secret.Operation) != "replace" {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(secret.Name), exchangeSecretPrefix) {
			return true
		}
	}
	return false
}
