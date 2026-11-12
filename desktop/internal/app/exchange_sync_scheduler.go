package app

import (
	"context"
	"time"
)

// exchangeSyncInterval is fixed: the desktop refreshes Binance every five
// minutes while it is open. There is no setting for it.
const exchangeSyncInterval = 5 * time.Minute

// ExchangeSyncScheduler pushes the local Binance bundle on a fixed interval.
// It lives only as long as the process; a closed client simply does not sync.
type ExchangeSyncScheduler struct {
	step func(context.Context)
	tick time.Duration
}

// NewExchangeSyncScheduler returns a scheduler that calls step immediately and
// then once per interval.
func NewExchangeSyncScheduler(step func(context.Context)) *ExchangeSyncScheduler {
	return &ExchangeSyncScheduler{step: step, tick: exchangeSyncInterval}
}

// Run steps until ctx is done. The first step runs immediately so a client
// that just started refreshes stale balances without waiting five minutes.
func (s *ExchangeSyncScheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.tick)
	defer ticker.Stop()
	s.step(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.step(ctx)
		}
	}
}
