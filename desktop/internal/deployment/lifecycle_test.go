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
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
)

type lifecycleFake struct {
	mu sync.Mutex

	activeVersion  string
	latestVersion  string
	deploymentID   string
	fingerprint    string
	releaseVersion string
	configJSON     []byte
	settingsJSON   []byte
	secretNames    []string
	scripts        []cloudflare.ScriptSummary
	buckets        map[string]cloudflare.R2Bucket
	subdomain      string
	schedules      []string

	uploadCalls           int
	uploadCallsForVersion int
	lastUploadPlan        cloudflare.ScriptUploadPlan
	lastUploadModules     map[string][]byte
	createBucketCalls     int
	createVersionCalls    int
	activateCalls         int
	creates               []recordedCreate
	activations           []string
	enableSubdomain       int

	createBucketErr        error
	createBucketStillWorks bool
	uploadErr              error
	uploadStillApplies     bool
	listScriptsErr         error
	createVersionErr       error
	activateErr            error
}

func newLifecycleFake() *lifecycleFake {
	return &lifecycleFake{
		activeVersion:  "version-1",
		latestVersion:  "version-1",
		deploymentID:   "deployment-1",
		fingerprint:    "fingerprint-1",
		releaseVersion: "1.0.0",
		buckets:        map[string]cloudflare.R2Bucket{},
		subdomain:      "example-sub",
	}
}

func (f *lifecycleFake) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	activeCount := 0
	if f.activeVersion != "" {
		activeCount = 1
	}
	return domain.Snapshot{
		Target:             domain.Target{AccountID: strings.Repeat("a", 32), ScriptName: "deskwand-bot"},
		DeploymentID:       f.deploymentID,
		VersionID:          f.activeVersion,
		LatestVersionID:    f.latestVersion,
		ConfigJSON:         append([]byte(nil), f.configJSON...),
		SettingsJSON:       append([]byte(nil), f.settingsJSON...),
		SecretNames:        append([]string(nil), f.secretNames...),
		Fingerprint:        f.fingerprint,
		ActiveVersionCount: activeCount,
		ReleaseVersion:     f.releaseVersion,
	}, nil
}

func (f *lifecycleFake) CreateVersion(_ context.Context, base domain.Snapshot, manifestJSON []byte, modules map[string][]byte, plan domain.PublishPlan, preserve cloudflare.PreservePolicy) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createVersionCalls++
	f.creates = append(f.creates, recordedCreate{Base: base, Plan: plan, Preserve: preserve, Modules: modules, Manifest: manifestJSON})
	if f.createVersionErr != nil {
		return "", f.createVersionErr
	}
	var manifest release.Manifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return "", err
	}
	f.configJSON = append([]byte(nil), plan.ConfigJSON...)
	f.releaseVersion = manifest.Version
	f.latestVersion = "version-staged"
	for _, edit := range plan.Secrets {
		switch edit.Operation {
		case domain.SecretReplace:
			if !contains(f.secretNames, edit.Name) {
				f.secretNames = append(f.secretNames, edit.Name)
				sort.Strings(f.secretNames)
			}
		case domain.SecretClear:
			f.secretNames = remove(f.secretNames, edit.Name)
		}
	}
	return "version-staged", nil
}

func (f *lifecycleFake) ActivateVersion(_ context.Context, _ domain.Target, versionID string) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.activateCalls++
	f.activations = append(f.activations, versionID)
	if f.activateErr != nil {
		return domain.Result{}, f.activateErr
	}
	f.activeVersion = versionID
	f.deploymentID = "deployment-" + versionID
	return domain.Result{DeploymentID: f.deploymentID, VersionID: versionID, State: "active"}, nil
}

func (f *lifecycleFake) FindVersionByOperation(context.Context, domain.Target, string) (string, bool, bool, error) {
	return "", false, false, nil
}

func (f *lifecycleFake) ListScripts(context.Context, string) ([]cloudflare.ScriptSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listScriptsErr != nil {
		return nil, f.listScriptsErr
	}
	return append([]cloudflare.ScriptSummary(nil), f.scripts...), nil
}

func (f *lifecycleFake) ListR2Buckets(context.Context, string) ([]cloudflare.R2Bucket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	buckets := make([]cloudflare.R2Bucket, 0, len(f.buckets))
	for _, bucket := range f.buckets {
		buckets = append(buckets, bucket)
	}
	return buckets, nil
}

func (f *lifecycleFake) GetR2Bucket(_ context.Context, _ string, name string) (cloudflare.R2Bucket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	bucket, ok := f.buckets[name]
	if !ok {
		return cloudflare.R2Bucket{}, cloudflare.ErrNotFound
	}
	return bucket, nil
}

