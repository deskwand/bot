package probe

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	apiBase      = "https://api.cloudflare.com/client/v4"
	probePrefix  = "deskwand-probe-"
	probeTimeout = 3 * time.Minute
	probePoll    = time.Second
	probeWait    = 45 * time.Second
)

var (
	keepSecret    = "DESKWAND_PROBE_KEEP"
	keep2Secret   = "DESKWAND_PROBE_KEEP2"
	replaceSecret = "DESKWAND_PROBE_REPLACE"
	clearSecret   = "DESKWAND_PROBE_CLEAR"
)

// TestLivePublishSemantics exercises the documented Workers versions,
// deployments and secrets workflow against a dedicated Cloudflare test
// account. It is opt-in; a skip is not evidence that the semantics work.
//
// Required environment:
//
//	DESKWAND_CF_LIVE_TEST=1
//	DESKWAND_CF_TEST_ACCOUNT=<32 character account id>
//	DESKWAND_CF_TEST_TOKEN=<token for that account only>
//
// The test creates and always deletes a disposable Worker whose name starts
// with deskwand-probe-. Secret values are sentinel strings, never logged,
// and asserted absent from read-back responses. The probe Worker returns only
// SHA-256 digests of its secret bindings plus whether CLEAR is defined, so a
// replaced value can be distinguished from a retained one without returning
// plaintext.
func TestLivePublishSemantics(t *testing.T) {
	if liveTestDisabled(t) {
		return
	}

	account := strings.TrimSpace(os.Getenv("DESKWAND_CF_TEST_ACCOUNT"))
	token := os.Getenv("DESKWAND_CF_TEST_TOKEN")
	if account == "" || token == "" {
		t.Fatal("DESKWAND_CF_TEST_ACCOUNT and DESKWAND_CF_TEST_TOKEN are required when DESKWAND_CF_LIVE_TEST=1")
	}

	name := newProbeName(t)
	if err := checkProbeName(name); err != nil {
		t.Fatalf("generated probe name rejected: %v", err)
	}

	client := &cfClient{
		account: account,
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		if err := client.deleteScript(cleanupCtx, name); err != nil {
			t.Errorf("cleanup: delete %s: %v", name, err)
			return
		}
		t.Logf("cleanup: deleted %s", name)
	})

	// 1. Create the disposable Worker and deploy its first version. Workers.dev
	// serves the latest deployment, which is how this test observes the
	// bindings that are actually active.
	scriptMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "DESKWAND_PROBE_MARKER", "text": "deskwand-probe"},
		},
	}
	data := client.uploadScript(t, ctx, name, scriptMetadata, probeModule("initial"))
	var initial struct {
		ID string `json:"id"`
	}
	client.decodeResult(t, data, &initial)
	t.Logf("created %s (initial version %q)", name, initial.ID)

	accountSubdomain := client.accountSubdomain(t, ctx)
	client.enableSubdomain(t, ctx, name)
	probeURL := fmt.Sprintf("https://%s.%s.workers.dev/", name, accountSubdomain)
	t.Logf("enabled workers.dev route %s", probeURL)

	// 2. Set three sentinel secrets with the bulk endpoint and read back the
	// names. The explicit baseline version below carries the same values as
	// secret bindings, so the deployed baseline is deterministic.
	secretValues := map[string]string{
		keepSecret:    "keep-" + randomSuffix(t),
		replaceSecret: "replace-old-" + randomSuffix(t),
		clearSecret:   "clear-" + randomSuffix(t),
	}
	client.addRedactions(secretValues)
	client.patchSecrets(t, ctx, name, map[string]any{
		keepSecret:    secretText(keepSecret, secretValues[keepSecret]),
		replaceSecret: secretText(replaceSecret, secretValues[replaceSecret]),
		clearSecret:   secretText(clearSecret, secretValues[clearSecret]),
	})
	assertSecretNames(t, client.secretNames(t, ctx, name), map[string]bool{
		keepSecret: true, replaceSecret: true, clearSecret: true,
	})

	// 2b. Deploy an explicit baseline version that carries all three secret
	// bindings, so the baseline observation does not depend on whether the
	// bulk-secret call itself deployed a version.
	baselineMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings": []any{
			secretText(keepSecret, secretValues[keepSecret]),
			secretText(replaceSecret, secretValues[replaceSecret]),
			secretText(clearSecret, secretValues[clearSecret]),
		},
		"annotations": map[string]any{
			"workers/message": "deskwand probe: baseline secrets",
		},
	}
	data = client.createVersion(t, ctx, name, baselineMetadata, probeModule("baseline"))
	var baseline struct {
		ID string `json:"id"`
	}
	client.decodeResult(t, data, &baseline)
	if baseline.ID == "" {
		t.Fatal("baseline version upload returned no version id")
	}
	t.Logf("created baseline version %s", baseline.ID)
	client.deployVersion(t, ctx, name, baseline.ID)
	client.waitForActiveVersion(t, ctx, name, baseline.ID)
	client.waitForProbe(t, ctx, probeURL, probeExpect{
		Revision:     "baseline",
		Keep:         sha256Hex(secretValues[keepSecret]),
		Replace:      sha256Hex(secretValues[replaceSecret]),
		ClearDefined: true,
	})

	// 3. Upload a version that inherits KEEP, replaces REPLACE and omits CLEAR.
	// bindings_inherit=strict makes an unresolvable inherit a failure rather
	// than a silently dropped binding. The test deliberately uses the default
	// inherit target ("latest") and passes no explicit version_id.
	newReplaceValue := "replace-new-" + randomSuffix(t)
	client.addRedactions(map[string]string{replaceSecret: newReplaceValue})
	versionMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings": []any{
			map[string]any{"type": "inherit", "name": keepSecret},
			secretText(replaceSecret, newReplaceValue),
		},
		"annotations": map[string]any{
			"workers/message": "deskwand probe: keep/replace/clear",
		},
	}
	data = client.createVersion(t, ctx, name, versionMetadata, probeModule("new"))
	var version struct {
		ID string `json:"id"`
	}
	client.decodeResult(t, data, &version)
	if version.ID == "" {
		t.Fatal("version upload returned no version id")
	}
	t.Logf("created version %s", version.ID)

	// 4. Deploy the new version to 100% of traffic and observe it over
	// workers.dev. KEEP must still hash to the original sentinel, REPLACE must
	// hash to the new sentinel, and CLEAR must be undefined in the Worker env.
	client.deployVersion(t, ctx, name, version.ID)
	client.waitForActiveVersion(t, ctx, name, version.ID)
	client.waitForProbe(t, ctx, probeURL, probeExpect{
		Revision:     "new",
		Keep:         sha256Hex(secretValues[keepSecret]),
		Replace:      sha256Hex(newReplaceValue),
		ClearDefined: false,
	})

	// 5. Read back secret names and assert no sentinel value came back.
	secretsBody := client.secretNamesRaw(t, ctx, name)
	names := client.parseSecretNames(t, secretsBody)
	assertSecretNames(t, names, map[string]bool{keepSecret: true, replaceSecret: true})
	if hasName(names, clearSecret) {
		t.Errorf("cleared secret %s is still present; version-upload omission did not clear it", clearSecret)
	}
	for secretName, value := range secretValues {
		if bytes.Contains(secretsBody, []byte(value)) {
			t.Errorf("secret value for %s was returned by the secrets API", secretName)
		}
	}
	if bytes.Contains(secretsBody, []byte(newReplaceValue)) {
		t.Errorf("new replace value was returned by the secrets API")
	}
	t.Logf("read back secret names: KEEP present, REPLACE present, CLEAR absent")

	// 6. Read the version's bindings as a second source for the same claim.
	bindings := client.versionBindings(t, ctx, name, version.ID)
	if len(bindings) == 0 {
		t.Fatal("version read returned no bindings")
	}
	for secretName, want := range map[string]bool{keepSecret: true, replaceSecret: true, clearSecret: false} {
		got := bytes.Contains(bindings, []byte(`"`+secretName+`"`))
		if got != want {
			t.Errorf("version bindings contain %s = %v, want %v", secretName, got, want)
		}
	}
}

