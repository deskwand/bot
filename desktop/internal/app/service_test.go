package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
	"github.com/deskwand/bot/desktop/internal/wechat"
)

const (
	serviceAccountID   = "0123456789abcdef0123456789abcdef"
	serviceToken       = "cfut_SERVICE_TOKEN_sentinel_0123456789"
	serviceSecret      = "SERVICE-SECRET-sentinel-value"
	serviceModelKey    = "sk-ant-api03-SERVICE-model-key"
	serviceConfigValue = "CONFIG-SENTINEL-not-exposed"
	serviceWorkerName  = "deskwand-bot"
)

type fakeAuth struct {
	mu sync.Mutex

	account         auth.Account
	connection      auth.Connection
	connectErr      error
	statusErr       error
	disconnectErr   error
	connectedTo     string
	connectCalls    int
	disconnectCalls int
}

func (f *fakeAuth) Connect(_ context.Context, accountID, token string) (auth.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.connectCalls++
	f.connectedTo = accountID
	if f.connectErr != nil {
		return auth.Account{}, f.connectErr
	}
	account := f.account
	if account.ID == "" {
		account = auth.Account{ID: accountID, Name: "Test Account"}
	}
	return account, nil
}

func (f *fakeAuth) Status(context.Context) (auth.Connection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	connection := f.connection
	if connection.State == "" {
		connection = auth.Connection{State: auth.StateConnected, AccountID: serviceAccountID}
	}
	return connection, f.statusErr
}

func (f *fakeAuth) Disconnect(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.disconnectCalls++
	return f.disconnectErr
}

type fakePublish struct {
	mu sync.Mutex

	previewSteps  []domain.Step
	previewErr    error
	applyResult   domain.Result
	applyErr      error
	resumeResult  domain.Result
	resumeErr     error
	resumeID      string
	abandonResult domain.Result
	abandonErr    error
	abandonID     string
	changes       []domain.Change
	targets       []domain.Target
}

func (f *fakePublish) Preview(_ context.Context, target domain.Target, change domain.Change) ([]domain.Step, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.targets = append(f.targets, target)
	f.changes = append(f.changes, change)
	return f.previewSteps, f.previewErr
}

func (f *fakePublish) Apply(_ context.Context, target domain.Target, change domain.Change) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.targets = append(f.targets, target)
	f.changes = append(f.changes, change)
	result := f.applyResult
	if result.OperationID == "" && f.applyErr == nil {
		result = domain.Result{OperationID: "op-publish", State: deployment.StatePublished}
	}
	return result, f.applyErr
}

func (f *fakePublish) Resume(_ context.Context, operationID string) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resumeID = operationID
	result := f.resumeResult
	if result.OperationID == "" && f.resumeErr == nil {
		result = domain.Result{OperationID: operationID, State: deployment.StatePublished}
	}
	return result, f.resumeErr
}

func (f *fakePublish) Abandon(_ context.Context, operationID string) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.abandonID = operationID
	result := f.abandonResult
	if result.OperationID == "" && f.abandonErr == nil {
		result = domain.Result{OperationID: operationID, State: deployment.StateCancelled}
	}
	return result, f.abandonErr
}

func (f *fakePublish) lastChange() domain.Change {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.changes) == 0 {
		return domain.Change{}
	}
	return f.changes[len(f.changes)-1]
}

type fakeLifecycle struct {
	mu sync.Mutex

	installRequest deployment.InstallRequest
	installResult  domain.Result
	installErr     error
	inspectPreview deployment.ImportPreview
	inspectErr     error
	confirmResult  domain.Result
	confirmErr     error
	confirmInput   deployment.ImportConfirmation
	upgradeTarget  domain.Target
	upgradeResult  domain.Result
	upgradeErr     error
	upgradeCalled  bool
	abandonResult  domain.Result
	abandonErr     error
	abandonID      string
	abandonCalls   int
}

func (f *fakeLifecycle) Install(_ context.Context, request deployment.InstallRequest) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.installRequest = request
	result := f.installResult
	if result.OperationID == "" && f.installErr == nil {
		result = domain.Result{OperationID: "op-install", State: deployment.StatePublished}
	}
	return result, f.installErr
}

func (f *fakeLifecycle) InspectImport(context.Context, domain.Target) (deployment.ImportPreview, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.inspectPreview, f.inspectErr
}

func (f *fakeLifecycle) ConfirmImport(_ context.Context, _ domain.Target, input deployment.ImportConfirmation) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.confirmInput = input
	result := f.confirmResult
	if result.OperationID == "" && f.confirmErr == nil {
		result = domain.Result{OperationID: "op-import", State: deployment.StatePublished}
	}
	return result, f.confirmErr
}

func (f *fakeLifecycle) Abandon(_ context.Context, operationID string) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.abandonCalls++
	f.abandonID = operationID
	result := f.abandonResult
	if result.OperationID == "" && f.abandonErr == nil {
		result = domain.Result{OperationID: operationID, State: deployment.StateCancelled}
	}
	return result, f.abandonErr
}

func (f *fakeLifecycle) Upgrade(_ context.Context, target domain.Target, _ release.Package) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upgradeCalled = true
	f.upgradeTarget = target
	result := f.upgradeResult
	if result.OperationID == "" && f.upgradeErr == nil {
		result = domain.Result{OperationID: "op-upgrade", State: deployment.StatePublished}
	}
	return result, f.upgradeErr
}

type fakeEntries struct {
	mu sync.Mutex

	loginFunc      func(ctx context.Context, onStatus func(wechat.LoginStatus)) (domain.Result, error)
	loginCalls     int
	telegramToken  string
	telegramOpts   TelegramConnectOptions
	telegramErr    error
	telegramResult domain.Result
	selectResult   EntrySelection
	selectErr      error
	selectChannel  string
}

func (f *fakeEntries) ConnectWeChatWithStatus(ctx context.Context, _ domain.Target, onStatus func(wechat.LoginStatus)) (domain.Result, error) {
	f.mu.Lock()
	f.loginCalls++
	login := f.loginFunc
	f.mu.Unlock()
	if login == nil {
		return domain.Result{State: StatePublished}, nil
	}
	return login(ctx, onStatus)
}

