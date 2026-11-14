// Package app contains the application-facing entry operations. It keeps
// presentation-free state, never returns bot tokens to the UI, and leaves
// ACTIVE_CHANNEL wiring to the desktop composition root.
package app

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/telegram"
	"github.com/deskwand/bot/desktop/internal/wechat"
)

const (
	// EntryTelegram and EntryWeChat are the only entries the UI can select.
	// EntryDisabled is reserved for the move flow.
	EntryTelegram = "telegram"
	EntryWeChat   = "wechat"
	// EntryDisabled is written by a move to silence the old residence. The
	// Worker treats any value outside the two entries as disabled
	// (src/channels/route-identity.ts), so no Worker change is needed.
	EntryDisabled = "none"

	// StatePublished matches deployment.Service.StatePublished.
	StatePublished = "published"
	StateUnchanged = "unchanged"
)

var (
	// ErrNotWired is returned by the Task 8 stub selector. Task 10 replaces the
	// selector with the service that writes ACTIVE_CHANNEL.
	ErrNotWired = errors.New("app: ACTIVE_CHANNEL is not wired yet")
	// ErrInvalidEntry rejects anything other than telegram or wechat.
	ErrInvalidEntry = errors.New("app: entry must be telegram or wechat")
	// ErrPublisherNotWired means no publication service was supplied.
	ErrPublisherNotWired = errors.New("app: publication service is not wired")
	// ErrSnapshotReaderNotWired means Telegram setup cannot inspect the current
	// deployment and is therefore blocked before any network call.
	ErrSnapshotReaderNotWired = errors.New("app: snapshot reader is not wired for Telegram")
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
	if normalized != EntryTelegram && normalized != EntryWeChat && normalized != EntryDisabled {
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
	DeleteWebhook(ctx context.Context) error
}

// EntryOptions constructs an EntryService. Login, Telegram and Selector are
// optional in tests; production supplies the real implementations.
type EntryOptions struct {
	Publisher   EntryPublisher
	Snapshots   SnapshotReader
	Selector    ChannelSelector
	Credentials platform.CredentialStore
	Login       func(ctx context.Context, onStatus func(wechat.LoginStatus)) (wechat.Credentials, error)
	Telegram    func(token string) TelegramAPI
	// Locale supplies the warning language; nil means zh.
	Locale func() string
}

// EntryService implements the message-entry operations.
type EntryService struct {
	publisher   EntryPublisher
	snapshots   SnapshotReader
	selector    ChannelSelector
	credentials platform.CredentialStore
	login       func(ctx context.Context, onStatus func(wechat.LoginStatus)) (wechat.Credentials, error)
	telegram    func(token string) TelegramAPI
	locale      func() string
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
	if options.Selector == nil {
		options.Selector = NotWiredSelector{}
	}
	return &EntryService{
		publisher:   options.Publisher,
		snapshots:   options.Snapshots,
		selector:    options.Selector,
		credentials: options.Credentials,
		login:       options.Login,
		telegram:    options.Telegram,
		locale:      options.Locale,
	}
}

func (s *EntryService) lang() string {
	if s.locale == nil {
		return i18n.ZH
	}
	return s.locale()
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
		status.Message = i18n.T(s.lang(), "wechat."+status.Phase)
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

// ConnectTelegram validates the token, publishes only the bot token, then
// asks Telegram to remove any registered webhook. The Worker polls with
// getUpdates; a stale webhook would make the first poll return 409, so removing
// it here lets a fresh desktop setup start receiving messages immediately.
func (s *EntryService) ConnectTelegram(ctx context.Context, target domain.Target, botToken string) (domain.Result, error) {
	if s.publisher == nil {
		return domain.Result{}, ErrPublisherNotWired
	}
	if s.snapshots == nil {
		return domain.Result{}, ErrSnapshotReaderNotWired
	}
	if botToken == "" {
		return domain.Result{}, telegram.ErrInvalidToken
	}

	client := s.telegram(botToken)
	if _, err := client.GetMe(ctx); err != nil {
		return domain.Result{}, redactedError(err, botToken)
	}
	if err := ctx.Err(); err != nil {
		return domain.Result{}, err
	}

	result, err := s.publishTelegram(ctx, target, botToken)
	if err != nil {
		return result, redactedError(err, botToken)
	}
	if result.State != StatePublished {
		return result, nil
	}

	// Best effort: the Worker deletes a conflicting webhook itself and keeps
	// polling, so a failure here must not fail the connection.
	if err := client.DeleteWebhook(ctx); err != nil {
		slog.Warn("app: delete Telegram webhook", "error", redactedError(err, botToken))
	}
	return result, nil
}

func (s *EntryService) publishTelegram(ctx context.Context, target domain.Target, botToken string) (domain.Result, error) {
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}
	return s.publisher.Apply(ctx, target, domain.Change{
		BaseFingerprint: snapshot.Fingerprint,
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit("TELEGRAM_BOT_TOKEN", domain.SecretReplace, botToken),
		},
	})
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

// MuteEntry silences the deployment's entry without touching credentials. It
// is the move flow's own path; SelectEntry keeps rejecting EntryDisabled.
func (s *EntryService) MuteEntry(ctx context.Context, target domain.Target) (domain.Result, error) {
	if s == nil || s.selector == nil {
		return domain.Result{}, ErrNotWired
	}
	return s.selector.SetActiveChannel(ctx, target, EntryDisabled)
}

// ReviveEntry puts the recorded entry back after a move was abandoned.
func (s *EntryService) ReviveEntry(ctx context.Context, target domain.Target, channel string) (domain.Result, error) {
	selection, err := s.SelectEntry(ctx, target, channel)
	if err != nil {
		return domain.Result{}, err
	}
	return selection.Result, nil
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
		selection.Warning = i18n.T(s.lang(), "app.entryNotConfigured")
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

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
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
