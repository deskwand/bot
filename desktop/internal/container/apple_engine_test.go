package container

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/hostexec"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

const (
	appleTestAbsDir       = "/Users/u/Library/Application Support/DeskWand/local"
	appleTestContainerBin = "/usr/local/bin/container"
	appleTestImage        = "ghcr.io/deskwand/bot:1.2.3"
	appleTestHome         = "/Users/u"
	appleTestDir          = "~/Library/Application Support/DeskWand/local"
)

// readApplePlistArray reads the strings of one <array> element.
func readApplePlistArray(decoder *xml.Decoder, start xml.StartElement) ([]string, error) {
	var items []string
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		switch element := token.(type) {
		case xml.EndElement:
			return items, nil
		case xml.StartElement:
			var text string
			if err := decoder.DecodeElement(&text, &element); err != nil {
				return nil, err
			}
			items = append(items, text)
		}
	}
}

// readApplePlist decodes the top-level dict of a plist into its string values
// and its arrays. It fails the test when the document is not well formed.
func readApplePlist(t *testing.T, data []byte) (map[string]string, map[string][]string) {
	t.Helper()
	decoder := xml.NewDecoder(bytes.NewReader(data))
	values := map[string]string{}
	arrays := map[string][]string{}
	var key string
	// depth is 1 inside <plist>, 2 for the top-level dict, 3 for its entries.
	depth := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("parse plist: %v", err)
		}
		switch element := token.(type) {
		case xml.EndElement:
			depth--
		case xml.StartElement:
			depth++
			if depth != 3 {
				continue
			}
			name := element.Name.Local
			switch {
			case name == "key":
				if err := decoder.DecodeElement(&key, &element); err != nil {
					t.Fatalf("parse plist key: %v", err)
				}
				// DecodeElement consumed the element's own end tag.
				depth--
				continue
			case name == "true" || name == "false":
				values[key] = name
				if err := decoder.Skip(); err != nil {
					t.Fatalf("parse plist %s: %v", key, err)
				}
			case name == "array":
				items, err := readApplePlistArray(decoder, element)
				if err != nil {
					t.Fatalf("parse plist array %q: %v", key, err)
				}
				arrays[key] = items
			default:
				var text string
				if err := decoder.DecodeElement(&text, &element); err != nil {
					t.Fatalf("parse plist value %q: %v", key, err)
				}
				values[key] = text
			}
			// The element's own end tag was consumed above.
			depth--
			key = ""
		}
	}
	return values, arrays
}

func TestAppleManifestQuotesDirWithSpace(t *testing.T) {
	script := string(appleRunScript(appleTestAbsDir, appleTestContainerBin, appleTestImage))

	cdLine := "cd '" + appleTestAbsDir + "' || exit 1"
	if !strings.Contains(script, cdLine) {
		t.Fatalf("run.sh missing %q:\n%s", cdLine, script)
	}

	lines := strings.Split(strings.TrimRight(script, "\n"), "\n")
	execLine := "exec '" + appleTestContainerBin + "' run --rm --name deskwand-bot --env-file .env " +
		"-p 127.0.0.1:8787:8787 -v " + appleVolume + ":/data " + appleTestImage
	if last := lines[len(lines)-1]; !strings.HasSuffix(last, execLine) {
		t.Fatalf("last line = %q, want suffix %q", last, execLine)
	}
	if !strings.HasPrefix(script, "#!/bin/sh\n") {
		t.Fatalf("run.sh does not start with a shebang:\n%s", script)
	}

	_, arrays := readApplePlist(t, appleAgentPlist(appleTestAbsDir))
	args := arrays["ProgramArguments"]
	if len(args) != 2 || args[1] != appleTestAbsDir+"/run.sh" {
		t.Fatalf("ProgramArguments = %q, want [/bin/sh %s/run.sh]", args, appleTestAbsDir)
	}
}