func (f *fakeEntries) ConnectTelegramWithOptions(_ context.Context, _ domain.Target, token string, options TelegramConnectOptions) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.telegramToken = token
	f.telegramOpts = options
	result := f.telegramResult
	if result.OperationID == "" && f.telegramErr == nil {
		result = domain.Result{OperationID: "op-telegram", State: StatePublished}
	}
	return result, f.telegramErr
}

func (f *fakeEntries) SelectEntry(_ context.Context, _ domain.Target, channel string) (EntrySelection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.selectChannel = channel
	return f.selectResult, f.selectErr
}

type fakeStatus struct {
	report    DiagnosticsReport
	reportErr error
	export    []byte
	exportErr error
}

func (f *fakeStatus) Status(context.Context, domain.Target) (DiagnosticsReport, error) {
	return f.report, f.reportErr
}

func (f *fakeStatus) ExportDiagnostics(context.Context, domain.Target) ([]byte, error) {
	return f.export, f.exportErr
}

type fakeSnapshots struct {
	snapshot domain.Snapshot
	err      error
}

func (f *fakeSnapshots) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	return f.snapshot, f.err
}

type fakeScripts struct {
	scripts []cloudflare.ScriptSummary
	err     error
}

func (f *fakeScripts) ListScripts(context.Context, string) ([]cloudflare.ScriptSummary, error) {
	return f.scripts, f.err
}

type fakeJournal struct {
	records map[string]deployment.OperationRecord
	err     error
}

func (f *fakeJournal) Load(operationID string) (deployment.OperationRecord, error) {
	if f.err != nil {
		return deployment.OperationRecord{}, f.err
	}
	record, ok := f.records[operationID]
	if !ok {
		return deployment.OperationRecord{}, errors.New("operation not found")
	}
	return record, nil
}

func (f *fakeJournal) Save(record deployment.OperationRecord) error {
	if f.err != nil {
		return f.err
	}
	if f.records == nil {
		f.records = map[string]deployment.OperationRecord{}
	}
	f.records[record.OperationID] = record
	return nil
}

func (f *fakeJournal) List() ([]deployment.OperationRecord, error) {
	if f.err != nil {
		return nil, f.err
	}
	records := make([]deployment.OperationRecord, 0, len(f.records))
	for _, record := range f.records {
		records = append(records, record)
	}
	return records, nil
}

type fakeBrowser struct {
	opened []string
	err    error
}

func (f *fakeBrowser) Open(rawURL string) error {
	f.opened = append(f.opened, rawURL)
	return f.err
}

type fakeRelease struct {
	pkg      release.Package
	version  string
	manifest release.Manifest
	err      error
}

func (f fakeRelease) Package() (release.Package, error) { return f.pkg, f.err }
func (f fakeRelease) Version() string                   { return f.version }
func (f fakeRelease) Manifest() release.Manifest        { return f.manifest }

type fakeStore struct {
	target domain.Target
	ok     bool
	err    error
	saved  []domain.Target
}

func (f *fakeStore) Load() (domain.Target, bool, error) {
	return f.target, f.ok, f.err
}

func (f *fakeStore) Save(target domain.Target) error {
	if f.err != nil {
		return f.err
	}
	f.target = target
	f.ok = true
	f.saved = append(f.saved, target)
	return nil
}

type serviceFixture struct {
	auth        *fakeAuth
	publish     *fakePublish
	lifecycle   *fakeLifecycle
	entries     *fakeEntries
	diagnostics *fakeStatus
	snapshots   *fakeSnapshots
	scripts     *fakeScripts
	journal     *fakeJournal
	store       *fakeStore
	browser     *fakeBrowser
	release     *fakeRelease
	service     *Service
	emitted     chan LoginStatusDTO
}

func newServiceFixture(t *testing.T) *serviceFixture {
	t.Helper()
	f := &serviceFixture{
		auth:        &fakeAuth{},
		publish:     &fakePublish{},
		lifecycle:   &fakeLifecycle{},
		entries:     &fakeEntries{},
		diagnostics: &fakeStatus{},
		snapshots:   &fakeSnapshots{snapshot: serviceSnapshot()},
		scripts: &fakeScripts{scripts: []cloudflare.ScriptSummary{
			{ID: "zeta", ModifiedOn: "2026-11-02T00:00:00Z", MigrationTag: "v2"},
			{ID: serviceWorkerName, ModifiedOn: "2026-11-01T00:00:00Z", MigrationTag: "v2"},
		}},
		journal: &fakeJournal{records: map[string]deployment.OperationRecord{}},
		store: &fakeStore{
			target: domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
			ok:     true,
		},
		browser: &fakeBrowser{},
		release: &fakeRelease{
			version: "2.0.0",
			manifest: release.Manifest{ResourceTemplate: release.ResourceTemplate{
				SecretNames: []string{
					"ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "TELEGRAM_BOT_TOKEN",
					"TELEGRAM_WEBHOOK_SECRET", "WECHAT_CREDENTIALS",
				},
			}},
		},
		emitted: make(chan LoginStatusDTO, 8),
	}
	f.service = NewService(ServiceOptions{
		Auth:        f.auth,
		Publish:     f.publish,
		Lifecycle:   f.lifecycle,
		Entries:     f.entries,
		Diagnostics: f.diagnostics,
		Snapshots:   f.snapshots,
		Scripts:     f.scripts,
		Journal:     f.journal,
		Store:       f.store,
		Browser:     f.browser,
		Release:     f.release,
		EmitLoginStatus: func(status LoginStatusDTO) {
			f.emitted <- status
		},
		NewOperationID: func() (string, error) { return "login-op", nil },
		Now:            func() time.Time { return time.Unix(1700000000, 0).UTC() },
	})
	return f
}

func serviceSnapshot() domain.Snapshot {
	settings := map[string]any{
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "ACTIVE_CHANNEL", "text": "wechat"},
			map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": "https://bot.example"},
			map[string]any{"type": "secret_text", "name": "ANTHROPIC_API_KEY"},
		},
	}
	settingsJSON, _ := json.Marshal(settings)
	return domain.Snapshot{
		Target:             domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
		DeploymentID:       "deployment-1",
		VersionID:          "version-1",
		LatestVersionID:    "version-1",
		ActiveVersionCount: 1,
		ReleaseVersion:     "1.0.0",
		Fingerprint:        "fingerprint-1",
		ConfigJSON: []byte(`{
			"schemaVersion": 1,
			"owner": {"telegramUserIds": [42, 43]},
			"models": {
				"butler": {"provider": "anthropic", "id": "claude-sonnet-5-5", "baseURL": "` + serviceConfigValue + `"},
				"task": {"provider": "opencode-go", "id": "kimi-k3"}
			},
			"mcpServers": [],
			"_note": "` + serviceConfigValue + `"
		}`),
		SettingsJSON: settingsJSON,
		SecretNames:  []string{"ANTHROPIC_API_KEY"},
	}
}

