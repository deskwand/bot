package container

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// touched counts everything a deploy did to the host.
func touched(host *fakeHost) int {
	return host.writes + len(host.commands) + len(host.reads)
}

// recordingLocker records that a deploy asked for the target lock.
type recordingLocker struct {
	locked   int
	released int
	err      error
}

func (l *recordingLocker) Lock(context.Context, domain.Target) (func(), error) {
	if l.err != nil {
		return nil, l.err
	}
	l.locked++
	return func() { l.released++ }, nil
}

func TestApplyTakesTheTargetLock(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{}}
	locker := &recordingLocker{}
	service := New(Options{
		Dial:    func(domain.Target) (Host, error) { return host, nil },
		Version: "1.2.3",
		Locker:  locker,
	})

	// The deploy itself may fail on the fixture; what matters is that it asked
	// for the lock before touching the host.
	_, _ = service.Apply(context.Background(), containerTarget(), domain.Change{})

	if locker.locked != 1 || locker.released != 1 {
		t.Fatalf("lock calls = %d / %d, want 1 / 1", locker.locked, locker.released)
	}
}

func TestApplyStopsWhenTheTargetIsBusy(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{}}
	busy := errors.New("a restore is running")
	service := New(Options{
		Dial:    func(domain.Target) (Host, error) { return host, nil },
		Version: "1.2.3",
		Locker:  &recordingLocker{err: busy},
	})

	if _, err := service.Apply(context.Background(), containerTarget(), domain.Change{}); !errors.Is(err, busy) {
		t.Fatalf("err = %v, want the locker's error", err)
	}
	if host.writes != 0 {
		t.Fatalf("the host was written %d times while the target was busy", host.writes)
	}
}

func TestApplyWaitsForTheTargetAndWritesNothingUntilReleased(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{}}
	locker := deployment.NewTargetLocker()
	target := containerTarget()

	release, err := locker.Lock(context.Background(), target)
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}

	service := New(Options{
		Dial:    func(domain.Target) (Host, error) { return host, nil },
		Version: "1.2.3",
		Locker:  locker,
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = service.Apply(context.Background(), target, domain.Change{})
	}()

	// While the target is busy (a restore holds the lock) the deploy must not
	// touch the host at all: this is the incident that broke a live restore.
	time.Sleep(100 * time.Millisecond)
	if touched(host) != 0 {
		t.Fatalf("the deploy touched the host %d times while the target was busy", touched(host))
	}
	select {
	case <-done:
		t.Fatal("the deploy finished while the target was busy")
	default:
	}

	release()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the deploy did not start after the lock was released")
	}
	if touched(host) == 0 {
		t.Fatal("the deploy never reached the host after the lock was released")
	}
}

func TestRollbackAndStopTakeTheTargetLock(t *testing.T) {
	for name, call := range map[string]func(*Service) error{
		"RestorePrevious": func(s *Service) error {
			_, err := s.RestorePrevious(context.Background(), containerTarget())
			return err
		},
		"StopTarget": func(s *Service) error {
			return s.StopTarget(context.Background(), containerTarget())
		},
		"StartTarget": func(s *Service) error {
			return s.StartTarget(context.Background(), containerTarget())
		},
	} {
		locker := &recordingLocker{}
		host := &fakeHost{files: map[string][]byte{}}
		service := New(Options{
			Dial:    func(domain.Target) (Host, error) { return host, nil },
			Version: "1.2.3",
			Locker:  locker,
		})
		_ = call(service)
		if locker.locked != 1 || locker.released != 1 {
			t.Fatalf("%s lock calls = %d / %d, want 1 / 1", name, locker.locked, locker.released)
		}
	}
}
