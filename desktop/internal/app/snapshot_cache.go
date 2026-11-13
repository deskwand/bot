package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// snapshotCacheVersion is the on-disk format this build understands. A file
// with any other version is treated as no cache, so an upgrade that changes
// the format never feeds stale shapes to the frontend.
const snapshotCacheVersion = 1

// SnapshotCache keeps the last successful config and status per target on
// disk so the app can paint the last known data before the network answers.
// It stores frontend DTOs only: no token, no raw configuration.
type SnapshotCache interface {
	LoadConfig(target domain.Target) (ConfigDTO, time.Time, bool)
	SaveConfig(target domain.Target, config ConfigDTO, at time.Time) error
	LoadStatus(target domain.Target) ([]StatusItemDTO, time.Time, bool)
	SaveStatus(target domain.Target, items []StatusItemDTO, at time.Time) error
	Clear() error
}

// FileSnapshotCache persists snapshots as JSON under <dataDir>/cache, one file
// per target.
type FileSnapshotCache struct {
	dir string
	mu  sync.Mutex
}

type snapshotCacheFile struct {
	Version    int                  `json:"version"`
	Kind       string               `json:"kind,omitempty"`
	AccountID  string               `json:"accountId"`
	ScriptName string               `json:"scriptName"`
	Host       *hostSettings        `json:"host,omitempty"`
	Config     *snapshotCacheConfig `json:"config,omitempty"`
	Status     *snapshotCacheStatus `json:"status,omitempty"`
}

type snapshotCacheConfig struct {
	Data    ConfigDTO `json:"data"`
	SavedAt time.Time `json:"savedAt"`
}

type snapshotCacheStatus struct {
	Data    []StatusItemDTO `json:"data"`
	SavedAt time.Time       `json:"savedAt"`
}

// NewFileSnapshotCache creates the cache directory if needed and returns a
// cache under <dataDir>/cache.
func NewFileSnapshotCache(dataDir string) (*FileSnapshotCache, error) {
	if strings.TrimSpace(dataDir) == "" {
		return nil, errors.New("app: app data directory is empty")
	}
	dir := filepath.Join(dataDir, "cache")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("app: create snapshot cache directory: %w", err)
	}
	return &FileSnapshotCache{dir: dir}, nil
}

func (c *FileSnapshotCache) pathFor(target domain.Target) string {
	sum := sha256.Sum256([]byte(cacheIdentity(target)))
	return filepath.Join(c.dir, hex.EncodeToString(sum[:])[:16]+".json")
}

// cacheIdentity names one cached target. Cloudflare targets keep the account
// and script key, while a container is identified by its host and directory so
// two hosts never share a file.
func cacheIdentity(target domain.Target) string {
	if target.IsContainer() {
		host := target.Host
		return domain.TargetContainer + "\x00" + host.Address + "\x00" + strconv.Itoa(host.Port) + "\x00" + host.User + "\x00" + host.Dir
	}
	return target.AccountID + "/" + target.ScriptName
}

func cacheKind(target domain.Target) string {
	if target.IsContainer() {
		return domain.TargetContainer
	}
	return ""
}

func cacheHost(target domain.Target) *hostSettings {
	if !target.IsContainer() {
		return nil
	}
	return &hostSettings{
		Address: target.Host.Address,
		Port:    target.Host.Port,
		User:    target.Host.User,
		Auth:    target.Host.Auth,
		KeyPath: target.Host.KeyPath,
		Dir:     target.Host.Dir,
	}
}

// LoadConfig returns the cached config for target, or ok=false when there is
// none.
func (c *FileSnapshotCache) LoadConfig(target domain.Target) (ConfigDTO, time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	file, ok := c.read(target)
	if !ok || file.Config == nil {
		return ConfigDTO{}, time.Time{}, false
	}
	return file.Config.Data, file.Config.SavedAt, true
}

// SaveConfig writes the config section and keeps an existing status section.
func (c *FileSnapshotCache) SaveConfig(target domain.Target, config ConfigDTO, at time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	file, _ := c.read(target)
	file.Version = snapshotCacheVersion
	file.Kind = cacheKind(target)
	file.AccountID = target.AccountID
	file.ScriptName = target.ScriptName
	file.Host = cacheHost(target)
	file.Config = &snapshotCacheConfig{Data: config, SavedAt: at}
	return c.write(target, file)
}

// LoadStatus returns the cached status items for target, or ok=false when
// there are none.
func (c *FileSnapshotCache) LoadStatus(target domain.Target) ([]StatusItemDTO, time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	file, ok := c.read(target)
	if !ok || file.Status == nil {
		return nil, time.Time{}, false
	}
	return file.Status.Data, file.Status.SavedAt, true
}

// SaveStatus writes the status section and keeps an existing config section.
func (c *FileSnapshotCache) SaveStatus(target domain.Target, items []StatusItemDTO, at time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	file, _ := c.read(target)
	file.Version = snapshotCacheVersion
	file.Kind = cacheKind(target)
	file.AccountID = target.AccountID
	file.ScriptName = target.ScriptName
	file.Host = cacheHost(target)
	file.Status = &snapshotCacheStatus{Data: items, SavedAt: at}
	return c.write(target, file)
}

// Clear removes every cached snapshot.
func (c *FileSnapshotCache) Clear() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.RemoveAll(c.dir); err != nil {
		return fmt.Errorf("app: clear snapshot cache: %w", err)
	}
	return nil
}

// read decodes one target's file. A missing file, an undecodable file, an
// unknown version or a file that belongs to another target all mean no cache;
// unusable files are deleted so they cannot linger.
func (c *FileSnapshotCache) read(target domain.Target) (snapshotCacheFile, bool) {
	path := c.pathFor(target)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return snapshotCacheFile{}, false
	}
	if err != nil {
		return snapshotCacheFile{}, false
	}
	var file snapshotCacheFile
	if err := json.Unmarshal(data, &file); err != nil {
		_ = os.Remove(path)
		return snapshotCacheFile{}, false
	}
	if file.Version != snapshotCacheVersion || !cacheBelongsTo(file, target) {
		_ = os.Remove(path)
		return snapshotCacheFile{}, false
	}
	return file, true
}

// cacheBelongsTo reports whether the decoded file was written for target. It
// checks the kind and the full host, so a stale Cloudflare file can never be
// read for a container target and two hosts cannot collide.
func cacheBelongsTo(file snapshotCacheFile, target domain.Target) bool {
	if file.Kind != cacheKind(target) {
		return false
	}
	if target.IsContainer() {
		return file.Host != nil && file.Host.target() == target.Host
	}
	return file.AccountID == target.AccountID && file.ScriptName == target.ScriptName
}

func (c *FileSnapshotCache) write(target domain.Target, file snapshotCacheFile) error {
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("app: encode snapshot cache: %w", err)
	}
	data = append(data, '\n')
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return fmt.Errorf("app: create snapshot cache directory: %w", err)
	}
	return writeFileAtomic(c.pathFor(target), data)
}
