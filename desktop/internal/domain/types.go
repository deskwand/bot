// Package domain holds the application-level types shared by the deployment
// client. It has no transport or UI dependencies.
//
// Secret values live only in memory. SecretEdit, Change and PublishPlan all
// implement explicit marshaling and logging methods that omit the value so a
// caller cannot leak a newly entered secret by marshaling or logging a domain
// value.
package domain

import (
	"encoding/json"
	"fmt"
	"log/slog"
)

// Error codes returned in Error.Code. They are stable contract values; the
// message is for humans and never contains a secret.
const (
	CONFIG_CONFLICT          = "CONFIG_CONFLICT"
	UNSUPPORTED_BINDING      = "UNSUPPORTED_BINDING"
	MULTI_VERSION_DEPLOYMENT = "MULTI_VERSION_DEPLOYMENT"
	UNSUPPORTED_SCHEMA       = "UNSUPPORTED_SCHEMA"
	MODEL_SWITCH_REJECTED    = "MODEL_SWITCH_REJECTED"
	LATEST_NOT_BASE          = "LATEST_NOT_BASE"
	NO_ACTIVE_VERSION        = "NO_ACTIVE_VERSION"
	INVALID_SECRET_EDIT      = "INVALID_SECRET_EDIT"
	INVALID_VAR              = "INVALID_VAR"
	MODEL_KEY_MISSING        = "MODEL_KEY_MISSING"
	// NOT_SENT means a mutation was rejected or failed before any remote write
	// could have happened. It is retryable without reconciliation.
	NOT_SENT = "NOT_SENT"
)

// Secret operation names accepted by Merge.
const (
	SecretKeep    = "keep"
	SecretReplace = "replace"
	SecretClear   = "clear"
)

// RedactedValue replaces a nonempty secret value in text representations.
const RedactedValue = "<redacted>"

// Error is a coded domain error. Code is one of the constants above.
type Error struct {
	Code    string
	Message string
}

func (e Error) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}

// As lets callers use either `var e Error` or `var e *Error` with errors.As.
func (e Error) As(target any) bool {
	switch typed := target.(type) {
	case *Error:
		*typed = e
		return true
	case **Error:
		copied := e
		*typed = &copied
		return true
	default:
		return false
	}
}

// Target identifies one Worker script in one account.
type Target struct {
	AccountID  string
	ScriptName string
}

// Snapshot is the read-only state Merge starts from. SettingsJSON keeps the
// full non-secret settings document for round-tripping; secret bindings are
// reduced to their name and type. ConfigJSON is the canonical DESKWAND_CONFIG
// document, or nil when the binding is absent.
type Snapshot struct {
	Target             Target
	DeploymentID       string
	VersionID          string
	ConfigJSON         []byte
	SettingsJSON       []byte
	SecretNames        []string
	Fingerprint        string
	ActiveVersionCount int
	ReleaseVersion     string
	// LatestVersionID is the most recently uploaded version, which may differ
	// from the version currently serving traffic. Version inheritance resolves
	// only from this version, so the publish flow must compare it with
	// VersionID before staging a change.
	LatestVersionID string
}

// SecretEdit is one requested secret operation. The value is kept in an
// unexported field so reflection and gob cannot expose it; use NewSecretEdit
// to construct one and Value to read it for the publish step.
type SecretEdit struct {
	Name      string
	Operation string
	value     string
}

// NewSecretEdit constructs a secret edit. value must be nonempty only for the
// replace operation.
func NewSecretEdit(name, operation, value string) SecretEdit {
	return SecretEdit{Name: name, Operation: operation, value: value}
}

// Value returns the secret value for the publish step. Callers must not log or
// serialize it.
func (e SecretEdit) Value() string { return e.value }

type secretEditJSON struct {
	Name      string `json:"name"`
	Operation string `json:"operation"`
}

// MarshalJSON always omits Value, including the redaction marker.
func (e SecretEdit) MarshalJSON() ([]byte, error) {
	return json.Marshal(secretEditJSON{Name: e.Name, Operation: e.Operation})
}

func (e SecretEdit) safeString() string {
	value := ""
	if e.value != "" {
		value = " value=" + RedactedValue
	}
	return fmt.Sprintf("SecretEdit{name=%q operation=%q%s}", e.Name, e.Operation, value)
}

func (e SecretEdit) String() string { return e.safeString() }

func (e SecretEdit) GoString() string { return e.safeString() }

// Format covers every fmt verb, including %v, %+v, %#v and %s. A containing
// struct that is formatted with %+v still calls this method for the field.
func (e SecretEdit) Format(state fmt.State, _ rune) {
	fmt.Fprintf(state, "%s", e.safeString())
}

func (e SecretEdit) LogValue() slog.Value {
	attrs := []slog.Attr{
		slog.String("name", e.Name),
		slog.String("operation", e.Operation),
	}
	if e.value != "" {
		attrs = append(attrs, slog.String("value", RedactedValue))
	}
	return slog.GroupValue(attrs...)
}

// EditablePatch is the whitelist of UI-editable fields. A nil pointer means
// unchanged; a non-nil pointer to an empty owner slice clears the allowlist;
// non-nil model raw JSON replaces the document at that role.
type EditablePatch struct {
	TelegramUserIDs *[]int64         `json:"telegramUserIds"`
	ButlerModel     *json.RawMessage `json:"butlerModel"`
	TaskModel       *json.RawMessage `json:"taskModel"`
	CustomProviders *json.RawMessage `json:"customProviders"`
	McpServers      *json.RawMessage `json:"mcpServers"`
	Locale          *string          `json:"locale"`
	ApprovalMode    *string          `json:"approvalMode"`
	SearchProvider  *string          `json:"searchProvider"`
}

