package app

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/telemetry"
)

// fakeReporter records what the service reported.
type fakeReporter struct {
	features []string
	configs  int
	pings    int
	// dropConfigDone makes the reporter swallow the report, as a dropped or
	// rejected send does.
	dropConfigDone bool
}

func (f *fakeReporter) Ping() { f.pings++ }

func (f *fakeReporter) Feature(name string) { f.features = append(f.features, name) }

func (f *fakeReporter) ConfigDone(onSent func()) {
	f.configs++
	if !f.dropConfigDone && onSent != nil {
		onSent()
	}
}

// fakeTelemetryStore is the switch and the one-shot facts, in memory.
type fakeTelemetryStore struct {
	state   TelemetryState
	saveErr error
	version string
}

func (f *fakeTelemetryStore) Telemetry() (TelemetryState, error) {
	if f.saveErr != nil {
		return TelemetryState{}, f.saveErr
	}
	return f.state, nil
}

func (f *fakeTelemetryStore) Enabled() bool { return f.state.Enabled }

func (f *fakeTelemetryStore) DeviceID() (string, error) { return f.state.DeviceID, f.saveErr }

func (f *fakeTelemetryStore) SetTelemetryEnabled(enabled bool) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.state.Enabled = enabled
	return nil
}

func (f *fakeTelemetryStore) MarkConfigDone() (bool, error) {
	if f.saveErr != nil {
		return false, f.saveErr
	}
	if f.state.ConfigDone {
		return false, nil
	}
	f.state.ConfigDone = true
	return true, nil
}

func (f *fakeTelemetryStore) RecordVersion(version string) error {
	f.version = version
	return nil
}

func TestConfigReadyNeedsOwnerModelsAndAConfiguredChannel(t *testing.T) {
	ready := ConfigDTO{
		OwnerUserIDs:  []int64{42},
		ButlerModel:   &ModelDTO{Provider: "workers-ai", ID: "gemma"},
		TaskModel:     &ModelDTO{Provider: "workers-ai", ID: "gemma"},
		ActiveChannel: "telegram",
		Secrets:       []SecretNameDTO{{Name: "TELEGRAM_BOT_TOKEN", Configured: true}},
	}
	if !configReady(ready) {
		t.Fatal("a fully configured deployment was not ready")
	}

	noOwner := ready
	noOwner.OwnerUserIDs = nil
	if configReady(noOwner) {
		t.Fatal("a deployment without an owner was ready")
	}

	noTask := ready
	noTask.TaskModel = nil
	if configReady(noTask) {
		t.Fatal("a deployment without a task model was ready")
	}

	noChannel := ready
	noChannel.ActiveChannel = ""
	if configReady(noChannel) {
		t.Fatal("a deployment without an active channel was ready")
	}

	unconfigured := ready
	unconfigured.Secrets = []SecretNameDTO{{Name: "TELEGRAM_BOT_TOKEN", Configured: false}}
	if configReady(unconfigured) {
		t.Fatal("a channel without credentials was ready")
	}

	otherSecret := ready
	otherSecret.ActiveChannel = "wechat"
	if configReady(otherSecret) {
		t.Fatal("a wechat deployment with only a telegram token was ready")
	}
}

func TestReportFeatureIgnoresFailuresAndNonPublishedStates(t *testing.T) {
	reporter := &fakeReporter{}
	service := NewService(ServiceOptions{Telemetry: reporter})

	service.reportFeature(telemetry.FeatureUpgrade, deployment.StateFailed, nil)
	service.reportFeature(telemetry.FeatureUpgrade, deployment.StatePublished, errors.New("boom"))
	service.reportAction(telemetry.FeatureBackup, errors.New("boom"))

	if len(reporter.features) != 0 {
		t.Fatalf("reported %v", reporter.features)
	}

	service.reportFeature(telemetry.FeatureUpgrade, deployment.StatePublished, nil)
	service.reportAction(telemetry.FeatureBackup, nil)

	if len(reporter.features) != 2 || reporter.features[0] != telemetry.FeatureUpgrade || reporter.features[1] != telemetry.FeatureBackup {
		t.Fatalf("features = %v", reporter.features)
	}
}

