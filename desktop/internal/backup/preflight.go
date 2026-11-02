package backup

import (
	"archive/zip"
	"bufio"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

var (
	createTable = regexp.MustCompile(`(?is)^\s*CREATE\s+TABLE\b`)
	createIndex = regexp.MustCompile(`(?is)^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b`)
	integerText = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)$`)
)

// jsSafeIntMax is the largest integer JSON.parse preserves exactly. The Worker
// decodes restore pages with JSON.parse, so a bare integer above this bound
// would be silently rounded before it reaches SQLite; the archive format's
// $int tag exists to carry larger values as strings.
const jsSafeIntMax int64 = 1<<53 - 1

// validateManifestStructure checks the parts of the manifest that a restore
// depends on but the row counts alone cannot prove: exactly one Butler and one
// Channel, unique identities, and a row map that matches the schema.
func validateManifestStructure(manifest Manifest) error {
	seenDO := map[string]bool{}
	butlers, channels := 0, 0
	for _, object := range manifest.DurableObjects {
		if err := validateDORef(object.DORef); err != nil {
			return err
		}
		if object.DO == "butler" || object.DO == "channel" {
			if object.ID != "" {
				return fmt.Errorf("%s id must be empty", object.DO)
			}
		}
		key := object.DO + "/" + object.ID
		if seenDO[key] {
			return fmt.Errorf("duplicate durable object %s", key)
		}
		seenDO[key] = true
		switch object.DO {
		case "butler":
			butlers++
		case "channel":
			channels++
		}

		tables := map[string]bool{}
		for _, table := range object.Schema.Tables {
			if err := validateTableSchema(table); err != nil {
				return fmt.Errorf("%s: %v", key, err)
			}
			if tables[table.Name] {
				return fmt.Errorf("%s has duplicate table %s", key, table.Name)
			}
			tables[table.Name] = true
		}
		if len(object.Rows) != len(tables) {
			return fmt.Errorf("%s row map does not match its schema", key)
		}
		for name := range object.Rows {
			if !tables[name] {
				return fmt.Errorf("%s has rows for unknown table %s", key, name)
			}
		}
	}
	if butlers != 1 {
		return fmt.Errorf("expected exactly one butler object, found %d", butlers)
	}
	if channels != 1 {
		return fmt.Errorf("expected exactly one channel object, found %d", channels)
	}
	return nil
}

func validateTableSchema(table TableSchema) error {
	if table.Name == "" {
		return errors.New("table name is empty")
	}
	if strings.ContainsAny(table.Name, "/\\\x00") || strings.Contains(table.Name, "..") {
		return fmt.Errorf("invalid table name %q", table.Name)
	}
	if table.Name == "__kv" {
		if table.Create != "" {
			return errors.New("__kv must not have a CREATE statement")
		}
		return nil
	}
	if table.Create == "" {
		return fmt.Errorf("table %s has no CREATE statement", table.Name)
	}
	if err := validateSchemaSQL(table.Create, createTable, "table"); err != nil {
		return fmt.Errorf("table %s: %v", table.Name, err)
	}
	return nil
}

func validateSchemaSQL(statement string, pattern *regexp.Regexp, kind string) error {
	if !pattern.MatchString(statement) {
		return fmt.Errorf("%s statement is not a supported CREATE", kind)
	}
	trimmed := strings.TrimSpace(statement)
	if strings.HasSuffix(trimmed, ";") {
		trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, ";"))
	}
	if strings.Contains(trimmed, ";") {
		return fmt.Errorf("%s statement contains multiple statements", kind)
	}
	upper := strings.ToUpper(trimmed)
	for _, forbidden := range []string{"ATTACH", "DETACH", "PRAGMA", "VACUUM"} {
		if strings.Contains(upper, forbidden) {
			return fmt.Errorf("%s statement contains %s", kind, forbidden)
		}
	}
	return nil
}

// preflightObject executes one object's schema, rows and indexes in an isolated
// in-memory SQLite database. It catches invalid SQL, constraint violations,
// unknown columns and malformed values before the deployment is touched.
func preflightObject(object DOManifest, files map[string]*zip.File) error {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	defer db.Close()

	for _, table := range object.Schema.Tables {
		if table.Name == "__kv" {
			continue
		}
		if _, err := db.Exec(table.Create); err != nil {
			return fmt.Errorf("table %s schema: %v", table.Name, err)
		}
	}

	for _, table := range object.Schema.Tables {
		entry := TableEntry(object.DORef, table.Name)
		file, ok := files[entry]
		if !ok {
			return fmt.Errorf("table entry %s is missing", entry)
		}
		if table.Name == "__kv" {
			count, err := validateKVEntry(file)
			if err != nil {
				return fmt.Errorf("table entry %s: %v", entry, err)
			}
			if want := object.Rows[table.Name]; count != want {
				return fmt.Errorf("table entry %s has %d rows, manifest says %d", entry, count, want)
			}
			continue
		}
		count, err := validateSQLRows(db, file, table)
		if err != nil {
			return fmt.Errorf("table entry %s: %v", entry, err)
		}
		if want := object.Rows[table.Name]; count != want {
			return fmt.Errorf("table entry %s has %d rows, manifest says %d", entry, count, want)
		}
	}

	for _, statement := range object.Schema.Indexes {
		if err := validateSchemaSQL(statement, createIndex, "index"); err != nil {
			return err
		}
		if _, err := db.Exec(statement); err != nil {
			return fmt.Errorf("index schema: %v", err)
		}
	}
	return nil
}

type sqlColumn struct {
	name       string
	notNull    bool
	primaryKey bool
}

func tableColumns(db *sql.DB, table string) ([]sqlColumn, error) {
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, quoteSQLIdent(table)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var columns []sqlColumn
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		columns = append(columns, sqlColumn{name: name, notNull: notNull != 0, primaryKey: primaryKey > 0})
	}
	return columns, rows.Err()
}

func validateSQLRows(db *sql.DB, file *zip.File, table TableSchema) (int64, error) {
	columns, err := tableColumns(db, table.Name)
	if err != nil {
		return 0, err
	}
	known := make(map[string]bool, len(columns)+1)
	for _, column := range columns {
		known[column.name] = true
	}
	if !table.WithoutRowid {
		known["__rowid"] = true
	}

	names := make([]string, 0, len(columns)+1)
	if !table.WithoutRowid {
		names = append(names, "rowid")
	}
	for _, column := range columns {
		names = append(names, quoteSQLIdent(column.name))
	}
	prefix := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES (",
		quoteSQLIdent(table.Name),
		strings.Join(names, ", "),
	)

	reader, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer reader.Close()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), scannerLimit)
	var count int64
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			return 0, fmt.Errorf("blank line at row %d", count+1)
		}
		var row map[string]json.RawMessage
		if err := json.Unmarshal(line, &row); err != nil {
			return 0, fmt.Errorf("invalid JSON at row %d: %v", count+1, err)
		}
		for name := range row {
			if !known[name] {
				return 0, fmt.Errorf("row %d has unknown column %s", count+1, name)
			}
		}

		placeholders := make([]string, 0, len(names))
		bindings := make([]any, 0, len(names))
		if !table.WithoutRowid {
			raw, ok := row["__rowid"]
			if !ok {
				placeholders = append(placeholders, "?")
				bindings = append(bindings, nil)
			} else {
				value, placeholder, err := archiveValue(raw)
				if err != nil {
					return 0, fmt.Errorf("row %d __rowid: %v", count+1, err)
				}
				placeholders = append(placeholders, placeholder)
				bindings = append(bindings, value)
			}
		}
		for _, column := range columns {
			raw, ok := row[column.name]
			if !ok {
				placeholders = append(placeholders, "?")
				bindings = append(bindings, nil)
				continue
			}
			value, placeholder, err := archiveValue(raw)
			if err != nil {
				return 0, fmt.Errorf("row %d column %s: %v", count+1, column.name, err)
			}
			placeholders = append(placeholders, placeholder)
			bindings = append(bindings, value)
		}
		if _, err := db.Exec(prefix+strings.Join(placeholders, ", ")+")", bindings...); err != nil {
			return 0, fmt.Errorf("row %d: %v", count+1, err)
		}
		count++
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return count, nil
}

func validateKVEntry(file *zip.File) (int64, error) {
	reader, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer reader.Close()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), scannerLimit)
	seen := map[string]bool{}
	var count int64
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			return 0, fmt.Errorf("blank line at row %d", count+1)
		}
		var row map[string]json.RawMessage
		if err := json.Unmarshal(line, &row); err != nil {
			return 0, fmt.Errorf("invalid JSON at row %d: %v", count+1, err)
		}
		if len(row) != 2 {
			return 0, fmt.Errorf("row %d must contain only key and value", count+1)
		}
		var key, value string
		if err := json.Unmarshal(row["key"], &key); err != nil || key == "" {
			return 0, fmt.Errorf("row %d has an invalid key", count+1)
		}
		if err := json.Unmarshal(row["value"], &value); err != nil {
			return 0, fmt.Errorf("row %d has a non-string value", count+1)
		}
		if !json.Valid([]byte(value)) {
			return 0, fmt.Errorf("row %d value is not valid JSON", count+1)
		}
		if seen[key] {
			return 0, fmt.Errorf("row %d duplicates key %s", count+1, key)
		}
		seen[key] = true
		count++
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return count, nil
}

func archiveValue(raw json.RawMessage) (any, string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, "", errors.New("empty value")
	}
	switch trimmed[0] {
	case 'n':
		if trimmed != "null" {
			return nil, "", fmt.Errorf("unsupported value %s", trimmed)
		}
		return nil, "?", nil
	case '"':
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil, "", err
		}
		return text, "?", nil
	case '{':
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return nil, "", err
		}
		if len(fields) != 1 {
			return nil, "", fmt.Errorf("encoded value must have exactly one tag")
		}
		for tag, encoded := range fields {
			var text string
			if err := json.Unmarshal(encoded, &text); err != nil {
				return nil, "", fmt.Errorf("%s must be a string", tag)
			}
			switch tag {
			case "$int":
				if !integerText.MatchString(text) {
					return nil, "", fmt.Errorf("invalid $int %q", text)
				}
				if _, err := strconv.ParseInt(text, 10, 64); err != nil {
					return nil, "", fmt.Errorf("invalid $int %q: outside the int64 range", text)
				}
				return text, "CAST(? AS INTEGER)", nil
			case "$real":
				value, err := strconv.ParseFloat(text, 64)
				if err != nil && !errors.Is(err, strconv.ErrRange) {
					return nil, "", fmt.Errorf("invalid $real %q", text)
				}
				if math.IsNaN(value) {
					return nil, "", fmt.Errorf("invalid $real %q", text)
				}
				return text, "CAST(? AS REAL)", nil
			case "$blob":
				decoded, err := base64.StdEncoding.DecodeString(text)
				if err != nil {
					return nil, "", fmt.Errorf("invalid $blob: %v", err)
				}
				return decoded, "?", nil
			default:
				return nil, "", fmt.Errorf("unknown value tag %s", tag)
			}
		}
		return nil, "", errors.New("missing encoded value")
	case 't', 'f':
		return nil, "", errors.New("boolean values are not supported")
	default:
		if !integerText.MatchString(trimmed) {
			return nil, "", fmt.Errorf("plain numbers must be integers, got %s", trimmed)
		}
		value, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return nil, "", fmt.Errorf("plain integer %s is outside the int64 range; encode it as $int", trimmed)
		}
		if value > jsSafeIntMax || value < -jsSafeIntMax {
			return nil, "", fmt.Errorf("plain integer %s is outside the JavaScript safe range; encode it as $int", trimmed)
		}
		return trimmed, "CAST(? AS INTEGER)", nil
	}
}

func quoteSQLIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
