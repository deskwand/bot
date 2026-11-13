package container

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/sshhost"
)

func TestAllowlistMatchesContainerEntrypoint(t *testing.T) {
	want, err := os.ReadFile("../../../container/env-allowlist.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(allowlistData, want) {
		t.Fatalf("embedded allowlist differs from container/env-allowlist.txt")
	}
}

func TestAllowed(t *testing.T) {
	allowed := []string{"ADMIN_TOKEN", "MODEL_KEY_OPENCODE_GO", "EXCHANGE_SECRET_OKX_MAIN"}
	for _, name := range allowed {
		if !Allowed(name) {
			t.Errorf("Allowed(%q) = false, want true", name)
		}
	}
	rejected := []string{"PATH", "MODEL_KEY_", "model_key_x", "MODEL_KEY_a-b"}
	for _, name := range rejected {
		if Allowed(name) {
			t.Errorf("Allowed(%q) = true, want false", name)
		}
	}
}

func TestReadSnapshot(t *testing.T) {
	env := "ADMIN_TOKEN=t\nMODEL_KEY_X=s3cr3t-value\nSEARCH_KEY_TAVILY=\n" +
		"ACTIVE_CHANNEL=telegram\nUNRELATED=1\nDESKWAND_CONFIG='{\"schemaVersion\":1}'\n"
	host := &fakeHost{files: map[string][]byte{
		"~/deskwand/.env":         []byte(env),
		"~/deskwand/compose.yaml": []byte("services:\n  bot:\n    image: ghcr.io/deskwand/bot:1.2.0\n"),
	}}

	snapshot, err := newService(host).ReadSnapshot(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(snapshot.SecretNames, []string{"ADMIN_TOKEN", "MODEL_KEY_X"}) {
		t.Errorf("SecretNames = %v", snapshot.SecretNames)
	}
	if string(snapshot.ConfigJSON) != `{"schemaVersion":1}` {
		t.Errorf("ConfigJSON = %s", snapshot.ConfigJSON)
	}
	if snapshot.ReleaseVersion != "1.2.0" {
		t.Errorf("ReleaseVersion = %q", snapshot.ReleaseVersion)
	}
	if snapshot.VersionID != "container:1.2.0" {
		t.Errorf("VersionID = %q", snapshot.VersionID)
	}
	if snapshot.Fingerprint != envfile.Fingerprint([]byte(env)) {
		t.Errorf("Fingerprint = %q", snapshot.Fingerprint)
	}
	var settings struct {
		Bindings []struct {
			Name string `json:"name"`
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"bindings"`
	}
	if err := json.Unmarshal(snapshot.SettingsJSON, &settings); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, binding := range settings.Bindings {
		if binding.Name == "ACTIVE_CHANNEL" && binding.Text == "telegram" {
			found = true
		}
	}
	if !found {
		t.Errorf("SettingsJSON does not carry ACTIVE_CHANNEL: %s", snapshot.SettingsJSON)
	}
	for _, rendered := range []string{fmt.Sprintf("%+v", snapshot), string(mustMarshal(t, snapshot))} {
		if strings.Contains(rendered, "s3cr3t-value") {
			t.Fatalf("snapshot leaked a secret value: %s", rendered)
		}
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestReadSnapshotInvalidConfig(t *testing.T) {
	cases := map[string]map[string][]byte{
		"invalid config json": {
			"~/deskwand/.env": []byte("DESKWAND_CONFIG='{not json'\n"),
		},
		"missing env file": {},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := newService(&fakeHost{files: files}).ReadSnapshot(context.Background(), containerTarget())
			assertCode(t, err, domain.ENV_FILE_INVALID)
		})
	}
}

func TestStatus(t *testing.T) {
	const healthy = "running|healthy|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.0\n"

	t.Run("healthy", func(t *testing.T) {
		host := &fakeHost{respond: func(command string) (sshhost.Result, error) {
			if strings.Contains(command, "docker inspect") {
				return sshhost.Result{Stdout: []byte(healthy)}, nil
			}
			return sshhost.Result{ExitCode: 1}, nil
		}}
		status, err := newService(host).Status(context.Background(), containerTarget())
		if err != nil {
			t.Fatal(err)
		}
		want := RuntimeStatus{
			Reachable: true,
			Running:   true,
			Health:    "healthy",
			Image:     "ghcr.io/deskwand/bot:1.2.0",
			StartedAt: "2026-11-13T02:00:00Z",
		}
		if status != want {
			t.Errorf("Status = %+v, want %+v", status, want)
		}
	})

	t.Run("not running", func(t *testing.T) {
		host := &fakeHost{respond: func(string) (sshhost.Result, error) {
			return sshhost.Result{ExitCode: 1}, nil
		}}
		status, err := newService(host).Status(context.Background(), containerTarget())
		if err != nil {
			t.Fatal(err)
		}
		if !status.Reachable || status.Running {
			t.Errorf("Status = %+v, want reachable but not running", status)
		}
	})

	t.Run("unreachable", func(t *testing.T) {
		service := New(Options{Dial: func(domain.Target) (Host, error) {
			return nil, domain.Error{Code: domain.SSH_UNREACHABLE}
		}})
		status, err := service.Status(context.Background(), containerTarget())
		if err != nil {
			t.Fatal(err)
		}
		if status.Reachable {
			t.Errorf("Status = %+v, want unreachable", status)
		}
	})

	t.Run("can restore", func(t *testing.T) {
		host := &fakeHost{files: map[string][]byte{
			"~/deskwand/.env.bak": []byte("ADMIN_TOKEN=t\n"),
		}}
		host.respond = func(command string) (sshhost.Result, error) {
			if strings.Contains(command, "docker inspect") {
				return sshhost.Result{Stdout: []byte(healthy)}, nil
			}
			if _, ok := host.files["~/deskwand/.env.bak"]; ok && strings.Contains(command, ".env.bak") {
				return sshhost.Result{}, nil
			}
			return sshhost.Result{ExitCode: 1}, nil
		}
		status, err := newService(host).Status(context.Background(), containerTarget())
		if err != nil {
			t.Fatal(err)
		}
		if !status.CanRestore {
			t.Errorf("Status = %+v, want CanRestore", status)
		}
	})
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v, want domain.Error with code %s", err, code)
	}
	if coded.Code != code {
		t.Fatalf("error code = %q, want %q", coded.Code, code)
	}
}
