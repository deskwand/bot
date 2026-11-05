// Package mcpcatalog holds the desktop client's built-in catalog of remote MCP
// services. The catalog is embedded so the binary does not depend on repository
// files. Build turns one entry into an mcpServers element and the secret edits
// that carry the user's values.
package mcpcatalog

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

//go:embed catalog.json
var embeddedCatalog []byte

// Text is one localized string in the catalog. A missing English text falls
// back to Chinese.
type Text struct {
	Zh string `json:"zh"`
	En string `json:"en"`
}

// In returns the text for locale.
func (t Text) In(locale string) string {
	if locale == i18n.EN && t.En != "" {
		return t.En
	}
	return t.Zh
}

// Field is one value the user supplies for a catalog entry.
type Field struct {
	Key        string `json:"key"`
	Label      string `json:"label"`
	Help       string `json:"help"`
	HelpURL    string `json:"helpUrl"`
	Placement  string `json:"placement"`            // "header" | "url"
	HeaderName string `json:"headerName,omitempty"` // placement header
	Prefix     string `json:"prefix,omitempty"`     // e.g. "Bearer "
}

// Entry is one service listed in the catalog.
type Entry struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Category        string   `json:"category"`
	Description     string   `json:"description"`
	URL             string   `json:"url"`
	OAuth           bool     `json:"oauth"`
	Fields          []Field  `json:"fields"`
	AutoApprove     []string `json:"autoApprove,omitempty"`
	RequireApproval []string `json:"requireApproval,omitempty"`
}

type catalog struct {
	SchemaVersion int        `json:"schemaVersion"`
	Entries       []rawEntry `json:"entries"`
}

type rawEntry struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Category        Text       `json:"category"`
	Description     Text       `json:"description"`
	URL             string     `json:"url"`
	OAuth           bool       `json:"oauth"`
	Fields          []rawField `json:"fields"`
	AutoApprove     []string   `json:"autoApprove,omitempty"`
	RequireApproval []string   `json:"requireApproval,omitempty"`
}

type rawField struct {
	Key        string `json:"key"`
	Label      Text   `json:"label"`
	Help       Text   `json:"help"`
	HelpURL    string `json:"helpUrl"`
	Placement  string `json:"placement"`
	HeaderName string `json:"headerName,omitempty"`
	Prefix     string `json:"prefix,omitempty"`
}

var (
	envReferencePattern = regexp.MustCompile(`^env:(MCP_[A-Z0-9_]{1,64})$`)
	urlReferencePattern = regexp.MustCompile(`\{env:(MCP_[A-Z0-9_]{1,64})\}`)

	builtin = mustCatalog()
)

func mustCatalog() catalog {
	var parsed catalog
	if err := json.Unmarshal(embeddedCatalog, &parsed); err != nil {
		panic("mcpcatalog: parse embedded catalog: " + err.Error())
	}
	return parsed
}

// All returns the catalog entries with their text in locale.
func All(locale string) []Entry {
	entries := make([]Entry, 0, len(builtin.Entries))
	for _, entry := range builtin.Entries {
		entries = append(entries, entry.localized(locale))
	}
	return entries
}

// Lookup finds an entry by ID with its text in locale.
func Lookup(locale, id string) (Entry, bool) {
	for _, entry := range builtin.Entries {
		if entry.ID == id {
			return entry.localized(locale), true
		}
	}
	return Entry{}, false
}

func (e rawEntry) localized(locale string) Entry {
	out := Entry{
		ID:              e.ID,
		Name:            e.Name,
		Category:        e.Category.In(locale),
		Description:     e.Description.In(locale),
		URL:             e.URL,
		OAuth:           e.OAuth,
		AutoApprove:     e.AutoApprove,
		RequireApproval: e.RequireApproval,
	}
	if e.Fields != nil {
		out.Fields = make([]Field, 0, len(e.Fields))
		for _, field := range e.Fields {
			out.Fields = append(out.Fields, Field{
				Key:        field.Key,
				Label:      field.Label.In(locale),
				Help:       field.Help.In(locale),
				HelpURL:    field.HelpURL,
				Placement:  field.Placement,
				HeaderName: field.HeaderName,
				Prefix:     field.Prefix,
			})
		}
	}
	return out
}

