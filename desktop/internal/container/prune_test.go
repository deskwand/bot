package container

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

func TestPruneScriptKeepsLiveImages(t *testing.T) {
	script := pruneScript()
	for _, want := range []string{
		`docker ps -a --format '{{.Image}}'`,
		`docker images --format '{{.Repository}}:{{.Tag}}'`,
		`case "$ref" in`,
		`grep -v '<none>$'`,
		`grep -Fqx "$ref"`,
		`docker rmi "$ref" >/dev/null 2>&1 || true`,
		ImageRepository + ":*",
		SandboxImageRepository + ":*",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("script is missing %q\n%s", want, script)
		}
	}
	// A forced removal deletes an image a stopped container may need, a status
	// probe would be mistaken for one by the fake hosts, a positional repository
	// argument matches sibling repositories by prefix, and an early exit would
	// leave the rest of the stale images behind.
	for _, unwanted := range []string{
		"docker rmi -f",
		"docker inspect",
		"--no-trunc",
		`"$repo"`,
		"set -e",
		"docker compose",
		"~/deskwand",
		"1.2.3",
	} {
		if strings.Contains(script, unwanted) {
			t.Errorf("script contains %q, want it gone\n%s", unwanted, script)
		}
	}
}

func TestPrunedRepositoriesCoverComposeTemplate(t *testing.T) {
	imageLine := regexp.MustCompile(`(?m)^\s*image:\s*(\S+)\s*$`)
	matches := imageLine.FindAllStringSubmatch(string(ComposeFile("1.2.3")), -1)
	if len(matches) == 0 {
		t.Fatal("the compose template names no image")
	}
	for _, match := range matches {
		ref := match[1]
		repo := ref[:strings.LastIndex(ref, ":")]
		covered := false
		for _, pruned := range prunedRepositories {
			if pruned == repo {
				covered = true
			}
		}
		if !covered {
			t.Errorf("compose template names %s, which prunedRepositories does not cover", repo)
		}
	}
}

func TestPruneImagesRunsTheScriptOnAnSSHHost(t *testing.T) {
	host := &fakeHost{}
	newService(host).pruneImages(context.Background(), containerTarget(), host)
	if len(host.commands) != 1 || host.commands[0] != pruneScript() {
		t.Fatalf("commands = %q, want the prune script once", host.commands)
	}
}

func TestPruneImagesSkipsLocalTargets(t *testing.T) {
	for _, engine := range []string{domain.EngineCompose, domain.EngineApple} {
		host := &fakeHost{}
		target := containerTarget()
		target.Host = domain.HostRef{Transport: domain.TransportLocal, Engine: engine, Dir: "~/deskwand"}
		newService(host).pruneImages(context.Background(), target, host)
		if len(host.commands) != 0 {
			t.Errorf("%s: commands = %q, want none for a local target", engine, host.commands)
		}
	}
}

func TestPruneImagesDropsFailures(t *testing.T) {
	// A nonzero exit and a broken transport both leave the deploy as it was:
	// pruneImages has nothing to report and must not panic on either.
	for name, respond := range map[string]func(string) (hostexec.Result, error){
		"exit": func(string) (hostexec.Result, error) {
			return hostexec.Result{ExitCode: 1, Stderr: []byte("permission denied")}, nil
		},
		"transport": func(string) (hostexec.Result, error) {
			return hostexec.Result{}, errors.New("connection reset")
		},
	} {
		host := &fakeHost{respond: respond}
		newService(host).pruneImages(context.Background(), containerTarget(), host)
		if len(host.commands) != 1 {
			t.Errorf("%s: commands = %q, want one attempt", name, host.commands)
		}
	}
}

func TestInstallPrunesOldImages(t *testing.T) {
	host := &fakeHost{respond: installRespond(func() hostexec.Result {
		return hostexec.Result{Stdout: []byte("running|healthy|2026-11-13T02:00:00Z|ghcr.io/deskwand/bot:1.2.3\n")}
	})}
	if _, err := newService(host).Install(context.Background(), containerTarget(), installRequest(), nil); err != nil {
		t.Fatal(err)
	}
	if pruned := pruneCommands(host.commands); len(pruned) != 1 {
		t.Fatalf("prune ran %d times, want once", len(pruned))
	}
	if commandIndex(host.commands, pruneScript()) < commandIndex(host.commands, "docker compose up -d") {
		t.Error("the cleanup ran before the container was started")
	}
}

