package config

import (
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/modelcatalog"
)

const maxWindowShrink = 4

// The Butler reuses its conversation; new Tasks pin their own model at creation.
func validateButlerWindow(locale string, before, after modelcatalog.ModelsDoc) error {
	if before.Butler.Provider == "" || before.Butler.ID == "" {
		return nil
	}
	oldWindow := modelcatalog.ContextWindow(before, before.Butler)
	newWindow := modelcatalog.ContextWindow(after, after.Butler)
	// Pi keeps the departing ref until a message applies the new selection.
	// Its old window must remain resolvable in the deployed catalog.
	if before.Butler != after.Butler && oldWindow > 0 && modelcatalog.ContextWindow(after, before.Butler) != oldWindow {
		return domain.Error{Code: domain.MODEL_SWITCH_REJECTED,
			Message: i18n.T(locale, "catalog.keepDepartingModel", before.Butler.Provider, before.Butler.ID)}
	}
	if oldWindow > 0 && newWindow > 0 {
		// ceil(oldWindow / 4), without overflowing for large custom limits.
		minimum := oldWindow / maxWindowShrink
		if oldWindow%maxWindowShrink != 0 {
			minimum++
		}
		if newWindow >= minimum {
			return nil
		}
		return domain.Error{
			Code:    domain.MODEL_SWITCH_REJECTED,
			Message: i18n.T(locale, "catalog.windowDowngrade", before.Butler.Provider, before.Butler.ID, oldWindow, after.Butler.Provider, after.Butler.ID, newWindow),
		}
	}
	// Unknown legacy refs must survive unrelated edits and release upgrades.
	if before.Butler == after.Butler {
		return nil
	}
	return domain.Error{Code: domain.MODEL_SWITCH_REJECTED, Message: i18n.T(locale, "catalog.windowUnknown")}
}
