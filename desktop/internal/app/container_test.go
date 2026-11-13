package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/container"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/release"
)

// fakeContainer implements both ContainerRuntime and EntryPublisher. Every
// call is recorded so a test can prove which implementation a router chose.
type fakeContainer struct {
	preflight      container.PreflightReport
	preflightErr   error
	preflightCalls int

	installRequest container.InstallRequest
	installTarget  domain.Target
	installSteps   []domain.Step
	installResult  domain.Result
	installErr     error
	installCalls   int

	status      container.RuntimeStatus
	statusErr   error
	statusCalls int

	restoreResult domain.Result
	restoreErr    error
	restoreCalls  int

	snapshot      domain.Snapshot
	snapshotErr   error
	snapshotCalls int

	previewSteps []domain.Step
	previewErr   error
	previewCalls int

	applyResult domain.Result
	applyErr    error
	applyTarget domain.Target
	applyChange domain.Change
	applyCalls  int

	totalCalls int
}

func (f *fakeContainer) Preflight(context.Context, domain.Target) (container.PreflightReport, error) {
	f.preflightCalls++
	f.totalCalls++
	return f.preflight, f.preflightErr
}

func (f *fakeContainer) Install(_ context.Context, target domain.Target, request container.InstallRequest, onStep func(domain.Step)) (domain.Result, error) {
	f.installCalls++
	f.totalCalls++
	f.installTarget = target
	f.installRequest = request
	for _, step := range f.installSteps {
		if onStep != nil {
			onStep(step)
		}
	}
	result := f.installResult
	if result.State == "" && f.installErr == nil {
		result = domain.Result{State: deployment.StatePublished}
	}
	return result, f.installErr
}

func (f *fakeContainer) Status(context.Context, domain.Target) (container.RuntimeStatus, error) {
	f.statusCalls++
	f.totalCalls++
	return f.status, f.statusErr
}

func (f *fakeContainer) RestorePrevious(context.Context, domain.Target) (domain.Result, error) {
	f.restoreCalls++
	f.totalCalls++
	result := f.restoreResult
	if result.State == "" && f.restoreErr == nil {
		result = domain.Result{State: deployment.StatePublished}
	}
	return result, f.restoreErr
}

func (f *fakeContainer) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	f.snapshotCalls++
	f.totalCalls++
	return f.snapshot, f.snapshotErr
}

func (f *fakeContainer) Preview(_ context.Context, _ domain.Target, _ domain.Change) ([]domain.Step, error) {
	f.previewCalls++
	f.totalCalls++
	return f.previewSteps, f.previewErr
}

func (f *fakeContainer) Apply(_ context.Context, target domain.Target, change domain.Change) (domain.Result, error) {
	f.applyCalls++
	f.totalCalls++
	f.applyTarget = target
	f.applyChange = change
	result := f.applyResult
	if result.State == "" && f.applyErr == nil {
		result = domain.Result{State: deployment.StatePublished}
	}
	return result, f.applyErr
}

type fakeSSH struct {
	fingerprint string
	known       bool
	probeErr    error
	probes      []domain.HostRef

	trustErr   error
	trusted    []string
	trustHosts []domain.HostRef

	storeErr    error
	stored      []string
	storedHosts []domain.HostRef

	forgetErr error
	forgets   []domain.HostRef

	events []string
}

func (f *fakeSSH) Probe(_ context.Context, host domain.HostRef) (string, bool, error) {
	f.probes = append(f.probes, host)
	return f.fingerprint, f.known, f.probeErr
}

func (f *fakeSSH) Trust(_ context.Context, host domain.HostRef, fingerprint string) error {
	f.events = append(f.events, "trust")
	f.trustHosts = append(f.trustHosts, host)
	f.trusted = append(f.trusted, fingerprint)
	return f.trustErr
}

func (f *fakeSSH) StoreSecret(_ context.Context, host domain.HostRef, secret string) error {
	f.events = append(f.events, "store")
	f.storedHosts = append(f.storedHosts, host)
	f.stored = append(f.stored, secret)
	return f.storeErr
}

func (f *fakeSSH) Forget(_ context.Context, host domain.HostRef) error {
	f.forgets = append(f.forgets, host)
	return f.forgetErr
}

type containerFixture struct {
	auth      *fakeAuth
	publish   *fakePublish
	container *fakeContainer
	ssh       *fakeSSH
	snapshots *fakeSnapshots
	store     *fakeStore
	release   *fakeRelease
	cache     *FileSnapshotCache
	steps     []StepDTO
	service   *Service
}