func (f *lifecycleFake) CreateR2Bucket(_ context.Context, _ string, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createBucketCalls++
	if f.createBucketErr != nil {
		if f.createBucketStillWorks {
			f.buckets[name] = cloudflare.R2Bucket{Name: name}
		}
		return f.createBucketErr
	}
	if _, exists := f.buckets[name]; exists {
		return cloudflare.ErrAlreadyExists
	}
	f.buckets[name] = cloudflare.R2Bucket{Name: name}
	return nil
}

func (f *lifecycleFake) WorkersSubdomain(context.Context, string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.subdomain, nil
}

func (f *lifecycleFake) EnableWorkersDev(context.Context, domain.Target) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.enableSubdomain++
	return nil
}

func (f *lifecycleFake) UploadScript(_ context.Context, _ domain.Target, manifestJSON []byte, modules map[string][]byte, plan cloudflare.ScriptUploadPlan) (cloudflare.ScriptResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.uploadCalls++
	f.lastUploadPlan = plan
	f.lastUploadModules = modules
	if f.uploadErr != nil {
		if f.uploadStillApplies {
			f.applyScriptLocked(manifestJSON, plan)
		}
		return cloudflare.ScriptResult{}, f.uploadErr
	}
	f.applyScriptLocked(manifestJSON, plan)
	return cloudflare.ScriptResult{ScriptID: "deskwand-bot", MigrationTag: lastMigrationTag(manifestJSON)}, nil
}

func (f *lifecycleFake) applyScriptLocked(manifestJSON []byte, plan cloudflare.ScriptUploadPlan) {
	var manifest release.Manifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return
	}
	f.configJSON = append([]byte(nil), plan.ConfigJSON...)
	f.releaseVersion = manifest.Version
	tag := lastMigrationTag(manifestJSON)
	f.scripts = setScript(f.scripts, cloudflare.ScriptSummary{ID: "deskwand-bot", MigrationTag: tag})
	f.settingsJSON = f.settingsForTemplateLocked(manifest.ResourceTemplate, plan)
	f.uploadCallsForVersion++
	f.activeVersion = fmt.Sprintf("version-upload-%d", f.uploadCallsForVersion)
	f.latestVersion = f.activeVersion
	f.deploymentID = "deployment-" + f.activeVersion
}

func (f *lifecycleFake) settingsForTemplateLocked(template release.ResourceTemplate, plan cloudflare.ScriptUploadPlan) []byte {
	existing := map[string]string{}
	if bindings, err := parseSettingsBindings(f.settingsJSON); err == nil {
		for _, binding := range bindings {
			var raw struct {
				NamespaceID string `json:"namespace_id"`
			}
			_ = json.Unmarshal(binding.Raw, &raw)
			if raw.NamespaceID != "" {
				existing[binding.Name] = raw.NamespaceID
			}
		}
	}
	bindings := make([]any, 0)
	for _, binding := range template.DurableObjects {
		namespaceID := existing[binding.Name]
		if namespaceID == "" {
			namespaceID = "namespace-" + binding.ClassName
		}
		bindings = append(bindings, map[string]any{
			"type": "durable_object_namespace", "name": binding.Name, "class_name": binding.ClassName, "namespace_id": namespaceID,
		})
	}
	for _, binding := range template.R2Buckets {
		bindings = append(bindings, map[string]any{"type": "r2_bucket", "name": binding.Name, "bucket_name": plan.BucketName})
	}
	if template.VersionMetadata.Name != "" {
		bindings = append(bindings, map[string]any{"type": "version_metadata", "name": template.VersionMetadata.Name})
	}
	if len(plan.ConfigJSON) > 0 {
		var config any
		_ = json.Unmarshal(plan.ConfigJSON, &config)
		bindings = append(bindings, map[string]any{"type": "json", "name": template.ConfigBinding.Name, "json": config})
	}
	names := make([]string, 0, len(plan.PlainVars))
	for name := range plan.PlainVars {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		bindings = append(bindings, map[string]any{"type": "plain_text", "name": name, "text": plan.PlainVars[name]})
	}
	for _, name := range f.secretNames {
		bindings = append(bindings, map[string]any{"type": "secret_text", "name": name})
	}
	encoded, err := domain.CanonicalJSON(map[string]any{"bindings": bindings})
	if err != nil {
		return nil
	}
	return encoded
}

func (f *lifecycleFake) PutSchedules(_ context.Context, _ domain.Target, crons []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.schedules = append([]string(nil), crons...)
	return nil
}

func (f *lifecycleFake) GetSchedules(context.Context, domain.Target) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.schedules...), nil
}

func (f *lifecycleFake) secrets() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.secretNames...)
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func remove(values []string, unwanted string) []string {
	result := values[:0]
	for _, value := range values {
		if value != unwanted {
			result = append(result, value)
		}
	}
	return result
}

func setScript(scripts []cloudflare.ScriptSummary, script cloudflare.ScriptSummary) []cloudflare.ScriptSummary {
	for i := range scripts {
		if scripts[i].ID == script.ID {
			scripts[i] = script
			return scripts
		}
	}
	return append(scripts, script)
}

