// Package app exposes the frontend-safe application service. All DTO values
// omit secret values, raw Cloudflare settings and deployment configuration
// bytes. Input DTOs may carry write-only secrets; they are never returned or
// logged.
package app

import (
	"encoding/json"
	"fmt"
	"log/slog"
)

// AccountDTO is a Cloudflare account name and id. It contains no credential.
type AccountDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ConnectionDTO is the local Cloudflare connection state. It never contains a
// token. AccountName is display-only metadata.
type ConnectionDTO struct {
	State       string `json:"state"`
	AccountID   string `json:"accountId,omitempty"`
	AccountName string `json:"accountName,omitempty"`
}

// BootStateDTO is the local-only state the app needs to pick its first
// screen. It is computed without any Cloudflare request.
type BootStateDTO struct {
	Connection     ConnectionDTO  `json:"connection"`
	TargetSelected bool           `json:"targetSelected"`
	TargetMismatch bool           `json:"targetMismatch"`
	TargetName     string         `json:"targetName"`
	Pending        []OperationDTO `json:"pending"`
}

// CloudflareLoginDTO is the only OAuth login state sent to the frontend. It
// carries no token, authorization code or PKCE verifier.
type CloudflareLoginDTO struct {
	OperationID string       `json:"operationId"`
	State       string       `json:"state"`
	Accounts    []AccountDTO `json:"accounts,omitempty"`
	Code        string       `json:"code,omitempty"`
}

// WorkerDTO is one Worker script summary.
type WorkerDTO struct {
	Name         string `json:"name"`
	ModifiedOn   string `json:"modifiedOn,omitempty"`
	MigrationTag string `json:"migrationTag,omitempty"`
}

// ModelDTO is the provider and model id shown in the UI. Provider-specific
// settings in the stored JSON are preserved but not exposed.
type ModelDTO struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

// ModelEntryDTO is one model listed by a built-in provider.
type ModelEntryDTO struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Input []string `json:"input,omitempty"`
}

// ModelProviderDTO is one built-in provider from the shared catalog.
type ModelProviderDTO struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Keyless bool            `json:"keyless,omitempty"`
	Models  []ModelEntryDTO `json:"models"`
}

// ModelCatalogDTO is the built-in provider and model list shown in the UI.
type ModelCatalogDTO struct {
	Providers []ModelProviderDTO `json:"providers"`
}

// CustomModelDTO is one model declared by a custom provider.
type CustomModelDTO struct {
	ID            string `json:"id"`
	ContextWindow int    `json:"contextWindow,omitempty"`
	MaxTokens     int    `json:"maxTokens,omitempty"`
}

// CustomProviderDTO is a deployment's OpenAI- or Anthropic-compatible
// endpoint. It carries no key value.
type CustomProviderDTO struct {
	ID      string           `json:"id"`
	Name    string           `json:"name,omitempty"`
	API     string           `json:"api"`
	BaseURL string           `json:"baseUrl"`
	Models  []CustomModelDTO `json:"models"`
}

// SecretNameDTO reports whether a named secret exists. Values never leave Go.
type SecretNameDTO struct {
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
}

// ConfigDTO is the editable configuration summary.
type ConfigDTO struct {
	AccountID          string              `json:"accountId"`
	WorkerName         string              `json:"workerName"`
	Fingerprint        string              `json:"fingerprint"`
	ReleaseVersion     string              `json:"releaseVersion,omitempty"`
	ActiveVersionCount int                 `json:"activeVersionCount"`
	ConfigPresent      bool                `json:"configPresent"`
	ActiveChannel      string              `json:"activeChannel,omitempty"`
	OwnerUserIDs       []int64             `json:"ownerUserIds"`
	ButlerModel        *ModelDTO           `json:"butlerModel"`
	TaskModel          *ModelDTO           `json:"taskModel"`
	CustomProviders    []CustomProviderDTO `json:"customProviders"`
	McpServers         json.RawMessage     `json:"mcpServers"`
	Secrets            []SecretNameDTO     `json:"secrets"`
}

// SecretEditDTO is a write-only secret edit. Value is accepted from the
// frontend and never returned in any DTO, error or journal.
type SecretEditDTO struct {
	Name      string `json:"name"`
	Operation string `json:"operation"`
	Value     string `json:"value,omitempty"`
}

