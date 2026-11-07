package main

import (
	"errors"
	"testing"

	"github.com/egoist/mygo"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
	"github.com/deskwand/bot/desktop/internal/platform"
)

// webViewRun records what the guard and the prompt did. The real App.Run never
// runs here: the guard is called directly with injected native calls, so the
// test observes the same steps the app would take.
type webViewRun struct {
	handled bool
	probes  int
	prompts int
	quits   int
	order   []string
	options []mygo.MessageOptions
	opened  []string
}

// runWebViewGuard composes the production guard with the production prompt and
// injects the dialog, the browser and the quit call.
func runWebViewGuard(goos string, available bool, locale string, button int, dialogErr, openErr error) webViewRun {
	var run webViewRun
	run.handled = guardMissingWebView(goos, func() bool {
		run.probes++
		return available
	}, func() {
		run.prompts++
		run.order = append(run.order, "prompt")
		explainMissingWebView(locale,
			func(options mygo.MessageOptions) (mygo.MessageResult, error) {
				run.options = append(run.options, options)
				if dialogErr != nil {
					return mygo.MessageResult{}, dialogErr
				}
				return mygo.MessageResult{Button: button}, nil
			},
			func(url string) error {
				run.opened = append(run.opened, url)
				return openErr
			},
		)
	}, func() {
		run.quits++
		run.order = append(run.order, "quit")
	})
	return run
}

// TestGuardMissingWebViewQuitsOnceOnEveryChoice walks the five prompt outcomes
// through the real orchestration: each one explains the runtime and then quits
// the app exactly once.
func TestGuardMissingWebViewQuitsOnceOnEveryChoice(t *testing.T) {
	openFailure := errors.New("no browser")
	dialogFailure := errors.New("dialog unavailable")
	cases := []struct {
		name      string
		button    int
		dialogErr error
		openErr   error
		opened    int
	}{
		{name: "download button", button: 0, opened: 1},
		{name: "quit button", button: 1},
		{name: "dialog dismissed as cancel", button: 1},
		{name: "dialog error", button: 0, dialogErr: dialogFailure},
		{name: "download page fails to open", button: 0, openErr: openFailure, opened: 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			run := runWebViewGuard("windows", false, i18n.EN, c.button, c.dialogErr, c.openErr)

			if !run.handled {
				t.Fatal("guardMissingWebView handled = false, want true on Windows without the runtime")
			}
			if run.probes != 1 {
				t.Errorf("probe calls = %d, want 1", run.probes)
			}
			if run.prompts != 1 {
				t.Errorf("prompt calls = %d, want 1", run.prompts)
			}
			if run.quits != 1 {
				t.Errorf("quit calls = %d, want exactly 1", run.quits)
			}
			if len(run.options) != 1 {
				t.Errorf("dialog calls = %d, want 1", len(run.options))
			}
			if got, want := len(run.opened), c.opened; got != want {
				t.Errorf("openExternal calls = %d, want %d", got, want)
			}
			for _, url := range run.opened {
				if url != platform.WebViewDownloadURL {
					t.Errorf("openExternal(%q), want the WebView2 download page", url)
				}
			}
			// The explanation must be on screen before the process ends.
			if len(run.order) != 2 || run.order[0] != "prompt" || run.order[1] != "quit" {
				t.Errorf("call order = %v, want [prompt quit]", run.order)
			}
		})
	}
}

// TestGuardMissingWebViewSkipsWithoutTheRuntimeCheck covers the two paths that
// must not explain anything: a machine that has the runtime, and a platform
// that never uses WebView2.
func TestGuardMissingWebViewSkipsWithoutTheRuntimeCheck(t *testing.T) {
	cases := []struct {
		name      string
		goos      string
		available bool
		probes    int
	}{
		{name: "windows with the runtime", goos: "windows", available: true, probes: 1},
		{name: "darwin without the runtime", goos: "darwin", available: false, probes: 0},
		{name: "linux without the runtime", goos: "linux", available: false, probes: 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			run := runWebViewGuard(c.goos, c.available, i18n.EN, 0, nil, nil)

			if run.handled {
				t.Error("guardMissingWebView handled = true, want false")
			}
			if run.probes != c.probes {
				t.Errorf("probe calls = %d, want %d", run.probes, c.probes)
			}
			if run.prompts != 0 {
				t.Errorf("prompt calls = %d, want 0", run.prompts)
			}
			if run.quits != 0 {
				t.Errorf("quit calls = %d, want 0", run.quits)
			}
			if len(run.options) != 0 || len(run.opened) != 0 {
				t.Errorf("native calls = %d dialogs / %d opens, want none", len(run.options), len(run.opened))
			}
		})
	}
}

// TestExplainMissingWebViewLocalizesTheDialog checks the four keys in both
// tables, including the button indices that make Enter retry the install and
// Escape quit.
func TestExplainMissingWebViewLocalizesTheDialog(t *testing.T) {
	for _, locale := range []string{i18n.EN, i18n.ZH} {
		t.Run(locale, func(t *testing.T) {
			run := runWebViewGuard("windows", false, locale, 0, nil, nil)
			if len(run.options) != 1 {
				t.Fatalf("dialog calls = %d, want 1", len(run.options))
			}
			options := run.options[0]

			if want := i18n.T(locale, "app.webViewMissingTitle"); options.Title != want {
				t.Errorf("Title = %q, want %q", options.Title, want)
			}
			if want := i18n.T(locale, "app.webViewMissingMessage"); options.Message != want {
				t.Errorf("Message = %q, want %q", options.Message, want)
			}
			want := []string{
				i18n.T(locale, "app.webViewMissingDownload"),
				i18n.T(locale, "app.webViewMissingQuit"),
			}
			if len(options.Buttons) != len(want) {
				t.Fatalf("Buttons = %v, want %v", options.Buttons, want)
			}
			for index, label := range want {
				if options.Buttons[index] != label {
					t.Errorf("Buttons[%d] = %q, want %q", index, options.Buttons[index], label)
				}
			}
			if options.Type != mygo.MessageError {
				t.Errorf("Type = %q, want %q", options.Type, mygo.MessageError)
			}
			if options.DefaultButton != 0 {
				t.Errorf("DefaultButton = %d, want 0", options.DefaultButton)
			}
			if options.CancelButton != 1 {
				t.Errorf("CancelButton = %d, want 1", options.CancelButton)
			}
			if len(run.opened) != 1 || run.opened[0] != "https://developer.microsoft.com/microsoft-edge/webview2/" {
				t.Errorf("opened = %v, want the official Microsoft WebView2 page", run.opened)
			}
			if locale == i18n.EN {
				i18ntest.NoHan(t, "app.webViewMissingMessage", options.Message)
				for _, button := range options.Buttons {
					i18ntest.NoHan(t, "app.webViewMissingButtons", button)
				}
			}
		})
	}
}

// TestWebViewPromptKeysExist keeps the four keys visible to the i18n check even
// if a later refactor moves the prompt out of main.go.
func TestWebViewPromptKeysExist(t *testing.T) {
	keys := []string{
		"app.webViewMissingTitle",
		"app.webViewMissingMessage",
		"app.webViewMissingDownload",
		"app.webViewMissingQuit",
	}
	for _, locale := range []string{i18n.EN, i18n.ZH} {
		for _, key := range keys {
			if text, ok := i18n.Lookup(locale, key); !ok || text == "" {
				t.Errorf("i18n.Lookup(%q, %q) = %q, %v", locale, key, text, ok)
			}
		}
	}
}
