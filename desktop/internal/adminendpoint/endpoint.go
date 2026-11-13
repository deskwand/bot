// Package adminendpoint resolves where and how a target's /admin/* requests
// go: the base URL, the bearer token, and the http.Client to use.
package adminendpoint

import (
	"context"
	"errors"
	"net/http"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// Stable error codes returned by this package.
const (
	// CodeTokenRejected reports that /admin/* rejected the bearer token.
	CodeTokenRejected = "ADMIN_TOKEN_REJECTED"
	// CodeTunnelPortBusy reports that 127.0.0.1:8787 is taken, so the tunnel
	// and the MCP callback cannot work.
	CodeTunnelPortBusy = "TUNNEL_PORT_BUSY"
	// CodeAdminUnavailable reports a deployment whose admin API cannot be
	// reached at all: no PUBLIC_BASE_URL, or a freshly published token that
	// never became live.
	CodeAdminUnavailable = "ADMIN_ENDPOINT_UNAVAILABLE"
	// CodeServiceUnavailable mirrors app.CodeServiceUnavailable; this package
	// cannot import app.
	CodeServiceUnavailable = "SERVICE_UNAVAILABLE"
)

// Endpoint is one resolved admin surface.
type Endpoint struct {
	BaseURL string
	Token   string
	HTTP    *http.Client // nil lets the client apply its own default policy
}

// Resolver turns a target into an Endpoint.
type Resolver interface {
	Resolve(ctx context.Context, target domain.Target) (Endpoint, error)
}

// Invalidator drops anything a resolver cached.
type Invalidator interface {
	Invalidate()
}

// Router sends each target to the resolver that owns its kind.
type Router struct {
	Cloudflare Resolver
	Container  Resolver
}

// Resolve picks the resolver for the target's kind.
func (r *Router) Resolve(ctx context.Context, target domain.Target) (Endpoint, error) {
	if target.IsContainer() {
		if r.Container == nil {
			return Endpoint{}, errors.New("adminendpoint: container resolver is not wired")
		}
		return r.Container.Resolve(ctx, target)
	}
	if r.Cloudflare == nil {
		return Endpoint{}, errors.New("adminendpoint: cloudflare resolver is not wired")
	}
	return r.Cloudflare.Resolve(ctx, target)
}

// Invalidate drops the container resolver's cache. The Cloudflare resolver
// keeps nothing between calls.
func (r *Router) Invalidate() {
	if invalidator, ok := r.Container.(Invalidator); ok {
		invalidator.Invalidate()
	}
}

// Unauthorized reports whether err says the admin token was rejected.
func Unauthorized(err error) bool {
	var coded domain.Error
	if !errors.As(err, &coded) {
		return false
	}
	return coded.Code == CodeTokenRejected
}
