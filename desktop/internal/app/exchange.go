package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/exchangeadmin"
)

var exchangeAccountID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// exchangeProblem carries the i18n key and the offending id: the caller turns
// it into a domain error in the owner's language.
type exchangeProblem struct {
	Key string
	ID  string
}

// validateExchangeAccounts mirrors src/exchange/accounts.ts. Publishing an
// account the Worker will silently drop looks like success to the owner, so the
// obvious mistakes are rejected here instead.
func validateExchangeAccounts(accounts []ExchangeAccountDTO) *exchangeProblem {
	seen := make(map[string]bool, len(accounts))
	for _, account := range accounts {
		id := strings.TrimSpace(account.ID)
		if !exchangeAccountID.MatchString(id) {
			return &exchangeProblem{Key: "app.exchangeIdInvalid", ID: id}
		}
		if seen[id] {
			return &exchangeProblem{Key: "app.exchangeDuplicateId", ID: id}
		}
		seen[id] = true
		switch account.Venue {
		case "okx", "binance":
		default:
			return &exchangeProblem{Key: "app.exchangeVenueInvalid", ID: id}
		}
		if utf8.RuneCountInString(account.Label) > 64 {
			return &exchangeProblem{Key: "app.exchangeLabelTooLong", ID: id}
		}
		if !validExchangeBaseURL(account.BaseURL) {
			return &exchangeProblem{Key: "app.exchangeBaseUrlInvalid", ID: id}
		}
	}
	return nil
}

func validExchangeBaseURL(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return true
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Host == "" {
		return false
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return false
	}
	return parsed.RawQuery == "" && parsed.Fragment == ""
}

func exchangeSectionPatch(accounts []ExchangeAccountDTO) ([]byte, error) {
	section := struct {
		Accounts []ExchangeAccountDTO `json:"accounts"`
	}{Accounts: accounts}
	encoded, err := json.Marshal(section)
	if err != nil {
		return nil, fmt.Errorf("app: encode exchange accounts: %w", err)
	}
	return encoded, nil
}

const codeExchangeAccountUnknown = "EXCHANGE_ACCOUNT_UNKNOWN"

// exchangeClient mirrors mcpClient: the ADMIN_TOKEN flow is shared with backups,
// so the page works before the user ever opens the backup page.
func (s *Service) exchangeClient(ctx context.Context, target domain.Target) (*exchangeadmin.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := exchangeadmin.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}

// TestExchange asks the deployed Worker to read one account. A freshly published
// version does not know the account yet, so the same propagation window as the
// MCP probe applies.
func (s *Service) TestExchange(accountID string) (ExchangeProbeDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ExchangeProbeDTO{}, err
	}
	client, err := s.exchangeClient(ctx, target)
	if err != nil {
		return ExchangeProbeDTO{}, safeAppError(err)
	}
	probe, err := untilLive(ctx,
		func() (exchangeadmin.Probe, error) {
			return client.Probe(ctx, strings.TrimSpace(accountID))
		},
		func(result exchangeadmin.Probe, err error) bool {
			return err == nil && result.Code == codeExchangeAccountUnknown
		})
	if err != nil {
		return ExchangeProbeDTO{}, s.adminFailure(err)
	}
	return ExchangeProbeDTO{
		OK:         probe.OK,
		Venue:      probe.Venue,
		Currencies: probe.Currencies,
		Total:      probe.Total,
		Code:       probe.Code,
		Message:    probe.Message,
	}, nil
}
