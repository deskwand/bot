package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
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
	if err := validateSecretEdits(base.SecretNames, change.Secrets); err != nil {
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

	return domain.PublishPlan{
		BaseVersionID: base.VersionID,
		ConfigJSON:    canonical,
		Secrets:       cloneSecretEdits(change.Secrets),
	}, nil
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

	if patch.ButlerModel == nil && patch.TaskModel == nil {
		return nil
	}
	models, err := objectAt(document, "models")
	if err != nil {
		return err
	}
	if patch.ButlerModel != nil {
		value, err := decodeModel(*patch.ButlerModel)
		if err != nil {
			return err
		}
		models["butler"] = value
	}
	if patch.TaskModel != nil {
		value, err := decodeModel(*patch.TaskModel)
		if err != nil {
			return err
		}
		models["task"] = value
	}
	return nil
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

func decodeModel(raw json.RawMessage) (any, error) {
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
	if _, ok := value.(map[string]any); !ok {
		return nil, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: "a model patch must be a JSON object",
		}
	}
	return value, nil
}

func patchIsEmpty(patch domain.EditablePatch) bool {
	return patch.TelegramUserIDs == nil && patch.ButlerModel == nil && patch.TaskModel == nil
}

func validateSecretEdits(existingNames []string, edits []domain.SecretEdit) error {
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

		if !templateSecretSet[edit.Name] && !existing[edit.Name] {
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

func cloneSecretEdits(edits []domain.SecretEdit) []domain.SecretEdit {
	if edits == nil {
		return nil
	}
	cloned := make([]domain.SecretEdit, len(edits))
	copy(cloned, edits)
	return cloned
}

// templateSecretNames is the runtime copy of the release template's
// secretNames. secret_names_test.go asserts it matches the contract file.
var templateSecretNames = []string{
	"ANTHROPIC_API_KEY",
	"OPENCODE_API_KEY",
	"TELEGRAM_BOT_TOKEN",
	"TELEGRAM_WEBHOOK_SECRET",
	"WECHAT_CREDENTIALS",
}

var templateSecretSet = func() map[string]bool {
	set := make(map[string]bool, len(templateSecretNames))
	for _, name := range templateSecretNames {
		set[name] = true
	}
	return set
}()