// Build turns an entry plus user values into one mcpServers element and the
// secret edits that carry the values. name is the server name the caller chose.
func Build(locale string, entry Entry, name string, values map[string]string) (map[string]any, []domain.SecretEdit, error) {
	server := map[string]any{
		"name":            name,
		"url":             entry.URL,
		"description":     entry.Description,
		"catalogId":       entry.ID,
		"oauth":           entry.OAuth,
		"approvalPolicy":  "writes",
		"autoApprove":     append([]string{}, entry.AutoApprove...),
		"requireApproval": append([]string{}, entry.RequireApproval...),
	}
	headers := map[string]any{}
	secrets := make([]domain.SecretEdit, 0, len(entry.Fields))
	serverURL := entry.URL

	for _, field := range entry.Fields {
		value := strings.TrimSpace(values[field.Key])
		if value == "" {
			return nil, nil, fmt.Errorf("%s", i18n.T(locale, "mcpcatalog.missingField", entry.Name, field.Label))
		}
		secretName := SecretName(name, field.Key)
		secretValue := value
		if field.Prefix != "" {
			secretValue = field.Prefix + value
		}
		secrets = append(secrets, domain.NewSecretEdit(secretName, domain.SecretReplace, secretValue))

		switch field.Placement {
		case "header":
			if field.HeaderName == "" {
				return nil, nil, fmt.Errorf("mcpcatalog: entry %q field %q has no header name", entry.ID, field.Key)
			}
			headers[field.HeaderName] = "env:" + secretName
		case "url":
			serverURL = strings.ReplaceAll(serverURL, "{field:"+field.Key+"}", "{env:"+secretName+"}")
		default:
			return nil, nil, fmt.Errorf("mcpcatalog: entry %q field %q has unsupported placement %q", entry.ID, field.Key, field.Placement)
		}
	}
	if strings.Contains(serverURL, "{field:") {
		return nil, nil, fmt.Errorf("mcpcatalog: entry %q has an unresolved field placeholder", entry.ID)
	}
	server["url"] = serverURL
	if len(headers) > 0 {
		server["headers"] = headers
	}
	return server, secrets, nil
}

// SecretName returns the MCP_* secret name for one server field.
func SecretName(server, field string) string {
	return "MCP_" + strings.ToUpper(server) + "_" + strings.ToUpper(field)
}

// Orphaned returns MCP_* secret names referenced by removed but not by kept.
func Orphaned(removed map[string]any, kept []map[string]any) []string {
	removedNames := referencedSecrets(removed)
	keptNames := map[string]bool{}
	for _, server := range kept {
		for name := range referencedSecrets(server) {
			keptNames[name] = true
		}
	}
	orphaned := make([]string, 0, len(removedNames))
	for name := range removedNames {
		if !keptNames[name] {
			orphaned = append(orphaned, name)
		}
	}
	sort.Strings(orphaned)
	return orphaned
}

func referencedSecrets(server map[string]any) map[string]bool {
	names := map[string]bool{}
	if server == nil {
		return names
	}
	if rawURL, ok := server["url"].(string); ok {
		for _, match := range urlReferencePattern.FindAllStringSubmatch(rawURL, -1) {
			names[match[1]] = true
		}
	}
	switch headers := server["headers"].(type) {
	case map[string]any:
		for _, raw := range headers {
			if value, ok := raw.(string); ok {
				addHeaderReference(names, value)
			}
		}
	case map[string]string:
		for _, value := range headers {
			addHeaderReference(names, value)
		}
	}
	return names
}

func addHeaderReference(names map[string]bool, value string) {
	if match := envReferencePattern.FindStringSubmatch(value); match != nil {
		names[match[1]] = true
	}
}
