package config

import (
	"encoding/json"
	"testing"
)

func TestTemplateSecretNamesMatchReleaseTemplate(t *testing.T) {
	raw := readContract(t, "release-template.json")
	var template struct {
		SecretNames []string `json:"secretNames"`
	}
	if err := json.Unmarshal(raw, &template); err != nil {
		t.Fatal(err)
	}
	if len(template.SecretNames) != len(templateSecretNames) {
		t.Fatalf("template has %d secret names, runtime copy has %d", len(template.SecretNames), len(templateSecretNames))
	}
	for i, name := range template.SecretNames {
		if name != templateSecretNames[i] {
			t.Fatalf("secretNames[%d] = %q, runtime copy = %q", i, name, templateSecretNames[i])
		}
	}
}