func lastMigrationTag(manifestJSON []byte) string {
	var manifest release.Manifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil || len(manifest.Migrations) == 0 {
		return ""
	}
	return manifest.Migrations[len(manifest.Migrations)-1].Tag
}

type lifecycleFixture struct {
	t   *testing.T
	API *lifecycleFake
	// uploadCallsForVersion tracks distinct fake script uploads.
	Dir       string
	Journal   *Journal
	Lifecycle *Lifecycle
	PKG       release.Package
	Logs      *bytes.Buffer
}

func (f *lifecycleFixture) target() domain.Target {
	return domain.Target{AccountID: strings.Repeat("a", 32), ScriptName: "deskwand-bot"}
}

func newLifecycleFixture(t *testing.T, pkg release.Package) *lifecycleFixture {
	t.Helper()
	dir := t.TempDir()
	journal, err := NewJournal(filepath.Join(dir, "journal"))
	if err != nil {
		t.Fatal(err)
	}
	api := newLifecycleFake()
	creds := platform.NewMemoryCredentialStore()
	logs := &bytes.Buffer{}
	f := &lifecycleFixture{t: t, API: api, Dir: journal.Dir(), Journal: journal, PKG: pkg, Logs: logs}
	f.Lifecycle = NewLifecycle(api, journal, pkg, creds, func() time.Time { return time.Unix(1700000000, 0).UTC() })
	return f
}

func lifecyclePackage(t *testing.T, version, minFrom string, irreversible []string) release.Package {
	t.Helper()
	if irreversible == nil {
		irreversible = []string{}
	}
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
			{Name: "TASK", ClassName: "TaskDO"},
			{Name: "CHANNELS", ClassName: "ChannelDO"},
		},
		R2Buckets:       []release.R2Binding{{Name: "ARTIFACTS", ParameterKey: "r2BucketName"}},
		VersionMetadata: release.BindingRef{Name: "CF_VERSION_METADATA"},
		ConfigBinding:   release.ConfigBinding{Name: "DESKWAND_CONFIG", Type: "json", SchemaVersion: 1},
		SecretNames:     []string{"ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "WECHAT_CREDENTIALS"},
		PlainVars:       []string{"ACTIVE_CHANNEL", "PUBLIC_BASE_URL"},
		Crons:           []string{"*/5 * * * *"},
		Vars:            []release.VarBinding{{Name: "PUBLIC_BASE_URL", ParameterKey: "PUBLIC_BASE_URL"}},
		Migrations: []release.Migration{
			{Tag: "v1", NewSQLiteClasses: []string{"ButlerDO", "TaskDO"}},
			{Tag: "v2", NewSQLiteClasses: []string{"ChannelDO"}},
		},
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
		Version:             version,
		Entrypoint:          "index.js",
		Files:               entries,
		CompressedSize:      10,
		ConfigSchemaVersion: 1,
		Compatibility:       template.Compatibility,
		ResourceTemplate:    template,
		Migrations:          template.Migrations,
		Upgrade:             release.Upgrade{MinFromVersion: minFrom, IrreversibleMigrations: irreversible},
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

func modelJSON(t *testing.T, id string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"provider": "opencode-go", "id": id})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func installRequest(t *testing.T) InstallRequest {
	t.Helper()
	return InstallRequest{
		AccountID:     strings.Repeat("a", 32),
		WorkerName:    "deskwand-bot",
		BucketName:    "deskwand-probe-bucket",
		Config:        InstallConfig{TelegramUserIDs: []int64{}, ButlerModel: modelJSON(t, "deepseek-v4.1-flash"), TaskModel: modelJSON(t, "kimi-k3")},
		ActiveChannel: ChannelTelegram,
	}
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got nil", code)
	}
	var domainErr domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != code {
		t.Fatalf("error = %v, want code %s", err, code)
	}
}

func assertLifecycleState(t *testing.T, result domain.Result, state string) {
	t.Helper()
	if result.OperationID == "" && state != StateNeedsInput {
		t.Fatal("operation id is empty")
	}
	if result.State != state {
		t.Fatalf("state = %q, want %q", result.State, state)
	}
}

