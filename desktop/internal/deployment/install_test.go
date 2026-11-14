package deployment

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestInstallConfigJSONCarriesLocale(t *testing.T) {
	f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
	f.Lifecycle.Locale = func() string { return "en" }
	result, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if !bytes.Contains(f.API.lastUploadPlan.ConfigJSON, []byte(`"locale":"en"`)) {
		t.Fatalf("installed config has no locale: %s", f.API.lastUploadPlan.ConfigJSON)
	}
}

func TestInstallResumeIgnoresLocaleChange(t *testing.T) {
	f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
	f.API.createBucketErr = errors.New("network lost after create")
	f.API.createBucketStillWorks = true

	first, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err == nil {
		t.Fatal("lost bucket response returned success")
	}
	assertLifecycleState(t, first, StateUnknown)

	f.API.createBucketErr = nil
	f.API.createBucketStillWorks = false
	f.Lifecycle.Locale = func() string { return "en" }

	second, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatalf("resuming after a locale change failed: %v", err)
	}
	assertLifecycleState(t, second, StatePublished)
	if second.OperationID != first.OperationID {
		t.Fatalf("resume used a new operation: %q then %q", first.OperationID, second.OperationID)
	}
}

func TestInstallConfigJSONOmitsLocaleWithoutHook(t *testing.T) {
	f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
	result, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if bytes.Contains(f.API.lastUploadPlan.ConfigJSON, []byte(`"locale"`)) {
		t.Fatalf("installed config has a locale without a hook: %s", f.API.lastUploadPlan.ConfigJSON)
	}
}

func TestInstallConfigJSONOmitsOwnerWhenTheListIsEmpty(t *testing.T) {
	request := installRequest(t)
	request.Config.TelegramUserIDs = nil
	raw, err := installConfigJSON(request, "")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`"owner"`)) {
		t.Fatalf("config must not carry an owner key: %s", raw)
	}
}

func TestInstallConfigJSONCarriesOwnerWhenProvided(t *testing.T) {
	request := installRequest(t)
	request.Config.TelegramUserIDs = []int64{7}
	raw, err := installConfigJSON(request, "")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"telegramUserIds":[7]`)) {
		t.Fatalf("owner missing from config: %s", raw)
	}
}
