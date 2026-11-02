package config

import (
	"encoding/json"
	"testing"
)

func TestTemplatePlainVarsMatchReleaseTemplate(t *testing.T) {
	raw := readContract(t, "release-template.json")
	var template struct {
		PlainVars []string `json:"plainVars"`
	}
	if err := json.Unmarshal(raw, &template); err != nil {
		t.Fatal(err)
	}
	if len(template.PlainVars) != len(templatePlainVars) {
		t.Fatalf("template has %d plain vars, runtime copy has %d", len(template.PlainVars), len(templatePlainVars))
	}
	for i, name := range template.PlainVars {
		if name != templatePlainVars[i] {
			t.Fatalf("plainVars[%d] = %q, runtime copy = %q", i, name, templatePlainVars[i])
		}
	}
}
