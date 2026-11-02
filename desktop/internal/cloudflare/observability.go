package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// Workers Observability telemetry query:
// POST /accounts/{account_id}/workers/observability/telemetry/query
//
// Source:
// https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
//
// The endpoint is account-scoped; the script is selected with the
// $metadata.service filter. The API reference lists the accepted permission
// group as "Workers Observability Write" for this read-only query.
const (
	observabilityQueryID      = "deskwand-channel-events"
	observabilityDataset      = "cloudflare-workers"
	observabilityDefaultLimit = 200
	observabilityMaxWindow    = 7 * 24 * time.Hour
	// ObservabilityDefaultWindow is the default lookback for status queries.
	ObservabilityDefaultWindow = 6 * time.Hour
	observabilityNeedleValue   = "channel_event"
)

// ErrObservabilityUnavailable marks a missing endpoint or insufficient
// permission. Callers show an unknown state with a warning instead of treating
// it as a failure of the deployment.
var ErrObservabilityUnavailable = errors.New("cloudflare: Workers Observability telemetry is unavailable")

// ObservabilityUnavailableError is the typed unavailable result. It unwraps to
// ErrObservabilityUnavailable so errors.Is works, and its message never echoes
// remote response text.
type ObservabilityUnavailableError struct {
	Status int
}

func (e *ObservabilityUnavailableError) Error() string {
	if e == nil || e.Status == 0 {
		return ErrObservabilityUnavailable.Error()
	}
	return fmt.Sprintf("%s (HTTP %d)", ErrObservabilityUnavailable.Error(), e.Status)
}

func (e *ObservabilityUnavailableError) Unwrap() error { return ErrObservabilityUnavailable }

// IsObservabilityUnavailable reports whether err means the telemetry endpoint
// or its permission is not available.
func IsObservabilityUnavailable(err error) bool {
	return errors.Is(err, ErrObservabilityUnavailable)
}

type observabilityFilter struct {
	Key       string `json:"key"`
	Operation string `json:"operation"`
	Type      string `json:"type"`
	Value     string `json:"value"`
}

type observabilityNeedle struct {
	Value     string `json:"value"`
	IsRegex   bool   `json:"isRegex"`
	MatchCase bool   `json:"matchCase"`
}

type observabilityOrderBy struct {
	Value string `json:"value"`
	Order string `json:"order"`
}

type observabilityParameters struct {
	Datasets          []string              `json:"datasets"`
	Filters           []observabilityFilter `json:"filters"`
	Needle            *observabilityNeedle  `json:"needle,omitempty"`
	FilterCombination string                `json:"filterCombination,omitempty"`
	OrderBy           *observabilityOrderBy `json:"orderBy,omitempty"`
}

type observabilityQuery struct {
	View       string                  `json:"view"`
	QueryID    string                  `json:"queryId"`
	Dry        bool                    `json:"dry"`
	Limit      int                     `json:"limit"`
	Timeframe  observabilityTimeframe  `json:"timeframe"`
	Parameters observabilityParameters `json:"parameters"`
}

type observabilityTimeframe struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

type telemetryEvent struct {
	Source    json.RawMessage `json:"source"`
	Timestamp int64           `json:"timestamp"`
	Metadata  struct {
		Message string `json:"message"`
		Service string `json:"service"`
	} `json:"$metadata"`
	Workers struct {
		ScriptVersion struct {
			ID string `json:"id"`
		} `json:"scriptVersion"`
	} `json:"$workers"`
}

type telemetryQueryResult struct {
	Events struct {
		Events []telemetryEvent `json:"events"`
	} `json:"events"`
}

type channelEventPayload struct {
	Deskwand  string `json:"deskwand"`
	V         int    `json:"v"`
	VersionID string `json:"versionId"`
	Channel   string `json:"channel"`
	Event     string `json:"event"`
	ErrorCode string `json:"errorCode"`
	At        string `json:"at"`
}

var allowedChannelEvents = map[string]bool{
	"poll_ok":          true,
	"poll_expired":     true,
	"poll_error":       true,
	"send_ok":          true,
	"webhook_ok":       true,
	"webhook_rejected": true,
}

var allowedChannels = map[string]bool{
	"telegram": true,
	"wechat":   true,
}

