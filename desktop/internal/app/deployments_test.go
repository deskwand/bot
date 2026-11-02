package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

type fakeDeploymentLifecycle struct {
	installRequest deployment.InstallRequest
	installResult  domain.Result
	installErr     error
	inspectPreview deployment.ImportPreview
	inspectErr     error
	confirmChange  deployment.ImportConfirmation
	confirmResult  domain.Result
	confirmErr     error
	upgradePackage release.Package
	upgradeResult  domain.Result
	upgradeErr     error
	abandonResult  domain.Result
	abandonErr     error
}

func (f *fakeDeploymentLifecycle) Install(_ context.Context, request deployment.InstallRequest) (domain.Result, error) {
	f.installRequest = request
	return f.installResult, f.installErr
}

func (f *fakeDeploymentLifecycle) InspectImport(context.Context, domain.Target) (deployment.ImportPreview, error) {
	return f.inspectPreview, f.inspectErr
}

func (f *fakeDeploymentLifecycle) ConfirmImport(_ context.Context, _ domain.Target, confirmation deployment.ImportConfirmation) (domain.Result, error) {
	f.confirmChange = confirmation
	return f.confirmResult, f.confirmErr
}

func (f *fakeDeploymentLifecycle) Upgrade(_ context.Context, _ domain.Target, pkg release.Package) (domain.Result, error) {
	f.upgradePackage = pkg
	return f.upgradeResult, f.upgradeErr
}

func (f *fakeDeploymentLifecycle) Abandon(context.Context, string) (domain.Result, error) {
	return f.abandonResult, f.abandonErr
}

type fakeOperationReader struct {
	records map[string]deployment.OperationRecord
	err     error
}

func (f *fakeOperationReader) Load(operationID string) (deployment.OperationRecord, error) {
	if f.err != nil {
		return deployment.OperationRecord{}, f.err
	}
	record, ok := f.records[operationID]
	if !ok {
		return deployment.OperationRecord{}, errors.New("not found")
	}
	return record, nil
}

const appDeploymentSecretSentinel = "APP-DEPLOYMENT-secret-sentinel"

func TestInstallDeploymentSummaryIsFrontendSafe(t *testing.T) {
	lifecycle := &fakeDeploymentLifecycle{installResult: domain.Result{OperationID: "op-1", State: "published", DeploymentID: "d-1", VersionID: "v-1"}}
	journal := &fakeOperationReader{records: map[string]deployment.OperationRecord{
		"op-1": {
			OperationID:    "op-1",
			Kind:           deployment.KindInstall,
			State:          "published",
			Target:         domain.Target{ScriptName: "deskwand-bot"},
			Steps:          []domain.Step{{ID: "preflight", State: "published", Message: "ok"}},
			ConfigJSON:     []byte(`{"schemaVersion":1,"owner":{"telegramUserIds":[]},"advanced":{"password":"` + appDeploymentSecretSentinel + `"}}`),
			SecretEdits:    []domain.SecretEdit{domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, appDeploymentSecretSentinel)},
			PublicBaseURL:  "https://deskwand-bot.example.workers.dev",
			ReleaseVersion: "1.0.0",
			ActiveChannel:  "telegram",
		},
	}}
	service := NewDeploymentsService(lifecycle, journal, release.Package{})
	summary, err := service.InstallDeployment(context.Background(), InstallDeploymentInput{
		AccountID:       strings.Repeat("a", 32),
		WorkerName:      "deskwand-bot",
		BucketName:      "deskwand-probe-bucket",
		TelegramUserIDs: []int64{},
		ButlerModel:     ModelRefInput{Provider: "opencode-go", ID: "deepseek-v4.1-flash"},
		TaskModel:       ModelRefInput{Provider: "opencode-go", ID: "kimi-k3"},
		ActiveChannel:   "telegram",
	})
	if err != nil {
		t.Fatal(err)
	}
	if summary.OperationID != "op-1" || summary.PublicBaseURL == "" {
		t.Fatalf("summary = %#v", summary)
	}
	if len(summary.Warnings) == 0 || !strings.Contains(summary.Warnings[0], "owner") {
		t.Fatalf("empty owner warning = %#v", summary.Warnings)
	}
	encoded, _ := json.Marshal(summary)
	if bytes.Contains(encoded, []byte(appDeploymentSecretSentinel)) {
		t.Fatal("summary leaked a secret")
	}
	if bytes.Contains(encoded, []byte("schemaVersion")) {
		t.Fatal("summary leaked raw configuration")
	}
	if len(lifecycle.installRequest.Config.TelegramUserIDs) != 0 {
		t.Fatal("empty owner was not forwarded")
	}
}