// TestLiveInheritExplicitVersion asks the question the previous live probe
// left open: can a version-upload `inherit` binding name an explicit older
// version id instead of "latest"?
//
//	POST /accounts/{account_id}/workers/scripts/{script_name}/versions
//
// Source for the Inherit object (fields: name, type, old_name, version_id)
// and the `bindings_inherit=strict` query parameter:
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
//
// The reference says version_id "can be a version ID, or the literal 'latest'
// ... Only the Workers API version endpoints under
// /accounts/{account_id}/workers/workers/{worker_id}/versions accept a version
// ID. Other endpoints, including script upload and script version upload,
// accept only 'latest' and reject a version ID with error 10057."
//
// This test does not assume either branch. It records REJECTED or ACCEPTED and,
// when accepted, whether KEEP resolves to V1 or to the latest upload (V2).
// Only harness failures (network, guard, cleanup) fail the test.
func TestLiveInheritExplicitVersion(t *testing.T) {
	if liveTestDisabled(t) {
		return
	}
	account, token := liveAccount(t)

	name := newProbeName(t)
	if err := checkProbeName(name); err != nil {
		t.Fatalf("generated probe name rejected: %v", err)
	}

	client := &cfClient{
		account: account,
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		if err := client.deleteScript(cleanupCtx, name); err != nil {
			t.Errorf("cleanup: delete %s: %v", name, err)
			return
		}
		t.Logf("cleanup: deleted %s", name)
	})

	initialMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "DESKWAND_PROBE_MARKER", "text": "deskwand-probe"},
		},
	}
	client.uploadScript(t, ctx, name, initialMetadata, probeModule("initial"))

	accountSubdomain := client.accountSubdomain(t, ctx)
	client.enableSubdomain(t, ctx, name)
	probeURL := fmt.Sprintf("https://%s.%s.workers.dev/", name, accountSubdomain)
	t.Logf("enabled workers.dev route %s", probeURL)

	v1Value := "keep-v1-" + randomSuffix(t)
	v2Value := "keep-v2-" + randomSuffix(t)
	client.addRedactions(map[string]string{"v1": v1Value, "v2": v2Value})

	v1ID := client.createAndDeployVersion(t, ctx, name,
		probeVersionMetadata("deskwand probe: inherit V1", []any{secretText(keepSecret, v1Value)}),
		probeModule("v1"))
	client.waitForKeep(t, ctx, probeURL, "v1", sha256Hex(v1Value))

	v2ID := client.createAndDeployVersion(t, ctx, name,
		probeVersionMetadata("deskwand probe: inherit V2", []any{secretText(keepSecret, v2Value)}),
		probeModule("v2"))
	client.waitForKeep(t, ctx, probeURL, "v2", sha256Hex(v2Value))
	t.Logf("baseline versions: V1=%s (KEEP=s1), V2=%s (KEEP=s2)", v1ID, v2ID)

	// Deliberate use of the documented `version_id` field on the Inherit
	// object. If Cloudflare accepts it, KEEP tells us which version resolved.
	explicitMetadata := probeVersionMetadata("deskwand probe: inherit explicit V1", []any{
		map[string]any{
			"type":       "inherit",
			"name":       keepSecret,
			"version_id": v1ID,
		},
	})
	outcome := client.createVersionOutcome(t, ctx, name, explicitMetadata, probeModule("v3-explicit"))
	if !outcome.Accepted {
		code := 0
		if len(outcome.Codes) > 0 {
			code = outcome.Codes[0]
		}
		t.Logf("explicit-version upload response: %s", client.safeBody(outcome.Body))
		t.Logf("RESULT explicit-version inherit: REJECTED code=%d message=%s",
			code, client.safeBody([]byte(outcome.message())))
		return
	}
	t.Logf("explicit-version inherit was accepted as version %q", outcome.ID)
	if outcome.ID == "" {
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=UNKNOWN (upload returned no version id)")
		return
	}

	deploy := client.createDeploymentOutcome(t, ctx, name, outcome.ID)
	if !deploy.Accepted {
		t.Logf("deployment of accepted version failed: %s", client.safeBody([]byte(deploy.errorSummary())))
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=UNKNOWN (deployment failed)")
		return
	}
	if _, ok := client.waitForActiveVersionBestEffort(t, ctx, name, outcome.ID, probeWait); !ok {
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=UNKNOWN (version never became active)")
		return
	}

	got, ok := client.waitForRevisionBestEffort(t, ctx, probeURL, "v3-explicit", probeWait)
	if !ok {
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=UNKNOWN (revision not observed)")
		return
	}
	switch {
	case got.Keep == nil:
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=NONE")
	case *got.Keep == sha256Hex(v1Value):
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=V1")
	case *got.Keep == sha256Hex(v2Value):
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=V2")
	default:
		t.Logf("RESULT explicit-version inherit: ACCEPTED keep=UNKNOWN")
	}
}