func TestInstallCreatesResourcesAndAllowsEmptyOwner(t *testing.T) {
	f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
	result, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if f.API.createBucketCalls != 1 || f.API.uploadCalls != 1 || f.API.enableSubdomain != 1 {
		t.Fatalf("calls bucket=%d upload=%d subdomain=%d", f.API.createBucketCalls, f.API.uploadCalls, f.API.enableSubdomain)
	}
	if !reflect.DeepEqual(f.API.schedules, []string{"*/5 * * * *"}) {
		t.Fatalf("schedules = %#v", f.API.schedules)
	}
	if f.API.lastUploadPlan.PlainVars["ACTIVE_CHANNEL"] != ChannelTelegram {
		t.Fatalf("ACTIVE_CHANNEL = %q", f.API.lastUploadPlan.PlainVars["ACTIVE_CHANNEL"])
	}
	expectedURL := "https://deskwand-bot.example-sub.workers.dev"
	if f.API.lastUploadPlan.PlainVars["PUBLIC_BASE_URL"] != expectedURL {
		t.Fatalf("PUBLIC_BASE_URL = %q", f.API.lastUploadPlan.PlainVars["PUBLIC_BASE_URL"])
	}
	record, err := f.Journal.Load(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if record.PublicBaseURL != expectedURL || record.BucketName != "deskwand-probe-bucket" {
		t.Fatalf("record = %#v", record)
	}
	if !bytes.Contains(f.API.lastUploadPlan.ConfigJSON, []byte(`"telegramUserIds":[]`)) {
		t.Fatalf("empty owner was not written: %s", f.API.lastUploadPlan.ConfigJSON)
	}
}

func TestInstallRejectsNameAndBucketCollisions(t *testing.T) {
	t.Run("worker name", func(t *testing.T) {
		f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
		f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v1"}}
		_, err := f.Lifecycle.Install(context.Background(), installRequest(t))
		assertCode(t, err, CodeNameTaken)
		if f.API.createBucketCalls != 0 || f.API.uploadCalls != 0 {
			t.Fatal("collision mutated resources")
		}
	})
	t.Run("bucket name", func(t *testing.T) {
		f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
		f.API.buckets["deskwand-probe-bucket"] = cloudflare.R2Bucket{Name: "deskwand-probe-bucket"}
		_, err := f.Lifecycle.Install(context.Background(), installRequest(t))
		assertCode(t, err, CodeBucketTaken)
		if f.API.createBucketCalls != 0 || f.API.uploadCalls != 0 {
			t.Fatal("collision mutated resources")
		}
	})
}

func TestInstallResumesAfterBucketCreateResponseLost(t *testing.T) {
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
	second, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, second, StatePublished)
	if second.OperationID != first.OperationID {
		t.Fatalf("resume used a new operation: %q then %q", first.OperationID, second.OperationID)
	}
	if f.API.createBucketCalls != 1 {
		t.Fatalf("bucket was created %d times", f.API.createBucketCalls)
	}
	if f.API.uploadCalls != 1 {
		t.Fatalf("script upload calls = %d", f.API.uploadCalls)
	}
}

const lifecyclePlaintextSentinel = "mcp-inline-SECRET-sentinel-1234567890"

func lifecycleConfig(t *testing.T, mcpHeader string) []byte {
	t.Helper()
	document := map[string]any{
		"schemaVersion": 1,
		"owner":         map[string]any{"telegramUserIds": []any{}},
		"models": map[string]any{
			"butler": map[string]any{"provider": "opencode-go", "id": "deepseek-v4.1-flash"},
			"task":   map[string]any{"provider": "opencode-go", "id": "kimi-k3"},
		},
		"mcpServers": []any{},
	}
	if mcpHeader != "" {
		document["mcpServers"] = []any{map[string]any{
			"name":    "notion",
			"url":     "https://mcp.example.com",
			"headers": map[string]any{"Authorization": mcpHeader},
		}}
	}
	raw, err := domain.CanonicalJSON(document)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func lifecycleSettings(t *testing.T, template release.ResourceTemplate, configJSON []byte, activeChannel string, includeConfig bool, extra ...any) []byte {
	t.Helper()
	bindings := make([]any, 0)
	for _, binding := range template.DurableObjects {
		bindings = append(bindings, map[string]any{
			"type": "durable_object_namespace", "name": binding.Name, "class_name": binding.ClassName, "namespace_id": "namespace-" + binding.ClassName,
		})
	}
	for _, binding := range template.R2Buckets {
		bindings = append(bindings, map[string]any{"type": "r2_bucket", "name": binding.Name, "bucket_name": "deskwand-probe-bucket"})
	}
	if template.VersionMetadata.Name != "" {
		bindings = append(bindings, map[string]any{"type": "version_metadata", "name": template.VersionMetadata.Name})
	}
	if includeConfig {
		var config any
		if err := json.Unmarshal(configJSON, &config); err != nil {
			t.Fatal(err)
		}
		bindings = append(bindings, map[string]any{"type": "json", "name": template.ConfigBinding.Name, "json": config})
	}
	bindings = append(bindings,
		map[string]any{"type": "plain_text", "name": "ACTIVE_CHANNEL", "text": activeChannel},
		map[string]any{"type": "plain_text", "name": "PUBLIC_BASE_URL", "text": "https://deskwand-bot.example-sub.workers.dev"},
		map[string]any{"type": "secret_text", "name": "WECHAT_CREDENTIALS"},
	)
	bindings = append(bindings, extra...)
	raw, err := domain.CanonicalJSON(map[string]any{"bindings": bindings})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestImportLegacyRequiresOwnerAndModelsAndStartsMcpEmpty(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = nil
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, nil, ChannelWeChat, false)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	preview, err := f.Lifecycle.InspectImport(context.Background(), f.target())
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Legacy || !reflect.DeepEqual(preview.RequiredInputs, []string{"owner", "models"}) {
		t.Fatalf("preview = %#v", preview)
	}
	if !contains(preview.Warnings, "MCP 服务器将从未配置开始；已存在的 secrets 会被保留。") {
		t.Fatalf("warnings = %#v", preview.Warnings)
	}

	_, err = f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{})
	assertCode(t, err, CodeOwnerRequired)

	owner := []int64{}
	butler := modelJSON(t, "deepseek-v4.1-flash")
	task := modelJSON(t, "kimi-k3")
	result, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{
		TelegramUserIDs: &owner,
		ButlerModel:     &butler,
		TaskModel:       &task,
	})
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if f.API.createVersionCalls != 1 {
		t.Fatalf("create version calls = %d", f.API.createVersionCalls)
	}
	create := f.API.creates[0]
	if !bytes.Contains(create.Plan.ConfigJSON, []byte(`"mcpServers":[]`)) {
		t.Fatalf("legacy config did not start MCP empty: %s", create.Plan.ConfigJSON)
	}
	if !contains(create.Base.SecretNames, "WECHAT_CREDENTIALS") {
		t.Fatalf("WECHAT_CREDENTIALS was not preserved: %#v", create.Base.SecretNames)
	}
}

