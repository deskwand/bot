// Package app contains the application-facing entry operations. It keeps
// presentation-free state, never returns bot tokens to the UI, and leaves
// ACTIVE_CHANNEL wiring to the desktop composition root.
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/telegram"
	"github.com/deskwand/bot/desktop/internal/wechat"
)

const (
	// EntryTelegram and EntryWeChat are the only accepted ACTIVE_CHANNEL values.
	EntryTelegram = "telegram"
	EntryWeChat   = "wechat"

	// StatePublished matches deployment.Service.StatePublished. StatePartial
	// means the secrets were published but the Telegram webhook was not
	// registered; retrying finishes the same ordered workflow.
	StatePublished = "published"
	StatePartial   = "partial"
	StateUnchanged = "unchanged"

	webhookSecretBytes = 32
	telegramBotIDKey   = "telegram.bot-id"
)

var (
	// ErrNotWired is returned by the Task 8 stub selector. Task 10 replaces the
	// selector with the service that writes ACTIVE_CHANNEL.
	ErrNotWired = errors.New("app: ACTIVE_CHANNEL is not wired yet")
	// ErrInvalidEntry rejects anything other than telegram or wechat.
	ErrInvalidEntry = errors.New("app: entry must be telegram or wechat")
	// ErrPublisherNotWired means no publication service was supplied.
	ErrPublisherNotWired = errors.New("app: publication service is not wired")
	// ErrInvalidPublicBaseURL means the Worker public URL cannot form a
	// Telegram HTTPS webhook URL.
	ErrInvalidPublicBaseURL = errors.New("app: PUBLIC_BASE_URL must be an https origin")
	// ErrWebhookRegistration means secrets were published but Telegram did not
	// accept the webhook. The published result is returned alongside it.
	ErrWebhookRegistration = errors.New("app: Telegram webhook registration failed")
	// ErrCredentialStore means the generated webhook secret could not be held
	// for a retry. No remote change is attempted in that case.
	ErrCredentialStore = errors.New("app: webhook secret could not be stored for retry")
	// ErrSnapshotReaderNotWired means Telegram setup cannot inspect the current
	// deployment and is therefore blocked before any network call.
	ErrSnapshotReaderNotWired = errors.New("app: snapshot reader is not wired for Telegram")
	// ErrPendingSecretCleanup means the webhook was registered but the local
	// retry copy could not be removed.
	ErrPendingSecretCleanup = errors.New("app: published webhook secret could not be removed from the credential store")
)

// EntryPublisher is the consumer-owned publication interface.
// deployment.Service implements Preview and Apply; a snapshot reader is
// separate because Task 10 composes it from the Cloudflare client.
type EntryPublisher interface {
	Preview(ctx context.Context, target domain.Target, change domain.Change) ([]domain.Step, error)
	Apply(ctx context.Context, target domain.Target, change domain.Change) (domain.Result, error)
}

// SnapshotReader reads the current deployment fingerprint and secret names.
// cloudflare.Client implements this method.
type SnapshotReader interface {
	ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error)
}

// ChannelSelector writes ACTIVE_CHANNEL. The composition root supplies
// NewActiveChannelSelector; NotWiredSelector remains the zero-dependency
// default for tests that only exercise credential publishing.
type ChannelSelector interface {
	SetActiveChannel(ctx context.Context, target domain.Target, channel string) (domain.Result, error)
}

// NotWiredSelector is the explicit not-wired default. It is not a fallback and
// it never writes a different channel than the one the user chose.
type NotWiredSelector struct{}

// SetActiveChannel returns the typed not-wired sentinel.
func (NotWiredSelector) SetActiveChannel(context.Context, domain.Target, string) (domain.Result, error) {
	return domain.Result{}, ErrNotWired
}

// ActiveChannelSelector implements the real ACTIVE_CHANNEL writer. It publishes
// a version whose only change is the ACTIVE_CHANNEL plain-text variable, using
// the same conflict-checked publish path as configuration changes.
type ActiveChannelSelector struct {
	Publisher EntryPublisher
	Snapshots SnapshotReader
}

