package backup

import "testing"

func TestValidateSchemaSQLAcceptsNamesThatLookLikeKeywords(t *testing.T) {
	// The Agents SDK's cf_agent_tool_runs table and any table with an
	// attachment column tripped the old keyword check, which rejected a
	// perfectly good backup.
	statements := []string{
		`CREATE TABLE cf_agent_tool_runs (run_id TEXT PRIMARY KEY, detached_at INTEGER, status TEXT NOT NULL DEFAULT 'detached')`,
		`CREATE TABLE media (attachments TEXT, detached INTEGER NOT NULL DEFAULT 0)`,
	}
	for _, statement := range statements {
		if err := validateSchemaSQL(statement, createTable, "table"); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

func TestValidateSchemaSQLRejectsASecondStatement(t *testing.T) {
	statement := `CREATE TABLE a (n INTEGER); ATTACH DATABASE '/tmp/x' AS y`
	if err := validateSchemaSQL(statement, createTable, "table"); err == nil {
		t.Fatal("a statement that smuggles a second one was accepted")
	}
}

func TestValidateSchemaSQLRejectsANonCreateStatement(t *testing.T) {
	if err := validateSchemaSQL(`DROP TABLE a`, createTable, "table"); err == nil {
		t.Fatal("a non-CREATE statement was accepted as a table definition")
	}
}

func TestValidateSchemaSQLAllowsSemicolonsInsideLiterals(t *testing.T) {
	statements := []string{
		`CREATE TABLE t (msg TEXT DEFAULT 'a;b')`,
		`CREATE TABLE t (msg TEXT CHECK (msg <> 'x;y'))`,
		`CREATE TABLE "we;ird" (n INTEGER)`,
		`CREATE TABLE t (msg TEXT DEFAULT 'it''s; fine')`,
	}
	for _, statement := range statements {
		if err := validateSchemaSQL(statement, createTable, "table"); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

func TestValidateSchemaSQLStillRejectsARealSecondStatement(t *testing.T) {
	statements := []string{
		`CREATE TABLE t (n INTEGER); DROP TABLE t`,
		`CREATE TABLE t (n INTEGER);ATTACH DATABASE '/tmp/x' AS y`,
	}
	for _, statement := range statements {
		if err := validateSchemaSQL(statement, createTable, "table"); err == nil {
			t.Fatalf("%s was accepted", statement)
		}
	}
}
