// Package diagnostics turns sanitized runtime observations into status items
// with an explicit source, observation time and state. It never treats missing
// evidence as success or failure.
package diagnostics

import (
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
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
func Summarize(kinds []string, events []domain.Evidence, currentVersion string) []StatusItem {
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
		items = append(items, summarizeKind(kind, kindEvents, currentVersion))
	}
	return items
}

func summarizeKind(kind string, events []domain.Evidence, currentVersion string) StatusItem {
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
		state, detail := classify(currentCloud.Detail)
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
			version = "未知"
		}
		observed := staleCloud.Detail
		if observed == "" {
			observed = "日志"
		}
		return StatusItem{
			Kind:       kind,
			State:      StateUnverified,
			Source:     staleCloud.Source,
			ObservedAt: staleCloud.ObservedAt,
			Detail:     "旧版本 " + version + " 的 " + observed + "，不是当前版本；未据此判定当前状态",
		}
	case localOrUser != nil:
		state, detail := classify(localOrUser.Detail)
		switch localOrUser.Source {
		case SourceUser:
			detail += "（用户确认，非云端日志）"
		case SourceLocal:
			// A probe from this machine cannot establish the cloud runtime
			// state, even when the provider accepted the key.
			state = StateUnverified
			detail += "（本机探测，不代表云端收发正常）"
		default:
			// An unrecognized source is never allowed to manufacture a
			// verified state.
			state = StateUnverified
			detail += "（来源未知）"
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
			Detail:     "已配置；尚无当前版本的云端日志",
		}
	default:
		return StatusItem{
			Kind:       kind,
			State:      StateUnknown,
			Source:     "",
			ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Detail:     "未找到可用证据（日志可能未保存或被采样）",
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
func classify(detail string) (string, string) {
	trimmed := strings.TrimSpace(detail)
	switch strings.ToLower(trimmed) {
	case "configured":
		return StateConfigured, trimmed
	case "":
		return StateUnverified, "证据没有事件说明"
	case "heartbeat":
		return StateUnverified, trimmed + "（心跳不代表轮询成功）"
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
