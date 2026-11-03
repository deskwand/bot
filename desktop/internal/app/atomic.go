package app

import (
	"fmt"
	"os"
	"path/filepath"
)

// writeFileAtomic replaces path with data: a temporary file in the same
// directory, owner-only, synced and renamed over it, so a crash leaves either
// the old file or the new one and never a half-written file.
func writeFileAtomic(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("app: create temporary file: %w", err)
	}
	tempName := temp.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tempName)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("app: set file permissions: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("app: write file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("app: sync file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("app: close file: %w", err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("app: replace file: %w", err)
	}
	renamed = true
	return nil
}
