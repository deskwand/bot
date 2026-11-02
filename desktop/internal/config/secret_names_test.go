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

func TestReservedReferenceNamesCoverReleaseTemplate(t *testing.T) {
	raw := readContract(t, "release-template.json")
	var template struct {
		DurableObjects []struct {
			Name string `json:"name"`
		} `json:"durableObjects"`
		R2Buckets []struct {
			Name string `json:"name"`
		} `json:"r2Buckets"`
		VersionMetadata struct {
			Name string `json:"name"`
		} `json:"versionMetadataBinding"`
		ConfigBinding struct {
			Name string `json:"name"`
		} `json:"configBinding"`
		SecretNames []string `json:"secretNames"`
		PlainVars   []string `json:"plainVars"`
		Vars        []struct {
			Name string `json:"name"`
		} `json:"vars"`
	}
	if err := json.Unmarshal(raw, &template); err != nil {
		t.Fatal(err)
	}
	names := []string{template.VersionMetadata.Name, template.ConfigBinding.Name}
	names = append(names, template.SecretNames...)
	names = append(names, template.PlainVars...)
	for _, binding := range template.DurableObjects {
		names = append(names, binding.Name)
	}
	for _, binding := range template.R2Buckets {
		names = append(names, binding.Name)
	}
	for _, variable := range template.Vars {
		names = append(names, variable.Name)
	}
	for _, name := range names {
		if !reservedReferenceNames[name] {
			t.Fatalf("release template name %q is not reserved for migrated secrets", name)
		}
	}
}
