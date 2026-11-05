// Package app exposes frontend-safe deployment operations. Summaries contain
// only operation identifiers, state, messages, names and public URLs; they
// never contain API tokens, secret values, DESKWAND_CONFIG bytes, SettingsJSON
// or any other raw remote settings.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/release"
)

// DeploymentLifecycle is the install/import/upgrade surface. The concrete
// deployment.Lifecycle implements it; tests inject a recording fake.
type DeploymentLifecycle interface {
	Install(ctx context.Context, request deployment.InstallRequest) (domain.Result, error)
	InspectImport(ctx context.Context, target domain.Target) (deployment.ImportPreview, error)
	ConfirmImport(ctx context.Context, target domain.Target, confirmation deployment.ImportConfirmation) (domain.Result, error)
	Upgrade(ctx context.Context, target domain.Target, pkg release.Package) (domain.Result, error)
}

// OperationReader reads one journaled operation. *deployment.Journal
// implements it.
type OperationReader interface {
	Load(operationID string) (deployment.OperationRecord, error)
}

// ModelRefInput is one role model chosen in the UI.
type ModelRefInput struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

// InstallDeploymentInput is the frontend install request.
type InstallDeploymentInput struct {
	AccountID       string        `json:"accountId"`
	WorkerName      string        `json:"workerName"`
	BucketName      string        `json:"bucketName"`
	TelegramUserIDs []int64       `json:"telegramUserIds"`
	ButlerModel     ModelRefInput `json:"butlerModel"`
	TaskModel       ModelRefInput `json:"taskModel"`
	ActiveChannel   string        `json:"activeChannel"`
}

// DeploymentStepSummary is one journaled step safe for display.
type DeploymentStepSummary struct {
	ID       string `json:"id"`
	State    string `json:"state"`
	Message  string `json:"message"`
	Evidence string `json:"evidence,omitempty"`
}

// DeploymentSummary is the frontend view of one install/import/upgrade.
type DeploymentSummary struct {
	OperationID    string                  `json:"operationId"`
	DeploymentID   string                  `json:"deploymentId,omitempty"`
	VersionID      string                  `json:"versionId,omitempty"`
	State          string                  `json:"state"`
	WorkerName     string                  `json:"workerName,omitempty"`
	ReleaseVersion string                  `json:"releaseVersion,omitempty"`
	PublicBaseURL  string                  `json:"publicBaseUrl,omitempty"`
	ActiveChannel  string                  `json:"activeChannel,omitempty"`
	Steps          []DeploymentStepSummary `json:"steps,omitempty"`
	Warnings       []string                `json:"warnings,omitempty"`
}

// PlaintextSecretSummary names an inline credential migration. It never
// carries the discovered value.
type PlaintextSecretSummary struct {
	Field      string `json:"field"`
	SecretName string `json:"secretName"`
	Reference  string `json:"reference"`
}

// ImportPreviewSummary is the frontend view of an existing deployment.
type ImportPreviewSummary struct {
	AccountID           string                   `json:"accountId"`
	WorkerName          string                   `json:"workerName"`
	ReleaseVersion      string                   `json:"releaseVersion,omitempty"`
	Legacy              bool                     `json:"legacy"`
	ConfigPresent       bool                     `json:"configPresent"`
	OwnerConfigured     bool                     `json:"ownerConfigured"`
	ModelsConfigured    bool                     `json:"modelsConfigured"`
	ActiveChannel       string                   `json:"activeChannel,omitempty"`
	SecretNames         []string                 `json:"secretNames"`
	PreserveSecretNames []string                 `json:"preserveSecretNames"`
	PlaintextSecrets    []PlaintextSecretSummary `json:"plaintextSecrets,omitempty"`
	RequiredInputs      []string                 `json:"requiredInputs,omitempty"`
	Warnings            []string                 `json:"warnings,omitempty"`
}

// ConfirmImportInput supplies re-entered owner/models and migrated secret
// values. SecretValues are input-only and never returned, logged or marshaled.
type ConfirmImportInput struct {
	AccountID       string            `json:"accountId"`
	WorkerName      string            `json:"workerName"`
	TelegramUserIDs *[]int64          `json:"telegramUserIds"`
	ButlerModel     *ModelRefInput    `json:"butlerModel"`
	TaskModel       *ModelRefInput    `json:"taskModel"`
	SecretValues    map[string]string `json:"-"`
	BaseFingerprint string            `json:"baseFingerprint,omitempty"`
}

type confirmImportInputJSON struct {
	AccountID       string         `json:"accountId"`
	WorkerName      string         `json:"workerName"`
	TelegramUserIDs *[]int64       `json:"telegramUserIds"`
	ButlerModel     *ModelRefInput `json:"butlerModel"`
	TaskModel       *ModelRefInput `json:"taskModel"`
	BaseFingerprint string         `json:"baseFingerprint,omitempty"`
}

