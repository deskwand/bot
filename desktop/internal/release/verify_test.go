package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const testKeyID = "test-only-do-not-use"

func validResourceTemplate() ResourceTemplate {
	compatibility := Compatibility{Date: "2026-11-01", Flags: []string{"nodejs_compat"}}
	migrations := []Migration{
		{Tag: "v1", NewSQLiteClasses: []string{"ButlerDO", "TaskDO"}},
		{Tag: "v2", NewSQLiteClasses: []string{"ChannelDO"}},
	}
	return ResourceTemplate{
		SchemaVersion:   1,
		Entrypoint:      "index.js",
		Compatibility:   compatibility,
		DurableObjects:  []DOBinding{{Name: "BUTLER", ClassName: "ButlerDO"}, {Name: "TASK", ClassName: "TaskDO"}, {Name: "CHANNELS", ClassName: "ChannelDO"}},
		R2Buckets:       []R2Binding{{Name: "ARTIFACTS", ParameterKey: "r2BucketName"}},
		VersionMetadata: BindingRef{Name: "CF_VERSION_METADATA"},
		Observability: &Observability{
			Enabled:          true,
			HeadSamplingRate: 1,
			Logs:             ObservabilityLogs{InvocationLogs: false},
		},
		ConfigBinding: ConfigBinding{Name: "DESKWAND_CONFIG", Type: "json", SchemaVersion: 1},
		SecretNames:   []string{"ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "WECHAT_CREDENTIALS"},
		PlainVars:     []string{"ACTIVE_CHANNEL", "PUBLIC_BASE_URL"},
		Crons:         []string{"*/5 * * * *"},
		Vars:          []VarBinding{{Name: "PUBLIC_BASE_URL", ParameterKey: "PUBLIC_BASE_URL"}},
		Migrations:    migrations,
		InstallParams: []InstallParameter{
			{Key: "workerName", Source: "user"},
			{Key: "r2BucketName", Source: "user"},
			{Key: "PUBLIC_BASE_URL", Source: "user"},
			{Key: "owner", Source: "DESKWAND_CONFIG"},
		},
	}
}

func fixtureFiles() map[string][]byte {
	return map[string][]byte{
		"index.js":        []byte("export default { fetch() { return new Response(\"ok\"); } };\n"),
		"chunks/extra.js": []byte("export const extra = 1;\n"),
	}
}

func fileEntries(files map[string][]byte) []FileEntry {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	entries := make([]FileEntry, 0, len(paths))
	for _, path := range paths {
		sum := sha256.Sum256(files[path])
		entries = append(entries, FileEntry{
			Path:   path,
			SHA256: hex.EncodeToString(sum[:]),
			Size:   int64(len(files[path])),
		})
	}
	return entries
}

// validReleaseFixture returns a complete, valid manifest. The package is not
// empty: it contains two modules and the full Durable Object migration history.
func validReleaseFixture(t *testing.T, version string) ([]byte, map[string][]byte, string) {
	t.Helper()

	files := fixtureFiles()
	template := validResourceTemplate()
	manifest := Manifest{
		ManifestVersion:     1,
		KeyID:               testKeyID,
		Version:             version,
		Entrypoint:          "index.js",
		Files:               fileEntries(files),
		CompressedSize:      100,
		ConfigSchemaVersion: 1,
		Compatibility:       template.Compatibility,
		ResourceTemplate:    template,
		Migrations:          template.Migrations,
		Upgrade: Upgrade{
			MinFromVersion:         "1.0.0",
			IrreversibleMigrations: []string{},
		},
	}

	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal valid fixture: %v", err)
	}
	return raw, files, testKeyID
}

func signed(t *testing.T, manifest Manifest) ([]byte, []byte, ed25519.PublicKey) {
	t.Helper()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	return raw, ed25519.Sign(priv, raw), pub
}

func signBytes(t *testing.T, raw []byte) ([]byte, ed25519.PublicKey) {
	t.Helper()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return ed25519.Sign(priv, raw), pub
}

func validManifest(t *testing.T) Manifest {
	t.Helper()

	raw, _, _ := validReleaseFixture(t, "1.0.0")
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("unmarshal valid fixture: %v", err)
	}
	return manifest
}

func TestAcceptValidPackage(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	manifest, files, _ := validReleaseFixture(t, "1.0.0")
	signature := ed25519.Sign(priv, manifest)

	if err := Verify(manifest, signature, pub, files); err != nil {
		t.Fatalf("Verify(valid package) = %v, want nil", err)
	}
}

