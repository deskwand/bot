package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/modelcatalog"
)

// Merge applies the whitelisted UI patch and secret edits to the configuration
// read from base. It checks the draft fingerprint first, so a stale UI draft
// can never overwrite newer remote settings.
//
// Merge does not read Cloudflare and does not keep a second copy of the
// document: the returned PublishPlan is the only result a publish step may
// consume.
func Merge(base domain.Snapshot, change domain.Change) (domain.PublishPlan, error) {
	if base.Fingerprint == "" || change.BaseFingerprint != base.Fingerprint {
		return domain.PublishPlan{}, domain.Error{
			Code:    domain.CONFIG_CONFLICT,
			Message: "the configuration changed since it was read; refresh before publishing",
		}
	}
	if base.VersionID == "" {
		return domain.PublishPlan{}, domain.Error{
			Code:    domain.NO_ACTIVE_VERSION,
			Message: "the deployment has no version receiving traffic; refresh after a deployment is active",
		}
	}
	if err := validateSecretEdits(base.SecretNames, change.Secrets, referenceSecretNames(change.References)); err != nil {
		return domain.PublishPlan{}, err
	}
	if err := validateReferences(base.SecretNames, change.References, change.Secrets); err != nil {
		return domain.PublishPlan{}, err
	}
	if err := validateVars(change.Vars, base.SettingsJSON); err != nil {
		return domain.PublishPlan{}, err
	}

	document, empty, err := baseDocument(base.ConfigJSON)
	if err != nil {
		return domain.PublishPlan{}, err
	}
	if empty {
		// A brand new deployment may not have DESKWAND_CONFIG yet. Seed only
		// the required shell so an explicit owner + models patch can create it.
		document = map[string]any{
			"schemaVersion": json.Number("1"),
			"mcpServers":    []any{},
		}
	}

	if err := applyPatch(document, change.Patch); err != nil {
		return domain.PublishPlan{}, err
	}
	if err := applyReferences(document, change.References); err != nil {
		return domain.PublishPlan{}, err
	}

	canonical, err := domain.CanonicalJSON(document)
	if err != nil {
		return domain.PublishPlan{}, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "the merged configuration could not be encoded",
		}
	}
	if err := Validate(canonical); err != nil {
		message := "the merged configuration does not match schema version 1"
		if empty && patchIsEmpty(change.Patch) {
			message = "DESKWAND_CONFIG is not set; set owner.telegramUserIds and models before publishing"
		}
		if locations := schemaLocations(err); len(locations) > 0 {
			message += " at " + strings.Join(locations, ", ")
		}
		return domain.PublishPlan{}, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: message,
		}
	}
	modelsDoc, err := modelcatalog.ParseModels(canonical)
	if err != nil {
		return domain.PublishPlan{}, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "the merged configuration has unreadable model settings",
		}
	}
	if err := modelcatalog.ValidateModels(mergeLocale(change), modelsDoc, !change.AllowReleaseChange); err != nil {
		return domain.PublishPlan{}, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: err.Error(),
		}
	}

	if !empty {
		previous, err := modelcatalog.ParseModels(base.ConfigJSON)
		if err != nil {
			return domain.PublishPlan{}, domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "the current configuration has unreadable model settings"}
		}
		if err := validateButlerWindow(mergeLocale(change), previous, modelsDoc); err != nil {
			return domain.PublishPlan{}, err
		}
	}

	return domain.PublishPlan{
		BaseVersionID: base.VersionID,
		ConfigJSON:    canonical,
		Secrets:       cloneSecretEdits(change.Secrets),
		Vars:          cloneVars(change.Vars),
	}, nil
}

// mergeLocale is the language the deployment is set to speak. Callers that
// publish fill the patch locale from the desktop language before merging, so a
// validation error reads in the same language as the rest of the UI.
func mergeLocale(change domain.Change) string {
	if change.Patch.Locale == nil {
		return ""
	}
	return *change.Patch.Locale
}

func schemaLocations(err error) []string {
	var validation *SchemaValidationError
	if !errors.As(err, &validation) {
		return nil
	}
	locations := make([]string, 0, len(validation.Locations))
	for _, location := range validation.Locations {
		if location != "" {
			locations = append(locations, location)
		}
	}
	return locations
}

