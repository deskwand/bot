package domain

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"testing"
)

const secretSentinel = "sk-domain-SENTINEL-never-print-0123456789"

func assertNoSentinel(t *testing.T, label, output string) {
	t.Helper()
	if strings.Contains(output, secretSentinel) {
		t.Fatalf("%s leaked the secret value: %s", label, output)
	}
}

func TestSecretEditNeverSerializesValue(t *testing.T) {
	edit := NewSecretEdit("TELEGRAM_BOT_TOKEN", SecretReplace, secretSentinel)

	encoded, err := json.Marshal(edit)
	if err != nil {
		t.Fatal(err)
	}
	assertNoSentinel(t, "json.Marshal", string(encoded))

	for _, format := range []string{"%v", "%+v", "%#v"} {
		assertNoSentinel(t, format, fmt.Sprintf(format, edit))
	}

	if got := fmt.Sprintf("%v", edit); !strings.Contains(got, RedactedValue) {
		t.Fatalf("%%v output = %q, want redaction marker", got)
	}
	if got := fmt.Sprintf("%v", NewSecretEdit("KEEP", SecretKeep, "")); strings.Contains(got, RedactedValue) {
		t.Fatalf("empty value still showed a redaction marker: %q", got)
	}
}

func TestChangeAndPublishPlanNeverSerializeValues(t *testing.T) {
	edit := NewSecretEdit("DEEPSEEK_API_KEY", SecretReplace, secretSentinel)
	change := Change{
		BaseFingerprint: "fingerprint",
		Patch: EditablePatch{
			ButlerModel: rawJSON(t, `{"provider":"opencode-go","id":"m"}`),
		},
		Secrets: []SecretEdit{edit},
	}
	plan := PublishPlan{
		BaseVersionID: "version-1",
		ConfigJSON:    []byte(`{"schemaVersion":1}`),
		Secrets:       []SecretEdit{edit},
	}

	for name, value := range map[string]any{"change": change, "plan": plan} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("%s marshal: %v", name, err)
		}
		assertNoSentinel(t, name+" json.Marshal", string(encoded))
		for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
			assertNoSentinel(t, name+" "+format, fmt.Sprintf(format, value))
		}
	}
}

func TestFormattingAContainingStructRedactsNestedEdit(t *testing.T) {
	type holder struct {
		Edit SecretEdit
		pin  string
	}
	value := holder{Edit: NewSecretEdit("TELEGRAM_BOT_TOKEN", SecretReplace, secretSentinel), pin: "unrelated"}

	for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
		assertNoSentinel(t, "holder "+format, fmt.Sprintf(format, value))
	}

	var encoded bytes.Buffer
	if err := gob.NewEncoder(&encoded).Encode(value.Edit); err != nil {
		t.Fatalf("gob encode: %v", err)
	}
	assertNoSentinel(t, "gob", encoded.String())

	reflected := reflect.ValueOf(value.Edit)
	field, ok := reflected.Type().FieldByName("value")
	if !ok || field.PkgPath == "" {
		t.Fatal("secret value field is exported")
	}
	if reflected.FieldByIndex(field.Index).CanInterface() {
		t.Fatal("reflection can expose the secret value")
	}
}

func TestEditablePatchUsesCamelCaseJSON(t *testing.T) {
	ids := []int64{7}
	encoded, err := json.Marshal(EditablePatch{
		TelegramUserIDs: &ids,
		ButlerModel:     rawJSON(t, `{"provider":"opencode-go","id":"m"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"telegramUserIds"`, `"butlerModel"`, `"taskModel"`} {
		if !strings.Contains(string(encoded), key) {
			t.Fatalf("patch JSON %s is missing %s", encoded, key)
		}
	}
	if !strings.Contains(string(encoded), `"taskModel":null`) {
		t.Fatalf("nil task model is not encoded as null: %s", encoded)
	}
}

func TestSecretEditValueAccessor(t *testing.T) {
	edit := NewSecretEdit("TOKEN", SecretReplace, secretSentinel)
	if edit.Value() != secretSentinel {
		t.Fatal("Value() did not return the in-memory secret")
	}
	if got := fmt.Sprintf("%s", edit); strings.Contains(got, secretSentinel) {
		t.Fatalf("%%s leaked the secret: %s", got)
	}
}

func TestSlogOutputNeverContainsSecretValue(t *testing.T) {
	edit := NewSecretEdit("WECHAT_CREDENTIALS", SecretReplace, secretSentinel)
	var buffer bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buffer, nil))

	logger.Info("test",
		"edit", edit,
		"change", Change{Secrets: []SecretEdit{edit}},
		"plan", PublishPlan{Secrets: []SecretEdit{edit}},
	)

	assertNoSentinel(t, "slog", buffer.String())
	if !strings.Contains(buffer.String(), RedactedValue) {
		t.Fatalf("slog output did not mark the redacted value: %s", buffer.String())
	}
}

func TestDomainErrorAsSupportsValuesAndPointers(t *testing.T) {
	err := error(Error{Code: CONFIG_CONFLICT, Message: "stale"})

	var value Error
	if !asError(err, &value) || value.Code != CONFIG_CONFLICT {
		t.Fatalf("errors.As into Error failed: %#v", value)
	}
	var pointer *Error
	if !asError(err, &pointer) || pointer == nil || pointer.Code != CONFIG_CONFLICT {
		t.Fatalf("errors.As into *Error failed: %#v", pointer)
	}
}

func asError(err error, target any) bool {
	for err != nil {
		if matcher, ok := err.(interface{ As(any) bool }); ok && matcher.As(target) {
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

func TestCanonicalizeJSONSortsKeysAndPreservesNumbers(t *testing.T) {
	raw := []byte(`{"b": 2, "a": {"z": 1, "y": 9007199254740993}, "c": [3, 1]}`)
	got, err := CanonicalizeJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"a":{"y":9007199254740993,"z":1},"b":2,"c":[3,1]}`
	if string(got) != want {
		t.Fatalf("canonical JSON = %s, want %s", got, want)
	}

	again, err := CanonicalizeJSON([]byte(`{"c":[3,1],"a":{"y":9007199254740993,"z":1},"b":2}`))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, again) {
		t.Fatal("canonical encoding depends on input key order")
	}
}

func rawJSON(t *testing.T, value string) *json.RawMessage {
	t.Helper()
	raw := json.RawMessage(value)
	if !json.Valid(raw) {
		t.Fatalf("invalid fixture JSON: %s", value)
	}
	return &raw
}