// TestLiveDurableObjectMigrationPaths asks whether version upload can apply a
// Durable Object migration and whether a script upload can.
//
// Script upload metadata source (`migrations` is a SingleStepMigration with
// new_tag, old_tag, new_sqlite_classes, ...):
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
//
// Version upload metadata source (main_module, annotations, bindings and seven
// more fields; no migrations attribute):
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
//
// Cloudflare documents that version upload cannot apply DO lifecycle changes:
// https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#durable-object-migrations
// and lists `migrations` only under "immediately deployed uploads":
// https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
//
// This test still sends migrations on the version endpoint so the run records
// what the API actually does. Only harness failures and broken counter
// persistence in steps 1 and 4 fail the test.
func TestLiveDurableObjectMigrationPaths(t *testing.T) {
	if liveTestDisabled(t) {
		return
	}
	account, token := liveAccount(t)

	name := newProbeName(t)
	if err := checkProbeName(name); err != nil {
		t.Fatalf("generated probe name rejected: %v", err)
	}

	client := &cfClient{
		account: account,
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		if err := client.deleteScript(cleanupCtx, name); err != nil {
			t.Errorf("cleanup: delete %s: %v", name, err)
			return
		}
		t.Logf("cleanup: deleted %s", name)
	})

	// 1. Immediate script upload: creates the Worker, the SQLite-backed DO
	// namespace and the v1 migration in one deploy.
	v1Metadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "DESKWAND_PROBE_MARKER", "text": "deskwand-probe"},
			durableNamespaceBinding("COUNTER", "ProbeCounter"),
		},
		"migrations": map[string]any{
			"new_tag":            "v1",
			"new_sqlite_classes": []any{"ProbeCounter"},
		},
		"annotations": map[string]any{"workers/message": "deskwand probe: DO migration v1"},
	}
	client.uploadScript(t, ctx, name, v1Metadata, durableProbeModule("v1", false))

	accountSubdomain := client.accountSubdomain(t, ctx)
	client.enableSubdomain(t, ctx, name)
	probeURL := fmt.Sprintf("https://%s.%s.workers.dev/", name, accountSubdomain)
	t.Logf("enabled workers.dev route %s", probeURL)

	client.waitForRevision(t, ctx, probeURL, "v1")
	client.mustCounter(t, ctx, probeURL+"do", 1)
	client.mustCounter(t, ctx, probeURL+"do", 2)

	// 2. The List Worker Scripts result field `migration_tag` exposes the most
	// recently applied DO migration tag:
	// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/
	tagV1 := client.migrationTag(t, ctx, name)
	t.Logf("migration tag after v1 script upload: %q", tagV1)
	if tagV1 != "v1" {
		t.Logf("WARNING: expected migration tag %q, got %q", "v1", tagV1)
	}

	v2Bindings := []any{
		durableNamespaceBinding("COUNTER", "ProbeCounter"),
		durableNamespaceBinding("COUNTER2", "ProbeCounter2"),
	}
	v2Migrations := map[string]any{
		"old_tag":            "v1",
		"new_tag":            "v2",
		"new_sqlite_classes": []any{"ProbeCounter2"},
	}

	// 3. Same v2 migration through the versions endpoint. `migrations` is not
	// in the documented version-upload metadata, but sending it is the only
	// way to observe whether the service ignores, rejects or applies it.
	versionMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings":           v2Bindings,
		"migrations":         v2Migrations,
		"annotations":        map[string]any{"workers/message": "deskwand probe: DO migration v2 via version upload"},
	}
	versionOutcome := client.createVersionOutcome(t, ctx, name, versionMetadata, durableProbeModule("v2-version", true))

	versionResult := "REJECTED"
	tagAfterVersion := tagV1
	if versionOutcome.Accepted {
		versionResult = "ACCEPTED_NOT_APPLIED"
		t.Logf("version upload with migrations was accepted as version %q", versionOutcome.ID)
		do2OK := false
		deploy := client.createDeploymentOutcome(t, ctx, name, versionOutcome.ID)
		if !deploy.Accepted {
			t.Logf("deployment of accepted version failed: %s", client.safeBody([]byte(deploy.errorSummary())))
		} else if _, ok := client.waitForActiveVersionBestEffort(t, ctx, name, versionOutcome.ID, probeWait); !ok {
			t.Logf("accepted version never became active")
		} else {
			_, revisionOK := client.waitForRevisionBestEffort(t, ctx, probeURL, "v2-version", probeWait)
			if !revisionOK {
				t.Logf("/do2 not attempted: revision v2-version was not served")
			} else {
				counter, detail := client.fetchCounter(ctx, probeURL+"do2")
				if detail != "" {
					t.Logf("/do2 failed: %s", detail)
				} else if counter.Count == nil {
					t.Logf("/do2 response had no count: class=%q", counter.ClassName)
				} else {
					t.Logf("/do2 returned count=%d class=%q", *counter.Count, counter.ClassName)
					do2OK = true
				}
			}
		}

		// Read the tag after the deploy attempt, matching the documented order:
		// deploy, observe /do2, then inspect the applied migration tag.
		tagAfterVersion = client.migrationTag(t, ctx, name)
		t.Logf("migration tag after the version-upload deploy attempt: %q", tagAfterVersion)
		if do2OK && tagAfterVersion == "v2" {
			versionResult = "ACCEPTED_APPLIED"
		}
	} else {
		t.Logf("version upload response: %s", client.safeBody(versionOutcome.Body))
	}
	t.Logf("RESULT version-upload migrations: %s", versionResult)

	// 4. Apply/confirm the same migration through an immediate script upload.
	// If the version endpoint unexpectedly already recorded v2, the script
	// upload cannot repeat it; redeploy the code without a migration step and
	// record APPLIED only if the tag stays at v2 and the DO data survives.
	tagBeforeScriptUpload := client.migrationTag(t, ctx, name)
	scriptMigrations := map[string]any{
		"old_tag":            tagBeforeScriptUpload,
		"new_tag":            "v2",
		"new_sqlite_classes": []any{"ProbeCounter2"},
	}
	if tagBeforeScriptUpload == "" {
		// We know step 1 applied v1; fall back to the documented expected tag
		// when the list read could not find this script.
		scriptMigrations["old_tag"] = "v1"
	}
	if tagBeforeScriptUpload == "v2" {
		t.Logf("v2 migration is already recorded; script upload will redeploy without a migration step")
		scriptMigrations = nil
	}

	scriptMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings":           v2Bindings,
		"annotations":        map[string]any{"workers/message": "deskwand probe: DO migration v2 via script upload"},
	}
	if scriptMigrations != nil {
		scriptMetadata["migrations"] = scriptMigrations
	}

	scriptOutcome := client.uploadScriptOutcome(t, ctx, name, scriptMetadata, durableProbeModule("v2-script", true))
	if !scriptOutcome.Accepted {
		t.Logf("script upload response: %s", client.safeBody(scriptOutcome.Body))
		t.Logf("RESULT script-upload migrations: FAILED")
		// The previous deployment should still serve /do. This is the step 4
		// persistence assertion required by the probe contract.
		client.mustCounter(t, ctx, probeURL+"do", 3)
		return
	}

	if _, ok := client.waitForRevisionBestEffort(t, ctx, probeURL, "v2-script", probeWait); !ok {
		t.Fatalf("script upload was accepted but workers.dev never served revision %q", "v2-script")
	}
	tagAfterScript := client.migrationTag(t, ctx, name)
	t.Logf("migration tag after v2 script upload (read after the new revision was live): %q", tagAfterScript)
	// The counter was 2 before this upload. Exactly one /do call must return 3,
	// proving the DO namespace and its SQLite storage survived the migration.
	client.mustCounter(t, ctx, probeURL+"do", 3)
	if tagAfterScript == "v2" {
		t.Logf("RESULT script-upload migrations: APPLIED")
	} else {
		t.Logf("RESULT script-upload migrations: FAILED")
	}
}

