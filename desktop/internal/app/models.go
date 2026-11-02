package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// Model providers the Worker supports. Keep these in sync with
// contracts/deployment-config.schema.json and src/llm/models.ts.
const (
	ProviderAnthropic  = "anthropic"
	ProviderOpenCodeGo = "opencode-go"
)

var (
	// ErrModelProbe means the provider request did not complete successfully.
	ErrModelProbe = errors.New("app: model probe failed")
	// ErrUnsupportedModelProvider rejects providers the Worker cannot use.
	ErrUnsupportedModelProvider = errors.New("app: unsupported model provider")
)

// Package variables allow tests to point probes at a loopback server. The
// production values are the base URLs used by the Worker's pi-ai adapters.
// OpenCode Go model-specific base URLs and wire APIs live in
// opencode_models_generated.go.
const openCodeGoProductionBaseURL = "https://opencode.ai/inference/go"

var modelProviderBaseURLs = map[string]string{
	// https://api.anthropic.com/v1/messages
	ProviderAnthropic:  "https://api.anthropic.com",
	ProviderOpenCodeGo: openCodeGoProductionBaseURL,
}

var modelProbeTimeout = 15 * time.Second

var modelProbeHTTPClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

type modelProbeMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type modelProbeRequest struct {
	Model           string              `json:"model"`
	MaxTokens       int                 `json:"max_tokens,omitempty"`
	MaxOutputTokens int                 `json:"max_output_tokens,omitempty"`
	Messages        []modelProbeMessage `json:"messages,omitempty"`
	Input           string              `json:"input,omitempty"`
}

// ProbeModel makes one minimal, user-triggered request with the supplied key.
// It never runs automatically, keeps the key only in memory, and returns
// evidence labelled local. A successful probe proves the provider accepted the
// credential from this machine; it does not verify the deployed Worker.
func ProbeModel(ctx context.Context, provider, model, key string) (domain.Evidence, error) {
	provider = strings.TrimSpace(provider)
	model = strings.TrimSpace(model)
	if strings.TrimSpace(key) == "" {
		return domain.Evidence{}, fmt.Errorf("%w: API key is empty", ErrModelProbe)
	}

	baseURL, ok := modelProviderBaseURLs[provider]
	if !ok {
		return domain.Evidence{}, fmt.Errorf("%w: %q", ErrUnsupportedModelProvider, provider)
	}
	if model == "" {
		return domain.Evidence{}, fmt.Errorf("%w: model id is empty", ErrModelProbe)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, modelProbeTimeout)
	defer cancel()

	api := "anthropic-messages"
	base := baseURL
	if provider == ProviderOpenCodeGo {
		endpoint, ok := openCodeGoModelEndpoints[model]
		if !ok {
			return domain.Evidence{}, fmt.Errorf("%w: unknown %s model %q", ErrUnsupportedModelProvider, provider, model)
		}
		api = endpoint.API
		base = endpoint.BaseURL
		if override := modelProviderBaseURLs[ProviderOpenCodeGo]; override != openCodeGoProductionBaseURL {
			base = override
		}
	}

	body := modelProbeRequest{Model: model}
	var path string
	switch api {
	case "anthropic-messages":
		path = "/v1/messages"
		body.MaxTokens = 1
		body.Messages = []modelProbeMessage{{Role: "user", Content: "ping"}}
	case "openai-completions":
		path = "/v1/chat/completions"
		body.MaxTokens = 1
		body.Messages = []modelProbeMessage{{Role: "user", Content: "ping"}}
	case "openai-responses":
		path = "/v1/responses"
		// Responses rejects max_output_tokens below 16.
		body.MaxOutputTokens = 16
		body.Input = "ping"
	default:
		return domain.Evidence{}, fmt.Errorf("%w: %s model %q uses unsupported API %q", ErrUnsupportedModelProvider, provider, model, api)
	}
	endpoint := joinModelPath(base, path)

	encoded, err := json.Marshal(body)
	if err != nil {
		return domain.Evidence{}, fmt.Errorf("%w: encode request", ErrModelProbe)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return domain.Evidence{}, fmt.Errorf("%w: create request", ErrModelProbe)
	}
	request.Header.Set("Content-Type", "application/json")
	switch api {
	case "anthropic-messages":
		request.Header.Set("x-api-key", key)
		request.Header.Set("anthropic-version", "2023-06-01")
	default:
		request.Header.Set("Authorization", "Bearer "+key)
	}

	response, err := modelProbeHTTPClient.Do(request)
	if err != nil {
		return domain.Evidence{}, probeError(err, key)
	}
	defer response.Body.Close()
	// Drain a bounded amount so a provider error body can never become part of
	// our error message or be retained in memory.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 16<<10))

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return domain.Evidence{}, fmt.Errorf("%w: provider returned HTTP %d", ErrModelProbe, response.StatusCode)
	}

	return domain.Evidence{
		Kind:       "model",
		Source:     diagnostics.SourceLocal,
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Detail:     "probe_ok",
	}, nil
}

// joinModelPath appends a canonical /v1 path without duplicating a base URL
// that already ends in /v1.
func joinModelPath(base, path string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/v1") && strings.HasPrefix(path, "/v1/") {
		return base + strings.TrimPrefix(path, "/v1")
	}
	return base + path
}

func probeError(err error, key string) error {
	message := err.Error()
	if redacted := diagnostics.NewRedactor(key).Redact(message); redacted != "" {
		message = redacted
	}
	if strings.Contains(message, key) {
		message = strings.ReplaceAll(message, key, diagnostics.RedactedValue)
	}
	return fmt.Errorf("%w: %s", ErrModelProbe, message)
}