func assertNoSentinel(t *testing.T, sentinel string, values ...any) {
	t.Helper()
	for _, value := range values {
		var text string
		switch typed := value.(type) {
		case error:
			if typed != nil {
				text = typed.Error()
			}
		case string:
			text = typed
		default:
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatalf("marshal %T: %v", value, err)
			}
			text = string(encoded)
		}
		if strings.Contains(text, sentinel) {
			t.Fatalf("output leaked sentinel %q: %s", sentinel, text)
		}
	}
}

func TestServiceName(t *testing.T) {
	if got := newServiceFixture(t).service.Name(); got != "DeskWand Bot" {
		t.Fatalf("name = %q", got)
	}
}

func TestServiceReleaseGatePrecedesNetworkAndJournal(t *testing.T) {
	for _, releaseErr := range []error{release.ErrNotBundled, release.ErrUntrusted} {
		f := newServiceFixture(t)
		expectedCode := CodeReleaseNotBundled
		if errors.Is(releaseErr, release.ErrUntrusted) {
			expectedCode = CodeReleaseUntrusted
		}
		f.service = NewService(ServiceOptions{
			Auth: f.auth, Publish: f.publish, Lifecycle: f.lifecycle,
			Entries: f.entries, Diagnostics: f.diagnostics, Snapshots: f.snapshots,
			Scripts: f.scripts, Journal: f.journal, Store: f.store, Browser: f.browser,
			Release:         EmbeddedRelease{Err: releaseErr},
			EmitLoginStatus: func(LoginStatusDTO) {},
			NewOperationID:  func() (string, error) { return "login-op", nil },
		})

		owner := []int64{1}
		calls := map[string]func() error{
			"PublishConfig": func() error {
				_, err := f.service.PublishConfig(ConfigEditDTO{BaseFingerprint: "fingerprint-1"})
				return err
			},
			"ConfirmImport": func() error {
				_, err := f.service.ConfirmImport(ImportInputDTO{BaseFingerprint: "fingerprint-1", TelegramUserIDs: &owner})
				return err
			},
			"ConnectTelegram": func() error {
				_, err := f.service.ConnectTelegram(serviceToken, false)
				return err
			},
			"StartWeChatLogin": func() error {
				_, err := f.service.StartWeChatLogin()
				return err
			},
			"SelectEntry": func() error {
				_, err := f.service.SelectEntry("wechat")
				return err
			},
			"ResumeOperation": func() error {
				_, err := f.service.ResumeOperation("op-1")
				return err
			},
			"Install": func() error {
				_, err := f.service.Install(InstallInputDTO{})
				return err
			},
			"Upgrade": func() error {
				_, err := f.service.Upgrade()
				return err
			},
		}
		for name, call := range calls {
			if err := call(); !hasCode(err, expectedCode) {
				t.Fatalf("%s error = %v, want %s", name, err, expectedCode)
			}
		}
		if len(f.publish.changes) != 0 || f.publish.resumeID != "" {
			t.Fatalf("release gate reached publish: %#v / %q", f.publish.changes, f.publish.resumeID)
		}
		if f.entries.loginCalls != 0 || f.entries.telegramToken != "" || f.entries.selectChannel != "" {
			t.Fatalf("release gate reached entries: %#v", f.entries)
		}
		if f.lifecycle.confirmInput.BaseFingerprint != "" {
			t.Fatalf("release gate reached import: %#v", f.lifecycle.confirmInput)
		}
		if len(f.journal.records) != 0 {
			t.Fatalf("release gate wrote journal records: %#v", f.journal.records)
		}
	}
}

func TestServiceAuthLifecycle(t *testing.T) {
	f := newServiceFixture(t)
	f.auth.account = auth.Account{ID: serviceAccountID, Name: "Acme"}
	f.auth.connection = auth.Connection{State: auth.StateConnected, AccountID: serviceAccountID}

	account, err := f.service.ConnectCloudflare(strings.ToUpper(serviceAccountID), serviceToken)
	if err != nil {
		t.Fatal(err)
	}
	if account.ID != serviceAccountID || account.Name != "Acme" {
		t.Fatalf("account = %#v", account)
	}
	if f.auth.connectedTo != strings.ToUpper(serviceAccountID) {
		t.Fatalf("account passed to auth = %q", f.auth.connectedTo)
	}
	status := f.service.CloudflareStatus()
	if status.State != auth.StateConnected || status.AccountID != serviceAccountID {
		t.Fatalf("status = %#v", status)
	}
	if err := f.service.DisconnectCloudflare(); err != nil {
		t.Fatal(err)
	}
	if f.auth.disconnectCalls != 1 {
		t.Fatalf("disconnect calls = %d", f.auth.disconnectCalls)
	}
	assertNoSentinel(t, serviceToken, account, status, err)

	f.auth.connectErr = fmt.Errorf("Cloudflare rejected token %s", serviceToken)
	_, err = f.service.ConnectCloudflare(serviceAccountID, serviceToken)
	if err == nil {
		t.Fatal("expected connect error")
	}
	assertNoSentinel(t, serviceToken, err)
}

func TestServiceCloudflareStatusUnavailable(t *testing.T) {
	f := newServiceFixture(t)
	f.auth.connection = auth.Connection{State: auth.StateUnavailable}
	f.auth.statusErr = errors.New("denied")
	if got := f.service.CloudflareStatus(); got.State != auth.StateUnavailable {
		t.Fatalf("status = %#v", got)
	}
}

func TestServiceOpenTokenPage(t *testing.T) {
	f := newServiceFixture(t)
	if err := f.service.OpenTokenPage(); err != nil {
		t.Fatal(err)
	}
	if len(f.browser.opened) != 1 || f.browser.opened[0] != "https://dash.cloudflare.com/profile/api-tokens" {
		t.Fatalf("opened = %#v", f.browser.opened)
	}
}

