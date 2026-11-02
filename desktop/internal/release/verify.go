package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"
)

var (
	// ErrInvalidSignature means the detached signature does not match the
	// exact manifest bytes.
	ErrInvalidSignature = errors.New("release: manifest signature is invalid")
	// ErrUnsupportedManifestVersion means the manifest shape is not understood.
	ErrUnsupportedManifestVersion = errors.New("release: unsupported manifest version")
	// ErrUnsupportedConfigSchema means the packaged configuration schema is
	// newer or otherwise unsupported by this client.
	ErrUnsupportedConfigSchema = errors.New("release: unsupported config schema version")
)

// TrustedKeys maps a manifest keyId to the release signing public key.
//
// Key rotation ships a new client carrying both the old and the new key before
// signing switches to the new keyId. A keyId that is not in the set is
// rejected even when the signature would verify under some other key.
type TrustedKeys map[string]ed25519.PublicKey

// Verify checks a detached Ed25519 signature over the exact manifest bytes,
// then parses and validates the package.
//
// Verify is the low-level primitive for callers that already selected a key.
// Production deployment code must use VerifyWithKeys, which binds the
// manifest keyId to the embedded trusted key set.
//
// The signature is checked before the manifest is interpreted. Verification
// requires exact file-map completeness: every listed module must be present,
// unlisted modules are rejected, and each SHA-256 digest and size must match.
// Paths, uncompressed sanity bounds and the signed compressedSize are checked
// against the limits shared with the TypeScript builder.
func Verify(manifest, signature []byte, key ed25519.PublicKey, files map[string][]byte) error {
	_, err := verify(manifest, signature, key, files)
	return err
}

// VerifyWithKeys selects the public key by the manifest keyId, then verifies
// and validates the package. This is the only production entry point.
//
// The keyId header is read before the signature so that the right key can be
// selected. No other manifest field is trusted until Verify has checked the
// raw bytes.
func (keys TrustedKeys) VerifyWithKeys(manifest, signature []byte, files map[string][]byte) error {
	var header struct {
		KeyID string `json:"keyId"`
	}
	if err := json.Unmarshal(manifest, &header); err != nil {
		return fmt.Errorf("release: read manifest keyId: %w", err)
	}
	if header.KeyID == "" {
		return errors.New("release: manifest keyId is empty")
	}
	key, ok := keys[header.KeyID]
	if !ok {
		return fmt.Errorf("release: untrusted release key %q", header.KeyID)
	}

	parsed, err := verify(manifest, signature, key, files)
	if err != nil {
		return err
	}
	if parsed.KeyID != header.KeyID {
		return fmt.Errorf("release: manifest keyId %q does not match selected key %q", parsed.KeyID, header.KeyID)
	}
	return nil
}

func verify(manifest, signature []byte, key ed25519.PublicKey, files map[string][]byte) (*Manifest, error) {
	if len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("release: public key has length %d, want %d", len(key), ed25519.PublicKeySize)
	}
	if len(signature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("%w: signature has length %d, want %d", ErrInvalidSignature, len(signature), ed25519.SignatureSize)
	}
	if !ed25519.Verify(key, manifest, signature) {
		return nil, ErrInvalidSignature
	}

	if err := validateJSONKeys(manifest); err != nil {
		return nil, err
	}

	decoder := json.NewDecoder(bytes.NewReader(manifest))
	decoder.DisallowUnknownFields()
	var parsed Manifest
	if err := decoder.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("release: parse manifest: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("release: manifest contains trailing data")
	}
	if err := validateManifest(&parsed, files); err != nil {
		return nil, err
	}
	return &parsed, nil
}

// manifestJSONKeys is derived from the Go structs so the exact-case token
// scan cannot drift from the decode target. DisallowUnknownFields handles
// keys that are valid somewhere but in the wrong object.
var manifestJSONKeys = func() map[string]bool {
	keys := map[string]bool{}
	collectJSONFieldNames(reflect.TypeOf(Manifest{}), keys, map[reflect.Type]bool{})
	return keys
}()

func collectJSONFieldNames(typ reflect.Type, keys map[string]bool, seen map[reflect.Type]bool) {
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice || typ.Kind() == reflect.Array {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct || seen[typ] {
		return
	}
	seen[typ] = true
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue
		}
		keys[name] = true
		collectJSONFieldNames(field.Type, keys, seen)
	}
}

