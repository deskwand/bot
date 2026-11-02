package cloudflare

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

const listPageSize = 50

// Account is one Cloudflare account the token can see.
type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ScriptSummary is one Worker script in an account.
type ScriptSummary struct {
	ID           string `json:"id"`
	ModifiedOn   string `json:"modified_on"`
	MigrationTag string `json:"migration_tag"`
}

// ListAccounts returns the accounts visible to the bearer token, reading every
// page until a short page or result_info.total_pages.
//
// Source: https://developers.cloudflare.com/api/resources/accounts/methods/list/
func (c *Client) ListAccounts(ctx context.Context) ([]Account, error) {
	return listPages[Account](ctx, c, "/accounts")
}

// ListScripts returns the Worker scripts in one account. The response carries
// id, modified_on and migration_tag; migration_tag is the currently applied
// Durable Object migration tag.
//
// Source: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/
func (c *Client) ListScripts(ctx context.Context, accountID string) ([]ScriptSummary, error) {
	base, err := accountBasePath(accountID)
	if err != nil {
		return nil, err
	}
	return listPages[ScriptSummary](ctx, c, base+"/workers/scripts")
}

func listPages[T any](ctx context.Context, client *Client, path string) ([]T, error) {
	all := make([]T, 0)
	for page := 1; ; page++ {
		query := url.Values{
			"page":     {strconv.Itoa(page)},
			"per_page": {strconv.Itoa(listPageSize)},
		}
		var batch []T
		info, err := client.GetJSONWithResultInfo(ctx, path, query, &batch)
		if err != nil {
			return nil, err
		}
		all = append(all, batch...)

		if len(batch) < listPageSize {
			break
		}
		var meta struct {
			TotalPages int `json:"total_pages"`
		}
		if len(info) > 0 {
			_ = json.Unmarshal(info, &meta)
		}
		if meta.TotalPages > 0 && page >= meta.TotalPages {
			break
		}
	}
	return all, nil
}
