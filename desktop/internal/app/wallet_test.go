package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
)

var (
	validWalletKey     = "0x" + strings.Repeat("1", 64)
	validWalletAddress = "0x" + strings.Repeat("2", 40)
)

func TestValidateWalletEdit(t *testing.T) {
	cases := []struct {
		name    string
		input   WalletEditDTO
		wantKey string
	}{
		{"empty means unchanged", WalletEditDTO{}, ""},
		{"valid", WalletEditDTO{PrivateKey: validWalletKey, OwnerAddress: validWalletAddress}, ""},
		{"short key", WalletEditDTO{PrivateKey: "0x1234"}, "app.walletPrivateKeyInvalid"},
		{"key without 0x", WalletEditDTO{PrivateKey: strings.Repeat("1", 64)}, "app.walletPrivateKeyInvalid"},
		{"key with non-hex", WalletEditDTO{PrivateKey: "0x" + strings.Repeat("z", 64)}, "app.walletPrivateKeyInvalid"},
		{"short address", WalletEditDTO{OwnerAddress: "0x1234"}, "app.walletOwnerAddressInvalid"},
		{"address without 0x", WalletEditDTO{OwnerAddress: strings.Repeat("2", 40)}, "app.walletOwnerAddressInvalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			problem := validateWalletEdit(tc.input)
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

func TestWalletConfigEditSkipsEmptyFields(t *testing.T) {
	edit, err := walletConfigEdit(WalletEditDTO{})
	if err != nil {
		t.Fatalf("walletConfigEdit: %v", err)
	}
	if len(edit.Secrets) != 0 {
		t.Fatalf("secrets = %#v", edit.Secrets)
	}
	if edit.Wallet != nil {
		t.Fatalf("wallet patch = %#v", edit.Wallet)
	}
}

func TestWalletConfigEditCarriesTheFilledFields(t *testing.T) {
	edit, err := walletConfigEdit(WalletEditDTO{
		PrivateKey:   " " + validWalletKey + " ",
		OwnerAddress: " " + validWalletAddress + " ",
		RPCURL:       " https://rpc.example ",
	})
	if err != nil {
		t.Fatalf("walletConfigEdit: %v", err)
	}
	if len(edit.Secrets) != 2 {
		t.Fatalf("secrets = %#v", edit.Secrets)
	}
	if edit.Secrets[0].Name != "WALLET_PRIVATE_KEY" || edit.Secrets[0].Operation != domain.SecretReplace {
		t.Fatalf("private key edit = %#v", edit.Secrets[0])
	}
	if edit.Secrets[0].Value != validWalletKey {
		t.Fatalf("private key was not trimmed: %q", edit.Secrets[0].Value)
	}
	if edit.Secrets[1].Name != "WALLET_OWNER_ADDRESS" || edit.Secrets[1].Value != validWalletAddress {
		t.Fatalf("owner edit = %#v", edit.Secrets[1])
	}
	if edit.Wallet == nil || edit.Wallet.RPCURL != "https://rpc.example" {
		t.Fatalf("wallet patch = %#v", edit.Wallet)
	}
}

func TestSaveWalletRejectsABadKeyBeforePublishing(t *testing.T) {
	fixture := newServiceFixture(t)
	_, err := fixture.service.SaveWallet(WalletEditDTO{PrivateKey: "0x1234"})
	if err == nil {
		t.Fatal("a bad key must be rejected")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != "INVALID_REQUEST" {
		t.Fatalf("error = %#v", err)
	}
	if len(fixture.publish.changes) != 0 {
		t.Fatal("nothing may be published")
	}
}

func TestSaveWalletPublishesSecretsAndTheRPCURL(t *testing.T) {
	fixture := newServiceFixture(t)
	if _, err := fixture.service.SaveWallet(WalletEditDTO{
		PrivateKey:   validWalletKey,
		OwnerAddress: validWalletAddress,
		RPCURL:       "https://rpc.example",
	}); err != nil {
		t.Fatalf("SaveWallet: %v", err)
	}
	if len(fixture.publish.changes) != 1 {
		t.Fatalf("publish calls = %d", len(fixture.publish.changes))
	}
	change := fixture.publish.lastChange()
	byName := make(map[string]domain.SecretEdit, len(change.Secrets))
	for _, edit := range change.Secrets {
		byName[edit.Name] = edit
	}
	if byName["WALLET_PRIVATE_KEY"].Value() != validWalletKey {
		t.Fatalf("private key edit = %#v", byName["WALLET_PRIVATE_KEY"])
	}
	if byName["WALLET_OWNER_ADDRESS"].Value() != validWalletAddress {
		t.Fatalf("owner edit = %#v", byName["WALLET_OWNER_ADDRESS"])
	}
	if change.Patch.Wallet == nil {
		t.Fatal("wallet patch missing")
	}
	var section struct {
		RPCURL string `json:"rpcUrl"`
	}
	if err := json.Unmarshal(*change.Patch.Wallet, &section); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	if section.RPCURL != "https://rpc.example" {
		t.Fatalf("rpcUrl = %q", section.RPCURL)
	}
}

func TestWalletFormatErrorsFollowLocale(t *testing.T) {
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		t.Run(locale, func(t *testing.T) {
			service := NewService(ServiceOptions{})
			setServiceLocale(service, locale)
			_, err := service.SaveWallet(WalletEditDTO{OwnerAddress: "0x1234"})
			var domainErr domain.Error
			if !errors.As(err, &domainErr) {
				t.Fatalf("error = %v; want a domain.Error", err)
			}
			if locale == i18n.EN {
				i18ntest.NoHan(t, "wallet owner address", domainErr.Message)
			}
			if domainErr.Message == "" {
				t.Fatal("empty message")
			}
		})
	}
}

func TestWalletStatusMapsTheWorkerPayload(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/admin/wallet/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"configured":true,"address":"0x2222222222222222222222222222222222222222","valueUsd":12.5}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
	status, err := fixture.service.WalletStatus()
	if err != nil {
		t.Fatalf("WalletStatus: %v", err)
	}
	if !status.Configured || status.Address != "0x2222222222222222222222222222222222222222" {
		t.Fatalf("status = %#v", status)
	}
	if status.ValueUSD == nil || *status.ValueUSD != 12.5 {
		t.Fatalf("valueUsd = %#v", status.ValueUSD)
	}
}
