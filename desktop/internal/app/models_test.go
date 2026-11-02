package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/modelcatalog"
)

const modelKeySentinel = "sk-ant-api03-SENTINEL-model-key-0123456789"

func useProbeServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func overrideProbeBaseURL(t *testing.T, baseURL string) {
	t.Helper()
	previous := modelProbeBaseURLOverride
	modelProbeBaseURLOverride = baseURL
	t.Cleanup(func() { modelProbeBaseURLOverride = previous })
}

type countBody struct {
	Model           string `json:"model"`
	MaxTokens       int    `json:"max_tokens"`
	MaxOutputTokens int    `json:"max_output_tokens"`
	Input           string `json:"input"`
	Messages        []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

func TestProbeModelAnthropicUsesMinimalRequest(t *testing.T) {
	var sawPath, sawKey, sawVersion string
	var body countBody
	server := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawKey = r.Header.Get("x-api-key")
		sawVersion = r.Header.Get("anthropic-version")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}`))
	}))
	overrideProbeBaseURL(t, server.URL)

	evidence, err := ProbeModel(context.Background(), "anthropic", "claude-sonnet-5-5", modelKeySentinel, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if sawPath != "/v1/messages" {
		t.Fatalf("path = %q", sawPath)
	}
	if sawKey != modelKeySentinel || sawVersion == "" {
		t.Fatalf("headers key=%q version=%q", sawKey, sawVersion)
	}
	if body.Model != "claude-sonnet-5-5" || body.MaxTokens != 1 || len(body.Messages) != 1 {
		t.Fatalf("body = %+v", body)
	}
	if evidence.Kind != "model" || evidence.Source != diagnostics.SourceLocal ||
		evidence.Detail != "probe_ok" || evidence.VersionID != "" {
		t.Fatalf("evidence = %+v", evidence)
	}
	if strings.Contains(evidence.ObservedAt, modelKeySentinel) {
		t.Fatal("evidence leaked the key")
	}
}

func TestProbeModelOpenCodeGoUsesBearerKey(t *testing.T) {
	var sawPath, sawAuthorization string
	var body countBody
	server := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawAuthorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	overrideProbeBaseURL(t, server.URL)

	evidence, err := ProbeModel(context.Background(), "opencode-go", "deepseek-v4.1-flash", modelKeySentinel, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if sawPath != "/chat/completions" {
		t.Fatalf("path = %q", sawPath)
	}
	if sawAuthorization != "Bearer "+modelKeySentinel {
		t.Fatalf("authorization = %q", sawAuthorization)
	}
	if body.Model != "deepseek-v4.1-flash" || body.MaxTokens != 1 || body.MaxOutputTokens != 0 {
		t.Fatalf("body = %+v", body)
	}
	if evidence.Source != diagnostics.SourceLocal || evidence.Detail != "probe_ok" {
		t.Fatalf("evidence = %+v", evidence)
	}
}

func TestProbeModelOpenCodeGoAnthropicMessages(t *testing.T) {
	var sawPath, sawKey, sawVersion string
	var body countBody
	server := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawKey = r.Header.Get("x-api-key")
		sawVersion = r.Header.Get("anthropic-version")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	overrideProbeBaseURL(t, server.URL)

	if _, err := ProbeModel(context.Background(), "opencode-go", "claude-haiku-5-5", modelKeySentinel, "", ""); err != nil {
		t.Fatal(err)
	}
	if sawPath != "/v1/messages" {
		t.Fatalf("path = %q", sawPath)
	}
	if sawKey != modelKeySentinel || sawVersion == "" {
		t.Fatalf("headers key=%q version=%q", sawKey, sawVersion)
	}
	if body.Model != "claude-haiku-5-5" || body.MaxTokens != 1 || body.MaxOutputTokens != 0 {
		t.Fatalf("body = %+v", body)
	}
}

func TestProbeModelOpenCodeGoResponses(t *testing.T) {
	var sawPath, sawAuthorization string
	var body countBody
	server := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawAuthorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	overrideProbeBaseURL(t, server.URL)

	if _, err := ProbeModel(context.Background(), "opencode-go", "gpt-5.6-luna", modelKeySentinel, "", ""); err != nil {
		t.Fatal(err)
	}
	if sawPath != "/responses" {
		t.Fatalf("path = %q", sawPath)
	}
	if sawAuthorization != "Bearer "+modelKeySentinel {
		t.Fatalf("authorization = %q", sawAuthorization)
	}
	if body.Model != "gpt-5.6-luna" || body.MaxOutputTokens != 16 || body.MaxTokens != 0 ||
		body.Input != "ping" || len(body.Messages) != 0 {
		t.Fatalf("body = %+v", body)
	}
}

func TestProbeModelCustomEndpointUsesSuppliedAPIAndBaseURL(t *testing.T) {
	var sawPath, sawAuthorization string
	var body countBody
	server := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawAuthorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))

	if _, err := ProbeModel(context.Background(), "my-proxy", "gpt-5.6", modelKeySentinel, "openai-completions", server.URL); err != nil {
		t.Fatal(err)
	}
	if sawPath != "/chat/completions" {
		t.Fatalf("path = %q", sawPath)
	}
	if sawAuthorization != "Bearer "+modelKeySentinel {
		t.Fatalf("authorization = %q", sawAuthorization)
	}
	if body.Model != "gpt-5.6" || body.MaxTokens != 1 {
		t.Fatalf("body = %+v", body)
	}
}

func TestProbeEndpointMatchesSDKPaths(t *testing.T) {
	tests := []struct {
		name string
		base string
		api  string
		want string
	}{
		{name: "openai base with v1", base: "https://x/v1", api: "openai-completions", want: "https://x/v1/chat/completions"},
		{name: "openai base without v1", base: "https://x", api: "openai-completions", want: "https://x/chat/completions"},
		{name: "openai trailing slash", base: "https://x/v1/", api: "openai-completions", want: "https://x/v1/chat/completions"},
		{name: "anthropic base without v1", base: "https://x", api: "anthropic-messages", want: "https://x/v1/messages"},
		{name: "responses base with v1", base: "https://x/v1", api: "openai-responses", want: "https://x/v1/responses"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := probeEndpoint(testCase.base, testCase.api)
			if err != nil {
				t.Fatal(err)
			}
			if got != testCase.want {
				t.Fatalf("probeEndpoint(%q, %q) = %q, want %q", testCase.base, testCase.api, got, testCase.want)
			}
		})
	}
}

func TestProbeEndpointUsesCatalogZaiBaseURL(t *testing.T) {
	provider, ok := modelcatalog.LookupBuiltin("zai")
	if !ok {
		t.Fatal("zai is missing from the catalog")
	}
	api, baseURL := catalogEndpoint(provider, "glm-5.2")
	if api != "openai-completions" || !strings.HasSuffix(baseURL, "/paas/v4") {
		t.Fatalf("catalog endpoint = %q %q", api, baseURL)
	}
	got, err := probeEndpoint(baseURL, api)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got, "/paas/v4/chat/completions") {
		t.Fatalf("probeEndpoint() = %q, want a /paas/v4/chat/completions suffix", got)
	}
}

func TestProbeModelRejectsGoogleGenerativeAI(t *testing.T) {
	overrideProbeBaseURL(t, "https://should-not-be-called.test")

	_, err := ProbeModel(context.Background(), "opencode-go", "gemini-4-argon-contributor", modelKeySentinel, "", "")
	if !errors.Is(err, ErrUnsupportedModelProvider) {
		t.Fatalf("err = %v, want ErrUnsupportedModelProvider", err)
	}
}

func TestProbeModelDoesNotFollowRedirects(t *testing.T) {
	followed := false
	target := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed = true
		w.WriteHeader(http.StatusOK)
	}))
	redirector := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/stolen", http.StatusTemporaryRedirect)
	}))
	overrideProbeBaseURL(t, redirector.URL)

	if _, err := ProbeModel(context.Background(), "anthropic", "claude-sonnet-5-5", modelKeySentinel, "", ""); !errors.Is(err, ErrModelProbe) {
		t.Fatalf("err = %v", err)
	}
	if followed {
		t.Fatal("probe followed a redirect with the API key")
	}
}

func TestProbeModelProviderErrorDoesNotLeakKey(t *testing.T) {
	server := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Debug-Authorization", "Bearer "+modelKeySentinel)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid key ` + modelKeySentinel + `"}}`))
	}))
	overrideProbeBaseURL(t, server.URL)

	_, err := ProbeModel(context.Background(), "anthropic", "claude-sonnet-5-5", modelKeySentinel, "", "")
	if !errors.Is(err, ErrModelProbe) {
		t.Fatalf("err = %v, want ErrModelProbe", err)
	}
	if strings.Contains(err.Error(), modelKeySentinel) {
		t.Fatalf("error leaked the key: %v", err)
	}
	if strings.Contains(err.Error(), "invalid key") {
		t.Fatalf("error included the raw provider body: %v", err)
	}
}