func TestImportRetainsWeChatCredentialsAndActiveChannel(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelWeChat, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	owner := []int64{101}
	butler := modelJSON(t, "deepseek-v4.1-flash")
	task := modelJSON(t, "kimi-k3")
	result, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{
		TelegramUserIDs: &owner,
		ButlerModel:     &butler,
		TaskModel:       &task,
	})
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	create := f.API.creates[0]
	if !contains(create.Base.SecretNames, "WECHAT_CREDENTIALS") {
		t.Fatalf("secret names = %#v", create.Base.SecretNames)
	}
	for _, edit := range create.Plan.Secrets {
		if edit.Name == "WECHAT_CREDENTIALS" {
			t.Fatal("import edited WECHAT_CREDENTIALS")
		}
	}
	if !bytes.Contains(create.Base.SettingsJSON, []byte(`"ACTIVE_CHANNEL"`)) || !bytes.Contains(create.Base.SettingsJSON, []byte(`"wechat"`)) {
		t.Fatalf("ACTIVE_CHANNEL was not preserved: %s", create.Base.SettingsJSON)
	}
	if !bytes.Contains(create.Plan.ConfigJSON, []byte(`101`)) {
		t.Fatalf("owner was not updated: %s", create.Plan.ConfigJSON)
	}
}

func TestImportWithoutModelsOrOwnerKeepsExistingConfig(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	config, err := domain.CanonicalJSON(map[string]any{
		"schemaVersion": 1,
		"owner":         map[string]any{"telegramUserIds": []any{101}},
		"models": map[string]any{
			"butler": map[string]any{"provider": "opencode-go", "id": "deepseek-v4.1-flash"},
			"task":   map[string]any{"provider": "opencode-go", "id": "kimi-k3"},
		},
		"mcpServers": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.API.configJSON = config
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, config, ChannelWeChat, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	result, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{})
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	create := f.API.creates[0]
	for _, want := range []string{`"telegramUserIds":[101]`, `"deepseek-v4.1-flash"`, `"kimi-k3"`} {
		if !bytes.Contains(create.Plan.ConfigJSON, []byte(want)) {
			t.Fatalf("config lost %s: %s", want, create.Plan.ConfigJSON)
		}
	}
	if bytes.Contains(create.Plan.ConfigJSON, []byte("workers-ai")) {
		t.Fatalf("config was overwritten with the default model: %s", create.Plan.ConfigJSON)
	}
}

func TestImportRefusesUnknownForkBindings(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelWeChat, true,
		map[string]any{"type": "durable_object_namespace", "name": "EXTRA", "class_name": "ExtraDO", "namespace_id": "namespace-extra"})
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}

	_, err := f.Lifecycle.InspectImport(context.Background(), f.target())
	assertCode(t, err, domain.UNSUPPORTED_BINDING)
	if f.API.createVersionCalls != 0 || f.API.uploadCalls != 0 {
		t.Fatal("fork inspection mutated remote")
	}
}

