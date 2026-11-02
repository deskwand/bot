package deployment

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
)

const serviceSecretSentinel = "SERVICE-SECRET-sentinel-value"

var validConfigJSON = []byte(`{
  "schemaVersion": 1,
  "owner": {"telegramUserIds": []},
  "models": {
    "butler": {"provider": "opencode-go", "id": "deepseek-v4.1-flash"},
    "task": {"provider": "opencode-go", "id": "deepseek-v4.1-flash"}
  },
  "mcpServers": []
}`)

type recordedCreate struct {
	Base     domain.Snapshot
	Plan     domain.PublishPlan
	Preserve cloudflare.PreservePolicy
	Modules  map[string][]byte
	Manifest []byte
}

type fakeVersion struct {
	id      string
	message string
}

type fakeAPI struct {
	mu sync.Mutex

	baseVersion   string
	stagedVersion string
	activeVersion string
	latestVersion string
	fingerprint   string
	secretNames   []string
	configJSON    []byte

	versions []fakeVersion

	readCalls     int
	createCalls   int
	activateCalls int
	creates       []recordedCreate
	activations   []string

	createErr    error
	createLost   bool
	activateErr  error
	activateLost bool
	onCreate     func()
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{
		baseVersion:   "version-base",
		stagedVersion: "version-staged",
		activeVersion: "version-base",
		latestVersion: "version-base",
		fingerprint:   "fingerprint-base",
		secretNames:   []string{"ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "WECHAT_CREDENTIALS"},
		configJSON:    append([]byte(nil), validConfigJSON...),
	}
}

func (f *fakeAPI) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readCalls++
	latestVersion := f.latestVersion
	if len(f.versions) > 0 {
		latestVersion = f.versions[0].id
	}
	return domain.Snapshot{
		Target:          domain.Target{AccountID: strings.Repeat("a", 32), ScriptName: "deskwand-bot"},
		DeploymentID:    "deployment-" + f.activeVersion,
		VersionID:       f.activeVersion,
		LatestVersionID: latestVersion,
		ConfigJSON:      append([]byte(nil), f.configJSON...),
		SecretNames:     append([]string(nil), f.secretNames...),
		Fingerprint:     f.fingerprint,
		ActiveVersionCount: func() int {
			if f.activeVersion == "" {
				return 0
			}
			return 1
		}(),
	}, nil
}

func (f *fakeAPI) CreateVersion(_ context.Context, base domain.Snapshot, manifestJSON []byte, modules map[string][]byte, plan domain.PublishPlan, preserve cloudflare.PreservePolicy) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls++
	f.creates = append(f.creates, recordedCreate{
		Base:     base,
		Plan:     plan,
		Preserve: preserve,
		Modules:  modules,
		Manifest: manifestJSON,
	})
	hook := f.onCreate
	if f.createErr != nil {
		if f.createLost {
			f.uploadVersionLocked(f.stagedVersion, preserve.OperationID)
		}
		if hook != nil {
			hook()
		}
		return "", f.createErr
	}
	f.uploadVersionLocked(f.stagedVersion, preserve.OperationID)
	if hook != nil {
		hook()
	}
	return f.stagedVersion, nil
}

func (f *fakeAPI) uploadVersionLocked(id, operationID string) {
	f.latestVersion = id
	f.versions = append([]fakeVersion{{
		id:      id,
		message: "DeskWand Bot publish " + operationID,
	}}, f.versions...)
}

func (f *fakeAPI) addExternalVersion(id, message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.versions = append([]fakeVersion{{id: id, message: message}}, f.versions...)
	f.latestVersion = id
}

func (f *fakeAPI) FindVersionByOperation(_ context.Context, _ domain.Target, operationID string) (string, bool, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	want := "DeskWand Bot publish " + operationID
	for index, version := range f.versions {
		if version.message == want {
			return version.id, index == 0, true, nil
		}
	}
	return "", false, false, nil
}

func (f *fakeAPI) ActivateVersion(_ context.Context, _ domain.Target, versionID string) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.activateCalls++
	f.activations = append(f.activations, versionID)
	if f.activateErr != nil {
		if f.activateLost {
			f.activeVersion = versionID
		}
		return domain.Result{}, f.activateErr
	}
	f.activeVersion = versionID
	return domain.Result{DeploymentID: "deployment-" + versionID, VersionID: versionID, State: "active"}, nil
}

