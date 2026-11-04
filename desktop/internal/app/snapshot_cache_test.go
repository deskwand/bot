package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

var (
	cacheTargetA = domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName}
	cacheTargetB = domain.Target{AccountID: "ffffffffffffffffffffffffffffffff", ScriptName: serviceWorkerName}
	cacheSavedAt = time.Unix(1700000000, 0).UTC()
)

func snapshotCachePath(t *testing.T, dataDir string, target domain.Target) string {
	t.Helper()
	sum := sha256.Sum256([]byte(target.AccountID + "/" + target.ScriptName))
	name := hex.EncodeToString(sum[:])[:16] + ".json"
	return filepath.Join(dataDir, "cache", name)
}

func sampleConfigDTO() ConfigDTO {
	return ConfigDTO{
		AccountID:          serviceAccountID,
		WorkerName:         serviceWorkerName,
		Fingerprint:        "fingerprint-1",
		ActiveVersionCount: 1,
		ConfigPresent:      true,
		ActiveChannel:      "wechat",
		OwnerUserIDs:       []int64{42, 43},
		ButlerModel:        &ModelDTO{Provider: "anthropic", ID: "claude-sonnet-5-5"},
		McpServers:         json.RawMessage("[]"),
		Secrets:            []SecretNameDTO{{Name: "ANTHROPIC_API_KEY", Configured: true}},
	}
}

func sampleStatusDTO() []StatusItemDTO {
	return []StatusItemDTO{{
		Kind:       "worker",
		State:      "ok",
		Source:     "cloudflare",
		ObservedAt: "2026-11-04T00:00:00Z",
		Detail:     "部署正常",
	}}
}

func TestSnapshotCacheRoundTrip(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	config := sampleConfigDTO()
	status := sampleStatusDTO()
	if err := cache.SaveConfig(cacheTargetA, config, cacheSavedAt); err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveStatus(cacheTargetA, status, cacheSavedAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	gotConfig, gotConfigAt, ok := cache.LoadConfig(cacheTargetA)
	if !ok {
		t.Fatal("config cache missing")
	}
	if !reflect.DeepEqual(gotConfig, config) {
		t.Fatalf("config = %#v", gotConfig)
	}
	if !gotConfigAt.Equal(cacheSavedAt) {
		t.Fatalf("config savedAt = %v", gotConfigAt)
	}

	gotStatus, gotStatusAt, ok := cache.LoadStatus(cacheTargetA)
	if !ok {
		t.Fatal("status cache missing")
	}
	if !reflect.DeepEqual(gotStatus, status) {
		t.Fatalf("status = %#v", gotStatus)
	}
	if !gotStatusAt.Equal(cacheSavedAt.Add(time.Minute)) {
		t.Fatalf("status savedAt = %v", gotStatusAt)
	}
}

func TestSnapshotCacheKeepsOtherSection(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveStatus(cacheTargetA, sampleStatusDTO(), cacheSavedAt); err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveConfig(cacheTargetA, sampleConfigDTO(), cacheSavedAt); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := cache.LoadStatus(cacheTargetA); !ok {
		t.Fatal("SaveConfig dropped the status section")
	}
}

func TestSnapshotCacheIsolatesTargets(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveConfig(cacheTargetA, sampleConfigDTO(), cacheSavedAt); err != nil {
		t.Fatal(err)
	}
	for _, target := range []domain.Target{
		{AccountID: cacheTargetB.AccountID, ScriptName: cacheTargetA.ScriptName},
		{AccountID: cacheTargetA.AccountID, ScriptName: "another-worker"},
	} {
		if _, _, ok := cache.LoadConfig(target); ok {
			t.Fatalf("target %#v read another target's cache", target)
		}
	}
}

func TestSnapshotCacheIgnoresAndRemovesCorrupt(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	path := snapshotCachePath(t, dataDir, cacheTargetA)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := cache.LoadConfig(cacheTargetA); ok {
		t.Fatal("corrupt cache was used")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("corrupt cache was not removed: %v", err)
	}
}

func TestSnapshotCacheIgnoresOtherVersion(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	path := snapshotCachePath(t, dataDir, cacheTargetA)
	body := `{"version":2,"accountId":"` + cacheTargetA.AccountID + `","scriptName":"` + cacheTargetA.ScriptName + `"}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := cache.LoadConfig(cacheTargetA); ok {
		t.Fatal("cache with another version was used")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cache with another version was not removed: %v", err)
	}
}

func TestSnapshotCacheRejectsMismatchedTarget(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	path := snapshotCachePath(t, dataDir, cacheTargetA)
	body := `{"version":1,"accountId":"` + cacheTargetB.AccountID + `","scriptName":"` + cacheTargetA.ScriptName + `"}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := cache.LoadConfig(cacheTargetA); ok {
		t.Fatal("cache with another target was used")
	}
}

func TestSnapshotCacheClear(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveConfig(cacheTargetA, sampleConfigDTO(), cacheSavedAt); err != nil {
		t.Fatal(err)
	}
	if err := cache.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "cache")); !os.IsNotExist(err) {
		t.Fatalf("cache directory still exists: %v", err)
	}
	if _, _, ok := cache.LoadConfig(cacheTargetA); ok {
		t.Fatal("cache survived Clear")
	}
	if err := cache.SaveConfig(cacheTargetA, sampleConfigDTO(), cacheSavedAt); err != nil {
		t.Fatalf("save after Clear: %v", err)
	}
	if _, _, ok := cache.LoadConfig(cacheTargetA); !ok {
		t.Fatal("save after Clear did not recreate the cache")
	}
}

func TestSnapshotCacheFilePermissions(t *testing.T) {
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.SaveConfig(cacheTargetA, sampleConfigDTO(), cacheSavedAt); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(snapshotCachePath(t, dataDir, cacheTargetA))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode = %o", perm)
	}
}
