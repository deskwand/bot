package adminendpoint

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/platform"
)

// CloudflareDeps are the services the Cloudflare resolver needs.
type CloudflareDeps struct {
	Snapshots    backup.SnapshotReader
	Publisher    backup.Publisher
	Credentials  platform.CredentialStore
	HTTP         *http.Client
	ReadyTimeout time.Duration
	Locale       func() string
}

// Cloudflare resolves a Worker target from its snapshot's PUBLIC_BASE_URL and
// the vault's ADMIN_TOKEN, publishing the token the first time.
type Cloudflare struct {
	deps CloudflareDeps
	// mu serializes Resolve: it may publish a Worker version, and two
	// concurrent publishes would race.
	mu sync.Mutex
}

// NewCloudflare returns a resolver for Cloudflare targets.
func NewCloudflare(deps CloudflareDeps) *Cloudflare {
	return &Cloudflare{deps: deps}
}

func (c *Cloudflare) lang() string {
	if c.deps.Locale == nil {
		return i18n.ZH
	}
	return c.deps.Locale()
}

// Resolve reads the deployment's public URL, ensures ADMIN_TOKEN exists, and
// waits for a freshly published token to reach the Worker.
func (c *Cloudflare) Resolve(ctx context.Context, target domain.Target) (Endpoint, error) {
	if c.deps.Snapshots == nil || c.deps.Publisher == nil || c.deps.Credentials == nil {
		return Endpoint{}, domain.Error{Code: CodeServiceUnavailable, Message: "the admin endpoint is not wired"}
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	snapshot, err := c.deps.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return Endpoint{}, err
	}
	baseURL := backup.PublicBaseURL(snapshot.SettingsJSON)
	if baseURL == "" {
		return Endpoint{}, domain.Error{
			Code:    CodeAdminUnavailable,
			Message: i18n.T(c.lang(), "adminendpoint.unavailable"),
		}
	}
	token, published, err := backup.EnsureAdminToken(ctx, backup.TokenDeps{
		Snapshots:   c.deps.Snapshots,
		Publisher:   c.deps.Publisher,
		Credentials: c.deps.Credentials,
	}, target)
	if err != nil {
		return Endpoint{}, err
	}
	if published {
		// Info is lease-checked, so a 409 already proves the route and token
		// are live. This reuses the backup flow's propagation window.
		wait := backup.NewAdminClient(baseURL, token, "", c.deps.HTTP)
		waitDeps := backup.Deps{HTTP: c.deps.HTTP, ReadyTimeout: c.deps.ReadyTimeout}
		if err := backup.WaitForAdmin(ctx, waitDeps, wait); err != nil {
			return Endpoint{}, domain.Error{
				Code:    CodeAdminUnavailable,
				Message: i18n.T(c.lang(), "adminendpoint.unavailable"),
			}
		}
	}
	return Endpoint{BaseURL: baseURL, Token: token, HTTP: c.deps.HTTP}, nil
}