func newContainerFixture(t *testing.T) *containerFixture {
	t.Helper()
	f := &containerFixture{
		auth:      &fakeAuth{connection: auth.Connection{State: auth.StateDisconnected}},
		publish:   &fakePublish{},
		container: &fakeContainer{},
		ssh:       &fakeSSH{fingerprint: "SHA256:aaa"},
		snapshots: &fakeSnapshots{},
		store:     &fakeStore{},
		release:   &fakeRelease{version: "2.0.0"},
	}
	dataDir := t.TempDir()
	cache, err := NewFileSnapshotCache(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	f.cache = cache
	f.build()
	return f
}

func (f *containerFixture) build() {
	f.service = NewService(ServiceOptions{
		Auth:        f.auth,
		Publish:     &PublishRouter{Cloudflare: f.publish, Container: f.container},
		Lifecycle:   &fakeLifecycle{},
		Entries:     &fakeEntries{},
		Diagnostics: &StatusRouter{Cloudflare: &fakeStatus{}, Container: &ContainerDiagnostics{Runtime: f.container}},
		Snapshots:   &SnapshotRouter{Cloudflare: f.snapshots, Container: f.container},
		Journal:     &fakeJournal{records: map[string]deployment.OperationRecord{}},
		Store:       f.store,
		Cache:       f.cache,
		Release:     f.release,
		Container:   f.container,
		SSH:         f.ssh,
		EmitContainerProgress: func(step StepDTO) {
			f.steps = append(f.steps, step)
		},
		Now: func() time.Time { return time.Unix(1700000000, 0).UTC() },
	})
}

func testSSHInput() SSHHostInputDTO {
	return SSHHostInputDTO{
		Address: "192.0.2.10",
		Port:    0,
		User:    "root",
		Auth:    domain.SSHAuthPassword,
		Secret:  "correct horse battery staple",
	}
}

func testRemoteHost() domain.HostRef {
	return domain.HostRef{
		Address: "192.0.2.10",
		Port:    domain.DefaultSSHPort,
		User:    "root",
		Auth:    domain.SSHAuthPassword,
		Dir:     domain.DefaultRemoteDir,
	}
}

func TestBootStateContainerTargetNeedsNoCloudflareLogin(t *testing.T) {
	f := newContainerFixture(t)
	target := routerContainerTarget()
	f.store.target = target
	f.store.ok = true

	state, err := f.service.BootState()
	if err != nil {
		t.Fatal(err)
	}
	if state.TargetKind != domain.TargetContainer || !state.TargetSelected {
		t.Fatalf("state = %#v", state)
	}
	if state.TargetName != target.Host.Address {
		t.Fatalf("target name = %q", state.TargetName)
	}
	if len(state.Pending) != 0 {
		t.Fatalf("pending = %#v", state.Pending)
	}
}

func TestBootStateLegacyTargetIsCloudflare(t *testing.T) {
	f := newContainerFixture(t)
	f.auth.connection = auth.Connection{State: auth.StateConnected, AccountID: serviceAccountID}
	f.store.target = domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName}
	f.store.ok = true

	state, err := f.service.BootState()
	if err != nil {
		t.Fatal(err)
	}
	if state.TargetKind != domain.TargetCloudflare || !state.TargetSelected || state.TargetName != serviceWorkerName {
		t.Fatalf("state = %#v", state)
	}
}

func TestProbeSSHHostAppliesDefaults(t *testing.T) {
	f := newContainerFixture(t)
	if _, err := f.service.ProbeSSHHost(testSSHInput()); err != nil {
		t.Fatal(err)
	}
	if len(f.ssh.probes) != 1 {
		t.Fatalf("probes = %d", len(f.ssh.probes))
	}
	probed := f.ssh.probes[0]
	if probed.Port != 22 || probed.Dir != "~/deskwand" {
		t.Fatalf("probed host = %#v", probed)
	}

	input := testSSHInput()
	input.Dir = "/a;b"
	if _, err := f.service.ProbeSSHHost(input); !hasCode(err, deployment.CodeInvalidRequest) {
		t.Fatalf("error = %v, want invalid request", err)
	}
	if len(f.ssh.probes) != 1 {
		t.Fatal("invalid input reached the prober")
	}
}

