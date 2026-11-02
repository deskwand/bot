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
)

const modelKeySentinel = "sk-ant-api03-SENTINEL-model-key-0123456789"

func useProbeServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func overrideProviderBase(t *testing.T, provider, baseURL string) {
	t.Helper()
	previous, existed := modelProviderBaseURLs[provider]
	modelProviderBaseURLs[provider] = baseURL
	t.Cleanup(func() {
		if existed {
			modelProviderBaseURLs[provider] = previous
		} else {
			delete(modelProviderBaseURLs, provider)
		}
	})
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
	overrideProviderBase(t, ProviderAnthropic, server.URL)

	evidence, err := ProbeModel(context.Background(), ProviderAnthropic, "claude-sonnet-5-5", modelKeySentinel)
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
	overrideProviderBase(t, ProviderOpenCodeGo, server.URL)

	evidence, err := ProbeModel(context.Background(), ProviderOpenCodeGo, "deepseek-v4.1-flash", modelKeySentinel)
	if err != nil {
		t.Fatal(err)
	}
	if sawPath != "/v1/chat/completions" {
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
	overrideProviderBase(t, ProviderOpenCodeGo, server.URL)

	if _, err := ProbeModel(context.Background(), ProviderOpenCodeGo, "claude-haiku-5-5", modelKeySentinel); err != nil {
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
	overrideProviderBase(t, ProviderOpenCodeGo, server.URL)

	if _, err := ProbeModel(context.Background(), ProviderOpenCodeGo, "gpt-5.6-luna", modelKeySentinel); err != nil {
		t.Fatal(err)
	}
	if sawPath != "/v1/responses" {
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

func TestProbeModelRejectsGoogleGenerativeAI(t *testing.T) {
	overrideProviderBase(t, ProviderOpenCodeGo, "https://should-not-be-called.test")

	_, err := ProbeModel(context.Background(), ProviderOpenCodeGo, "gemini-4-argon-contributor", modelKeySentinel)
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
	overrideProviderBase(t, ProviderAnthropic, redirector.URL)

	if _, err := ProbeModel(context.Background(), ProviderAnthropic, "claude-sonnet-5-5", modelKeySentinel); !errors.Is(err, ErrModelProbe) {
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
	overrideProviderBase(t, ProviderAnthropic, server.URL)

	_, err := ProbeModel(context.Background(), ProviderAnthropic, "claude-sonnet-5-5", modelKeySentinel)
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
	overrideProviderBase(t, ProviderAnthropic, "https://api.anthropic.test")

	_, err := ProbeModel(context.Background(), ProviderAnthropic, "claude-sonnet-5-5", modelKeySentinel)
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
	overrideProviderBase(t, ProviderAnthropic, server.URL)

	_, err := ProbeModel(context.Background(), ProviderAnthropic, "claude-sonnet-5-5", modelKeySentinel)
	if !errors.Is(err, ErrModelProbe) {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), modelKeySentinel) {
		t.Fatalf("timeout error leaked the key: %v", err)
	}
}

func TestProbeModelRejectsInvalidInputWithoutRequest(t *testing.T) {
	if _, err := ProbeModel(context.Background(), "deepseek", "deepseek-chat", "key-sentinel"); !errors.Is(err, ErrUnsupportedModelProvider) {
		t.Fatalf("unsupported provider err = %v", err)
	}
	if _, err := ProbeModel(context.Background(), ProviderAnthropic, "", "key-sentinel"); !errors.Is(err, ErrModelProbe) {
		t.Fatalf("empty model err = %v", err)
	}
	if _, err := ProbeModel(context.Background(), ProviderAnthropic, "claude-sonnet-5-5", "   "); !errors.Is(err, ErrModelProbe) {
		t.Fatalf("empty key err = %v", err)
	}
}
