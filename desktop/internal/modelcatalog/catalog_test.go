package modelcatalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readRepositoryFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", path))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestEmbeddedCatalogMatchesContract(t *testing.T) {
	if string(embeddedCatalog) != string(readRepositoryFile(t, "contracts/model-catalog.json")) {
		t.Fatal("embedded catalog differs from contracts/model-catalog.json")
	}
}

func TestSecretNameForMatchesSharedFixture(t *testing.T) {
	var cases []struct {
		ID     string `json:"id"`
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(readRepositoryFile(t, "contracts/fixtures/model-key-names.json"), &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no model key fixture cases")
	}
	for _, testCase := range cases {
		if got := SecretNameFor(testCase.ID); got != testCase.Secret {
			t.Fatalf("SecretNameFor(%q) = %q, want %q", testCase.ID, got, testCase.Secret)
		}
	}
}

func validModelsDoc() ModelsDoc {
	return ModelsDoc{
		Butler: RoleRef{Provider: "opencode-go", ID: "deepseek-v4.1-flash"},
		Task:   RoleRef{Provider: "my-proxy", ID: "gpt-5.6"},
		CustomProviders: []CustomProvider{
			{
				ID:      "my-proxy",
				Name:    "My Proxy",
				API:     "openai-completions",
				BaseURL: "https://proxy.example.com/v1",
				Models:  []CustomModel{{ID: "gpt-5.6", ContextWindow: 128000, MaxTokens: 8192}},
			},
		},
	}
}

func TestValidateModelsAcceptsBuiltinAndCustomReferences(t *testing.T) {
	if err := ValidateModels(validModelsDoc()); err != nil {
		t.Fatalf("ValidateModels() = %v, want nil", err)
	}
}

func TestValidateModelsRejectsInvalidReferences(t *testing.T) {
	tests := []struct {
		name string
		edit func(*ModelsDoc)
		want string
	}{
		{
			name: "custom id conflicts with builtin",
			edit: func(doc *ModelsDoc) { doc.CustomProviders[0].ID = "deepseek" },
			want: "deepseek",
		},
		{
			name: "duplicate custom id",
			edit: func(doc *ModelsDoc) {
				doc.CustomProviders = append(doc.CustomProviders, doc.CustomProviders[0])
			},
			want: "my-proxy",
		},
		{
			name: "unknown provider",
			edit: func(doc *ModelsDoc) { doc.Butler.Provider = "ghost" },
			want: "ghost",
		},
		{
			name: "custom model not declared",
			edit: func(doc *ModelsDoc) { doc.Task.ID = "gpt-6" },
			want: "gpt-6",
		},
		{
			name: "builtin model not in catalog",
			edit: func(doc *ModelsDoc) {
				doc.Butler = RoleRef{Provider: "deepseek", ID: "not-in-catalog"}
			},
			want: "not-in-catalog",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			doc := validModelsDoc()
			testCase.edit(&doc)
			err := ValidateModels(doc)
			if err == nil {
				t.Fatal("ValidateModels() = nil, want an error")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error = %v, want it to mention %q", err, testCase.want)
			}
		})
	}
}

func TestRequiredSecretNamesIsSortedAndUnique(t *testing.T) {
	doc := validModelsDoc()
	doc.Task = doc.Butler
	got := RequiredSecretNames(doc)
	want := []string{SecretNameFor("opencode-go")}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("RequiredSecretNames() = %#v, want %#v", got, want)
	}
}