func baseDocument(raw []byte) (map[string]any, bool, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil, true, nil
	}
	value, err := domain.DecodeJSON(raw)
	if err != nil {
		return nil, false, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "the current DESKWAND_CONFIG is not valid JSON",
		}
	}
	document, ok := value.(map[string]any)
	if !ok {
		return nil, false, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "the current DESKWAND_CONFIG is not a JSON object",
		}
	}
	return document, false, nil
}

func applyPatch(document map[string]any, patch domain.EditablePatch) error {
	if patch.TelegramUserIDs != nil {
		owner, err := objectAt(document, "owner")
		if err != nil {
			return err
		}
		ids := make([]any, len(*patch.TelegramUserIDs))
		for i, id := range *patch.TelegramUserIDs {
			ids[i] = json.Number(strconv.FormatInt(id, 10))
		}
		owner["telegramUserIds"] = ids
	}

	if patch.McpServers != nil {
		servers, err := decodeMcpServers(*patch.McpServers)
		if err != nil {
			return err
		}
		document["mcpServers"] = servers
	}

	if patch.Locale != nil {
		document["locale"] = *patch.Locale
	}

	if patch.ApprovalMode != nil {
		document["approvalMode"] = *patch.ApprovalMode
	}

	if patch.SearchProvider != nil {
		document["search"] = map[string]any{"provider": *patch.SearchProvider}
	}

	if patch.ButlerModel == nil && patch.TaskModel == nil && patch.CustomProviders == nil {
		return nil
	}
	models, err := objectAt(document, "models")
	if err != nil {
		return err
	}
	if patch.CustomProviders != nil {
		providers, err := decodeCustomProviders(*patch.CustomProviders)
		if err != nil {
			return err
		}
		models["customProviders"] = mergeCustomProviders(models["customProviders"], providers)
	}
	if patch.ButlerModel != nil {
		value, err := decodeModel(*patch.ButlerModel)
		if err != nil {
			return err
		}
		models["butler"] = mergeRoleModel(models["butler"], value)
	}
	if patch.TaskModel != nil {
		value, err := decodeModel(*patch.TaskModel)
		if err != nil {
			return err
		}
		models["task"] = mergeRoleModel(models["task"], value)
	}
	return nil
}

// mergeRoleModel keeps stored fields the client did not send. A client that
// predates a field (thinkingLevel) sends only the fields it knows about;
// replacing the object wholesale would erase the rest. Everything the patch
// does carry wins. Note the consequence: an absent field means "keep", so a
// role model field cannot be deleted through a patch at all.
func mergeRoleModel(existing any, incoming map[string]any) map[string]any {
	previous, ok := existing.(map[string]any)
	if !ok {
		return incoming
	}
	merged := copyObject(previous)
	for field, value := range incoming {
		merged[field] = value
	}
	return merged
}

func objectAt(document map[string]any, key string) (map[string]any, error) {
	current, ok := document[key]
	if !ok || current == nil {
		object := map[string]any{}
		document[key] = object
		return object, nil
	}
	object, ok := current.(map[string]any)
	if !ok {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: fmt.Sprintf("the current configuration has a non-object %q field", key),
		}
	}
	return object, nil
}

func decodeModel(raw json.RawMessage) (map[string]any, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "a model patch must be a JSON object",
		}
	}
	value, err := domain.DecodeJSON(trimmed)
	if err != nil {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "a model patch is not valid JSON",
		}
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "a model patch must be a JSON object",
		}
	}
	return object, nil
}

func decodeMcpServers(raw json.RawMessage) ([]any, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "an mcpServers patch must be a JSON array",
		}
	}
	value, err := domain.DecodeJSON(trimmed)
	if err != nil {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "an mcpServers patch is not valid JSON",
		}
	}
	servers, ok := value.([]any)
	if !ok {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "an mcpServers patch must be a JSON array",
		}
	}
	return servers, nil
}

func decodeCustomProviders(raw json.RawMessage) ([]any, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "a customProviders patch must be a JSON array",
		}
	}
	value, err := domain.DecodeJSON(trimmed)
	if err != nil {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "a customProviders patch is not valid JSON",
		}
	}
	providers, ok := value.([]any)
	if !ok {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "a customProviders patch must be a JSON array",
		}
	}
	return providers, nil
}

