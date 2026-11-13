package container

import (
	"context"
	"errors"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

func TestComposeFileMatchesRepositoryCompose(t *testing.T) {
	repository, err := os.ReadFile("../../../compose.yaml")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.ReplaceAll(string(repository), "ghcr.io/deskwand/bot:latest", "ghcr.io/deskwand/bot:1.2.3")
	if got := string(ComposeFile("1.2.3")); got != want {
		t.Fatalf("ComposeFile(1.2.3) differs from the repository compose.yaml:\n%s", got)
	}
}

func passingPreflight(command string) (hostexec.Result, error) {
	switch {
	case strings.HasPrefix(command, "docker version"):
		return hostexec.Result{Stdout: []byte("27.0.1\n")}, nil
	case strings.HasPrefix(command, "docker compose version"):
		return hostexec.Result{Stdout: []byte("2.29.0\n")}, nil
	case strings.HasPrefix(command, "uname -m"):
		return hostexec.Result{Stdout: []byte("x86_64\n")}, nil
	case strings.HasPrefix(command, "mkdir -p"):
		return hostexec.Result{}, nil
	case strings.HasPrefix(command, "ss "):
		return hostexec.Result{}, nil
	}
	return hostexec.Result{ExitCode: 1}, nil
}

func preflightIDs(report PreflightReport) []string {
	ids := make([]string, 0, len(report.Checks))
	for _, check := range report.Checks {
		ids = append(ids, check.ID)
	}
	return ids
}

func checkByID(t *testing.T, report PreflightReport, id string) Check {
	t.Helper()
	for _, check := range report.Checks {
		if check.ID == id {
			return check
		}
	}
	t.Fatalf("no check with id %q", id)
	return Check{}
}

func TestPreflightAllPass(t *testing.T) {
	host := &fakeHost{respond: passingPreflight}
	report, err := newService(host).Preflight(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"docker", "compose", "permission", "arch", "port", "dir"}
	if got := preflightIDs(report); !reflect.DeepEqual(got, want) {
		t.Fatalf("check order = %v, want %v", got, want)
	}
	for _, check := range report.Checks {
		if !check.OK {
			t.Errorf("check %s = %+v, want OK", check.ID, check)
		}
	}
	if report.Existing {
		t.Errorf("Existing = true, want false")
	}
	if !report.Passed() {
		t.Errorf("Passed() = false, want true")
	}
}

func TestPreflightDockerMissing(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "docker version") {
			return hostexec.Result{Stderr: []byte("sh: docker: not found\n"), ExitCode: 127}, nil
		}
		return passingPreflight(command)
	}}
	report, err := newService(host).Preflight(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	docker := checkByID(t, report, "docker")
	if docker.OK {
		t.Errorf("docker check = %+v, want failure", docker)
	}
	if !strings.Contains(docker.Fix, "get.docker.com") {
		t.Errorf("docker Fix = %q, want the install script", docker.Fix)
	}
	if compose := checkByID(t, report, "compose"); compose.OK {
		t.Errorf("compose check = %+v, want failure", compose)
	}
	for _, command := range host.commands {
		if strings.HasPrefix(command, "docker compose version") {
			t.Fatalf("ran the compose check without Docker")
		}
	}
}

func TestPreflightPermissionDenied(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "docker version") {
			return hostexec.Result{
				Stderr:   []byte("permission denied while trying to connect to the Docker daemon socket\n"),
				ExitCode: 1,
			}, nil
		}
		return passingPreflight(command)
	}}
	report, err := newService(host).Preflight(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	if docker := checkByID(t, report, "docker"); !docker.OK {
		t.Errorf("docker check = %+v, want OK", docker)
	}
	permission := checkByID(t, report, "permission")
	if permission.OK {
		t.Errorf("permission check = %+v, want failure", permission)
	}
	if !strings.Contains(permission.Fix, "usermod -aG docker") {
		t.Errorf("permission Fix = %q, want the usermod command", permission.Fix)
	}
	if compose := checkByID(t, report, "compose"); compose.OK {
		t.Errorf("compose check = %+v, want failure", compose)
	}
}

func TestPreflightUnsupportedArch(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "uname -m") {
			return hostexec.Result{Stdout: []byte("armv7l\n")}, nil
		}
		return passingPreflight(command)
	}}
	report, err := newService(host).Preflight(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	if arch := checkByID(t, report, "arch"); arch.OK {
		t.Errorf("arch check = %+v, want failure", arch)
	}
}

func TestPreflightPortBusy(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "ss ") {
			return hostexec.Result{Stdout: []byte("LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:*\n")}, nil
		}
		return passingPreflight(command)
	}}
	report, err := newService(host).Preflight(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	if port := checkByID(t, report, "port"); port.OK {
		t.Errorf("port check = %+v, want failure", port)
	}
}

