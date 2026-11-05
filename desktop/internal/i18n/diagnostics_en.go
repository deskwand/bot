package i18n

var enDiagnostics = map[string]string{
	"diagnostics.versionUnknown":   "Unknown",
	"diagnostics.logs":             "logs",
	"diagnostics.staleVersion":     "Logs in old version %s: %s, not the current version; the current state was not determined from them",
	"diagnostics.userConfirmed":    " (confirmed by the user, not a cloud log)",
	"diagnostics.localProbe":       " (local probe, does not prove cloud send/receive)",
	"diagnostics.unknownSource":    " (unknown source)",
	"diagnostics.configuredNoLogs": "Configured; no cloud logs for the current version yet",
	"diagnostics.noEvidence":       "No usable evidence found (logs may not be stored or may be sampled)",
	"diagnostics.noDetail":         "The evidence has no event description",
	"diagnostics.heartbeat":        "%s (a heartbeat does not prove polling works)",
}