// mergeCustomProviders keeps unknown fields from the existing entry and its
// models while replacing the fields the desktop UI knows about.
func mergeCustomProviders(existing any, incoming []any) []any {
	existingByID := map[string]map[string]any{}
	if list, ok := existing.([]any); ok {
		for _, entry := range list {
			object, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if id, _ := object["id"].(string); id != "" {
				existingByID[id] = object
			}
		}
	}
	merged := make([]any, len(incoming))
	for index, entry := range incoming {
		object, ok := entry.(map[string]any)
		if !ok {
			merged[index] = entry
			continue
		}
		id, _ := object["id"].(string)
		previous, ok := existingByID[id]
		if !ok {
			merged[index] = entry
			continue
		}
		next := copyObject(previous)
		for _, field := range []string{"id", "name", "api", "baseUrl"} {
			if value, ok := object[field]; ok {
				next[field] = value
			} else {
				delete(next, field)
			}
		}
		if models, ok := object["models"]; ok {
			next["models"] = mergeCustomModels(previous["models"], models)
		} else {
			delete(next, "models")
		}
		merged[index] = next
	}
	return merged
}

func mergeCustomModels(existing, incoming any) any {
	existingByID := map[string]map[string]any{}
	if list, ok := existing.([]any); ok {
		for _, entry := range list {
			object, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if id, _ := object["id"].(string); id != "" {
				existingByID[id] = object
			}
		}
	}
	list, ok := incoming.([]any)
	if !ok {
		return incoming
	}
	merged := make([]any, len(list))
	for index, entry := range list {
		object, ok := entry.(map[string]any)
		if !ok {
			merged[index] = entry
			continue
		}
		id, _ := object["id"].(string)
		previous, ok := existingByID[id]
		if !ok {
			merged[index] = entry
			continue
		}
		next := copyObject(previous)
		for _, field := range []string{"id", "contextWindow", "maxTokens"} {
			if value, ok := object[field]; ok {
				next[field] = value
			} else {
				delete(next, field)
			}
		}
		merged[index] = next
	}
	return merged
}

func copyObject(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func patchIsEmpty(patch domain.EditablePatch) bool {
	return patch.TelegramUserIDs == nil && patch.ButlerModel == nil && patch.TaskModel == nil && patch.CustomProviders == nil && patch.McpServers == nil
}

var (
	referenceNamePattern = regexp.MustCompile(`^MCP_[A-Z0-9_]+$`)
	referencePathPattern = regexp.MustCompile(`^/mcpServers/[0-9]+/headers/[^/]+$`)
	modelKeyNamePattern  = regexp.MustCompile(`^MODEL_KEY_`)
)

// reservedReferenceNames lists names an imported credential must not shadow.
// They mirror the release template's bindings, variables and secret names.
var reservedReferenceNames = func() map[string]bool {
	set := map[string]bool{
		"DESKWAND_CONFIG":     true,
		"CF_VERSION_METADATA": true,
		"PUBLIC_BASE_URL":     true,
		"ACTIVE_CHANNEL":      true,
		"BUTLER":              true,
		"TASK":                true,
		"BOT":                 true,
		"BOT_CHAT":            true,
		"CHANNELS":            true,
		"MCP_AUTH":            true,
		"ARTIFACTS":           true,
		"AI":                  true,
	}
	for _, name := range templateSecretNames {
		set[name] = true
	}
	return set
}()

// referenceSecretNames returns the secret names referenced by import
// migrations. Merging may create a new named secret for an inline value that
// is not part of the release template.
func referenceSecretNames(references []domain.ConfigReference) map[string]bool {
	if len(references) == 0 {
		return nil
	}
	names := make(map[string]bool, len(references))
	for _, reference := range references {
		if strings.HasPrefix(reference.Reference, "env:") {
			names[strings.TrimPrefix(reference.Reference, "env:")] = true
		}
	}
	return names
}

// applyReferences rewrites inline credential strings to env:NAME references.
// It only touches string leaves that already exist and never copies a value.
func applyReferences(document map[string]any, references []domain.ConfigReference) error {
	for _, reference := range references {
		if !referencePathPattern.MatchString(reference.Path) {
			return domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference may only rewrite an MCP header value"}
		}
		if !strings.HasPrefix(reference.Reference, "env:") {
			return domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference must start with env:"}
		}
		name := strings.TrimPrefix(reference.Reference, "env:")
		if !referenceNamePattern.MatchString(name) {
			return domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference names an invalid secret"}
		}
		segments, err := pointerSegments(reference.Path)
		if err != nil {
			return err
		}
		parent, last, err := walkPointer(document, segments)
		if err != nil {
			return err
		}
		switch container := parent.(type) {
		case map[string]any:
			value, ok := container[last]
			if !ok {
				return domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference points at a missing field"}
			}
			if _, ok := value.(string); !ok {
				return domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference must replace a string field"}
			}
			container[last] = reference.Reference
		case []any:
			index, err := pointerIndex(last, len(container))
			if err != nil {
				return err
			}
			if _, ok := container[index].(string); !ok {
				return domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference must replace a string field"}
			}
			container[index] = reference.Reference
		default:
			return domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference points at a non-container field"}
		}
	}
	return nil
}

func pointerSegments(path string) ([]string, error) {
	if path == "" || !strings.HasPrefix(path, "/") {
		return nil, domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference path must be a JSON pointer"}
	}
	raw := strings.Split(strings.TrimPrefix(path, "/"), "/")
	segments := make([]string, len(raw))
	for i, segment := range raw {
		segment = strings.ReplaceAll(segment, "~1", "/")
		segment = strings.ReplaceAll(segment, "~0", "~")
		segments[i] = segment
	}
	return segments, nil
}

func walkPointer(document map[string]any, segments []string) (any, string, error) {
	var current any = document
	for i, segment := range segments {
		last := i == len(segments)-1
		switch container := current.(type) {
		case map[string]any:
			value, ok := container[segment]
			if !ok {
				return nil, "", domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference points at a missing field"}
			}
			if last {
				return container, segment, nil
			}
			current = value
		case []any:
			index, err := pointerIndex(segment, len(container))
			if err != nil {
				return nil, "", err
			}
			if last {
				return container, segment, nil
			}
			current = container[index]
		default:
			return nil, "", domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference points at a non-container field"}
		}
	}
	return nil, "", domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference path is empty"}
}

func pointerIndex(segment string, length int) (int, error) {
	index, err := strconv.Atoi(segment)
	if err != nil || index < 0 || index >= length {
		return 0, domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: "a configuration reference array index is invalid"}
	}
	return index, nil
}

