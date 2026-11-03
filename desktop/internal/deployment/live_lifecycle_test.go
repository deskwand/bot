package deployment

// Opt-in live lifecycle test. It is never run by `go test ./...` without
// DESKWAND_CF_LIVE_TEST=1, and every created name must start with
// "deskwand-probe-".
//
// Build and sign a disposable release with the committed TEST-ONLY fixture key
// (never a production key):
//
//   npm run release:worker -- --version 1.0.0 --key-id test-only-do-not-use --min-from-version 0.9.0
//   DESKWAND_RELEASE_SIGNING_KEY_FILE=contracts/fixtures/release/TEST-ONLY-signing-key.pem npm run release:sign
//   DESKWAND_CF_LIVE_TEST=1 \
//   DESKWAND_CF_TEST_ACCOUNT=<32 hex account id> \
//   DESKWAND_CF_TEST_TOKEN=<token> \
//   DESKWAND_RELEASE_DIR=$PWD/dist/worker-release \
//   go test ./internal/deployment -run TestLiveLifecycle -v
//
// This test trusts the committed TEST-ONLY public key only here, and only the
// release manifest's own keyId.
//
// If a run is interrupted before cleanup, sweep stale test resources manually
// by listing workers and buckets with the "deskwand-probe-" prefix. The test
// only deletes the exact worker and bucket names it generated.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
)