// TestLiveScriptUploadSecretPreservation asks how the non-versioned script
// upload (PUT .../scripts/{name}), which is required for Durable Object
// migrations, treats existing secrets.
//
// Sources:
//   - Upload Worker Module API reference. `keep_bindings` is documented there
//     as "List of binding types to keep from previous_upload". The same page
//     documents the Inherit binding object fields (`name`, `type`, `old_name`,
//     `version_id`) and the `bindings_inherit=strict` query parameter:
//     https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
//   - `inherit` resolves only from the latest uploaded version on script
//     uploads. An explicit version id is rejected with error 10057; without
//     `bindings_inherit=strict`, an unresolvable inherit is silently dropped.
//     (Same Upload Worker Module page.)
//   - Multipart upload metadata for binding shapes and the immediate-deploy
//     `migrations` attribute:
//     https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
//
// `keep_bindings` appears in the Upload Worker Module API schema; it is not
// listed on the multipart-upload-metadata page.
//
// Outcomes are recorded, not asserted. Only harness failures and broken DO
// counter persistence fail the test.
func TestLiveScriptUploadSecretPreservation(t *testing.T) {
	if liveTestDisabled(t) {
		return
	}
	account, token := liveAccount(t)

	name := newProbeName(t)
	if err := checkProbeName(name); err != nil {
		t.Fatalf("generated probe name rejected: %v", err)
	}

	client := &cfClient{
		account: account,
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		if err := client.deleteScript(cleanupCtx, name); err != nil {
			t.Errorf("cleanup: delete %s: %v", name, err)
			return
		}
		t.Logf("cleanup: deleted %s", name)
	})

	// 1. Create the Worker with ProbeCounter and migration v1.
	initialMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings": append(doBindingsForClasses([]string{"ProbeCounter"}),
			map[string]any{"type": "plain_text", "name": "DESKWAND_PROBE_MARKER", "text": "deskwand-probe"},
		),
		"migrations": map[string]any{
			"new_tag":            "v1",
			"new_sqlite_classes": []string{"ProbeCounter"},
		},
		"annotations": map[string]any{"workers/message": "deskwand probe: script-upload secret baseline"},
	}
	client.uploadScript(t, ctx, name, initialMetadata, durableProbeModule("initial", false))

	accountSubdomain := client.accountSubdomain(t, ctx)
	client.enableSubdomain(t, ctx, name)
	probeURL := fmt.Sprintf("https://%s.%s.workers.dev/", name, accountSubdomain)
	t.Logf("enabled workers.dev route %s", probeURL)

	keepValue := "keep-" + randomSuffix(t)
	keep2Value := "keep2-" + randomSuffix(t)
	client.addRedactions(map[string]string{keepSecret: keepValue, keep2Secret: keep2Value})
	client.patchSecrets(t, ctx, name, map[string]any{
		keepSecret:  secretText(keepSecret, keepValue),
		keep2Secret: secretText(keep2Secret, keep2Value),
	})

	// Deploy a known baseline through the script upload so the next upload's
	// "previous_upload" is also a script upload. Both secrets are explicit in
	// this baseline; the bulk-secret call above registers the same values.
	baselineMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings": append(doBindingsForClasses([]string{"ProbeCounter"}),
			secretText(keepSecret, keepValue),
			secretText(keep2Secret, keep2Value),
		),
		"annotations": map[string]any{"workers/message": "deskwand probe: script-upload secret baseline"},
	}
	client.uploadScript(t, ctx, name, baselineMetadata, durableProbeModule("baseline", false))
	baseline := client.waitForRevision(t, ctx, probeURL, "baseline")
	if !hasSecretHashes(baseline, keepValue, keep2Value) {
		t.Fatalf("baseline / did not report both KEEP and KEEP2 hashes: %s", baseline)
	}
	client.mustCounter(t, ctx, probeURL+"do", 1)
	expectedCounter := 1

	// The initial PUT applied v1. Keep the expected tag locally; the list
	// read is observational only because it can lag the upload.
	appliedTag := "v1"
	if tag := client.migrationTag(t, ctx, name); tag != "" && tag != appliedTag {
		t.Logf("WARNING: expected migration tag %q after baseline, list returned %q", appliedTag, tag)
	} else {
		t.Logf("migration tag after baseline script upload: %q", tag)
	}

	// Variant A: keep_bindings=["secret_text"], migration v1->v2, and no
	// secret bindings listed. Both KEEP and KEEP2 are checked because
	// keep_bindings is a binding-type keep, not a per-name keep.
	variantAMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"keep_bindings":      []string{"secret_text"},
		"bindings":           doBindingsForClasses([]string{"ProbeCounter", "ProbeCounter2"}),
		"migrations": map[string]any{
			"old_tag":            appliedTag,
			"new_tag":            "v2",
			"new_sqlite_classes": []string{"ProbeCounter2"},
		},
		"annotations": map[string]any{"workers/message": "deskwand probe: keep_bindings secret_text"},
	}
	outcomeA := client.uploadScriptOutcome(t, ctx, name, variantAMetadata,
		durableProbeModuleWithClasses("script-keep-bindings", "ProbeCounter", "ProbeCounter2"))
	if outcomeA.Accepted {
		got := client.waitForRevision(t, ctx, probeURL, "script-keep-bindings")
		t.Logf("keep_bindings / response: %s", got)
		if hasSecretHashes(got, keepValue, keep2Value) {
			t.Logf("RESULT script-upload keep_bindings: KEPT")
		} else {
			t.Logf("RESULT script-upload keep_bindings: LOST")
		}
		expectedCounter++
		client.mustCounter(t, ctx, probeURL+"do", expectedCounter)
		appliedTag = "v2"
		if tag := client.migrationTag(t, ctx, name); tag != "" && tag != appliedTag {
			t.Logf("WARNING: expected migration tag %q after keep_bindings upload, list returned %q", appliedTag, tag)
		} else {
			t.Logf("migration tag after keep_bindings upload: %q", tag)
		}
	} else {
		t.Logf("RESULT script-upload keep_bindings: REJECTED code=%d message=%s",
			outcomeA.firstCode(), client.safeBody([]byte(outcomeA.message())))
	}

	// Variant B: no keep_bindings, inherit KEEP only, and migration v2->v3.
	// If variant A was rejected, create the missing classes in this step so
	// the test can still reach variant C; the applied tag is recorded below.
	currentClasses := doClassesForTag(appliedTag)
	newClasses := missingDOClasses(currentClasses, []string{"ProbeCounter2", "ProbeCounter3"})
	classesAfterB := append(append([]string{}, currentClasses...), newClasses...)
	if appliedTag != "v2" {
		t.Logf("NOTE: applied tag before inherit upload is %q, not v2; missing classes are created together", appliedTag)
	}
	inheritBindings := append(doBindingsForClasses(classesAfterB),
		map[string]any{"type": "inherit", "name": keepSecret},
	)
	variantBMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings":           inheritBindings,
		"annotations":        map[string]any{"workers/message": "deskwand probe: script upload inherit KEEP"},
	}
	if len(newClasses) > 0 {
		variantBMetadata["migrations"] = map[string]any{
			"old_tag":            appliedTag,
			"new_tag":            "v3",
			"new_sqlite_classes": newClasses,
		}
	} else {
		t.Logf("no missing DO classes for v3; inherit upload carries no migration")
	}
	outcomeB := client.uploadScriptOutcomeStrict(t, ctx, name, variantBMetadata,
		durableProbeModuleWithClasses("script-inherit-keep", classesAfterB...))
	if outcomeB.Accepted {
		got := client.waitForRevision(t, ctx, probeURL, "script-inherit-keep")
		t.Logf("inherit / response: %s", got)
		keepState := "LOST"
		if got.Keep != nil && *got.Keep == sha256Hex(keepValue) {
			keepState = "KEPT"
		}
		keep2State := "ABSENT"
		if got.Keep2 != nil {
			keep2State = "PRESENT"
			if *got.Keep2 != sha256Hex(keep2Value) {
				t.Logf("WARNING: KEEP2 is present but its hash changed")
			}
		}
		t.Logf("RESULT script-upload inherit: ACCEPTED keep=%s keep2=%s", keepState, keep2State)
		expectedCounter++
		client.mustCounter(t, ctx, probeURL+"do", expectedCounter)
		if len(newClasses) > 0 {
			appliedTag = "v3"
		}
		if tag := client.migrationTag(t, ctx, name); tag != "" && tag != appliedTag {
			t.Logf("WARNING: expected migration tag %q after inherit upload, list returned %q", appliedTag, tag)
		} else {
			t.Logf("migration tag after inherit upload: %q", tag)
		}
	} else {
		t.Logf("RESULT script-upload inherit: REJECTED code=%d message=%s",
			outcomeB.firstCode(), client.safeBody([]byte(outcomeB.message())))
	}

	// Variant C: a plain script upload with no keep_bindings and no secret
	// bindings at all. DO bindings are still present so /do remains testable.
	plainClasses := doClassesForTag(appliedTag)
	variantCMetadata := map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings":           doBindingsForClasses(plainClasses),
		"annotations":        map[string]any{"workers/message": "deskwand probe: plain script upload"},
	}
	outcomeC := client.uploadScriptOutcome(t, ctx, name, variantCMetadata,
		durableProbeModuleWithClasses("script-plain", plainClasses...))
	if outcomeC.Accepted {
		got := client.waitForRevision(t, ctx, probeURL, "script-plain")
		t.Logf("plain / response: %s", got)
		if hasSecretHashes(got, keepValue, keep2Value) {
			t.Logf("RESULT script-upload plain: KEPT")
		} else {
			t.Logf("RESULT script-upload plain: LOST")
		}
		expectedCounter++
		client.mustCounter(t, ctx, probeURL+"do", expectedCounter)
	} else {
		t.Logf("RESULT script-upload plain: REJECTED code=%d message=%s",
			outcomeC.firstCode(), client.safeBody([]byte(outcomeC.message())))
	}
}

func liveAccount(t *testing.T) (string, string) {
	t.Helper()
	account := strings.TrimSpace(os.Getenv("DESKWAND_CF_TEST_ACCOUNT"))
	token := os.Getenv("DESKWAND_CF_TEST_TOKEN")
	if account == "" || token == "" {
		t.Fatal("DESKWAND_CF_TEST_ACCOUNT and DESKWAND_CF_TEST_TOKEN are required when DESKWAND_CF_LIVE_TEST=1")
	}
	return account, token
}

func liveTestDisabled(t *testing.T) bool {
	t.Helper()
	if os.Getenv("DESKWAND_CF_LIVE_TEST") != "1" {
		t.Skip("dedicated account opt-in required: set DESKWAND_CF_LIVE_TEST=1, DESKWAND_CF_TEST_ACCOUNT and DESKWAND_CF_TEST_TOKEN")
		return true
	}
	return false
}

func newProbeName(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("random probe name: %v", err)
	}
	return fmt.Sprintf("%s%d-%s", probePrefix, time.Now().Unix(), hex.EncodeToString(b[:]))
}

// checkProbeName refuses any target that could touch a real deployment.
func checkProbeName(name string) error {
	if !strings.HasPrefix(name, probePrefix) {
		return fmt.Errorf("script name %q does not start with %q", name, probePrefix)
	}
	if len(name) > 63 {
		return fmt.Errorf("script name %q is longer than 63 characters", name)
	}
	if trimmed := strings.Trim(name, "abcdefghijklmnopqrstuvwxyz0123456789-"); trimmed != "" {
		return fmt.Errorf("script name %q contains characters outside a-z, 0-9 and '-'", name)
	}
	if strings.HasSuffix(name, "-") {
		return fmt.Errorf("script name %q ends with '-'", name)
	}
	return nil
}

