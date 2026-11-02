package diagnostics

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// RedactedValue replaces any value the redactor removes.
const RedactedValue = "[REDACTED]"

var (
	// Telegram bot API tokens appear in request URLs as bot<digits>:<token>,
	// including the percent-encoded colon some clients produce.
	telegramTokenPattern = regexp.MustCompile(`(?i)\bbot\d+(?::|%3A)[A-Za-z0-9_%.-]+`)
	// Query parameters whose names end in token/key/secret (token, api_key,
	// access-token, secret_key, ...).
	querySecretPattern = regexp.MustCompile(`(?i)([?&][\w-]*(?:token|key|secret)=)[^&\s#]+`)
	// Authorization headers with any scheme (Bearer, Basic, Token, ...), and
	// API key headers copied into a provider error.
	authorizationHeaderPattern = regexp.MustCompile(`(?i)(authorization\s*:\s*)(?:[a-z][a-z0-9_-]*\s+)?[^\s,;"']+`)
	apiKeyHeaderPattern        = regexp.MustCompile(`(?i)(x-(?:api-key|goog-api-key)\s*:\s*)[^\s,;"']+`)
	// A bare bearer credential quoted in an error message.
	bearerPattern = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+`)
	// Common provider key prefixes, even when the caller did not register it.
	prefixedKeyPattern = regexp.MustCompile(`\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b`)
)

// Redactor removes registered secret values and recognizable credential
// shapes from arbitrary diagnostic text. It performs replacements in place on
// a copy of the input; it never returns the original secret in an error.
type Redactor struct {
	secrets []string
}

// NewRedactor returns a redactor that removes the supplied secret values in
// addition to the built-in credential patterns.
func NewRedactor(secrets ...string) *Redactor {
	redactor := &Redactor{}
	for _, secret := range secrets {
		redactor.Add(secret)
	}
	return redactor
}

// Add registers a secret value. Empty values are ignored. The longest values
// are replaced first so a secret that contains another registered secret is
// still fully removed.
func (r *Redactor) Add(secret string) {
	if r == nil || secret == "" {
		return
	}
	for _, existing := range r.secrets {
		if existing == secret {
			return
		}
	}
	r.secrets = append(r.secrets, secret)
	sort.Slice(r.secrets, func(i, j int) bool {
		return len(r.secrets[i]) > len(r.secrets[j])
	})
}

// Redact returns text with credentials removed. A nil Redactor still applies
// the built-in patterns.
func (r *Redactor) Redact(text string) string {
	if text == "" {
		return text
	}
	if r != nil {
		for _, secret := range r.secrets {
			if secret != "" {
				text = strings.ReplaceAll(text, secret, RedactedValue)
			}
		}
	}
	text = authorizationHeaderPattern.ReplaceAllString(text, "${1}"+RedactedValue)
	text = apiKeyHeaderPattern.ReplaceAllString(text, "${1}"+RedactedValue)
	text = querySecretPattern.ReplaceAllString(text, "${1}"+RedactedValue)
	text = bearerPattern.ReplaceAllString(text, "Bearer "+RedactedValue)
	text = telegramTokenPattern.ReplaceAllString(text, "bot[REDACTED]:"+RedactedValue)
	text = prefixedKeyPattern.ReplaceAllString(text, RedactedValue)
	return text
}

type exportedItem struct {
	Kind       string `json:"kind"`
	State      string `json:"state"`
	Source     string `json:"source"`
	ObservedAt string `json:"observedAt"`
	Detail     string `json:"detail"`
}

type exportedEvidence struct {
	Kind       string `json:"kind"`
	Source     string `json:"source"`
	ObservedAt string `json:"observedAt"`
	Detail     string `json:"detail"`
	VersionID  string `json:"versionId"`
}

type exportDocument struct {
	SchemaVersion int                `json:"schemaVersion"`
	Items         []exportedItem     `json:"items"`
	Events        []exportedEvidence `json:"events"`
}

// Export writes the fixed allowlist of status and evidence fields. It applies
// the built-in credential patterns but has no registered secret values; use
// ExportWithRedactor when the caller holds secrets in memory.
func Export(items []StatusItem, events []domain.Evidence) ([]byte, error) {
	return ExportWithRedactor(items, events, NewRedactor())
}

// ExportWithRedactor is Export with caller-registered secret values. Only the
// fields declared in exportedItem and exportedEvidence are serialized; raw
// evidence values never pass through.
func ExportWithRedactor(items []StatusItem, events []domain.Evidence, redactor *Redactor) ([]byte, error) {
	document := exportDocument{
		SchemaVersion: 1,
		Items:         make([]exportedItem, 0, len(items)),
		Events:        make([]exportedEvidence, 0, len(events)),
	}
	clean := func(value string) string { return redactor.Redact(value) }

	for _, item := range items {
		document.Items = append(document.Items, exportedItem{
			Kind:       clean(item.Kind),
			State:      clean(item.State),
			Source:     clean(item.Source),
			ObservedAt: clean(item.ObservedAt),
			Detail:     clean(item.Detail),
		})
	}
	for _, event := range events {
		document.Events = append(document.Events, exportedEvidence{
			Kind:       clean(event.Kind),
			Source:     clean(event.Source),
			ObservedAt: clean(event.ObservedAt),
			Detail:     clean(event.Detail),
			VersionID:  clean(event.VersionID),
		})
	}
	return json.MarshalIndent(document, "", "  ")
}