// NewActiveChannelSelector composes the publish service and snapshot reader.
func NewActiveChannelSelector(publisher EntryPublisher, snapshots SnapshotReader) *ActiveChannelSelector {
	return &ActiveChannelSelector{Publisher: publisher, Snapshots: snapshots}
}

// SetActiveChannel writes ACTIVE_CHANNEL. It never writes any other variable,
// never changes secrets and never selects a different channel on failure.
func (s *ActiveChannelSelector) SetActiveChannel(ctx context.Context, target domain.Target, channel string) (domain.Result, error) {
	normalized := strings.ToLower(strings.TrimSpace(channel))
	if normalized != EntryTelegram && normalized != EntryWeChat {
		return domain.Result{}, ErrInvalidEntry
	}
	if s == nil || s.Publisher == nil {
		return domain.Result{}, ErrPublisherNotWired
	}
	if s.Snapshots == nil {
		return domain.Result{}, ErrSnapshotReaderNotWired
	}
	snapshot, err := s.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}
	if current := ReadPlainVar(snapshot.SettingsJSON, "ACTIVE_CHANNEL"); current == normalized {
		return domain.Result{State: StateUnchanged}, nil
	}
	return s.Publisher.Apply(ctx, target, domain.Change{
		BaseFingerprint: snapshot.Fingerprint,
		Vars:            map[string]string{"ACTIVE_CHANNEL": normalized},
	})
}

// TelegramAPI is the Telegram surface used by ConnectTelegram.
type TelegramAPI interface {
	GetMe(ctx context.Context) (telegram.User, error)
	SetWebhook(ctx context.Context, webhookURL, secretToken string) error
	GetWebhookInfo(ctx context.Context) (telegram.WebhookInfo, error)
}

// EntryOptions constructs an EntryService. Login, Telegram, Random and
// Selector are optional in tests; production supplies the real implementations.
type EntryOptions struct {
	Publisher     EntryPublisher
	Snapshots     SnapshotReader
	Selector      ChannelSelector
	Credentials   platform.CredentialStore
	PublicBaseURL string
	// PublicBaseURLFor overrides PublicBaseURL per deployment. The desktop
	// composition root reads the selected Worker's PUBLIC_BASE_URL so the
	// Telegram webhook URL matches the deployment being configured.
	PublicBaseURLFor func(ctx context.Context, target domain.Target) (string, error)
	Login            func(ctx context.Context, onStatus func(wechat.LoginStatus)) (wechat.Credentials, error)
	Telegram         func(token string) TelegramAPI
	Random           io.Reader
}

// EntryService implements the message-entry operations.
type EntryService struct {
	publisher        EntryPublisher
	snapshots        SnapshotReader
	selector         ChannelSelector
	credentials      platform.CredentialStore
	publicBaseURL    string
	publicBaseURLFor func(ctx context.Context, target domain.Target) (string, error)
	login            func(ctx context.Context, onStatus func(wechat.LoginStatus)) (wechat.Credentials, error)
	telegram         func(token string) TelegramAPI
	random           io.Reader
}