func (i ConfirmImportInput) MarshalJSON() ([]byte, error) {
	return json.Marshal(confirmImportInputJSON{
		AccountID:       i.AccountID,
		WorkerName:      i.WorkerName,
		TelegramUserIDs: i.TelegramUserIDs,
		ButlerModel:     i.ButlerModel,
		TaskModel:       i.TaskModel,
		BaseFingerprint: i.BaseFingerprint,
	})
}

func (i ConfirmImportInput) String() string {
	return fmt.Sprintf("ConfirmImportInput{account=%q worker=%q ownerSet=%v butlerSet=%v taskSet=%v base=%q secretNames=%v}",
		i.AccountID, i.WorkerName, i.TelegramUserIDs != nil, i.ButlerModel != nil, i.TaskModel != nil,
		i.BaseFingerprint, i.secretNames())
}

func (i ConfirmImportInput) GoString() string { return i.String() }

func (i ConfirmImportInput) Format(state fmt.State, _ rune) {
	fmt.Fprintf(state, "%s", i.String())
}

func (i ConfirmImportInput) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("accountId", i.AccountID),
		slog.String("workerName", i.WorkerName),
		slog.Bool("ownerSet", i.TelegramUserIDs != nil),
		slog.Bool("butlerSet", i.ButlerModel != nil),
		slog.Bool("taskSet", i.TaskModel != nil),
		slog.String("baseFingerprint", i.BaseFingerprint),
		slog.Any("secretNames", i.secretNames()),
	)
}