// validateJSONKeys rejects duplicate object keys and keys whose spelling does
// not exactly match a manifest JSON field. encoding/json otherwise matches
// field names case-insensitively and silently keeps the last duplicate.
func validateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()

	type frame struct {
		object    bool
		expectKey bool
		keys      map[string]bool
	}
	var stack []frame
	afterValue := func() {
		if len(stack) == 0 {
			return
		}
		top := &stack[len(stack)-1]
		if top.object {
			top.expectKey = true
		}
	}

	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("release: scan manifest JSON: %w", err)
		}
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{':
				stack = append(stack, frame{object: true, expectKey: true, keys: map[string]bool{}})
			case '[':
				stack = append(stack, frame{object: false})
			case '}', ']':
				if len(stack) == 0 {
					return errors.New("release: unbalanced manifest JSON")
				}
				stack = stack[:len(stack)-1]
				afterValue()
			}
			continue
		}

		if len(stack) == 0 {
			continue
		}
		top := &stack[len(stack)-1]
		if top.object && top.expectKey {
			key, ok := token.(string)
			if !ok {
				return errors.New("release: manifest object key is not a string")
			}
			if !manifestJSONKeys[key] {
				return fmt.Errorf("release: unknown or case-mismatched manifest key %q", key)
			}
			if top.keys[key] {
				return fmt.Errorf("release: duplicate manifest key %q", key)
			}
			top.keys[key] = true
			top.expectKey = false
			continue
		}
		if top.object {
			top.expectKey = true
		}
	}

	if len(stack) != 0 {
		return errors.New("release: unbalanced manifest JSON")
	}
	return nil
}

func validateManifest(manifest *Manifest, files map[string][]byte) error {
	if manifest.ManifestVersion != ManifestVersion {
		return fmt.Errorf("%w: %d", ErrUnsupportedManifestVersion, manifest.ManifestVersion)
	}
	if manifest.KeyID == "" {
		return errors.New("release: manifest keyId is empty")
	}
	if manifest.Version == "" {
		return errors.New("release: manifest version is empty")
	}
	if manifest.ConfigSchemaVersion != SupportedConfigSchemaVersion {
		return fmt.Errorf("%w: %d", ErrUnsupportedConfigSchema, manifest.ConfigSchemaVersion)
	}
	if manifest.CompressedSize < 0 {
		return errors.New("release: compressedSize is negative")
	}
	if manifest.CompressedSize > MaxCompressedBytes {
		return fmt.Errorf("release: compressedSize %d exceeds the %d byte free-plan limit", manifest.CompressedSize, MaxCompressedBytes)
	}
	if err := validateCompatibility(manifest.Compatibility); err != nil {
		return err
	}
	if err := validateResourceTemplate(&manifest.ResourceTemplate); err != nil {
		return err
	}
	if manifest.Entrypoint != manifest.ResourceTemplate.Entrypoint {
		return errors.New("release: entrypoint does not match the resource template")
	}
	if !reflect.DeepEqual(manifest.Compatibility, manifest.ResourceTemplate.Compatibility) {
		return errors.New("release: compatibility settings do not match the resource template")
	}
	if !reflect.DeepEqual(manifest.Migrations, manifest.ResourceTemplate.Migrations) {
		return errors.New("release: migration history does not match the resource template")
	}
	if err := validateMigrations(manifest.Migrations, manifest.Upgrade.IrreversibleMigrations); err != nil {
		return err
	}
	if manifest.Upgrade.MinFromVersion == "" {
		return errors.New("release: upgrade.minFromVersion is empty")
	}
	if manifest.Upgrade.IrreversibleMigrations == nil {
		return errors.New("release: upgrade.irreversibleMigrations is missing or null")
	}
	if err := checkRelativePath(manifest.Entrypoint); err != nil {
		return fmt.Errorf("release: entrypoint: %w", err)
	}
	if err := validateFiles(manifest, files); err != nil {
		return err
	}
	return nil
}

func validateCompatibility(compatibility Compatibility) error {
	if _, err := time.Parse("2006-01-02", compatibility.Date); err != nil {
		return fmt.Errorf("release: compatibility date %q is not YYYY-MM-DD", compatibility.Date)
	}
	if compatibility.Flags == nil {
		return errors.New("release: compatibility flags are missing or null")
	}
	return nil
}

