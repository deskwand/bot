package app

import (
	"errors"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func newResidentialStore(t *testing.T) *FileTargetStore {
	t.Helper()
	store, err := NewFileTargetStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileTargetStore: %v", err)
	}
	return store
}

var (
	cloudHouse = domain.Target{AccountID: "0123456789abcdef0123456789abcdef", ScriptName: "deskwand-bot"}
	boxHouse   = domain.Target{Kind: domain.TargetContainer, Host: domain.HostRef{
		Transport: domain.TransportSSH, Engine: domain.EngineCompose,
		Address: "10.0.0.5", Port: 22, User: "bot", Auth: domain.SSHAuthAgent, Dir: "/home/bot/deskwand",
	}}
)

func TestLoadHasNoPreviousForLegacyFile(t *testing.T) {
	store := newResidentialStore(t)
	if err := store.Save(cloudHouse); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, ok, err := store.Previous(); err != nil || ok {
		t.Fatalf("Previous() = ok %v, err %v; want false, nil", ok, err)
	}
}

func TestSaveKeepsPrevious(t *testing.T) {
	store := newResidentialStore(t)
	if err := store.Save(cloudHouse); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := store.SetPrevious(boxHouse); err != nil {
		t.Fatalf("SetPrevious: %v", err)
	}
	if err := store.Save(cloudHouse); err != nil {
		t.Fatalf("Save again: %v", err)
	}
	previous, ok, err := store.Previous()
	if err != nil || !ok {
		t.Fatalf("Previous() = ok %v, err %v; want true, nil", ok, err)
	}
	if previous != boxHouse {
		t.Fatalf("Previous() = %+v, want %+v", previous, boxHouse)
	}
}

func TestSwapResidenceExchangesSlots(t *testing.T) {
	store := newResidentialStore(t)
	if err := store.Save(cloudHouse); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := store.SetPrevious(boxHouse); err != nil {
		t.Fatalf("SetPrevious: %v", err)
	}
	if err := store.SwapResidence(); err != nil {
		t.Fatalf("SwapResidence: %v", err)
	}
	current, ok, err := store.Load()
	if err != nil || !ok || current != boxHouse {
		t.Fatalf("Load() = %+v ok %v err %v; want %+v", current, ok, err, boxHouse)
	}
	previous, ok, err := store.Previous()
	if err != nil || !ok || previous != cloudHouse {
		t.Fatalf("Previous() = %+v ok %v err %v; want %+v", previous, ok, err, cloudHouse)
	}
}

func TestSwapResidenceWithoutPrevious(t *testing.T) {
	store := newResidentialStore(t)
	if err := store.Save(cloudHouse); err != nil {
		t.Fatalf("Save: %v", err)
	}
	err := store.SwapResidence()
	var coded domain.Error
	if err == nil || !errors.As(err, &coded) || coded.Code != CodeMoveNoPrevious {
		t.Fatalf("SwapResidence() = %v, want %s", err, CodeMoveNoPrevious)
	}
	current, _, _ := store.Load()
	if current != cloudHouse {
		t.Fatalf("Load() = %+v, want unchanged %+v", current, cloudHouse)
	}
}

func TestClearPrevious(t *testing.T) {
	store := newResidentialStore(t)
	if err := store.Save(cloudHouse); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := store.SetPrevious(boxHouse); err != nil {
		t.Fatalf("SetPrevious: %v", err)
	}
	if err := store.ClearPrevious(); err != nil {
		t.Fatalf("ClearPrevious: %v", err)
	}
	if _, ok, err := store.Previous(); err != nil || ok {
		t.Fatalf("Previous() = ok %v err %v; want false, nil", ok, err)
	}
	// The file must still hold the current residence.
	if current, ok, _ := store.Load(); !ok || current != cloudHouse {
		t.Fatalf("Load() = %+v ok %v, want %+v", current, ok, cloudHouse)
	}
}