func validateReferences(_ []string, references []domain.ConfigReference, edits []domain.SecretEdit) error {
	if len(references) == 0 {
		return nil
	}
	replaced := make(map[string]bool, len(edits))
	for _, edit := range edits {
		if edit.Operation == domain.SecretReplace {
			replaced[edit.Name] = true
		}
	}
	for _, reference := range references {
		if !referencePathPattern.MatchString(reference.Path) {
			return invalidSecretEdit("configuration references may only rewrite MCP header values")
		}
		if !strings.HasPrefix(reference.Reference, "env:") {
			return invalidSecretEdit("configuration reference must start with env:")
		}
		name := strings.TrimPrefix(reference.Reference, "env:")
		if !referenceNamePattern.MatchString(name) {
			return invalidSecretEdit("migrated secret names must match ^MCP_[A-Z0-9_]+$")
		}
		if reservedReferenceNames[name] || modelKeyNamePattern.MatchString(name) {
			return invalidSecretEdit(fmt.Sprintf("migrated secret name %q collides with a binding, variable or template name", name))
		}
		if !replaced[name] {
			return invalidSecretEdit(fmt.Sprintf("configuration reference %q requires a replace edit in the same change", name))
		}
	}
	return nil
}

func validateSecretEdits(existingNames []string, edits []domain.SecretEdit, referenced map[string]bool) error {
	if len(edits) == 0 {
		return nil
	}

	existing := make(map[string]bool, len(existingNames))
	for _, name := range existingNames {
		existing[name] = true
	}
	seen := make(map[string]bool, len(edits))

	for _, edit := range edits {
		if edit.Name == "" {
			return invalidSecretEdit("a secret edit has an empty name")
		}
		if seen[edit.Name] {
			return invalidSecretEdit(fmt.Sprintf("secret %q is edited more than once", edit.Name))
		}
		seen[edit.Name] = true

		if !secretNameAllowed(edit.Name) && !existing[edit.Name] && !referenced[edit.Name] {
			return invalidSecretEdit(fmt.Sprintf("secret %q is not declared by the release template", edit.Name))
		}

		switch edit.Operation {
		case domain.SecretKeep:
			if edit.Value() != "" {
				return invalidSecretEdit(fmt.Sprintf("keep for %q must not carry a value", edit.Name))
			}
			if !existing[edit.Name] {
				return invalidSecretEdit(fmt.Sprintf("keep for %q requires an existing secret", edit.Name))
			}
		case domain.SecretReplace:
			if edit.Value() == "" {
				return invalidSecretEdit(fmt.Sprintf("replace for %q requires a value", edit.Name))
			}
		case domain.SecretClear:
			if edit.Value() != "" {
				return invalidSecretEdit(fmt.Sprintf("clear for %q must not carry a value", edit.Name))
			}
			if !existing[edit.Name] {
				return invalidSecretEdit(fmt.Sprintf("clear for %q requires an existing secret", edit.Name))
			}
		default:
			return invalidSecretEdit(fmt.Sprintf("secret %q has an unknown operation", edit.Name))
		}
	}
	return nil
}

