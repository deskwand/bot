package app

import (
	"context"
	"fmt"
	"time"

	"github.com/deskwand/bot/desktop/internal/container"
	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// ContainerDiagnostics implements StatusService for a container target. It
// reads only the SSH host and the remote .env: a configured channel is never
// reported as verified.
type ContainerDiagnostics struct {
	Runtime ContainerRuntime
	Now     func() time.Time
	Locale  func() string
}

func (d *ContainerDiagnostics) lang() string {
	if d == nil || d.Locale == nil {
		return i18n.ZH
	}
	return d.Locale()
}

func (d *ContainerDiagnostics) clock() time.Time {
	if d.Now == nil {
		return time.Now()
	}
	return d.Now()
}

// Status reports the container runtime plus the configured entry channels.
func (d *ContainerDiagnostics) Status(ctx context.Context, target domain.Target) (DiagnosticsReport, error) {
	if d == nil || d.Runtime == nil {
		return DiagnosticsReport{}, fmt.Errorf("app: container diagnostics runtime is not wired")
	}
	status, err := d.Runtime.Status(ctx, target)
	if err != nil {
		return DiagnosticsReport{}, err
	}
	observedAt := d.clock().UTC().Format(time.RFC3339Nano)
	snapshot := domain.Snapshot{}
	if status.Reachable {
		snapshot, err = d.Runtime.ReadSnapshot(ctx, target)
		if err != nil {
			return DiagnosticsReport{}, err
		}
	}
	items := []diagnostics.StatusItem{
		d.containerItem(status, observedAt),
		d.channelItem("telegram", "TELEGRAM_BOT_TOKEN", snapshot, observedAt),
		d.channelItem("wechat", "WECHAT_CREDENTIALS", snapshot, observedAt),
	}
	return DiagnosticsReport{
		WorkerName: d.targetName(target),
		ObservedAt: observedAt,
		Items:      items,
	}, nil
}

// targetName is the user-facing name of target. A local target has no host
// address, so the name comes from the app's language.
func (d *ContainerDiagnostics) targetName(target domain.Target) string {
	if target.IsContainer() && target.Host.IsLocal() {
		return i18n.T(d.lang(), "app.localTargetName")
	}
	return target.DisplayName()
}

// ExportDiagnostics returns the sanitized JSON export of the same report.
func (d *ContainerDiagnostics) ExportDiagnostics(ctx context.Context, target domain.Target) ([]byte, error) {
	report, err := d.Status(ctx, target)
	if err != nil {
		return nil, err
	}
	return diagnostics.Export(report.Items, nil)
}

func (d *ContainerDiagnostics) containerItem(status container.RuntimeStatus, observedAt string) diagnostics.StatusItem {
	item := diagnostics.StatusItem{
		Kind:       "container",
		Source:     diagnostics.SourceLocal,
		ObservedAt: observedAt,
	}
	switch {
	case !status.Reachable:
		item.State = diagnostics.StateUnavailable
		item.Detail = i18n.T(d.lang(), "app.containerUnreachable")
	case !status.Running:
		item.State = diagnostics.StateUnavailable
		item.Detail = i18n.T(d.lang(), "app.containerNotRunning")
	case status.Health != "healthy":
		item.State = diagnostics.StateUnavailable
		item.Detail = i18n.T(d.lang(), "app.containerNotReady")
	default:
		item.State = diagnostics.StateVerified
		item.Detail = status.Health
	}
	return item
}

func (d *ContainerDiagnostics) channelItem(kind, secret string, snapshot domain.Snapshot, observedAt string) diagnostics.StatusItem {
	item := diagnostics.StatusItem{
		Kind:       kind,
		Source:     diagnostics.SourceConfig,
		ObservedAt: observedAt,
		State:      diagnostics.StateUnknown,
		Detail:     "not_configured",
	}
	for _, name := range snapshot.SecretNames {
		if name == secret {
			item.State = diagnostics.StateConfigured
			item.Detail = "configured"
			break
		}
	}
	return item
}
