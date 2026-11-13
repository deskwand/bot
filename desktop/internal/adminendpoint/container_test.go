package adminendpoint

import (
	"context"
	"errors"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/sshtunnel"
)

type fakeAccess struct {
	token string
	err   error
	calls int
}

func (f *fakeAccess) AdminAccess(context.Context, domain.Target) (string, error) {
	f.calls++
	return f.token, f.err
}

type fakeTunnel struct {
	baseURL string
	err     error
	calls   int
	closed  int
}

func (f *fakeTunnel) Open(context.Context, domain.HostRef) (string, error) {
	f.calls++
	return f.baseURL, f.err
}

func (f *fakeTunnel) Close() { f.closed++ }

func localTarget() domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{Transport: domain.TransportLocal, Engine: domain.EngineCompose, Dir: "~/deskwand"},
	}
}

func TestContainerResolvesALocalTargetWithoutATunnel(t *testing.T) {
	access := &fakeAccess{token: "tok"}
	tunnel := &fakeTunnel{baseURL: "http://127.0.0.1:8787"}
	resolver := NewContainer(ContainerDeps{Access: access, Tunnel: tunnel})

	endpoint, err := resolver.Resolve(context.Background(), localTarget())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if endpoint.BaseURL != "http://127.0.0.1:8787" || endpoint.Token != "tok" {
		t.Fatalf("endpoint = %#v", endpoint)
	}
	if tunnel.calls != 0 {
		t.Fatalf("tunnel opened %d times for a local target", tunnel.calls)
	}
}

func TestContainerOpensATunnelForAnSSHTarget(t *testing.T) {
	access := &fakeAccess{token: "tok"}
	tunnel := &fakeTunnel{baseURL: "http://127.0.0.1:8787"}
	resolver := NewContainer(ContainerDeps{Access: access, Tunnel: tunnel})

	endpoint, err := resolver.Resolve(context.Background(), containerTarget())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if endpoint.BaseURL != "http://127.0.0.1:8787" {
		t.Fatalf("baseURL = %q", endpoint.BaseURL)
	}
	if tunnel.calls != 1 {
		t.Fatalf("tunnel calls = %d, want 1", tunnel.calls)
	}
}

func TestContainerCachesUntilInvalidated(t *testing.T) {
	access := &fakeAccess{token: "tok"}
	tunnel := &fakeTunnel{baseURL: "http://127.0.0.1:8787"}
	resolver := NewContainer(ContainerDeps{Access: access, Tunnel: tunnel})

	for i := 0; i < 3; i++ {
		if _, err := resolver.Resolve(context.Background(), containerTarget()); err != nil {
			t.Fatalf("Resolve: %v", err)
		}
	}
	if access.calls != 1 {
		t.Fatalf("AdminAccess calls = %d, want 1", access.calls)
	}

	resolver.Invalidate()
	if _, err := resolver.Resolve(context.Background(), containerTarget()); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if access.calls != 2 {
		t.Fatalf("AdminAccess calls after Invalidate = %d, want 2", access.calls)
	}
}

func TestContainerKeepsTheAccessError(t *testing.T) {
	access := &fakeAccess{err: domain.Error{Code: domain.ENV_FILE_INVALID, Message: "no token"}}
	resolver := NewContainer(ContainerDeps{Access: access, Tunnel: &fakeTunnel{}})
	_, err := resolver.Resolve(context.Background(), containerTarget())
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.ENV_FILE_INVALID {
		t.Fatalf("error = %v, want ENV_FILE_INVALID", err)
	}
}

type busyTunnel struct{}

func (busyTunnel) Open(context.Context, domain.HostRef) (string, error) {
	return "", sshtunnel.ErrPortBusy
}

func (busyTunnel) Close() {}

func TestContainerMapsABusyPortToItsOwnCode(t *testing.T) {
	resolver := NewContainer(ContainerDeps{Access: &fakeAccess{token: "tok"}, Tunnel: busyTunnel{}})
	_, err := resolver.Resolve(context.Background(), containerTarget())
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != CodeTunnelPortBusy {
		t.Fatalf("error = %v, want %s", err, CodeTunnelPortBusy)
	}
}

func TestUnauthorizedRecognisesTheCode(t *testing.T) {
	err := domain.Error{Code: CodeTokenRejected, Message: "401"}
	if !Unauthorized(err) {
		t.Fatal("Unauthorized(err) = false")
	}
	if Unauthorized(errors.New("boom")) {
		t.Fatal("Unauthorized(unknown) = true")
	}
}

func TestContainerReopensTheTunnelAfterADrop(t *testing.T) {
	access := &fakeAccess{token: "tok"}
	tunnel := &fakeTunnel{baseURL: "http://127.0.0.1:8787"}
	resolver := NewContainer(ContainerDeps{Access: access, Tunnel: tunnel})

	for i := 0; i < 3; i++ {
		if _, err := resolver.Resolve(context.Background(), containerTarget()); err != nil {
			t.Fatalf("Resolve %d: %v", i, err)
		}
	}
	// A dropped tunnel closes its listener, so every resolve must ask it to
	// open again; Open is idempotent for a live tunnel.
	if tunnel.calls != 3 {
		t.Fatalf("tunnel calls = %d, want 3", tunnel.calls)
	}
	if access.calls != 1 {
		t.Fatalf("AdminAccess calls = %d, want 1", access.calls)
	}
}
