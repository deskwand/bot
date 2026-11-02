package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readContract(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestEmbeddedSchemaMatchesContract(t *testing.T) {
	if string(embeddedSchema) != string(readContract(t, "deployment-config.schema.json")) {
		t.Fatal("embedded schema differs from contracts/deployment-config.schema.json")
	}
}

func TestValidateSharedFixtureCases(t *testing.T) {
	raw := readContract(t, "fixtures/config-cases.json")
	var cases []struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
		Valid bool            `json:"valid"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no shared fixture cases")
	}

	for _, testCase := range cases {
		t.Run(testCase.Name, func(t *testing.T) {
			err := Validate(testCase.Input)
			if testCase.Valid && err != nil {
				t.Fatalf("Validate() = %v, want nil", err)
			}
			if !testCase.Valid && err == nil {
				t.Fatal("Validate() = nil, want an error")
			}
		})
	}
}

func TestValidateFixtureDocuments(t *testing.T) {
	if err := Validate(readContract(t, "fixtures/config-valid.json")); err != nil {
		t.Fatalf("valid fixture rejected: %v", err)
	}
	if err := Validate(readContract(t, "fixtures/config-invalid.json")); err == nil {
		t.Fatal("invalid fixture accepted")
	}
}

func TestValidateRejectsNonJSONWithoutEchoingInput(t *testing.T) {
	sentinel := "sk-schema-SENTINEL"
	err := Validate([]byte("not json " + sentinel))
	if err == nil {
		t.Fatal("invalid JSON accepted")
	}
	if !errors.Is(err, ErrInvalidJSON) {
		t.Fatalf("error = %v, want ErrInvalidJSON", err)
	}
	if errors.Is(err, ErrInvalidSchema) {
		t.Fatal("invalid JSON was reported as a schema mismatch")
	}
}

func TestValidateAcceptsStringForm(t *testing.T) {
	valid := readContract(t, "fixtures/config-valid.json")
	quoted, err := json.Marshal(string(valid))
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(quoted); err != nil {
		t.Fatalf("JSON string form rejected: %v", err)
	}
}

func TestValidateReportsJSONPointerLocationsOnly(t *testing.T) {
	const forbiddenValue = "-424242"
	document := []byte(`{"schemaVersion":1,"owner":{"telegramUserIds":[-424242]},"models":{"butler":{"provider":"opencode-go","id":"m"},"task":{"provider":"opencode-go","id":"m"}},"mcpServers":[]}`)
	err := Validate(document)
	if err == nil {
		t.Fatal("invalid document accepted")
	}
	var validation *SchemaValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("error %T is not *SchemaValidationError: %v", err, err)
	}
	if !errors.Is(err, ErrInvalidSchema) {
		t.Fatalf("SchemaValidationError does not unwrap to ErrInvalidSchema: %v", err)
	}
	if len(validation.Locations) == 0 || !strings.Contains(strings.Join(validation.Locations, ","), "/owner/telegramUserIds") {
		t.Fatalf("locations = %#v", validation.Locations)
	}
	if strings.Contains(err.Error(), forbiddenValue) {
		t.Fatalf("validation error leaked the invalid value: %v", err)
	}
}