func TestRejectTamperedManifest(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	manifest, files, _ := validReleaseFixture(t, "1.0.0")
	signature := ed25519.Sign(priv, manifest)
	if err := Verify(manifest, signature, pub, files); err != nil {
		t.Fatalf("Verify(valid package) = %v, want nil", err)
	}

	changed := bytes.Replace(manifest, []byte("1.0.0"), []byte("1.0.1"), 1)
	if Verify(changed, signature, pub, files) == nil {
		t.Fatal("tampered manifest accepted")
	}
}

func TestRejectTamperedFileContent(t *testing.T) {
	manifest := validManifest(t)
	files := fixtureFiles()
	files["index.js"] = append(files["index.js"], []byte("// changed\n")...)
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, files); err == nil {
		t.Fatal("tampered file content accepted")
	}
}

func TestRejectMissingFile(t *testing.T) {
	manifest := validManifest(t)
	files := fixtureFiles()
	delete(files, "chunks/extra.js")
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, files); err == nil {
		t.Fatal("missing module accepted")
	}
}

func TestRejectExtraFile(t *testing.T) {
	manifest := validManifest(t)
	files := fixtureFiles()
	files["unlisted.js"] = []byte("export const unlisted = true;\n")
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, files); err == nil {
		t.Fatal("unlisted module accepted")
	}
}

func TestRejectUnsafePaths(t *testing.T) {
	cases := map[string]string{
		"absolute unix":               "/etc/passwd",
		"absolute windows":            `C:\Windows\system32\evil.js`,
		"parent traversal":            "../escape.js",
		"nested traversal":            "a/../../b.js",
		"dot segment":                 "a/./b.js",
		"backslash":                   `chunks\extra.js`,
		"empty":                       "",
		"trailing slash":              "chunks/",
		"empty segment":               "a//b.js",
		"colon":                       "a:b.js",
		"drive relative":              "C:evil.js",
		"reserved con":                "CON",
		"reserved con extension":      "con.js",
		"reserved com1":               "COM1",
		"reserved lpt9 extension":     "lpt9.txt",
		"reserved aux extension":      "aux.js",
		"reserved nul":                "NUL",
		"reserved prn":                "PRN",
		"trailing dot":                "index.js.",
		"trailing space":              "index.js ",
		"control character":           "a\x01b.js",
		"space outside whitelist":     "a b.js",
		"non-ascii outside whitelist": "é.js",
	}

	for name, badPath := range cases {
		t.Run(name, func(t *testing.T) {
			manifest := validManifest(t)
			manifest.Files[0].Path = badPath
			raw, signature, pub := signed(t, manifest)

			if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
				t.Fatalf("unsafe path %q accepted", badPath)
			}
		})
	}
}

func TestRejectCaseCollidingFileEntries(t *testing.T) {
	manifest := validManifest(t)
	files := map[string][]byte{
		"Index.js": []byte("export const upper = true;\n"),
		"index.js": fixtureFiles()["index.js"],
	}
	manifest.Files = fileEntries(files)
	raw, signature, pub := signed(t, manifest)

	err := Verify(raw, signature, pub, files)
	if err == nil {
		t.Fatal("case-colliding file entries accepted")
	}
	if !strings.Contains(err.Error(), "collide") {
		t.Fatalf("error = %v, want a normalization collision", err)
	}
}

func TestRejectNFCNFDCollidingFileEntries(t *testing.T) {
	if pathComparisonKey("Cafe\u0301.js") != pathComparisonKey("Caf\u00e9.js") {
		t.Fatal("NFC/NFD comparison keys differ")
	}

	manifest := validManifest(t)
	files := map[string][]byte{
		"index.js":      fixtureFiles()["index.js"],
		"Cafe\u0301.js": []byte("export const decomposed = true;\n"),
		"Caf\u00e9.js":  []byte("export const composed = true;\n"),
	}
	manifest.Files = fileEntries(files)
	raw, signature, pub := signed(t, manifest)

	err := Verify(raw, signature, pub, files)
	if err == nil {
		t.Fatal("NFC/NFD-colliding file entries accepted")
	}
	if !strings.Contains(err.Error(), "collide") {
		t.Fatalf("error = %v, want a normalization collision", err)
	}
}

func TestRejectDuplicateFileEntries(t *testing.T) {
	manifest := validManifest(t)
	manifest.Files = append(manifest.Files, manifest.Files[0])
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("duplicate file entry accepted")
	}
}

func TestRejectOversizedFile(t *testing.T) {
	manifest := validManifest(t)
	big := bytes.Repeat([]byte("x"), int(MaxFileSanityBytes)+1)
	files := fixtureFiles()
	files["index.js"] = big
	manifest.Files = fileEntries(files)
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, files); err == nil {
		t.Fatal("file above the uncompressed sanity bound accepted")
	}
}

