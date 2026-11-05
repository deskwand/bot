package deployment

import (
	"bytes"
	"context"
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
