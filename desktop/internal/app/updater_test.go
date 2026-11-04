package app

import "testing"

func TestCheckClientUpdatesOpensUpdaterWindow(t *testing.T) {
	calls := 0
	s := NewService(ServiceOptions{CheckClientUpdates: func() { calls++ }})
	if err := s.CheckClientUpdates(); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
}
