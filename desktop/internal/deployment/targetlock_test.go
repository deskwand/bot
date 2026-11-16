package deployment

import (
	"context"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func containerTarget(address string) domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{Address: address, Port: 22, User: "ubuntu", Dir: "~/deskwand"},
	}
}

func TestTargetLockerSeparatesTwoContainers(t *testing.T) {
	locker := NewTargetLocker()

	release, err := locker.Lock(context.Background(), containerTarget("203.0.113.7"))
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}
	defer release()

	// A second host must not wait for the first one: a restore on one
	// container cannot block a deploy on another.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	other, err := locker.Lock(ctx, containerTarget("203.0.113.8"))
	if err != nil {
		t.Fatalf("a lock on another container blocked: %v", err)
	}
	other()
}

func TestTargetLockerBlocksTheSameContainer(t *testing.T) {
	locker := NewTargetLocker()
	release, err := locker.Lock(context.Background(), containerTarget("203.0.113.7"))
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := locker.Lock(ctx, containerTarget("203.0.113.7")); err == nil {
		t.Fatal("a second lock on the same container was granted while the first was held")
	}
	release()
}
