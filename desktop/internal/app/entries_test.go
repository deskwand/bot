package app

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
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

type webhookCall struct {
	url    string
	secret string
}

type fakeTelegram struct {
	mu sync.Mutex

	userID         int64
	getMeErr       error
	setWebhookErr  error
	setWebhookHook func()
	webhookInfoURL string
	webhookInfoErr error
	calls          []string
	webhooks       []webhookCall
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

func (f *fakeTelegram) SetWebhook(ctx context.Context, webhookURL, secretToken string) error {
	f.mu.Lock()
	f.calls = append(f.calls, "setWebhook")
	hook := f.setWebhookHook
	err := f.setWebhookErr
	f.mu.Unlock()

	if hook != nil {
		hook()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.webhooks = append(f.webhooks, webhookCall{url: webhookURL, secret: secretToken})
	f.mu.Unlock()
	return nil
}

func (f *fakeTelegram) GetWebhookInfo(context.Context) (telegram.WebhookInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "getWebhookInfo")
	if f.webhookInfoErr != nil {
		return telegram.WebhookInfo{}, f.webhookInfoErr
	}
	url := f.webhookInfoURL
	if url == "" {
		url = "https://bot.example/telegram/webhook"
	}
	return telegram.WebhookInfo{URL: url}, nil
}

func newTestService(publisher *fakePublisher, selector *fakeSelector, credentials platform.CredentialStore, login func(context.Context, func(wechat.LoginStatus)) (wechat.Credentials, error), telegramClient *fakeTelegram) *EntryService {
	return NewEntryService(EntryOptions{
		Publisher:     publisher,
		Snapshots:     publisher,
		Selector:      selector,
		Credentials:   credentials,
		PublicBaseURL: "https://bot.example/",
		Login:         login,
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

func TestConnectTelegramFirstEnableGeneratesAndVerifiesWebhook(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1", VersionID: "v1"}}
	store := platform.NewMemoryCredentialStore()
	client := &fakeTelegram{}
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	result, err := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if err != nil {
		t.Fatalf("ConnectTelegram: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}

	change := publisher.lastChange(t)
	values := secretValues(change.Secrets)
	if values["TELEGRAM_BOT_TOKEN"] != telegramTokenSentinel {
		t.Fatalf("bot token edit = %q", values["TELEGRAM_BOT_TOKEN"])
	}
	webhookSecret := values["TELEGRAM_WEBHOOK_SECRET"]
	if len(webhookSecret) != 64 {
		t.Fatalf("webhook secret length = %d, want 64 hex chars", len(webhookSecret))
	}
	if _, err := hex.DecodeString(webhookSecret); err != nil {
		t.Fatalf("webhook secret is not hex: %v", err)
	}
	if len(client.webhooks) != 1 {
		t.Fatalf("setWebhook calls = %#v", client.webhooks)
	}
	if client.webhooks[0].url != "https://bot.example/telegram/webhook" {
		t.Fatalf("webhook URL = %q", client.webhooks[0].url)
	}
	if client.webhooks[0].secret != webhookSecret {
		t.Fatal("setWebhook did not use the published secret")
	}
	if len(client.calls) < 2 || client.calls[0] != "getMe" {
		t.Fatalf("call order = %v, want getMe before publish", client.calls)
	}
	if _, err := store.Get(context.Background(), telegramWebhookPendingKey(target)); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("pending secret still stored after success: %v", err)
	}
	for _, output := range []string{fmt.Sprint(result), fmt.Sprint(change)} {
		if strings.Contains(output, telegramTokenSentinel) || strings.Contains(output, webhookSecret) {
			t.Fatalf("output leaked a secret: %s", output)
		}
	}
}

func TestConnectTelegramPublishFailureDoesNotSetWebhook(t *testing.T) {
	publisher := &fakePublisher{
		snapshot:   domain.Snapshot{Fingerprint: "fp-1"},
		applyState: "failed",
		applyErr:   errors.New("publish failed"),
	}
	client := &fakeTelegram{}
	store := platform.NewMemoryCredentialStore()
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	result, err := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if err == nil || result.State != "failed" {
		t.Fatalf("ConnectTelegram result=%#v err=%v", result, err)
	}
	if len(client.webhooks) != 0 {
		t.Fatal("setWebhook was called after a publish failure")
	}
	if _, err := store.Get(context.Background(), telegramWebhookPendingKey(target)); err != nil {
		t.Fatalf("retry secret was not retained after publish failure: %v", err)
	}
	if strings.Contains(err.Error(), telegramTokenSentinel) {
		t.Fatalf("publish error leaked token: %v", err)
	}
}

func TestConnectTelegramWebhookFailureReportsPartialState(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{setWebhookErr: errors.New("Telegram unavailable")}
	store := platform.NewMemoryCredentialStore()
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	result, err := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if !errors.Is(err, ErrWebhookRegistration) {
		t.Fatalf("ConnectTelegram error = %v, want ErrWebhookRegistration", err)
	}
	if result.State != StatePartial {
		t.Fatalf("state = %q, want %q", result.State, StatePartial)
	}
	webhookSecret := secretValues(publisher.lastChange(t).Secrets)["TELEGRAM_WEBHOOK_SECRET"]
	if webhookSecret == "" {
		t.Fatal("webhook secret was not published")
	}
	if _, err := store.Get(context.Background(), telegramWebhookPendingKey(target)); err != nil {
		t.Fatalf("retry secret was not retained: %v", err)
	}
	if strings.Contains(err.Error(), telegramTokenSentinel) || strings.Contains(err.Error(), webhookSecret) {
		t.Fatalf("error leaked a secret: %v", err)
	}
}

func TestConnectTelegramRetryReusesSecret(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{setWebhookErr: errors.New("first webhook attempt failed")}
	store := platform.NewMemoryCredentialStore()
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	firstResult, firstErr := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if !errors.Is(firstErr, ErrWebhookRegistration) || firstResult.State != StatePartial {
		t.Fatalf("first attempt result=%#v err=%v", firstResult, firstErr)
	}
	firstSecret := secretValues(publisher.lastChange(t).Secrets)["TELEGRAM_WEBHOOK_SECRET"]

	client.mu.Lock()
	client.setWebhookErr = nil
	client.mu.Unlock()
	secondResult, secondErr := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if secondErr != nil {
		t.Fatalf("second ConnectTelegram: %v", secondErr)
	}
	if secondResult.State != StatePublished {
		t.Fatalf("second result = %#v", secondResult)
	}
	secondSecret := secretValues(publisher.lastChange(t).Secrets)["TELEGRAM_WEBHOOK_SECRET"]
	if secondSecret != firstSecret {
		t.Fatal("retry generated a different webhook secret")
	}
	if len(client.webhooks) != 1 || client.webhooks[0].secret != firstSecret {
		t.Fatalf("retry webhook calls = %#v", client.webhooks)
	}
	if _, err := store.Get(context.Background(), telegramWebhookPendingKey(target)); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("pending secret not cleared after retry success: %v", err)
	}
}

func TestConnectTelegramRetainsExistingSecretWithoutRotate(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{
		Fingerprint: "fp-1",
		SecretNames: []string{"TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"},
	}}
	client := &fakeTelegram{}
	store := platform.NewMemoryCredentialStore()
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	result, err := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if err != nil {
		t.Fatalf("ConnectTelegram: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	change := publisher.lastChange(t)
	if len(change.Secrets) != 1 || change.Secrets[0].Name != "TELEGRAM_BOT_TOKEN" {
		t.Fatalf("secret edits = %#v, want only the bot token", change.Secrets)
	}
	if len(client.webhooks) != 0 {
		t.Fatal("existing unreadable webhook secret was re-registered without rotation")
	}
	if _, err := store.Get(context.Background(), telegramWebhookPendingKey(target)); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("unexpected pending secret: %v", err)
	}
}

func TestConnectTelegramRotateReplacesSecret(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{
		Fingerprint: "fp-1",
		SecretNames: []string{"TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"},
	}}
	client := &fakeTelegram{}
	service := newTestService(publisher, &fakeSelector{}, platform.NewMemoryCredentialStore(), nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	result, err := service.ConnectTelegramWithOptions(context.Background(), target, telegramTokenSentinel, TelegramConnectOptions{
		RotateWebhookSecret: true,
	})
	if err != nil {
		t.Fatalf("ConnectTelegramWithOptions: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	values := secretValues(publisher.lastChange(t).Secrets)
	if values["TELEGRAM_WEBHOOK_SECRET"] == "" {
		t.Fatal("rotation did not replace the webhook secret")
	}
	if len(client.webhooks) != 1 || client.webhooks[0].secret != values["TELEGRAM_WEBHOOK_SECRET"] {
		t.Fatalf("rotation webhook calls = %#v", client.webhooks)
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

func TestConnectTelegramInvalidPublicBaseURLDoesNotCallNetworkOrPublish(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{}
	service := NewEntryService(EntryOptions{
		Publisher:     publisher,
		Snapshots:     publisher,
		Selector:      &fakeSelector{},
		Credentials:   platform.NewMemoryCredentialStore(),
		PublicBaseURL: "http://bot.example",
		Telegram:      func(string) TelegramAPI { return client },
	})

	result, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel)
	if !errors.Is(err, ErrInvalidPublicBaseURL) {
		t.Fatalf("ConnectTelegram error = %v, want ErrInvalidPublicBaseURL", err)
	}
	if result != (domain.Result{}) {
		t.Fatalf("result = %#v, want zero result", result)
	}
	if publisher.callCount() != 0 {
		t.Fatal("invalid PUBLIC_BASE_URL still published secrets")
	}
	if len(client.calls) != 0 {
		t.Fatalf("invalid PUBLIC_BASE_URL called Telegram: %v", client.calls)
	}
}

func TestConnectTelegramExistingSecretChecksWebhookInfo(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{
		Fingerprint: "fp-1",
		SecretNames: []string{"TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"},
	}}
	client := &fakeTelegram{}
	service := newTestService(publisher, &fakeSelector{}, platform.NewMemoryCredentialStore(), nil, client)

	if _, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel); err != nil {
		t.Fatalf("ConnectTelegram: %v", err)
	}
	found := false
	for _, call := range client.calls {
		if call == "getWebhookInfo" {
			found = true
		}
	}
	if !found {
		t.Fatalf("GetWebhookInfo was not called: %v", client.calls)
	}
}

func TestConnectTelegramChangedBotRotatesExistingSecret(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{
		Fingerprint: "fp-1",
		SecretNames: []string{"TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"},
	}}
	client := &fakeTelegram{}
	store := platform.NewMemoryCredentialStore()
	target := domain.Target{AccountID: "a", ScriptName: "bot"}
	if err := store.Set(context.Background(), telegramBotIDKey, "999"); err != nil {
		t.Fatalf("seed bot id: %v", err)
	}
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)

	result, err := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if err != nil {
		t.Fatalf("ConnectTelegram: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	change := publisher.lastChange(t)
	values := secretValues(change.Secrets)
	if values["TELEGRAM_WEBHOOK_SECRET"] == "" {
		t.Fatal("changed bot did not rotate the webhook secret")
	}
	if len(client.webhooks) != 1 || client.webhooks[0].secret != values["TELEGRAM_WEBHOOK_SECRET"] {
		t.Fatalf("webhook calls = %#v", client.webhooks)
	}
	stored, err := store.Get(context.Background(), telegramBotIDKey)
	if err != nil || stored != "1" {
		t.Fatalf("stored bot id = %q, err=%v", stored, err)
	}
}

func TestConnectTelegramChangedWebhookURLRotatesThroughWebhookInfo(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{
		Fingerprint: "fp-1",
		SecretNames: []string{"TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"},
	}}
	client := &fakeTelegram{webhookInfoURL: "https://old.example/telegram/webhook"}
	store := platform.NewMemoryCredentialStore()
	target := domain.Target{AccountID: "a", ScriptName: "bot"}
	if err := store.Set(context.Background(), telegramBotIDKey, "1"); err != nil {
		t.Fatalf("seed bot id: %v", err)
	}
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)

	result, err := service.ConnectTelegram(context.Background(), target, telegramTokenSentinel)
	if err != nil {
		t.Fatalf("ConnectTelegram: %v", err)
	}
	if result.State != StatePublished {
		t.Fatalf("result = %#v", result)
	}
	if publisher.callCount() != 2 {
		t.Fatalf("Apply calls = %d, want token-only then rotated secret", publisher.callCount())
	}
	values := secretValues(publisher.lastChange(t).Secrets)
	if values["TELEGRAM_WEBHOOK_SECRET"] == "" {
		t.Fatal("webhook URL change did not rotate the secret")
	}
	if len(client.webhooks) != 1 || client.webhooks[0].url != "https://bot.example/telegram/webhook" {
		t.Fatalf("webhook calls = %#v", client.webhooks)
	}
	if len(client.webhooks) != 0 && client.webhooks[0].secret != values["TELEGRAM_WEBHOOK_SECRET"] {
		t.Fatal("rotated webhook did not use the published secret")
	}
}

func TestConnectTelegramWithoutSnapshotsIsBlocked(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{}
	service := NewEntryService(EntryOptions{
		Publisher:     publisher,
		Selector:      &fakeSelector{},
		Credentials:   platform.NewMemoryCredentialStore(),
		PublicBaseURL: "https://bot.example",
		Telegram:      func(string) TelegramAPI { return client },
	})

	_, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel)
	if !errors.Is(err, ErrSnapshotReaderNotWired) {
		t.Fatalf("ConnectTelegram error = %v, want ErrSnapshotReaderNotWired", err)
	}
	if publisher.callCount() != 0 || len(client.calls) != 0 {
		t.Fatal("missing snapshot reader still performed work")
	}
}

func TestConnectTelegramCancelDuringSetWebhookIsPartial(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	ctx, cancel := context.WithCancel(context.Background())
	client := &fakeTelegram{setWebhookHook: cancel}
	store := platform.NewMemoryCredentialStore()
	service := newTestService(publisher, &fakeSelector{}, store, nil, client)
	target := domain.Target{AccountID: "a", ScriptName: "bot"}

	result, err := service.ConnectTelegram(ctx, target, telegramTokenSentinel)
	if !errors.Is(err, ErrWebhookRegistration) {
		t.Fatalf("ConnectTelegram error = %v, want ErrWebhookRegistration", err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ConnectTelegram error = %v, want context.Canceled", err)
	}
	if result.State != StatePartial {
		t.Fatalf("state = %q, want %q", result.State, StatePartial)
	}
	if _, err := store.Get(context.Background(), telegramWebhookPendingKey(target)); err != nil {
		t.Fatalf("retry secret was not retained: %v", err)
	}
}

type deleteFailStore struct {
	platform.CredentialStore
}

func (deleteFailStore) Delete(context.Context, string) error {
	return errors.New("delete failed")
}

func TestConnectTelegramPendingSecretDeleteFailureIsReported(t *testing.T) {
	publisher := &fakePublisher{snapshot: domain.Snapshot{Fingerprint: "fp-1"}}
	client := &fakeTelegram{}
	service := newTestService(publisher, &fakeSelector{}, deleteFailStore{
		CredentialStore: platform.NewMemoryCredentialStore(),
	}, nil, client)

	result, err := service.ConnectTelegram(context.Background(), domain.Target{AccountID: "a", ScriptName: "bot"}, telegramTokenSentinel)
	if !errors.Is(err, ErrPendingSecretCleanup) {
		t.Fatalf("ConnectTelegram error = %v, want ErrPendingSecretCleanup", err)
	}
	if result.State != StatePublished {
		t.Fatalf("state = %q, want published", result.State)
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

func secretValues(edits []domain.SecretEdit) map[string]string {
	values := make(map[string]string, len(edits))
	for _, edit := range edits {
		values[edit.Name] = edit.Value()
	}
	return values
}