// probeModule returns a Worker that reports only SHA-256 digests of the
// secret bindings and whether CLEAR exists. It never returns a secret value.
func probeModule(revision string) string {
	return `export default {
  async fetch(_request, env) {
    const encoder = new TextEncoder();
    const sha256 = async (value) => {
      if (value === undefined || value === null) return null;
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    };
    const body = {
      revision: "` + revision + `",
      keep: await sha256(env.DESKWAND_PROBE_KEEP),
      replace: await sha256(env.DESKWAND_PROBE_REPLACE),
      clearDefined:
        env.DESKWAND_PROBE_CLEAR !== undefined && env.DESKWAND_PROBE_CLEAR !== null,
    };
    return new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  },
};
`
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// durableNamespaceBinding uses the documented DO binding fields `type`,
// `name` and `class_name`:
// https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
func durableNamespaceBinding(name, className string) map[string]any {
	return map[string]any{
		"type":       "durable_object_namespace",
		"name":       name,
		"class_name": className,
	}
}

// durableProbeModule is a minimal SQLite-backed Durable Object Worker with
// ProbeCounter plus, optionally, ProbeCounter2.
//
//   - `/` returns SHA-256 digests for KEEP, KEEP2 and REPLACE plus whether
//     CLEAR is defined.
//   - `/do` increments ProbeCounter's SQLite counter and returns its value.
//   - `/do2` does the same for ProbeCounter2.
//
// The DO classes are exported so `new_sqlite_classes` can provision SQLite
// namespaces for them. `ctx.storage.sql` is the documented SQLite storage API.
func durableProbeModule(revision string, includeSecondClass bool) string {
	classes := []string{"ProbeCounter"}
	if includeSecondClass {
		classes = append(classes, "ProbeCounter2")
	}
	return durableProbeModuleWithClasses(revision, classes...)
}

// durableProbeModuleWithClasses is durableProbeModule generalized to any
// number of extra DO classes. ProbeCounter is always defined; names in classes
// other than ProbeCounter are appended in order and deduplicated.
func durableProbeModuleWithClasses(revision string, classes ...string) string {
	var extraClasses strings.Builder
	seen := map[string]bool{"ProbeCounter": true}
	for _, className := range classes {
		if seen[className] {
			continue
		}
		seen[className] = true
		fmt.Fprintf(&extraClasses, `
export class %s {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(_request) {
    return incrementCounter(this.ctx, %q);
  }
}
`, className, className)
	}
	return `const respond = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

async function incrementCounter(ctx, className) {
  const sql = ctx.storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)"
  );
  const rows = sql.exec("SELECT value FROM counter WHERE id = 1").toArray();
  const next = (rows.length > 0 ? Number(rows[0].value) : 0) + 1;
  if (rows.length > 0) {
    sql.exec("UPDATE counter SET value = ? WHERE id = 1", next);
  } else {
    sql.exec("INSERT INTO counter (id, value) VALUES (1, ?)", next);
  }
  return respond({ className, count: next });
}

export class ProbeCounter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(_request) {
    return incrementCounter(this.ctx, "ProbeCounter");
  }
}
` + extraClasses.String() + `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/do") {
      const id = env.COUNTER.idFromName("deskwand-probe-do");
      return env.COUNTER.get(id).fetch(request);
    }
    if (url.pathname === "/do2") {
      if (!env.COUNTER2) {
        return respond({ error: "COUNTER2 binding is missing" }, 500);
      }
      const id = env.COUNTER2.idFromName("deskwand-probe-do2");
      return env.COUNTER2.get(id).fetch(request);
    }
    const encoder = new TextEncoder();
    const sha256 = async (value) => {
      if (value === undefined || value === null) return null;
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    };
    return respond({
      revision: "` + revision + `",
      keep: await sha256(env.DESKWAND_PROBE_KEEP),
      keep2: await sha256(env.DESKWAND_PROBE_KEEP2),
      replace: await sha256(env.DESKWAND_PROBE_REPLACE),
      clearDefined:
        env.DESKWAND_PROBE_CLEAR !== undefined && env.DESKWAND_PROBE_CLEAR !== null,
    });
  },
};
`
}

var doBindingNames = map[string]string{
	"ProbeCounter":  "COUNTER",
	"ProbeCounter2": "COUNTER2",
	"ProbeCounter3": "COUNTER3",
}

func doBindingsForClasses(classes []string) []any {
	bindings := make([]any, 0, len(classes))
	for _, className := range classes {
		bindingName, ok := doBindingNames[className]
		if !ok {
			bindingName = "COUNTER_" + strings.ToUpper(className)
		}
		bindings = append(bindings, durableNamespaceBinding(bindingName, className))
	}
	return bindings
}

func doClassesForTag(tag string) []string {
	switch tag {
	case "v1":
		return []string{"ProbeCounter"}
	case "v2":
		return []string{"ProbeCounter", "ProbeCounter2"}
	case "v3":
		return []string{"ProbeCounter", "ProbeCounter2", "ProbeCounter3"}
	default:
		return []string{"ProbeCounter"}
	}
}

func missingDOClasses(current, wanted []string) []string {
	var missing []string
	for _, className := range wanted {
		if !slices.Contains(current, className) {
			missing = append(missing, className)
		}
	}
	return missing
}

func hasSecretHashes(r probeResponse, keep, keep2 string) bool {
	return r.Keep != nil && *r.Keep == sha256Hex(keep) &&
		r.Keep2 != nil && *r.Keep2 == sha256Hex(keep2)
}

func secretText(name, value string) map[string]any {
	return map[string]any{"type": "secret_text", "name": name, "text": value}
}

func randomSuffix(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("random secret suffix: %v", err)
	}
	return hex.EncodeToString(b[:])
}

type cfClient struct {
	account    string
	token      string
	http       *http.Client
	redactions []string
}

type cfError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cfEnvelope struct {
	Success bool            `json:"success"`
	Errors  []cfError       `json:"errors"`
	Result  json.RawMessage `json:"result"`
}

func (c *cfClient) addRedactions(values map[string]string) {
	for _, value := range values {
		if value != "" {
			c.redactions = append(c.redactions, value)
		}
	}
}

// checkedScriptPath validates the target before any request can be built.
func (c *cfClient) checkedScriptPath(name string) (string, error) {
	if err := checkProbeName(name); err != nil {
		return "", err
	}
	return "/accounts/" + url.PathEscape(c.account) + "/workers/scripts/" + url.PathEscape(name), nil
}

func (c *cfClient) scriptPath(t *testing.T, name string) string {
	t.Helper()
	path, err := c.checkedScriptPath(name)
	if err != nil {
		t.Fatalf("refusing non-probe script target: %v", err)
	}
	return path
}

func (c *cfClient) uploadScript(t *testing.T, ctx context.Context, name string, metadata any, code string) []byte {
	t.Helper()
	body, contentType := multipartBody(t, metadata, code)
	return c.do(t, ctx, http.MethodPut, c.scriptPath(t, name), body, contentType, http.StatusOK)
}

func (c *cfClient) createVersion(t *testing.T, ctx context.Context, name string, metadata any, code string) []byte {
	t.Helper()
	body, contentType := multipartBody(t, metadata, code)
	path := c.scriptPath(t, name) + "/versions?bindings_inherit=strict"
	return c.do(t, ctx, http.MethodPost, path, body, contentType, http.StatusOK)
}

func (c *cfClient) patchSecrets(t *testing.T, ctx context.Context, name string, secrets map[string]any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"secrets": secrets})
	if err != nil {
		t.Fatalf("encode secrets: %v", err)
	}
	c.do(t, ctx, http.MethodPatch, c.scriptPath(t, name)+"/secrets-bulk", bytes.NewReader(payload), "application/json", http.StatusOK)
}