func TestAppleRunScriptStartsServiceFirst(t *testing.T) {
	script := string(appleRunScript(appleTestAbsDir, appleTestContainerBin, appleTestImage))

	service := strings.Index(script, "system start --enable-kernel-install")
	remove := strings.Index(script, "rm -f deskwand-bot")
	exec := strings.Index(script, "exec ")
	switch {
	case service < 0:
		t.Fatalf("run.sh does not start the service:\n%s", script)
	case remove < 0:
		t.Fatalf("run.sh does not clear an old container:\n%s", script)
	case exec < 0:
		t.Fatalf("run.sh does not exec the container:\n%s", script)
	case !(service < remove && remove < exec):
		t.Fatalf("run.sh order is service %d, rm %d, exec %d, want service before rm before exec", service, remove, exec)
	}
}

// Apple's container tool creates a named volume as a fresh, root-owned file
// system: unlike Docker it does not copy the image directory's ownership into
// it. The bot runs as uid 10001 and refuses to start on a /data it cannot
// write, so the run script hands the volume to that user before it execs.
func TestAppleRunScriptHandsTheVolumeToTheBotUser(t *testing.T) {
	script := string(appleRunScript(appleTestAbsDir, appleTestContainerBin, appleTestImage))

	want := appleTestContainerBin + "' run --rm --user root --entrypoint chown -v " +
		appleVolume + ":/data " + appleTestImage + " " + appleDataOwner + " /data"
	if !strings.Contains(script, want) {
		t.Fatalf("run.sh does not give the volume to the bot user, want %q:\n%s", want, script)
	}
	chown := strings.Index(script, "--entrypoint chown")
	exec := strings.Index(script, "\nexec ")
	if chown < 0 || exec < 0 || chown > exec {
		t.Fatalf("run.sh chown at %d must come before exec at %d:\n%s", chown, exec, script)
	}
}

func TestApplePlistKeepsAlive(t *testing.T) {
	values, _ := readApplePlist(t, appleAgentPlist(appleTestAbsDir))
	for key, want := range map[string]string{
		"Label":            agentLabel,
		"RunAtLoad":        "true",
		"KeepAlive":        "true",
		"ThrottleInterval": "10",
	} {
		if got := values[key]; got != want {
			t.Fatalf("plist %s = %q, want %q (parsed %q)", key, got, want, values)
		}
	}
}

func TestAppleReadVersion(t *testing.T) {
	script := appleRunScript(appleTestAbsDir, appleTestContainerBin, appleImageRef("1.2.3"))
	if got := appleReadVersion(script); got != "1.2.3" {
		t.Fatalf("version = %q, want 1.2.3", got)
	}

	noImage := []byte("#!/bin/sh\n# " + appleScriptMarker + ". Rewritten on deploy.\nexec container run bot\n")
	if got := appleReadVersion(noImage); got != "" {
		t.Fatalf("version = %q, want empty for a script with no image line", got)
	}
	target := appleTarget()
	host := &fakeHost{files: map[string][]byte{runScriptPath(target.Host.Dir): noImage}}
	_, err := newService(host).engine(target).ReadVersion(context.Background(), host, target.Host.Dir)
	assertCode(t, err, domain.ENV_FILE_INVALID)
}

// A tag is copied out of run.sh and written back unquoted into a /bin/sh line,
// so anything that is not a plain tag has to be refused instead of truncated
// into something that looks valid.
func TestAppleReadVersionRejectsHostileTag(t *testing.T) {
	target := appleTarget()
	const hostile = `1.0"; rm -rf /`
	script := appleRunScript(appleTestAbsDir, appleTestContainerBin, ImageRepository+":"+hostile)
	if got := appleReadVersion(script); got != hostile {
		t.Fatalf("version = %q, want the whole hostile tail %q", got, hostile)
	}

	host := &fakeHost{files: map[string][]byte{runScriptPath(target.Host.Dir): script}}
	_, err := newService(host).engine(target).ReadVersion(context.Background(), host, target.Host.Dir)
	assertCode(t, err, domain.ENV_FILE_INVALID)
}