func (f *fakeAPI) snapshotCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.readCalls
}

func (f *fakeAPI) createCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.createCalls
}

func (f *fakeAPI) activateCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.activateCalls
}

func releasePackageFixture(t *testing.T) release.Package {
	t.Helper()
	files := map[string][]byte{"index.js": []byte("export default { fetch() { return new Response('ok') } };\n")}
	entries := make([]release.FileEntry, 0, len(files))
	for path, data := range files {
		sum := sha256.Sum256(data)
		entries = append(entries, release.FileEntry{Path: path, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(data))})
	}
	template := release.ResourceTemplate{
		SchemaVersion: 1,
		Entrypoint:    "index.js",
		Compatibility: release.Compatibility{Date: "2026-11-01", Flags: []string{}},
		DurableObjects: []release.DOBinding{
			{Name: "BUTLER", ClassName: "ButlerDO"},
		},
		R2Buckets:       []release.R2Binding{{Name: "ARTIFACTS", ParameterKey: "r2BucketName"}},
		VersionMetadata: release.BindingRef{Name: "CF_VERSION_METADATA"},
		ConfigBinding:   release.ConfigBinding{Name: "DESKWAND_CONFIG", Type: "json", SchemaVersion: 1},
		SecretNames:     []string{"ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "WECHAT_CREDENTIALS"},
		PlainVars:       []string{"ACTIVE_CHANNEL", "PUBLIC_BASE_URL"},
		Crons:           []string{"*/5 * * * *"},
		Vars:            []release.VarBinding{{Name: "PUBLIC_BASE_URL", ParameterKey: "PUBLIC_BASE_URL"}},
		Migrations:      []release.Migration{{Tag: "v1", NewSQLiteClasses: []string{"ButlerDO"}}},
		InstallParams: []release.InstallParameter{
			{Key: "workerName", Source: "user"},
			{Key: "r2BucketName", Source: "user"},
			{Key: "PUBLIC_BASE_URL", Source: "user"},
			{Key: "owner", Source: "DESKWAND_CONFIG"},
		},
	}
	manifest := release.Manifest{
		ManifestVersion:     1,
		KeyID:               "test-key",
		Version:             "3.0.0",
		Entrypoint:          "index.js",
		Files:               entries,
		CompressedSize:      42,
		ConfigSchemaVersion: 1,
		Compatibility:       template.Compatibility,
		ResourceTemplate:    template,
		Migrations:          template.Migrations,
		Upgrade:             release.Upgrade{MinFromVersion: "1.0.0", IrreversibleMigrations: []string{}},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := release.TrustedKeys{"test-key": pub}.VerifyPackage(raw, ed25519.Sign(priv, raw), files)
	if err != nil {
		t.Fatal(err)
	}
	return pkg
}

type publishFixture struct {
	t       *testing.T
	API     *fakeAPI
	Journal *Journal
	Creds   *platform.MemoryCredentialStore
	Service *Service
	Dir     string
	Logs    *bytes.Buffer
	restore func()
}

func newPublishFixture(t *testing.T) *publishFixture {
	t.Helper()
	dir := t.TempDir()
	journal, err := NewJournal(filepath.Join(dir, "journal"))
	if err != nil {
		t.Fatal(err)
	}
	api := newFakeAPI()
	creds := platform.NewMemoryCredentialStore()
	logs := &bytes.Buffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	f := &publishFixture{
		t:       t,
		API:     api,
		Journal: journal,
		Creds:   creds,
		Service: NewService(api, journal, creds, releasePackageFixture(t), func() time.Time { return time.Unix(1700000000, 0).UTC() }),
		Dir:     journal.Dir(),
		Logs:    logs,
		restore: func() { slog.SetDefault(previous) },
	}
	t.Cleanup(f.restore)
	return f
}

func (f *publishFixture) target() domain.Target {
	return domain.Target{AccountID: strings.Repeat("a", 32), ScriptName: "deskwand-bot"}
}

func (f *publishFixture) change(secretEdits ...domain.SecretEdit) domain.Change {
	return domain.Change{
		BaseFingerprint: f.API.fingerprint,
		Secrets:         secretEdits,
	}
}

func assertNoSentinel(t *testing.T, dir string, logs *bytes.Buffer) {
	t.Helper()
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if bytes.Contains(data, []byte(serviceSecretSentinel)) {
			t.Fatalf("journal file %s contains the secret sentinel", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if logs != nil && bytes.Contains(logs.Bytes(), []byte(serviceSecretSentinel)) {
		t.Fatalf("slog output contains the secret sentinel: %s", logs.String())
	}
}

func assertState(t *testing.T, result domain.Result, state string) {
	t.Helper()
	if result.OperationID == "" {
		t.Fatal("operation id is empty")
	}
	if result.State != state {
		t.Fatalf("state = %q, want %q", result.State, state)
	}
}

func TestApplyPublishesAndRedacts(t *testing.T) {
	f := newPublishFixture(t)
	result, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
		domain.NewSecretEdit("WECHAT_CREDENTIALS", domain.SecretClear, ""),
	))
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StatePublished)
	if f.API.createCount() != 1 || f.API.activateCount() != 1 {
		t.Fatalf("create/activate calls = %d/%d", f.API.createCount(), f.API.activateCount())
	}
	if len(f.API.creates) != 1 {
		t.Fatal("create call not recorded")
	}
	create := f.API.creates[0]
	if create.Preserve.OperationID != result.OperationID {
		t.Fatalf("preserve operation id = %q, want %q", create.Preserve.OperationID, result.OperationID)
	}
	if create.Preserve.SecretNames == nil {
		t.Fatal("preserve secret names missing")
	}
	if len(create.Plan.Secrets) != 2 || create.Plan.Secrets[0].Value() != serviceSecretSentinel {
		t.Fatalf("plan secrets = %v", create.Plan.Secrets)
	}
	if !bytes.Contains(create.Manifest, []byte("3.0.0")) {
		t.Fatal("verified manifest was not passed to the API")
	}
	if _, ok := create.Modules["index.js"]; !ok {
		t.Fatal("verified modules were not passed to the API")
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestResumeVerifiesBeforeRepublishing(t *testing.T) {
	f := newPublishFixture(t)
	f.API.activateErr = fmt.Errorf("activation response lost %s", serviceSecretSentinel)
	f.API.activateLost = true

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("lost activation response returned success")
	}
	assertState(t, first, StateUnknown)
	if strings.Contains(err.Error(), serviceSecretSentinel) {
		t.Fatalf("returned error leaked the sentinel: %v", err)
	}

	f.API.mu.Lock()
	f.API.activateErr = nil
	f.API.activateLost = false
	f.API.mu.Unlock()

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StatePublished)
	if f.API.activateCount() != 1 {
		t.Fatalf("resume repeated activation: %d calls", f.API.activateCount())
	}
	if f.API.createCount() != 1 {
		t.Fatalf("resume re-uploaded: %d create calls", f.API.createCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestResumeFindsCreateVersionLostResponse(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = fmt.Errorf("create response lost %s", serviceSecretSentinel)
	f.API.createLost = true

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("lost create response returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.createLost = false
	f.API.mu.Unlock()

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StatePublished)
	if f.API.createCount() != 1 || f.API.activateCount() != 1 {
		t.Fatalf("create/activate calls = %d/%d, want no repeat upload", f.API.createCount(), f.API.activateCount())
	}
	if f.API.activations[0] != "version-staged" {
		t.Fatalf("activated %q", f.API.activations[0])
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestChangedFingerprintBeforePublishDoesNotMutate(t *testing.T) {
	f := newPublishFixture(t)
	change := f.change()
	change.BaseFingerprint = "stale-fingerprint"
	f.API.fingerprint = "someone-else-changed-it"

	result, err := f.Service.Apply(context.Background(), f.target(), change)
	if err == nil {
		t.Fatal("stale draft published")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != domain.CONFIG_CONFLICT {
		t.Fatalf("error = %v", err)
	}
	assertState(t, result, StateFailed)
	if f.API.createCount() != 0 || f.API.activateCount() != 0 {
		t.Fatalf("conflict mutated remote: create=%d activate=%d", f.API.createCount(), f.API.activateCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestCrashAfterStageResumesWithFreshService(t *testing.T) {
	f := newPublishFixture(t)
	f.API.activateErr = errors.New("activation crashed")

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("activation failure returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.activateErr = nil
	f.API.mu.Unlock()

	restarted, err := NewJournal(f.Dir)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(f.API, restarted, f.Creds, releasePackageFixture(t), func() time.Time { return time.Unix(1700000001, 0).UTC() })
	result, err := service.Resume(context.Background(), first.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StatePublished)
	if f.API.createCount() != 1 {
		t.Fatalf("fresh service re-uploaded: %d", f.API.createCount())
	}
	if f.API.activateCount() != 2 {
		t.Fatalf("activate calls = %d, want initial failed + one resume", f.API.activateCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestSecretClearRemovesValueFromPlanAndJournal(t *testing.T) {
	f := newPublishFixture(t)
	result, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("WECHAT_CREDENTIALS", domain.SecretClear, ""),
	))
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StatePublished)
	create := f.API.creates[0]
	if len(create.Plan.Secrets) != 1 || create.Plan.Secrets[0].Operation != domain.SecretClear || create.Plan.Secrets[0].Value() != "" {
		t.Fatalf("clear plan = %v", create.Plan.Secrets)
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestCredentialStoreUnavailableNeedsInputBeforeMutation(t *testing.T) {
	f := newPublishFixture(t)
	f.Creds.FailWith(fmt.Errorf("keychain unavailable %s", serviceSecretSentinel))

	result, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("unavailable credential store returned success")
	}
	assertState(t, result, StateNeedsInput)
	if strings.Contains(err.Error(), serviceSecretSentinel) {
		t.Fatalf("returned error leaked the sentinel: %v", err)
	}
	if f.API.createCount() != 0 || f.API.activateCount() != 0 {
		t.Fatalf("credential failure mutated remote: create=%d activate=%d", f.API.createCount(), f.API.activateCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestCancellationStopsFutureSteps(t *testing.T) {
	f := newPublishFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	f.API.mu.Lock()
	f.API.onCreate = cancel
	f.API.mu.Unlock()

	result, err := f.Service.Apply(ctx, f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("cancelled publish returned success")
	}
	assertState(t, result, StateCancelled)
	if f.API.createCount() != 1 {
		t.Fatalf("create calls = %d", f.API.createCount())
	}
	if f.API.activateCount() != 0 {
		t.Fatalf("cancellation still activated: %d", f.API.activateCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestLatestNotBaseIsSurfaced(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = domain.Error{Code: domain.LATEST_NOT_BASE, Message: "latest changed " + serviceSecretSentinel}

	result, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("LATEST_NOT_BASE returned success")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != domain.LATEST_NOT_BASE {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), serviceSecretSentinel) {
		t.Fatalf("LATEST_NOT_BASE leaked sentinel: %v", err)
	}
	assertState(t, result, StateFailed)
	if f.API.activateCount() != 0 {
		t.Fatalf("LATEST_NOT_BASE still activated: %d", f.API.activateCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestResumeRetriesStageOnlyWithPendingSecret(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = fmt.Errorf("network failed %s", serviceSecretSentinel)

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("failed stage returned success")
	}
	assertState(t, first, StateUnknown)

	// Remove the pending value to simulate process restart without the
	// credential-store entry.
	if err := f.Creds.Delete(context.Background(), pendingSecretKey(first.OperationID, "TELEGRAM_BOT_TOKEN")); err != nil {
		t.Fatal(err)
	}
	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.mu.Unlock()

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err == nil {
		t.Fatal("resume without pending secret returned success")
	}
	assertState(t, result, StateNeedsInput)
	if f.API.createCount() != 1 {
		t.Fatalf("resume republished without the pending secret: %d", f.API.createCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestPreviewReturnsPlanAndConflictNote(t *testing.T) {
	f := newPublishFixture(t)
	steps, err := f.Service.Preview(context.Background(), f.target(), f.change())
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) < 4 {
		t.Fatalf("steps = %#v", steps)
	}
	if !strings.Contains(steps[3].Message, "无法检测") {
		t.Fatalf("conflict note = %q", steps[3].Message)
	}
	if f.API.createCount() != 0 {
		t.Fatal("Preview mutated remote state")
	}
}

func TestResumeFailsWhenFingerprintChangedBeforeRetry(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = fmt.Errorf("network failed %s", serviceSecretSentinel)

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("failed stage returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.fingerprint = "someone-else-changed-it"
	f.API.mu.Unlock()

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err == nil {
		t.Fatal("resume after external change returned success")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != domain.CONFIG_CONFLICT {
		t.Fatalf("error = %v", err)
	}
	assertState(t, result, StateFailed)
	if f.API.createCount() != 1 {
		t.Fatalf("resume published after conflict: %d create calls", f.API.createCount())
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}

func TestResumeDoesNotActivateExternalVersionAfterLatestNotBase(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = domain.Error{Code: domain.LATEST_NOT_BASE, Message: "latest changed"}
	f.API.createLost = true

	first, err := f.Service.Apply(context.Background(), f.target(), f.change())
	if err == nil {
		t.Fatal("LATEST_NOT_BASE returned success")
	}
	assertState(t, first, StateFailed)
	if f.API.activateCount() != 0 {
		t.Fatalf("LATEST_NOT_BASE activated: %d", f.API.activateCount())
	}

	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.createLost = false
	f.API.mu.Unlock()

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err == nil {
		t.Fatal("resume after LATEST_NOT_BASE returned success")
	}
	assertState(t, result, StateFailed)
	if f.API.activateCount() != 0 {
		t.Fatalf("resume activated an external version: %d", f.API.activateCount())
	}
}

func TestApplyStateTable(t *testing.T) {
	cases := []struct {
		name         string
		setup        func(*publishFixture)
		change       func(*publishFixture) domain.Change
		wantState    string
		wantErr      bool
		wantCreate   int
		wantActivate int
	}{
		{
			name:         "published",
			wantState:    StatePublished,
			wantCreate:   1,
			wantActivate: 1,
		},
		{
			name: "config conflict",
			setup: func(f *publishFixture) {
				f.API.fingerprint = "changed"
			},
			change: func(f *publishFixture) domain.Change {
				change := f.change()
				change.BaseFingerprint = "stale"
				return change
			},
			wantState:    StateFailed,
			wantErr:      true,
			wantCreate:   0,
			wantActivate: 0,
		},
		{
			name: "credential store unavailable",
			setup: func(f *publishFixture) {
				f.Creds.FailWith(errors.New("unavailable " + serviceSecretSentinel))
			},
			change: func(f *publishFixture) domain.Change {
				return f.change(domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel))
			},
			wantState:    StateNeedsInput,
			wantErr:      true,
			wantCreate:   0,
			wantActivate: 0,
		},
		{
			name: "latest not base",
			setup: func(f *publishFixture) {
				f.API.createErr = domain.Error{Code: domain.LATEST_NOT_BASE, Message: "changed"}
			},
			wantState:    StateFailed,
			wantErr:      true,
			wantCreate:   1,
			wantActivate: 0,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			f := newPublishFixture(t)
			if testCase.setup != nil {
				testCase.setup(f)
			}
			change := f.change()
			if testCase.change != nil {
				change = testCase.change(f)
			}
			result, err := f.Service.Apply(context.Background(), f.target(), change)
			if (err != nil) != testCase.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, testCase.wantErr)
			}
			assertState(t, result, testCase.wantState)
			if f.API.createCount() != testCase.wantCreate || f.API.activateCount() != testCase.wantActivate {
				t.Fatalf("create/activate calls = %d/%d, want %d/%d",
					f.API.createCount(), f.API.activateCount(), testCase.wantCreate, testCase.wantActivate)
			}
			assertNoSentinel(t, f.Dir, f.Logs)
		})
	}
}

type deleteFailStore struct {
	inner *platform.MemoryCredentialStore
	mu    sync.Mutex
	fail  bool
}

func (s *deleteFailStore) Get(ctx context.Context, key string) (string, error) {
	return s.inner.Get(ctx, key)
}

func (s *deleteFailStore) Set(ctx context.Context, key, value string) error {
	return s.inner.Set(ctx, key, value)
}

func (s *deleteFailStore) Delete(ctx context.Context, key string) error {
	s.mu.Lock()
	fail := s.fail
	s.mu.Unlock()
	if fail {
		return errors.New("delete failed " + serviceSecretSentinel)
	}
	return s.inner.Delete(ctx, key)
}

func (s *deleteFailStore) setFail(fail bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fail = fail
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) {
	return 0, errors.New("random source failed")
}

func TestResumeRefusesExternalLatestAndCleansPendingSecret(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = fmt.Errorf("network failed %s", serviceSecretSentinel)

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("failed stage returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.mu.Unlock()
	f.API.addExternalVersion("version-external", "DeskWand Bot publish op-someone-else")

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err == nil {
		t.Fatal("resume of external latest returned success")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != domain.CONFIG_CONFLICT {
		t.Fatalf("error = %v", err)
	}
	assertState(t, result, StateFailed)
	if f.API.activateCount() != 0 {
		t.Fatalf("external version was activated: %d", f.API.activateCount())
	}
	if _, err := f.Creds.Get(context.Background(), pendingSecretKey(first.OperationID, "TELEGRAM_BOT_TOKEN")); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("pending secret was not deleted: %v", err)
	}
}

func TestResumeRefusesOurVersionWhenAnotherFollowed(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = fmt.Errorf("create response lost %s", serviceSecretSentinel)
	f.API.createLost = true

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("lost create returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.createLost = false
	f.API.mu.Unlock()
	f.API.addExternalVersion("version-external", "DeskWand Bot publish op-someone-else")

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err == nil {
		t.Fatal("resume after a newer external version returned success")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != domain.CONFIG_CONFLICT {
		t.Fatalf("error = %v", err)
	}
	assertState(t, result, StateFailed)
	if f.API.activateCount() != 0 {
		t.Fatalf("non-latest operation version was activated: %d", f.API.activateCount())
	}
	if _, err := f.Creds.Get(context.Background(), pendingSecretKey(first.OperationID, "TELEGRAM_BOT_TOKEN")); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("pending secret was not deleted: %v", err)
	}
}

func TestResumeRefusesActivationWhenActiveVersionChanged(t *testing.T) {
	f := newPublishFixture(t)
	f.API.activateErr = errors.New("activation response lost")
	f.API.activateLost = false

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("activation failure returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.activateErr = nil
	f.API.activeVersion = "version-external"
	f.API.mu.Unlock()

	result, err := f.Service.Resume(context.Background(), first.OperationID)
	if err == nil {
		t.Fatal("resume with a changed active version returned success")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != domain.CONFIG_CONFLICT {
		t.Fatalf("error = %v", err)
	}
	assertState(t, result, StateFailed)
	if f.API.activateCount() != 1 {
		t.Fatalf("resume activated after active version changed: %d total", f.API.activateCount())
	}
}

func TestAbandonCancelsWithoutActivatingAndDeletesPendingSecrets(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = fmt.Errorf("network failed %s", serviceSecretSentinel)

	first, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("failed stage returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.mu.Unlock()

	result, err := f.Service.Abandon(context.Background(), first.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StateCancelled)
	if f.API.activateCount() != 0 {
		t.Fatalf("abandon activated a version: %d", f.API.activateCount())
	}
	if _, err := f.Creds.Get(context.Background(), pendingSecretKey(first.OperationID, "TELEGRAM_BOT_TOKEN")); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("pending secret was not deleted: %v", err)
	}

	// I6: Resume on a cancelled record must return without activating.
	result, err = f.Service.Resume(context.Background(), first.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, result, StateCancelled)
	if f.API.activateCount() != 0 {
		t.Fatalf("resume activated a cancelled operation: %d", f.API.activateCount())
	}
}

func TestAbandonRefusesPendingStagedVersion(t *testing.T) {
	f := newPublishFixture(t)
	f.API.activateErr = errors.New("activation failed")

	first, err := f.Service.Apply(context.Background(), f.target(), f.change())
	if err == nil {
		t.Fatal("activation failure returned success")
	}
	assertState(t, first, StateUnknown)

	f.API.mu.Lock()
	f.API.activateErr = nil
	f.API.mu.Unlock()

	if _, err := f.Service.Abandon(context.Background(), first.OperationID); err == nil {
		t.Fatal("abandoned while our staged version was still pending")
	}
	if f.API.activateCount() != 1 {
		t.Fatalf("abandon activated something: %d", f.API.activateCount())
	}
}

func TestCleanupFailureIsJournaledAndRetriedOnResume(t *testing.T) {
	dir := t.TempDir()
	journal, err := NewJournal(filepath.Join(dir, "journal"))
	if err != nil {
		t.Fatal(err)
	}
	inner := platform.NewMemoryCredentialStore()
	creds := &deleteFailStore{inner: inner, fail: true}
	api := newFakeAPI()
	service := NewService(api, journal, creds, releasePackageFixture(t), func() time.Time { return time.Unix(1700000000, 0).UTC() })
	target := domain.Target{AccountID: strings.Repeat("a", 32), ScriptName: "deskwand-bot"}
	change := domain.Change{
		BaseFingerprint: api.fingerprint,
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
		},
	}

	result, err := service.Apply(context.Background(), target, change)
	if err == nil {
		t.Fatal("cleanup failure was not surfaced")
	}
	assertState(t, result, StatePublished)
	record, err := journal.Load(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if !record.CleanupPending {
		t.Fatal("cleanup failure did not set CleanupPending")
	}
	if _, err := inner.Get(context.Background(), pendingSecretKey(result.OperationID, "TELEGRAM_BOT_TOKEN")); err != nil {
		t.Fatalf("pending secret unexpectedly absent before retry: %v", err)
	}

	creds.setFail(false)
	retried, err := service.Resume(context.Background(), result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, retried, StatePublished)
	record, err = journal.Load(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if record.CleanupPending {
		t.Fatal("Resume did not clear CleanupPending")
	}
	if _, err := inner.Get(context.Background(), pendingSecretKey(result.OperationID, "TELEGRAM_BOT_TOKEN")); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("pending secret was not deleted on retry: %v", err)
	}
}

func TestNotSentMarksFailedRetryableAndRetainsPendingSecret(t *testing.T) {
	f := newPublishFixture(t)
	f.API.createErr = domain.Error{Code: domain.NOT_SENT, Message: "not sent " + serviceSecretSentinel}

	result, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("NOT_SENT returned success")
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != domain.NOT_SENT {
		t.Fatalf("error = %v", err)
	}
	assertState(t, result, StateFailed)
	if f.API.activateCount() != 0 {
		t.Fatalf("NOT_SENT activated: %d", f.API.activateCount())
	}
	if _, err := f.Creds.Get(context.Background(), pendingSecretKey(result.OperationID, "TELEGRAM_BOT_TOKEN")); err != nil {
		t.Fatalf("NOT_SENT deleted the pending secret: %v", err)
	}

	f.API.mu.Lock()
	f.API.createErr = nil
	f.API.mu.Unlock()
	retried, err := f.Service.Resume(context.Background(), result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertState(t, retried, StatePublished)
	if f.API.createCount() != 2 || f.API.activateCount() != 1 {
		t.Fatalf("retry create/activate = %d/%d", f.API.createCount(), f.API.activateCount())
	}
}

func TestOperationIDFailureFailsBeforeMutation(t *testing.T) {
	f := newPublishFixture(t)
	previous := operationRand
	operationRand = failingReader{}
	t.Cleanup(func() { operationRand = previous })

	_, err := f.Service.Apply(context.Background(), f.target(), f.change())
	if err == nil {
		t.Fatal("operation id failure returned success")
	}
	if f.API.createCount() != 0 || f.API.activateCount() != 0 {
		t.Fatalf("mutation happened without an operation id: create=%d activate=%d", f.API.createCount(), f.API.activateCount())
	}
	entries, readErr := os.ReadDir(f.Dir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("mutation or journal happened without an operation id: %#v", entries)
	}
}

func TestTargetLockHonorsContext(t *testing.T) {
	f := newPublishFixture(t)
	unlock, err := f.Service.lockTarget(context.Background(), f.target())
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.Service.Apply(ctx, f.target(), f.change()); !errors.Is(err, context.Canceled) {
		t.Fatalf("Apply with cancelled lock = %v", err)
	}
	if f.API.createCount() != 0 {
		t.Fatalf("cancelled lock still mutated: %d", f.API.createCount())
	}
}

func TestJournalEvidenceNeverContainsRawServerBody(t *testing.T) {
	f := newPublishFixture(t)
	const rawBody = "RAW-SERVER-BODY-MUST-NOT-BE-JOURNALED"
	f.API.createErr = fmt.Errorf("%s %s", rawBody, serviceSecretSentinel)

	result, err := f.Service.Apply(context.Background(), f.target(), f.change(
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
	))
	if err == nil {
		t.Fatal("failed create returned success")
	}
	assertState(t, result, StateUnknown)
	data, readErr := os.ReadFile(filepath.Join(f.Dir, result.OperationID+".json"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if bytes.Contains(data, []byte(rawBody)) {
		t.Fatalf("journal contains a raw server body: %s", data)
	}
	assertNoSentinel(t, f.Dir, f.Logs)
}
