package config

import (
	"encoding/json"
	"testing"
)

// TestReservedReferenceNamesCoverEveryBinding guards the drift that let the AI
// binding reach the release template without the client knowing its name: the
// map is a hand-written mirror, so every binding the template declares must be
// in it.
func TestReservedReferenceNamesCoverEveryBinding(t *testing.T) {
	raw := readContract(t, "release-template.json")
	var template struct {
		DurableObjects []struct {
			Name string `json:"name"`
		} `json:"durableObjects"`
		R2Buckets []struct {
			Name string `json:"name"`
		} `json:"r2Buckets"`
		AIBindings []struct {
			Name string `json:"name"`
		} `json:"aiBindings"`
		VersionMetadataBinding struct {
			Name string `json:"name"`
		} `json:"versionMetadataBinding"`
		ConfigBinding struct {
			Name string `json:"name"`
		} `json:"configBinding"`
	}
	if err := json.Unmarshal(raw, &template); err != nil {
		t.Fatal(err)
	}

	names := []string{
		template.VersionMetadataBinding.Name,
		template.ConfigBinding.Name,
	}
	for _, binding := range template.DurableObjects {
		names = append(names, binding.Name)
	}
	for _, binding := range template.R2Buckets {
		names = append(names, binding.Name)
	}
	for _, binding := range template.AIBindings {
		names = append(names, binding.Name)
	}

	for _, name := range names {
		if name == "" {
			t.Fatal("release template declares an empty binding name")
		}
		if !reservedReferenceNames[name] {
			t.Fatalf("binding %q from the release template is not reserved", name)
		}
	}
}
