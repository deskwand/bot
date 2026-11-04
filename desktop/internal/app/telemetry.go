package app

import (
	"log/slog"
	"strings"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/telemetry"
)

// TelemetryReporter is the anonymous usage reporter the service notifies. A
// nil reporter disables reporting entirely.
type TelemetryReporter interface {
	Ping()
	Feature(name string)
	// ConfigDone reports that setup completed. onSent runs only when the server
	// accepted the report; the caller persists the one-shot fact there.
	ConfigDone(onSent func())
}

// reportFeature records one successful use of a client feature, and for the
// operations that can finish setup it also reports the one-shot config_done.
// Only a published operation counts: failed, cancelled and needs_input results
// leave the caller's error alone and report nothing.
func (s *Service) reportFeature(name string, state string, err error) {
	if s.telemetry == nil || err != nil || state != deployment.StatePublished {
		return
	}
	s.telemetry.Feature(name)
	switch name {
	case telemetry.FeatureInstall, telemetry.FeatureImport, telemetry.FeaturePublish:
		s.reportConfigDone()
	}
}

// reportAction records one successful feature use that has no published state
// of its own, such as a backup.
func (s *Service) reportAction(name string, err error) {
	if s.telemetry == nil || err != nil {
		return
	}
	s.telemetry.Feature(name)
}

// reportConfigDone reports that setup completed, once in the installation's
// lifetime. The store owns that decision, so a second visit to a fully
// configured deployment reports nothing.
func (s *Service) reportConfigDone() {
	if s.telemetry == nil || s.telemetrySettings == nil {
		return
	}
	// Stay off the network once the installation has been recorded: evaluating
	// reads the deployment from Cloudflare, and every later publish would pay
	// that cost for a fact that can only be true once.
	state, err := s.telemetrySettings.Telemetry()
	if err != nil || state.ConfigDone {
		return
	}
	config, err := s.GetConfig()
	if err != nil || !configReady(config) {
		return
	}
	s.telemetry.ConfigDone(func() {
		if _, err := s.telemetrySettings.MarkConfigDone(); err != nil {
			slog.Error("app: record telemetry setup", "error", err)
		}
	})
}

// configReady reports whether a configuration summary has everything the bot
// needs to answer: an owner, both role models, and an active channel whose
// credentials exist.
func configReady(config ConfigDTO) bool {
	if len(config.OwnerUserIDs) == 0 || config.ButlerModel == nil || config.TaskModel == nil {
		return false
	}
	var secret string
	switch strings.ToLower(strings.TrimSpace(config.ActiveChannel)) {
	case "telegram":
		secret = "TELEGRAM_BOT_TOKEN"
	case "wechat":
		secret = "WECHAT_CREDENTIALS"
	default:
		return false
	}
	for _, name := range config.Secrets {
		if name.Name == secret {
			return name.Configured
		}
	}
	return false
}

// TelemetryEnabled reports the anonymous usage switch. Telemetry is on unless
// the user turned it off.
func (s *Service) TelemetryEnabled() bool {
	if s.telemetrySettings == nil {
		return false
	}
	state, err := s.telemetrySettings.Telemetry()
	if err != nil {
		return false
	}
	return state.Enabled
}

// SetTelemetryEnabled stores the switch. Turning it on reports a ping right
// away, so the dashboard sees the client without waiting for the heartbeat.
func (s *Service) SetTelemetryEnabled(enabled bool) error {
	if s.telemetrySettings == nil {
		return serviceUnavailable()
	}
	if err := s.telemetrySettings.SetTelemetryEnabled(enabled); err != nil {
		slog.Error("app: save telemetry preference", "error", err)
		return domain.Error{Code: CodeTelemetrySaveFailed, Message: "匿名统计设置未保存"}
	}
	if enabled && s.telemetry != nil {
		s.telemetry.Ping()
	}
	return nil
}
