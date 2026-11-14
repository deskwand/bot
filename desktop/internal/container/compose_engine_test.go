package container

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/hostexec"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

func localComposeTarget() domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{
			Transport: domain.TransportLocal,
			Dir:       domain.DefaultLocalDir,
		},
	}
}

func localPath(name string) string {
	return domain.DefaultLocalDir + "/" + name
}

// passingLocalCompose answers every command a healthy local run sends.
func passingLocalCompose(command string) (hostexec.Result, error) {
	switch {
	case strings.HasPrefix(command, "docker version"):
		return hostexec.Result{Stdout: []byte("27.0.1\n")}, nil
	case strings.HasPrefix(command, "docker compose version"):
		return hostexec.Result{Stdout: []byte("2.29.0\n")}, nil
	case strings.HasPrefix(command, "uname -m"):
		return hostexec.Result{Stdout: []byte("arm64\n")}, nil
	case strings.HasPrefix(command, "mkdir -p"):
		return hostexec.Result{}, nil
	case strings.HasPrefix(command, "lsof "):
		return hostexec.Result{}, nil
	case strings.Contains(command, "docker inspect"):
		return hostexec.Result{Stdout: []byte("running|healthy|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.3\n")}, nil
	case strings.HasPrefix(command, "test -e"):
		return hostexec.Result{ExitCode: 1}, nil
	}
	return hostexec.Result{ExitCode: 1}, nil
}

func TestLocalComposePreflightHasNoLinuxFixes(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "docker version") {
			return hostexec.Result{Stderr: []byte("sh: docker: command not found\n"), ExitCode: 127}, nil
		}
		return passingLocalCompose(command)
	}}
	report, err := newService(host).Preflight(context.Background(), localComposeTarget())
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"docker", "compose", "arch", "port", "dir"}
	if got := preflightIDs(report); !reflect.DeepEqual(got, want) {
		t.Fatalf("check order = %v, want %v", got, want)
	}

	for _, check := range report.Checks {
		for _, command := range []string{"sudo", "systemctl", "apt-get", "usermod", "get.docker.com"} {
			if strings.Contains(check.Fix, command) {
				t.Errorf("check %s Fix = %q, want no Linux repair command", check.ID, check.Fix)
			}
			if strings.Contains(check.Detail, command) {
				t.Errorf("check %s Detail = %q, want no Linux repair command", check.ID, check.Detail)
			}
		}
	}

	docker := checkByID(t, report, "docker")
	if docker.OK {
		t.Errorf("docker check = %+v, want failure", docker)
	}
	if docker.Fix != "" {
		t.Errorf("docker Fix = %q, want empty", docker.Fix)
	}
	if want := i18n.T(i18n.ZH, "container.check.docker.localMissing"); docker.Detail != want {
		t.Errorf("docker Detail = %q, want %q", docker.Detail, want)
	}
}

func TestLocalComposePreflightAcceptsArm64(t *testing.T) {
	host := &fakeHost{respond: passingLocalCompose}
	report, err := newService(host).Preflight(context.Background(), localComposeTarget())
	if err != nil {
		t.Fatal(err)
	}
	if arch := checkByID(t, report, "arch"); !arch.OK {
		t.Errorf("arch check = %+v, want OK for arm64", arch)
	}
	if !report.Passed() {
		t.Errorf("Passed() = false, want true")
	}

	ran := false
	for _, command := range host.commands {
		if strings.HasPrefix(command, "uname -m") {
			ran = true
		}
	}
	if !ran {
		t.Errorf("the architecture check did not run")
	}
}

func TestLocalComposePortUsesLsof(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "lsof ") {
			return hostexec.Result{Stdout: []byte("48231\n")}, nil
		}
		return passingLocalCompose(command)
	}}
	report, err := newService(host).Preflight(context.Background(), localComposeTarget())
	if err != nil {
		t.Fatal(err)
	}
	if port := checkByID(t, report, "port"); port.OK {
		t.Errorf("port check = %+v, want failure", port)
	}

	usedLsof := false
	for _, command := range host.commands {
		if strings.Contains(command, "ss -ltnH") {
			t.Fatalf("ran the Linux port command on this Mac: %s", command)
		}
		if strings.Contains(command, "lsof -nP -iTCP:8787") {
			usedLsof = true
		}
	}
	if !usedLsof {
		t.Errorf("the port check did not use lsof")
	}
}

func TestLocalComposeRefusesAppleDir(t *testing.T) {
	host := &fakeHost{
		files: map[string][]byte{
			localPath("run.sh"): appleRunScript(domain.DefaultLocalDir, appleTestContainerBin, appleTestImage),
		},
		respond: passingLocalCompose,
	}
	report, err := newService(host).Preflight(context.Background(), localComposeTarget())
	if err != nil {
		t.Fatal(err)
	}
	dir := checkByID(t, report, "dir")
	if dir.OK {
		t.Errorf("dir check = %+v, want failure", dir)
	}
	if want := i18n.T(i18n.ZH, "container.check.dir.otherEngine"); dir.Detail != want {
		t.Errorf("dir Detail = %q, want %q", dir.Detail, want)
	}
	if report.Existing {
		t.Errorf("Existing = true, want false")
	}
}