func TestServiceReportsInstallOnlyWhenPublished(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.service = f.buildService()

	// A failed result is reported through the summary's state, not an error.
	f.lifecycle.installResult = domain.Result{OperationID: "op-install-failed", State: deployment.StateFailed}
	if _, err := f.service.Install(installInput()); err != nil {
		t.Fatal(err)
	}
	if len(f.telemetry.features) != 0 {
		t.Fatalf("a failed install reported %v", f.telemetry.features)
	}

	f.lifecycle.installResult = domain.Result{OperationID: "op-install-ok", State: deployment.StatePublished}
	if _, err := f.service.Install(installInput()); err != nil {
		t.Fatal(err)
	}
	if len(f.telemetry.features) != 1 || f.telemetry.features[0] != telemetry.FeatureInstall {
		t.Fatalf("features = %v", f.telemetry.features)
	}
}

func TestServiceReportsConfigDoneOnce(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{}
	f.service = f.buildService()
	// The fixture's snapshot already has an owner, both role models and
	// ACTIVE_CHANNEL=wechat; adding the wechat credentials completes setup.
	f.snapshots.snapshot.SecretNames = []string{"ANTHROPIC_API_KEY", "WECHAT_CREDENTIALS"}

	f.service.reportFeature(telemetry.FeaturePublish, deployment.StatePublished, nil)
	f.service.reportFeature(telemetry.FeaturePublish, deployment.StatePublished, nil)

	if f.telemetry.configs != 1 {
		t.Fatalf("config_done reported %d times; want once", f.telemetry.configs)
	}
}

func TestServiceReportsNoConfigDoneWithoutChannelCredentials(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{}
	f.service = f.buildService()

	// The fixture's snapshot has ACTIVE_CHANNEL=wechat but no WECHAT_CREDENTIALS.
	f.service.reportFeature(telemetry.FeaturePublish, deployment.StatePublished, nil)

	if f.telemetry.configs != 0 {
		t.Fatalf("config_done reported %d times without channel credentials", f.telemetry.configs)
	}
}

func TestServiceTelemetrySwitch(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{state: TelemetryState{Enabled: true}}
	f.service = f.buildService()

	if !f.service.TelemetryEnabled() {
		t.Fatal("a fresh install reported disabled")
	}
	if err := f.service.SetTelemetryEnabled(false); err != nil {
		t.Fatal(err)
	}
	if f.service.TelemetryEnabled() {
		t.Fatal("the switch did not persist")
	}
	if err := f.service.SetTelemetryEnabled(true); err != nil {
		t.Fatal(err)
	}
	if f.telemetry.pings != 1 {
		t.Fatalf("turning telemetry on sent %d pings; want one", f.telemetry.pings)
	}
}

func TestSetTelemetryEnabledReportsAFailedSave(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{saveErr: errors.New("read-only home")}
	f.service = f.buildService()

	err := f.service.SetTelemetryEnabled(false)
	var appErr domain.Error
	if !errors.As(err, &appErr) || appErr.Code != CodeTelemetrySaveFailed {
		t.Fatalf("err = %v; want %s", err, CodeTelemetrySaveFailed)
	}
}

// installInput is the smallest input Install accepts from a connected account.
func installInput() InstallInputDTO {
	return InstallInputDTO{
		AccountID:     serviceAccountID,
		WorkerName:    "worker",
		BucketName:    "bucket",
		ButlerModel:   ModelDTO{Provider: "workers-ai", ID: "gemma"},
		TaskModel:     ModelDTO{Provider: "workers-ai", ID: "gemma"},
		ActiveChannel: "telegram",
	}
}

func TestReportConfigDoneSkipsTheReadOnceRecorded(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{state: TelemetryState{Enabled: true, ConfigDone: true}}
	f.service = f.buildService()
	before := f.snapshots.calls

	f.service.reportFeature(telemetry.FeaturePublish, deployment.StatePublished, nil)

	if f.snapshots.calls != before {
		t.Fatalf("a recorded installation still read the deployment %d times", f.snapshots.calls-before)
	}
	if f.telemetry.configs != 0 {
		t.Fatalf("config_done reported %d times after it was recorded", f.telemetry.configs)
	}
}

