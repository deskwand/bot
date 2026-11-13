package adminendpoint

import (
	"context"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

type fakeResolver struct {
	endpoint Endpoint
	err      error
	calls    int
}

func (f *fakeResolver) Resolve(context.Context, domain.Target) (Endpoint, error) {
	f.calls++
	return f.endpoint, f.err
}

func cloudflareTarget() domain.Target {
	return domain.Target{AccountID: "acc", ScriptName: "worker"}
}

func containerTarget() domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{Address: "203.0.113.7", Port: 22, User: "root", Auth: domain.SSHAuthPassword, Dir: "~/deskwand"},
	}
}

func TestRouterPicksByTargetKind(t *testing.T) {
	cloud := &fakeResolver{endpoint: Endpoint{BaseURL: "https://worker.example"}}
	box := &fakeResolver{endpoint: Endpoint{BaseURL: "http://127.0.0.1:8787"}}
	router := &Router{Cloudflare: cloud, Container: box}

	if _, err := router.Resolve(context.Background(), cloudflareTarget()); err != nil {
		t.Fatalf("cloudflare resolve: %v", err)
	}
	if _, err := router.Resolve(context.Background(), containerTarget()); err != nil {
		t.Fatalf("container resolve: %v", err)
	}
	if cloud.calls != 1 || box.calls != 1 {
		t.Fatalf("calls = %d/%d, want 1/1", cloud.calls, box.calls)
	}
}
