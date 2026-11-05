package app

import (
	"context"
	"fmt"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/modelcatalog"
)

const defaultDiagnosticsWindow = 6 * time.Hour

// DiagnosticsSnapshotReader reads the deployed version and non-secret state.
type DiagnosticsSnapshotReader interface {
	ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error)
}

// ChannelEventReader reads sanitized channel events from Workers
// Observability. *cloudflare.Client implements it.
type ChannelEventReader interface {
	QueryChannelEvents(ctx context.Context, target domain.Target, since time.Duration) ([]domain.Evidence, error)
}

// DiagnosticsOptions configures a DiagnosticsService. Zero values use the
// defaults: a six-hour lookback and the model/telegram/wechat kinds.
type DiagnosticsOptions struct {
	Window time.Duration
	Kinds  []string
	Now    func() time.Time
	// Locale supplies the warning language; nil means zh.
	Locale func() string
}

// DiagnosticsReport is the frontend-safe status document. It carries no
// configuration bytes, secret names or raw log messages.
type DiagnosticsReport struct {
	AccountID  string                   `json:"accountId"`
	WorkerName string                   `json:"workerName"`
	VersionID  string                   `json:"versionId,omitempty"`
	ObservedAt string                   `json:"observedAt"`
	Items      []diagnostics.StatusItem `json:"items"`
	Warnings   []string                 `json:"warnings,omitempty"`
}

// DiagnosticsService combines the deployment snapshot, Workers Observability
// evidence and configured state. It never promotes local probes or old logs to
// a current cloud verification.
type DiagnosticsService struct {
	snapshots DiagnosticsSnapshotReader
	events    ChannelEventReader
	window    time.Duration
	kinds     []string
	now       func() time.Time
	locale    func() string
}

// NewDiagnosticsService returns a service with production defaults.
func NewDiagnosticsService(snapshots DiagnosticsSnapshotReader, events ChannelEventReader) *DiagnosticsService {
	return NewDiagnosticsServiceWithOptions(snapshots, events, DiagnosticsOptions{})
}

// NewDiagnosticsServiceWithOptions returns a service with explicit options.
func NewDiagnosticsServiceWithOptions(snapshots DiagnosticsSnapshotReader, events ChannelEventReader, options DiagnosticsOptions) *DiagnosticsService {
	window := options.Window
	if window <= 0 {
		window = defaultDiagnosticsWindow
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	kinds := options.Kinds
	if len(kinds) == 0 {
		kinds = []string{"model", "telegram", "wechat"}
	}

	return &DiagnosticsService{
		snapshots: snapshots,
		events:    events,
		window:    window,
		kinds:     append([]string(nil), kinds...),
		now:       now,
		locale:    options.Locale,
	}
}

func (s *DiagnosticsService) lang() string {
	if s.locale == nil {
		return i18n.ZH
	}
	return s.locale()
}

// Status reads the current deployment, queries the allowed logs and returns
// one status item per kind. An unavailable observability endpoint or missing
// logs produce unknown items and a warning, not a failed status call.
func (s *DiagnosticsService) Status(ctx context.Context, target domain.Target) (DiagnosticsReport, error) {
	report, _, err := s.status(ctx, target)
	return report, err
}

// ExportDiagnostics returns the allowlisted, sanitized JSON export.
func (s *DiagnosticsService) ExportDiagnostics(ctx context.Context, target domain.Target) ([]byte, error) {
	report, events, err := s.status(ctx, target)
	if err != nil {
		return nil, err
	}
	return diagnostics.Export(report.Items, events)
}

func (s *DiagnosticsService) status(ctx context.Context, target domain.Target) (DiagnosticsReport, []domain.Evidence, error) {
	if s == nil || s.snapshots == nil {
		return DiagnosticsReport{}, nil, fmt.Errorf("app: diagnostics snapshot reader is not wired")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return DiagnosticsReport{}, nil, fmt.Errorf("app: read deployment snapshot: %w", err)
	}

	nowFn := s.now
	if nowFn == nil {
		nowFn = time.Now
	}
	now := nowFn().UTC()
	observedAt := now.Format(time.RFC3339Nano)
	evidence := configuredEvidence(snapshot, observedAt)
	warnings := make([]string, 0)

	if s.events == nil {
		warnings = append(warnings, i18n.T(s.lang(), "app.diagnosticsNoLogsConnection"))
	} else {
		cloudEvents, queryErr := s.events.QueryChannelEvents(ctx, target, s.window)
		switch {
		case queryErr == nil:
			evidence = append(evidence, cloudEvents...)
			if len(cloudEvents) == 0 {
				warnings = append(warnings, i18n.T(s.lang(), "app.diagnosticsNoLogsFound"))
			}
		case cloudflare.IsObservabilityUnavailable(queryErr):
			warnings = append(warnings, i18n.T(s.lang(), "app.diagnosticsObservabilityUnavailable"))
		case cloudflare.IsObservabilityUnauthorized(queryErr):
			warnings = append(warnings, i18n.T(s.lang(), "app.diagnosticsObservabilityUnauthorized"))
		default:
			warnings = append(warnings, i18n.T(s.lang(), "app.diagnosticsReadFailed"))
		}
	}

	items := diagnostics.Summarize(s.lang(), s.kinds, evidence, snapshot.VersionID)
	return DiagnosticsReport{
		AccountID:  target.AccountID,
		WorkerName: target.ScriptName,
		VersionID:  snapshot.VersionID,
		ObservedAt: observedAt,
		Items:      items,
		Warnings:   warnings,
	}, evidence, nil
}

// configuredEvidence marks kinds that exist in the snapshot. It is deliberately
// separate from cloud evidence: a configured secret never becomes "verified".
func configuredEvidence(snapshot domain.Snapshot, observedAt string) []domain.Evidence {
	secrets := make(map[string]bool, len(snapshot.SecretNames))
	for _, name := range snapshot.SecretNames {
		secrets[name] = true
	}

	evidence := make([]domain.Evidence, 0, 3)
	if secrets["WECHAT_CREDENTIALS"] {
		evidence = append(evidence, domain.Evidence{
			Kind:       "wechat",
			Source:     diagnostics.SourceConfig,
			ObservedAt: observedAt,
			Detail:     "configured",
		})
	}
	if secrets["TELEGRAM_BOT_TOKEN"] {
		evidence = append(evidence, domain.Evidence{
			Kind:       "telegram",
			Source:     diagnostics.SourceConfig,
			ObservedAt: observedAt,
			Detail:     "configured",
		})
	}
	if modelsConfigured(snapshot.ConfigJSON, secrets) {
		evidence = append(evidence, domain.Evidence{
			Kind:       "model",
			Source:     diagnostics.SourceConfig,
			ObservedAt: observedAt,
			Detail:     "configured",
		})
	}
	return evidence
}

func modelsConfigured(configJSON []byte, secrets map[string]bool) bool {
	if len(configJSON) == 0 {
		return false
	}
	doc, err := modelcatalog.ParseModels(configJSON)
	if err != nil {
		return false
	}
	for _, ref := range []modelcatalog.RoleRef{doc.Butler, doc.Task} {
		if modelcatalog.IsKeyless(ref.Provider) {
			return true
		}
	}
	for _, name := range modelcatalog.RequiredSecretNames(doc) {
		if secrets[name] {
			return true
		}
	}
	return false
}
