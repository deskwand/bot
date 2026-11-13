package container

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

// seededConfig is already in canonical JSON form, so a publish that changes
// nothing keeps the DESKWAND_CONFIG bytes unchanged.
const seededConfig = `{"mcpServers":[],"models":{"butler":{"id":"deepseek-v4.1-flash","provider":"opencode-go"},"task":{"id":"kimi-k3","provider":"opencode-go"}},"owner":{"telegramUserIds":[1]},"schemaVersion":1}`

func seededEnv() []byte {
	return []byte("ADMIN_TOKEN=t\nMODEL_KEY_X=old-key\nACTIVE_CHANNEL=telegram\n# hand note\nUNRELATED=1\nDESKWAND_CONFIG='" + seededConfig + "'\n")
}

func seedInstance(host *fakeHost) {
	host.files = map[string][]byte{
		"~/deskwand/.env":         seededEnv(),
		"~/deskwand/compose.yaml": []byte("services:\n  bot:\n    image: ghcr.io/deskwand/bot:1.2.3\n"),
	}
	host.respond = publishRespond(host, "healthy", "")
}

func publishRespond(host *fakeHost, health, logs string) func(string) (hostexec.Result, error) {
	return func(command string) (hostexec.Result, error) {
		switch {
		case strings.HasPrefix(command, "cp -p "):
			if strings.HasSuffix(command, ".env'") {
				host.files["~/deskwand/.env"] = append([]byte(nil), host.files["~/deskwand/.env.bak"]...)
			} else {
				host.files["~/deskwand/.env.bak"] = append([]byte(nil), host.files["~/deskwand/.env"]...)
			}
			return hostexec.Result{}, nil
		case strings.Contains(command, "docker compose up -d"):
			return hostexec.Result{}, nil
		case strings.Contains(command, "docker inspect"):
			return hostexec.Result{Stdout: []byte("running|" + health + "|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.3\n")}, nil
		case strings.Contains(command, "docker compose logs"):
			return hostexec.Result{Stdout: []byte(logs + "\n")}, nil
		case strings.HasPrefix(command, "test -e"):
			if _, ok := host.files["~/deskwand/.env.bak"]; ok {
				return hostexec.Result{}, nil
			}
			return hostexec.Result{ExitCode: 1}, nil
		}
		return hostexec.Result{ExitCode: 1}, nil
	}
}

func seededChange(host *fakeHost, change domain.Change) domain.Change {
	change.BaseFingerprint = envfile.Fingerprint(host.files["~/deskwand/.env"])
	return change
}

func ownerIDs(ids ...int64) *[]int64 {
	return &ids
}

func commandIndex(commands []string, substring string) int {
	for index, command := range commands {
		if strings.Contains(command, substring) {
			return index
		}
	}
	return -1
}

func TestPreviewWritesNothing(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	before := map[string][]byte{
		"~/deskwand/.env":         append([]byte(nil), host.files["~/deskwand/.env"]...),
		"~/deskwand/compose.yaml": append([]byte(nil), host.files["~/deskwand/compose.yaml"]...),
	}

	steps, err := newService(host).Preview(context.Background(), containerTarget(),
		seededChange(host, domain.Change{Patch: domain.EditablePatch{TelegramUserIDs: ownerIDs(1, 2)}}))
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(steps))
	for _, step := range steps {
		ids = append(ids, step.ID)
	}
	if want := []string{"restart", "write-env", "healthy"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("step IDs = %v, want %v", ids, want)
	}
	if steps[0].State != "info" || steps[0].Message == "" {
		t.Errorf("restart step = %+v, want an info step with a message", steps[0])
	}
	for _, step := range steps[1:] {
		if step.State != "planned" {
			t.Errorf("step %s = %q, want planned", step.ID, step.State)
		}
	}
	if !reflect.DeepEqual(host.files, before) {
		t.Errorf("preview changed the remote files")
	}
	if commandIndex(host.commands, "up -d") >= 0 {
		t.Errorf("preview started the container")
	}
}

