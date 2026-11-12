package i18n

var enCatalog = map[string]string{
	"catalog.keepDepartingModel":  "Keep the current model %s/%s and its existing context window until the Butler has applied the switch; then change or remove it.",
	"catalog.windowDowngrade":     "Cannot switch the Butler model: %s/%s has a %d-token context window, but %s/%s has only %d tokens. The target is less than one quarter of the current window. Choose a model with at least one quarter of the current window.",
	"catalog.windowUnknown":       "Cannot verify the context windows for this Butler model switch. Update the model catalog and check custom model window settings.",
	"catalog.provider.workers-ai": "Cloudflare Workers AI (free tier)",
	"catalog.keySeparator":        ", ",
	"catalog.missingModelKeys":    "Missing model keys: %s",
	"catalog.modelUnavailable":    "Model %s/%s is unavailable; choose another model on the Brain page",
}