func TestServiceListWorkersSortsAndRequiresConnection(t *testing.T) {
	f := newServiceFixture(t)
	workers, err := f.service.ListWorkers()
	if err != nil {
		t.Fatal(err)
	}
	if len(workers) != 2 || workers[0].Name != serviceWorkerName || workers[1].Name != "zeta" {
		t.Fatalf("workers = %#v", workers)
	}

	f.auth.connection = auth.Connection{State: auth.StateDisconnected}
	if _, err := f.service.ListWorkers(); !hasCode(err, CodeAuthRequired) {
		t.Fatalf("error = %v, want %s", err, CodeAuthRequired)
	}
}

func TestServiceSelectDeploymentPersistsAndValidates(t *testing.T) {
	f := newServiceFixture(t)
	if err := f.service.SelectDeployment(" my-worker "); err != nil {
		t.Fatal(err)
	}
	if len(f.store.saved) != 1 || f.store.saved[0] != (domain.Target{AccountID: serviceAccountID, ScriptName: "my-worker"}) {
		t.Fatalf("saved = %#v", f.store.saved)
	}
	if err := f.service.SelectDeployment("Bad Name"); !hasCode(err, deployment.CodeInvalidRequest) {
		t.Fatalf("error = %v, want invalid request", err)
	}
	if len(f.store.saved) != 1 {
		t.Fatal("invalid name was persisted")
	}

	f.store.target = domain.Target{AccountID: strings.Repeat("b", 32), ScriptName: "other"}
	if _, err := f.service.GetConfig(); !hasCode(err, CodeAccountMismatch) {
		t.Fatalf("error = %v, want account mismatch", err)
	}
}

func TestServiceGetConfigSummarizesAndOmitsRawConfig(t *testing.T) {
	f := newServiceFixture(t)
	config, err := f.service.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.AccountID != serviceAccountID || config.WorkerName != serviceWorkerName ||
		config.Fingerprint != "fingerprint-1" || !config.ConfigPresent {
		t.Fatalf("config = %#v", config)
	}
	if config.ActiveChannel != "wechat" || len(config.OwnerUserIDs) != 2 || config.OwnerUserIDs[1] != 43 {
		t.Fatalf("config = %#v", config)
	}
	if config.ButlerModel == nil || config.ButlerModel.Provider != "anthropic" || config.ButlerModel.ID != "claude-sonnet-5-5" {
		t.Fatalf("butler = %#v", config.ButlerModel)
	}
	if config.TaskModel == nil || config.TaskModel.Provider != "opencode-go" {
		t.Fatalf("task = %#v", config.TaskModel)
	}
	if len(config.Secrets) != 5 {
		t.Fatalf("secrets = %#v", config.Secrets)
	}
	for _, secret := range config.Secrets {
		if secret.Name == "ANTHROPIC_API_KEY" && !secret.Configured {
			t.Fatal("existing secret reported unconfigured")
		}
		if secret.Name != "ANTHROPIC_API_KEY" && secret.Configured {
			t.Fatalf("secret %q reported configured", secret.Name)
		}
	}
	assertNoSentinel(t, serviceConfigValue, config)
}