func TestConnectSSHHostTrustsOnlyTheShownFingerprint(t *testing.T) {
	f := newContainerFixture(t)
	f.container.preflight = container.PreflightReport{Checks: []container.Check{{ID: "docker", OK: true, Detail: "ok"}}}

	if _, err := f.service.ConnectSSHHost(testSSHInput(), "SHA256:bbb"); err == nil {
		t.Fatal("a fingerprint that was not shown was accepted")
	}
	if len(f.ssh.trusted) != 0 || len(f.ssh.stored) != 0 || f.container.preflightCalls != 0 {
		t.Fatalf("unexpected calls: trust=%v store=%v preflight=%d", f.ssh.trusted, f.ssh.stored, f.container.preflightCalls)
	}

	f.container.totalCalls = 0
	report, err := f.service.ConnectSSHHost(testSSHInput(), "SHA256:aaa")
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Checks) != 1 || report.Checks[0].ID != "docker" || !report.Passed {
		t.Fatalf("report = %#v", report)
	}
	if len(f.ssh.trusted) != 1 || f.ssh.trusted[0] != "SHA256:aaa" {
		t.Fatalf("trusted = %#v", f.ssh.trusted)
	}
	if len(f.ssh.stored) != 1 || f.ssh.stored[0] != testSSHInput().Secret {
		t.Fatalf("stored = %#v", f.ssh.stored)
	}
	want := []string{"trust", "store", "preflight"}
	if strings.Join(f.ssh.events, ",") != strings.Join(want[:2], ",") {
		t.Fatalf("events = %#v", f.ssh.events)
	}
	if f.container.totalCalls != 1 {
		t.Fatalf("container calls = %d", f.container.totalCalls)
	}
}

func TestConnectSSHHostForgetsOnAuthFailure(t *testing.T) {
	f := newContainerFixture(t)
	f.container.preflightErr = domain.Error{Code: domain.SSH_AUTH_FAILED, Message: "bad credentials"}

	if _, err := f.service.ConnectSSHHost(testSSHInput(), "SHA256:aaa"); !hasCode(err, domain.SSH_AUTH_FAILED) {
		t.Fatalf("error = %v", err)
	}
	if len(f.ssh.forgets) != 1 {
		t.Fatalf("forgets = %#v", f.ssh.forgets)
	}
	_, err := f.service.ContainerPreflight()
	if !hasCode(err, deployment.CodeInvalidRequest) {
		t.Fatalf("preflight error = %v", err)
	}
	want := i18n.T(f.service.locale.Current(), "app.containerHostPending")
	if domainMessage(t, err) != want {
		t.Fatalf("message = %q, want %q", domainMessage(t, err), want)
	}
}