func TestAppleWriteManifestCreatesLogDir(t *testing.T) {
	target := appleTarget()
	var host *fakeHost
	host = &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if _, written := host.files[agentPlistPath]; written {
			t.Errorf("command %q ran after the plist was written", command)
		}
		return passingApple(command)
	}}
	engine := newService(host).engine(target)
	if err := engine.WriteManifest(context.Background(), host, target.Host.Dir, "1.2.3"); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	want := "mkdir -p " + hostexec.QuotePath(appleTestAbsDir+"/logs")
	found := false
	for _, command := range host.commands {
		if command == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("commands = %q, want %q", host.commands, want)
	}
	if _, ok := host.files[agentPlistPath]; !ok {
		t.Fatalf("files = %q, want the launch agent plist", host.files)
	}
	if _, ok := host.files[runScriptPath(target.Host.Dir)]; !ok {
		t.Errorf("files = %q, want run.sh", host.files)
	}
}

func appleTarget() domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{
			Transport: domain.TransportLocal,
			Engine:    domain.EngineApple,
			Dir:       appleTestDir,
		},
	}
}

func appleTestdata(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read testdata/%s: %v", name, err)
	}
	return data
}

// passingApple answers every command a healthy Apple container run sends.
func passingApple(command string) (hostexec.Result, error) {
	switch {
	case strings.HasPrefix(command, "printf "):
		return hostexec.Result{Stdout: []byte(appleTestHome + "\n" + appleTestContainerBin + "\n")}, nil
	case strings.HasPrefix(command, "container --version"):
		return hostexec.Result{Stdout: []byte("container version 1.0.0 (build release, commit unknown)\n")}, nil
	case strings.HasPrefix(command, "container system status"):
		return hostexec.Result{Stdout: []byte("status: running\n")}, nil
	case strings.HasPrefix(command, "container inspect "):
		return hostexec.Result{Stderr: []byte("not found\n"), ExitCode: 1}, nil
	case strings.HasPrefix(command, "container image inspect"):
		return hostexec.Result{}, nil
	case strings.HasPrefix(command, "container ls "):
		return hostexec.Result{Stdout: []byte("[]\n")}, nil
	case strings.HasPrefix(command, "uname -m"):
		return hostexec.Result{Stdout: []byte("arm64\n")}, nil
	case strings.HasPrefix(command, "lsof "):
		return hostexec.Result{}, nil
	case strings.HasPrefix(command, "mkdir -p"):
		return hostexec.Result{}, nil
	case strings.Contains(command, "launchctl"):
		return hostexec.Result{}, nil
	case strings.HasPrefix(command, "test -e"):
		return hostexec.Result{ExitCode: 1}, nil
	}
	return hostexec.Result{ExitCode: 1}, nil
}

func TestApplePreflightNamesContainerOnPort(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		switch {
		case strings.HasPrefix(command, "lsof "):
			return hostexec.Result{Stdout: []byte("6197\n")}, nil
		case strings.HasPrefix(command, "container ls "):
			return hostexec.Result{Stdout: appleTestdata(t, "apple-ls.json")}, nil
		}
		return passingApple(command)
	}}
	report, err := newService(host).Preflight(context.Background(), appleTarget())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"container", "version", "service", "arch", "port", "dir"}
	if got := preflightIDs(report); !reflect.DeepEqual(got, want) {
		t.Fatalf("check order = %v, want %v", got, want)
	}
	port := checkByID(t, report, "port")
	if port.OK {
		t.Fatalf("port check = %+v, want failure", port)
	}
	if port.Fix != "container stop bot" {
		t.Fatalf("port Fix = %q, want %q", port.Fix, "container stop bot")
	}
}

func TestApplePreflightServiceStopped(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "container system status") {
			return hostexec.Result{Stderr: []byte("not running\n"), ExitCode: 1}, nil
		}
		return passingApple(command)
	}}
	report, err := newService(host).Preflight(context.Background(), appleTarget())
	if err != nil {
		t.Fatal(err)
	}
	service := checkByID(t, report, "service")
	if service.OK {
		t.Fatalf("service check = %+v, want failure", service)
	}
	if service.Fix != "container system start" {
		t.Fatalf("service Fix = %q, want %q", service.Fix, "container system start")
	}
	if runtime := checkByID(t, report, "container"); !runtime.OK {
		t.Errorf("container check = %+v, want OK", runtime)
	}
}