// MarshalJSON deliberately omits Value. The field is accepted on input but
// never serialized into a response, journal or diagnostic export.
func (s SecretEditDTO) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Name      string `json:"name"`
		Operation string `json:"operation"`
	}{Name: s.Name, Operation: s.Operation})
}

func (s SecretEditDTO) safeString() string {
	value := ""
	if s.Value != "" {
		value = " value=<redacted>"
	}
	return fmt.Sprintf("SecretEditDTO{name=%q operation=%q%s}", s.Name, s.Operation, value)
}

func (s SecretEditDTO) String() string { return s.safeString() }

func (s SecretEditDTO) GoString() string { return s.safeString() }

func (s SecretEditDTO) Format(state fmt.State, _ rune) {
	fmt.Fprint(state, s.safeString())
}

func (s SecretEditDTO) LogValue() slog.Value {
	attrs := []slog.Attr{slog.String("name", s.Name), slog.String("operation", s.Operation)}
	if s.Value != "" {
		attrs = append(attrs, slog.String("value", "<redacted>"))
	}
	return slog.GroupValue(attrs...)
}

// CachedConfigDTO is the last config written to the local snapshot cache. An
// absent cache is a nil Data and an empty SavedAt.
type CachedConfigDTO struct {
	Data    *ConfigDTO `json:"data"`
	SavedAt string     `json:"savedAt"`
}

// CachedStatusDTO is the last status written to the local snapshot cache. An
// absent cache is a nil Data and an empty SavedAt.
type CachedStatusDTO struct {
	Data    []StatusItemDTO `json:"data"`
	SavedAt string          `json:"savedAt"`
}

// ConfigEditDTO is the 保存并发布 input. A nil owner or model means unchanged;
// an empty owner slice clears the allowlist. Secrets are write-only.
type ConfigEditDTO struct {
	BaseFingerprint string               `json:"baseFingerprint,omitempty"`
	OwnerUserIDs    *[]int64             `json:"ownerUserIds,omitempty"`
	ButlerModel     *ModelDTO            `json:"butlerModel,omitempty"`
	TaskModel       *ModelDTO            `json:"taskModel,omitempty"`
	CustomProviders *[]CustomProviderDTO `json:"customProviders,omitempty"`
	McpServers      *json.RawMessage     `json:"mcpServers,omitempty"`
	Secrets         []SecretEditDTO      `json:"secrets,omitempty"`
}

// StepDTO is one planned or journaled publish step.
type StepDTO struct {
	ID       string `json:"id"`
	State    string `json:"state"`
	Message  string `json:"message"`
	Evidence string `json:"evidence,omitempty"`
}

// ResultDTO is the outcome of one deployment operation.
type ResultDTO struct {
	OperationID    string    `json:"operationId"`
	DeploymentID   string    `json:"deploymentId,omitempty"`
	VersionID      string    `json:"versionId,omitempty"`
	State          string    `json:"state"`
	WorkerName     string    `json:"workerName,omitempty"`
	ReleaseVersion string    `json:"releaseVersion,omitempty"`
	PublicBaseURL  string    `json:"publicBaseUrl,omitempty"`
	ActiveChannel  string    `json:"activeChannel,omitempty"`
	Steps          []StepDTO `json:"steps,omitempty"`
	Warnings       []string  `json:"warnings,omitempty"`
}

// OperationDTO is one journaled operation summary for the resume view.
type OperationDTO struct {
	OperationID    string    `json:"operationId"`
	Kind           string    `json:"kind,omitempty"`
	AccountID      string    `json:"accountId"`
	WorkerName     string    `json:"workerName"`
	State          string    `json:"state"`
	ReleaseVersion string    `json:"releaseVersion,omitempty"`
	ActiveChannel  string    `json:"activeChannel,omitempty"`
	Steps          []StepDTO `json:"steps,omitempty"`
	CreatedAt      string    `json:"createdAt,omitempty"`
	UpdatedAt      string    `json:"updatedAt,omitempty"`
}

// PlaintextSecretDTO names an inline credential migration. It never carries
// the discovered value.
type PlaintextSecretDTO struct {
	Field      string `json:"field"`
	SecretName string `json:"secretName"`
	Reference  string `json:"reference"`
}