func TestRejectOversizedPackage(t *testing.T) {
	manifest := validManifest(t)
	part := bytes.Repeat([]byte("y"), int(MaxFileSanityBytes))
	files := map[string][]byte{
		"index.js":        part,
		"chunks/extra.js": part,
		"chunks/third.js": []byte("z"),
	}
	if int64(len(part))*2+1 <= MaxTotalSanityBytes {
		t.Fatalf("test fixture is not larger than MaxTotalSanityBytes: %d", MaxTotalSanityBytes)
	}
	manifest.Files = fileEntries(files)
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, files); err == nil {
		t.Fatal("package larger than the uncompressed total sanity bound accepted")
	}
}

func TestRejectOversizedCompressedSize(t *testing.T) {
	manifest := validManifest(t)
	manifest.CompressedSize = MaxCompressedBytes + 1
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("compressedSize above the free-plan limit accepted")
	}
}

func TestRejectUnknownManifestVersion(t *testing.T) {
	manifest := validManifest(t)
	manifest.ManifestVersion = 2
	raw, signature, pub := signed(t, manifest)

	err := Verify(raw, signature, pub, fixtureFiles())
	if err == nil {
		t.Fatal("unknown manifest version accepted")
	}
	if !errors.Is(err, ErrUnsupportedManifestVersion) {
		t.Fatalf("error = %v, want ErrUnsupportedManifestVersion", err)
	}
}

func TestRejectUnknownConfigSchema(t *testing.T) {
	manifest := validManifest(t)
	manifest.ConfigSchemaVersion = 2
	raw, signature, pub := signed(t, manifest)

	err := Verify(raw, signature, pub, fixtureFiles())
	if err == nil {
		t.Fatal("unknown config schema accepted")
	}
	if !errors.Is(err, ErrUnsupportedConfigSchema) {
		t.Fatalf("error = %v, want ErrUnsupportedConfigSchema", err)
	}
}

func TestRejectUnknownKeyID(t *testing.T) {
	manifest := validManifest(t)
	raw, signature, pub := signed(t, manifest)

	if err := (TrustedKeys{testKeyID: pub}).VerifyWithKeys(raw, signature, fixtureFiles()); err != nil {
		t.Fatalf("trusted key rejected the fixture: %v", err)
	}
	if err := (TrustedKeys{"some-other-key": pub}).VerifyWithKeys(raw, signature, fixtureFiles()); err == nil {
		t.Fatal("unknown keyId accepted")
	}
	if err := (TrustedKeys{}).VerifyWithKeys(raw, signature, fixtureFiles()); err == nil {
		t.Fatal("empty trusted key set accepted a manifest")
	}
}

func TestRejectEntrypointMismatch(t *testing.T) {
	manifest := validManifest(t)
	manifest.ResourceTemplate.Entrypoint = "other.js"
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("entrypoint/template mismatch accepted")
	}
}

func TestRejectEntrypointMissingFromFiles(t *testing.T) {
	manifest := validManifest(t)
	manifest.Entrypoint = "other.js"
	manifest.ResourceTemplate.Entrypoint = "other.js"
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("entrypoint missing from the file map accepted")
	}
}

func TestRejectUnsafeTemplateEntrypoint(t *testing.T) {
	manifest := validManifest(t)
	manifest.Entrypoint = "../escape.js"
	manifest.ResourceTemplate.Entrypoint = "../escape.js"
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("unsafe template entrypoint accepted")
	}
}

func TestRejectMigrationClassWithoutBinding(t *testing.T) {
	manifest := validManifest(t)
	migration := Migration{Tag: "v3", NewSQLiteClasses: []string{"GhostDO"}}
	manifest.Migrations = append(manifest.Migrations, migration)
	manifest.ResourceTemplate.Migrations = append(manifest.ResourceTemplate.Migrations, migration)
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("migration for an unbound Durable Object class accepted")
	}
}

func TestRejectDurableObjectWithoutMigration(t *testing.T) {
	manifest := validManifest(t)
	manifest.ResourceTemplate.DurableObjects = append(
		manifest.ResourceTemplate.DurableObjects,
		DOBinding{Name: "EXTRA", ClassName: "ExtraDO"},
	)
	raw, signature, pub := signed(t, manifest)

	if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("Durable Object class without a migration accepted")
	}
}