// An old tool cannot answer for the service, so the service was never probed and
// has no repair command to offer. Keeping the fix would tell the user to start a
// service that a too-old release may not even have.
func TestApplePreflightOldVersionHasNoServiceFix(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "container --version") {
			return hostexec.Result{Stdout: []byte("container version 0.9.0 (build release, commit unknown)\n")}, nil
		}
		return passingApple(command)
	}}
	report, err := newService(host).Preflight(context.Background(), appleTarget())
	if err != nil {
		t.Fatal(err)
	}
	if version := checkByID(t, report, "version"); version.OK {
		t.Fatalf("version check = %+v, want failure", version)
	}
	service := checkByID(t, report, "service")
	if service.OK {
		t.Fatalf("service check = %+v, want failure", service)
	}
	if service.Fix != "" {
		t.Fatalf("service Fix = %q, want none: the service was never probed", service.Fix)
	}
	for _, command := range host.commands {
		if strings.HasPrefix(command, "container system status") {
			t.Fatalf("commands = %q, want no service probe", host.commands)
		}
	}
}

func TestApplePreflightMissingContainer(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "container --version") {
			return hostexec.Result{Stderr: []byte("sh: container: command not found\n"), ExitCode: 127}, nil
		}
		return passingApple(command)
	}}
	report, err := newService(host).Preflight(context.Background(), appleTarget())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"container", "version", "service"} {
		if check := checkByID(t, report, id); check.OK {
			t.Errorf("%s check = %+v, want failure", id, check)
		}
	}
	if runtime := checkByID(t, report, "container"); !strings.Contains(runtime.Detail, "github.com/apple/container/releases") {
		t.Errorf("container Detail = %q, want the releases URL", runtime.Detail)
	}
	for _, command := range host.commands {
		if strings.HasPrefix(command, "container system status") {
			t.Fatalf("ran the service check without the container command")
		}
	}
}

func TestApplePreflightRefusesComposeDir(t *testing.T) {
	host := &fakeHost{
		files:   map[string][]byte{composePath(appleTestDir): []byte("services:\n  bot:\n    image: ghcr.io/deskwand/bot:1.0.0\n")},
		respond: passingApple,
	}
	report, err := newService(host).Preflight(context.Background(), appleTarget())
	if err != nil {
		t.Fatal(err)
	}
	dir := checkByID(t, report, "dir")
	if dir.OK {
		t.Fatalf("dir check = %+v, want failure", dir)
	}
	if want := i18n.T(i18n.ZH, "container.check.dir.otherEngineCompose"); dir.Detail != want {
		t.Fatalf("dir Detail = %q, want %q", dir.Detail, want)
	}
	if report.Existing {
		t.Errorf("Existing = true, want false")
	}
}

func TestApplePullSkipsLocalImage(t *testing.T) {
	target := appleTarget()
	host := &fakeHost{
		files: map[string][]byte{
			runScriptPath(target.Host.Dir): appleRunScript(appleTestAbsDir, appleTestContainerBin, appleTestImage),
		},
		respond: passingApple,
	}
	engine := newService(host).engine(target)
	if err := engine.Pull(context.Background(), host, target.Host.Dir); err != nil {
		t.Fatalf("pull: %v", err)
	}
	found := false
	for _, command := range host.commands {
		if !strings.HasPrefix(command, "container image inspect ") {
			continue
		}
		if !strings.Contains(command, "|| container image pull ") {
			t.Fatalf("pull command = %q, want inspect then pull", command)
		}
		if !strings.Contains(command, appleTestImage) {
			t.Errorf("pull command = %q, want the image from run.sh", command)
		}
		found = true
	}
	if !found {
		t.Fatalf("commands = %q, want a container image inspect", host.commands)
	}
}