// ImportPreviewDTO is the frontend view of an existing deployment.
type ImportPreviewDTO struct {
	AccountID           string               `json:"accountId"`
	WorkerName          string               `json:"workerName"`
	ReleaseVersion      string               `json:"releaseVersion,omitempty"`
	Legacy              bool                 `json:"legacy"`
	ConfigPresent       bool                 `json:"configPresent"`
	OwnerConfigured     bool                 `json:"ownerConfigured"`
	ModelsConfigured    bool                 `json:"modelsConfigured"`
	ActiveChannel       string               `json:"activeChannel,omitempty"`
	SecretNames         []string             `json:"secretNames"`
	PreserveSecretNames []string             `json:"preserveSecretNames"`
	PlaintextSecrets    []PlaintextSecretDTO `json:"plaintextSecrets,omitempty"`
	RequiredInputs      []string             `json:"requiredInputs,omitempty"`
	Warnings            []string             `json:"warnings,omitempty"`
}

// ImportSecretDTO is a re-entered credential for one migrated secret. Value is
// write-only.
type ImportSecretDTO struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// MarshalJSON deliberately omits Value. It is a write-only input field.
func (s ImportSecretDTO) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Name string `json:"name"`
	}{Name: s.Name})
}

func (s ImportSecretDTO) safeString() string {
	value := ""
	if s.Value != "" {
		value = " value=<redacted>"
	}
	return fmt.Sprintf("ImportSecretDTO{name=%q%s}", s.Name, value)
}

func (s ImportSecretDTO) String() string { return s.safeString() }

func (s ImportSecretDTO) GoString() string { return s.safeString() }

func (s ImportSecretDTO) Format(state fmt.State, _ rune) {
	fmt.Fprint(state, s.safeString())
}

func (s ImportSecretDTO) LogValue() slog.Value {
	attrs := []slog.Attr{slog.String("name", s.Name)}
	if s.Value != "" {
		attrs = append(attrs, slog.String("value", "<redacted>"))
	}
	return slog.GroupValue(attrs...)
}

// ImportInputDTO supplies the re-entered values for an imported deployment.
// Secrets are write-only.
type ImportInputDTO struct {
	BaseFingerprint string            `json:"baseFingerprint,omitempty"`
	TelegramUserIDs *[]int64          `json:"telegramUserIds,omitempty"`
	ButlerModel     *ModelDTO         `json:"butlerModel,omitempty"`
	TaskModel       *ModelDTO         `json:"taskModel,omitempty"`
	Secrets         []ImportSecretDTO `json:"secrets,omitempty"`
}

// InstallInputDTO is a from-scratch install request.
type InstallInputDTO struct {
	AccountID       string   `json:"accountId"`
	WorkerName      string   `json:"workerName"`
	BucketName      string   `json:"bucketName"`
	TelegramUserIDs []int64  `json:"telegramUserIds"`
	ButlerModel     ModelDTO `json:"butlerModel"`
	TaskModel       ModelDTO `json:"taskModel"`
	ActiveChannel   string   `json:"activeChannel"`
}

// UpgradeDTO reports whether the embedded release is newer than the deployment.
type UpgradeDTO struct {
	Available        bool     `json:"available"`
	CurrentVersion   string   `json:"currentVersion,omitempty"`
	AvailableVersion string   `json:"availableVersion,omitempty"`
	Reason           string   `json:"reason,omitempty"`
	ModelKeysMissing []string `json:"modelKeysMissing,omitempty"`
}

// LoginStatusDTO is the only WeChat login state sent to the frontend. It has
// no credential field.
type LoginStatusDTO struct {
	OperationID string `json:"operationId"`
	State       string `json:"state"`
	QRContent   string `json:"qrContent,omitempty"`
	Message     string `json:"message,omitempty"`
	Code        string `json:"code,omitempty"`
}

// EntryResultDTO reports the selected entry and whether it has credentials.
type EntryResultDTO struct {
	OperationID  string `json:"operationId,omitempty"`
	DeploymentID string `json:"deploymentId,omitempty"`
	VersionID    string `json:"versionId,omitempty"`
	State        string `json:"state,omitempty"`
	Channel      string `json:"channel"`
	Configured   bool   `json:"configured"`
	Warning      string `json:"warning,omitempty"`
}

// StatusItemDTO is one evidence-based status row.
type StatusItemDTO struct {
	Kind       string `json:"kind"`
	State      string `json:"state"`
	Source     string `json:"source,omitempty"`
	ObservedAt string `json:"observedAt"`
	Detail     string `json:"detail"`
}
