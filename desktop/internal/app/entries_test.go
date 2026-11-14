package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/i18n/i18ntest"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/telegram"
	"github.com/deskwand/bot/desktop/internal/wechat"
)

const (
	wechatTokenSentinel   = "WECHAT-TOKEN-sentinel"
	telegramTokenSentinel = "234567:TELEGRAM-TOKEN-sentinel"
)

type fakePublisher struct {
	mu sync.Mutex

	snapshot    domain.Snapshot
	snapshotErr error
	applyState  string
	applyErr    error

	applyCalls   []domain.Change
	previewCalls int
}

func (f *fakePublisher) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.snapshotErr != nil {
		return domain.Snapshot{}, f.snapshotErr
	}
	return f.snapshot, nil
}

func (f *fakePublisher) Preview(context.Context, domain.Target, domain.Change) ([]domain.Step, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.previewCalls++
	return []domain.Step{{ID: "preview", State: "planned"}}, nil
}

func (f *fakePublisher) Apply(_ context.Context, _ domain.Target, change domain.Change) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.applyCalls = append(f.applyCalls, change)
	state := f.applyState
	if state == "" {
		state = StatePublished
	}
	if f.applyErr != nil {
		return domain.Result{OperationID: "operation-failed", State: state}, f.applyErr
	}
	for _, edit := range change.Secrets {
		if edit.Operation == domain.SecretReplace && !containsString(f.snapshot.SecretNames, edit.Name) {
			f.snapshot.SecretNames = append(f.snapshot.SecretNames, edit.Name)
		}
	}
	return domain.Result{OperationID: "operation-1", State: state}, nil
}

func (f *fakePublisher) lastChange(t *testing.T) domain.Change {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.applyCalls) == 0 {
		t.Fatal("publisher was not called")
	}
	return f.applyCalls[len(f.applyCalls)-1]
}

func (f *fakePublisher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.applyCalls)
}

type fakeSelector struct {
	mu     sync.Mutex
	calls  []string
	result domain.Result
	err    error
}

func (f *fakeSelector) SetActiveChannel(_ context.Context, _ domain.Target, channel string) (domain.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, channel)
	if f.err != nil {
		return domain.Result{}, f.err
	}
	if f.result.State == "" {
		return domain.Result{State: "published"}, nil
	}
	return f.result, nil
}

type fakeTelegram struct {
	mu sync.Mutex

	userID             int64
	getMeErr           error
	deleteWebhookErr   error
	deleteWebhookCalls int
	calls              []string
}

func (f *fakeTelegram) GetMe(context.Context) (telegram.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "getMe")
	if f.getMeErr != nil {
		return telegram.User{}, f.getMeErr
	}
	id := f.userID
	if id == 0 {
		id = 1
	}
	return telegram.User{ID: id, IsBot: true, FirstName: "DeskWand"}, nil
}

func (f *fakeTelegram) DeleteWebhook(ctx context.Context) error {
	f.mu.Lock()
	f.calls = append(f.calls, "deleteWebhook")
	f.deleteWebhookCalls++
	err := f.deleteWebhookErr
	f.mu.Unlock()

	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return err
}

func newTestService(publisher *fakePublisher, selector *fakeSelector, credentials platform.CredentialStore, login func(context.Context, func(wechat.LoginStatus)) (wechat.Credentials, error), telegramClient *fakeTelegram) *EntryService {
	return NewEntryService(EntryOptions{
		Publisher:   publisher,
		Snapshots:   publisher,
		Selector:    selector,
		Credentials: credentials,
		Login:       login,
		Telegram: func(string) TelegramAPI {
			return telegramClient
		},
	})
}