func TestAppleApplyFailureIsAgentFailed(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.Contains(command, "launchctl") {
			return hostexec.Result{Stderr: []byte("Bootstrap failed: 5: Input/output error\n"), ExitCode: 5}, nil
		}
		return passingApple(command)
	}}
	target := appleTarget()
	err := newService(host).engine(target).Apply(context.Background(), host, target.Host.Dir)
	assertCode(t, err, domain.LOCAL_AGENT_FAILED)
	if !strings.Contains(err.Error(), "Bootstrap failed") {
		t.Errorf("error = %v, want the command output", err)
	}
	joined := strings.Join(host.commands, "\n")
	for _, want := range []string{"launchctl print", "launchctl bootstrap", `"gui/$(id -u)/` + agentLabel + `"`} {
		if !strings.Contains(joined, want) {
			t.Errorf("apply commands = %q, want %q", joined, want)
		}
	}
}

func TestAppleStatusParsesInspect(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		switch {
		case strings.HasPrefix(command, "container inspect "):
			return hostexec.Result{Stdout: appleTestdata(t, "apple-inspect.json")}, nil
		case strings.HasPrefix(command, "curl "):
			return hostexec.Result{}, nil
		}
		return passingApple(command)
	}}
	status, err := newService(host).Status(context.Background(), appleTarget())
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Reachable || !status.Running {
		t.Fatalf("status = %+v, want reachable and running", status)
	}
	if status.Health != "healthy" {
		t.Errorf("Health = %q, want healthy", status.Health)
	}
	if status.StartedAt != "2026-11-13T14:06:30Z" {
		t.Errorf("StartedAt = %q, want 2026-11-13T14:06:30Z", status.StartedAt)
	}
	if status.Image != "ghcr.io/deskwand/bot:latest" {
		t.Errorf("Image = %q, want ghcr.io/deskwand/bot:latest", status.Image)
	}
}

func TestAppleStatusStartingWhenHealthzFails(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		switch {
		case strings.HasPrefix(command, "container inspect "):
			return hostexec.Result{Stdout: appleTestdata(t, "apple-inspect.json")}, nil
		case strings.HasPrefix(command, "curl "):
			return hostexec.Result{ExitCode: 7}, nil
		}
		return passingApple(command)
	}}
	status, err := newService(host).Status(context.Background(), appleTarget())
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Running {
		t.Fatalf("status = %+v, want Running true", status)
	}
	if status.Health != "starting" {
		t.Fatalf("Health = %q, want starting", status.Health)
	}
}

func TestAppleStatusRuntimeStoppedIsUnreachable(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if strings.HasPrefix(command, "container system status") {
			return hostexec.Result{Stderr: []byte("not running\n"), ExitCode: 1}, nil
		}
		return passingApple(command)
	}}
	status, err := newService(host).Status(context.Background(), appleTarget())
	if err != nil {
		t.Fatalf("Status error = %v, want none", err)
	}
	if status.Reachable {
		t.Fatalf("status = %+v, want Reachable false", status)
	}
	for _, command := range host.commands {
		if strings.HasPrefix(command, "container inspect ") {
			t.Fatalf("inspected the container while the runtime was stopped")
		}
	}
}

func TestAppleRemoveWithoutRuntime(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		if command == "command -v container" {
			return hostexec.Result{ExitCode: 1}, nil
		}
		return passingApple(command)
	}}
	target := appleTarget()
	err := newService(host).engine(target).Remove(context.Background(), host, target.Host.Dir)
	assertCode(t, err, domain.LOCAL_RUNTIME_MISSING)

	joined := strings.Join(host.commands, "\n")
	if !strings.Contains(joined, "launchctl bootout "+`"gui/$(id -u)/`+agentLabel+`"`) {
		t.Errorf("commands = %q, want a launchctl bootout", joined)
	}
	if !strings.Contains(joined, "rm -f") || !strings.Contains(joined, "Library/LaunchAgents/"+agentLabel+".plist") {
		t.Errorf("commands = %q, want the agent plist removed", joined)
	}
	if strings.Contains(joined, "container rm -f") {
		t.Errorf("commands = %q, want no container rm without the runtime", joined)
	}
}

