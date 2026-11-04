package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestUpdatesConfiguration(t *testing.T) {
	raw, err := os.ReadFile("mygo.json")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Updates struct {
			PublicKey string `json:"publicKey"`
			URL       string `json:"url"`
			S3        struct {
				Bucket   string `json:"bucket"`
				Prefix   string `json:"prefix"`
				Endpoint string `json:"endpoint"`
			} `json:"s3"`
		} `json:"updates"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	updates := config.Updates
	if strings.TrimSpace(updates.PublicKey) == "" {
		t.Fatal("updates.publicKey is empty")
	}
	if updates.URL != "https://updates.example.com/bot" {
		t.Fatalf("updates.url = %q, want https://updates.example.com/bot", updates.URL)
	}
	if updates.S3.Bucket != "my-update-assets" || updates.S3.Prefix != "bot" {
		t.Fatalf("updates.s3 = %q/%q, want my-update-assets/bot", updates.S3.Bucket, updates.S3.Prefix)
	}
	if !strings.HasPrefix(updates.S3.Endpoint, "https://") ||
		!strings.HasSuffix(updates.S3.Endpoint, ".r2.cloudflarestorage.com") {
		t.Fatalf("updates.s3.endpoint = %q, want an https R2 endpoint", updates.S3.Endpoint)
	}
	if !strings.HasSuffix(updates.URL, "/"+updates.S3.Prefix) {
		t.Fatalf("updates.url %q does not end with /%s", updates.URL, updates.S3.Prefix)
	}
}