func TestConnectWeChatPublishesReplaceWithoutSelecting(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1", VersionID: "v1"}}
	selector := &fakeSelector{}
	credentials := wechat.Credentials{
		Token:     wechatTokenSentinel,
		BaseURL:   "https://ilinkai.weixin.qq.com",
		AccountID: "account-1",
		UserID:    "owner-1",
	}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(),
		func(_ context.Context, onStatus func(wechat.LoginStatus)) (wechat.Credentials, error) {
			if onStatus != nil {
				onStatus(wechat.LoginStatus{OperationID: "login-1", State: wechat.LoginConfirmed, Message: "已确认登录"})
			}
			return credentials, nil
		}, &fakeTelegram{})

	result, err := service.ConnectWeChat(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"})
	if err != nil {
		t.Fatalf("ConnectWeChat: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	change := publisher.lastChange(t)
	if change.BaseFingerprint != "fp-1" {
		t.Fatalf("base fingerprint = %q", change.BaseFingerprint)
	}
	if len(change.Secrets) != 1 || change.Secrets[0].Name != "WECHAT_CREDENTIALS" ||
		change.Secrets[0].Operation != domain.SecretReplace {
		t.Fatalf("secret edits = %#v", change.Secrets)
	}
	var stored wechat.Credentials
	if err := json.Unmarshal([]byte(change.Secrets[0].Value()), &stored); err != nil {
		t.Fatalf("published JSON: %v", err)
	}
	if stored != credentials {
		t.Fatalf("published credentials = %#v, want %#v", stored, credentials)
	}
	if len(selector.calls) != 0 {
		t.Fatalf("saving WeChat credentials changed ACTIVE_CHANNEL: %v", selector.calls)
	}
	for _, output := range []string{fmt.Sprint(result), fmt.Sprint(change), fmt.Sprint(credentials)} {
		if strings.Contains(output, wechatTokenSentinel) {
			t.Fatalf("output leaked token: %s", output)
		}
	}
}

func TestCancelledLoginCannotPublish(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	selector := &fakeSelector{}
	ctx, cancel := context.WithCancel(context.Background())
	credentials := wechat.Credentials{
		Token:     wechatTokenSentinel,
		BaseURL:   "https://ilinkai.weixin.qq.com",
		AccountID: "account-1",
		UserID:    "owner-1",
	}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(),
		func(context.Context, func(wechat.LoginStatus)) (wechat.Credentials, error) {
			// A late confirmed response arrives after the user cancelled.
			cancel()
			return credentials, nil
		}, &fakeTelegram{})

	result, err := service.ConnectWeChat(ctx, domain.Target{AccountID: "a", ScriptName: "bot"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ConnectWeChat error = %v, want context.Canceled", err)
	}
	if result != (domain.Result{}) {
		t.Fatalf("cancelled login returned result: %#v", result)
	}
	if publisher.callCount() != 0 {
		t.Fatal("cancelled login published credentials")
	}
	if len(selector.calls) != 0 {
		t.Fatal("cancelled login changed ACTIVE_CHANNEL")
	}
}

func TestConfirmedLoginPublishesAfterCancellation(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	selector := &fakeSelector{}
	ctx, cancel := context.WithCancel(context.Background())
	credentials := wechat.Credentials{
		Token:     wechatTokenSentinel,
		BaseURL:   "https://ilinkai.weixin.qq.com",
		AccountID: "account-1",
		UserID:    "owner-1",
	}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(),
		func(_ context.Context, onStatus func(wechat.LoginStatus)) (wechat.Credentials, error) {
			onStatus(wechat.LoginStatus{OperationID: "login-1", State: wechat.LoginConfirmed, Message: "已确认登录"})
			// A cancel arriving after confirmed must not discard the credential.
			cancel()
			return credentials, nil
		}, &fakeTelegram{})

	result, err := service.ConnectWeChatWithStatus(ctx, domain.Target{AccountID: "a", ScriptName: "bot"}, nil)
	if err != nil {
		t.Fatalf("ConnectWeChatWithStatus: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	if publisher.callCount() != 1 {
		t.Fatalf("publish calls = %d, want 1", publisher.callCount())
	}
}

func TestConnectWeChatRejectsUntrustedCredentials(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	service := newTestService(publisher, &fakeSelector{}, platform.NewMemoryCredentialStore(),
		func(context.Context, func(wechat.LoginStatus)) (wechat.Credentials, error) {
			return wechat.Credentials{
				Token:     wechatTokenSentinel,
				BaseURL:   "https://example.com",
				AccountID: "account-1",
				UserID:    "owner-1",
			}, nil
		}, &fakeTelegram{})

	_, err := service.ConnectWeChat(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"})
	if !errors.Is(err, wechat.ErrUntrustedBaseURL) {
		t.Fatalf("ConnectWeChat error = %v, want ErrUntrustedBaseURL", err)
	}
	if publisher.callCount() != 0 {
		t.Fatal("untrusted login published credentials")
	}
}

func TestConnectTelegramPublishesTokenAndDeletesWebhook(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1", VersionID: "v1"}}
	client := &fakeTelegram{}
	service := newTestService(publisher, &fakeSelector{}, platform.NewMemoryCredentialStore(), nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	result, err := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if err != nil {
		t.Fatalf("ConnectTelegram: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}

	change := publisher.lastChange(t)
	if len(change.Secrets) != 1 || change.Secrets[0].Name != "TELEGRAM_BOT_TOKEN" ||
		change.Secrets[0].Operation != domain.SecretReplace ||
		change.Secrets[0].Value() != telegramTokenSentinel {
		t.Fatalf("secret edits = %#v, want only the bot token", change.Secrets)
	}
	if client.deleteWebhookCalls != 1 {
		t.Fatalf("deleteWebhook calls = %d, want 1", client.deleteWebhookCalls)
	}
	if len(client.calls) < 2 || client.calls[0] != "getMe" {
		t.Fatalf("call order = %v, want getMe before publish", client.calls)
	}
	for _, output := range []string{fmt.Sprint(result), fmt.Sprint(change)} {
		if strings.Contains(output, telegramTokenSentinel) {
			t.Fatalf("output leaked a secret: %s", output)
		}
	}
}

func TestConnectTelegramPublishFailureDoesNotDeleteWebhook(t *testing.T) {
	publisher := &fakePublisher{
		snapshot:   domain.Snapshot{Fingerprint: "fp-1"},
		applyState: "failed",
		applyErr:   errors.New("publish failed"),
	}
	client := &fakeTelegram{}
	service := newTestService(publisher, &fakeSelector{}, platform.NewMemoryCredentialStore(), nil, client)

	result, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel)
	if err == nil || result.State != "failed" {
		t.Fatalf("ConnectTelegram result=%#v err=%v", result, err)
	}
	if client.deleteWebhookCalls != 0 {
		t.Fatalf("deleteWebhook calls = %d, want 0", client.deleteWebhookCalls)
	}
	if strings.Contains(err.Error(), telegramTokenSentinel) {
		t.Fatalf("publish error leaked token: %v", err)
	}
}

func TestConnectTelegramDeleteWebhookFailureStillPublished(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{deleteWebhookErr: errors.New("Telegram unavailable")}
	service := newTestService(publisher, &fakeSelector{}, platform.NewMemoryCredentialStore(), nil, client)

	result, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel)
	if err != nil {
		t.Fatalf("ConnectTelegram: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	if client.deleteWebhookCalls != 1 {
		t.Fatalf("deleteWebhook calls = %d, want 1", client.deleteWebhookCalls)
	}
}

func TestConnectTelegramGetMeFailureDoesNotPublish(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{getMeErr: errors.New("unauthorized token " + telegramTokenSentinel)}
	service := newTestService(publisher, &fakeSelector{}, platform.NewMemoryCredentialStore(), nil, client)

	_, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel)
	if err == nil {
		t.Fatal("ConnectTelegram succeeded with a failing getMe")
	}
	if publisher.callCount() != 0 {
		t.Fatal("token validation failure still published secrets")
	}
	if strings.Contains(err.Error(), telegramTokenSentinel) {
		t.Fatalf("getMe error leaked token: %v", err)
	}
}

func TestConnectTelegramWithoutSnapshotsIsBlocked(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{}
	service := NewEntryService(EntryOptions{
		Publisher:   publisher,
		Selector:    &fakeSelector{},
		Credentials: platform.NewMemoryCredentialStore(),
		Telegram:    func(string) TelegramAPI { return client },
	})

	_, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel)
	if !errors.Is(err, ErrSnapshotReaderNotWired) {
		t.Fatalf("ConnectTelegram error = %v, want ErrSnapshotReaderNotWired", err)
	}
	if publisher.callCount() != 0 || len(client.calls) != 0 {
		t.Fatal("missing snapshot reader still performed work")
	}
}

func TestSetActiveChannelValidatesEntry(t *testing.T) {
	selector := &fakeSelector{}
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(), nil, &fakeTelegram{})

	if _, err := service.SetActiveChannel(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "slack"); !errors.Is(err, ErrInvalidEntry) {
		t.Fatalf("SetActiveChannel error = %v, want ErrInvalidEntry", err)
	}
	if len(selector.calls) != 0 {
		t.Fatalf("selector calls = %v", selector.calls)
	}
	if _, err := service.SetActiveChannel(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "WECHAT"); err != nil {
		t.Fatalf("SetActiveChannel: %v", err)
	}
	if len(selector.calls) != 1 || selector.calls[0] != EntryWeChat {
		t.Fatalf("selector calls = %v", selector.calls)
	}
}

func TestSelectEntryRejectsUnknownChannel(t *testing.T) {
	selector := &fakeSelector{}
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(), nil, &fakeTelegram{})

	_, err := service.SelectEntry(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "slack")
	if !errors.Is(err, ErrInvalidEntry) {
		t.Fatalf("SelectEntry error = %v, want ErrInvalidEntry", err)
	}
	if len(selector.calls) != 0 {
		t.Fatalf("selector calls = %v", selector.calls)
	}
}

func TestSelectUnconfiguredChannelWarnsAndDoesNotFallBack(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1", SecretNames: []string{"TELEGRAM_BOT_TOKEN"}}}
	selector := &fakeSelector{}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(), nil, &fakeTelegram{})

	selection, err := service.SelectEntry(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "wechat")
	if err != nil {
		t.Fatalf("SelectEntry: %v", err)
	}
	if selection.Channel != EntryWeChat || selection.Configured {
		t.Fatalf("selection = %#v", selection)
	}
	if selection.Warning == "" {
		t.Fatal("unconfigured selection did not warn")
	}
	if len(selector.calls) != 1 || selector.calls[0] != EntryWeChat {
		t.Fatalf("selector calls = %v, want only wechat", selector.calls)
	}
}