func TestInspectDeploymentImportReturnsPreviewWithoutValues(t *testing.T) {
	lifecycle := &fakeDeploymentLifecycle{
		inspectPreview: deployment.ImportPreview{
			ReleaseVersion:   "1.0.0",
			Legacy:           true,
			RequiredInputs:   []string{"owner", "models"},
			Warnings:         []string{"MCP 服务器将从未配置开始"},
			PlaintextSecrets: []deployment.SecretMigration{{Path: "/mcpServers/0/headers/Authorization", SecretName: "MCP_NOTION_AUTHORIZATION", Reference: "env:MCP_NOTION_AUTHORIZATION"}},
		},
		inspectErr: domain.Error{Code: deployment.CodePlaintextSecretDetected, Message: "needs values"},
	}
	service := NewDeploymentsService(lifecycle, nil, release.Package{})
	summary, err := service.InspectDeploymentImport(context.Background(), strings.Repeat("a", 32), "deskwand-bot")
	if err == nil {
		t.Fatal("expected the actionable plaintext error")
	}
	if len(summary.PlaintextSecrets) != 1 || summary.PlaintextSecrets[0].SecretName != "MCP_NOTION_AUTHORIZATION" {
		t.Fatalf("summary = %#v", summary)
	}
	encoded, _ := json.Marshal(summary)
	if bytes.Contains(encoded, []byte(appDeploymentSecretSentinel)) {
		t.Fatal("preview leaked a value")
	}
}

func TestConfirmDeploymentImportDoesNotReturnSecretValues(t *testing.T) {
	lifecycle := &fakeDeploymentLifecycle{
		confirmResult: domain.Result{OperationID: "op-2", State: "published"},
	}
	journal := &fakeOperationReader{records: map[string]deployment.OperationRecord{
		"op-2": {OperationID: "op-2", State: "published", Target: domain.Target{ScriptName: "deskwand-bot"}},
	}}
	service := NewDeploymentsService(lifecycle, journal, release.Package{})
	owner := []int64{7}
	summary, err := service.ConfirmDeploymentImport(context.Background(), ConfirmImportInput{
		AccountID:       strings.Repeat("a", 32),
		WorkerName:      "deskwand-bot",
		TelegramUserIDs: &owner,
		SecretValues:    map[string]string{"MCP_NOTION_AUTHORIZATION": appDeploymentSecretSentinel},
	})
	if err != nil {
		t.Fatal(err)
	}
	if lifecycle.confirmChange.SecretValues["MCP_NOTION_AUTHORIZATION"] != appDeploymentSecretSentinel {
		t.Fatal("secret value was not forwarded")
	}
	encoded, _ := json.Marshal(summary)
	if bytes.Contains(encoded, []byte(appDeploymentSecretSentinel)) {
		t.Fatal("summary leaked the secret value")
	}
}

func TestUpgradeDeploymentUsesConfiguredPackage(t *testing.T) {
	lifecycle := &fakeDeploymentLifecycle{upgradeResult: domain.Result{OperationID: "op-3", State: "published"}}
	service := NewDeploymentsService(lifecycle, &fakeOperationReader{records: map[string]deployment.OperationRecord{}}, release.Package{})
	summary, err := service.UpgradeDeployment(context.Background(), UpgradeDeploymentInput{AccountID: strings.Repeat("a", 32), WorkerName: "deskwand-bot"})
	if err != nil {
		t.Fatal(err)
	}
	if summary.OperationID != "op-3" {
		t.Fatalf("summary = %#v", summary)
	}
	if len(lifecycle.upgradePackage.ManifestJSON()) != 0 {
		t.Fatal("upgrade did not use the service package")
	}
}

func TestConfirmImportInputRedactsSecretValues(t *testing.T) {
	owner := []int64{7}
	input := ConfirmImportInput{
		AccountID:       strings.Repeat("a", 32),
		WorkerName:      "deskwand-bot",
		TelegramUserIDs: &owner,
		SecretValues:    map[string]string{"MCP_NOTION_AUTHORIZATION": appDeploymentSecretSentinel},
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	logger.Info("confirm", "input", input)
	for label, output := range map[string]string{
		"json": string(encoded),
		"%v":   fmt.Sprintf("%v", input),
		"%+v":  fmt.Sprintf("%+v", input),
		"%#v":  fmt.Sprintf("%#v", input),
		"log":  logs.String(),
	} {
		if strings.Contains(output, appDeploymentSecretSentinel) {
			t.Fatalf("%s leaked the secret value: %s", label, output)
		}
	}
	if !strings.Contains(fmt.Sprintf("%v", input), "MCP_NOTION_AUTHORIZATION") {
		t.Fatal("safe representation should retain secret names")
	}
}

func TestAbandonDeploymentReturnsSafeSummary(t *testing.T) {
	lifecycle := &fakeDeploymentLifecycle{abandonResult: domain.Result{OperationID: "op-4", State: "cancelled"}}
	journal := &fakeOperationReader{records: map[string]deployment.OperationRecord{
		"op-4": {OperationID: "op-4", Kind: deployment.KindInstall, State: "cancelled", Target: domain.Target{ScriptName: "deskwand-bot"}},
	}}
	service := NewDeploymentsService(lifecycle, journal, release.Package{})
	summary, err := service.AbandonDeployment(context.Background(), "op-4")
	if err != nil {
		t.Fatal(err)
	}
	if summary.OperationID != "op-4" || summary.State != "cancelled" {
		t.Fatalf("summary = %#v", summary)
	}
}
