package cloudflare_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/cloudflare/cloudflaretest"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestQueryChannelEventsParsesSanitizedEvidence(t *testing.T) {
	target := domain.Target{AccountID: testAccountID, ScriptName: "deskwand-bot"}
	wantPath := "/client/v4/accounts/" + testAccountID + "/workers/observability/telemetry/query"

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != wantPath {
			t.Fatalf("path = %q, want %q", r.URL.Path, wantPath)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q", r.Method)
		}
		var body struct {
			View      string `json:"view"`
			QueryID   string `json:"queryId"`
			Limit     int    `json:"limit"`
			Timeframe struct {
				From int64 `json:"from"`
				To   int64 `json:"to"`
			} `json:"timeframe"`
			Parameters struct {
				Datasets []string `json:"datasets"`
				Filters  []struct {
					Key       string `json:"key"`
					Operation string `json:"operation"`
					Type      string `json:"type"`
					Value     string `json:"value"`
				} `json:"filters"`
				Needle *struct {
					Value string `json:"value"`
				} `json:"needle"`
				OrderBy *struct {
					Value string `json:"value"`
					Order string `json:"order"`
				} `json:"orderBy"`
			} `json:"parameters"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode query: %v", err)
		}
		if body.View != "events" || body.QueryID == "" || body.Limit <= 0 {
			t.Fatalf("unexpected query envelope: %+v", body)
		}
		if body.Timeframe.From <= 0 || body.Timeframe.To <= body.Timeframe.From {
			t.Fatalf("invalid timeframe: %+v", body.Timeframe)
		}
		if len(body.Parameters.Datasets) != 1 || body.Parameters.Datasets[0] != "cloudflare-workers" {
			t.Fatalf("datasets = %v", body.Parameters.Datasets)
		}
		if len(body.Parameters.Filters) != 1 || body.Parameters.Filters[0].Key != "$metadata.service" ||
			body.Parameters.Filters[0].Operation != "eq" || body.Parameters.Filters[0].Value != target.ScriptName {
			t.Fatalf("filters = %+v", body.Parameters.Filters)
		}
		if body.Parameters.Needle == nil || body.Parameters.Needle.Value != "channel_event" {
			t.Fatalf("needle = %+v", body.Parameters.Needle)
		}
		if body.Parameters.OrderBy == nil || body.Parameters.OrderBy.Value != "timestamp" || body.Parameters.OrderBy.Order != "desc" {
			t.Fatalf("orderBy = %+v", body.Parameters.OrderBy)
		}

		writeResult(t, w, map[string]any{
			"events": map[string]any{
				"count": 4,
				"events": []any{
					map[string]any{
						"source": map[string]any{
							"deskwand":  "channel_event",
							"v":         1,
							"versionId": "version-from-payload",
							"channel":   "telegram",
							"event":     "webhook_ok",
							"at":        "2026-11-02T10:02:00Z",
						},
						"timestamp": 1762070520000,
						"$metadata": map[string]any{"message": "ignored", "service": target.ScriptName},
					},
					map[string]any{
						"source": `{"deskwand":"channel_event","v":1,"channel":"wechat","event":"poll_ok","at":"2026-11-02T10:01:00Z"}`,
						"$workers": map[string]any{
							"scriptVersion": map[string]any{"id": "version-from-worker"},
						},
					},
					map[string]any{
						"source": map[string]any{
							"deskwand": "channel_event",
							"v":        1,
							"channel":  "wechat",
							"event":    "arbitrary_event",
						},
					},
					map[string]any{
						"source": `{"message":"not a deskwand event"}`,
					},
				},
			},
		})
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	events, err := client.QueryChannelEvents(context.Background(), target, 2*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2: %+v", len(events), events)
	}
	first := events[0]
	if first.Kind != "wechat" || first.Source != "cloudflare-logs" || first.Detail != "poll_ok" ||
		first.VersionID != "version-from-worker" || first.ObservedAt != "2026-11-02T10:01:00Z" {
		t.Fatalf("first = %+v", first)
	}
	second := events[1]
	if second.Kind != "telegram" || second.Detail != "webhook_ok" || second.VersionID != "version-from-payload" {
		t.Fatalf("second = %+v", second)
	}
}

func TestQueryChannelEventsFallsBackToMetadataMessageAndTimestamp(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeResult(t, w, map[string]any{
			"events": map[string]any{
				"events": []any{
					map[string]any{
						"source":    "",
						"timestamp": int64(1762070460000),
						"$metadata": map[string]any{
							"message": `{"deskwand":"channel_event","v":1,"channel":"wechat","event":"poll_error","versionId":"version-1","at":"not-a-time"}`,
						},
					},
				},
			},
		})
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	events, err := client.QueryChannelEvents(context.Background(), domain.Target{
		AccountID:  testAccountID,
		ScriptName: "deskwand-bot",
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d", len(events))
	}
	wantTime := time.UnixMilli(1762070460000).UTC().Format(time.RFC3339Nano)
	if events[0].ObservedAt != wantTime {
		t.Fatalf("observedAt = %q, want %q", events[0].ObservedAt, wantTime)
	}
	if events[0].Detail != "poll_error" || events[0].VersionID != "version-1" {
		t.Fatalf("event = %+v", events[0])
	}
}

func TestQueryChannelEventsUnavailableIsTyped(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"result":null}`))
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	_, err := client.QueryChannelEvents(context.Background(), domain.Target{
		AccountID:  testAccountID,
		ScriptName: "deskwand-bot",
	}, time.Hour)
	if !cloudflare.IsObservabilityUnavailable(err) {
		t.Fatalf("err = %v, want typed unavailable", err)
	}
	var unavailable *cloudflare.ObservabilityUnavailableError
	if !errors.As(err, &unavailable) || unavailable.Status != http.StatusForbidden {
		t.Fatalf("typed error = %#v", unavailable)
	}
}