func (i ConfirmImportInput) secretNames() []string {
	names := make([]string, 0, len(i.SecretValues))
	for name := range i.SecretValues {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// UpgradeDeploymentInput selects the existing deployment to upgrade.
type UpgradeDeploymentInput struct {
	AccountID  string `json:"accountId"`
	WorkerName string `json:"workerName"`
}

// DeploymentsService binds deployment operations to frontend-safe DTOs.
type DeploymentsService struct {
	lifecycle DeploymentLifecycle
	journal   OperationReader
	pkg       release.Package
	// Locale supplies the language for warnings; nil means zh.
	Locale func() string
}

func (s *DeploymentsService) lang() string {
	if s.Locale == nil {
		return i18n.ZH
	}
	return s.Locale()
}

// NewDeploymentsService constructs the app service with the verified package
// used by upgrades.
func NewDeploymentsService(lifecycle DeploymentLifecycle, journal OperationReader, pkg release.Package) *DeploymentsService {
	return &DeploymentsService{lifecycle: lifecycle, journal: journal, pkg: pkg}
}

// InstallDeployment creates a new deployment.
func (s *DeploymentsService) InstallDeployment(ctx context.Context, input InstallDeploymentInput) (DeploymentSummary, error) {
	butler, err := modelInput(input.ButlerModel)
	if err != nil {
		return DeploymentSummary{}, err
	}
	task, err := modelInput(input.TaskModel)
	if err != nil {
		return DeploymentSummary{}, err
	}
	result, err := s.lifecycle.Install(ctx, deployment.InstallRequest{
		AccountID:  input.AccountID,
		WorkerName: input.WorkerName,
		BucketName: input.BucketName,
		Config: deployment.InstallConfig{
			TelegramUserIDs: append([]int64(nil), input.TelegramUserIDs...),
			ButlerModel:     butler,
			TaskModel:       task,
		},
		ActiveChannel: input.ActiveChannel,
	})
	summary := s.summary(result, input.WorkerName)
	if err != nil {
		return summary, safeDeploymentError(err)
	}
	if len(input.TelegramUserIDs) == 0 {
		summary.Warnings = append(summary.Warnings, i18n.T(s.lang(), "app.ownerMissing"))
	}
	return summary, nil
}

// InspectDeploymentImport reads an existing deployment without writing.
func (s *DeploymentsService) InspectDeploymentImport(ctx context.Context, accountID, workerName string) (ImportPreviewSummary, error) {
	preview, err := s.lifecycle.InspectImport(ctx, domain.Target{AccountID: accountID, ScriptName: workerName})
	summary := ImportPreviewSummary{
		AccountID:           accountID,
		WorkerName:          workerName,
		ReleaseVersion:      preview.ReleaseVersion,
		Legacy:              preview.Legacy,
		ConfigPresent:       preview.ConfigPresent,
		OwnerConfigured:     preview.OwnerConfigured,
		ModelsConfigured:    preview.ModelsConfigured,
		ActiveChannel:       preview.ActiveChannel,
		SecretNames:         visibleSecretNames(preview.SecretNames),
		PreserveSecretNames: visibleSecretNames(preview.PreserveSecretNames),
		RequiredInputs:      append([]string(nil), preview.RequiredInputs...),
		Warnings:            append([]string(nil), preview.Warnings...),
	}
	for _, migration := range preview.PlaintextSecrets {
		summary.PlaintextSecrets = append(summary.PlaintextSecrets, PlaintextSecretSummary{
			Field:      migration.Path,
			SecretName: migration.SecretName,
			Reference:  migration.Reference,
		})
	}
	if err != nil {
		return summary, safeDeploymentError(err)
	}
	return summary, nil
}

// ConfirmDeploymentImport publishes the confirmed import through the Task 6
// versioned publish path.
func (s *DeploymentsService) ConfirmDeploymentImport(ctx context.Context, input ConfirmImportInput) (DeploymentSummary, error) {
	butler, err := optionalModelInput(input.ButlerModel)
	if err != nil {
		return DeploymentSummary{}, err
	}
	task, err := optionalModelInput(input.TaskModel)
	if err != nil {
		return DeploymentSummary{}, err
	}
	result, err := s.lifecycle.ConfirmImport(ctx, domain.Target{AccountID: input.AccountID, ScriptName: input.WorkerName}, deployment.ImportConfirmation{
		BaseFingerprint: input.BaseFingerprint,
		TelegramUserIDs: input.TelegramUserIDs,
		ButlerModel:     butler,
		TaskModel:       task,
		SecretValues:    input.SecretValues,
	})
	summary := s.summary(result, input.WorkerName)
	return summary, safeDeploymentError(err)
}

// UpgradeDeployment upgrades an existing deployment with the verified package
// held by the service.
func (s *DeploymentsService) UpgradeDeployment(ctx context.Context, input UpgradeDeploymentInput) (DeploymentSummary, error) {
	result, err := s.lifecycle.Upgrade(ctx, domain.Target{AccountID: input.AccountID, ScriptName: input.WorkerName}, s.pkg)
	return s.summary(result, input.WorkerName), safeDeploymentError(err)
}

// AbandonDeployment cancels an unfinished install record without deleting any
// remote resource.
func (s *DeploymentsService) AbandonDeployment(ctx context.Context, operationID string) (DeploymentSummary, error) {
	abandoner, ok := s.lifecycle.(interface {
		Abandon(context.Context, string) (domain.Result, error)
	})
	if !ok {
		return DeploymentSummary{}, errors.New("deployment: abandon is not supported")
	}
	result, err := abandoner.Abandon(ctx, operationID)
	return s.summary(result, ""), safeDeploymentError(err)
}

// DeploymentOperation returns the safe state of one journaled operation.
func (s *DeploymentsService) DeploymentOperation(_ context.Context, operationID string) (DeploymentSummary, error) {
	if s.journal == nil {
		return DeploymentSummary{}, errors.New("deployment: no operation journal is configured")
	}
	record, err := s.journal.Load(operationID)
	if err != nil {
		return DeploymentSummary{}, safeDeploymentError(err)
	}
	return s.summaryFromRecord(record), nil
}

func (s *DeploymentsService) summary(result domain.Result, workerName string) DeploymentSummary {
	summary := DeploymentSummary{
		OperationID:  result.OperationID,
		DeploymentID: result.DeploymentID,
		VersionID:    result.VersionID,
		State:        result.State,
		WorkerName:   workerName,
	}
	if result.OperationID != "" && s.journal != nil {
		if record, err := s.journal.Load(result.OperationID); err == nil {
			fromRecord := s.summaryFromRecord(record)
			fromRecord.OperationID = result.OperationID
			fromRecord.DeploymentID = result.DeploymentID
			fromRecord.VersionID = result.VersionID
			fromRecord.State = result.State
			if fromRecord.WorkerName == "" {
				fromRecord.WorkerName = workerName
			}
			return fromRecord
		}
	}
	return summary
}

func (s *DeploymentsService) summaryFromRecord(record deployment.OperationRecord) DeploymentSummary {
	summary := DeploymentSummary{
		OperationID:    record.OperationID,
		DeploymentID:   record.DeploymentID,
		VersionID:      record.StagedVersionID,
		State:          record.State,
		WorkerName:     record.Target.ScriptName,
		ReleaseVersion: record.ReleaseVersion,
		PublicBaseURL:  record.PublicBaseURL,
		ActiveChannel:  record.ActiveChannel,
	}
	for _, step := range record.Steps {
		summary.Steps = append(summary.Steps, DeploymentStepSummary{
			ID:       step.ID,
			State:    step.State,
			Message:  step.Message,
			Evidence: step.Evidence,
		})
	}
	return summary
}

func modelInput(input ModelRefInput) (json.RawMessage, error) {
	if input.Provider == "" || input.ID == "" {
		return nil, domain.Error{Code: deployment.CodeInvalidRequest, Message: "both role models require a provider and an id"}
	}
	return json.Marshal(map[string]string{"provider": input.Provider, "id": input.ID})
}

func optionalModelInput(input *ModelRefInput) (*json.RawMessage, error) {
	if input == nil {
		return nil, nil
	}
	raw, err := modelInput(*input)
	if err != nil {
		return nil, err
	}
	return &raw, nil
}

// safeDeploymentError exposes only coded domain errors. Unexpected transport
// or library errors become a fixed message so no remote detail reaches the UI.
func safeDeploymentError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	return errors.New("deployment: operation failed")
}
