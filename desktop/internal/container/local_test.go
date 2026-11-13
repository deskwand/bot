package container

import (
	"bytes"
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

// recordingHost records every file write, so a test can prove nothing was
// written.
type recordingHost struct {
	*fakeHost
	writes []string
}

func (h *recordingHost) WriteFileAtomic(ctx context.Context, path string, data []byte, mode os.FileMode) error {
	h.writes = append(h.writes, path)
	return h.fakeHost.WriteFileAtomic(ctx, path, data, mode)
}

// localService dials host for every target and remembers the target it saw.
func localService(host Host, seen *[]domain.Target) *Service {
	return New(Options{
		Dial: func(target domain.Target) (Host, error) {
			if seen != nil {
				*seen = append(*seen, target)
			}
			return host, nil
		},
		Version: "1.2.3",
		Sleep: func(context.Context, time.Duration) error {
			return nil
		},
	})
}

func TestDetectLocalReportsBoth(t *testing.T) {
	host := &fakeHost{respond: func(string) (hostexec.Result, error) {
		return hostexec.Result{}, nil
	}}
	var seen []domain.Target

	runtimes, err := localService(host, &seen).DetectLocal(context.Background())
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if !runtimes.Apple || !runtimes.Compose {
		t.Fatalf("DetectLocal = %+v, want both runtimes", runtimes)
	}
	if len(seen) != 1 || seen[0].Kind != domain.TargetContainer || !seen[0].Host.IsLocal() {
		t.Fatalf("dial target = %+v, want one local container target", seen)
	}
	if want := []string{"command -v container", "command -v docker"}; !reflect.DeepEqual(host.commands, want) {
		t.Fatalf("commands = %q, want %q", host.commands, want)
	}
}

func TestAdoptLocalHealthyWritesNothing(t *testing.T) {
	target := appleTarget()
	host := &fakeHost{
		files: map[string][]byte{
			runScriptPath(target.Host.Dir): appleRunScript(appleTestAbsDir, appleTestContainerBin, appleTestImage),
			envPath(target.Host.Dir):       []byte("MODEL_KEY_OPENAI='sk-test'\n"),
		},
		respond: func(command string) (hostexec.Result, error) {
			switch {
			case strings.HasPrefix(command, "container inspect "):
				return hostexec.Result{Stdout: appleTestdata(t, "apple-inspect.json")}, nil
			case strings.HasPrefix(command, "curl "):
				return hostexec.Result{}, nil
			}
			return passingApple(command)
		},
	}
	recorder := &recordingHost{fakeHost: host}

	var steps []string
	result, err := localService(recorder, nil).AdoptLocal(context.Background(), target,
		func(step domain.Step) { steps = append(steps, step.ID) })
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if result.State != "published" {
		t.Errorf("State = %q, want published", result.State)
	}
	if len(recorder.writes) != 0 {
		t.Errorf("wrote %q, want no file written", recorder.writes)
	}
	if len(steps) != 0 {
		t.Errorf("steps = %q, want no step", steps)
	}
	for _, command := range host.commands {
		if strings.Contains(command, "launchctl") {
			t.Fatalf("commands = %q, want no launchctl on a healthy container", host.commands)
		}
	}
}

func TestAdoptLocalRestartsStoppedApple(t *testing.T) {
	target := appleTarget()
	env := []byte("MODEL_KEY_OPENAI='sk-test'\n")
	host := &fakeHost{
		files: map[string][]byte{
			runScriptPath(target.Host.Dir): appleRunScript(appleTestAbsDir, appleTestContainerBin, appleImageRef("1.0.0")),
			envPath(target.Host.Dir):       env,
		},
	}
	inspects := 0
	host.respond = func(command string) (hostexec.Result, error) {
		switch {
		case strings.HasPrefix(command, "container inspect "):
			inspects++
			if inspects == 1 {
				return hostexec.Result{Stderr: []byte("not found\n"), ExitCode: 1}, nil
			}
			return hostexec.Result{Stdout: appleTestdata(t, "apple-inspect.json")}, nil
		case strings.HasPrefix(command, "curl "):
			return hostexec.Result{}, nil
		}
		return passingApple(command)
	}

	var steps []domain.Step
	result, err := localService(host, nil).AdoptLocal(context.Background(), target,
		func(step domain.Step) { steps = append(steps, step) })
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if result.State != "published" {
		t.Errorf("State = %q, want published", result.State)
	}
	// The takeover rewrites the manifest, registers the agent and waits for
	// health, in that order.
	var states []string
	for _, step := range steps {
		states = append(states, step.ID+":"+step.State)
	}
	wantStates := []string{
		"write-agent:applying", "write-agent:completed",
		"register:applying", "register:completed",
		"healthy:applying", "healthy:completed",
	}
	if !reflect.DeepEqual(states, wantStates) {
		t.Errorf("steps = %v, want %v", states, wantStates)
	}

	if want := "1.0.0"; appleReadVersion(host.files[runScriptPath(target.Host.Dir)]) != want {
		t.Errorf("run.sh image = %q, want the version read from the old run.sh (%s)",
			appleReadVersion(host.files[runScriptPath(target.Host.Dir)]), want)
	}
	if _, ok := host.files[agentPlistPath]; !ok {
		t.Errorf("the launch agent plist was not written")
	}
	found := false
	for _, command := range host.commands {
		if strings.Contains(command, "launchctl") {
			found = true
		}
	}
	if !found {
		t.Fatalf("commands = %q, want a launchctl command", host.commands)
	}
	if !bytes.Equal(host.files[envPath(target.Host.Dir)], env) {
		t.Errorf(".env = %q, want the bytes unchanged (%q)", host.files[envPath(target.Host.Dir)], env)
	}
}

func TestRemoveRejectsSSHTarget(t *testing.T) {
	host := &fakeHost{}
	err := newService(host).Remove(context.Background(), containerTarget())
	assertCode(t, err, domain.TARGET_UNSUPPORTED)
	if len(host.commands) != 0 {
		t.Errorf("commands = %q, want none", host.commands)
	}
}

func TestRemoveLocalCallsEngine(t *testing.T) {
	host := &fakeHost{respond: func(string) (hostexec.Result, error) {
		return hostexec.Result{}, nil
	}}
	if err := newService(host).Remove(context.Background(), localComposeTarget()); err != nil {
		t.Fatalf("remove: %v", err)
	}
	joined := strings.Join(host.commands, "\n")
	if !strings.Contains(joined, "docker compose down") {
		t.Fatalf("commands = %q, want a docker compose down", host.commands)
	}
}

func TestAdoptLocalRefusesMissingVersion(t *testing.T) {
	target := localComposeTarget()
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker inspect") {
			// Nothing runs here, so the takeover has to rewrite a manifest.
			return hostexec.Result{ExitCode: 1}, nil
		}
		return passingLocalCompose(command)
	}}
	recorder := &recordingHost{fakeHost: host}

	_, err := localService(recorder, nil).AdoptLocal(context.Background(), target, nil)
	assertCode(t, err, domain.ENV_FILE_INVALID)
	if len(recorder.writes) != 0 {
		t.Errorf("wrote %q, want nothing written", recorder.writes)
	}
}