func TestPreflightExistingInstance(t *testing.T) {
	host := &fakeHost{
		files: map[string][]byte{
			"~/deskwand/compose.yaml": []byte("services:\n  bot:\n    image: ghcr.io/deskwand/bot:1.0.0\n"),
			"~/deskwand/.env":         []byte("ADMIN_TOKEN=t\n"),
		},
		respond: func(command string) (hostexec.Result, error) {
			if strings.HasPrefix(command, "ss ") {
				return hostexec.Result{Stdout: []byte("LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:*\n")}, nil
			}
			return passingPreflight(command)
		},
	}
	report, err := newService(host).Preflight(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	if !report.Existing {
		t.Fatalf("Existing = false, want true")
	}
	if dir := checkByID(t, report, "dir"); !dir.OK {
		t.Errorf("dir check = %+v, want OK", dir)
	}
	if port := checkByID(t, report, "port"); !port.OK {
		t.Errorf("port check = %+v, want OK for an existing instance", port)
	}
	for _, command := range host.commands {
		if strings.HasPrefix(command, "ss ") {
			t.Fatalf("ran the port check for an existing instance")
		}
	}
}

func TestPreflightForeignCompose(t *testing.T) {
	cases := map[string]map[string][]byte{
		"foreign compose": {
			"~/deskwand/compose.yaml": []byte("services:\n  web:\n    image: nginx\n"),
		},
		"missing env": {
			"~/deskwand/compose.yaml": []byte("services:\n  bot:\n    image: ghcr.io/deskwand/bot:1.0.0\n"),
		},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			report, err := newService(&fakeHost{files: files, respond: passingPreflight}).
				Preflight(context.Background(), containerTarget())
			if err != nil {
				t.Fatal(err)
			}
			if dir := checkByID(t, report, "dir"); dir.OK {
				t.Errorf("dir check = %+v, want failure", dir)
			}
			if report.Existing {
				t.Errorf("Existing = true, want false")
			}
		})
	}
}

func installRespond(inspect func() hostexec.Result) func(string) (hostexec.Result, error) {
	return func(command string) (hostexec.Result, error) {
		switch {
		case strings.Contains(command, "docker inspect"):
			return inspect(), nil
		case strings.Contains(command, "docker compose pull"):
			return hostexec.Result{}, nil
		case strings.Contains(command, "docker compose up -d"):
			return hostexec.Result{}, nil
		case strings.HasPrefix(command, "test -e"):
			return hostexec.Result{ExitCode: 1}, nil
		}
		return passingPreflight(command)
	}
}

func installRequest() InstallRequest {
	return InstallRequest{
		ConfigJSON:    []byte(`{"schemaVersion":1,"owner":{"telegramUserIds":[1]}}`),
		ActiveChannel: "telegram",
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "s3cr3t-value"),
			domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, "tok-123"),
		},
	}
}