func TestSelectConfiguredChannelHasNoWarning(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1", SecretNames: []string{"WECHAT_CREDENTIALS"}}}
	selector := &fakeSelector{}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(), nil, &fakeTelegram{})

	selection, err := service.SelectEntry(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "WECHAT")
	if err != nil {
		t.Fatalf("SelectEntry: %v", err)
	}
	if !selection.Configured || selection.Warning != "" || selection.Channel != EntryWeChat {
		t.Fatalf("selection = %#v", selection)
	}
}

func TestSelectEntryKeepsUnavailableChoiceOnRepeatedSelection(t *testing.T) {
	// Missing credentials do not clear or replace the user's selection; the
	// page can remain on WeChat until the user explicitly chooses Telegram.
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	selector := &fakeSelector{}
	service := newTestService(publisher, selector, platform.NewMemoryCredentialStore(), nil, &fakeTelegram{})

	for range 2 {
		selection, err := service.SelectEntry(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, EntryWeChat)
		if err != nil {
			t.Fatalf("SelectEntry: %v", err)
		}
		if selection.Channel != EntryWeChat || selection.Warning == "" {
			t.Fatalf("selection = %#v", selection)
		}
	}
	if len(selector.calls) != 2 || selector.calls[0] != EntryWeChat || selector.calls[1] != EntryWeChat {
		t.Fatalf("selector calls = %v", selector.calls)
	}
}

