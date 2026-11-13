package adminendpoint

import (
	"context"
	"errors"
	"sync"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/sshtunnel"
)

// Access reads one container's admin token. *container.Service implements it.
type Access interface {
	AdminAccess(ctx context.Context, target domain.Target) (string, error)
}

// Tunnel opens the loopback forward for an SSH target. *sshtunnel.Manager
// implements it; a local target never uses it.
type Tunnel interface {
	Open(ctx context.Context, host domain.HostRef) (baseURL string, err error)
	Close()
}

// ContainerDeps are the services the container resolver needs.
type ContainerDeps struct {
	Access Access
	Tunnel Tunnel
	Locale func() string // error language; nil means zh
}

// Container resolves container targets: the token comes from the deployment's
// own .env, and SSH targets reach it through the loopback tunnel.
type Container struct {
	deps ContainerDeps

	// mu serializes Resolve so two pages opening together dial the host once.
	mu    sync.Mutex
	cache map[domain.Target]string
}

// NewContainer returns a resolver for container targets.
func NewContainer(deps ContainerDeps) *Container {
	return &Container{deps: deps, cache: map[domain.Target]string{}}
}

// Resolve returns an endpoint for target. The token is read at most once per
// target until Invalidate is called; the tunnel is asked to open on every call
// because a dropped connection closes its listener, and Open is idempotent for
// a tunnel that is still up.
func (c *Container) Resolve(ctx context.Context, target domain.Target) (Endpoint, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.deps.Access == nil {
		return Endpoint{}, domain.Error{Code: CodeServiceUnavailable, Message: "the container runtime is not wired"}
	}
	token, ok := c.cache[target]
	if !ok {
		var err error
		token, err = c.deps.Access.AdminAccess(ctx, target)
		if err != nil {
			return Endpoint{}, err
		}
		c.cache[target] = token
	}
	baseURL := "http://" + sshtunnel.AdminAddr
	if !target.Host.IsLocal() {
		if c.deps.Tunnel == nil {
			return Endpoint{}, domain.Error{Code: CodeServiceUnavailable, Message: "the admin tunnel is not wired"}
		}
		var err error
		baseURL, err = c.deps.Tunnel.Open(ctx, target.Host)
		if err != nil {
			if errors.Is(err, sshtunnel.ErrPortBusy) {
				return Endpoint{}, domain.Error{Code: CodeTunnelPortBusy, Message: i18n.T(c.lang(), "adminendpoint.portBusy")}
			}
			return Endpoint{}, err
		}
	}
	return Endpoint{BaseURL: baseURL, Token: token}, nil
}

// Invalidate drops every cached endpoint. One target is managed at a time, so
// clearing all of them cannot confuse two deployments.
func (c *Container) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache = map[domain.Target]string{}
}

func (c *Container) lang() string {
	if c.deps.Locale == nil {
		return i18n.ZH
	}
	return c.deps.Locale()
}