func TestQueryChannelEvents401IsAuthFailureNotUnavailable(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"result":null}`))
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	_, err := client.QueryChannelEvents(context.Background(), domain.Target{
		AccountID:  testAccountID,
		ScriptName: "deskwand-bot",
	}, time.Hour)
	if err == nil {
		t.Fatal("expected an auth error")
	}
	if cloudflare.IsObservabilityUnavailable(err) {
		t.Fatalf("401 became unavailable: %v", err)
	}
	if !cloudflare.IsObservabilityUnauthorized(err) {
		t.Fatalf("401 was not recognized as an auth error: %v", err)
	}
	var apiErr *cloudflare.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("err = %#v", err)
	}
}

func TestEnableObservabilityPatchesScriptSettings(t *testing.T) {
	target := domain.Target{AccountID: testAccountID, ScriptName: "deskwand-bot"}
	wantPath := "/client/v4/accounts/" + testAccountID + "/workers/scripts/" + target.ScriptName + "/script-settings"

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != wantPath {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		var body struct {
			Observability struct {
				Enabled          bool    `json:"enabled"`
				HeadSamplingRate float64 `json:"head_sampling_rate"`
				Logs             struct {
					InvocationLogs bool `json:"invocation_logs"`
				} `json:"logs"`
			} `json:"observability"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if !body.Observability.Enabled || body.Observability.HeadSamplingRate != 1 ||
			body.Observability.Logs.InvocationLogs {
			t.Fatalf("observability body = %+v", body.Observability)
		}
		writeResult(t, w, map[string]any{})
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	if err := client.EnableObservability(context.Background(), target); err != nil {
		t.Fatal(err)
	}
}

func TestQueryChannelEventsRejectsInvalidTarget(t *testing.T) {
	client, _ := cloudflaretest.NewServerClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("invalid target must not send a request")
	}))

	if _, err := client.QueryChannelEvents(context.Background(), domain.Target{
		AccountID:  "not-an-account",
		ScriptName: "deskwand-bot",
	}, time.Hour); err == nil {
		t.Fatal("expected an account validation error")
	}
	if _, err := client.QueryChannelEvents(context.Background(), domain.Target{
		AccountID:  testAccountID,
		ScriptName: "Not A Worker",
	}, time.Hour); err == nil {
		t.Fatal("expected a script validation error")
	}
}