func TestUpgradePrunesOldImages(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.respond = upgradeRespond(host)
	if _, err := newService(host).Upgrade(context.Background(), containerTarget(), nil); err != nil {
		t.Fatal(err)
	}
	if pruned := pruneCommands(host.commands); len(pruned) != 1 {
		t.Fatalf("prune ran %d times, want once", len(pruned))
	}
	if commandIndex(host.commands, pruneScript()) < commandIndex(host.commands, "docker compose up -d") {
		t.Error("the cleanup ran before the container was started")
	}
}

func TestUpgradeSurvivesAFailedPrune(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	healthy := upgradeRespond(host)
	host.respond = func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "docker images --format") {
			return hostexec.Result{ExitCode: 1, Stderr: []byte("permission denied")}, nil
		}
		return healthy(command)
	}
	result, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	if err != nil {
		t.Fatalf("a failed cleanup turned the upgrade into a failure: %v", err)
	}
	if result.VersionID != "container:1.2.3" {
		t.Errorf("VersionID = %q", result.VersionID)
	}
}

func TestRollbackPrunesAfterASuccessfulRollback(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.respond = upgradeRespond(host, "1.2.3")
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.UPGRADE_ROLLED_BACK {
		t.Fatalf("error = %v, want %s", err, domain.UPGRADE_ROLLED_BACK)
	}
	// The cleanup runs after the rollback's own health wait, so it is the last
	// thing this deploy does; a stopped container keeps its image, which is why
	// the live set protects the version the rollback restarted.
	if pruned := pruneCommands(host.commands); len(pruned) != 1 {
		t.Fatalf("prune ran %d times, want once after the rollback", len(pruned))
	}
	if commandIndex(host.commands, pruneScript()) < commandIndex(host.commands, "docker compose up -d") {
		t.Error("the cleanup ran before the rollback restarted the container")
	}
}

func TestNoPruneWhenTheRollbackItselfFails(t *testing.T) {
	host := &fakeHost{}
	seededCompose(host, "1.2.2")
	host.respond = upgradeRespond(host, "1.2.2", "1.2.3")
	_, err := newService(host).Upgrade(context.Background(), containerTarget(), nil)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != domain.UPGRADE_ROLLBACK_FAILED {
		t.Fatalf("error = %v, want %s", err, domain.UPGRADE_ROLLBACK_FAILED)
	}
	if pruned := pruneCommands(host.commands); len(pruned) != 0 {
		t.Errorf("prune commands = %q, want none", pruned)
	}
}

func TestNoPruneWhenTheVersionIsCurrent(t *testing.T) {
	// Already on the bundled release: nothing was pulled or started, so the
	// cleanup has nothing of its own to drop and the page must stay instant.
	host := &fakeHost{}
	seededCompose(host, "1.2.3")
	host.respond = upgradeRespond(host)
	if _, err := newService(host).Upgrade(context.Background(), containerTarget(), nil); err != nil {
		t.Fatal(err)
	}
	if pruned := pruneCommands(host.commands); len(pruned) != 0 {
		t.Errorf("prune commands = %q, want none", pruned)
	}
}

// TestPruneScriptPrunesOnlyStaleImages runs the generated script through a real
// shell with docker stubbed out, because substring assertions cannot tell a
// working script from one whose case branches are swapped.
func TestPruneScriptPrunesOnlyStaleImages(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no POSIX shell on this machine")
	}
	logPath := filepath.Join(t.TempDir(), "removed.txt")
	harness := `docker() {
  case "$1" in
    ps) printf 'ghcr.io/deskwand/bot:1.2.3\nghcr.io/deskwand/sandbox:1.2.3\nghcr.io/deskwand/bot:1.1.0\n' ;;
    images) printf 'ghcr.io/deskwand/bot:1.2.3\nghcr.io/deskwand/bot:1.1.0\nghcr.io/deskwand/bot:1.0.0\nghcr.io/deskwand/bot:<none>\nghcr.io/deskwand/bot-web:1.0.0\nghcr.io/deskwand/sandbox:1.2.3\nghcr.io/deskwand/sandbox:1.1.0\n' ;;
    rmi) printf '%s\n' "$2" >> "$PRUNE_TEST_LOG" ;;
  esac
}
` + pruneScript()
	cmd := exec.Command("sh", "-c", harness)
	cmd.Env = append(os.Environ(), "PRUNE_TEST_LOG="+logPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("the script failed under sh: %v\n%s", err, out)
	}
	removed, err := os.ReadFile(logPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	// 1.2.3 is running, 1.1.0 belongs to a stopped container imaged by another
	// instance, bot-web is a sibling repository, and <none> has no tag: none of
	// those may be touched.
	want := "ghcr.io/deskwand/bot:1.0.0\nghcr.io/deskwand/sandbox:1.1.0\n"
	if got := string(removed); got != want {
		t.Errorf("removed %q, want %q", got, want)
	}
}
