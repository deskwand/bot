package deployment

import (
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/release"
)

func aiTemplate(name string) release.ResourceTemplate {
	return release.ResourceTemplate{
		AIBindings: []release.AIBinding{{Name: name}},
	}
}

func aiSettings(name string) []byte {
	return []byte(`{"bindings":[{"type":"ai","name":"` + name + `"}]}`)
}

func TestInspectUpgradeBindingsAcceptsADeclaredAIBinding(t *testing.T) {
	inspection, err := inspectUpgradeBindings(aiSettings("AI"), aiTemplate("AI"))
	if err != nil {
		t.Fatalf("declared AI binding rejected: %v", err)
	}
	if _, ok := inspection.ByTypeAndName["ai/AI"]; !ok {
		t.Fatalf("AI binding was not inspected: %#v", inspection.ByTypeAndName)
	}
}

func TestInspectUpgradeBindingsRejectsAnUndeclaredAIBinding(t *testing.T) {
	_, err := inspectUpgradeBindings(aiSettings("OTHER_AI"), aiTemplate("AI"))
	if err == nil {
		t.Fatal("undeclared AI binding was accepted")
	}
	// Rejected as "not declared by the template", not as an unknown type:
	// an `ai` binding is only acceptable when the signed template names it.
	if !strings.Contains(err.Error(), "not declared by the release template") {
		t.Fatalf("error = %v", err)
	}
}
