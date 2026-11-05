package config

import (
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/modelcatalog"
)

// CheckModelKeys requires every provider referenced by the butler and task
// roles to have its MODEL_KEY_* secret either already deployed or written by
// this publish. A key cleared by the same change does not count.
func CheckModelKeys(locale string, configJSON []byte, existing []string, edits []domain.SecretEdit) error {
	doc, err := modelcatalog.ParseModels(configJSON)
	if err != nil {
		return err
	}
	available := make(map[string]bool, len(existing)+len(edits))
	for _, name := range existing {
		available[name] = true
	}
	for _, edit := range edits {
		switch edit.Operation {
		case domain.SecretReplace:
			available[edit.Name] = true
		case domain.SecretClear:
			delete(available, edit.Name)
		}
	}

	missing := make([]string, 0)
	for _, name := range modelcatalog.RequiredSecretNames(doc) {
		if !available[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	separator := i18n.T(locale, "catalog.keySeparator")
	return domain.Error{
		Code:    domain.MODEL_KEY_MISSING,
		Message: i18n.T(locale, "catalog.missingModelKeys", strings.Join(missing, separator)),
	}
}
