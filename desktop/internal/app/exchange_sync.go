package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/exchangeadmin"
	"github.com/deskwand/bot/desktop/internal/exchangesync"
)

// CodeExchangeSyncNoLocalKey reports a manual sync for an account whose key is
// not in this computer's vault. It is a local error, not a Worker refusal.
const CodeExchangeSyncNoLocalKey = "EXCHANGE_SYNC_NO_LOCAL_KEY"

// SyncExchange fetches one account from the local network and pushes the raw
// bundle to the deployed Worker. It is the page's "sync now" button; unlike the
// scheduler it may publish an ADMIN_TOKEN through the usual connect path.
func (s *Service) SyncExchange(accountID string) (ExchangeSyncDTO, error) {
	id := strings.TrimSpace(accountID)
	ctx := context.Background()
	keys, err := s.loadExchangeKeys(ctx)
	if err != nil {
		return ExchangeSyncDTO{}, safeAppError(err)
	}
	credentials, ok := keys[id]
	if !ok {
		return ExchangeSyncDTO{}, domain.Error{
			Code:    CodeExchangeSyncNoLocalKey,
			Message: s.t("app.exchangeSyncNoLocalKey"),
		}
	}
	s.exchangeSyncRun.Lock()
	defer s.exchangeSyncRun.Unlock()
	status := s.syncOne(ctx, id, credentials)
	s.recordExchangeSync(status)
	return status, nil
}

// ExchangeSyncStatus lists every locally stored account, sorted by id. An
// account that never synced carries only its id.
func (s *Service) ExchangeSyncStatus() ([]ExchangeSyncDTO, error) {
	keys, err := s.loadExchangeKeys(context.Background())
	if err != nil {
		return nil, safeAppError(err)
	}
	ids := sortedExchangeKeyIDs(keys)
	s.exchangeStatusMu.Lock()
	defer s.exchangeStatusMu.Unlock()
	statuses := make([]ExchangeSyncDTO, 0, len(ids))
	for _, id := range ids {
		if status, ok := s.exchangeStatus[id]; ok {
			statuses = append(statuses, status)
			continue
		}
		statuses = append(statuses, ExchangeSyncDTO{AccountID: id})
	}
	return statuses, nil
}

// ExchangeSyncStep returns the scheduler's step for service. It is a package
// function rather than a Service method so MyGo does not bind it to the page.
func ExchangeSyncStep(service *Service) func(context.Context) {
	return service.syncAllExchanges
}

// syncAllExchanges is the scheduler's step. It never publishes: without an
// ADMIN_TOKEN in the deployment it records the refusal and waits for the next
// tick instead of changing the deployment behind the owner's back.
func (s *Service) syncAllExchanges(ctx context.Context) {
	keys, err := s.loadExchangeKeys(ctx)
	if err != nil {
		slog.Warn("app: read local exchange keys for the scheduled sync", "error", err)
		return
	}
	if len(keys) == 0 {
		return
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return
	}
	if s.snapshots == nil {
		return
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		slog.Warn("app: read deployment for the scheduled exchange sync", "error", err)
		return
	}
	// Only accounts the deployment still lists as Binance: a key left behind by
	// an account removed elsewhere (another computer, an import) must stop
	// signing requests.
	ids := configuredBinanceIDs(snapshot.ConfigJSON, keys)
	if len(ids) == 0 {
		return
	}
	if !hasSecretName(snapshot.SecretNames, backup.AdminTokenSecret) {
		for _, id := range ids {
			s.recordExchangeSync(ExchangeSyncDTO{
				AccountID: id,
				At:        s.syncTimestamp(),
				Code:      exchangeadmin.CodeAdminUnavailable,
				Message:   s.t("exchangeadmin.unavailable"),
			})
		}
		return
	}

	s.exchangeSyncRun.Lock()
	defer s.exchangeSyncRun.Unlock()
	for _, id := range ids {
		s.recordExchangeSync(s.syncOne(ctx, id, keys[id]))
	}
}

// syncOne fetches and pushes one account. A local failure is a status the page
// renders, never an error: the next tick retries.
func (s *Service) syncOne(ctx context.Context, id string, credentials exchangesync.Credentials) ExchangeSyncDTO {
	bundle, err := s.exchangeFetcher.Fetch(ctx, credentials)
	if err != nil {
		var failure *exchangesync.Failure
		if errors.As(err, &failure) {
			return ExchangeSyncDTO{AccountID: id, At: s.syncTimestamp(), Code: failure.Code}
		}
		return s.failedExchangeSync(id, safeAppError(err))
	}

	target, err := s.managedTarget(ctx)
	if err != nil {
		return s.failedExchangeSync(id, safeAppError(err))
	}
	client, err := s.exchangeClient(ctx, target)
	if err != nil {
		return s.failedExchangeSync(id, safeAppError(err))
	}
	probe, err := client.PushSnapshot(ctx, id, bundle)
	if err != nil {
		return s.failedExchangeSync(id, safeAppError(err))
	}
	return ExchangeSyncDTO{
		AccountID:  id,
		At:         s.syncTimestamp(),
		OK:         probe.OK,
		Currencies: probe.Currencies,
		Total:      probe.Total,
		Code:       probe.Code,
		Message:    probe.Message,
	}
}

func (s *Service) failedExchangeSync(id string, err error) ExchangeSyncDTO {
	status := ExchangeSyncDTO{AccountID: id, At: s.syncTimestamp()}
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		status.Code = domainErr.Code
		status.Message = domainErr.Message
		return status
	}
	status.Message = err.Error()
	return status
}

func (s *Service) recordExchangeSync(status ExchangeSyncDTO) {
	s.exchangeStatusMu.Lock()
	defer s.exchangeStatusMu.Unlock()
	if s.exchangeStatus == nil {
		s.exchangeStatus = map[string]ExchangeSyncDTO{}
	}
	s.exchangeStatus[status.AccountID] = status
}

func (s *Service) syncTimestamp() string {
	return s.now().UTC().Format(time.RFC3339)
}

// configuredBinanceIDs returns the sorted ids that have a local key and are
// configured as Binance accounts in the deployment's config document.
func configuredBinanceIDs(configJSON []byte, keys map[string]exchangesync.Credentials) []string {
	var document struct {
		Exchange struct {
			Accounts []ExchangeAccountDTO `json:"accounts"`
		} `json:"exchange"`
	}
	if len(configJSON) == 0 || json.Unmarshal(configJSON, &document) != nil {
		return nil
	}
	binance := make(map[string]bool, len(document.Exchange.Accounts))
	for _, account := range document.Exchange.Accounts {
		if account.Venue == "binance" {
			binance[account.ID] = true
		}
	}
	ids := make([]string, 0, len(keys))
	for _, id := range sortedExchangeKeyIDs(keys) {
		if binance[id] {
			ids = append(ids, id)
		}
	}
	return ids
}

func sortedExchangeKeyIDs(keys map[string]exchangesync.Credentials) []string {
	ids := make([]string, 0, len(keys))
	for id := range keys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func hasSecretName(names []string, want string) bool {
	for _, name := range names {
		if name == want {
			return true
		}
	}
	return false
}
