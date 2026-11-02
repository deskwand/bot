package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func fixtureDir() string {
	return filepath.Join("..", "..", "..", "contracts", "fixtures", "release")
}

func fixtureBundle(t *testing.T) fstest.MapFS {
	t.Helper()
	dir := fixtureDir()
	manifest, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	signature, err := os.ReadFile(filepath.Join(dir, "manifest.sig"))
	if err != nil {
		t.Fatal(err)
	}
	module, err := os.ReadFile(filepath.Join(dir, "files", "index.js"))
	if err != nil {
		t.Fatal(err)
	}
	return fstest.MapFS{
		"manifest.json":    {Data: manifest},
		"manifest.sig":     {Data: signature},
		"modules/index.js": {Data: module},
	}
}

func fixturePublicKey(t *testing.T) ed25519.PublicKey {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixtureDir(), "TEST-ONLY-signing-key.pub.pem"))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		t.Fatal("fixture public key is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatal("fixture public key is not Ed25519")
	}
	return key
}

func TestLoadBundleWithoutFilesIsNotBundled(t *testing.T) {
	_, err := loadBundle(fstest.MapFS{}, TrustedKeys{})
	if !errors.Is(err, ErrNotBundled) {
		t.Fatalf("error = %v, want ErrNotBundled", err)
	}
}

func TestLoadBundleWithoutTrustedKeysIsUntrusted(t *testing.T) {
	_, err := loadBundle(fixtureBundle(t), TrustedKeys{})
	if !errors.Is(err, ErrUntrusted) {
		t.Fatalf("error = %v, want ErrUntrusted", err)
	}
}

func TestLoadBundleVerifiesTrustedTestKey(t *testing.T) {
	keys := TrustedKeys{"test-only-do-not-use": fixturePublicKey(t)}
	pkg, err := loadBundle(fixtureBundle(t), keys)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Version() != "1.0.0" {
		t.Fatalf("version = %q", pkg.Version())
	}
	if _, ok := pkg.Modules()["index.js"]; !ok {
		t.Fatal("module was not loaded")
	}
}

func TestLoadBundleRejectsWrongTrustedKey(t *testing.T) {
	_, other, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keys := TrustedKeys{"test-only-do-not-use": other.Public().(ed25519.PublicKey)}
	if _, err := loadBundle(fixtureBundle(t), keys); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("error = %v, want ErrUntrusted", err)
	}
}

func TestLoadBundleRejectsMalformedSignature(t *testing.T) {
	bundle := fixtureBundle(t)
	bundle["manifest.sig"] = &fstest.MapFile{Data: []byte("not base64")}
	keys := TrustedKeys{"test-only-do-not-use": fixturePublicKey(t)}
	if _, err := loadBundle(bundle, keys); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("error = %v, want ErrUntrusted", err)
	}
}

func TestProductionTrustedKeysExcludeTestOnlyKey(t *testing.T) {
	keys, err := TrustedReleaseKeys()
	if err != nil {
		t.Fatal(err)
	}
	testKey := fixturePublicKey(t)
	for keyID, key := range keys {
		if keyID == "test-only-do-not-use" {
			t.Fatal("production key set contains the test-only key id")
		}
		if key.Equal(testKey) {
			t.Fatal("production key set contains the test-only public key")
		}
	}
	if len(keys) > 0 {
		if _, ok := keys[ProductionReleaseKeyID]; !ok {
			t.Fatalf("production key set has unexpected ids: %v", keys)
		}
	}
}
