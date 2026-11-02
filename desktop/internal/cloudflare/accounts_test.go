package cloudflare_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare/cloudflaretest"
)

func writeResultWithInfo(t *testing.T, w http.ResponseWriter, result any, info any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"success":     true,
		"errors":      []any{},
		"result":      result,
		"result_info": info,
	})
	if err != nil {
		t.Fatalf("encode fixture response: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(payload)
}

func TestListAccountsAndScripts(t *testing.T) {
	var sawAccounts, sawScripts bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/client/v4/accounts":
			sawAccounts = true
			if r.URL.Query().Get("per_page") != "50" || r.URL.Query().Get("page") != "1" {
				t.Errorf("accounts query = %q", r.URL.RawQuery)
			}
			writeResult(t, w, []any{
				map[string]any{"id": testAccountID, "name": "First"},
				map[string]any{"id": "account-2", "name": "Second"},
			})
		case "/client/v4/accounts/" + testAccountID + "/workers/scripts":
			sawScripts = true
			if r.URL.Query().Get("per_page") != "50" || r.URL.Query().Get("page") != "1" {
				t.Errorf("scripts query = %q", r.URL.RawQuery)
			}
			writeResult(t, w, []any{
				map[string]any{"id": "worker-1", "modified_on": "2026-11-02T00:00:00Z", "migration_tag": "v2"},
			})
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
		}
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	accounts, err := client.ListAccounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 2 || accounts[1].ID != "account-2" || accounts[0].Name != "First" {
		t.Fatalf("accounts = %#v", accounts)
	}

	scripts, err := client.ListScripts(context.Background(), testAccountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(scripts) != 1 || scripts[0].ID != "worker-1" || scripts[0].MigrationTag != "v2" {
		t.Fatalf("scripts = %#v", scripts)
	}
	if !sawAccounts || !sawScripts {
		t.Fatalf("missing requests: accounts=%v scripts=%v", sawAccounts, sawScripts)
	}
}

func TestListAccountsPaginatesUntilTotalPages(t *testing.T) {
	var pages []int
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		pages = append(pages, page)
		switch page {
		case 1:
			batch := make([]any, 50)
			for i := range batch {
				batch[i] = map[string]any{"id": "id-" + strconv.Itoa(i), "name": "page-one"}
			}
			writeResultWithInfo(t, w, batch, map[string]any{"page": 1, "per_page": 50, "total_pages": 2})
		case 2:
			writeResultWithInfo(t, w, []any{
				map[string]any{"id": "last", "name": "page-two"},
			}, map[string]any{"page": 2, "per_page": 50, "total_pages": 2})
		default:
			t.Errorf("unexpected page %d", page)
			http.NotFound(w, r)
		}
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	accounts, err := client.ListAccounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 51 || accounts[50].ID != "last" {
		t.Fatalf("accounts count = %d, last = %#v", len(accounts), accounts[len(accounts)-1])
	}
	if len(pages) != 2 || pages[0] != 1 || pages[1] != 2 {
		t.Fatalf("pages = %#v", pages)
	}
}

func TestListScriptsRejectsInvalidIdentifiers(t *testing.T) {
	var calls atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.NotFound(w, r)
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	invalidAccounts := []string{"", "account-1", "../../etc", "0123456789abcdef0123456789abcdeg"}
	for _, accountID := range invalidAccounts {
		if _, err := client.ListScripts(context.Background(), accountID); err == nil {
			t.Errorf("invalid account %q accepted", accountID)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid account IDs made %d requests", calls.Load())
	}
}