func TestApplyReplacesSecretAndConfig(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	before := append([]byte(nil), host.files["~/deskwand/.env"]...)
	change := seededChange(host, domain.Change{
		Patch:   domain.EditablePatch{TelegramUserIDs: ownerIDs(1, 2)},
		Secrets: []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "new-s3cr3t")},
	})

	result, err := newService(host).Apply(context.Background(), containerTarget(), change)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "published" {
		t.Errorf("State = %q, want published", result.State)
	}
	if result.VersionID != "container:1.2.3" {
		t.Errorf("VersionID = %q, want container:1.2.3", result.VersionID)
	}
	if !bytes.Equal(host.files["~/deskwand/.env.bak"], before) {
		t.Errorf(".env.bak does not hold the previous contents")
	}

	env, err := envfile.Parse(host.files["~/deskwand/.env"])
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := env.Get("MODEL_KEY_X"); got != "new-s3cr3t" {
		t.Errorf("MODEL_KEY_X = %q, want the replaced value", got)
	}
	configValue, _ := env.Get("DESKWAND_CONFIG")
	var document struct {
		Owner struct {
			TelegramUserIDs []int64 `json:"telegramUserIds"`
		} `json:"owner"`
	}
	if err := json.Unmarshal([]byte(configValue), &document); err != nil {
		t.Fatal(err)
	}
	if want := []int64{1, 2}; !reflect.DeepEqual(document.Owner.TelegramUserIDs, want) {
		t.Errorf("telegramUserIds = %v, want %v", document.Owner.TelegramUserIDs, want)
	}
	lines := strings.Split(string(host.files["~/deskwand/.env"]), "\n")
	if len(lines) < 5 || lines[3] != "# hand note" || lines[4] != "UNRELATED=1" {
		t.Errorf("untouched lines moved: %q", lines)
	}

	copyIndex := commandIndex(host.commands, "cp -p ")
	upIndex := commandIndex(host.commands, "docker compose up -d")
	inspectIndex := commandIndex(host.commands, "docker inspect")
	if copyIndex < 0 || upIndex < 0 || inspectIndex < 0 || !(copyIndex < upIndex && upIndex < inspectIndex) {
		t.Errorf("commands = %v, want cp, up, then inspect", host.commands)
	}
	joined := strings.Join(host.commands, "\n")
	for _, secret := range []string{"new-s3cr3t", "old-key"} {
		if strings.Contains(joined, secret) {
			t.Errorf("a secret value reached a remote command")
		}
	}
}

func TestApplyClearsSecretAndSetsVar(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	host.files["~/deskwand/.env"] = append(host.files["~/deskwand/.env"], []byte("SEARCH_KEY_TAVILY=x\n")...)
	change := seededChange(host, domain.Change{
		Secrets: []domain.SecretEdit{domain.NewSecretEdit("SEARCH_KEY_TAVILY", domain.SecretClear, "")},
		Vars:    map[string]string{"ACTIVE_CHANNEL": "wechat"},
	})

	if _, err := newService(host).Apply(context.Background(), containerTarget(), change); err != nil {
		t.Fatal(err)
	}
	env, err := envfile.Parse(host.files["~/deskwand/.env"])
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := env.Get("SEARCH_KEY_TAVILY"); ok {
		t.Errorf("SEARCH_KEY_TAVILY was not cleared")
	}
	if got, _ := env.Get("ACTIVE_CHANNEL"); got != "wechat" {
		t.Errorf("ACTIVE_CHANNEL = %q, want wechat", got)
	}
	if !bytes.Contains(host.files["~/deskwand/.env"], []byte("# hand note")) {
		t.Errorf("the comment line was lost")
	}
}

func TestApplyDetectsConflict(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	change := seededChange(host, domain.Change{Patch: domain.EditablePatch{TelegramUserIDs: ownerIDs(10)}})

	edited := append(append([]byte(nil), host.files["~/deskwand/.env"]...), []byte("UNRELATED=2\n")...)
	host.files["~/deskwand/.env"] = edited

	_, err := newService(host).Apply(context.Background(), containerTarget(), change)
	assertCode(t, err, domain.CONFIG_CONFLICT)
	if !bytes.Equal(host.files["~/deskwand/.env"], edited) {
		t.Errorf("a conflicting publish changed .env")
	}
	if _, ok := host.files["~/deskwand/.env.bak"]; ok {
		t.Errorf("a conflicting publish wrote .env.bak")
	}
	if commandIndex(host.commands, "up -d") >= 0 {
		t.Errorf("a conflicting publish started the container")
	}
}

