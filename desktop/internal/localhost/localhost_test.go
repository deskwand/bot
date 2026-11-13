//go:build unix

package localhost

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/hostexec"
)

func TestReadFileMissingIsErrNotExist(t *testing.T) {
	_, err := New().ReadFile(context.Background(), filepath.Join(t.TempDir(), "missing"))
	if !errors.Is(err, hostexec.ErrNotExist) {
		t.Fatalf("read missing = %v, want hostexec.ErrNotExist", err)
	}
}

func TestWriteFileAtomicCreatesParentsAndSetsMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a b", "c", ".env")
	const content = "A=x\n"
	if err := New().WriteFileAtomic(context.Background(), path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != content {
		t.Fatalf("content = %q, want %q", data, content)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestWriteFileAtomicExpandsHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := New().WriteFileAtomic(context.Background(), "~/x", []byte("y"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "x")); err != nil {
		t.Fatalf("home file missing: %v", err)
	}
}