// NewEntryService builds the entry service. Missing optional dependencies get
// their production implementations, except the selector, which stays the
// explicit not-wired stub until the composition root replaces it.
func NewEntryService(options EntryOptions) *EntryService {
	if options.Credentials == nil {
		options.Credentials = platform.NewMemoryCredentialStore()
	}
	if options.Login == nil {
		options.Login = wechat.Login
	}
	if options.Telegram == nil {
		options.Telegram = func(token string) TelegramAPI { return telegram.NewClient(token) }
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	if options.Selector == nil {
		options.Selector = NotWiredSelector{}
	}
	return &EntryService{
		publisher:        options.Publisher,
		snapshots:        options.Snapshots,
		selector:         options.Selector,
		credentials:      options.Credentials,
		publicBaseURL:    strings.TrimRight(options.PublicBaseURL, "/"),
		publicBaseURLFor: options.PublicBaseURLFor,
		login:            options.Login,
		telegram:         options.Telegram,
		random:           options.Random,
	}
}

// TelegramConnectOptions controls webhook secret rotation. The default keeps
// an existing, unreadable secret and does not re-register the webhook.
type TelegramConnectOptions struct {
	RotateWebhookSecret bool
}

// ConnectWeChat runs QR login and publishes WECHAT_CREDENTIALS. It never
// changes ACTIVE_CHANNEL, so saving credentials for the non-selected entry
// does not start polling. Cancellation is checked after login returns to stop
// a late confirmation from being published.
func (s *EntryService) ConnectWeChat(ctx context.Context, target domain.Target) (domain.Result, error) {
	return s.ConnectWeChatWithStatus(ctx, target, nil)
}

// ConnectWeChatWithStatus is ConnectWeChat with a UI status callback. The
// callback receives only LoginStatus, never credentials.
func (s *EntryService) ConnectWeChatWithStatus(ctx context.Context, target domain.Target, onStatus func(wechat.LoginStatus)) (domain.Result, error) {
	if s.publisher == nil {
		return domain.Result{}, ErrPublisherNotWired
	}
	confirmed := false
	loginStatus := func(status wechat.LoginStatus) {
		if status.State == wechat.LoginConfirmed {
			confirmed = true
		}
		if onStatus != nil {
			onStatus(status)
		}
	}
	credentials, err := s.login(ctx, loginStatus)
	if err != nil {
		return domain.Result{}, err
	}
	publishCtx := ctx
	if confirmed {
		// The QR login is complete. Publishing the confirmed credential is an
		// independent operation: a cancel arriving after confirmation must not
		// discard it.
		publishCtx = context.WithoutCancel(ctx)
	} else if err := ctx.Err(); err != nil {
		// No confirmed status was observed, so this is a late response after
		// cancellation. Never publish it.
		return domain.Result{}, err
	}
	if credentials.Token == "" || credentials.BaseURL == "" ||
		credentials.AccountID == "" || credentials.UserID == "" {
		return domain.Result{}, wechat.ErrCredentialsIncomplete
	}
	if !wechat.IsTrustedBaseURL(credentials.BaseURL) {
		return domain.Result{}, wechat.ErrUntrustedBaseURL
	}

	secretJSON, err := credentials.SecretJSON()
	if err != nil {
		return domain.Result{}, errors.New("app: encode WeChat credentials")
	}

	change := domain.Change{
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("WECHAT_CREDENTIALS", domain.SecretReplace, string(secretJSON)),
		},
	}
	if s.snapshots != nil {
		snapshot, err := s.snapshots.ReadSnapshot(publishCtx, target)
		if err != nil {
			return domain.Result{}, redactedError(err, credentials.Token, string(secretJSON))
		}
		change.BaseFingerprint = snapshot.Fingerprint
	}
	result, err := s.publisher.Apply(publishCtx, target, change)
	return result, redactedError(err, credentials.Token, string(secretJSON))
}

// ConnectTelegram validates the token, publishes the bot token and (on first
// enable or explicit rotation) the webhook secret, then registers the webhook
// only after the publication result is published.
func (s *EntryService) ConnectTelegram(ctx context.Context, target domain.Target, botToken string) (domain.Result, error) {
	return s.ConnectTelegramWithOptions(ctx, target, botToken, TelegramConnectOptions{})
}

