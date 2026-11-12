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

// LocaleDTO is the language the UI shows: the stored source and the zh/en
// locale it resolves to.
type LocaleDTO struct {
	Source   string `json:"source"`
	Resolved string `json:"resolved"`
}

// ModelDTO is the provider and model id shown in the UI. Provider-specific
// settings in the stored JSON are preserved but not exposed, except the
// thinking level, which the UI edits next to the model.
type ModelDTO struct {
	Provider      string  `json:"provider"`
	ID            string  `json:"id"`
	ThinkingLevel *string `json:"thinkingLevel,omitempty"`
}

// ModelEntryDTO is one model listed by a built-in provider.
type ModelEntryDTO struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Input []string `json:"input,omitempty"`
	// ThinkingLevels is empty when the model has nothing to choose.
	ThinkingLevels []string `json:"thinkingLevels,omitempty"`
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
	AccountID          string               `json:"accountId"`
	WorkerName         string               `json:"workerName"`
	Fingerprint        string               `json:"fingerprint"`
	ReleaseVersion     string               `json:"releaseVersion,omitempty"`
	ActiveVersionCount int                  `json:"activeVersionCount"`
	ConfigPresent      bool                 `json:"configPresent"`
	ActiveChannel      string               `json:"activeChannel,omitempty"`
	OwnerUserIDs       []int64              `json:"ownerUserIds"`
	ButlerModel        *ModelDTO            `json:"butlerModel"`
	TaskModel          *ModelDTO            `json:"taskModel"`
	CustomProviders    []CustomProviderDTO  `json:"customProviders"`
	McpServers         json.RawMessage      `json:"mcpServers"`
	Locale             string               `json:"locale"`
	ApprovalMode       string               `json:"approvalMode"`
	SearchProvider     string               `json:"searchProvider"`
	ExchangeAccounts   []ExchangeAccountDTO `json:"exchangeAccounts"`
	Secrets            []SecretNameDTO      `json:"secrets"`
}

// ExchangeProbeDTO is one account's health check from the deployed Worker.
type ExchangeProbeDTO struct {
	OK         bool     `json:"ok"`
	Venue      string   `json:"venue,omitempty"`
	Currencies int      `json:"currencies"`
	Total      *float64 `json:"total,omitempty"`
	Code       string   `json:"code,omitempty"`
	Message    string   `json:"message,omitempty"`
}

// ExchangeSyncDTO is one locally stored Binance account's last desktop sync.
// At is RFC3339 and empty until the account synced once; Code and Message
// describe a refusal, never a secret.
type ExchangeSyncDTO struct {
	AccountID  string   `json:"accountId"`
	At         string   `json:"at,omitempty"`
	OK         bool     `json:"ok"`
	Currencies int      `json:"currencies,omitempty"`
	Total      *float64 `json:"total,omitempty"`
	Code       string   `json:"code,omitempty"`
	Message    string   `json:"message,omitempty"`
}

// ExchangeAccountDTO is one exchange account in the config document. Secrets
// never appear here; they travel as EXCHANGE_SECRET_<ID> edits.
type ExchangeAccountDTO struct {
	ID      string `json:"id"`
	Venue   string `json:"venue"`
	Label   string `json:"label,omitempty"`
	BaseURL string `json:"baseUrl,omitempty"`
}

// WalletStatusDTO is the deployed wallet's public state. The owner address
// and the private key never appear here.
type WalletStatusDTO struct {
	Configured bool     `json:"configured"`
	Address    string   `json:"address,omitempty"`
	ValueUSD   *float64 `json:"valueUsd,omitempty"`
}

// WalletEditDTO is the write-only 保存钱包 input. An empty field means
// unchanged, so a page that only changes the RPC URL never rewrites a secret.
type WalletEditDTO struct {
	PrivateKey   string `json:"privateKey,omitempty"`
	OwnerAddress string `json:"ownerAddress,omitempty"`
	RPCURL       string `json:"rpcUrl,omitempty"`
}

// WalletSectionDTO is the public half of the wallet config section.
type WalletSectionDTO struct {
	RPCURL string `json:"rpcUrl"`
}

// LifeSourceDTO is one entry in the vitals' spend ranking.
type LifeSourceDTO struct {
	Source string  `json:"source"`
	USD    float64 `json:"usd"`
}

// LifeVitalsDTO is the deployed life ledger's read-only state. TopSources is
// always an array, never null.
type LifeVitalsDTO struct {
	BalanceUSD        float64         `json:"balanceUsd"`
	DailySpendUSD     float64         `json:"dailySpendUsd"`
	RunwayDays        *float64        `json:"runwayDays"`
	Tier              string          `json:"tier"`
	MetabolismStarted bool            `json:"metabolismStarted"`
	Unpriced          bool            `json:"unpriced"`
	TopSources        []LifeSourceDTO `json:"topSources"`
}

// MarshalJSON omits the write-only values, like SecretEditDTO.
func (w WalletEditDTO) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		RPCURL string `json:"rpcUrl,omitempty"`
	}{RPCURL: w.RPCURL})
}

func (w WalletEditDTO) safeString() string {
	return fmt.Sprintf("WalletEditDTO{privateKey=%q ownerAddress=%q rpcUrl=%q}",
		redactedIfSet(w.PrivateKey), redactedIfSet(w.OwnerAddress), redactedIfSet(w.RPCURL))
}

func (w WalletEditDTO) String() string { return w.safeString() }

func (w WalletEditDTO) GoString() string { return w.safeString() }

func (w WalletEditDTO) Format(state fmt.State, _ rune) {
	fmt.Fprint(state, w.safeString())
}

func (w WalletEditDTO) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("privateKey", redactedIfSet(w.PrivateKey)),
		slog.String("ownerAddress", redactedIfSet(w.OwnerAddress)),
		slog.String("rpcUrl", redactedIfSet(w.RPCURL)),
	)
}

func redactedIfSet(value string) string {
	if value == "" {
		return ""
	}
	return "<redacted>"
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
	BaseFingerprint  string                `json:"baseFingerprint,omitempty"`
	OwnerUserIDs     *[]int64              `json:"ownerUserIds,omitempty"`
	ButlerModel      *ModelDTO             `json:"butlerModel,omitempty"`
	TaskModel        *ModelDTO             `json:"taskModel,omitempty"`
	CustomProviders  *[]CustomProviderDTO  `json:"customProviders,omitempty"`
	McpServers       *json.RawMessage      `json:"mcpServers,omitempty"`
	ApprovalMode     *string               `json:"approvalMode,omitempty"`
	SearchProvider   *string               `json:"searchProvider,omitempty"`
	ExchangeAccounts *[]ExchangeAccountDTO `json:"exchangeAccounts,omitempty"`
	Wallet           *WalletSectionDTO     `json:"wallet,omitempty"`
	Secrets          []SecretEditDTO       `json:"secrets,omitempty"`
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
