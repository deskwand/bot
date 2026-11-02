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

const customModelKeyConfig = `{
  "schemaVersion": 1,
  "owner": {"telegramUserIds": []},
  "models": {
    "butler": {"provider": "my-proxy", "id": "gpt-5.6"},
    "task": {"provider": "my-proxy", "id": "gpt-5.6"},
    "customProviders": [{
      "id": "my-proxy",
      "api": "openai-completions",
      "baseUrl": "https://proxy.example.com/v1",
      "models": [{"id": "gpt-5.6"}]
    }]
  },
  "mcpServers": []
}`

func TestCheckModelKeysRequiresCustomProviderKey(t *testing.T) {
	err := CheckModelKeys([]byte(customModelKeyConfig), nil, nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.MODEL_KEY_MISSING {
		t.Fatalf("error = %v, want %s", err, domain.MODEL_KEY_MISSING)
	}
	if !strings.Contains(coded.Message, "MODEL_KEY_MY_PROXY") {
		t.Fatalf("message = %q, want it to list the custom provider key", coded.Message)
	}
}

func TestCheckModelKeysUsesTheLastEditForTheSameName(t *testing.T) {
	tests := []struct {
		name    string
		edits   []domain.SecretEdit
		wantErr bool
	}{
		{
			name: "clear then replace",
			edits: []domain.SecretEdit{
				domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretClear, ""),
				domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretReplace, "value"),
			},
		},
		{
			name: "replace then clear",
			edits: []domain.SecretEdit{
				domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretReplace, "value"),
				domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretClear, ""),
			},
			wantErr: true,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			err := CheckModelKeys([]byte(modelKeyConfig), []string{"MODEL_KEY_DEEPSEEK"}, testCase.edits)
			if testCase.wantErr {
				if err == nil {
					t.Fatal("CheckModelKeys() = nil, want an error")
				}
				return
			}
			if err != nil {
				t.Fatalf("CheckModelKeys() = %v, want nil", err)
			}
		})
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
