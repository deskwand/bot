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
	var deployment struct {
		ID       string `json:"id"`
		Versions []struct {
			VersionID  string  `json:"version_id"`
			Percentage float64 `json:"percentage"`
		} `json:"versions"`
	}
	c.decodeResult(t, data, &deployment)
	if deployment.ID == "" {
		t.Fatal("deployment creation returned no deployment id")
	}
	if len(deployment.Versions) != 1 || deployment.Versions[0].VersionID != versionID || deployment.Versions[0].Percentage != 100 {
		t.Fatalf("deployment versions = %+v, want only %s at 100%%", deployment.Versions, versionID)
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

type probeExpect struct {
	Revision     string
	Keep         string
	Replace      string
	ClearDefined bool
}

type probeResponse struct {
	Revision     string  `json:"revision"`
	Keep         *string `json:"keep"`
	Replace      *string `json:"replace"`
	ClearDefined bool    `json:"clearDefined"`
}

func (r probeResponse) String() string {
	keep, replace := "null", "null"
	if r.Keep != nil {
		keep = *r.Keep
	}
	if r.Replace != nil {
		replace = *r.Replace
	}
	return fmt.Sprintf("revision=%q keep=%s replace=%s clearDefined=%v", r.Revision, keep, replace, r.ClearDefined)
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
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, apiBase+path, nil)
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