func TestLocalComposeIgnoresForeignRunScript(t *testing.T) {
	host := &fakeHost{
		files: map[string][]byte{
			localPath("run.sh"): []byte("#!/bin/sh\nexec other-tool run\n"),
		},
		respond: passingLocalCompose,
	}
	report, err := newService(host).Preflight(context.Background(), localComposeTarget())
	if err != nil {
		t.Fatal(err)
	}
	dir := checkByID(t, report, "dir")
	if dir.OK {
		t.Errorf("dir check = %+v, want failure", dir)
	}
	if want := i18n.T(i18n.ZH, "container.check.dir.local.fail"); dir.Detail != want {
		t.Errorf("dir Detail = %q, want %q", dir.Detail, want)
	}
}

func TestLocalComposeRemoveFailureCode(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker compose down") {
			return hostexec.Result{Stderr: []byte("Cannot connect to the Docker daemon\n"), ExitCode: 1}, nil
		}
		return passingLocalCompose(command)
	}}
	err := newService(host).Remove(context.Background(), localComposeTarget())
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v, want a coded error", err)
	}
	if coded.Code != domain.LOCAL_RUNTIME_STOPPED {
		t.Fatalf("error code = %q, want %q and never %q", coded.Code, domain.LOCAL_RUNTIME_STOPPED, domain.DOCKER_UNAVAILABLE)
	}
	if !strings.Contains(coded.Message, "Cannot connect to the Docker daemon") {
		t.Errorf("Message = %q, want the command output", coded.Message)
	}
}

func TestLocalComposePullFailureCode(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker compose pull") {
			return hostexec.Result{Stderr: []byte("manifest unknown\n"), ExitCode: 1}, nil
		}
		return passingLocalCompose(command)
	}}
	target := localComposeTarget()
	err := newService(host).engine(target).Pull(context.Background(), host, target.Host.Dir)
	assertCode(t, err, domain.LOCAL_PULL_FAILED)
	if !strings.Contains(err.Error(), "manifest unknown") {
		t.Errorf("error = %v, want the command output", err)
	}
}

func TestLocalComposePreflightChecksComposePlugin(t *testing.T) {
	t.Run("plugin available", func(t *testing.T) {
		host := &fakeHost{respond: passingLocalCompose}
		report, err := newService(host).Preflight(context.Background(), localComposeTarget())
		if err != nil {
			t.Fatal(err)
		}
		compose := checkByID(t, report, "compose")
		if !compose.OK {
			t.Errorf("compose check = %+v, want OK", compose)
		}
		if compose.Fix != "" {
			t.Errorf("compose Fix = %q, want empty", compose.Fix)
		}
		ran := false
		for _, command := range host.commands {
			if strings.HasPrefix(command, "docker compose version --short") {
				ran = true
			}
		}
		if !ran {
			t.Errorf("the compose check did not run")
		}
	})

	t.Run("plugin missing", func(t *testing.T) {
		host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
			if strings.HasPrefix(command, "docker compose version") {
				return hostexec.Result{Stderr: []byte("docker: 'compose' is not a docker command\n"), ExitCode: 1}, nil
			}
			return passingLocalCompose(command)
		}}
		report, err := newService(host).Preflight(context.Background(), localComposeTarget())
		if err != nil {
			t.Fatal(err)
		}
		compose := checkByID(t, report, "compose")
		if compose.OK {
			t.Errorf("compose check = %+v, want failure", compose)
		}
		if compose.Fix != "" {
			t.Errorf("compose Fix = %q, want empty on this Mac", compose.Fix)
		}
		if report.Passed() {
			t.Errorf("Passed() = true, want false")
		}
	})
}

func TestLocalComposeStatusRuntimeStopped(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "docker version") {
			return hostexec.Result{Stderr: []byte("Cannot connect to the Docker daemon\n"), ExitCode: 1}, nil
		}
		return passingLocalCompose(command)
	}}
	status, err := newService(host).Status(context.Background(), localComposeTarget())
	if err != nil {
		t.Fatalf("Status error = %v, want none", err)
	}
	if status.Reachable {
		t.Errorf("status = %+v, want Reachable false", status)
	}
	if status.Running {
		t.Errorf("status = %+v, want Running false", status)
	}
	for _, command := range host.commands {
		if strings.Contains(command, "docker inspect") {
			t.Fatalf("inspected the container while the runtime was stopped")
		}
	}
}

func TestLocalInstallPreflightFailureIsInvalidRequest(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "lsof ") {
			return hostexec.Result{Stdout: []byte("48231\n")}, nil
		}
		return passingLocalCompose(command)
	}}
	_, err := newService(host).Install(context.Background(), localComposeTarget(), installRequest(), nil)
	assertCode(t, err, "INVALID_REQUEST")
	var coded domain.Error
	if !errors.As(err, &coded) || !strings.HasPrefix(coded.Message, "port: ") {
		t.Errorf("error = %v, want a message that starts with the check ID", err)
	}
	if len(host.files) != 0 {
		t.Errorf("wrote %d files during a refused install", len(host.files))
	}
}

// The engines are never built directly in tests: every container flow reaches
// them through Service and the fake Host that Options.Dial returns.
func TestStopTargetRunsComposeStop(t *testing.T) {
	host := &fakeHost{}
	service := newService(host)
	target := containerTarget()

	if err := service.StopTarget(context.Background(), target); err != nil {
		t.Fatalf("StopTarget: %v", err)
	}
	if err := service.StartTarget(context.Background(), target); err != nil {
		t.Fatalf("StartTarget: %v", err)
	}
	if len(host.commands) != 2 {
		t.Fatalf("commands = %v, want two", host.commands)
	}
	if !strings.Contains(host.commands[0], "docker compose stop") {
		t.Fatalf("stop command = %q", host.commands[0])
	}
	if !strings.Contains(host.commands[1], "docker compose start") {
		t.Fatalf("start command = %q", host.commands[1])
	}
}