func TestApplyRejectsUnrepresentableSecretBeforeWriting(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	before := append([]byte(nil), host.files["~/deskwand/.env"]...)
	change := seededChange(host, domain.Change{
		Secrets: []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "it's")},
	})

	_, err := newService(host).Apply(context.Background(), containerTarget(), change)
	assertCode(t, err, domain.ENV_FILE_INVALID)
	if !bytes.Equal(host.files["~/deskwand/.env"], before) {
		t.Errorf(".env changed before the request was validated")
	}
	if _, ok := host.files["~/deskwand/.env.bak"]; ok {
		t.Errorf(".env.bak was written before the request was validated")
	}
	if commandIndex(host.commands, "cp ") >= 0 || commandIndex(host.commands, "up -d") >= 0 {
		t.Errorf("ran a remote command before the request was validated")
	}
}

func TestApplyWithNoDifferenceStillStartsContainer(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	before := append([]byte(nil), host.files["~/deskwand/.env"]...)
	change := seededChange(host, domain.Change{
		Secrets: []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "old-key")},
	})

	result, err := newService(host).Apply(context.Background(), containerTarget(), change)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "published" {
		t.Errorf("State = %q, want published", result.State)
	}
	if !bytes.Equal(host.files["~/deskwand/.env"], before) {
		t.Errorf(".env changed even though the publish had no difference")
	}
	if _, ok := host.files["~/deskwand/.env.bak"]; ok {
		t.Errorf("wrote .env.bak even though the publish had no difference")
	}
	if commandIndex(host.commands, "docker compose up -d") < 0 {
		t.Errorf("a retried publish did not start the container")
	}
	if commandIndex(host.commands, "docker inspect") < 0 {
		t.Errorf("a retried publish did not wait for health")
	}
}

func TestApplyUnhealthyKeepsBackup(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	host.respond = publishRespond(host, "starting", "bad config key=new-s3cr3t")
	before := append([]byte(nil), host.files["~/deskwand/.env"]...)
	change := seededChange(host, domain.Change{
		Secrets: []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "new-s3cr3t")},
	})

	_, err := newService(host).Apply(context.Background(), containerTarget(), change)
	assertCode(t, err, domain.CONTAINER_UNHEALTHY)
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v, want domain.Error", err)
	}
	if !strings.Contains(coded.Message, "bad config") {
		t.Errorf("Message = %q, want the container logs", coded.Message)
	}
	if strings.Contains(coded.Message, "new-s3cr3t") {
		t.Errorf("Message leaked a secret value: %q", coded.Message)
	}
	if !bytes.Equal(host.files["~/deskwand/.env.bak"], before) {
		t.Errorf(".env.bak does not hold the previous contents")
	}
}

func TestRestorePrevious(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)
	change := seededChange(host, domain.Change{
		Secrets: []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "new-key")},
	})
	if _, err := newService(host).Apply(context.Background(), containerTarget(), change); err != nil {
		t.Fatal(err)
	}
	restored := append([]byte(nil), host.files["~/deskwand/.env.bak"]...)
	host.files["~/deskwand/.env"] = []byte("broken\n")

	host.commands = nil
	result, err := newService(host).RestorePrevious(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "published" {
		t.Errorf("State = %q, want published", result.State)
	}
	if !bytes.Equal(host.files["~/deskwand/.env"], restored) {
		t.Errorf(".env was not restored from .env.bak")
	}
	if commandIndex(host.commands, "docker compose up -d") < 0 {
		t.Errorf("restore did not start the container")
	}
	if _, ok := host.files["~/deskwand/.env.bak"]; !ok {
		t.Errorf("restore deleted .env.bak")
	}
}

func TestRestorePreviousWithoutBackup(t *testing.T) {
	host := &fakeHost{}
	seedInstance(host)

	_, err := newService(host).RestorePrevious(context.Background(), containerTarget())
	assertCode(t, err, "INVALID_REQUEST")
	if commandIndex(host.commands, "up -d") >= 0 {
		t.Errorf("started the container without a backup")
	}
}
