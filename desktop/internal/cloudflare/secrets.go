package cloudflare

import (
	"context"
	"sort"

	"github.com/deskwand/bot/desktop/internal/domain"
)

type secretMetadata struct {
	Name string `json:"name"`
}

// ListSecretNames returns the names of the Worker's secret bindings. The
// Cloudflare API never returns secret values; v1 has no API that writes
// secrets outside a version upload.
func (c *Client) ListSecretNames(ctx context.Context, target domain.Target) ([]string, error) {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return nil, err
	}
	var secrets []secretMetadata
	if err := c.GetJSON(ctx, scriptPath+"/secrets", nil, &secrets); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(secrets))
	seen := map[string]bool{}
	for _, secret := range secrets {
		if secret.Name == "" || seen[secret.Name] {
			continue
		}
		seen[secret.Name] = true
		names = append(names, secret.Name)
	}
	sort.Strings(names)
	return names, nil
}