type failingTransport struct {
	err error
}

func (f failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, f.err
}

func TestProbeModelTransportErrorIsRedacted(t *testing.T) {
	previousClient := modelProbeHTTPClient
	modelProbeHTTPClient = &http.Client{Transport: failingTransport{
		err: errors.New("dial failed for Authorization: Bearer " + modelKeySentinel),
	}}
	t.Cleanup(func() { modelProbeHTTPClient = previousClient })
	overrideProbeBaseURL(t, "https://api.anthropic.test")

	_, err := ProbeModel(context.Background(), "anthropic", "claude-sonnet-5-5", modelKeySentinel, "", "")
	if !errors.Is(err, ErrModelProbe) {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), modelKeySentinel) {
		t.Fatalf("transport error leaked the key: %v", err)
	}
}

func TestProbeModelTimesOutAndIsRedacted(t *testing.T) {
	previousTimeout := modelProbeTimeout
	modelProbeTimeout = 30 * time.Millisecond
	t.Cleanup(func() { modelProbeTimeout = previousTimeout })

	server := useProbeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	overrideProbeBaseURL(t, server.URL)

	_, err := ProbeModel(context.Background(), "anthropic", "claude-sonnet-5-5", modelKeySentinel, "", "")
	if !errors.Is(err, ErrModelProbe) {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), modelKeySentinel) {
		t.Fatalf("timeout error leaked the key: %v", err)
	}
}

func TestProbeModelRejectsInvalidInputWithoutRequest(t *testing.T) {
	if _, err := ProbeModel(context.Background(), "ghost", "deepseek-chat", "key-sentinel", "", ""); !errors.Is(err, ErrUnsupportedModelProvider) {
		t.Fatalf("unsupported provider err = %v", err)
	}
	if _, err := ProbeModel(context.Background(), "anthropic", "", "key-sentinel", "", ""); !errors.Is(err, ErrModelProbe) {
		t.Fatalf("empty model err = %v", err)
	}
	if _, err := ProbeModel(context.Background(), "anthropic", "claude-sonnet-5-5", "   ", "", ""); !errors.Is(err, ErrModelProbe) {
		t.Fatalf("empty key err = %v", err)
	}
}