func validateResourceTemplate(template *ResourceTemplate) error {
	if template.SchemaVersion != 1 {
		return fmt.Errorf("release: unsupported resource template schema version %d", template.SchemaVersion)
	}
	if template.Entrypoint == "" {
		return errors.New("release: resource template entrypoint is empty")
	}
	if err := checkRelativePath(template.Entrypoint); err != nil {
		return fmt.Errorf("release: resource template entrypoint: %w", err)
	}
	if err := validateCompatibility(template.Compatibility); err != nil {
		return err
	}
	if len(template.Migrations) == 0 {
		return errors.New("release: resource template migration history is empty")
	}

	durableClasses := map[string]bool{}
	for _, binding := range template.DurableObjects {
		if binding.Name == "" || binding.ClassName == "" {
			return errors.New("release: resource template contains an empty Durable Object binding")
		}
		if durableClasses[binding.ClassName] {
			return fmt.Errorf("release: duplicate Durable Object class %q", binding.ClassName)
		}
		durableClasses[binding.ClassName] = true
	}

	migratedClasses := map[string]bool{}
	for _, migration := range template.Migrations {
		for _, className := range migration.NewSQLiteClasses {
			if className == "" {
				return errors.New("release: migration contains an empty Durable Object class")
			}
			if !durableClasses[className] {
				return fmt.Errorf("release: migration references unknown Durable Object class %q", className)
			}
			migratedClasses[className] = true
		}
	}
	for className := range durableClasses {
		if !migratedClasses[className] {
			return fmt.Errorf("release: Durable Object class %q has no migration entry", className)
		}
	}

	if template.VersionMetadata.Name == "" {
		return errors.New("release: resource template version metadata binding is empty")
	}
	if template.ConfigBinding.Name == "" {
		return errors.New("release: resource template config binding is empty")
	}
	if template.ConfigBinding.Type != "json" {
		return fmt.Errorf("release: resource template config binding type %q is not json", template.ConfigBinding.Type)
	}
	if template.ConfigBinding.SchemaVersion != SupportedConfigSchemaVersion {
		return fmt.Errorf("release: resource template config binding schema version %d is not supported", template.ConfigBinding.SchemaVersion)
	}
	if err := validateUniqueNames(template.SecretNames, "secret names"); err != nil {
		return err
	}
	if err := validateUniqueNames(template.PlainVars, "plain variable names"); err != nil {
		return err
	}
	plainBaseURL := false
	for _, name := range template.PlainVars {
		if name == "PUBLIC_BASE_URL" {
			plainBaseURL = true
		}
	}
	if !plainBaseURL {
		return errors.New("release: resource template plain variables must include PUBLIC_BASE_URL")
	}
	if len(template.Crons) == 0 {
		return errors.New("release: resource template cron list is empty")
	}
	for _, cron := range template.Crons {
		if strings.TrimSpace(cron) == "" {
			return errors.New("release: resource template contains an empty cron")
		}
	}

	required := map[string]bool{
		"workerName":      false,
		"r2BucketName":    false,
		"PUBLIC_BASE_URL": false,
		"owner":           false,
	}
	installKeys := map[string]bool{}
	for _, parameter := range template.InstallParams {
		if parameter.Key == "" || parameter.Source == "" {
			return errors.New("release: resource template contains an empty install parameter")
		}
		if parameter.Key == "owner" && parameter.Source != "DESKWAND_CONFIG" {
			return errors.New("release: owner install parameter must come from DESKWAND_CONFIG")
		}
		installKeys[parameter.Key] = true
		if _, ok := required[parameter.Key]; ok {
			required[parameter.Key] = true
		}
	}
	for key, present := range required {
		if !present {
			return fmt.Errorf("release: resource template is missing install parameter %q", key)
		}
	}

	for _, binding := range template.R2Buckets {
		if binding.Name == "" || binding.ParameterKey == "" {
			return errors.New("release: resource template contains an empty R2 binding")
		}
		if !installKeys[binding.ParameterKey] {
			return fmt.Errorf("release: R2 binding parameterKey %q is not an install parameter", binding.ParameterKey)
		}
	}
	for _, variable := range template.Vars {
		if variable.Name == "" || variable.ParameterKey == "" {
			return errors.New("release: resource template contains an empty variable binding")
		}
		if !installKeys[variable.ParameterKey] {
			return fmt.Errorf("release: variable parameterKey %q is not an install parameter", variable.ParameterKey)
		}
	}
	return nil
}

func validateUniqueNames(names []string, label string) error {
	if len(names) == 0 {
		return fmt.Errorf("release: resource template %s are empty", label)
	}
	seen := map[string]bool{}
	for _, name := range names {
		if name == "" {
			return fmt.Errorf("release: resource template %s contain an empty name", label)
		}
		if seen[name] {
			return fmt.Errorf("release: resource template %s contain duplicate %q", label, name)
		}
		seen[name] = true
	}
	return nil
}

func validateMigrations(migrations []Migration, irreversible []string) error {
	if len(migrations) == 0 {
		return errors.New("release: migration history is empty")
	}
	tags := make(map[string]bool, len(migrations))
	for _, migration := range migrations {
		if migration.Tag == "" {
			return errors.New("release: migration has an empty tag")
		}
		if tags[migration.Tag] {
			return fmt.Errorf("release: duplicate migration tag %q", migration.Tag)
		}
		tags[migration.Tag] = true
	}
	for _, tag := range irreversible {
		if !tags[tag] {
			return fmt.Errorf("release: irreversible migration %q is not in the migration history", tag)
		}
	}
	return nil
}

