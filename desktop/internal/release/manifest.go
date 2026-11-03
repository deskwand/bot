// Package release verifies precompiled Worker release packages before the
// deployment client uploads them. The manifest is the signed authority for
// module contents, compatibility settings, the resource template and the
// Durable Object migration history.
package release

// ManifestVersion is the only release manifest version understood by this
// client. A new manifest shape requires a new client key set or a new
// manifestVersion and explicit verifier support.
const ManifestVersion = 1

// SupportedConfigSchemaVersion is the deployment-config schema version this
// client can publish. It must match contracts/deployment-config.schema.json.
const SupportedConfigSchemaVersion = 1

// Release size limits.
//
// The supported plan is the Workers free plan, which allows 3 MB after
// compression. The signed manifest carries `compressedSize`, measured by the
// TypeScript builder as the sum of gzip level 9 sizes for each module. The
// verifier checks the signed value against MaxCompressedBytes; it does not
// recompress the files.
//
// The uncompressed bounds are local sanity guards, not Cloudflare limits.
// They keep a malformed or hostile manifest from forcing excessive memory use
// in the client. The TypeScript builder uses the same constants; changing
// either side without the other is a contract break.
const (
	MaxCompressedBytes  int64 = 3_000_000
	MaxFileSanityBytes  int64 = 32 << 20 // 32 MiB
	MaxTotalSanityBytes int64 = 64 << 20 // 64 MiB
)

// Manifest is the canonical, signed description of a Worker release.
type Manifest struct {
	ManifestVersion     int              `json:"manifestVersion"`
	KeyID               string           `json:"keyId"`
	Version             string           `json:"version"`
	Entrypoint          string           `json:"entrypoint"`
	Files               []FileEntry      `json:"files"`
	CompressedSize      int64            `json:"compressedSize"`
	ConfigSchemaVersion int              `json:"configSchemaVersion"`
	Compatibility       Compatibility    `json:"compatibility"`
	ResourceTemplate    ResourceTemplate `json:"resourceTemplate"`
	Migrations          []Migration      `json:"migrations"`
	Upgrade             Upgrade          `json:"upgrade"`
}

// FileEntry identifies one Worker module by path, SHA-256 digest and size.
type FileEntry struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Compatibility is the Workers compatibility date and flag set.
type Compatibility struct {
	Date  string   `json:"date"`
	Flags []string `json:"flags"`
}

// Upgrade records the oldest release version that may be upgraded from and
// any migrations that cannot be rolled back.
type Upgrade struct {
	MinFromVersion         string   `json:"minFromVersion"`
	IrreversibleMigrations []string `json:"irreversibleMigrations"`
}

// Migration is one Durable Object migration tag. The full history is carried
// so a deploy step can apply migrations even though a versions-only upload
// does not apply Durable Object lifecycle changes.
type Migration struct {
	Tag              string   `json:"tag"`
	NewSQLiteClasses []string `json:"newSqliteClasses,omitempty"`
}

// ResourceTemplate is the install-time resource description. Names that vary
// per installation are represented by install parameter keys, not by fixed
// personal values.
type ResourceTemplate struct {
	SchemaVersion      int                `json:"schemaVersion"`
	Entrypoint         string             `json:"entrypoint"`
	Compatibility      Compatibility      `json:"compatibility"`
	DurableObjects     []DOBinding        `json:"durableObjects"`
	R2Buckets          []R2Binding        `json:"r2Buckets"`
	AIBindings         []AIBinding        `json:"aiBindings"`
	VersionMetadata    BindingRef         `json:"versionMetadataBinding"`
	Observability      *Observability     `json:"observability"`
	ConfigBinding      ConfigBinding      `json:"configBinding"`
	SecretNamePatterns []string           `json:"secretNamePatterns"`
	SecretNames        []string           `json:"secretNames"`
	PlainVars          []string           `json:"plainVars"`
	Crons              []string           `json:"crons"`
	Vars               []VarBinding       `json:"vars"`
	Migrations         []Migration        `json:"migrations"`
	InstallParams      []InstallParameter `json:"installParameters"`
}

// AIBinding is a Workers AI binding the release template declares. It carries
// no install parameter: the platform provides the model catalogue.
type AIBinding struct {
	Name string `json:"name"`
}

// Observability is the script-level logging configuration required for
// diagnostics. Field names match the Cloudflare script-settings API so the
// explicit script-settings patch uses the same shape as the release template.
type Observability struct {
	Enabled          bool              `json:"enabled"`
	HeadSamplingRate float64           `json:"head_sampling_rate"`
	Logs             ObservabilityLogs `json:"logs"`
}

// ObservabilityLogs keeps persisted structured logs while disabling the noisy
// per-invocation log line.
type ObservabilityLogs struct {
	InvocationLogs bool `json:"invocation_logs"`
}

// ConfigBinding describes the single JSON binding that carries the editable
// deployment configuration. Snapshot reads and Merge both key off this name.
type ConfigBinding struct {
	Name          string `json:"name"`
	Type          string `json:"type"`
	SchemaVersion int    `json:"schemaVersion"`
}

// DOBinding names a Durable Object binding and its exported class.
type DOBinding struct {
	Name      string `json:"name"`
	ClassName string `json:"className"`
}

// R2Binding names an R2 binding and the install parameter supplying the
// bucket name.
type R2Binding struct {
	Name         string `json:"name"`
	ParameterKey string `json:"parameterKey"`
}

// BindingRef names a binding that has no install-time parameter.
type BindingRef struct {
	Name string `json:"name"`
}

// VarBinding names a plain-text variable and the install parameter supplying
// its value.
type VarBinding struct {
	Name         string `json:"name"`
	ParameterKey string `json:"parameterKey"`
}

// InstallParameter is a key the installer must supply. Source is either
// "user" or the configuration binding name (for example DESKWAND_CONFIG).
type InstallParameter struct {
	Key    string `json:"key"`
	Source string `json:"source"`
}