func (c *cfClient) accountSubdomain(t *testing.T, ctx context.Context) string {
	t.Helper()
	path := "/accounts/" + url.PathEscape(c.account) + "/workers/subdomain"
	data := c.do(t, ctx, http.MethodGet, path, nil, "", http.StatusOK)
	var out struct {
		Subdomain string `json:"subdomain"`
	}
	c.decodeResult(t, data, &out)
	if out.Subdomain == "" {
		t.Fatal("account has no workers.dev subdomain")
	}
	return out.Subdomain
}

func (c *cfClient) enableSubdomain(t *testing.T, ctx context.Context, name string) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"enabled": true})
	if err != nil {
		t.Fatalf("encode subdomain body: %v", err)
	}
	c.do(t, ctx, http.MethodPost, c.scriptPath(t, name)+"/subdomain", bytes.NewReader(payload), "application/json", http.StatusOK)
}

func (c *cfClient) createDeployment(t *testing.T, ctx context.Context, name, versionID string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"strategy": "percentage",
		"versions": []any{map[string]any{"version_id": versionID, "percentage": 100}},
		"annotations": map[string]any{
			"workers/message": "deskwand probe deployment",
		},
	})
	if err != nil {
		t.Fatalf("encode deployment: %v", err)
	}
	return c.do(t, ctx, http.MethodPost, c.scriptPath(t, name)+"/deployments", bytes.NewReader(payload), "application/json", http.StatusOK)
}

func (c *cfClient) deployVersion(t *testing.T, ctx context.Context, name, versionID string) {
	t.Helper()
	data := c.createDeployment(t, ctx, name, versionID)
	// The create response carries only the deployment id; the version split is
	// confirmed afterwards from the deployments list (waitForActiveVersion).
	var deployment struct {
		ID string `json:"id"`
	}
	c.decodeResult(t, data, &deployment)
	if deployment.ID == "" {
		t.Fatalf("deployment creation returned no deployment id: %s", c.safeBody(data))
	}
	t.Logf("deployed version %s as deployment %s", versionID, deployment.ID)
}

func (c *cfClient) activeVersion(t *testing.T, ctx context.Context, name string) string {
	t.Helper()
	data := c.do(t, ctx, http.MethodGet, c.scriptPath(t, name)+"/deployments?per_page=5", nil, "", http.StatusOK)
	var out struct {
		Deployments []struct {
			Versions []struct {
				VersionID string `json:"version_id"`
			} `json:"versions"`
		} `json:"deployments"`
	}
	c.decodeResult(t, data, &out)
	if len(out.Deployments) == 0 || len(out.Deployments[0].Versions) == 0 {
		t.Fatal("deployments list is empty")
	}
	return out.Deployments[0].Versions[0].VersionID
}

func (c *cfClient) waitForActiveVersion(t *testing.T, ctx context.Context, name, want string) {
	t.Helper()
	deadline := time.Now().Add(probeWait)
	var last string
	for {
		last = c.activeVersion(t, ctx, name)
		if last == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("active version = %q, want %q after %s", last, want, probeWait)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for active version %s: %v", want, ctx.Err())
		case <-time.After(probePoll):
		}
	}
}

func (c *cfClient) waitForActiveVersionBestEffort(t *testing.T, ctx context.Context, name, want string, timeout time.Duration) (string, bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last string
	for {
		last = c.activeVersion(t, ctx, name)
		if last == want {
			return last, true
		}
		if time.Now().After(deadline) {
			t.Logf("active version = %q, want %q after %s", last, want, timeout)
			return last, false
		}
		select {
		case <-ctx.Done():
			t.Logf("waiting for active version %s: %v", want, ctx.Err())
			return last, false
		case <-time.After(probePoll):
		}
	}
}

func probeVersionMetadata(message string, bindings []any) map[string]any {
	return map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": "2026-11-01",
		"bindings":           bindings,
		"annotations":        map[string]any{"workers/message": message},
	}
}

func (c *cfClient) createAndDeployVersion(t *testing.T, ctx context.Context, name string, metadata any, code string) string {
	t.Helper()
	data := c.createVersion(t, ctx, name, metadata, code)
	var version struct {
		ID string `json:"id"`
	}
	c.decodeResult(t, data, &version)
	if version.ID == "" {
		t.Fatal("version upload returned no version id")
	}
	c.deployVersion(t, ctx, name, version.ID)
	c.waitForActiveVersion(t, ctx, name, version.ID)
	t.Logf("created and deployed version %s", version.ID)
	return version.ID
}

// apiOutcome is a non-fatal Cloudflare response. Transport failures are
// returned as errors and treated as harness failures by the callers; a
// Cloudflare error envelope is data that the live probes record.
type apiOutcome struct {
	Accepted bool
	Status   int
	ID       string
	Codes    []int
	Messages []string
	Body     []byte
}

func (o apiOutcome) firstCode() int {
	if len(o.Codes) > 0 {
		return o.Codes[0]
	}
	return 0
}

func (o apiOutcome) message() string {
	return strings.Join(o.Messages, "; ")
}

func (o apiOutcome) errorSummary() string {
	if len(o.Codes) == 0 && len(o.Messages) == 0 {
		return fmt.Sprintf("HTTP %d with no Cloudflare error envelope", o.Status)
	}
	parts := make([]string, 0, len(o.Messages))
	for i, message := range o.Messages {
		code := 0
		if i < len(o.Codes) {
			code = o.Codes[i]
		}
		parts = append(parts, fmt.Sprintf("code=%d message=%q", code, message))
	}
	return strings.Join(parts, "; ")
}

func (c *cfClient) call(ctx context.Context, method, path string, body io.Reader, contentType string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, apiBase+path, body)
	if err != nil {
		return 0, nil, err
	}
	c.authorize(req)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}

func (c *cfClient) outcome(status int, data []byte) apiOutcome {
	out := apiOutcome{Status: status, Body: data}
	var envelope cfEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		out.Messages = []string{"non-JSON response"}
		return out
	}
	for _, apiErr := range envelope.Errors {
		out.Codes = append(out.Codes, apiErr.Code)
		out.Messages = append(out.Messages, apiErr.Message)
	}
	out.Accepted = status >= 200 && status < 300 && envelope.Success
	if out.Accepted {
		var result struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(envelope.Result, &result); err == nil {
			out.ID = result.ID
		}
	}
	return out
}

// createVersionOutcome uploads a version but records a rejection instead of
// failing the test. It uses bindings_inherit=strict so an unresolvable
// inherit binding is an error rather than a silently dropped binding.
func (c *cfClient) createVersionOutcome(t *testing.T, ctx context.Context, name string, metadata any, code string) apiOutcome {
	t.Helper()
	body, contentType := multipartBody(t, metadata, code)
	path := c.scriptPath(t, name) + "/versions?bindings_inherit=strict"
	status, data, err := c.call(ctx, http.MethodPost, path, body, contentType)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	out := c.outcome(status, data)
	t.Logf("version upload: HTTP %d accepted=%v id=%q errors=%s",
		status, out.Accepted, out.ID, c.safeBody([]byte(out.errorSummary())))
	return out
}

// uploadScriptOutcome uploads and immediately deploys a script but records a
// rejection instead of failing the test.
func (c *cfClient) uploadScriptOutcome(t *testing.T, ctx context.Context, name string, metadata any, code string) apiOutcome {
	t.Helper()
	return c.uploadScriptOutcomeQuery(t, ctx, name, metadata, code, "")
}

// uploadScriptOutcomeStrict uses bindings_inherit=strict, so an unresolvable
// `inherit` binding fails with error 10057 instead of being silently dropped.
// Source: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
func (c *cfClient) uploadScriptOutcomeStrict(t *testing.T, ctx context.Context, name string, metadata any, code string) apiOutcome {
	t.Helper()
	return c.uploadScriptOutcomeQuery(t, ctx, name, metadata, code, "bindings_inherit=strict")
}