func TestInstallContainerSavesTargetOnlyOnSuccess(t *testing.T) {
	f := newContainerFixture(t)
	host := testRemoteHost()
	f.service.setPendingHost(host)
	secretValue := "sk-ant-api03-INSTALL-SECRET"
	input := ContainerInstallInputDTO{
		TelegramUserIDs: []int64{7, 8},
		ButlerModel:     ModelDTO{Provider: "anthropic", ID: "claude-sonnet-5-5"},
		TaskModel:       ModelDTO{Provider: "opencode-go", ID: "kimi-k3"},
		ActiveChannel:   "telegram",
		Secrets:         []SecretEditDTO{{Name: "MODEL_KEY_ANTHROPIC", Operation: "replace", Value: secretValue}},
	}

	f.container.installErr = errors.New("boom")
	summary, err := f.service.InstallContainer(input)
	if err == nil {
		t.Fatal("install failure was reported as success")
	}
	if _, ok, err := f.store.Load(); err != nil || ok {
		t.Fatalf("store after failure = %v, %v", ok, err)
	}
	assertNoSentinel(t, secretValue, err, summary)

	f.container.installErr = nil
	f.container.installSteps = []domain.Step{{ID: "write-env", State: "completed", Message: "done"}}
	f.steps = nil
	summary, err = f.service.InstallContainer(input)
	if err != nil {
		t.Fatal(err)
	}
	assertNoSentinel(t, secretValue, err, summary)

	stored, ok, err := f.store.Load()
	if err != nil || !ok {
		t.Fatalf("store = %v, %v", ok, err)
	}
	if !stored.IsContainer() || stored.Host != host {
		t.Fatalf("stored target = %#v", stored)
	}
	if f.container.installTarget != stored {
		t.Fatalf("install target = %#v", f.container.installTarget)
	}

	var config struct {
		Owner struct {
			TelegramUserIDs []int64 `json:"telegramUserIds"`
		} `json:"owner"`
		Models struct {
			Butler *ModelDTO `json:"butler"`
			Task   *ModelDTO `json:"task"`
		} `json:"models"`
	}
	if err := json.Unmarshal(f.container.installRequest.ConfigJSON, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Owner.TelegramUserIDs) != 2 || config.Owner.TelegramUserIDs[0] != 7 || config.Owner.TelegramUserIDs[1] != 8 {
		t.Fatalf("owner = %#v", config.Owner.TelegramUserIDs)
	}
	if config.Models.Butler == nil || config.Models.Butler.Provider != "anthropic" ||
		config.Models.Task == nil || config.Models.Task.ID != "kimi-k3" {
		t.Fatalf("models = %#v / %#v", config.Models.Butler, config.Models.Task)
	}
	if f.container.installRequest.ActiveChannel != "telegram" {
		t.Fatalf("channel = %q", f.container.installRequest.ActiveChannel)
	}
	if len(f.container.installRequest.Secrets) != 1 ||
		f.container.installRequest.Secrets[0].Name != "MODEL_KEY_ANTHROPIC" ||
		f.container.installRequest.Secrets[0].Value() != secretValue {
		t.Fatalf("secrets = %#v", f.container.installRequest.Secrets)
	}
	if len(f.steps) != 1 || f.steps[0].ID != "write-env" || f.steps[0].State != "completed" {
		t.Fatalf("steps = %#v", f.steps)
	}
	if _, err := f.service.ContainerPreflight(); !hasCode(err, deployment.CodeInvalidRequest) {
		t.Fatalf("pending host was not cleared: %v", err)
	}
}

func TestAdoptContainerRequiresExistingInstance(t *testing.T) {
	f := newContainerFixture(t)
	host := testRemoteHost()
	f.service.setPendingHost(host)

	f.container.preflight = container.PreflightReport{Existing: false}
	if _, err := f.service.AdoptContainer(); err == nil {
		t.Fatal("adopt accepted a directory without an instance")
	}
	if _, ok, _ := f.store.Load(); ok {
		t.Fatal("adopt saved a target without an instance")
	}

	f.container.preflight = container.PreflightReport{Existing: true}
	f.container.snapshot = domain.Snapshot{Fingerprint: "fp", ReleaseVersion: "1.0.0"}
	summary, err := f.service.AdoptContainer()
	if err != nil {
		t.Fatal(err)
	}
	stored, ok, _ := f.store.Load()
	if !ok || !stored.IsContainer() || stored.Host != host {
		t.Fatalf("stored = %#v", stored)
	}
	if f.container.installCalls != 0 {
		t.Fatalf("adopt installed: %d", f.container.installCalls)
	}
	if summary.State != deployment.StatePublished || summary.ReleaseVersion != "1.0.0" {
		t.Fatalf("summary = %#v", summary)
	}
}

func TestCloudflareOnlyMethodsReportUnsupported(t *testing.T) {
	f := newContainerFixture(t)
	f.store.target = routerContainerTarget()
	f.store.ok = true

	calls := map[string]func() error{
		"UpgradeAvailable": func() error { _, err := f.service.UpgradeAvailable(); return err },
		"Upgrade":          func() error { _, err := f.service.Upgrade(); return err },
		"ListWorkers":      func() error { _, err := f.service.ListWorkers(); return err },
		"InspectImport":    func() error { _, err := f.service.InspectImport(); return err },
		"ConfirmImport": func() error {
			_, err := f.service.ConfirmImport(ImportInputDTO{})
			return err
		},
		"ExportData":       func() error { _, err := f.service.ExportData(); return err },
		"WalletStatus":     func() error { _, err := f.service.WalletStatus(); return err },
		"LifeVitals":       func() error { _, err := f.service.LifeVitals(); return err },
		"McpStatus":        func() error { _, err := f.service.McpStatus(); return err },
		"TestExchange":     func() error { _, err := f.service.TestExchange("okx-1"); return err },
		"Install":          func() error { _, err := f.service.Install(InstallInputDTO{}); return err },
		"SelectDeployment": func() error { return f.service.SelectDeployment("another-worker") },
	}
	for name, call := range calls {
		err := call()
		if !hasCode(err, domain.TARGET_UNSUPPORTED) {
			t.Fatalf("%s error = %v, want %s", name, err, domain.TARGET_UNSUPPORTED)
		}
		if hasCode(err, CodeAuthRequired) {
			t.Fatalf("%s reported AUTH_REQUIRED", name)
		}
	}
}