var (
	segmentPattern        = regexp.MustCompile(`^[A-Za-z0-9._@+-]+$`)
	reservedDevicePattern = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)`)
)

func validateFiles(manifest *Manifest, files map[string][]byte) error {
	if len(manifest.Files) == 0 {
		return errors.New("release: manifest lists no files")
	}
	if len(files) != len(manifest.Files) {
		return fmt.Errorf("release: file map has %d entries, manifest lists %d", len(files), len(manifest.Files))
	}

	var total int64
	var actualTotal int64
	previous := ""
	entrypoints := 0

	// Detect NFC/lowercase collisions before path validation so a decomposed
	// or case-folded duplicate is reported as a duplicate even when the
	// portable whitelist would also reject it.
	collisions := map[string]string{}
	for _, entry := range manifest.Files {
		comparisonKey := pathComparisonKey(entry.Path)
		if previousPath, ok := collisions[comparisonKey]; ok {
			return fmt.Errorf("release: files %q and %q collide after NFC/lowercase normalization", previousPath, entry.Path)
		}
		collisions[comparisonKey] = entry.Path
	}

	for _, entry := range manifest.Files {
		if err := checkRelativePath(entry.Path); err != nil {
			return fmt.Errorf("release: file %q: %w", entry.Path, err)
		}
		if previous != "" && entry.Path <= previous {
			return fmt.Errorf("release: files are not strictly sorted or contain duplicate path %q", entry.Path)
		}
		previous = entry.Path

		if entry.Size < 0 {
			return fmt.Errorf("release: file %q has negative size", entry.Path)
		}
		if entry.Size > MaxFileSanityBytes {
			return fmt.Errorf("release: file %q is %d bytes, uncompressed per-file sanity bound is %d", entry.Path, entry.Size, MaxFileSanityBytes)
		}
		if entry.Size > MaxTotalSanityBytes-total {
			return fmt.Errorf("release: package exceeds the %d byte uncompressed total sanity bound at file %q", MaxTotalSanityBytes, entry.Path)
		}
		total += entry.Size

		digest, err := hex.DecodeString(entry.SHA256)
		if err != nil || len(digest) != sha256.Size {
			return fmt.Errorf("release: file %q has an invalid sha256", entry.Path)
		}

		data, ok := files[entry.Path]
		if !ok {
			return fmt.Errorf("release: manifest file %q is missing from the package", entry.Path)
		}
		actualSize := int64(len(data))
		if actualSize != entry.Size {
			return fmt.Errorf("release: file %q size is %d, manifest says %d", entry.Path, len(data), entry.Size)
		}
		if actualSize > MaxFileSanityBytes {
			return fmt.Errorf("release: actual file %q is %d bytes, uncompressed per-file sanity bound is %d", entry.Path, actualSize, MaxFileSanityBytes)
		}
		actualTotal += actualSize
		if actualTotal > MaxTotalSanityBytes {
			return fmt.Errorf("release: actual files exceed the %d byte uncompressed total sanity bound", MaxTotalSanityBytes)
		}

		actual := sha256.Sum256(data)
		if subtle.ConstantTimeCompare(actual[:], digest) != 1 {
			return fmt.Errorf("release: file %q sha256 does not match", entry.Path)
		}
		if entry.Path == manifest.Entrypoint {
			entrypoints++
		}
	}

	if entrypoints != 1 {
		return fmt.Errorf("release: entrypoint %q is not listed exactly once", manifest.Entrypoint)
	}
	return nil
}

func pathComparisonKey(path string) string {
	return strings.ToLower(norm.NFC.String(path))
}

func checkRelativePath(path string) error {
	if path == "" {
		return errors.New("path is empty")
	}
	for _, r := range path {
		if r < 0x20 || r == 0x7f {
			return errors.New("path contains a control character")
		}
	}
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, `\`) {
		return errors.New("absolute path is not allowed")
	}
	if strings.Contains(path, `\`) {
		return errors.New("backslash separators are not allowed")
	}
	if strings.Contains(path, ":") {
		return errors.New("colon is not allowed in a portable path")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" {
			return errors.New("path contains an empty segment")
		}
		if segment == "." || segment == ".." {
			return errors.New("path contains a dot or parent segment")
		}
		if !segmentPattern.MatchString(segment) {
			return fmt.Errorf("path segment %q must match [A-Za-z0-9._@+-]", segment)
		}
		if strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
			return errors.New("path segment has a trailing dot or space")
		}
		if reservedDevicePattern.MatchString(segment) {
			return fmt.Errorf("path segment %q is a reserved Windows device name", segment)
		}
	}
	return nil
}
