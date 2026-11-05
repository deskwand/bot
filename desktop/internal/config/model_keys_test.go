package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
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
	err := CheckModelKeys(i18n.ZH, []byte(modelKeyConfig), []string{"TELEGRAM_BOT_TOKEN"}, nil)
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
	if err := CheckModelKeys(i18n.ZH, []byte(modelKeyConfig), nil, edits); err != nil {
		t.Fatalf("CheckModelKeys() = %v, want nil", err)
	}
}

func TestCheckModelKeysRejectsAClearedKey(t *testing.T) {
	edits := []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_DEEPSEEK", domain.SecretClear, "")}
	err := CheckModelKeys(i18n.ZH, []byte(modelKeyConfig), []string{"MODEL_KEY_DEEPSEEK"}, edits)
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

const keylessModelKeyConfig = `{
  "schemaVersion": 1,
  "owner": {"telegramUserIds": []},
  "models": {
    "butler": {"provider": "workers-ai", "id": "@cf/zai-org/glm-5.3-flash"},
    "task": {"provider": "workers-ai", "id": "@cf/zai-org/glm-5.3-flash"}
  },
  "mcpServers": []
}`

func TestCheckModelKeysAllowsKeyless(t *testing.T) {
	if err := CheckModelKeys(i18n.ZH, []byte(keylessModelKeyConfig), nil, nil); err != nil {
		t.Fatalf("CheckModelKeys() = %v, want nil", err)
	}
}

func TestCheckModelKeysRequiresCustomProviderKey(t *testing.T) {
	err := CheckModelKeys(i18n.ZH, []byte(customModelKeyConfig), nil, nil)
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
			err := CheckModelKeys(i18n.ZH, []byte(modelKeyConfig), []string{"MODEL_KEY_DEEPSEEK"}, testCase.edits)
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
	err := CheckModelKeys(i18n.ZH, []byte(modelKeyConfig), nil, nil)
	if err == nil {
		t.Fatal("CheckModelKeys() = nil, want an error")
	}
	if count := strings.Count(err.Error(), "MODEL_KEY_DEEPSEEK"); count != 1 {
		t.Fatalf("message %q mentions the key %d times, want once", err.Error(), count)
	}
}

func TestMissingModelKeysFollowsLocale(t *testing.T) {
	for _, locale := range []string{i18n.ZH, i18n.EN} {
		t.Run(locale, func(t *testing.T) {
			err := CheckModelKeys(locale, []byte(modelKeyConfig), nil, nil)
			var coded domain.Error
			if !errors.As(err, &coded) || coded.Code != domain.MODEL_KEY_MISSING {
				t.Fatalf("error = %v, want %s", err, domain.MODEL_KEY_MISSING)
			}
			if locale == i18n.EN {
				i18ntest.NoHan(t, "missing model keys", coded.Message)
				if !strings.Contains(coded.Message, "MODEL_KEY_DEEPSEEK") {
					t.Fatalf("message = %q, want it to list the missing key", coded.Message)
				}
				return
			}
			if want := "缺少模型 key：MODEL_KEY_DEEPSEEK"; coded.Message != want {
				t.Fatalf("message = %q, want %q", coded.Message, want)
			}
		})
	}
}