func TestPublishConfigRoutesToContainerWithoutReleasePackage(t *testing.T) {
	f := newContainerFixture(t)
	f.store.target = routerContainerTarget()
	f.store.ok = true
	f.release.err = release.ErrNotBundled
	f.container.snapshot = domain.Snapshot{Fingerprint: "fp"}

	if _, err := f.service.PublishConfig(ConfigEditDTO{}); err != nil {
		t.Fatal(err)
	}
	if f.container.applyCalls != 1 {
		t.Fatalf("container apply = %d", f.container.applyCalls)
	}
	if len(f.publish.changes) != 0 {
		t.Fatalf("cloudflare publish = %d", len(f.publish.changes))
	}
}

func TestDisconnectContainerTouchesNothingRemote(t *testing.T) {
	f := newContainerFixture(t)
	target := routerContainerTarget()
	f.store.target = target
	f.store.ok = true

	if err := f.service.DisconnectContainer(); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := f.store.Load(); ok {
		t.Fatal("target survived disconnect")
	}
	if len(f.ssh.forgets) != 1 || f.ssh.forgets[0] != target.Host {
		t.Fatalf("forgets = %#v", f.ssh.forgets)
	}
	if f.container.totalCalls != 0 {
		t.Fatalf("container calls = %d", f.container.totalCalls)
	}
}

func TestContainerDiagnostics(t *testing.T) {
	f := newContainerFixture(t)
	reports := &ContainerDiagnostics{Runtime: f.container, Locale: func() string { return i18n.ZH }}

	f.container.status = container.RuntimeStatus{Reachable: false}
	report, err := reports.Status(context.Background(), routerContainerTarget())
	if err != nil {
		t.Fatal(err)
	}
	item := itemByKind(t, report, "container")
	if item.State != diagnostics.StateUnavailable || item.Detail != i18n.T(i18n.ZH, "app.containerUnreachable") {
		t.Fatalf("unreachable item = %#v", item)
	}

	f.container.status = container.RuntimeStatus{Reachable: true, Running: true, Health: "healthy"}
	f.container.snapshot = domain.Snapshot{SecretNames: []string{"TELEGRAM_BOT_TOKEN"}}
	report, err = reports.Status(context.Background(), routerContainerTarget())
	if err != nil {
		t.Fatal(err)
	}
	item = itemByKind(t, report, "container")
	if item.State != diagnostics.StateVerified {
		t.Fatalf("healthy item = %#v", item)
	}
	if item = itemByKind(t, report, "telegram"); item.State != diagnostics.StateConfigured {
		t.Fatalf("telegram item = %#v", item)
	}
	for _, kind := range []string{"telegram", "wechat"} {
		if state := itemByKind(t, report, kind).State; state == diagnostics.StateVerified {
			t.Fatalf("%s item claims cloud verification: %#v", kind, item)
		}
	}

	exported, err := reports.ExportDiagnostics(context.Background(), routerContainerTarget())
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Items []struct {
			Kind string `json:"kind"`
		} `json:"items"`
	}
	if err := json.Unmarshal(exported, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Items) == 0 {
		t.Fatalf("export = %s", exported)
	}
}

func itemByKind(t *testing.T, report DiagnosticsReport, kind string) diagnostics.StatusItem {
	t.Helper()
	for _, item := range report.Items {
		if item.Kind == kind {
			return item
		}
	}
	t.Fatalf("no %q item in %#v", kind, report.Items)
	return diagnostics.StatusItem{}
}

func TestCacheDoesNotCrossTargets(t *testing.T) {
	f := newContainerFixture(t)
	cloudflare := domain.Target{AccountID: serviceAccountID, ScriptName: serviceWorkerName}
	if err := f.cache.SaveConfig(cloudflare, ConfigDTO{WorkerName: serviceWorkerName}, time.Unix(1700000000, 0).UTC()); err != nil {
		t.Fatal(err)
	}
	f.store.target = routerContainerTarget()
	f.store.ok = true

	cached, err := f.service.CachedConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cached.Data != nil {
		t.Fatalf("container target read the cloudflare cache: %#v", cached.Data)
	}
}