func TestImportMigratesInlineCredentialToSecretReference(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "Bearer "+lifecyclePlaintextSentinel)
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	preview, err := f.Lifecycle.InspectImport(context.Background(), f.target())
	assertCode(t, err, CodePlaintextSecretDetected)
	if len(preview.PlaintextSecrets) != 1 {
		t.Fatalf("preview = %#v", preview)
	}
	migration := preview.PlaintextSecrets[0]
	if migration.SecretName == "" || !strings.HasPrefix(migration.Reference, "env:") || migration.Path != "/mcpServers/0/headers/Authorization" {
		t.Fatalf("migration = %#v", migration)
	}
	encoded, _ := json.Marshal(preview)
	if bytes.Contains(encoded, []byte(lifecyclePlaintextSentinel)) {
		t.Fatal("preview leaked the inline value")
	}

	_, err = f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{SecretValues: map[string]string{}})
	assertCode(t, err, CodePlaintextSecretDetected)
	if f.API.createVersionCalls != 0 {
		t.Fatal("missing migrated secret still published")
	}

	owner := []int64{}
	result, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{
		TelegramUserIDs: &owner,
		SecretValues:    map[string]string{migration.SecretName: lifecyclePlaintextSentinel},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	create := f.API.creates[0]
	if !bytes.Contains(create.Plan.ConfigJSON, []byte(`env:`+migration.SecretName)) {
		t.Fatalf("config did not reference the secret: %s", create.Plan.ConfigJSON)
	}
	if bytes.Contains(create.Plan.ConfigJSON, []byte(lifecyclePlaintextSentinel)) {
		t.Fatal("plaintext credential remained in DESKWAND_CONFIG")
	}
	if len(create.Plan.Secrets) != 1 || create.Plan.Secrets[0].Name != migration.SecretName || create.Plan.Secrets[0].Value() != lifecyclePlaintextSentinel {
		t.Fatalf("secret edits = %v", create.Plan.Secrets)
	}
	assertNoFileContains(t, f.Dir, lifecyclePlaintextSentinel)
	if bytes.Contains(f.Logs.Bytes(), []byte(lifecyclePlaintextSentinel)) {
		t.Fatal("log output contains the migrated secret")
	}
}

func TestUpgradePreservesResourceIdentity(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelWeChat, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.releaseVersion = "1.0.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}
	before, err := resourceIdentity(f.API.settingsJSON)
	if err != nil {
		t.Fatal(err)
	}

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if f.API.createVersionCalls != 1 || f.API.uploadCalls != 0 {
		t.Fatalf("versioned path calls create=%d upload=%d", f.API.createVersionCalls, f.API.uploadCalls)
	}
	after, err := resourceIdentity(f.API.settingsJSON)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("resource identity changed: before=%#v after=%#v", before, after)
	}
	if !contains(f.API.secrets(), "WECHAT_CREDENTIALS") {
		t.Fatalf("secrets = %#v", f.API.secrets())
	}
}

func TestUpgradeDoesNotRequireModelKeys(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelWeChat, true)
	f.API.secretNames = []string{"OPENCODE_API_KEY"}
	f.API.releaseVersion = "1.0.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatalf("Upgrade() = %v, want nil", err)
	}
	assertLifecycleState(t, result, StatePublished)
	if f.API.createVersionCalls != 1 || f.API.uploadCalls != 0 {
		t.Fatalf("create=%d upload=%d", f.API.createVersionCalls, f.API.uploadCalls)
	}
}

func TestUpgradeUsesScriptUploadForNewMigrations(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "0.9.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	// The 0.9.0 deployment only had the v1 Durable Objects.
	v1Only := pkg.Manifest().ResourceTemplate
	v1Only.DurableObjects = v1Only.DurableObjects[:2]
	f.API.settingsJSON = lifecycleSettings(t, v1Only, f.API.configJSON, ChannelTelegram, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.releaseVersion = "0.9.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v1"}}
	before, err := resourceIdentity(f.API.settingsJSON)
	if err != nil {
		t.Fatal(err)
	}

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if f.API.uploadCalls != 1 || f.API.createVersionCalls != 0 {
		t.Fatalf("script path calls upload=%d create=%d", f.API.uploadCalls, f.API.createVersionCalls)
	}
	if f.API.lastUploadPlan.BaseTag != "v1" {
		t.Fatalf("base tag = %q", f.API.lastUploadPlan.BaseTag)
	}
	if !reflect.DeepEqual(f.API.lastUploadPlan.ConfigJSON, f.API.configJSON) {
		t.Fatal("upgrade rewrote the configuration")
	}
	if f.API.lastUploadPlan.PlainVars["ACTIVE_CHANNEL"] != ChannelTelegram {
		t.Fatalf("ACTIVE_CHANNEL = %q", f.API.lastUploadPlan.PlainVars["ACTIVE_CHANNEL"])
	}
	after, err := resourceIdentity(f.API.settingsJSON)
	if err != nil {
		t.Fatal(err)
	}
	if !before.equal(after) {
		t.Fatalf("resource identity changed: before=%#v after=%#v", before, after)
	}
	if !contains(f.API.secrets(), "WECHAT_CREDENTIALS") {
		t.Fatalf("secrets = %#v", f.API.secrets())
	}
}

func TestUpgradeRejectsMigrationHistoryMismatch(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v9"}}

	_, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	assertCode(t, err, CodeMigrationHistoryMismatch)
	if f.API.uploadCalls != 0 || f.API.createVersionCalls != 0 {
		t.Fatal("mismatch mutated remote")
	}
}