// Remove must not hide a failed container removal. A surviving instance keeps
// port 8787, so reporting success would leave the next install failing the port
// check with no explanation. The trailing "; true" this test guards against
// made the exit code always 0.
func TestAppleRemoveFailedContainerRmIsRuntimeStopped(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		switch {
		case command == "command -v container":
			return hostexec.Result{Stdout: []byte(appleTestContainerBin + "\n")}, nil
		case strings.Contains(command, "container rm -f "):
			return hostexec.Result{Stderr: []byte("Error: failed to remove " + appleContainerName + "\n"), ExitCode: 1}, nil
		}
		return passingApple(command)
	}}
	target := appleTarget()
	err := newService(host).engine(target).Remove(context.Background(), host, target.Host.Dir)
	assertCode(t, err, domain.LOCAL_RUNTIME_STOPPED)

	var coded domain.Error
	if errors.As(err, &coded) && !strings.Contains(coded.Message, "failed to remove") {
		t.Errorf("message = %q, want the command output", coded.Message)
	}

	var removeCommand string
	for _, command := range host.commands {
		if strings.Contains(command, "container rm -f ") {
			removeCommand = command
		}
		if strings.HasSuffix(strings.TrimSpace(command), "true") {
			t.Errorf("command = %q, want no trailing true that hides the exit code", command)
		}
	}
	if removeCommand == "" {
		t.Fatalf("commands = %q, want a container rm", host.commands)
	}
	if !strings.Contains(removeCommand, "container rm -f "+appleContainerName) {
		t.Errorf("remove command = %q, want the instance removed by name", removeCommand)
	}
}

func TestAppleInstallWritesPlainEnv(t *testing.T) {
	host := &fakeHost{respond: func(command string) (hostexec.Result, error) {
		switch {
		case strings.HasPrefix(command, "container inspect "):
			return hostexec.Result{Stdout: appleTestdata(t, "apple-inspect.json")}, nil
		case strings.HasPrefix(command, "curl "):
			return hostexec.Result{}, nil
		}
		return passingApple(command)
	}}
	target := appleTarget()
	var ids []string
	result, err := newService(host).Install(context.Background(), target, installRequest(), func(step domain.Step) {
		ids = append(ids, step.ID)
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if result.State != "published" {
		t.Errorf("State = %q, want published", result.State)
	}
	wantIDs := []string{"write-agent", "write-env", "pull", "register", "healthy"}
	if got := uniqueInOrder(ids); !reflect.DeepEqual(got, wantIDs) {
		t.Errorf("step order = %v, want %v", got, wantIDs)
	}
	if _, ok := host.files[runScriptPath(target.Host.Dir)]; !ok {
		t.Errorf("run.sh was not written")
	}
	if _, ok := host.files[agentPlistPath]; !ok {
		t.Errorf("the launch agent plist was not written")
	}

	found := false
	for _, line := range strings.Split(string(host.files[envPath(target.Host.Dir)]), "\n") {
		rest, ok := strings.CutPrefix(line, "DESKWAND_CONFIG=")
		if !ok {
			continue
		}
		found = true
		if strings.HasPrefix(rest, "'") {
			t.Fatalf("DESKWAND_CONFIG line = %q, want an unquoted plain value", line)
		}
	}
	if !found {
		t.Fatalf(".env = %q, want a DESKWAND_CONFIG line", host.files[envPath(target.Host.Dir)])
	}
}

func TestStopTargetOnAppleBootsOutAndStopsTheContainer(t *testing.T) {
	host := &fakeHost{}
	service := newService(host)
	target := containerTarget()
	target.Host.Transport = domain.TransportLocal
	target.Host.Engine = domain.EngineApple
	target.Host.Address = ""
	target.Host.User = ""
	target.Host.Auth = ""

	if err := service.StopTarget(context.Background(), target); err != nil {
		t.Fatalf("StopTarget: %v", err)
	}
	command := host.commands[0]
	if !strings.Contains(command, "launchctl bootout") || !strings.Contains(command, "container stop "+appleContainerName) {
		t.Fatalf("command = %q", command)
	}
	if err := service.StartTarget(context.Background(), target); err != nil {
		t.Fatalf("StartTarget: %v", err)
	}
	if start := host.commands[1]; !strings.Contains(start, "launchctl") {
		t.Fatalf("start = %q", start)
	}
}