func TestServicePreviewAndPublishConfigRedactSecrets(t *testing.T) {
	f := newServiceFixture(t)
	f.publish.previewSteps = []domain.Step{{ID: "stage", State: "planned", Message: "upload"}}
	owner := []int64{7}
	input := ConfigEditDTO{
		BaseFingerprint: "fingerprint-1",
		OwnerUserIDs:    &owner,
		ButlerModel:     &ModelDTO{Provider: "anthropic", ID: "claude-sonnet-5-5"},
		Secrets: []SecretEditDTO{{
			Name: "ANTHROPIC_API_KEY", Operation: domain.SecretReplace, Value: serviceSecret,
		}},
	}

	steps, err := f.service.PreviewConfig(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[0].ID != "release" || steps[1].ID != "stage" {
		t.Fatalf("steps = %#v", steps)
	}
	if !strings.Contains(steps[0].Message, "1.0.0") || !strings.Contains(steps[0].Message, "2.0.0") {
		t.Fatalf("release step = %#v", steps[0])
	}
	previewChange := f.publish.lastChange()
	if len(previewChange.Secrets) != 1 || previewChange.Secrets[0].Value() != serviceSecret {
		t.Fatal("secret value was not forwarded to the publish layer")
	}
	if previewChange.Patch.TelegramUserIDs == nil || (*previewChange.Patch.TelegramUserIDs)[0] != 7 {
		t.Fatalf("patch = %#v", previewChange.Patch)
	}
	assertNoSentinel(t, serviceSecret, steps, err)

	result, err := f.service.PublishConfig(input)
	if err != nil {
		t.Fatal(err)
	}
	if result.OperationID != "op-publish" || result.State != deployment.StatePublished {
		t.Fatalf("result = %#v", result)
	}
	assertNoSentinel(t, serviceSecret, result, err)

	f.publish.applyErr = fmt.Errorf("upload failed with %s", serviceSecret)
	_, err = f.service.PublishConfig(input)
	if err == nil {
		t.Fatal("expected publish error")
	}
	assertNoSentinel(t, serviceSecret, err)
}

func TestServicePublishConfigFillsMissingFingerprint(t *testing.T) {
	f := newServiceFixture(t)
	if _, err := f.service.PublishConfig(ConfigEditDTO{}); err != nil {
		t.Fatal(err)
	}
	if got := f.publish.lastChange().BaseFingerprint; got != "fingerprint-1" {
		t.Fatalf("base fingerprint = %q", got)
	}
}

func TestServiceResumeAndPendingOperations(t *testing.T) {
	f := newServiceFixture(t)
	now := time.Unix(1700000000, 0).UTC()
	f.journal.records["op-open"] = deployment.OperationRecord{
		OperationID:    "op-open",
		Kind:           deployment.KindInstall,
		Target:         domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
		State:          deployment.StateUnknown,
		BucketName:     "deskwand-bucket",
		ActiveChannel:  "wechat",
		ReleaseVersion: "2.0.0",
		ConfigJSON: []byte(`{
			"schemaVersion": 1,
			"owner": {"telegramUserIds": [7, 8]},
			"models": {
				"butler": {"provider": "anthropic", "id": "claude-sonnet-5-5"},
				"task": {"provider": "opencode-go", "id": "kimi-k3"}
			},
			"mcpServers": []
		}`),
		Steps:     []domain.Step{{ID: "upload", State: deployment.StateUnknown, Message: "unknown"}},
		CreatedAt: now,
		UpdatedAt: now.Add(time.Minute),
	}
	f.journal.records["op-done"] = deployment.OperationRecord{
		OperationID: "op-done",
		Target:      domain.Target{AccountID: serviceAccountID, ScriptName: "worker-done"},
		State:       deployment.StatePublished,
		CreatedAt:   now,
		UpdatedAt:   now.Add(2 * time.Minute),
	}
	f.journal.records["op-cancelled"] = deployment.OperationRecord{
		OperationID: "op-cancelled",
		Target:      domain.Target{AccountID: serviceAccountID, ScriptName: "worker-cancelled"},
		State:       deployment.StateCancelled,
		CreatedAt:   now,
		UpdatedAt:   now.Add(3 * time.Minute),
	}
	f.lifecycle.installResult = domain.Result{
		OperationID: "op-open", State: deployment.StatePublished,
		DeploymentID: "deployment-2", VersionID: "version-2",
	}

	operations, err := f.service.PendingOperations()
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 1 || operations[0].OperationID != "op-open" {
		t.Fatalf("operations = %#v", operations)
	}
	if operations[0].Steps[0].State != deployment.StateUnknown || operations[0].UpdatedAt == "" {
		t.Fatalf("operation = %#v", operations[0])
	}

	result, err := f.service.ResumeOperation(" op-open ")
	if err != nil {
		t.Fatal(err)
	}
	if f.publish.resumeID != "" {
		t.Fatalf("install resume entered publish.Resume with %q", f.publish.resumeID)
	}
	if f.lifecycle.installRequest.WorkerName != serviceWorkerName ||
		f.lifecycle.installRequest.BucketName != "deskwand-bucket" ||
		f.lifecycle.installRequest.ActiveChannel != "wechat" {
		t.Fatalf("install request = %#v", f.lifecycle.installRequest)
	}
	if len(f.lifecycle.installRequest.Config.TelegramUserIDs) != 2 ||
		f.lifecycle.installRequest.Config.TelegramUserIDs[1] != 8 {
		t.Fatalf("owner = %#v", f.lifecycle.installRequest.Config.TelegramUserIDs)
	}
	if result.OperationID != "op-open" || result.State != deployment.StatePublished {
		t.Fatalf("result = %#v", result)
	}
}

func TestServiceResumeUpgradeRecognizesLiveReleaseWithoutReupload(t *testing.T) {
	f := newServiceFixture(t)
	f.snapshots.snapshot.ReleaseVersion = "2.0.0"
	f.journal.records["op-upgrade"] = deployment.OperationRecord{
		OperationID:           "op-upgrade",
		Kind:                  deployment.KindUpgrade,
		Target:                domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
		State:                 deployment.StateUnknown,
		ReleaseVersion:        "2.0.0",
		ScriptUploadAttempted: true,
		Steps:                 []domain.Step{{ID: "script", State: deployment.StateUnknown, Message: "unknown"}},
	}

	result, err := f.service.ResumeOperation("op-upgrade")
	if err != nil {
		t.Fatal(err)
	}
	if f.lifecycle.upgradeCalled {
		t.Fatal("a live upgrade release was re-uploaded")
	}
	if result.State != deployment.StatePublished || result.OperationID != "op-upgrade" {
		t.Fatalf("result = %#v", result)
	}
	if f.journal.records["op-upgrade"].State != deployment.StatePublished {
		t.Fatalf("journal = %#v", f.journal.records["op-upgrade"])
	}
}

func TestServiceResumeUpgradeRetriesWhenUploadWasNotAttempted(t *testing.T) {
	f := newServiceFixture(t)
	f.snapshots.snapshot.ReleaseVersion = "1.0.0"
	f.journal.records["op-upgrade"] = deployment.OperationRecord{
		OperationID:    "op-upgrade",
		Kind:           deployment.KindUpgrade,
		Target:         domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
		State:          deployment.StateUnknown,
		ReleaseVersion: "2.0.0",
		Steps:          []domain.Step{{ID: "script", State: deployment.StateUnknown, Message: "unknown"}},
	}
	f.lifecycle.upgradeResult = domain.Result{
		OperationID: "op-upgrade", State: deployment.StatePublished,
		DeploymentID: "deployment-2", VersionID: "version-2",
	}

	result, err := f.service.ResumeOperation("op-upgrade")
	if err != nil {
		t.Fatal(err)
	}
	if !f.lifecycle.upgradeCalled {
		t.Fatal("resume did not retry an upgrade that never uploaded")
	}
	if result.State != deployment.StatePublished || f.journal.records["op-upgrade"].State != deployment.StatePublished {
		t.Fatalf("result = %#v journal = %#v", result, f.journal.records["op-upgrade"])
	}
}

func TestServiceResumeUpgradeWithUnknownUploadNeedsInput(t *testing.T) {
	f := newServiceFixture(t)
	f.snapshots.snapshot.ReleaseVersion = "1.0.0"
	f.journal.records["op-upgrade"] = deployment.OperationRecord{
		OperationID:           "op-upgrade",
		Kind:                  deployment.KindUpgrade,
		Target:                domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
		State:                 deployment.StateUnknown,
		ReleaseVersion:        "2.0.0",
		ScriptUploadAttempted: true,
		Steps:                 []domain.Step{{ID: "script", State: deployment.StateUnknown, Message: "unknown"}},
	}

	result, err := f.service.ResumeOperation("op-upgrade")
	if err != nil {
		t.Fatal(err)
	}
	if f.lifecycle.upgradeCalled {
		t.Fatal("resume re-uploaded an upgrade with an unknown prior upload")
	}
	if result.State != deployment.StateNeedsInput || f.journal.records["op-upgrade"].State != deployment.StateNeedsInput {
		t.Fatalf("result = %#v journal = %#v", result, f.journal.records["op-upgrade"])
	}
	if len(result.Warnings) == 0 {
		t.Fatal("unknown upgrade result did not warn")
	}
}

func TestServiceAbandonOperationUsesTheOwningStateMachine(t *testing.T) {
	for _, kind := range []string{deployment.KindInstall, deployment.KindUpgrade} {
		t.Run(kind, func(t *testing.T) {
			f := newServiceFixture(t)
			f.journal.records["op-"+kind] = deployment.OperationRecord{
				OperationID: "op-" + kind,
				Kind:        kind,
				Target:      domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
				State:       deployment.StateUnknown,
			}
			result, err := f.service.AbandonOperation("op-" + kind)
			if err != nil {
				t.Fatal(err)
			}
			if f.lifecycle.abandonID != "op-"+kind || f.lifecycle.abandonCalls != 1 {
				t.Fatalf("lifecycle abandon = %q calls=%d", f.lifecycle.abandonID, f.lifecycle.abandonCalls)
			}
			if f.publish.abandonID != "" {
				t.Fatalf("wrong publish abandon path for %s", kind)
			}
			if result.State != deployment.StateCancelled {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func TestServiceAbandonOperationUsesPublishOnlyForPublishRecords(t *testing.T) {
	f := newServiceFixture(t)
	f.journal.records["op-publish"] = deployment.OperationRecord{
		OperationID: "op-publish",
		Target:      domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName},
		State:       deployment.StateUnknown,
	}
	result, err := f.service.AbandonOperation("op-publish")
	if err != nil {
		t.Fatal(err)
	}
	if f.publish.abandonID != "op-publish" {
		t.Fatalf("publish abandon = %q", f.publish.abandonID)
	}
	if f.lifecycle.abandonCalls != 0 {
		t.Fatal("publish abandon entered the lifecycle path")
	}
	if result.State != deployment.StateCancelled {
		t.Fatalf("result = %#v", result)
	}
}

func TestServiceResumeRejectsOperationFromAnotherTarget(t *testing.T) {
	f := newServiceFixture(t)
	f.journal.records["op-other"] = deployment.OperationRecord{
		OperationID: "op-other",
		Target:      domain.Target{AccountID: serviceAccountID, ScriptName: "other-worker"},
		State:       deployment.StateUnknown,
	}
	if _, err := f.service.ResumeOperation("op-other"); !hasCode(err, CodeTargetMismatch) {
		t.Fatalf("error = %v, want %s", err, CodeTargetMismatch)
	}
	if f.publish.resumeID != "" {
		t.Fatal("resume reached publish for another target")
	}
}

func TestServiceInstallPersistsTargetAndSummarizes(t *testing.T) {
	f := newServiceFixture(t)
	f.journal.records["op-install"] = deployment.OperationRecord{
		OperationID:    "op-install",
		Kind:           deployment.KindInstall,
		Target:         domain.Target{AccountID: serviceAccountID, ScriptName: "new-worker"},
		State:          deployment.StatePublished,
		PublicBaseURL:  "https://new-worker.example.workers.dev",
		ReleaseVersion: "2.0.0",
		ActiveChannel:  "telegram",
		Steps:          []domain.Step{{ID: "verify", State: deployment.StatePublished, Message: "done"}},
	}
	f.lifecycle.installResult = domain.Result{OperationID: "op-install", State: deployment.StatePublished}

	result, err := f.service.Install(InstallInputDTO{
		AccountID:       serviceAccountID,
		WorkerName:      "new-worker",
		BucketName:      "new-bucket",
		TelegramUserIDs: []int64{99},
		ButlerModel:     ModelDTO{Provider: "anthropic", ID: "claude-sonnet-5-5"},
		TaskModel:       ModelDTO{Provider: "opencode-go", ID: "kimi-k3"},
		ActiveChannel:   "TELEGRAM",
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.lifecycle.installRequest.ActiveChannel != "telegram" {
		t.Fatalf("active channel = %q", f.lifecycle.installRequest.ActiveChannel)
	}
	if result.PublicBaseURL != "https://new-worker.example.workers.dev" || len(result.Steps) != 1 {
		t.Fatalf("result = %#v", result)
	}
	if len(f.store.saved) != 1 || f.store.saved[0] != (domain.Target{AccountID: serviceAccountID, ScriptName: "new-worker"}) {
		t.Fatalf("saved = %#v", f.store.saved)
	}
}

func TestServiceInstallReportsReleaseState(t *testing.T) {
	f := newServiceFixture(t)
	f.release.err = release.ErrNotBundled
	if _, err := f.service.Install(InstallInputDTO{
		AccountID: serviceAccountID, WorkerName: "worker", BucketName: "bucket",
		ButlerModel:   ModelDTO{Provider: "anthropic", ID: "m"},
		TaskModel:     ModelDTO{Provider: "anthropic", ID: "m"},
		ActiveChannel: "telegram",
	}); !hasCode(err, CodeReleaseNotBundled) {
		t.Fatalf("error = %v, want %s", err, CodeReleaseNotBundled)
	}

	f.release.err = release.ErrUntrusted
	if _, err := f.service.Upgrade(); !hasCode(err, CodeReleaseUntrusted) {
		t.Fatalf("error = %v, want %s", err, CodeReleaseUntrusted)
	}
}

func TestServiceUpgradeAvailable(t *testing.T) {
	f := newServiceFixture(t)
	f.release.version = "2.0.0"
	f.snapshots.snapshot.ReleaseVersion = "1.0.0"

	upgrade, err := f.service.UpgradeAvailable()
	if err != nil {
		t.Fatal(err)
	}
	if !upgrade.Available || upgrade.CurrentVersion != "1.0.0" || upgrade.AvailableVersion != "2.0.0" {
		t.Fatalf("upgrade = %#v", upgrade)
	}

	f.snapshots.snapshot.ReleaseVersion = "2.0.0"
	upgrade, err = f.service.UpgradeAvailable()
	if err != nil {
		t.Fatal(err)
	}
	if upgrade.Available || upgrade.Reason != "UP_TO_DATE" {
		t.Fatalf("upgrade = %#v", upgrade)
	}

	f.snapshots.snapshot.ReleaseVersion = "3.0.0"
	upgrade, err = f.service.UpgradeAvailable()
	if err != nil {
		t.Fatal(err)
	}
	if upgrade.Available || upgrade.Reason != deployment.CodeDowngradeRejected {
		t.Fatalf("upgrade = %#v", upgrade)
	}

	f.snapshots.snapshot.ReleaseVersion = ""
	upgrade, err = f.service.UpgradeAvailable()
	if err != nil {
		t.Fatal(err)
	}
	if upgrade.Available || upgrade.Reason != deployment.CodeVersionUnknownReimport {
		t.Fatalf("upgrade = %#v", upgrade)
	}

	f.release.err = release.ErrNotBundled
	upgrade, err = f.service.UpgradeAvailable()
	if err != nil {
		t.Fatal(err)
	}
	if upgrade.Available || upgrade.Reason != CodeReleaseNotBundled {
		t.Fatalf("upgrade = %#v", upgrade)
	}
}

func TestServiceUpgradeDelegates(t *testing.T) {
	f := newServiceFixture(t)
	result, err := f.service.Upgrade()
	if err != nil {
		t.Fatal(err)
	}
	if !f.lifecycle.upgradeCalled || f.lifecycle.upgradeTarget.ScriptName != serviceWorkerName {
		t.Fatalf("upgrade target = %#v called=%v", f.lifecycle.upgradeTarget, f.lifecycle.upgradeCalled)
	}
	if result.OperationID != "op-upgrade" {
		t.Fatalf("result = %#v", result)
	}
}

func TestServiceStartAndCancelWeChatLogin(t *testing.T) {
	f := newServiceFixture(t)
	started := make(chan struct{})
	f.entries.loginFunc = func(ctx context.Context, onStatus func(wechat.LoginStatus)) (domain.Result, error) {
		onStatus(wechat.LoginStatus{State: wechat.LoginWaiting, QRContent: "qr-content", Message: "scan"})
		close(started)
		<-ctx.Done()
		return domain.Result{}, ctx.Err()
	}

	operationID, err := f.service.StartWeChatLogin()
	if err != nil {
		t.Fatal(err)
	}
	if operationID != "login-op" {
		t.Fatalf("operation id = %q", operationID)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("login did not start")
	}
	status := <-f.emitted
	if status.OperationID != "login-op" || status.State != wechat.LoginWaiting || status.QRContent != "qr-content" {
		t.Fatalf("status = %#v", status)
	}
	assertNoSentinel(t, serviceToken, status)

	if err := f.service.CancelWeChatLogin("login-op"); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case status = <-f.emitted:
			if status.State == wechat.LoginCancelled {
				goto cancelled
			}
		case <-deadline:
			t.Fatal("cancelled status was not emitted")
		}
	}

cancelled:
	if err := f.service.CancelWeChatLogin("missing"); !hasCode(err, CodeLoginNotFound) {
		t.Fatalf("error = %v, want %s", err, CodeLoginNotFound)
	}
}

func TestServiceStartWeChatLoginRejectsConcurrentLogin(t *testing.T) {
	f := newServiceFixture(t)
	started := make(chan struct{})
	f.entries.loginFunc = func(ctx context.Context, _ func(wechat.LoginStatus)) (domain.Result, error) {
		close(started)
		<-ctx.Done()
		return domain.Result{}, ctx.Err()
	}
	op, err := f.service.StartWeChatLogin()
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("login did not start")
	}
	if _, err := f.service.StartWeChatLogin(); !hasCode(err, CodeLoginInProgress) {
		t.Fatalf("error = %v, want %s", err, CodeLoginInProgress)
	}
	if err := f.service.CancelWeChatLogin(op); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case status := <-f.emitted:
			if status.State == wechat.LoginCancelled {
				return
			}
		case <-deadline:
			t.Fatal("cancelled status was not emitted")
		}
	}
}

func TestServiceConfirmedLoginReportsPublished(t *testing.T) {
	f := newServiceFixture(t)
	f.entries.loginFunc = func(_ context.Context, onStatus func(wechat.LoginStatus)) (domain.Result, error) {
		onStatus(wechat.LoginStatus{State: wechat.LoginConfirmed, Message: "已确认登录"})
		return domain.Result{OperationID: "op-wx-published", State: deployment.StatePublished}, nil
	}
	if _, err := f.service.StartWeChatLogin(); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case status := <-f.emitted:
			if status.State == "published" {
				if status.OperationID != "op-wx-published" {
					t.Fatalf("published = %#v", status)
				}
				return
			}
		case <-deadline:
			t.Fatal("published status was not emitted")
		}
	}
}