func TestUpgradeRejectsVersionBelowMinFrom(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.1", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.releaseVersion = "0.9.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	assertCode(t, err, CodeUpgradeRequiresIntermediate)
	if result.State != StateFailed {
		t.Fatalf("state = %q, want %q", result.State, StateFailed)
	}
	if f.API.uploadCalls != 0 || f.API.createVersionCalls != 0 {
		t.Fatal("a blocked upgrade mutated the remote deployment")
	}
}

// A points release must stay upgradeable from the release it follows: the
// signed floor is the previous release (0.1.0), not some larger version.
func TestUpgradeAcceptsPointsRelease(t *testing.T) {
	pkg := lifecyclePackage(t, "0.1.1", "0.1.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.releaseVersion = "0.1.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatalf("Upgrade() = %v, want nil", err)
	}
	assertLifecycleState(t, result, StatePublished)
}

func TestUpgradeRejectsDowngrade(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.releaseVersion = "2.0.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	_, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	assertCode(t, err, CodeDowngradeRejected)
	if f.API.uploadCalls != 0 || f.API.createVersionCalls != 0 {
		t.Fatal("downgrade mutated remote")
	}
}

func TestUpgradeUnknownVersionNeedsInput(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.releaseVersion = ""
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	assertCode(t, err, CodeVersionUnknownReimport)
	assertLifecycleState(t, result, StateNeedsInput)
}

func TestUpgradeRejectsIrreversibleMigration(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "0.9.0", []string{"v2"})
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	v1Only := pkg.Manifest().ResourceTemplate
	v1Only.DurableObjects = v1Only.DurableObjects[:2]
	f.API.settingsJSON = lifecycleSettings(t, v1Only, f.API.configJSON, ChannelTelegram, true)
	f.API.releaseVersion = "0.9.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v1"}}

	_, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	assertCode(t, err, CodeIrreversibleMigration)
	if f.API.uploadCalls != 0 {
		t.Fatal("irreversible migration was applied")
	}
}

func assertNoFileContains(t *testing.T, dir, sentinel string) {
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
		if bytes.Contains(data, []byte(sentinel)) {
			t.Fatalf("file %s contains the sentinel", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestImportRefusesWhenMigrationsArePending(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "0.9.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.releaseVersion = "0.9.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v1"}}

	owner := []int64{}
	_, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{TelegramUserIDs: &owner})
	assertCode(t, err, CodeUpgradeRequiredFirst)
	if !strings.Contains(err.Error(), "先导入当前版本再升级") {
		t.Fatalf("error = %v", err)
	}
	if f.API.createVersionCalls != 0 || f.API.uploadCalls != 0 {
		t.Fatal("blocked import still mutated remote")
	}

	// Upgrade is the next safe step and carries the already-present config.
	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if f.API.uploadCalls != 1 || f.API.createVersionCalls != 0 {
		t.Fatalf("upload=%d create=%d", f.API.uploadCalls, f.API.createVersionCalls)
	}
}

func TestUpgradeAfterSuccessfulImportPublishes(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelWeChat, true)
	f.API.secretNames = []string{"WECHAT_CREDENTIALS"}
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	owner := []int64{42}
	if _, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{TelegramUserIDs: &owner}); err != nil {
		t.Fatal(err)
	}
	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if f.API.createVersionCalls != 2 || f.API.uploadCalls != 0 {
		t.Fatalf("create=%d upload=%d", f.API.createVersionCalls, f.API.uploadCalls)
	}
}

func TestImportWarnsAboutNonHeaderAndMCPURLCredentials(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	config := map[string]any{
		"schemaVersion": 1,
		"owner":         map[string]any{"telegramUserIds": []any{}},
		"models": map[string]any{
			"butler": map[string]any{"provider": "opencode-go", "id": "deepseek-v4.1-flash"},
			"task":   map[string]any{"provider": "opencode-go", "id": "kimi-k3"},
		},
		"advanced": map[string]any{"apiKey": "short-value"},
		"mcpServers": []any{map[string]any{
			"name": "notion",
			"url":  "https://user:pass@mcp.example.com/v1?token=abc",
			"args": []any{"--api-key", "abc"},
		}},
	}
	raw, err := domain.CanonicalJSON(config)
	if err != nil {
		t.Fatal(err)
	}
	f.API.configJSON = raw
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, raw, ChannelTelegram, true)
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	preview, err := f.Lifecycle.InspectImport(context.Background(), f.target())
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.PlaintextSecrets) != 0 {
		t.Fatalf("non-header credentials were migrated: %#v", preview.PlaintextSecrets)
	}
	joined := strings.Join(preview.Warnings, "\n")
	for _, marker := range []string{"字段 /advanced/apiKey", "URL", "args"} {
		if !strings.Contains(joined, marker) {
			t.Fatalf("warnings missing %q: %s", marker, joined)
		}
	}
}

