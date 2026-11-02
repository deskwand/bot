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
	"github.com/deskwand/bot/desktop/internal/modelcatalog"
)

var (
	// ErrModelProbe means the provider request did not complete successfully.
	ErrModelProbe = errors.New("app: model probe failed")
	// ErrUnsupportedModelProvider rejects providers the catalog does not list.
	ErrUnsupportedModelProvider = errors.New("app: unsupported model provider")
)

// modelProbeBaseURLOverride lets tests point probes at a loopback server. The
// production base URL comes from the shared catalog or the custom provider.
var modelProbeBaseURLOverride string

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
// When api and baseURL are both empty it looks the model up in the shared
// catalog; custom providers pass their wire API and endpoint explicitly. It
// never runs automatically, keeps the key only in memory, and returns evidence
// labelled local. A successful probe proves the provider accepted the
// credential from this machine; it does not verify the deployed Worker.
func ProbeModel(ctx context.Context, provider, model, key, api, baseURL string) (domain.Evidence, error) {
	provider = strings.TrimSpace(provider)
	model = strings.TrimSpace(model)
	api = strings.TrimSpace(api)
	baseURL = strings.TrimSpace(baseURL)
	if strings.TrimSpace(key) == "" {
		return domain.Evidence{}, fmt.Errorf("%w: API key is empty", ErrModelProbe)
	}
	if model == "" {
		return domain.Evidence{}, fmt.Errorf("%w: model id is empty", ErrModelProbe)
	}

	if api == "" && baseURL == "" {
		catalogProvider, ok := modelcatalog.LookupBuiltin(provider)
		if !ok {
			return domain.Evidence{}, fmt.Errorf("%w: %q", ErrUnsupportedModelProvider, provider)
		}
		api, baseURL = catalogEndpoint(catalogProvider, model)
		if api == "" {
			return domain.Evidence{}, fmt.Errorf("%w: unknown %s model %q", ErrUnsupportedModelProvider, provider, model)
		}
	}
	if api == "" || baseURL == "" {
		return domain.Evidence{}, fmt.Errorf("%w: %s model %q needs an api and baseUrl", ErrUnsupportedModelProvider, provider, model)
	}
	if override := modelProbeBaseURLOverride; override != "" {
		baseURL = override
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, modelProbeTimeout)
	defer cancel()

	endpoint, err := probeEndpoint(baseURL, api)
	if err != nil {
		return domain.Evidence{}, fmt.Errorf("%w: %s model %q uses unsupported API %q", ErrUnsupportedModelProvider, provider, model, api)
	}
	body := modelProbeRequest{Model: model}
	switch api {
	case "anthropic-messages":
		body.MaxTokens = 1
		body.Messages = []modelProbeMessage{{Role: "user", Content: "ping"}}
	case "openai-completions":
		body.MaxTokens = 1
		body.Messages = []modelProbeMessage{{Role: "user", Content: "ping"}}
	case "openai-responses":
		// Responses rejects max_output_tokens below 16.
		body.MaxOutputTokens = 16
		body.Input = "ping"
	}

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

// catalogEndpoint finds the wire API and base URL for one catalog model.
func catalogEndpoint(provider modelcatalog.Provider, model string) (string, string) {
	for _, entry := range provider.Models {
		if entry.ID == model {
			return entry.API, entry.BaseURL
		}
	}
	return "", ""
}

// probeEndpoint builds the request URL exactly like the Worker SDKs: the base
// URL is used as-is, so an OpenAI-compatible base must already end in /v1 when
// the provider requires it. Anthropic's SDK appends /v1 itself.
func probeEndpoint(base, api string) (string, error) {
	base = strings.TrimRight(base, "/")
	switch api {
	case "anthropic-messages":
		return base + "/v1/messages", nil
	case "openai-completions":
		return base + "/chat/completions", nil
	case "openai-responses":
		return base + "/responses", nil
	default:
		return "", fmt.Errorf("unsupported API %q", api)
	}
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
