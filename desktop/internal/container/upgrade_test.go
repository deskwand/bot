package container

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

func composeWithTag(tag string) []byte {
	return []byte("services:\n  bot:\n    image: ghcr.io/deskwand/bot:" + tag + "\n")
}

func TestUpgradeAvailableComparesTheManifestWithTheClient(t *testing.T) {
	cases := []struct{ tag, want string }{
		{"1.2.2", VersionUpgradable},
		{"1.2.3", VersionCurrent},
		{"1.2.4", VersionClientBehind},
		{"1.10.0", VersionClientBehind},
		{"latest", VersionUnknown},
		{"bad:tag", VersionUnknown},
		{"", VersionUnknown},
	}
	for _, tc := range cases {
		host := &fakeHost{files: map[string][]byte{
			"~/deskwand/compose.yaml": composeWithTag(tc.tag),
		}}
		state, err := newService(host).UpgradeAvailable(context.Background(), containerTarget())
		if err != nil {
			t.Fatalf("tag %q: %v", tc.tag, err)
		}
		if state.State != tc.want {
			t.Errorf("tag %q: state = %q, want %q", tc.tag, state.State, tc.want)
		}
		if state.Current != tc.tag || state.Target != "1.2.3" {
			t.Errorf("tag %q: state = %#v", tc.tag, state)
		}
	}
}

func TestUpgradeAvailableRejectsAnUnknownTarget(t *testing.T) {
	_, err := newService(&fakeHost{}).UpgradeAvailable(context.Background(), domain.Target{})
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.TARGET_UNSUPPORTED {
		t.Fatalf("error = %v, want %s", err, domain.TARGET_UNSUPPORTED)
	}
}

func TestUpgradeAvailableTreatsAMissingAppleScriptAsUnknown(t *testing.T) {
	// The Apple engine reports a missing run.sh as ENV_FILE_INVALID; the page
	// should show "version unknown" rather than an error banner for an install
	// it cannot identify.
	state, err := newService(&fakeHost{}).UpgradeAvailable(context.Background(), appleTarget())
	if err != nil {
		t.Fatalf("error = %v, want no error", err)
	}
	if state.State != VersionUnknown || state.Current != "" {
		t.Fatalf("state = %#v, want unknown with no current version", state)
	}
}

// upgradeRespond answers an upgrade like a healthy compose host. The health it
// reports depends on which tag the manifest currently names, so a rollback is
// observable.
func upgradeRespond(host *fakeHost, unhealthyTags ...string) func(string) (hostexec.Result, error) {
	return func(command string) (hostexec.Result, error) {
		switch {
		case strings.Contains(command, "docker compose pull"):
			return hostexec.Result{}, nil
		case strings.Contains(command, "docker compose up -d"):
			return hostexec.Result{}, nil
		case strings.Contains(command, "docker inspect"):
			health := "healthy"
			manifest := string(host.files["~/deskwand/compose.yaml"])
			for _, tag := range unhealthyTags {
				if strings.Contains(manifest, ":"+tag) {
					health = "unhealthy"
				}
			}
			return hostexec.Result{Stdout: []byte("running|" + health + "|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.3\n")}, nil
		case strings.Contains(command, "docker compose logs"):
			return hostexec.Result{Stdout: []byte("boom: model key rejected\n")}, nil
		case strings.HasPrefix(command, "test -e"):
			return hostexec.Result{ExitCode: 1}, nil
		}
		return hostexec.Result{ExitCode: 1}, nil
	}
}

func seededCompose(host *fakeHost, tag string) {
	host.files = map[string][]byte{"~/deskwand/compose.yaml": ComposeFile(tag)}
}