func TestRejectUndeclaredInstallParameterKey(t *testing.T) {
	t.Run("R2", func(t *testing.T) {
		manifest := validManifest(t)
		manifest.ResourceTemplate.R2Buckets[0].ParameterKey = "missingBucket"
		raw, signature, pub := signed(t, manifest)
		if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
			t.Fatal("R2 parameterKey outside install parameters accepted")
		}
	})
	t.Run("var", func(t *testing.T) {
		manifest := validManifest(t)
		manifest.ResourceTemplate.Vars[0].ParameterKey = "MISSING_VAR"
		raw, signature, pub := signed(t, manifest)
		if err := Verify(raw, signature, pub, fixtureFiles()); err == nil {
			t.Fatal("variable parameterKey outside install parameters accepted")
		}
	})
}

func TestRejectUnknownManifestKey(t *testing.T) {
	raw, _, _ := validReleaseFixture(t, "1.0.0")
	mutated := bytes.Replace(
		raw,
		[]byte(`"manifestVersion":1,`),
		[]byte(`"manifestVersion":1,"futureField":true,`),
		1,
	)
	if bytes.Equal(mutated, raw) {
		t.Fatal("test mutation did not apply")
	}
	signature, pub := signBytes(t, mutated)
	if err := Verify(mutated, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("unknown manifest key accepted")
	}
}

func TestRejectCaseMismatchedManifestKey(t *testing.T) {
	raw, _, _ := validReleaseFixture(t, "1.0.0")
	mutated := bytes.Replace(raw, []byte(`"version":`), []byte(`"Version":`), 1)
	if bytes.Equal(mutated, raw) {
		t.Fatal("test mutation did not apply")
	}
	signature, pub := signBytes(t, mutated)
	if err := Verify(mutated, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("case-mismatched manifest key accepted")
	}
}

func TestRejectDuplicateManifestKey(t *testing.T) {
	raw, _, _ := validReleaseFixture(t, "1.0.0")
	mutated := bytes.Replace(
		raw,
		[]byte(`"version":"1.0.0"`),
		[]byte(`"version":"1.0.0","version":"1.0.0"`),
		1,
	)
	if bytes.Equal(mutated, raw) {
		t.Fatal("test mutation did not apply")
	}
	signature, pub := signBytes(t, mutated)
	if err := Verify(mutated, signature, pub, fixtureFiles()); err == nil {
		t.Fatal("duplicate manifest key accepted")
	}
}

func TestCrossLanguageFixture(t *testing.T) {
	fixtureDir := filepath.Join("..", "..", "..", "contracts", "fixtures", "release")

	manifestBytes, err := os.ReadFile(filepath.Join(fixtureDir, "manifest.json"))
	if err != nil {
		t.Fatalf("read fixture manifest: %v", err)
	}
	signatureText, err := os.ReadFile(filepath.Join(fixtureDir, "manifest.sig"))
	if err != nil {
		t.Fatalf("read fixture signature: %v", err)
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
	if err != nil {
		t.Fatalf("decode fixture signature: %v", err)
	}
	publicKeyPEM, err := os.ReadFile(filepath.Join(fixtureDir, "TEST-ONLY-signing-key.pub.pem"))
	if err != nil {
		t.Fatalf("read fixture public key: %v", err)
	}
	block, _ := pem.Decode(publicKeyPEM)
	if block == nil {
		t.Fatal("fixture public key is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatalf("parse fixture public key: %v", err)
	}
	pub, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("fixture public key type = %T, want ed25519.PublicKey", parsed)
	}

	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("unmarshal fixture manifest: %v", err)
	}
	if manifest.KeyID != testKeyID {
		t.Fatalf("fixture keyId = %q, want %q", manifest.KeyID, testKeyID)
	}
	wantObservability := Observability{
		Enabled:          true,
		HeadSamplingRate: 1,
		Logs:             ObservabilityLogs{InvocationLogs: false},
	}
	if manifest.ResourceTemplate.Observability == nil || *manifest.ResourceTemplate.Observability != wantObservability {
		t.Fatalf("fixture observability = %+v, want %+v", manifest.ResourceTemplate.Observability, wantObservability)
	}

	files := readFixtureFiles(t, filepath.Join(fixtureDir, "files"))
	if err := Verify(manifestBytes, signature, pub, files); err != nil {
		t.Fatalf("Verify(cross-language fixture) = %v, want nil", err)
	}
	if err := (TrustedKeys{testKeyID: pub}).VerifyWithKeys(manifestBytes, signature, files); err != nil {
		t.Fatalf("VerifyWithKeys(cross-language fixture) = %v, want nil", err)
	}
}

func readFixtureFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()

	files := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
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
		t.Fatalf("read fixture files: %v", err)
	}
	return files
}
