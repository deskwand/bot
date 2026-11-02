package release

// Package is a verified release bundle. The zero value is not usable; the
// only production constructor is TrustedKeys.VerifyPackage, which validates
// the signature and every listed module before returning.
type Package struct {
	manifestJSON []byte
	manifest     Manifest
	modules      map[string][]byte
}

// ManifestJSON returns a copy of the exact signed manifest bytes.
func (p Package) ManifestJSON() []byte {
	if p.manifestJSON == nil {
		return nil
	}
	return append([]byte(nil), p.manifestJSON...)
}

// Manifest returns the parsed, verified manifest.
func (p Package) Manifest() Manifest { return p.manifest }

// Version returns the release version from the verified manifest.
func (p Package) Version() string { return p.manifest.Version }

// Modules returns a deep copy of the verified module map. Callers may mutate
// the returned map without changing the package.
func (p Package) Modules() map[string][]byte {
	if p.modules == nil {
		return nil
	}
	copied := make(map[string][]byte, len(p.modules))
	for path, data := range p.modules {
		copied[path] = append([]byte(nil), data...)
	}
	return copied
}

// VerifyPackage is VerifyWithKeys plus construction of the verified Package.
// It is the only production entry point that produces a Package.
func (keys TrustedKeys) VerifyPackage(manifest, signature []byte, files map[string][]byte) (Package, error) {
	var header struct {
		KeyID string `json:"keyId"`
	}
	if err := jsonUnmarshal(manifest, &header); err != nil {
		return Package{}, err
	}
	if header.KeyID == "" {
		return Package{}, errEmptyKeyID
	}
	key, ok := keys[header.KeyID]
	if !ok {
		return Package{}, untrustedKeyError(header.KeyID)
	}
	parsed, err := verify(manifest, signature, key, files)
	if err != nil {
		return Package{}, err
	}
	if parsed.KeyID != header.KeyID {
		return Package{}, keyMismatchError(parsed.KeyID, header.KeyID)
	}

	modules := make(map[string][]byte, len(files))
	for path, data := range files {
		modules[path] = append([]byte(nil), data...)
	}
	return Package{
		manifestJSON: append([]byte(nil), manifest...),
		manifest:     *parsed,
		modules:      modules,
	}, nil
}
