package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAppVersionMatchesMyGoConfiguration(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("mygo.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	if appVersion != config.Version {
		t.Fatalf("appVersion = %q, mygo.json version = %q", appVersion, config.Version)
	}
}

func TestDevIsolationNames(t *testing.T) {
	if credentialServiceName(false) != credentialService || credentialServiceName(false) == credentialServiceName(true) {
		t.Fatal("production and development credential services must differ")
	}
	if credentialServiceName(true) != devCredentialService {
		t.Fatalf("dev credential service = %q", credentialServiceName(true))
	}
	prodDir, err := appDataDir(false)
	if err != nil {
		t.Fatal(err)
	}
	devDir, err := appDataDir(true)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(prodDir) != appDataName || filepath.Base(devDir) != devAppDataName || prodDir == devDir {
		t.Fatalf("data dirs = %q / %q", prodDir, devDir)
	}
}