// ConfigReference rewrites one existing JSON string in DESKWAND_CONFIG to an
// env:NAME secret reference. Import uses it to remove inline credentials from
// an existing configuration without copying the value into a plain variable.
// Path is an RFC 6901 JSON pointer; Reference must be "env:" followed by a
// secret name.
type ConfigReference struct {
	Path      string `json:"path"`
	Reference string `json:"reference"`
}

// Change is the UI intent: a whitelisted patch plus secret edits, based on a
// specific previously read fingerprint. References is an optional, narrow
// migration for inline credentials found during import; it never carries a
// secret value.
type Change struct {
	BaseFingerprint string
	Patch           EditablePatch
	Secrets         []SecretEdit
	References      []ConfigReference
	// Vars overrides plain-text variables such as ACTIVE_CHANNEL. Names must
	// be declared by the release template's plainVars; CreateVersion enforces
	// the allowlist before uploading. Values are never secret.
	Vars map[string]string
	// AllowReleaseChange bypasses the deployed-vs-client release check. Only
	// import and upgrade set it: every versioned publish uploads the embedded
	// Worker code, so ordinary configuration changes must not silently change
	// the cloud release version.
	AllowReleaseChange bool
}

type changeJSON struct {
	BaseFingerprint    string            `json:"baseFingerprint"`
	Patch              EditablePatch     `json:"patch"`
	Secrets            []SecretEdit      `json:"secrets"`
	References         []ConfigReference `json:"references,omitempty"`
	Vars               map[string]string `json:"vars,omitempty"`
	AllowReleaseChange bool              `json:"allowReleaseChange,omitempty"`
}

func (c Change) MarshalJSON() ([]byte, error) {
	return json.Marshal(changeJSON{
		BaseFingerprint:    c.BaseFingerprint,
		Patch:              c.Patch,
		Secrets:            c.Secrets,
		References:         c.References,
		Vars:               c.Vars,
		AllowReleaseChange: c.AllowReleaseChange,
	})
}

func (c Change) String() string {
	return fmt.Sprintf("Change{base=%q patch=%s secrets=%v references=%v vars=%v allowReleaseChange=%v}", c.BaseFingerprint, patchString(c.Patch), c.Secrets, c.References, c.Vars, c.AllowReleaseChange)
}

func (c Change) GoString() string {
	return c.String()
}

func (c Change) Format(state fmt.State, _ rune) {
	fmt.Fprintf(state, "%s", c.String())
}

func (c Change) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("baseFingerprint", c.BaseFingerprint),
		slog.String("patch", patchString(c.Patch)),
		slog.Any("secrets", c.Secrets),
		slog.Any("references", c.References),
		slog.Any("vars", c.Vars),
		slog.Bool("allowReleaseChange", c.AllowReleaseChange),
	)
}

func patchString(p EditablePatch) string {
	owner := "unchanged"
	if p.TelegramUserIDs != nil {
		owner = fmt.Sprintf("%v", *p.TelegramUserIDs)
	}
	butler := "unchanged"
	if p.ButlerModel != nil {
		butler = string(*p.ButlerModel)
	}
	task := "unchanged"
	if p.TaskModel != nil {
		task = string(*p.TaskModel)
	}
	return fmt.Sprintf("EditablePatch{telegramUserIDs=%s butlerModel=%s taskModel=%s}", owner, butler, task)
}

// PublishPlan is the only input accepted by the publish step. ConfigJSON is
// the complete canonical configuration with unknown fields preserved.
type PublishPlan struct {
	BaseVersionID string
	ConfigJSON    []byte
	Secrets       []SecretEdit
	// Vars are plain-text variable overrides validated by CreateVersion
	// against the release template's plainVars allowlist.
	Vars map[string]string
}

type publishPlanJSON struct {
	BaseVersionID string            `json:"baseVersionId"`
	ConfigJSON    json.RawMessage   `json:"configJson"`
	Secrets       []SecretEdit      `json:"secrets"`
	Vars          map[string]string `json:"vars,omitempty"`
}

func (p PublishPlan) MarshalJSON() ([]byte, error) {
	config := p.ConfigJSON
	if len(config) == 0 {
		config = json.RawMessage("null")
	}
	return json.Marshal(publishPlanJSON{BaseVersionID: p.BaseVersionID, ConfigJSON: config, Secrets: p.Secrets, Vars: p.Vars})
}

func (p PublishPlan) String() string {
	return fmt.Sprintf("PublishPlan{baseVersionId=%q configBytes=%d secrets=%v vars=%v}", p.BaseVersionID, len(p.ConfigJSON), p.Secrets, p.Vars)
}

func (p PublishPlan) GoString() string { return p.String() }

func (p PublishPlan) Format(state fmt.State, _ rune) {
	fmt.Fprintf(state, "%s", p.String())
}

func (p PublishPlan) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("baseVersionId", p.BaseVersionID),
		slog.Int("configBytes", len(p.ConfigJSON)),
		slog.String("configJson", string(p.ConfigJSON)),
		slog.Any("secrets", p.Secrets),
		slog.Any("vars", p.Vars),
	)
}

// Step is one journaled publish step.
type Step struct {
	ID       string
	State    string
	Message  string
	Evidence string
}

// Evidence is one sanitized observation used by diagnostics.
type Evidence struct {
	Kind       string
	Source     string
	ObservedAt string
	Detail     string
	VersionID  string
}

// Result is the outcome of a publish operation.
type Result struct {
	OperationID  string
	DeploymentID string
	VersionID    string
	State        string
}
