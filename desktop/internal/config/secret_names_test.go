package config

import (
	"encoding/json"
	"testing"
)

func TestTemplateSecretNamesMatchReleaseTemplate(t *testing.T) {
	raw := readContract(t, "release-template.json")
	var template struct {
		SecretNames        []string `json:"secretNames"`
		SecretNamePatterns []string `json:"secretNamePatterns"`
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
	for _, legacy := range []string{"ANTHROPIC_API_KEY", "OPENCODE_API_KEY"} {
		for _, name := range template.SecretNames {
			if name == legacy {
				t.Fatalf("template still declares legacy secret %q", legacy)
			}
		}
	}
	if len(template.SecretNamePatterns) != len(templateSecretNamePatterns) {
		t.Fatalf("template has %d secret name patterns, runtime copy has %d", len(template.SecretNamePatterns), len(templateSecretNamePatterns))
	}
	for i, pattern := range template.SecretNamePatterns {
		if pattern != templateSecretNamePatterns[i].String() {
			t.Fatalf("secretNamePatterns[%d] = %q, runtime copy = %q", i, pattern, templateSecretNamePatterns[i].String())
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

func TestExchangeSecretNamesAreAllowed(t *testing.T) {
	for _, name := range []string{
		"EXCHANGE_SECRET_OKX_MAIN",
		"EXCHANGE_SECRET_BN_MAIN",
		"EXCHANGE_SECRET_A",
	} {
		if !secretNameAllowed(name) {
			t.Fatalf("%s should be allowed", name)
		}
	}
	for _, name := range []string{
		"EXCHANGE_SECRET_",
		"EXCHANGE_SECRET_lower",
		"EXCHANGE_OKX_MAIN",
	} {
		if secretNameAllowed(name) {
			t.Fatalf("%s should be rejected", name)
		}
	}
}

func TestWalletSecretNamesAreAllowed(t *testing.T) {
	for _, name := range []string{"WALLET_PRIVATE_KEY", "WALLET_OWNER_ADDRESS"} {
		if !secretNameAllowed(name) {
			t.Fatalf("%s should be allowed", name)
		}
		if !reservedReferenceNames[name] {
			t.Fatalf("%s should be reserved", name)
		}
	}
}
