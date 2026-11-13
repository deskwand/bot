// Package localhost runs commands and touches files on this Mac. It is the
// local implementation of container.Host.
package localhost

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/deskwand/bot/desktop/internal/hostexec"
)

// ExtraPath lists directories appended to the inherited PATH when a command
// runs. An app started from Finder inherits only a short PATH, so the usual
// install locations must be added explicitly.
var ExtraPath = []string{
	"/usr/local/bin",
	"/opt/homebrew/bin",
	"~/.orbstack/bin",
	"~/.rd/bin",
	"/Applications/Docker.app/Contents/Resources/bin",
}

// Host is the local machine.
type Host struct{}

// New returns a host for this Mac.
func New() *Host {
	return &Host{}
}

// Run executes command with /bin/sh. A nonzero exit status is in Result, not
// in the error.
func (h *Host) Run(ctx context.Context, command string, stdin []byte) (hostexec.Result, error) {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	configureCommand(cmd)
	cmd.Env = pathEnvironment()
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return hostexec.Result{}, ctxErr
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return hostexec.Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), ExitCode: exitErr.ExitCode()}, nil
		}
		return hostexec.Result{}, err
	}
	return hostexec.Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}, nil
}

// ReadFile returns a local file's bytes. A missing file is ErrNotExist.
func (h *Host) ReadFile(_ context.Context, path string) ([]byte, error) {
	expanded, err := expandHome(path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(expanded)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, hostexec.ErrNotExist
	}
	return data, err
}

// WriteFileAtomic writes data to a sibling temporary file, sets mode, then
// renames it over path.
func (h *Host) WriteFileAtomic(_ context.Context, path string, data []byte, mode os.FileMode) error {
	expanded, err := expandHome(path)
	if err != nil {
		return err
	}
	dir := filepath.Dir(expanded)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, "."+filepath.Base(expanded)+".tmp-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)

	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(mode.Perm()); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, expanded)
}

// pathEnvironment copies the process environment with PATH extended by
// ExtraPath. Directories that no longer exist are harmless in PATH.
func pathEnvironment() []string {
	parts := []string{}
	if base := os.Getenv("PATH"); base != "" {
		parts = append(parts, base)
	}
	for _, dir := range ExtraPath {
		if expanded, err := expandHome(dir); err == nil {
			parts = append(parts, expanded)
		}
	}
	env := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "PATH=") {
			continue
		}
		env = append(env, entry)
	}
	return append(env, "PATH="+strings.Join(parts, ":"))
}

func expandHome(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if path == "~" {
			return home, nil
		}
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}