// QueryChannelEvents reads sanitized deskwand=channel_event log lines for one
// script over the last `since` duration (default six hours, capped at the
// seven-day Workers Logs retention). Each result is evidence with the event's
// channel as Kind, source "cloudflare-logs", the reported version and the
// fixed event name as Detail.
func (c *Client) QueryChannelEvents(ctx context.Context, target domain.Target, since time.Duration) ([]domain.Evidence, error) {
	base, err := accountBasePath(target.AccountID)
	if err != nil {
		return nil, err
	}
	if err := ValidateWorkerName(target.ScriptName); err != nil {
		return nil, err
	}

	if since <= 0 {
		since = ObservabilityDefaultWindow
	}
	if since > observabilityMaxWindow {
		since = observabilityMaxWindow
	}
	now := time.Now().UTC()
	query := observabilityQuery{
		View:    "events",
		QueryID: observabilityQueryID,
		Dry:     true,
		Limit:   observabilityDefaultLimit,
		Timeframe: observabilityTimeframe{
			From: now.Add(-since).UnixMilli(),
			To:   now.UnixMilli(),
		},
		Parameters: observabilityParameters{
			Datasets: []string{observabilityDataset},
			Filters: []observabilityFilter{{
				Key:       "$metadata.service",
				Operation: "eq",
				Type:      "string",
				Value:     target.ScriptName,
			}},
			Needle: &observabilityNeedle{
				Value:     observabilityNeedleValue,
				IsRegex:   false,
				MatchCase: false,
			},
			OrderBy: &observabilityOrderBy{Value: "timestamp", Order: "desc"},
		},
	}

	var result telemetryQueryResult
	path := base + "/workers/observability/telemetry/query"
	if err := c.SendJSON(ctx, "POST", path, query, &result); err != nil {
		return nil, classifyObservabilityError(err)
	}

	evidence := make([]domain.Evidence, 0, len(result.Events.Events))
	for _, event := range result.Events.Events {
		parsed, ok := parseChannelEvent(event)
		if !ok {
			continue
		}
		evidence = append(evidence, parsed)
	}
	sort.SliceStable(evidence, func(i, j int) bool {
		return evidence[i].ObservedAt < evidence[j].ObservedAt
	})
	return evidence, nil
}

func classifyObservabilityError(err error) error {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case 403, 404, 405, 501:
			return &ObservabilityUnavailableError{Status: apiErr.Status}
		}
	}
	return err
}

// IsObservabilityUnauthorized reports an API token rejection. It is an
// authorization failure of the whole Cloudflare connection, not a missing
// Observability endpoint.
func IsObservabilityUnauthorized(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == 401
}

// ObservabilitySettings is the script-level logging configuration required for
// diagnostics. Field names match the Cloudflare script-settings API.
type ObservabilitySettings struct {
	Enabled          bool              `json:"enabled"`
	HeadSamplingRate float64           `json:"head_sampling_rate"`
	Logs             ObservabilityLogs `json:"logs"`
}

// ObservabilityLogs keeps persisted structured logs while disabling the noisy
// per-invocation log line.
type ObservabilityLogs struct {
	InvocationLogs bool `json:"invocation_logs"`
}

type scriptSettingsPatch struct {
	Observability ObservabilitySettings `json:"observability"`
}

// RequiredObservability is the settings the Worker release installs so
// diagnostics can query deskwand=channel_event lines.
func RequiredObservability() ObservabilitySettings {
	return ObservabilitySettings{
		Enabled:          true,
		HeadSamplingRate: 1,
		Logs:             ObservabilityLogs{InvocationLogs: false},
	}
}

// EnableObservability patches the script-level settings with the required
// logging configuration. It is an explicit step; install and upgrade do not
// call it automatically.
//
// PATCH /accounts/{account_id}/workers/scripts/{script_name}/script-settings
// Source:
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/
// Accepted permission group: Workers Scripts Write.
func (c *Client) EnableObservability(ctx context.Context, target domain.Target) error {
	path, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return err
	}
	return c.SendJSON(ctx, "PATCH", path+"/script-settings", scriptSettingsPatch{
		Observability: RequiredObservability(),
	}, nil)
}

func parseChannelEvent(event telemetryEvent) (domain.Evidence, bool) {
	payload, ok := decodeChannelPayload(event.Source)
	if !ok {
		// Some Workers Logs shapes put the raw message in $metadata.message.
		payload, ok = decodeChannelPayload(json.RawMessage(quoteJSONString(event.Metadata.Message)))
	}
	if !ok {
		return domain.Evidence{}, false
	}
	if payload.Deskwand != "channel_event" || payload.V != 1 {
		return domain.Evidence{}, false
	}
	if !allowedChannels[payload.Channel] || !allowedChannelEvents[payload.Event] {
		return domain.Evidence{}, false
	}

	versionID := payload.VersionID
	if versionID == "" {
		versionID = event.Workers.ScriptVersion.ID
	}
	observedAt := payload.At
	if _, err := time.Parse(time.RFC3339Nano, observedAt); err != nil {
		if event.Timestamp > 0 {
			observedAt = time.UnixMilli(event.Timestamp).UTC().Format(time.RFC3339Nano)
		} else {
			observedAt = ""
		}
	}

	return domain.Evidence{
		Kind:       payload.Channel,
		Source:     "cloudflare-logs",
		ObservedAt: observedAt,
		Detail:     payload.Event,
		VersionID:  versionID,
	}, true
}

func decodeChannelPayload(raw json.RawMessage) (channelEventPayload, bool) {
	var payload channelEventPayload
	if len(raw) == 0 {
		return payload, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return payload, false
		}
		trimmed = strings.TrimSpace(text)
	}
	if !strings.HasPrefix(trimmed, "{") {
		return payload, false
	}
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return payload, false
	}
	if payload.Deskwand == "" {
		// A structured log wrapper may nest the console argument under
		// "message"; try that shape without touching any other field.
		var wrapper struct {
			Message json.RawMessage `json:"message"`
		}
		if err := json.Unmarshal([]byte(trimmed), &wrapper); err == nil && len(wrapper.Message) > 0 {
			return decodeChannelPayload(wrapper.Message)
		}
	}
	return payload, true
}

// quoteJSONString encodes s as a JSON string so the shared decoder can accept
// a raw $metadata.message value.
func quoteJSONString(s string) string {
	encoded, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(encoded)
}
