package deployment

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

func TestJournalRoundTripsWithoutSecretValues(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "journal")
	journal, err := NewJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	record := OperationRecord{
		OperationID:     "op-test",
		Target:          domain.Target{AccountID: "0123456789abcdef0123456789abcdef", ScriptName: "deskwand-bot"},
		State:           StateUnknown,
		Steps:           applySteps(i18n.ZH),
		BaseFingerprint: "fingerprint",
		BaseVersionID:   "version-base",
		StagedVersionID: "version-staged",
		SecretRefs:      []string{"deployment.op.op-test.TELEGRAM_BOT_TOKEN"},
		ConfigJSON:      []byte(`{"schemaVersion":1}`),
		SecretEdits: []domain.SecretEdit{
			domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, serviceSecretSentinel),
		},
		StageAttempted: true,
		CreatedAt:      time.Unix(1, 0).UTC(),
		UpdatedAt:      time.Unix(2, 0).UTC(),
	}
	if err := journal.Save(record); err != nil {
		t.Fatal(err)
	}
	loaded, err := journal.Load(record.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.OperationID != record.OperationID || loaded.StagedVersionID != record.StagedVersionID {
		t.Fatalf("loaded = %#v", loaded)
	}
	if len(loaded.SecretEdits) != 1 || loaded.SecretEdits[0].Value() != "" {
		t.Fatalf("secret edit value was persisted: %#v", loaded.SecretEdits)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "op-test.json" {
		t.Fatalf("journal entries = %#v", entries)
	}
	data, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(serviceSecretSentinel)) {
		t.Fatal("journal contains a secret value")
	}
	info, err := entries[0].Info()
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("journal mode = %o, want 600", info.Mode().Perm())
	}
}

func TestJournalRejectsUnsafeOperationIDs(t *testing.T) {
	journal, err := NewJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "../escape", "a/b", ".hidden", "a b"} {
		if err := journal.Save(OperationRecord{OperationID: id}); err == nil {
			t.Errorf("Save accepted operation id %q", id)
		}
		if _, err := journal.Load(id); err == nil {
			t.Errorf("Load accepted operation id %q", id)
		}
	}
}