func (c *cfClient) uploadScriptOutcomeQuery(t *testing.T, ctx context.Context, name string, metadata any, code, query string) apiOutcome {
	t.Helper()
	body, contentType := multipartBody(t, metadata, code)
	path := c.scriptPath(t, name)
	if query != "" {
		path += "?" + query
	}
	status, data, err := c.call(ctx, http.MethodPut, path, body, contentType)
	if err != nil {
		t.Fatalf("PUT %s: %v", path, err)
	}
	out := c.outcome(status, data)
	t.Logf("script upload: HTTP %d accepted=%v errors=%s",
		status, out.Accepted, c.safeBody([]byte(out.errorSummary())))
	return out
}

func (c *cfClient) createDeploymentOutcome(t *testing.T, ctx context.Context, name, versionID string) apiOutcome {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"strategy": "percentage",
		"versions": []any{map[string]any{"version_id": versionID, "percentage": 100}},
		"annotations": map[string]any{
			"workers/message": "deskwand probe deployment",
		},
	})
	if err != nil {
		t.Fatalf("encode deployment: %v", err)
	}
	path := c.scriptPath(t, name) + "/deployments"
	status, data, err := c.call(ctx, http.MethodPost, path, bytes.NewReader(payload), "application/json")
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	out := c.outcome(status, data)
	t.Logf("deployment create: HTTP %d accepted=%v id=%q errors=%s",
		status, out.Accepted, out.ID, c.safeBody([]byte(out.errorSummary())))
	return out
}

// migrationTag reads the applied Durable Object migration tag from the List
// Worker Scripts result (`migration_tag`).
//
// Source: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/
func (c *cfClient) migrationTag(t *testing.T, ctx context.Context, name string) string {
	t.Helper()
	if err := checkProbeName(name); err != nil {
		t.Fatalf("refusing non-probe script target: %v", err)
	}
	path := "/accounts/" + url.PathEscape(c.account) + "/workers/scripts"
	data := c.do(t, ctx, http.MethodGet, path, nil, "", http.StatusOK)
	var scripts []struct {
		ID           string `json:"id"`
		MigrationTag string `json:"migration_tag"`
	}
	c.decodeResult(t, data, &scripts)
	for _, script := range scripts {
		if script.ID == name {
			return script.MigrationTag
		}
	}
	t.Logf("script %s was not found in the listed scripts", name)
	return ""
}

func (c *cfClient) waitForKeep(t *testing.T, ctx context.Context, probeURL, revision, wantKeep string) probeResponse {
	t.Helper()
	start := time.Now()
	deadline := start.Add(probeWait)
	var last string
	for {
		got, detail := c.fetchProbe(ctx, probeURL)
		last = detail
		if detail == "" {
			last = got.String()
		}
		if detail == "" && got.Revision == revision && got.Keep != nil && *got.Keep == wantKeep {
			t.Logf("workers.dev observed revision %q with the expected KEEP hash after %s",
				revision, time.Since(start).Round(time.Millisecond))
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("workers.dev did not show revision %q with expected KEEP after %s: last=%s",
				revision, probeWait, last)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for workers.dev revision %q: %v", revision, ctx.Err())
		case <-time.After(probePoll):
		}
	}
}

func (c *cfClient) waitForRevision(t *testing.T, ctx context.Context, probeURL, revision string) probeResponse {
	t.Helper()
	got, ok := c.waitForRevisionBestEffort(t, ctx, probeURL, revision, probeWait)
	if !ok {
		t.Fatalf("workers.dev did not serve revision %q within %s", revision, probeWait)
	}
	return got
}

func (c *cfClient) waitForRevisionBestEffort(t *testing.T, ctx context.Context, probeURL, revision string, timeout time.Duration) (probeResponse, bool) {
	t.Helper()
	start := time.Now()
	deadline := start.Add(timeout)
	var last string
	for {
		got, detail := c.fetchProbe(ctx, probeURL)
		if detail != "" {
			last = detail
		} else {
			last = got.String()
		}
		if detail == "" && got.Revision == revision {
			t.Logf("workers.dev observed revision %q after %s", revision, time.Since(start).Round(time.Millisecond))
			return got, true
		}
		if time.Now().After(deadline) {
			t.Logf("workers.dev did not serve revision %q within %s: last=%s", revision, timeout, last)
			return probeResponse{}, false
		}
		select {
		case <-ctx.Done():
			t.Logf("waiting for workers.dev revision %q: %v", revision, ctx.Err())
			return probeResponse{}, false
		case <-time.After(probePoll):
		}
	}
}

type counterResponse struct {
	ClassName string `json:"className"`
	Count     *int   `json:"count"`
	Error     string `json:"error"`
}

func (c *cfClient) fetchCounter(ctx context.Context, counterURL string) (counterResponse, string) {
	requestURL := fmt.Sprintf("%s?deskwand_probe=%d", counterURL, time.Now().UnixNano())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return counterResponse{}, err.Error()
	}
	req.Header.Set("User-Agent", "deskwand-probe/1")
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := c.http.Do(req)
	if err != nil {
		return counterResponse{}, err.Error()
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return counterResponse{}, err.Error()
	}
	if resp.StatusCode != http.StatusOK {
		return counterResponse{}, fmt.Sprintf("HTTP %s: %s", resp.Status, truncate(body))
	}
	var out counterResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return counterResponse{}, fmt.Sprintf("decode %s: %v", truncate(body), err)
	}
	if out.Error != "" {
		return out, "worker error: " + out.Error
	}
	return out, ""
}

// mustCounter retries only failed requests. A successful response with the
// wrong count fails immediately: every successful /do call increments the
// counter, so retrying a wrong count would corrupt the persistence assertion.
func (c *cfClient) mustCounter(t *testing.T, ctx context.Context, counterURL string, want int) {
	t.Helper()
	deadline := time.Now().Add(probeWait)
	var last string
	for {
		got, detail := c.fetchCounter(ctx, counterURL)
		last = detail
		if detail == "" {
			if got.Count == nil {
				last = fmt.Sprintf("response without count: class=%q", got.ClassName)
			} else if *got.Count != want {
				t.Fatalf("%s returned count=%d class=%q, want %d", counterURL, *got.Count, got.ClassName, want)
			} else {
				t.Logf("%s returned count=%d class=%q", counterURL, *got.Count, got.ClassName)
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s did not return count=%d within %s: %s", counterURL, want, probeWait, last)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for %s: %v", counterURL, ctx.Err())
		case <-time.After(probePoll):
		}
	}
}

type probeExpect struct {
	Revision     string
	Keep         string
	Replace      string
	ClearDefined bool
}

type probeResponse struct {
	Revision     string  `json:"revision"`
	Keep         *string `json:"keep"`
	Keep2        *string `json:"keep2"`
	Replace      *string `json:"replace"`
	ClearDefined bool    `json:"clearDefined"`
}

func (r probeResponse) String() string {
	keep, keep2, replace := "null", "null", "null"
	if r.Keep != nil {
		keep = *r.Keep
	}
	if r.Keep2 != nil {
		keep2 = *r.Keep2
	}
	if r.Replace != nil {
		replace = *r.Replace
	}
	return fmt.Sprintf("revision=%q keep=%s keep2=%s replace=%s clearDefined=%v", r.Revision, keep, keep2, replace, r.ClearDefined)
}

func (r probeResponse) matches(want probeExpect) bool {
	return r.Revision == want.Revision &&
		r.Keep != nil && *r.Keep == want.Keep &&
		r.Replace != nil && *r.Replace == want.Replace &&
		r.ClearDefined == want.ClearDefined
}

// waitForProbe fetches the public workers.dev route and retries while the
// deployment propagates. It never sends the Cloudflare API token.
func (c *cfClient) waitForProbe(t *testing.T, ctx context.Context, probeURL string, want probeExpect) {
	t.Helper()
	start := time.Now()
	deadline := start.Add(probeWait)
	var last string
	for {
		got, detail := c.fetchProbe(ctx, probeURL)
		last = detail
		if detail == "" && got.matches(want) {
			t.Logf("workers.dev observed revision %q after %s (KEEP/REPLACE hashes and CLEAR presence match)",
				want.Revision, time.Since(start).Round(time.Millisecond))
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("workers.dev probe did not match after %s: want revision=%q clearDefined=%v, last=%s",
				probeWait, want.Revision, want.ClearDefined, last)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for workers.dev probe: %v", ctx.Err())
		case <-time.After(probePoll):
		}
	}
}