func TestActiveChannelSelectorPublishesOnlyTheVariable(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1", VersionID: "v1"}}
	selector := NewActiveChannelSelector(publisher, publisher)

	result, err := selector.SetActiveChannel(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "WECHAT")
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	change := publisher.lastChange(t)
	if change.BaseFingerprint != "fp-1" {
		t.Fatalf("base fingerprint = %q", change.BaseFingerprint)
	}
	if len(change.Vars) != 1 || change.Vars["ACTIVE_CHANNEL"] != "wechat" {
		t.Fatalf("vars = %#v", change.Vars)
	}
	if len(change.Secrets) != 0 {
		t.Fatalf("secret edits = %#v, want none", change.Secrets)
	}
	if change.Patch.TelegramUserIDs != nil || change.Patch.ButlerModel != nil || change.Patch.TaskModel != nil {
		t.Fatalf("patch = %#v, want no configuration change", change.Patch)
	}
}

func TestActiveChannelSelectorShortCircuitsUnchangedChannel(t *testing.T) {
	settings, _ := json.Marshal(map[string]any{
		"bindings": []any{
			map[string]any{"type": "plain_text", "name": "ACTIVE_CHANNEL", "text": "wechat"},
		},
	})
	publisher := &fakePublisher{snapshot: domain.Snapshot{
		Fingerprint:  "fp-1",
		VersionID:    "v1",
		SettingsJSON: settings,
	}}
	selector := NewActiveChannelSelector(publisher, publisher)

	result, err := selector.SetActiveChannel(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "WECHAT")
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StateUnchanged {
		t.Fatalf("result = %#v", result)
	}
	if publisher.callCount() != 0 {
		t.Fatal("unchanged ACTIVE_CHANNEL still published a version")
	}
}

func TestActiveChannelSelectorRejectsUnknownChannelBeforeReading(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	selector := NewActiveChannelSelector(publisher, publisher)

	if _, err := selector.SetActiveChannel(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, "slack"); !errors.Is(err, ErrInvalidEntry) {
		t.Fatalf("error = %v, want ErrInvalidEntry", err)
	}
	if publisher.callCount() != 0 {
		t.Fatal("invalid channel reached the publisher")
	}
}

