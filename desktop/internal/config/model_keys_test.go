package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const modelKeyConfig = `{
  "schemaVersion": 1,
  "owner": {"telegramUserIds": []},
  "models": {
    "butler": {"provider": "deepseek", "id": "deepseek-flash"},
    "task": {"provider": "deepseek", "id": "deepseek-flash"}
  },
  "mcpServers": []
}`

func TestCheckModelKeysReportsMissingSecrets(t *testing.T) {
	err := CheckModelKeys([]byte(modelKeyConfig), []string{"TELEGRAM_BOT_TOKEN"}, nil)
	if err == nil {
		t.Fatal("CheckModelKeys() = nil, want an error")
	}
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.MODEL_KEY_MISSING {
		t.Fatalf("error = %v, want %s", err, domain.MODEL_KEY_MISSING)
	}
	if !strings.Contains(coded.Message, "MODEL_KEY_DEEPSEEK") {
		t.Fatalf("message = %q, want it to list the missing key", coded.Message)
	}
}

func TestCheckModelKeysAcceptsAKeyReplacedThisPublish(t *testing.T) {
	edits := []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretReplace, "value")}
	if err := CheckModelKeys([]byte(modelKeyConfig), nil, edits); err != nil {
		t.Fatalf("CheckModelKeys() = %v, want nil", err)
	}
}

func TestCheckModelKeysRejectsAClearedKey(t *testing.T) {
	edits := []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretClear, "")}
	err := CheckModelKeys([]byte(modelKeyConfig), []string{"MODEL_KEY_DEEPSEEK"}, edits)
	if err == nil {
		t.Fatal("CheckModelKeys() = nil, want an error")
	}
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.MODEL_KEY_MISSING {
		t.Fatalf("error = %v, want %s", err, domain.MODEL_KEY_MISSING)
	}
}

func TestCheckModelKeysListsEachProviderOnce(t *testing.T) {
	err := CheckModelKeys([]byte(modelKeyConfig), nil, nil)
	if err == nil {
		t.Fatal("CheckModelKeys() = nil, want an error")
	}
	if count := strings.Count(err.Error(), "MODEL_KEY_DEEPSEEK"); count != 1 {
		t.Fatalf("message %q mentions the key %d times, want once", err.Error(), count)
	}
}