func TestServiceConfirmedLoginReportsPublishFailure(t *testing.T) {
	f := newServiceFixture(t)
	f.entries.loginFunc = func(_ context.Context, onStatus func(wechat.LoginStatus)) (domain.Result, error) {
		onStatus(wechat.LoginStatus{State: wechat.LoginConfirmed, Message: "已确认登录"})
		return domain.Result{OperationID: "op-wx-login", State: deployment.StateFailed}, domain.Error{
			Code:    domain.CONFIG_CONFLICT,
			Message: "conflict",
		}
	}
	op, err := f.service.StartWeChatLogin()
	if err != nil {
		t.Fatal(err)
	}
	var failed LoginStatusDTO
	deadline := time.After(2 * time.Second)
	for failed.State != "publish_failed" {
		select {
		case status := <-f.emitted:
			if status.State == wechat.LoginCancelled {
				t.Fatal("publish failure was reported as cancelled")
			}
			if status.State == "publish_failed" {
				failed = status
			}
		case <-deadline:
			t.Fatal("publish_failed status was not emitted")
		}
	}
	if failed.Code != domain.CONFIG_CONFLICT || failed.OperationID != "op-wx-login" {
		t.Fatalf("publish_failed = %#v", failed)
	}
	if err := f.service.CancelWeChatLogin(op); !hasCode(err, CodeLoginNotFound) {
		t.Fatalf("cancel after confirm = %v", err)
	}
}