func TestServiceReportsConfigDoneAfterInstallSelectsTheTarget(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{state: TelemetryState{Enabled: true}}
	// A first install has no selected deployment yet: the target is only known
	// once Install saves it.
	f.store = &fakeStore{}
	f.snapshots.snapshot.SecretNames = []string{"ANTHROPIC_API_KEY", "WECHAT_CREDENTIALS"}
	f.service = f.buildService()
	f.lifecycle.installResult = domain.Result{OperationID: "op-install-ok", State: deployment.StatePublished}

	if _, err := f.service.Install(installInput()); err != nil {
		t.Fatal(err)
	}
	if f.telemetry.configs != 1 {
		t.Fatalf("config_done reported %d times; want one", f.telemetry.configs)
	}
}

func TestServiceReportsConfigDoneAfterSelectEntry(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{state: TelemetryState{Enabled: true}}
	f.snapshots.snapshot.SecretNames = []string{"ANTHROPIC_API_KEY", "WECHAT_CREDENTIALS"}
	f.entries.selectResult = EntrySelection{
		Result:     domain.Result{State: deployment.StatePublished},
		Channel:    EntryWeChat,
		Configured: true,
	}
	f.service = f.buildService()

	if _, err := f.service.SelectEntry("wechat"); err != nil {
		t.Fatal(err)
	}
	if f.telemetry.configs != 1 {
		t.Fatalf("config_done reported %d times after choosing the channel; want one", f.telemetry.configs)
	}
}

func TestOnlyAddingAnMcpServerReportsMcp(t *testing.T) {
	existing := `[
		{"name":"github","url":"https://api.githubcopilot.com/mcp/"},
		{"name":"deepwiki","url":"https://mcp.deepwiki.com/mcp/"}
	]`
	f := newMcpFixture(t, existing, []string{"ADMIN_TOKEN"}, nil)
	f.telemetry = &fakeReporter{}
	f.telemetrySettings = &fakeTelemetryStore{state: TelemetryState{Enabled: true}}
	f.service = f.buildService()

	if _, err := f.service.UpdateMcpServer(
		"deepwiki",
		json.RawMessage(`{"name":"deepwiki","url":"https://mcp.deepwiki.com/mcp/","autoApprove":["read_wiki"]}`),
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if countFeature(f.telemetry.features, telemetry.FeatureMcp) != 0 {
		t.Fatalf("editing a server reported mcp: %v", f.telemetry.features)
	}

	if _, err := f.service.AddMcpServer(McpAddInput{
		Name:   "custom",
		Custom: &McpCustomInput{URL: "https://custom.example/mcp"},
	}); err != nil {
		t.Fatal(err)
	}
	if countFeature(f.telemetry.features, telemetry.FeatureMcp) != 1 {
		t.Fatalf("adding a server reported %v", f.telemetry.features)
	}
}

func countFeature(features []string, name string) int {
	count := 0
	for _, feature := range features {
		if feature == name {
			count++
		}
	}
	return count
}

func TestConfigDoneIsNotRecordedWhenTheSendIsDropped(t *testing.T) {
	f := newServiceFixture(t)
	f.telemetry = &fakeReporter{dropConfigDone: true}
	f.telemetrySettings = &fakeTelemetryStore{state: TelemetryState{Enabled: true}}
	f.snapshots.snapshot.SecretNames = []string{"ANTHROPIC_API_KEY", "WECHAT_CREDENTIALS"}
	f.service = f.buildService()

	f.service.reportFeature(telemetry.FeaturePublish, deployment.StatePublished, nil)

	if f.telemetrySettings.state.ConfigDone {
		t.Fatal("a dropped report still recorded config_done")
	}
	// The next successful publish can still report it.
	f.telemetry.dropConfigDone = false
	f.service.reportFeature(telemetry.FeaturePublish, deployment.StatePublished, nil)
	if !f.telemetrySettings.state.ConfigDone || f.telemetry.configs != 2 {
		t.Fatalf("retry = %d reports, recorded %v", f.telemetry.configs, f.telemetrySettings.state.ConfigDone)
	}
}
