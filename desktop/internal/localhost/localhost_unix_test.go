//go:build unix

package localhost

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunReturnsExitCodeWithoutError(t *testing.T) {
	result, err := New().Run(context.Background(), "echo out; echo err >&2; exit 3", nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if string(result.Stdout) != "out\n" || string(result.Stderr) != "err\n" || result.ExitCode != 3 {
		t.Fatalf("run = %q/%q exit %d, want out\\n/err\\n exit 3", result.Stdout, result.Stderr, result.ExitCode)
	}
}

func TestRunPassesStdin(t *testing.T) {
	result, err := New().Run(context.Background(), "cat", []byte("abc"))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if string(result.Stdout) != "abc" {
		t.Fatalf("stdout = %q, want abc", result.Stdout)
	}
}

func TestRunFindsCommandsOutsideShortPath(t *testing.T) {
	dir := t.TempDir()
	probe := filepath.Join(dir, "probe")
	if err := os.WriteFile(probe, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write probe: %v", err)
	}
	t.Setenv("PATH", "/usr/bin:/bin")
	original := ExtraPath
	ExtraPath = []string{dir}
	defer func() { ExtraPath = original }()

	result, err := New().Run(context.Background(), "probe", nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("probe exit = %d, want 0", result.ExitCode)
	}
}

func TestRunReturnsWhenGrandchildOutlivesDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	// The shell must fork so that a child survives the kill of the shell and
	// keeps the output pipes open: that is what used to block Wait.
	_, err := New().Run(ctx, "sleep 5; true", nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("run after deadline returned no error")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("run took %v, want under 2s", elapsed)
	}
}