func TestServiceLoginDoesNotEmitDuplicateCancelled(t *testing.T) {
	f := newServiceFixture(t)
	f.entries.loginFunc = func(_ context.Context, onStatus func(wechat.LoginStatus)) (domain.Result, error) {
		onStatus(wechat.LoginStatus{State: wechat.LoginCancelled, Message: "登录已取消"})
		return domain.Result{}, context.Canceled
	}
	if _, err := f.service.StartWeChatLogin(); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	cancelled := 0
	for {
		select {
		case status := <-f.emitted:
			if status.State == wechat.LoginCancelled {
				cancelled++
				if cancelled > 1 {
					t.Fatal("duplicate cancelled event")
				}
			}
		case <-time.After(200 * time.Millisecond):
			if cancelled != 1 {
				t.Fatalf("cancelled events = %d", cancelled)
			}
			return
		case <-deadline:
			t.Fatal("timed out")
		}
	}
}

func TestServiceConnectTelegramRedactsToken(t *testing.T) {
	f := newServiceFixture(t)
	result, err := f.service.ConnectTelegram(serviceToken, true)
	if err != nil {
		t.Fatal(err)
	}
	if f.entries.telegramToken != serviceToken || !f.entries.telegramOpts.RotateWebhookSecret {
		t.Fatalf("token/options = %q/%v", f.entries.telegramToken, f.entries.telegramOpts)
	}
	assertNoSentinel(t, serviceToken, result, err)

	f.entries.telegramErr = fmt.Errorf("telegram rejected %s", serviceToken)
	_, err = f.service.ConnectTelegram(serviceToken, false)
	if err == nil {
		t.Fatal("expected telegram error")
	}
	assertNoSentinel(t, serviceToken, err)
}