func TestInstallWritesFilesThenStarts(t *testing.T) {
	inspections := 0
	host := &fakeHost{respond: installRespond(func() hostexec.Result {
		inspections++
		if inspections == 1 {
			return hostexec.Result{Stdout: []byte("running|starting|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.3\n")}
		}
		return hostexec.Result{Stdout: []byte("running|healthy|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.3\n")}
	})}
	service := newService(host)

	var ids []string
	result, err := service.Install(context.Background(), containerTarget(), installRequest(), func(step domain.Step) {
		ids = append(ids, step.ID)
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "published" {
		t.Errorf("State = %q, want published", result.State)
	}
	wantIDs := []string{"write-compose", "write-env", "pull", "up", "healthy"}
	if got := uniqueInOrder(ids); !reflect.DeepEqual(got, wantIDs) {
		t.Errorf("step order = %v, want %v", got, wantIDs)
	}

	compose := host.files["~/deskwand/compose.yaml"]
	if string(compose) != string(ComposeFile("1.2.3")) {
		t.Errorf("compose.yaml does not match ComposeFile(1.2.3)")
	}
	env, err := envfile.Parse(host.files["~/deskwand/.env"])
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"MODEL_KEY_X":        "s3cr3t-value",
		"TELEGRAM_BOT_TOKEN": "tok-123",
		"ACTIVE_CHANNEL":     "telegram",
		"DESKWAND_CONFIG":    `{"schemaVersion":1,"owner":{"telegramUserIds":[1]}}`,
	} {
		if got, _ := env.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	adminToken, ok := env.Get("ADMIN_TOKEN")
	if !ok || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(adminToken) {
		t.Errorf("ADMIN_TOKEN = %q, want 64 hex characters", adminToken)
	}

	joined := strings.Join(host.commands, "\n")
	for _, secret := range []string{"s3cr3t-value", "tok-123", adminToken} {
		if strings.Contains(joined, secret) {
			t.Fatalf("a secret value reached a remote command")
		}
	}
	pullIndex, upIndex := -1, -1
	for i, command := range host.commands {
		if strings.Contains(command, "docker compose pull") {
			pullIndex = i
		}
		if strings.Contains(command, "docker compose up -d") {
			upIndex = i
		}
	}
	if pullIndex < 0 || upIndex < 0 || pullIndex > upIndex {
		t.Errorf("pull index = %d, up index = %d; want pull before up", pullIndex, upIndex)
	}
}

func uniqueInOrder(values []string) []string {
	seen := make(map[string]bool)
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func TestInstallValidatesBeforeWriting(t *testing.T) {
	cases := map[string]struct {
		request InstallRequest
		code    string
	}{
		"missing model key": {
			request: InstallRequest{
				ConfigJSON:    []byte(`{"schemaVersion":1}`),
				ActiveChannel: "telegram",
				Secrets:       []domain.SecretEdit{domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, "tok")},
			},
			code: domain.MODEL_KEY_MISSING,
		},
		"disallowed name": {
			request: InstallRequest{
				ConfigJSON:    []byte(`{"schemaVersion":1}`),
				ActiveChannel: "telegram",
				Secrets: []domain.SecretEdit{
					domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "value"),
					domain.NewSecretEdit("PATH", domain.SecretReplace, "value"),
				},
			},
			code: "INVALID_REQUEST",
		},
		"unrepresentable value": {
			request: InstallRequest{
				ConfigJSON:    []byte(`{"schemaVersion":1}`),
				ActiveChannel: "telegram",
				Secrets:       []domain.SecretEdit{domain.NewSecretEdit("MODEL_KEY_X", domain.SecretReplace, "it's")},
			},
			code: domain.ENV_FILE_INVALID,
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			host := &fakeHost{respond: installRespond(func() hostexec.Result {
				return hostexec.Result{ExitCode: 1}
			})}
			_, err := newService(host).Install(context.Background(), containerTarget(), c.request, nil)
			assertCode(t, err, c.code)
			if _, ok := host.files["~/deskwand/.env"]; ok {
				t.Fatalf("wrote .env before validating the request")
			}
			if _, ok := host.files["~/deskwand/compose.yaml"]; ok {
				t.Fatalf("wrote compose.yaml before validating the request")
			}
		})
	}
}

func TestInstallRefusesExistingInstance(t *testing.T) {
	files := map[string][]byte{
		"~/deskwand/compose.yaml": []byte("services:\n  bot:\n    image: ghcr.io/deskwand/bot:1.0.0\n"),
		"~/deskwand/.env":         []byte("ADMIN_TOKEN=t\n"),
	}
	host := &fakeHost{files: files, respond: passingPreflight}
	_, err := newService(host).Install(context.Background(), containerTarget(), installRequest(), nil)
	assertCode(t, err, "INVALID_REQUEST")
	for path, want := range files {
		if got := host.files[path]; string(got) != string(want) {
			t.Errorf("%s changed during a refused install", path)
		}
	}
}

func TestInstallPullFailure(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker compose pull") {
			return hostexec.Result{Stderr: []byte("manifest unknown\n"), ExitCode: 1}, nil
		}
		return installRespond(func() hostexec.Result {
			return hostexec.Result{ExitCode: 1}
		})(command)
	}}
	_, err := newService(host).Install(context.Background(), containerTarget(), installRequest(), nil)
	assertCode(t, err, domain.DOCKER_UNAVAILABLE)
	var coded domain.Error
	if errors.As(err, &coded) && !strings.Contains(coded.Message, "manifest unknown") {
		t.Errorf("Message = %q, want the pull stderr", coded.Message)
	}
	for _, command := range host.commands {
		if strings.Contains(command, "docker compose up -d") {
			t.Fatalf("started the container after a failed pull")
		}
	}
}

func TestInstallUnhealthyReturnsRedactedLogs(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		switch {
		case strings.Contains(command, "docker compose logs"):
			return hostexec.Result{Stdout: []byte("boot failed key=s3cr3t-value\n")}, nil
		case strings.Contains(command, "docker inspect"):
			return hostexec.Result{Stdout: []byte("running|starting|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.3\n")}, nil
		case strings.Contains(command, "docker compose pull"), strings.Contains(command, "docker compose up -d"):
			return hostexec.Result{}, nil
		}
		return passingPreflight(command)
	}}
	_, err := newService(host).Install(context.Background(), containerTarget(), installRequest(), nil)
	assertCode(t, err, domain.CONTAINER_UNHEALTHY)
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v, want domain.Error", err)
	}
	if !strings.Contains(coded.Message, "boot failed") {
		t.Errorf("Message = %q, want the container logs", coded.Message)
	}
	if strings.Contains(coded.Message, "s3cr3t-value") {
		t.Errorf("Message leaked a secret value: %q", coded.Message)
	}
}
