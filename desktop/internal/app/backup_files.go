package app

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// backupFilePattern matches only the files this client writes, so pruning can
// never touch a pre-restore snapshot or an unrelated file in the folder.
const backupFilePattern = "deskwand-backup-*.zip"

// backupFileName is the name the client writes for a deployment at now.
func backupFileName(scriptName string, now time.Time) string {
	return "deskwand-backup-" + scriptName + "-" + now.UTC().Format("20060102-150405") + ".zip"
}

// backupFiles lists the backup file names in dir, newest first. The timestamp
// inside the name sorts correctly, so a copied file keeps its order.
func backupFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if ok, _ := filepath.Match(backupFilePattern, entry.Name()); !ok {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	return names, nil
}

// pruneBackups keeps the newest keep backups in dir. It is best effort: a
// leftover file wastes space, a failed export loses data, so callers ignore
// the error rather than turning a finished export into an error.
func pruneBackups(dir string, keep int) error {
	names, err := backupFiles(dir)
	if err != nil {
		return err
	}
	if keep < 1 {
		keep = 1
	}
	if len(names) <= keep {
		return nil
	}
	var firstErr error
	for _, name := range names[keep:] {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