func invalidSecretEdit(message string) error {
	return domain.Error{Code: domain.INVALID_SECRET_EDIT, Message: message}
}

// validateVars restricts variable overrides to the release template's
// plainVars and rejects a name that the current settings already bind as a
// different type. CreateVersion repeats the allowlist check against the signed
// manifest before uploading.
func validateVars(vars map[string]string, settingsJSON []byte) error {
	if len(vars) == 0 {
		return nil
	}
	bindingTypes := map[string]string{}
	if len(settingsJSON) > 0 {
		var document struct {
			Bindings []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"bindings"`
		}
		if err := json.Unmarshal(settingsJSON, &document); err != nil {
			return invalidVar("the current settings bindings are not readable")
		}
		for _, binding := range document.Bindings {
			bindingTypes[binding.Name] = binding.Type
		}
	}
	for name, value := range vars {
		if name == "" {
			return invalidVar("a plain variable override has an empty name")
		}
		if strings.ContainsRune(name, 0) || strings.ContainsRune(value, 0) {
			return invalidVar("a plain variable override contains NUL")
		}
		if !templatePlainVarSet[name] {
			return invalidVar(fmt.Sprintf("plain variable %q is not declared by the release template", name))
		}
		if bindingType, ok := bindingTypes[name]; ok && bindingType != "plain_text" {
			return invalidVar(fmt.Sprintf("binding %q is not a plain-text variable", name))
		}
	}
	return nil
}

func invalidVar(message string) error {
	return domain.Error{Code: domain.INVALID_VAR, Message: message}
}

func cloneVars(vars map[string]string) map[string]string {
	if vars == nil {
		return nil
	}
	cloned := make(map[string]string, len(vars))
	for name, value := range vars {
		cloned[name] = value
	}
	return cloned
}

func cloneSecretEdits(edits []domain.SecretEdit) []domain.SecretEdit {
	if edits == nil {
		return nil
	}
	cloned := make([]domain.SecretEdit, len(edits))
	copy(cloned, edits)
	return cloned
}

// templatePlainVars is the runtime copy of the release template's plainVars.
// plain_vars_test.go asserts it matches the contract file.
var templatePlainVars = []string{
	"ACTIVE_CHANNEL",
	"PUBLIC_BASE_URL",
}

var templatePlainVarSet = func() map[string]bool {
	set := make(map[string]bool, len(templatePlainVars))
	for _, name := range templatePlainVars {
		set[name] = true
	}
	return set
}()

// templateSecretNames is the runtime copy of the release template's
// secretNames. secret_names_test.go asserts it matches the contract file.
var templateSecretNames = []string{
	"TELEGRAM_BOT_TOKEN",
	"TELEGRAM_WEBHOOK_SECRET",
	"WECHAT_CREDENTIALS",
	"ADMIN_TOKEN",
}

// templateSecretNamePatterns is the runtime copy of the release template's
// secretNamePatterns. secret_names_test.go asserts it matches the contract
// file. Model provider keys are created by name, so the template cannot list
// them individually.
var templateSecretNamePatterns = []*regexp.Regexp{
	regexp.MustCompile(`^MODEL_KEY_[A-Z0-9_]{1,64}$`),
	regexp.MustCompile(`^MCP_[A-Z0-9_]{1,64}$`),
	regexp.MustCompile(`^SEARCH_KEY_[A-Z0-9_]{1,64}$`),
}

// secretNameAllowed reports whether an edit may target name: either it is a
// template secret or it matches a template secret name pattern.
func secretNameAllowed(name string) bool {
	if templateSecretSet[name] {
		return true
	}
	for _, pattern := range templateSecretNamePatterns {
		if pattern.MatchString(name) {
			return true
		}
	}
	return false
}

var templateSecretSet = func() map[string]bool {
	set := make(map[string]bool, len(templateSecretNames))
	for _, name := range templateSecretNames {
		set[name] = true
	}
	return set
}()
