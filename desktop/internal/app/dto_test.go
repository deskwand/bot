package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"testing"
)

const dtoSentinel = "DTO-SENTINEL-must-never-serialize"

func TestSecretInputDTOsMarshalWithoutValues(t *testing.T) {
	config := ConfigEditDTO{
		BaseFingerprint: "fp",
		Secrets: []SecretEditDTO{{
			Name: "MODEL_KEY_ANTHROPIC", Operation: "replace", Value: dtoSentinel,
		}},
	}
	importInput := ImportInputDTO{
		BaseFingerprint: "fp",
		Secrets: []ImportSecretDTO{{
			Name: "MCP_TOKEN", Value: dtoSentinel,
		}},
	}
	for _, value := range []any{
		SecretEditDTO{Name: "X", Operation: "replace", Value: dtoSentinel},
		ImportSecretDTO{Name: "X", Value: dtoSentinel},
		config,
		importInput,
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(encoded, []byte(dtoSentinel)) {
			t.Fatalf("%T JSON leaked the value: %s", value, encoded)
		}
	}
}

func TestSecretInputDTOsFormatAndLogWithoutValues(t *testing.T) {
	config := ConfigEditDTO{
		BaseFingerprint: "fp",
		Secrets: []SecretEditDTO{{
			Name: "MODEL_KEY_ANTHROPIC", Operation: "replace", Value: dtoSentinel,
		}},
	}
	importInput := ImportInputDTO{
		BaseFingerprint: "fp",
		Secrets: []ImportSecretDTO{{
			Name: "MCP_TOKEN", Value: dtoSentinel,
		}},
	}
	for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
		for _, value := range []any{config, importInput} {
			rendered := fmt.Sprintf(format, value)
			if strings.Contains(rendered, dtoSentinel) {
				t.Fatalf("%s on %T leaked the value: %s", format, value, rendered)
			}
		}
	}

	var buffer bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buffer, nil))
	logger.Info("input", "config", config, "import", importInput)
	if strings.Contains(buffer.String(), dtoSentinel) {
		t.Fatalf("slog JSON leaked the value: %s", buffer.String())
	}
}

func TestBoundServiceMethodSetAndResultFieldNames(t *testing.T) {
	expected := map[string]bool{
		"AbandonOperation": true, "CancelCloudflareLogin": true, "CancelWeChatLogin": true,
		"CheckClientUpdate": true, "CloudflareStatus": true, "ConfirmCloudflareAccount": true,
		"ConfirmImport": true, "ConnectTelegram": true,
		"DisconnectCloudflare": true, "ExportDiagnostics": true, "GetConfig": true,
		"InspectImport": true, "Install": true, "InstallClientUpdate": true,
		"ListWorkers": true, "ModelCatalog": true, "Name": true,
		"StartCloudflareLogin": true,
		"PendingOperations":    true, "PreviewConfig": true, "ProbeModel": true,
		"PublishConfig": true, "ResumeOperation": true, "SelectDeployment": true,
		"SelectEntry": true, "StartWeChatLogin": true, "Status": true,
		"Upgrade": true, "UpgradeAvailable": true,
	}
	serviceType := reflect.TypeOf(&Service{})
	seen := map[string]bool{}
	for i := 0; i < serviceType.NumMethod(); i++ {
		method := serviceType.Method(i)
		seen[method.Name] = true
		if !expected[method.Name] {
			t.Fatalf("unexpected bound method %q", method.Name)
		}
		methodType := method.Type
		for out := 0; out < methodType.NumOut(); out++ {
			checkResultFields(t, method.Name, methodType.Out(out), map[reflect.Type]bool{})
		}
	}
	for name := range expected {
		if !seen[name] {
			t.Fatalf("bound method %q is missing", name)
		}
	}
}

func checkResultFields(t *testing.T, method string, typ reflect.Type, seen map[reflect.Type]bool) {
	t.Helper()
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice || typ.Kind() == reflect.Array {
		typ = typ.Elem()
	}
	if typ.Kind() == reflect.Map {
		checkResultFields(t, method, typ.Key(), seen)
		checkResultFields(t, method, typ.Elem(), seen)
		return
	}
	if typ.Kind() != reflect.Struct || seen[typ] {
		return
	}
	seen[typ] = true
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if field.PkgPath != "" {
			continue
		}
		normalized := strings.ToLower(strings.ReplaceAll(field.Name, "_", ""))
		if forbiddenResultField(normalized) {
			t.Fatalf("%s returns %s.%s, which looks like a secret value", method, typ.Name(), field.Name)
		}
		checkResultFields(t, method, field.Type, seen)
	}
}

func forbiddenResultField(name string) bool {
	switch name {
	case "token", "accesstoken", "refreshtoken", "password", "secret",
		"secretvalue", "apikey", "privatekey", "botkey", "modelkey", "value":
		return true
	}
	return strings.HasSuffix(name, "token") || strings.HasSuffix(name, "password")
}
