package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestValidateExchangeAccounts(t *testing.T) {
	cases := []struct {
		name    string
		account ExchangeAccountDTO
		wantKey string
	}{
		{"ok", ExchangeAccountDTO{ID: "okx-main", Venue: "okx"}, ""},
		{"binance", ExchangeAccountDTO{ID: "bn", Venue: "binance"}, ""},
		{"upper id", ExchangeAccountDTO{ID: "OKX", Venue: "okx"}, "app.exchangeIdInvalid"},
		{"space id", ExchangeAccountDTO{ID: "okx main", Venue: "okx"}, "app.exchangeIdInvalid"},
		{"unknown venue", ExchangeAccountDTO{ID: "x", Venue: "binance-us"}, "app.exchangeVenueInvalid"},
		{"http base", ExchangeAccountDTO{ID: "x", Venue: "okx", BaseURL: "http://www.okx.com"}, "app.exchangeBaseUrlInvalid"},
		{"path base", ExchangeAccountDTO{ID: "x", Venue: "okx", BaseURL: "https://www.okx.com/zh"}, "app.exchangeBaseUrlInvalid"},
		{"userinfo base", ExchangeAccountDTO{ID: "x", Venue: "okx", BaseURL: "https://u:p@www.okx.com"}, "app.exchangeBaseUrlInvalid"},
		{"long label", ExchangeAccountDTO{ID: "x", Venue: "okx", Label: strings.Repeat("a", 65)}, "app.exchangeLabelTooLong"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			problem := validateExchangeAccounts([]ExchangeAccountDTO{tc.account})
			if tc.wantKey == "" {
				if problem != nil {
					t.Fatalf("unexpected problem: %#v", problem)
				}
				return
			}
			if problem == nil || problem.Key != tc.wantKey {
				t.Fatalf("problem = %#v, want key %q", problem, tc.wantKey)
			}
		})
	}
}

func TestValidateExchangeAccountsRejectsDuplicates(t *testing.T) {
	problem := validateExchangeAccounts([]ExchangeAccountDTO{
		{ID: "dup", Venue: "okx"},
		{ID: "dup", Venue: "binance"},
	})
	if problem == nil || problem.Key != "app.exchangeDuplicateId" {
		t.Fatalf("problem = %#v", problem)
	}
}

func TestTestExchangeWaitsForAJustPublishedAccount(t *testing.T) {
	propagationInterval = time.Millisecond
	t.Cleanup(func() { propagationInterval = 2 * time.Second })

	calls := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/exchange/probe" {
			http.NotFound(w, r)
			return
		}
		calls++
		w.Header().Set("content-type", "application/json")
		if calls < 3 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"ok":false,"code":"EXCHANGE_ACCOUNT_UNKNOWN","message":"unknown"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"venue":"okx","currencies":2,"total":12.5}`))
	})

	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
	dto, err := f.service.TestExchange("okx-main")
	if err != nil {
		t.Fatalf("TestExchange: %v", err)
	}
	if !dto.OK || dto.Venue != "okx" || dto.Currencies != 2 {
		t.Fatalf("dto = %#v", dto)
	}
	if dto.Total == nil || *dto.Total != 12.5 {
		t.Fatalf("total = %#v", dto.Total)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestTestExchangeReturnsARefusal(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"ok":false,"code":"EXCHANGE_REGION_BLOCKED","message":"restricted"}`))
	})
	f := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
	dto, err := f.service.TestExchange("bn-main")
	if err != nil {
		t.Fatalf("a refusal is a result, not an error: %v", err)
	}
	if dto.OK || dto.Code != "EXCHANGE_REGION_BLOCKED" {
		t.Fatalf("dto = %#v", dto)
	}
}

func exchangeFixture(t *testing.T, configJSON string) *Service {
	t.Helper()
	base := newServiceFixture(t)
	snapshot := base.snapshots.snapshot
	snapshot.ConfigJSON = []byte(configJSON)
	base.snapshots = &fakeSnapshots{snapshot: snapshot}
	return base.buildService()
}

const exchangeConfigDocument = `{
	"schemaVersion": 1,
	"owner": {"telegramUserIds": [42]},
	"models": {
		"butler": {"provider": "anthropic", "id": "claude-sonnet-5-5"},
		"task": {"provider": "opencode-go", "id": "kimi-k3"}
	},
	"mcpServers": [],
	"exchange": {"accounts": [
		{"id": "okx-main", "venue": "okx", "label": "OKX 主号"},
		{"id": "bn-main", "venue": "binance", "baseUrl": "https://api.binance.com"}
	]}
}`

func TestGetConfigDecodesExchangeAccounts(t *testing.T) {
	service := exchangeFixture(t, exchangeConfigDocument)
	dto, err := service.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	got := make([]string, 0, len(dto.ExchangeAccounts))
	for _, account := range dto.ExchangeAccounts {
		got = append(got, account.ID+"/"+account.Venue)
	}
	if strings.Join(got, ",") != "okx-main/okx,bn-main/binance" {
		t.Fatalf("accounts = %v", got)
	}
	if dto.ExchangeAccounts[0].Label != "OKX 主号" {
		t.Fatalf("label = %q", dto.ExchangeAccounts[0].Label)
	}
}

func TestGetConfigWithoutExchangeReturnsEmptySlice(t *testing.T) {
	base := newServiceFixture(t)
	service := base.buildService()
	dto, err := service.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if dto.ExchangeAccounts == nil {
		t.Fatal("ExchangeAccounts must be an empty slice, never nil")
	}
	if len(dto.ExchangeAccounts) != 0 {
		t.Fatalf("accounts = %#v", dto.ExchangeAccounts)
	}
}

func TestChangeFromEditCarriesTrimmedExchangeAccounts(t *testing.T) {
	service := exchangeFixture(t, exchangeConfigDocument)
	target := domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName}
	accounts := []ExchangeAccountDTO{
		{ID: " okx-main ", Venue: " okx ", Label: " 主号 "},
	}
	change, err := service.changeFromEdit(context.Background(), target, ConfigEditDTO{
		ExchangeAccounts: &accounts,
	})
	if err != nil {
		t.Fatalf("changeFromEdit: %v", err)
	}
	if change.Patch.Exchange == nil {
		t.Fatal("exchange patch missing")
	}
	var section struct {
		Accounts []ExchangeAccountDTO `json:"accounts"`
	}
	if err := json.Unmarshal(*change.Patch.Exchange, &section); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	if len(section.Accounts) != 1 || section.Accounts[0].ID != "okx-main" {
		t.Fatalf("accounts = %#v", section.Accounts)
	}
	if section.Accounts[0].Venue != "okx" || section.Accounts[0].Label != "主号" {
		t.Fatalf("account = %#v", section.Accounts[0])
	}
}

func TestChangeFromEditRejectsAnInvalidExchangeAccount(t *testing.T) {
	service := exchangeFixture(t, exchangeConfigDocument)
	target := domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName}
	accounts := []ExchangeAccountDTO{{ID: "OKX", Venue: "okx"}}
	_, err := service.changeFromEdit(context.Background(), target, ConfigEditDTO{
		ExchangeAccounts: &accounts,
	})
	if err == nil {
		t.Fatal("an invalid id must be rejected before publishing")
	}
}
