package cloudflare_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare/cloudflaretest"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestListSecretNamesReturnsSortedUniqueNamesOnly(t *testing.T) {
	const sentinel = "secret-value-never-returned"
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeResult(t, w, []any{
			map[string]any{"name": "Z_SECRET", "type": "secret_text"},
			map[string]any{"name": "A_SECRET", "type": "secret_text", "text": sentinel},
			map[string]any{"name": "A_SECRET", "type": "secret_text"},
		})
	}))

	names, err := client.ListSecretNames(context.Background(), domain.Target{AccountID: testAccountID, ScriptName: "worker-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "A_SECRET" || names[1] != "Z_SECRET" {
		t.Fatalf("names = %#v", names)
	}
}