func TestUpgradeRewritesTheManifestAndWaitsForHealth(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.files["~/deskwand/.env"] = []byte("ADMIN_TOKEN=t\nMODEL_KEY_X=sk-live\n")
	host.respond = upgradeRespond(host)
	var steps []domain.Step
	result, err := newService(host).Upgrade(context.Background(), containerTarget(), func(step domain.Step) {
		steps = append(steps, step)
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.VersionID != "container:1.2.3" {
		t.Errorf("versionId = %q", result.VersionID)
	}
	if got := string(host.files["~/deskwand/compose.yaml"]); !strings.Contains(got, "ghcr.io/deskwand/bot:1.2.3") {
		t.Errorf("manifest = %q, want the new tag", got)
	}
	for _, path := range host.reads {
		if strings.HasSuffix(path, "/.env") {
			t.Fatalf("upgrade read %q", path)
		}
	}
	if got := string(host.files["~/deskwand/.env"]); got != "ADMIN_TOKEN=t\nMODEL_KEY_X=sk-live\n" {
		t.Fatalf(".env = %q, want it untouched", got)
	}
	if commandIndex(host.commands, "docker compose pull") > commandIndex(host.commands, "docker compose up -d") {
		t.Error("the pull ran after the container was started")
	}
	if len(steps) == 0 || steps[len(steps)-1].ID != "healthy" || steps[len(steps)-1].State != "completed" {
		t.Errorf("steps = %+v, want a completed healthy step", steps)
	}
}

func TestUpgradeIsANoOpAtTheSameVersion(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.3")
	host.respond = upgradeRespond(host)
	if _, err := newService(host).Upgrade(context.Background(), containerTarget(), nil); err != nil {
		t.Fatal(err)
	}
	if len(host.commands) != 0 {
		t.Errorf("commands = %q, want none", host.commands)
	}
}

func TestUpgradeRestoresTheManifestWhenThePullFails(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.respond = func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker compose pull") {
			return hostexec.Result{Stderr: []byte("manifest unknown\n"), ExitCode: 1}, nil
		}
		return upgradeRespond(host)(command)
	}
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.DOCKER_UNAVAILABLE {
		t.Fatalf("error = %v, want %s", err, domain.DOCKER_UNAVAILABLE)
	}
	if strings.Contains(string(host.files["~/deskwand/compose.yaml"]), "1.2.3") {
		t.Fatal("manifest still names the new tag after a failed pull")
	}
	if commandIndex(host.commands, "docker compose up -d") >= 0 {
		t.Error("a failed pull restarted the container")
	}
}

func TestUpgradeRollsBackWhenTheNewVersionNeverBecomesHealthy(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.respond = upgradeRespond(host, "1.2.3")
	var steps []domain.Step
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), func(step domain.Step) {
		steps = append(steps, step)
	})
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.UPGRADE_ROLLED_BACK {
		t.Fatalf("error = %v, want %s", err, domain.UPGRADE_ROLLED_BACK)
	}
	if !strings.Contains(coded.Message, "boom") {
		t.Errorf("message = %q, want the new version's logs", coded.Message)
	}
	if got := string(host.files["~/deskwand/compose.yaml"]); !strings.Contains(got, "ghcr.io/deskwand/bot:1.2.2") {
		t.Errorf("manifest = %q, want the previous tag back", got)
	}
	applies := 0
	for _, command := range host.commands {
		if strings.Contains(command, "docker compose up -d") {
			applies++
		}
	}
	if applies != 2 {
		t.Errorf("up -d ran %d times, want the upgrade and the rollback", applies)
	}
	pulls := 0
	for _, command := range host.commands {
		if strings.Contains(command, "docker compose pull") {
			pulls++
		}
	}
	if pulls != 1 {
		t.Errorf("pull ran %d times, want only the upgrade's own pull", pulls)
	}
	last := steps[len(steps)-1]
	if last.ID != "rollback" || last.State != "completed" {
		t.Errorf("last step = %+v, want a completed rollback", last)
	}
}

func TestUpgradeReportsARollbackThatAlsoFails(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.respond = upgradeRespond(host, "1.2.2", "1.2.3")
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.UPGRADE_ROLLBACK_FAILED {
		t.Fatalf("error = %v, want %s", err, domain.UPGRADE_ROLLBACK_FAILED)
	}
	if !strings.Contains(coded.Message, "boom") {
		t.Errorf("message = %q, want the container logs", coded.Message)
	}
}

func TestUpgradeRejectsAnUnknownOrNewerVersion(t *testing.T) {
	for _, tc := range []struct{ tag, want string }{
		{"bad:tag", domain.CONTAINER_VERSION_UNKNOWN},
		{"2.0.0", domain.CONTAINER_CLIENT_BEHIND},
	} {
		host := &fakeHost{}
		seededCompose(host, tc.tag)
		host.respond = upgradeRespond(host)
		_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
		var coded domain.Error
		if !errors.As(err, &coded) || coded.Code != tc.want {
			t.Fatalf("tag %q: error = %v, want %s", tc.tag, err, tc.want)
		}
		if len(host.commands) != 0 {
			t.Errorf("tag %q: commands = %q, want none", tc.tag, host.commands)
		}
	}
}

func TestUpgradeRewritesTheAppleRunScript(t *testing.T) {
	target := appleTarget()
	host := &fakeHost{
		files: map[string][]byte{
			runScriptPath(target.Host.Dir): appleRunScript(appleTestAbsDir, appleTestContainerBin, "ghcr.io/deskwand/bot:1.2.2"),
		},
	}
	host.respond = func(command string) (hostexec.Result, error) {
		switch {
		case strings.HasPrefix(command, "printf "):
			return hostexec.Result{Stdout: []byte(appleTestHome + "\n" + appleTestContainerBin + "\n")}, nil
		case strings.HasPrefix(command, "container system status"):
			return hostexec.Result{Stdout: []byte("status: running\n")}, nil
		case strings.HasPrefix(command, "container inspect "):
			return hostexec.Result{Stdout: appleTestdata(t, "apple-inspect.json")}, nil
		case strings.HasPrefix(command, "container image inspect"):
			return hostexec.Result{}, nil
		case strings.HasPrefix(command, "test -e"):
			return hostexec.Result{ExitCode: 1}, nil
		case strings.HasPrefix(command, "curl "):
			return hostexec.Result{}, nil
		case strings.HasPrefix(command, "mkdir -p"):
			return hostexec.Result{}, nil
		case strings.Contains(command, "launchctl"):
			return hostexec.Result{}, nil
		}
		return hostexec.Result{ExitCode: 1}, nil
	}
	if _, err := newService(host).Upgrade(context.Background(), target, nil); err != nil {
		t.Fatal(err)
	}
	script := string(host.files[runScriptPath(target.Host.Dir)])
	if !strings.Contains(script, "ghcr.io/deskwand/bot:1.2.3") {
		t.Errorf("run script = %q, want the new tag", script)
	}
}