func TestServiceSelectEntry(t *testing.T) {
	f := newServiceFixture(t)
	f.entries.selectResult = EntrySelection{
		Result:     domain.Result{OperationID: "op-entry", State: StatePublished},
		Channel:    EntryWeChat,
		Configured: true,
	}
	result, err := f.service.SelectEntry("wechat")
	if err != nil {
		t.Fatal(err)
	}
	if f.entries.selectChannel != "wechat" || result.Channel != EntryWeChat || !result.Configured || result.OperationID != "op-entry" {
		t.Fatalf("result = %#v", result)
	}
}

func TestServiceStatusExportAndProbeModel(t *testing.T) {
	f := newServiceFixture(t)
	f.diagnostics.report = DiagnosticsReport{Items: []diagnostics.StatusItem{{
		Kind: "wechat", State: diagnostics.StateUnknown, ObservedAt: "2026-11-02T00:00:00Z", Detail: "no logs",
	}}}
	items, err := f.service.Status()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Kind != "wechat" || items[0].State != diagnostics.StateUnknown {
		t.Fatalf("items = %#v", items)
	}

	f.diagnostics.export = []byte(`{"items":[]}`)
	exported, err := f.service.ExportDiagnostics()
	if err != nil {
		t.Fatal(err)
	}
	if exported != `{"items":[]}` {
		t.Fatalf("export = %q", exported)
	}

	var sawKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawKey = r.Header.Get("x-api-key")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	overrideProviderBase(t, ProviderAnthropic, server.URL)

	item, err := f.service.ProbeModel(ProviderAnthropic, "claude-sonnet-5-5", serviceModelKey)
	if err != nil {
		t.Fatal(err)
	}
	if sawKey != serviceModelKey {
		t.Fatalf("probe key = %q", sawKey)
	}
	if item.Kind != "model" || item.Source != diagnostics.SourceLocal || item.State != diagnostics.StateUnverified {
		t.Fatalf("item = %#v", item)
	}
	assertNoSentinel(t, serviceModelKey, item, err)
}

func TestServiceProbeModelErrorDoesNotLeakKey(t *testing.T) {
	f := newServiceFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprintf(w, `{"error":"invalid %s"}`, serviceModelKey)
	}))
	t.Cleanup(server.Close)
	overrideProviderBase(t, ProviderAnthropic, server.URL)

	_, err := f.service.ProbeModel(ProviderAnthropic, "claude-sonnet-5-5", serviceModelKey)
	if err == nil {
		t.Fatal("expected probe error")
	}
	assertNoSentinel(t, serviceModelKey, err)
}

func TestServiceInspectImportAndConfirmRedactSecrets(t *testing.T) {
	f := newServiceFixture(t)
	f.lifecycle.inspectPreview = deployment.ImportPreview{
		ReleaseVersion:      "1.0.0",
		Legacy:              true,
		SecretNames:         []string{"ANTHROPIC_API_KEY"},
		PreserveSecretNames: []string{"ANTHROPIC_API_KEY"},
		RequiredInputs:      []string{"owner"},
		PlaintextSecrets:    []deployment.SecretMigration{{Path: "/mcpServers/0/headers/Authorization", SecretName: "MCP_TOKEN", Reference: "env:MCP_TOKEN"}},
	}
	preview, err := f.service.InspectImport()
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Legacy || len(preview.PlaintextSecrets) != 1 || preview.PlaintextSecrets[0].Reference != "env:MCP_TOKEN" {
		t.Fatalf("preview = %#v", preview)
	}
	foundVersionWarning := false
	for _, warning := range preview.Warnings {
		if strings.Contains(warning, "2.0.0") {
			foundVersionWarning = true
		}
	}
	if !foundVersionWarning {
		t.Fatalf("preview does not state the client release version: %#v", preview.Warnings)
	}

	f.lifecycle.confirmErr = fmt.Errorf("import failed with %s", serviceSecret)
	result, err := f.service.ConfirmImport(ImportInputDTO{
		BaseFingerprint: "fingerprint-1",
		Secrets:         []ImportSecretDTO{{Name: "MCP_TOKEN", Value: serviceSecret}},
	})
	if err == nil {
		t.Fatal("expected import error")
	}
	if f.lifecycle.confirmInput.SecretValues["MCP_TOKEN"] != serviceSecret {
		t.Fatal("secret value was not forwarded to the import layer")
	}
	assertNoSentinel(t, serviceSecret, result, err, preview)
}

func TestServiceFileTargetStorePersistsNonSecretSettings(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileTargetStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	target := domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName}
	if err := store.Save(target); err != nil {
		t.Fatal(err)
	}
	loaded, ok, err := store.Load()
	if err != nil || !ok || loaded != target {
		t.Fatalf("loaded = %#v ok=%v err=%v", loaded, ok, err)
	}
	data, err := osReadFile(dir + "/settings.json")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "token") || strings.Contains(string(data), serviceToken) {
		t.Fatalf("settings file contains a credential: %s", data)
	}
	if err := store.Save(domain.Target{AccountID: "bad", ScriptName: serviceWorkerName}); err == nil {
		t.Fatal("invalid account id was accepted")
	}
}

// osReadFile is a tiny wrapper so the test's secret scan uses the same file
// the store wrote without importing os in several places.
func osReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func hasCode(err error, code string) bool {
	var domainErr domain.Error
	return errors.As(err, &domainErr) && domainErr.Code == code
}
