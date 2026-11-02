package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/deployment"
)

type fakeClientUpdates struct {
	configured   bool
	current      string
	checkInfo    ClientUpdateInfo
	checkErr     error
	installErr   error
	checkCalls   int
	installCalls int
	installed    []ClientUpdateInfo
}

func (f *fakeClientUpdates) Configured() bool { return f.configured }

func (f *fakeClientUpdates) CurrentVersion() string { return f.current }

func (f *fakeClientUpdates) Check(context.Context) (ClientUpdateInfo, error) {
	f.checkCalls++
	return f.checkInfo, f.checkErr
}

func (f *fakeClientUpdates) Install(_ context.Context, update ClientUpdateInfo) error {
	f.installCalls++
	f.installed = append(f.installed, update)
	return f.installErr
}

func useClientUpdates(f *serviceFixture, provider ClientUpdateProvider) {
	f.service.clientUpdates = provider
}

func TestClientUpdateDisabledWhenFeedUnconfigured(t *testing.T) {
	f := newServiceFixture(t)
	provider := &fakeClientUpdates{configured: false, current: "0.1.0"}
	useClientUpdates(f, provider)

	got, err := f.service.CheckClientUpdate()
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "not_configured" || got.Message != "未配置更新源" {
		t.Fatalf("update = %#v", got)
	}
	if got.CurrentVersion != "0.1.0" {
		t.Fatalf("current version = %q", got.CurrentVersion)
	}
	if provider.checkCalls != 0 {
		t.Fatalf("unconfigured updater made %d feed requests", provider.checkCalls)
	}
}

func TestClientUpdateCheckRejectsInvalidFeedSignature(t *testing.T) {
	f := newServiceFixture(t)
	useClientUpdates(f, &fakeClientUpdates{
		configured: true,
		current:    "0.1.0",
		checkErr:   fmt.Errorf("%w: detached signature", ErrClientUpdateSignature),
	})

	_, err := f.service.CheckClientUpdate()
	if !hasCode(err, CodeClientUpdateSignatureError) {
		t.Fatalf("error = %v, want %s", err, CodeClientUpdateSignatureError)
	}
}

func TestClientUpdateInstallRejectsInvalidSignature(t *testing.T) {
	f := newServiceFixture(t)
	provider := &fakeClientUpdates{
		configured: true,
		current:    "0.1.0",
		checkInfo:  ClientUpdateInfo{Version: "0.2.0"},
		installErr: fmt.Errorf("%w: archive digest", ErrClientUpdateSignature),
	}
	useClientUpdates(f, provider)

	check, err := f.service.CheckClientUpdate()
	if err != nil || check.State != "available" {
		t.Fatalf("check = %#v, %v", check, err)
	}
	result, err := f.service.InstallClientUpdate()
	if !hasCode(err, CodeClientUpdateSignatureError) {
		t.Fatalf("error = %v, want %s", err, CodeClientUpdateSignatureError)
	}
	if result.State != "failed" || result.Version != "0.2.0" {
		t.Fatalf("result = %#v", result)
	}
	if provider.installCalls != 1 {
		t.Fatalf("install calls = %d", provider.installCalls)
	}
}

func TestClientUpdateRejectsDowngrade(t *testing.T) {
	f := newServiceFixture(t)
	provider := &fakeClientUpdates{
		configured: true,
		current:    "2.0.0",
		checkInfo:  ClientUpdateInfo{Version: "1.9.0"},
	}
	useClientUpdates(f, provider)

	_, err := f.service.CheckClientUpdate()
	if !hasCode(err, CodeClientUpdateDowngrade) {
		t.Fatalf("error = %v, want %s", err, CodeClientUpdateDowngrade)
	}
	if _, ok := f.service.takeCheckedClientUpdate(); ok {
		t.Fatal("downgraded update was retained for installation")
	}
}

func TestClientUpdateUpToDate(t *testing.T) {
	f := newServiceFixture(t)
	useClientUpdates(f, &fakeClientUpdates{
		configured: true,
		current:    "2.0.0",
		checkInfo:  ClientUpdateInfo{Version: "2.0.0"},
	})

	got, err := f.service.CheckClientUpdate()
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "up_to_date" || got.AvailableVersion != "" {
		t.Fatalf("update = %#v", got)
	}
}

func TestInstallClientUpdateRequiresCheck(t *testing.T) {
	f := newServiceFixture(t)
	useClientUpdates(f, &fakeClientUpdates{configured: true, current: "0.1.0"})

	result, err := f.service.InstallClientUpdate()
	if !hasCode(err, CodeClientUpdateNotChecked) {
		t.Fatalf("error = %v, want %s", err, CodeClientUpdateNotChecked)
	}
	if result.State != "not_checked" {
		t.Fatalf("result = %#v", result)
	}
}

func TestClientAndCloudVersionsAreIndependent(t *testing.T) {
	f := newServiceFixture(t)
	provider := &fakeClientUpdates{
		configured: true,
		current:    "0.1.0",
		checkInfo: ClientUpdateInfo{
			Version: "0.2.0",
			Notes:   "client notes",
			Date:    "2026-11-02T09:00:00Z",
		},
	}
	useClientUpdates(f, provider)

	client, err := f.service.CheckClientUpdate()
	if err != nil {
		t.Fatal(err)
	}
	if client.State != "available" || client.CurrentVersion != "0.1.0" ||
		client.AvailableVersion != "0.2.0" {
		t.Fatalf("client update = %#v", client)
	}

	cloud, err := f.service.UpgradeAvailable()
	if err != nil {
		t.Fatal(err)
	}
	if !cloud.Available || cloud.CurrentVersion != "1.0.0" || cloud.AvailableVersion != "2.0.0" {
		t.Fatalf("cloud upgrade = %#v", cloud)
	}

	installBefore := provider.installCalls
	publishChanges := len(f.publish.changes)
	lifecycleUpgrades := f.lifecycle.upgradeCalled
	result, err := f.service.InstallClientUpdate()
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "installed" || result.Version != "0.2.0" {
		t.Fatalf("install result = %#v", result)
	}
	if provider.installCalls != installBefore+1 {
		t.Fatalf("client install count = %d", provider.installCalls)
	}
	if len(f.publish.changes) != publishChanges || f.lifecycle.upgradeCalled != lifecycleUpgrades {
		t.Fatal("installing a client update touched the cloud deployment")
	}
}

func TestMyGoClientUpdateProviderHasNoFeedByDefault(t *testing.T) {
	if strings.TrimSpace(ClientUpdateFeedURL) != "" {
		t.Fatalf("ClientUpdateFeedURL = %q, want empty by default", ClientUpdateFeedURL)
	}
	provider := NewMyGoClientUpdateProvider("")
	if provider.Configured() {
		t.Fatal("provider with an empty feed is configured")
	}
	if _, err := provider.Check(context.Background()); !errors.Is(err, ErrClientUpdateNotConfigured) {
		t.Fatalf("error = %v, want ErrClientUpdateNotConfigured", err)
	}
}

func TestClientUpdateVersionComparisonUsesDeploymentSemver(t *testing.T) {
	if comparison, ok := deployment.CompareVersions("0.10.0", "0.9.0"); !ok || comparison <= 0 {
		t.Fatalf("CompareVersions = %d, %v", comparison, ok)
	}
}