func (c *cfClient) fetchProbe(ctx context.Context, probeURL string) (probeResponse, string) {
	requestURL := fmt.Sprintf("%s?deskwand_probe=%d", probeURL, time.Now().UnixNano())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return probeResponse{}, err.Error()
	}
	req.Header.Set("User-Agent", "deskwand-probe/1")
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := c.http.Do(req)
	if err != nil {
		return probeResponse{}, err.Error()
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return probeResponse{}, err.Error()
	}
	if resp.StatusCode != http.StatusOK {
		return probeResponse{}, fmt.Sprintf("HTTP %s", resp.Status)
	}
	var out probeResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return probeResponse{}, fmt.Sprintf("decode %s: %v", truncate(body), err)
	}
	return out, ""
}

func (c *cfClient) secretNamesRaw(t *testing.T, ctx context.Context, name string) []byte {
	t.Helper()
	return c.do(t, ctx, http.MethodGet, c.scriptPath(t, name)+"/secrets", nil, "", http.StatusOK)
}

func (c *cfClient) secretNames(t *testing.T, ctx context.Context, name string) map[string]bool {
	t.Helper()
	return c.parseSecretNames(t, c.secretNamesRaw(t, ctx, name))
}

func (c *cfClient) parseSecretNames(t *testing.T, data []byte) map[string]bool {
	t.Helper()
	var out []struct {
		Name string `json:"name"`
	}
	c.decodeResult(t, data, &out)
	names := make(map[string]bool, len(out))
	for _, secret := range out {
		names[secret.Name] = true
	}
	return names
}

func (c *cfClient) versionBindings(t *testing.T, ctx context.Context, name, versionID string) []byte {
	t.Helper()
	data := c.do(t, ctx, http.MethodGet, c.scriptPath(t, name)+"/versions/"+url.PathEscape(versionID), nil, "", http.StatusOK)
	var out struct {
		Resources struct {
			Bindings json.RawMessage `json:"bindings"`
		} `json:"resources"`
	}
	c.decodeResult(t, data, &out)
	return out.Resources.Bindings
}

func (c *cfClient) deleteScript(ctx context.Context, name string) error {
	path, err := c.checkedScriptPath(name)
	if err != nil {
		return err
	}
	// force=true is required so a probe Worker that owns Durable Object
	// namespaces can still be deleted; it also deletes those namespaces.
	// Source: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, apiBase+path+"?force=true", nil)
	if err != nil {
		return err
	}
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("DELETE returned %s: %s", resp.Status, c.safeBody(body))
	}
	return nil
}

func (c *cfClient) do(t *testing.T, ctx context.Context, method, path string, body io.Reader, contentType string, want ...int) []byte {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, method, apiBase+path, body)
	if err != nil {
		t.Fatalf("%s %s: build request: %v", method, path, err)
	}
	c.authorize(req)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		t.Fatalf("%s %s: read response: %v", method, path, err)
	}
	if !slices.Contains(want, resp.StatusCode) {
		t.Fatalf("%s %s: %s: %s", method, path, resp.Status, c.safeBody(data))
	}
	return data
}

func (c *cfClient) authorize(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", "deskwand-probe/1")
	req.Header.Set("Accept", "application/json")
}

// safeBody removes every sentinel value before a response body can reach a
// test log or failure message.
func (c *cfClient) safeBody(data []byte) string {
	text := string(data)
	for _, value := range c.redactions {
		if value != "" {
			text = strings.ReplaceAll(text, value, "[redacted]")
		}
	}
	return truncate([]byte(text))
}

func (c *cfClient) decodeResult(t *testing.T, data []byte, dst any) {
	t.Helper()
	var envelope cfEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatalf("decode API envelope: %v: %s", err, c.safeBody(data))
	}
	if !envelope.Success {
		messages := make([]string, 0, len(envelope.Errors))
		for _, e := range envelope.Errors {
			messages = append(messages, fmt.Sprintf("%d: %s", e.Code, e.Message))
		}
		t.Fatalf("Cloudflare API failure: %s", c.safeBody([]byte(strings.Join(messages, "; "))))
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		t.Fatalf("Cloudflare API response has no result: %s", c.safeBody(data))
	}
	if err := json.Unmarshal(envelope.Result, dst); err != nil {
		t.Fatalf("decode API result: %v: %s", err, c.safeBody(envelope.Result))
	}
}

func multipartBody(t *testing.T, metadata any, code string) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	meta, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("encode multipart metadata: %v", err)
	}
	metaHeader := textproto.MIMEHeader{}
	metaHeader.Set("Content-Disposition", `form-data; name="metadata"`)
	metaHeader.Set("Content-Type", "application/json")
	metaPart, err := writer.CreatePart(metaHeader)
	if err != nil {
		t.Fatalf("create metadata part: %v", err)
	}
	if _, err := metaPart.Write(meta); err != nil {
		t.Fatalf("write metadata part: %v", err)
	}

	codeHeader := textproto.MIMEHeader{}
	codeHeader.Set("Content-Disposition", `form-data; name="worker.js"; filename="worker.js"`)
	codeHeader.Set("Content-Type", "application/javascript+module")
	codePart, err := writer.CreatePart(codeHeader)
	if err != nil {
		t.Fatalf("create module part: %v", err)
	}
	if _, err := codePart.Write([]byte(code)); err != nil {
		t.Fatalf("write module part: %v", err)
	}

	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart body: %v", err)
	}
	return &buf, writer.FormDataContentType()
}

func assertSecretNames(t *testing.T, names map[string]bool, want map[string]bool) {
	t.Helper()
	for name, present := range want {
		if names[name] != present {
			t.Errorf("secret %s present = %v, want %v (all: %v)", name, names[name], present, sortedNames(names))
		}
	}
}

func hasName(names map[string]bool, name string) bool { return names[name] }

func sortedNames(names map[string]bool) []string {
	out := make([]string, 0, len(names))
	for name, present := range names {
		if present {
			out = append(out, name)
		}
	}
	slices.Sort(out)
	return out
}

func truncate(data []byte) string {
	const limit = 1000
	if len(data) <= limit {
		return string(data)
	}
	return string(data[:limit]) + "…"
}

func TestProbeNameGuard(t *testing.T) {
	if err := checkProbeName("deskwand-probe-1700000000-abcdef"); err != nil {
		t.Fatalf("valid probe name rejected: %v", err)
	}
	for _, name := range []string{
		"production-bot",
		"deskwand-probe-Prod",
		"deskwand-probe-../escape",
		"deskwand-probe-" + strings.Repeat("a", 60),
		"deskwand-probe-trailing-",
	} {
		if err := checkProbeName(name); err == nil {
			t.Errorf("checkProbeName(%q) accepted an unsafe target", name)
		}
	}
}

func TestProbePathGuard(t *testing.T) {
	client := &cfClient{account: "0123456789abcdef0123456789abcdef"}
	if _, err := client.checkedScriptPath("deskwand-probe-1700000000-abcdef"); err != nil {
		t.Fatalf("valid probe path rejected: %v", err)
	}
	for _, name := range []string{"production-bot", "deskwand-probe-../escape", "other"} {
		if _, err := client.checkedScriptPath(name); err == nil {
			t.Errorf("checkedScriptPath(%q) accepted an unsafe target", name)
		}
	}
}

func TestSafeBodyRedactsSentinels(t *testing.T) {
	client := &cfClient{redactions: []string{"keep-sentinel", "replace-sentinel"}}
	body := []byte(`{"keep":"keep-sentinel","replace":"replace-sentinel"}`)
	got := client.safeBody(body)
	if strings.Contains(got, "keep-sentinel") || strings.Contains(got, "replace-sentinel") {
		t.Fatalf("safeBody leaked a sentinel: %s", got)
	}
	if !strings.Contains(got, "[redacted]") {
		t.Fatalf("safeBody did not mark redactions: %s", got)
	}
}