func TestUpgradeRejectsPrereleaseDowngrade(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0-beta", "0.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.releaseVersion = "1.0.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	_, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	assertCode(t, err, CodeDowngradeRejected)
}

func TestUpgradeIdentityUnverifiableWithoutNamespaceID(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	config := lifecycleConfig(t, "")
	bindings := []any{
		map[string]any{"type": "durable_object_namespace", "name": "BUTLER", "class_name": "ButlerDO"},
		map[string]any{"type": "durable_object_namespace", "name": "TASK", "class_name": "TaskDO"},
		map[string]any{"type": "durable_object_namespace", "name": "CHANNELS", "class_name": "ChannelDO"},
		map[string]any{"type": "r2_bucket", "name": "ARTIFACTS", "bucket_name": "deskwand-probe-bucket"},
		map[string]any{"type": "version_metadata", "name": "CF_VERSION_METADATA"},
	}
	var configValue any
	if err := json.Unmarshal(config, &configValue); err != nil {
		t.Fatal(err)
	}
	bindings = append(bindings, map[string]any{"type": "json", "name": "DESKWAND_CONFIG", "json": configValue})
	settings, err := domain.CanonicalJSON(map[string]any{"bindings": bindings})
	if err != nil {
		t.Fatal(err)
	}
	f.API.configJSON = config
	f.API.settingsJSON = settings
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v2"}}

	_, err = f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	assertCode(t, err, CodeIdentityUnverifiable)
	if f.API.createVersionCalls != 0 || f.API.uploadCalls != 0 {
		t.Fatal("unverifiable identity still mutated remote")
	}
}

func TestInstallAbandonAllowsACorrectedRetry(t *testing.T) {
	f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
	f.API.buckets["deskwand-probe-bucket"] = cloudflare.R2Bucket{Name: "deskwand-probe-bucket"}

	first, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err == nil {
		t.Fatal("bucket collision returned success")
	}
	assertLifecycleState(t, first, StateFailed)

	abandoned, err := f.Lifecycle.Abandon(context.Background(), first.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, abandoned, StateCancelled)

	delete(f.API.buckets, "deskwand-probe-bucket")
	second, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, second, StatePublished)
	if second.OperationID == first.OperationID {
		t.Fatal("corrected retry reused the cancelled operation")
	}
}

func TestInstallClearsAttemptOnDefinitiveCreateRejection(t *testing.T) {
	f := newLifecycleFixture(t, lifecyclePackage(t, "1.0.0", "1.0.0", nil))
	f.API.createBucketErr = &cloudflare.APIError{Status: 400, Code: 10000, Message: "invalid bucket request"}

	first, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err == nil {
		t.Fatal("definitive rejection returned success")
	}
	assertLifecycleState(t, first, StateFailed)
	record, err := f.Journal.Load(first.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if record.BucketCreateAttempted {
		t.Fatal("definitive 4xx left the create-attempted flag set")
	}

	f.API.createBucketErr = nil
	second, err := f.Lifecycle.Install(context.Background(), installRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, second, StatePublished)
	if second.OperationID == first.OperationID {
		t.Fatal("retry after a definitive rejection reused the failed operation")
	}
}

func TestUpgradeScriptPathRestoresDriftedSchedules(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "0.9.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	v1Only := pkg.Manifest().ResourceTemplate
	v1Only.DurableObjects = v1Only.DurableObjects[:2]
	f.API.settingsJSON = lifecycleSettings(t, v1Only, f.API.configJSON, ChannelTelegram, true)
	f.API.releaseVersion = "0.9.0"
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v1"}}
	f.API.schedules = []string{"0 * * * *"}

	result, err := f.Lifecycle.Upgrade(context.Background(), f.target(), pkg)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, result, StatePublished)
	if !reflect.DeepEqual(f.API.schedules, pkg.Manifest().ResourceTemplate.Crons) {
		t.Fatalf("schedules = %#v", f.API.schedules)
	}
}

func TestConfirmImportRejectsMigrationHistoryFork(t *testing.T) {
	pkg := lifecyclePackage(t, "1.0.0", "1.0.0", nil)
	f := newLifecycleFixture(t, pkg)
	f.API.configJSON = lifecycleConfig(t, "")
	f.API.settingsJSON = lifecycleSettings(t, pkg.Manifest().ResourceTemplate, f.API.configJSON, ChannelTelegram, true)
	f.API.scripts = []cloudflare.ScriptSummary{{ID: "deskwand-bot", MigrationTag: "v9"}}

	owner := []int64{}
	_, err := f.Lifecycle.ConfirmImport(context.Background(), f.target(), ImportConfirmation{TelegramUserIDs: &owner})
	assertCode(t, err, CodeMigrationHistoryMismatch)
	if f.API.createVersionCalls != 0 || f.API.uploadCalls != 0 {
		t.Fatal("forked import still mutated remote")
	}
}