func TestLiveLifecycle(t *testing.T) {
	if os.Getenv("DESKWAND_CF_LIVE_TEST") != "1" {
		t.Skip("dedicated account opt-in required (DESKWAND_CF_LIVE_TEST=1)")
	}
	accountID := strings.TrimSpace(os.Getenv("DESKWAND_CF_TEST_ACCOUNT"))
	token := strings.TrimSpace(os.Getenv("DESKWAND_CF_TEST_TOKEN"))
	releaseDir := strings.TrimSpace(os.Getenv("DESKWAND_RELEASE_DIR"))
	if accountID == "" || token == "" || releaseDir == "" {
		t.Fatal("DESKWAND_CF_TEST_ACCOUNT, DESKWAND_CF_TEST_TOKEN and DESKWAND_RELEASE_DIR are required")
	}
	pkg := loadLivePackage(t, releaseDir)

	suffix := randomLiveSuffix(t)
	workerName := "deskwand-probe-lifecycle-" + suffix
	bucketName := "deskwand-probe-lifecycle-" + suffix
	if !strings.HasPrefix(workerName, "deskwand-probe-") || !strings.HasPrefix(bucketName, "deskwand-probe-") {
		t.Fatal("refusing non-probe names")
	}
	if err := cloudflare.ValidateWorkerName(workerName); err != nil {
		t.Fatal(err)
	}
	if err := cloudflare.ValidateBucketName(bucketName); err != nil {
		t.Fatal(err)
	}

	client := cloudflare.New(cloudflare.Options{
		Token: func(context.Context) (string, error) { return token, nil },
	})
	target := domain.Target{AccountID: accountID, ScriptName: workerName}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if !strings.HasPrefix(target.ScriptName, "deskwand-probe-") || !strings.HasPrefix(bucketName, "deskwand-probe-") {
			t.Errorf("cleanup: refusing non-probe name")
			return
		}
		if err := client.DeleteScript(ctx, target); err != nil && !errors.Is(err, cloudflare.ErrNotFound) {
			t.Errorf("cleanup: delete worker: %v", err)
		}
		if err := client.DeleteR2Bucket(ctx, accountID, bucketName); err != nil && !errors.Is(err, cloudflare.ErrNotFound) {
			t.Errorf("cleanup: delete bucket: %v", err)
		}
	})

	journal, err := NewJournal(filepath.Join(t.TempDir(), "journal"))
	if err != nil {
		t.Fatal(err)
	}
	lifecycle := NewLifecycle(client, journal, pkg, platform.NewMemoryCredentialStore(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	result, err := lifecycle.Install(ctx, InstallRequest{
		AccountID:     accountID,
		WorkerName:    workerName,
		BucketName:    bucketName,
		ActiveChannel: ChannelTelegram,
		Config: InstallConfig{
			TelegramUserIDs: []int64{},
			ButlerModel:     liveModel(t, "butler"),
			TaskModel:       liveModel(t, "task"),
		},
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("install state = %q", result.State)
	}

	installed, err := client.ReadSnapshot(ctx, target)
	if err != nil {
		t.Fatalf("read installed snapshot: %v", err)
	}
	if installed.ReleaseVersion != pkg.Version() {
		t.Fatalf("release version = %q, want %q", installed.ReleaseVersion, pkg.Version())
	}
	installedIdentity, err := resourceIdentity(installed.SettingsJSON)
	if err != nil {
		t.Fatal(err)
	}
	if len(installedIdentity.DurableObjects) == 0 || len(installedIdentity.R2Buckets) == 0 {
		t.Fatalf("installed identity is empty: %#v", installedIdentity)
	}
	for name, namespaceID := range installedIdentity.DurableObjects {
		if namespaceID == "" {
			t.Fatalf("installed Durable Object %q has no namespace_id", name)
		}
	}

	owner := []int64{123456789}
	if _, err := lifecycle.ConfirmImport(ctx, target, ImportConfirmation{
		BaseFingerprint: installed.Fingerprint,
		TelegramUserIDs: &owner,
	}); err != nil {
		t.Fatalf("publish config change: %v", err)
	}

	// Observation only: report whether a version upload preserves the
	// script-level observability settings. This must not fail the lifecycle.
	var scriptSettings struct {
		Observability struct {
			Enabled bool `json:"enabled"`
		} `json:"observability"`
	}
	settingsPath := "/accounts/" + accountID + "/workers/scripts/" + workerName + "/script-settings"
	if err := client.GetJSON(ctx, settingsPath, nil, &scriptSettings); err != nil {
		t.Logf("RESULT observability after version publish: enabled=unknown (read failed)")
	} else {
		t.Logf("RESULT observability after version publish: enabled=%v", scriptSettings.Observability.Enabled)
	}

	updated, err := client.ReadSnapshot(ctx, target)
	if err != nil {
		t.Fatalf("read updated snapshot: %v", err)
	}
	if !strings.Contains(string(updated.ConfigJSON), "123456789") {
		t.Fatalf("published owner is missing from config: %s", updated.ConfigJSON)
	}

	upgraded, err := lifecycle.Upgrade(ctx, target, pkg)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	if upgraded.State != StatePublished {
		t.Fatalf("upgrade state = %q", upgraded.State)
	}
	after, err := client.ReadSnapshot(ctx, target)
	if err != nil {
		t.Fatalf("read upgraded snapshot: %v", err)
	}
	afterIdentity, err := resourceIdentity(after.SettingsJSON)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(installedIdentity, afterIdentity) {
		t.Fatalf("resource identity changed: before=%#v after=%#v", installedIdentity, afterIdentity)
	}
	if after.ReleaseVersion != pkg.Version() {
		t.Fatalf("upgraded release version = %q", after.ReleaseVersion)
	}
}

func liveModel(t *testing.T, id string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"provider": "opencode-go", "id": id})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func randomLiveSuffix(t *testing.T) string {
	t.Helper()
	var bytes [6]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(bytes[:])
}

func loadLivePackage(t *testing.T, dir string) release.Package {
	t.Helper()
	manifestJSON, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("read release manifest: %v", err)
	}
	signatureText, err := os.ReadFile(filepath.Join(dir, "manifest.sig"))
	if err != nil {
		t.Fatalf("read release signature: %v", err)
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
	if err != nil {
		t.Fatalf("decode release signature: %v", err)
	}
	var header struct {
		KeyID string `json:"keyId"`
	}
	if err := json.Unmarshal(manifestJSON, &header); err != nil {
		t.Fatalf("read manifest keyId: %v", err)
	}
	publicKey := readLivePublicKey(t, dir)
	files := map[string][]byte{}
	moduleDir := filepath.Join(dir, "modules")
	err = filepath.WalkDir(moduleDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(moduleDir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(relative)] = data
		return nil
	})
	if err != nil {
		t.Fatalf("read release modules: %v", err)
	}
	pkg, err := release.TrustedKeys{header.KeyID: publicKey}.VerifyPackage(manifestJSON, signature, files)
	if err != nil {
		t.Fatalf("verify release package: %v", err)
	}
	return pkg
}

func readLivePublicKey(t *testing.T, dir string) ed25519.PublicKey {
	t.Helper()
	candidates := []string{
		filepath.Join(dir, "TEST-ONLY-signing-key.pub.pem"),
		filepath.Join("..", "..", "..", "contracts", "fixtures", "release", "TEST-ONLY-signing-key.pub.pem"),
	}
	var pemBytes []byte
	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if err == nil {
			pemBytes = data
			break
		}
	}
	if pemBytes == nil {
		t.Fatal("TEST-ONLY public key not found; build the live release with the fixture key")
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		t.Fatal("TEST-ONLY public key is not PEM")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatalf("parse TEST-ONLY public key: %v", err)
	}
	publicKey, ok := key.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("TEST-ONLY key is %T, want ed25519.PublicKey", key)
	}
	return publicKey
}
