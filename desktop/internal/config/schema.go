// Package config validates the shared deployment configuration schema and
// merges whitelisted edits onto a previously ReadSnapshot.
package config

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// The embedded copy is asserted byte-identical to the repository contract by
// schema_test.go. The desktop binary must validate without repository files.
//
// Schema validation uses github.com/santhosh-tekuri/jsonschema/v6 v6.0.3,
// pinned exactly in go.mod. It is a small, interpreted Draft 2020-12 validator
// with no code generation, which keeps one reviewed dependency instead of a
// hand-written schema engine.
//
//go:embed deployment-config.schema.json
var embeddedSchema []byte

const schemaURL = "https://deskwand.dev/contracts/deployment-config.schema.json"

var (
	ErrInvalidJSON   = errors.New("config: document is not valid JSON")
	ErrInvalidSchema = errors.New("config: document does not match deployment configuration schema version 1")

	schemaOnce sync.Once
	schema     *jsonschema.Schema
	schemaErr  error
)

func compiledSchema() (*jsonschema.Schema, error) {
	schemaOnce.Do(func() {
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(embeddedSchema))
		if err != nil {
			schemaErr = fmt.Errorf("config: parse embedded schema: %w", err)
			return
		}
		compiler := jsonschema.NewCompiler()
		if err := compiler.AddResource(schemaURL, document); err != nil {
			schemaErr = fmt.Errorf("config: add embedded schema: %w", err)
			return
		}
		schema, schemaErr = compiler.Compile(schemaURL)
	})
	return schema, schemaErr
}

// SchemaValidationError carries only the JSON-pointer locations of failing
// instance values. It never includes the values themselves.
type SchemaValidationError struct {
	Locations []string
}

func (e *SchemaValidationError) Error() string {
	if len(e.Locations) == 0 {
		return ErrInvalidSchema.Error()
	}
	return fmt.Sprintf("%s at %s", ErrInvalidSchema.Error(), strings.Join(e.Locations, ", "))
}

func (e *SchemaValidationError) Unwrap() error { return ErrInvalidSchema }

// Validate checks one JSON document against the shared schema. It accepts the
// JSON-string form used by CLI and local dev, matching src/runtime-config.ts.
// Errors are fixed and never include document values.
func Validate(raw []byte) error {
	value, err := parse(raw)
	if err != nil {
		return ErrInvalidJSON
	}
	if text, ok := value.(string); ok {
		value, err = parse([]byte(text))
		if err != nil {
			return ErrInvalidJSON
		}
	}

	compiled, err := compiledSchema()
	if err != nil {
		return err
	}
	if err := compiled.Validate(value); err != nil {
		return &SchemaValidationError{Locations: validationLocations(err)}
	}
	return nil
}

func validationLocations(err error) []string {
	var validation *jsonschema.ValidationError
	if !errors.As(err, &validation) {
		return nil
	}
	seen := map[string]bool{}
	var walk func(*jsonschema.ValidationError)
	walk = func(current *jsonschema.ValidationError) {
		if len(current.Causes) == 0 {
			seen[jsonPointer(current.InstanceLocation)] = true
			return
		}
		for _, cause := range current.Causes {
			walk(cause)
		}
	}
	walk(validation)

	locations := make([]string, 0, len(seen))
	for location := range seen {
		locations = append(locations, location)
	}
	sort.Strings(locations)
	return locations
}

func jsonPointer(segments []string) string {
	var builder strings.Builder
	for _, segment := range segments {
		builder.WriteByte('/')
		segment = strings.ReplaceAll(segment, "~", "~0")
		segment = strings.ReplaceAll(segment, "/", "~1")
		builder.WriteString(segment)
	}
	return builder.String()
}

func parse(raw []byte) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, ErrInvalidJSON
	}
	return domain.DecodeJSON(raw)
}
