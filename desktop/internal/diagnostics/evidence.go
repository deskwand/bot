// Package diagnostics turns sanitized runtime observations into status items
// with an explicit source, observation time and state. It never treats missing
// evidence as success or failure.
package diagnostics

import (
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Status states shown by the client. A runtime observation is only "verified"
// when it comes from a cloud log of the currently deployed version.
const (
	StateConfigured  = "configured"
	StateUnverified  = "unverified"
	StateVerified    = "verified"
	StateExpired     = "expired"
	StateUnavailable = "unavailable"
	StateUnknown     = "unknown"
)

// Evidence sources used by the application. Cloud evidence is the only source
// that can establish a cloud-runtime state for a specific version.
const (
	SourceCloudLogs = "cloudflare-logs"
	SourceLocal     = "local"
	SourceUser      = "user"
	SourceConfig    = "config"
)

// StatusItem is one row of the diagnostics view. Every field is a fixed,
// display-safe string; message content, user identity and tokens never enter
// this type.
type StatusItem struct {
	Kind       string `json:"kind"`
	State      string `json:"state"`
	Source     string `json:"source"`
	ObservedAt string `json:"observedAt"`
	Detail     string `json:"detail"`
}

// Summarize returns one item per requested Kind. Only evidence of that Kind is
// considered. Cloud evidence must carry the current version to count as a
// current observation; evidence from another version is reported as
// "unverified" instead of being reused as success. A Kind without any evidence
// is "unknown".
func Summarize(locale string, kinds []string, events []domain.Evidence, currentVersion string) []StatusItem {
	items := make([]StatusItem, 0, len(kinds))
	seen := make(map[string]bool, len(kinds))
	for _, kind := range kinds {
		if seen[kind] {
			continue
		}
		seen[kind] = true

		kindEvents := make([]domain.Evidence, 0, len(events))
		for _, event := range events {
			if event.Kind != kind {
				continue
			}
			// A rejected webhook describes an inbound request, not the
			// channel's ability to receive or send. It must not become the
			// state while an ok/expired/error observation exists.
			if strings.EqualFold(strings.TrimSpace(event.Detail), "webhook_rejected") {
				continue
			}
			kindEvents = append(kindEvents, event)
		}
		items = append(items, summarizeKind(locale, kind, kindEvents, currentVersion))
	}
	return items
}

func summarizeKind(locale, kind string, events []domain.Evidence, currentVersion string) StatusItem {
	var currentCloud, staleCloud, localOrUser, configured *domain.Evidence

	for index := range events {
		event := &events[index]
		switch {
		case isCloudSource(event.Source):
			if currentVersion != "" && event.VersionID == currentVersion {
				currentCloud = newest(currentCloud, event)
			} else {
				staleCloud = newest(staleCloud, event)
			}
		case isConfiguredEvidence(*event):
			configured = newest(configured, event)
		default:
			localOrUser = newest(localOrUser, event)
		}
	}

	switch {
	case currentCloud != nil:
		state, detail := classify(locale, currentCloud.Detail)
		return StatusItem{
			Kind:       kind,
			State:      state,
			Source:     currentCloud.Source,
			ObservedAt: currentCloud.ObservedAt,
			Detail:     detail,
		}
	case staleCloud != nil:
		version := staleCloud.VersionID
		if version == "" {
			version = i18n.T(locale, "diagnostics.versionUnknown")
		}
		observed := staleCloud.Detail
		if observed == "" {
			observed = i18n.T(locale, "diagnostics.logs")
		}
		return StatusItem{
			Kind:       kind,
			State:      StateUnverified,
			Source:     staleCloud.Source,
			ObservedAt: staleCloud.ObservedAt,
			Detail:     i18n.T(locale, "diagnostics.staleVersion", version, observed),
		}
	case localOrUser != nil:
		state, detail := classify(locale, localOrUser.Detail)
		switch localOrUser.Source {
		case SourceUser:
			detail += i18n.T(locale, "diagnostics.userConfirmed")
		case SourceLocal:
			// A probe from this machine cannot establish the cloud runtime
			// state, even when the provider accepted the key.
			state = StateUnverified
			detail += i18n.T(locale, "diagnostics.localProbe")
		default:
			// An unrecognized source is never allowed to manufacture a
			// verified state.
			state = StateUnverified
			detail += i18n.T(locale, "diagnostics.unknownSource")
		}
		return StatusItem{
			Kind:       kind,
			State:      state,
			Source:     localOrUser.Source,
			ObservedAt: localOrUser.ObservedAt,
			Detail:     detail,
		}
	case configured != nil:
		return StatusItem{
			Kind:       kind,
			State:      StateConfigured,
			Source:     configured.Source,
			ObservedAt: configured.ObservedAt,
			Detail:     i18n.T(locale, "diagnostics.configuredNoLogs"),
		}
	default:
		return StatusItem{
			Kind:       kind,
			State:      StateUnknown,
			Source:     "",
			ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Detail:     i18n.T(locale, "diagnostics.noEvidence"),
		}
	}
}

func isCloudSource(source string) bool {
	return source == SourceCloudLogs
}

func isConfiguredEvidence(event domain.Evidence) bool {
	if event.Source == SourceConfig {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(event.Detail), "configured")
}

// classify maps an exact event name to a state. The detail is preserved for
// cloud evidence; local and user callers append their own qualifier. Only the
// fixed names emitted by the Worker and the diagnostics probes are accepted,
// so a message that merely contains "ok" cannot become a success.
func classify(locale, detail string) (string, string) {
	trimmed := strings.TrimSpace(detail)
	switch strings.ToLower(trimmed) {
	case "configured":
		return StateConfigured, trimmed
	case "":
		return StateUnverified, i18n.T(locale, "diagnostics.noDetail")
	case "heartbeat":
		return StateUnverified, i18n.T(locale, "diagnostics.heartbeat", trimmed)
	case "user_confirmed", "confirmed":
		return StateVerified, trimmed
	case "poll_expired":
		return StateExpired, trimmed
	case "poll_error", "webhook_rejected", "probe_error":
		return StateUnavailable, trimmed
	case "poll_ok", "send_ok", "webhook_ok", "probe_ok":
		return StateVerified, trimmed
	default:
		return StateUnverified, trimmed
	}
}

func newest(current, candidate *domain.Evidence) *domain.Evidence {
	if current == nil {
		return candidate
	}
	if observedAfter(candidate.ObservedAt, current.ObservedAt) {
		return candidate
	}
	return current
}

func observedAfter(candidate, current string) bool {
	candidateTime, candidateOK := parseObserved(candidate)
	currentTime, currentOK := parseObserved(current)
	switch {
	case candidateOK && currentOK:
		return candidateTime.After(currentTime)
	case candidateOK:
		return true
	case currentOK:
		return false
	default:
		return candidate > current
	}
}

func parseObserved(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}
