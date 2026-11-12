package app

import (
	"context"
	"testing"
	"time"
)

func TestSchedulerRunsImmediatelyThenOnTick(t *testing.T) {
	steps := make(chan struct{}, 64)
	scheduler := NewExchangeSyncScheduler(func(context.Context) {
		select {
		case steps <- struct{}{}:
		default:
		}
	})
	scheduler.tick = time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		scheduler.Run(ctx)
	}()

	for index := 0; index < 2; index++ {
		select {
		case <-steps:
		case <-time.After(2 * time.Second):
			cancel()
			t.Fatalf("scheduler did not step %d time(s)", index+1)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}
}
