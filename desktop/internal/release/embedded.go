package release

import (
	"embed"
	"encoding/base64"
	"errors"
	"io/fs"
	"path"
	"strings"
)

// The bundle directory is populated by scripts/build-desktop.sh at build
// time. Only bundle/.gitkeep is committed, so a normal checkout and test run
// carries no Worker release. The app still runs; Install and Upgrade then
// report RELEASE_NOT_BUNDLED.
//
//go:embed all:bundle
var bundleFS embed.FS

var (
	// ErrNotBundled means no signed Worker release is embedded in this build.
	ErrNotBundled = errors.New("release: no Worker release bundle is embedded (RELEASE_NOT_BUNDLED)")
	// ErrUntrusted means the embedded release was not signed by one of the
	// production trusted keys, including the case where no public key is
	// embedded at all.
	ErrUntrusted = errors.New("release: the embedded Worker release is not signed by a trusted key (RELEASE_UNTRUSTED)")
)

// LoadEmbedded verifies the embedded release against the production trusted
// key set. A missing bundle returns ErrNotBundled; a missing or mismatched key
// returns ErrUntrusted. No verification detail that could describe key
// material is included in the error.
func LoadEmbedded(keys TrustedKeys) (Package, error) {
	root, err := fs.Sub(bundleFS, "bundle")
	if err != nil {
		return Package{}, ErrNotBundled
	}
	return loadBundle(root, keys)
}

// loadBundle reads and verifies the canonical bundle layout used by the build
// script: manifest.json, manifest.sig (base64) and modules/**.
func loadBundle(root fs.FS, keys TrustedKeys) (Package, error) {
	manifest, err := fs.ReadFile(root, "manifest.json")
	if err != nil || len(strings.TrimSpace(string(manifest))) == 0 {
		return Package{}, ErrNotBundled
	}
	signatureText, err := fs.ReadFile(root, "manifest.sig")
	if err != nil {
		return Package{}, ErrNotBundled
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
	if err != nil {
		return Package{}, ErrUntrusted
	}

	modules, err := readBundleModules(root)
	if err != nil {
		return Package{}, ErrNotBundled
	}
	if len(modules) == 0 {
		return Package{}, ErrNotBundled
	}
	if len(keys) == 0 {
		return Package{}, ErrUntrusted
	}

	pkg, err := keys.VerifyPackage(manifest, signature, modules)
	if err != nil {
		// Keep the client-facing code stable and never echo key ids or
		// verification internals into the UI.
		return Package{}, ErrUntrusted
	}
	return pkg, nil
}

func readBundleModules(root fs.FS) (map[string][]byte, error) {
	modules := map[string][]byte{}
	err := fs.WalkDir(root, "modules", func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative := strings.TrimPrefix(filePath, "modules/")
		if relative == "" || relative == filePath {
			return nil
		}
		// Defensive: a malformed bundle must not produce paths that escape
		// the module namespace.
		cleaned := path.Clean(relative)
		if cleaned != relative || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") {
			return errors.New("release: embedded bundle contains an invalid module path")
		}
		data, err := fs.ReadFile(root, filePath)
		if err != nil {
			return err
		}
		modules[relative] = data
		return nil
	})
	if err != nil {
		return nil, err
	}
	return modules, nil
}