func TestStopWaitsForAnUpgradeInFlight(t *testing.T) {
	pulling := make(chan struct{})
	release := make(chan struct{})
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.respond = func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker compose pull") {
			close(pulling)
			<-release
		}
		return upgradeRespond(host)(command)
	}
	service := newService(host)
	go func() { _, _ = service.Upgrade(context.Background(), containerTarget(), nil) }()
	select {
	case <-pulling:
	case <-time.After(2 * time.Second):
		t.Fatal("the upgrade never reached the pull step")
	}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		_ = service.StopTarget(context.Background(), containerTarget())
	}()
	select {
	case <-stopped:
		t.Fatal("StopTarget ran while an upgrade held the lock")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	<-stopped
}

func TestUpgradeRefusesToOverwriteAHandEditedManifest(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		"~/deskwand/compose.yaml": append(ComposeFile("1.2.2"), []byte("    # hand-edited bind mount\n")...),
	}}
	host.respond = upgradeRespond(host)
	before := string(host.files["~/deskwand/compose.yaml"])
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.CONTAINER_MANIFEST_MODIFIED {
		t.Fatalf("error = %v, want %s", err, domain.CONTAINER_MANIFEST_MODIFIED)
	}
	if len(host.commands) != 0 {
		t.Errorf("commands = %q, want none", host.commands)
	}
	if got := string(host.files["~/deskwand/compose.yaml"]); got != before {
		t.Error("the hand-edited manifest was rewritten")
	}
}

func TestUpgradeAvailableReportsAManifestTheContainerHasNotPickedUp(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		"~/deskwand/compose.yaml": ComposeFile("1.2.3"),
	}}
	host.respond = func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker inspect") {
			return hostexec.Result{Stdout: []byte("running|healthy|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.2\n")}, nil
		}
		return hostexec.Result{ExitCode: 1}, nil
	}
	state, err := newService(host).UpgradeAvailable(context.Background(), containerTarget())
	if err != nil {
		t.Fatal(err)
	}
	if state.State != VersionManifestPending {
		t.Fatalf("state = %#v, want %s", state, VersionManifestPending)
	}
	if state.Current != "1.2.3" {
		t.Fatalf("current = %q", state.Current)
	}
}

func TestUpgradeReportsWhenAFailedApplyLeavesTheManifestAhead(t *testing.T) {
	host := &fakeHost{writeErr: domain.Error{Code: domain.SSH_UNREACHABLE}, failWritesAfter: 1}
	seededCompose(host, "1.2.2")
	host.respond = func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker compose up -d") {
			return hostexec.Result{Stderr: []byte("no such image\n"), ExitCode: 1}, nil
		}
		return upgradeRespond(host)(command)
	}
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.DOCKER_UNAVAILABLE {
		t.Fatalf("error = %v, want %s", err, domain.DOCKER_UNAVAILABLE)
	}
	if !strings.Contains(coded.Message, "still names 1.2.3") {
		t.Errorf("message = %q, want the manifest-ahead note", coded.Message)
	}
}

func TestRollbackKeepsAnUnreachableHostCode(t *testing.T) {
	host := &fakeHost{writeErr: domain.Error{Code: domain.SSH_UNREACHABLE}, failWritesAfter: 1}
	seededCompose(host, "1.2.2")
	host.respond = upgradeRespond(host, "1.2.3")
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.SSH_UNREACHABLE {
		t.Fatalf("error = %v, want %s", err, domain.SSH_UNREACHABLE)
	}
	if !strings.Contains(coded.Message, "boom") {
		t.Errorf("message = %q, want the failed version's logs", coded.Message)
	}
}

func TestUpgradeRejectsANonContainerTarget(t *testing.T) {
	_, err := newService(&fakeHost{}).Upgrade(context.Background(), domain.Target{AccountID: "a", ScriptName: "worker"}, nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.TARGET_UNSUPPORTED {
		t.Fatalf("error = %v, want %s", err, domain.TARGET_UNSUPPORTED)
	}
}