func TestWeChatLoginStatusFollowsLocale(t *testing.T) {
	credentials := wechat.Credentials{
		Token:     wechatTokenSentinel,
		BaseURL:   "https://ilinkai.weixin.qq.com",
		AccountID: "account-1",
		UserID:    "owner-1",
	}
	cases := []struct {
		phase string
		state string
		zh    string
	}{
		{"prompt", wechat.LoginWaiting, "请使用微信扫描二维码"},
		{"pending", wechat.LoginWaiting, "等待扫码"},
		{"scanned", wechat.LoginScanned, "已扫码，请在手机上确认"},
		{"expired", wechat.LoginExpired, "二维码已过期，正在刷新"},
		{"cancelled", wechat.LoginCancelled, "登录已取消"},
		{"confirmed", wechat.LoginConfirmed, "已确认登录"},
	}

	for _, locale := range []string{i18n.ZH, i18n.EN} {
		t.Run(locale, func(t *testing.T) {
			publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
			service := NewEntryService(EntryOptions{
				Publisher:   publisher,
				Snapshots:   publisher,
				Selector:    &fakeSelector{},
				Credentials: platform.NewMemoryCredentialStore(),
				Login: func(_ context.Context, onStatus func(wechat.LoginStatus)) (wechat.Credentials, error) {
					for _, test := range cases {
						onStatus(wechat.LoginStatus{OperationID: "login-1", State: test.state, Phase: test.phase})
					}
					return credentials, nil
				},
				Telegram: func(string) TelegramAPI { return &fakeTelegram{} },
				Locale:   func() string { return locale },
			})

			var forwarded []wechat.LoginStatus
			_, err := service.ConnectWeChatWithStatus(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, func(status wechat.LoginStatus) {
				forwarded = append(forwarded, status)
			})
			if err != nil {
				t.Fatalf("ConnectWeChatWithStatus: %v", err)
			}
			if len(forwarded) != len(cases) {
				t.Fatalf("forwarded %d statuses, want %d", len(forwarded), len(cases))
			}
			for index, status := range forwarded {
				if status.Message == "" {
					t.Fatalf("phase %q has no message", cases[index].phase)
				}
				if locale == i18n.ZH {
					if status.Message != cases[index].zh {
						t.Fatalf("phase %q message = %q, want %q", cases[index].phase, status.Message, cases[index].zh)
					}
					continue
				}
				i18ntest.NoHan(t, "phase "+cases[index].phase, status.Message)
			}
		})
	}
}

func TestSelectEntryDefaultSelectorIsExplicitlyNotWired(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1", SecretNames: []string{"WECHAT_CREDENTIALS"}}}
	service := NewEntryService(EntryOptions{
		Publisher: publisher,
		Snapshots: publisher,
	})

	selection, err := service.SelectEntry(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, EntryWeChat)
	if !errors.Is(err, ErrNotWired) {
		t.Fatalf("SelectEntry error = %v, want ErrNotWired", err)
	}
	if selection.Channel != EntryWeChat {
		t.Fatalf("selection = %#v", selection)
	}
}

// A move silences the entry through its own path; the UI's selection path keeps
// rejecting the disabled value.
func TestMuteEntryWritesTheDisabledSelection(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp", SettingsJSON: []byte(`{"ACTIVE_CHANNEL":"telegram"}`)}}
	service := &EntryService{selector: NewActiveChannelSelector(publisher, publisher)}
	target := domain.Target{ScriptName: "w"}

	if _, err := service.MuteEntry(context.Background(), target); err != nil {
		t.Fatalf("MuteEntry: %v", err)
	}
	change := publisher.lastChange(t)
	if got := change.Vars["ACTIVE_CHANNEL"]; got != EntryDisabled {
		t.Fatalf("ACTIVE_CHANNEL = %q, want %q", got, EntryDisabled)
	}
	if _, err := service.SelectEntry(context.Background(), target, EntryDisabled); err == nil {
		t.Fatal("SelectEntry must keep rejecting the disabled selection")
	}
}

func TestReviveEntryRestoresTheRecordedChannel(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp", SettingsJSON: []byte(`{"ACTIVE_CHANNEL":"none"}`)}}
	service := &EntryService{selector: NewActiveChannelSelector(publisher, publisher), snapshots: publisher}

	if _, err := service.ReviveEntry(context.Background(), domain.Target{ScriptName: "w"}, EntryTelegram); err != nil {
		t.Fatalf("ReviveEntry: %v", err)
	}
	if got := publisher.lastChange(t).Vars["ACTIVE_CHANNEL"]; got != EntryTelegram {
		t.Fatalf("ACTIVE_CHANNEL = %q, want %q", got, EntryTelegram)
	}
}