// ConnectTelegramWithOptions is ConnectTelegram with explicit rotation.
func (s *EntryService) ConnectTelegramWithOptions(ctx context.Context, target domain.Target, botToken string, options TelegramConnectOptions) (domain.Result, error) {
	if s.publisher == nil {
		return domain.Result{}, ErrPublisherNotWired
	}
	if s.snapshots == nil {
		return domain.Result{}, ErrSnapshotReaderNotWired
	}
	if botToken == "" {
		return domain.Result{}, telegram.ErrInvalidToken
	}
	webhookURL, err := s.webhookURLFor(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}

	client := s.telegram(botToken)
	me, err := client.GetMe(ctx)
	if err != nil {
		return domain.Result{}, redactedError(err, botToken)
	}
	if err := ctx.Err(); err != nil {
		return domain.Result{}, err
	}

	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Result{}, redactedError(err, botToken)
	}
	hasSecret := containsString(snapshot.SecretNames, "TELEGRAM_WEBHOOK_SECRET")

	pendingKey := telegramWebhookPendingKey(target)
	pending, err := s.pendingWebhookSecret(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}
	havePending := pending != ""

	botID := strconv.FormatInt(me.ID, 10)
	storedBotID, err := s.credentials.Get(ctx, telegramBotIDKey)
	if err != nil && !errors.Is(err, platform.ErrCredentialNotFound) {
		return domain.Result{}, fmt.Errorf("%w: %v", ErrCredentialStore, platformSafeError(err))
	}
	botChanged := storedBotID != "" && storedBotID != botID

	registerWebhook := havePending
	secretForPublish := ""
	if havePending {
		// A retry continues the same operation with the same secret. It never
		// generates a replacement just because rotation was requested again.
		secretForPublish = pending
		registerWebhook = true
	} else if options.RotateWebhookSecret || botChanged || !hasSecret {
		generated, err := s.generateWebhookSecret()
		if err != nil {
			return domain.Result{}, err
		}
		if err := s.credentials.Set(ctx, pendingKey, generated); err != nil {
			return domain.Result{}, fmt.Errorf("%w: %v", ErrCredentialStore, platformSafeError(err))
		}
		pending = generated
		secretForPublish = generated
		registerWebhook = true
	}
	// Otherwise an existing unreadable secret is retained untouched until the
	// webhook inspection below proves that rotation is required.

	result, err := s.publishTelegram(ctx, target, botToken, secretForPublish)
	if err != nil {
		return result, redactedError(err, botToken, pending)
	}
	if result.State != StatePublished {
		// Publish failure, cancellation or unknown state: never register the
		// webhook. Keep the pending secret so a retry reuses it.
		return result, nil
	}
	// The token is published; record the non-secret bot id so a later entry
	// with a different bot automatically rotates its webhook secret.
	_ = s.credentials.Set(ctx, telegramBotIDKey, botID)

	info, infoErr := client.GetWebhookInfo(ctx)
	if infoErr != nil && !registerWebhook {
		result.State = StatePartial
		return result, redactedError(infoErr, botToken, pending)
	}
	if infoErr == nil && !registerWebhook && info.URL != webhookURL {
		// The retained secret belongs to a different webhook URL. Rotate it
		// now and publish the token plus the new secret together.
		generated, err := s.generateWebhookSecret()
		if err != nil {
			return result, err
		}
		if err := s.credentials.Set(ctx, pendingKey, generated); err != nil {
			return result, fmt.Errorf("%w: %v", ErrCredentialStore, platformSafeError(err))
		}
		pending = generated
		result, err = s.publishTelegram(ctx, target, botToken, pending)
		if err != nil {
			return result, redactedError(err, botToken, pending)
		}
		if result.State != StatePublished {
			return result, nil
		}
		_ = s.credentials.Set(ctx, telegramBotIDKey, botID)
		registerWebhook = true
	}
	if !registerWebhook {
		return result, nil
	}

	if err := client.SetWebhook(ctx, webhookURL, pending); err != nil {
		result.State = StatePartial
		return result, fmt.Errorf("%w: %w", ErrWebhookRegistration, redactedError(err, botToken, pending))
	}

	// The webhook now uses this secret. Clearing the local retry copy means a
	// later non-rotating connect keeps the remote secret and does not
	// re-register the webhook. Surface cleanup failure because the next connect
	// would otherwise register the webhook again.
	if err := s.credentials.Delete(ctx, pendingKey); err != nil {
		return result, fmt.Errorf("%w: %v", ErrPendingSecretCleanup, platformSafeError(err))
	}
	return result, nil
}

func (s *EntryService) publishTelegram(ctx context.Context, target domain.Target, botToken, webhookSecret string) (domain.Result, error) {
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}
	secretEdits := []domain.SecretEdit{
		domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, botToken),
	}
	if webhookSecret != "" {
		secretEdits = append(secretEdits,
			domain.NewSecretEdit("TELEGRAM_WEBHOOK_SECRET", domain.SecretReplace, webhookSecret))
	}
	return s.publisher.Apply(ctx, target, domain.Change{
		BaseFingerprint: snapshot.Fingerprint,
		Secrets:         secretEdits,
	})
}

