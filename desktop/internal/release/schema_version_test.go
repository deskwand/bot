package release

import (
	"encoding/json"
	"os"
	"testing"
)

// The TS builder reads the schema version from the shared contract; the Go
// constant must not drift from it.
func TestSupportedConfigSchemaVersionMatchesContract(t *testing.T) {
	raw, err := os.ReadFile("../../../contracts/deployment-config.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Properties struct {
			SchemaVersion struct {
				Const int `json:"const"`
			} `json:"schemaVersion"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	if got := schema.Properties.SchemaVersion.Const; got != SupportedConfigSchemaVersion {
		t.Fatalf("schema const %d != SupportedConfigSchemaVersion %d", got, SupportedConfigSchemaVersion)
	}
}