func (s *EntryService) pendingWebhookSecret(ctx context.Context, target domain.Target) (string, error) {
	value, err := s.credentials.Get(ctx, telegramWebhookPendingKey(target))
	if errors.Is(err, platform.ErrCredentialNotFound) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrCredentialStore, platformSafeError(err))
	}
	return value, nil
}

// EntrySelection reports a channel choice and whether it currently has
// credentials. A warning never blocks the explicit choice and never causes an
// automatic fallback to the other entry. domain.Result is embedded so callers
// can read State/OperationID directly.
type EntrySelection struct {
	domain.Result
	Channel    string
	Configured bool
	Warning    string
}

// SelectEntry validates the requested channel and writes ACTIVE_CHANNEL
// through the selector. Choosing an unconfigured channel is allowed with a
// warning; expiry or missing credentials never selects the other channel.
func (s *EntryService) SelectEntry(ctx context.Context, target domain.Target, channel string) (EntrySelection, error) {
	normalized := strings.ToLower(strings.TrimSpace(channel))
	if normalized != EntryTelegram && normalized != EntryWeChat {
		return EntrySelection{}, ErrInvalidEntry
	}

	configured := false
	if s.snapshots != nil {
		snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
		if err != nil {
			return EntrySelection{}, err
		}
		switch normalized {
		case EntryTelegram:
			configured = containsString(snapshot.SecretNames, "TELEGRAM_BOT_TOKEN")
		case EntryWeChat:
			configured = containsString(snapshot.SecretNames, "WECHAT_CREDENTIALS")
		}
	}

	selection := EntrySelection{Channel: normalized, Configured: configured}
	if !configured {
		selection.Warning = "所选入口尚未配置；选择已保存，但不会自动改用另一个入口。"
	}
	result, err := s.selector.SetActiveChannel(ctx, target, normalized)
	if err != nil {
		return selection, err
	}
	selection.Result = result
	return selection, nil
}

// SetActiveChannel validates the entry name and delegates the ACTIVE_CHANNEL
// write to the composed selector. In Task 8 the default selector deliberately
// returns ErrNotWired.
func (s *EntryService) SetActiveChannel(ctx context.Context, target domain.Target, channel string) (domain.Result, error) {
	normalized := strings.ToLower(strings.TrimSpace(channel))
	if normalized != EntryTelegram && normalized != EntryWeChat {
		return domain.Result{}, ErrInvalidEntry
	}
	return s.selector.SetActiveChannel(ctx, target, normalized)
}

func (s *EntryService) generateWebhookSecret() (string, error) {
	bytes := make([]byte, webhookSecretBytes)
	if _, err := io.ReadFull(s.random, bytes); err != nil {
		return "", errors.New("app: generate webhook secret")
	}
	return hex.EncodeToString(bytes), nil
}

func (s *EntryService) webhookURLFor(ctx context.Context, target domain.Target) (string, error) {
	base := s.publicBaseURL
	if s.publicBaseURLFor != nil {
		resolved, err := s.publicBaseURLFor(ctx, target)
		if err != nil {
			return "", err
		}
		base = resolved
	}
	return webhookURL(base)
}

func webhookURL(base string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return "", ErrInvalidPublicBaseURL
	}
	return strings.TrimRight(base, "/") + "/telegram/webhook", nil
}

func telegramWebhookPendingKey(target domain.Target) string {
	return "telegram-webhook-pending/" + target.AccountID + "/" + target.ScriptName
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func platformSafeError(err error) error {
	// Credential-store errors are already documented as never containing a
	// value. Keep a stable message anyway so a test double cannot leak one.
	return errors.New("credential store unavailable")
}

// redactError keeps errors.Is/As working while removing known secret values
// from any text a test double or transport might have included.
type redactError struct {
	err          error
	replacements []string
}

func (e redactError) Error() string {
	message := e.err.Error()
	for _, value := range e.replacements {
		if value != "" {
			message = strings.ReplaceAll(message, value, wechat.RedactedToken)
		}
	}
	return message
}

func (e redactError) Unwrap() error { return e.err }

func redactedError(err error, replacements ...string) error {
	if err == nil {
		return nil
	}
	return redactError{err: err, replacements: replacements}
}
