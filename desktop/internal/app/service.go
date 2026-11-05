package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/diagnostics"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/modelcatalog"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
	"github.com/deskwand/bot/desktop/internal/telemetry"
	"github.com/deskwand/bot/desktop/internal/wechat"
)

// Stable error codes returned to the frontend in domain.Error.Code. Messages
// are display-safe and never contain a token or secret value.
const (
	CodeTargetNotSelected  = "TARGET_NOT_SELECTED"
	CodeAccountMismatch    = "TARGET_ACCOUNT_MISMATCH"
	CodeTargetMismatch     = "TARGET_MISMATCH"
	CodeAuthRequired       = "AUTH_REQUIRED"
	CodeServiceUnavailable = "SERVICE_UNAVAILABLE"
	CodeReleaseNotBundled  = "RELEASE_NOT_BUNDLED"
	CodeReleaseUntrusted   = "RELEASE_UNTRUSTED"
	CodeReleaseUnavailable = "RELEASE_UNAVAILABLE"
	CodeLoginNotFound      = "LOGIN_NOT_FOUND"
	CodeLoginInProgress    = "LOGIN_IN_PROGRESS"

	CodeCloudflareLoginInProgress = "CLOUDFLARE_LOGIN_IN_PROGRESS"
	CodeCloudflareLoginNotFound   = "CLOUDFLARE_LOGIN_NOT_FOUND"
	CodeInvalidEntryChannel       = "INVALID_ENTRY_CHANNEL"
	// CodeThemeSaveFailed reports a preference write the disk refused. The
	// message stays generic: the store's error names a home directory path.
	CodeThemeSaveFailed = "THEME_SAVE_FAILED"
	// CodeTelemetrySaveFailed reports a telemetry preference the disk refused.
	CodeTelemetrySaveFailed = "TELEMETRY_SAVE_FAILED"
	// CodeLocaleSaveFailed reports a language preference the disk refused. The
	// language still switches for this run; only the save failed.
	CodeLocaleSaveFailed = "LOCALE_SAVE_FAILED"
)

// legacyModelSecretNames are the pre-MODEL_KEY_* names. A publish clears any
// that are still deployed, because the Worker no longer reads them.
var legacyModelSecretNames = []string{"ANTHROPIC_API_KEY", "OPENCODE_API_KEY"}

// LoginStatusEvent carries sanitized QR login progress to the frontend.
// `mygo generate` turns it into `events.loginStatus`.
var LoginStatusEvent = mygo.NewEvent[LoginStatusDTO]("login-status")

// CloudflareLoginEvent carries sanitized OAuth login progress to the frontend.
// `mygo generate` turns it into `events.cloudflareLogin`.
var CloudflareLoginEvent = mygo.NewEvent[CloudflareLoginDTO]("cloudflare-login")

// AuthService is the consumer-owned subset of *auth.TokenService.
type AuthService interface {
	Status(ctx context.Context) (auth.Connection, error)
	Disconnect(ctx context.Context) error
	BeginLogin(ctx context.Context) (auth.LoginSession, error)
}

// PublishService is the configuration publish state machine.
type PublishService interface {
	Preview(ctx context.Context, target domain.Target, change domain.Change) ([]domain.Step, error)
	Apply(ctx context.Context, target domain.Target, change domain.Change) (domain.Result, error)
	Resume(ctx context.Context, operationID string) (domain.Result, error)
	Abandon(ctx context.Context, operationID string) (domain.Result, error)
}

// LifecycleService is install, import and upgrade.
type LifecycleService interface {
	Install(ctx context.Context, request deployment.InstallRequest) (domain.Result, error)
	InspectImport(ctx context.Context, target domain.Target) (deployment.ImportPreview, error)
	ConfirmImport(ctx context.Context, target domain.Target, confirmation deployment.ImportConfirmation) (domain.Result, error)
	Upgrade(ctx context.Context, target domain.Target, pkg release.Package) (domain.Result, error)
	Abandon(ctx context.Context, operationID string) (domain.Result, error)
}

// EntriesService is WeChat login and Telegram / ACTIVE_CHANNEL configuration.
type EntriesService interface {
	ConnectWeChatWithStatus(ctx context.Context, target domain.Target, onStatus func(wechat.LoginStatus)) (domain.Result, error)
	ConnectTelegram(ctx context.Context, target domain.Target, botToken string) (domain.Result, error)
	SelectEntry(ctx context.Context, target domain.Target, channel string) (EntrySelection, error)
}

// StatusService is the evidence-based diagnostics surface.
type StatusService interface {
	Status(ctx context.Context, target domain.Target) (DiagnosticsReport, error)
	ExportDiagnostics(ctx context.Context, target domain.Target) ([]byte, error)
}

// ScriptLister lists Worker scripts in the connected account.
type ScriptLister interface {
	ListScripts(ctx context.Context, accountID string) ([]cloudflare.ScriptSummary, error)
}

// OperationJournal reads journaled operations for the resume view.
type OperationJournal interface {
	Load(operationID string) (deployment.OperationRecord, error)
	List() ([]deployment.OperationRecord, error)
	Save(record deployment.OperationRecord) error
}

// TargetStore persists the non-secret managed deployment target.
type TargetStore interface {
	Load() (domain.Target, bool, error)
	Save(target domain.Target) error
}

// ReleaseSource supplies the verified embedded Worker release. Package returns
// release.ErrNotBundled or release.ErrUntrusted when the build carries none.
type ReleaseSource interface {
	Package() (release.Package, error)
	Version() string
	Manifest() release.Manifest
}

// EmbeddedRelease is the production ReleaseSource for an embedded bundle.
type EmbeddedRelease struct {
	Pkg release.Package
	Err error
}

// Package returns the verified package or the loader's stable error.
func (r EmbeddedRelease) Package() (release.Package, error) { return r.Pkg, r.Err }

// Version returns the embedded release version, or "" when unavailable.
func (r EmbeddedRelease) Version() string { return r.Pkg.Version() }

// Manifest returns the embedded release manifest, or its zero value.
func (r EmbeddedRelease) Manifest() release.Manifest { return r.Pkg.Manifest() }

// ServiceOptions composes the application service. The production composition
// root supplies every dependency; tests substitute small fakes.
type ServiceOptions struct {
	Auth        AuthService
	Publish     PublishService
	Lifecycle   LifecycleService
	Entries     EntriesService
	Diagnostics StatusService
	Snapshots   SnapshotReader
	Scripts     ScriptLister
	Journal     OperationJournal
	Store       TargetStore
	Browser     platform.BrowserOpener
	// McpBrowser opens provider consent pages. It defaults to Browser.
	McpBrowser  platform.BrowserOpener
	Credentials platform.CredentialStore
	Release     ReleaseSource
	Backup      BackupService
	FileDialogs FileDialogs
	// BackupSettings is the persisted backup folder and schedule. Nil makes
	// every backup-folder operation report SERVICE_UNAVAILABLE.
	BackupSettings BackupSettingsStore
	// OpenPath reveals a local folder in the file manager. It defaults to
	// mygo.Shell.OpenPath.
	OpenPath func(path string) error
	// CheckClientUpdates opens the MyGo updater window. It defaults to
	// updater.CheckForUpdates.
	CheckClientUpdates func()
	// Theme is the persisted appearance choice; nil makes SetTheme
	// appearance-only for this run.
	Theme ThemeStore
	// Locale is the language choice shared with publishing; nil follows the
	// system and keeps this run's choice in memory.
	Locale *LocaleState
	// Telemetry reports anonymous feature use. Nil disables reporting.
	Telemetry TelemetryReporter
	// TelemetrySettings is the persisted switch and the one-shot facts. Nil
	// makes TelemetryEnabled report false and SetTelemetryEnabled unavailable.
	TelemetrySettings TelemetryStore
	// Cache keeps the last successful config and status for local reads. Nil
	// disables persistence.
	Cache SnapshotCache
	// ApplyTheme defaults to mygo.Theme.SetSource. Tests inject a recorder so
	// they do not need a running app.
	ApplyTheme func(source string)
	// EmitLoginStatus defaults to LoginStatusEvent.Broadcast.
	EmitLoginStatus func(LoginStatusDTO)
	// EmitCloudflareLogin defaults to CloudflareLoginEvent.Broadcast.
	EmitCloudflareLogin func(CloudflareLoginDTO)
	NewOperationID      func() (string, error)
	Now                 func() time.Time
}

// Service is the single service bound to MyGo. Every exported method is a
// frontend-safe DTO operation; raw clients, tokens, secret getters and
// arbitrary URL openers are not exposed.
type Service struct {
	auth               AuthService
	publish            PublishService
	lifecycle          LifecycleService
	entries            EntriesService
	diagnostics        StatusService
	snapshots          SnapshotReader
	scripts            ScriptLister
	journal            OperationJournal
	store              TargetStore
	browser            platform.BrowserOpener
	mcpBrowser         platform.BrowserOpener
	credentials        platform.CredentialStore
	release            ReleaseSource
	backup             BackupService
	dialogs            FileDialogs
	settings           BackupSettingsStore
	openPath           func(string) error
	checkClientUpdates func()
	theme              ThemeStore
	locale             *LocaleState
	telemetry          TelemetryReporter
	telemetrySettings  TelemetryStore
	cache              SnapshotCache
	applyTheme         func(string)
	emitLogin          func(LoginStatusDTO)
	emitCloudflare     func(CloudflareLoginDTO)
	newOpID            func() (string, error)
	now                func() time.Time

	cfMu          sync.Mutex
	cfSession     auth.LoginSession
	cfOperationID string
	cfActive      bool
	cfTimer       *time.Timer

	loginMu     sync.Mutex
	logins      map[string]context.CancelFunc
	loginActive bool

	backupMu   sync.Mutex
	backupPath string
	backupBusy bool
}

// NewService constructs the application service.
func NewService(options ServiceOptions) *Service {
	emit := options.EmitLoginStatus
	if emit == nil {
		emit = func(status LoginStatusDTO) { _ = LoginStatusEvent.Broadcast(status) }
	}
	newOpID := options.NewOperationID
	if newOpID == nil {
		newOpID = randomOperationID
	}
	emitCloudflare := options.EmitCloudflareLogin
	if emitCloudflare == nil {
		emitCloudflare = func(status CloudflareLoginDTO) { _ = CloudflareLoginEvent.Broadcast(status) }
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	mcpBrowser := options.McpBrowser
	if mcpBrowser == nil {
		mcpBrowser = options.Browser
	}
	checkClientUpdates := options.CheckClientUpdates
	if checkClientUpdates == nil {
		checkClientUpdates = updater.CheckForUpdates
	}
	openPath := options.OpenPath
	if openPath == nil {
		openPath = func(path string) error { return mygo.Shell.OpenPath(path) }
	}
	applyTheme := options.ApplyTheme
	if applyTheme == nil {
		applyTheme = func(source string) { mygo.Theme.SetSource(mygo.ThemeSource(source)) }
	}
	locale := options.Locale
	if locale == nil {
		locale = NewLocaleState(nil, nil)
	}
	return &Service{
		auth:               options.Auth,
		publish:            options.Publish,
		lifecycle:          options.Lifecycle,
		entries:            options.Entries,
		diagnostics:        options.Diagnostics,
		snapshots:          options.Snapshots,
		scripts:            options.Scripts,
		journal:            options.Journal,
		store:              options.Store,
		browser:            options.Browser,
		mcpBrowser:         mcpBrowser,
		credentials:        options.Credentials,
		release:            options.Release,
		backup:             options.Backup,
		dialogs:            options.FileDialogs,
		settings:           options.BackupSettings,
		openPath:           openPath,
		checkClientUpdates: checkClientUpdates,
		theme:              options.Theme,
		locale:             locale,
		telemetry:          options.Telemetry,
		telemetrySettings:  options.TelemetrySettings,
		cache:              options.Cache,
		applyTheme:         applyTheme,
		emitLogin:          emit,
		emitCloudflare:     emitCloudflare,
		newOpID:            newOpID,
		now:                now,
		logins:             map[string]context.CancelFunc{},
	}
}

// Name returns the product name for the shell header.
func (s *Service) Name() string { return "DeskWand Bot" }

// t returns the message for key in the language this run resolves to.
func (s *Service) t(key string, args ...any) string {
	return i18n.T(s.locale.Current(), key, args...)
}

// Theme returns the appearance the client shows: "system", "light" or "dark".
// ThemeSystem when nothing was chosen yet or the stored value cannot be used.
func (s *Service) Theme() string {
	if s.theme == nil {
		return ThemeSystem
	}
	source, err := s.theme.Theme()
	if err != nil {
		return ThemeSystem
	}
	return source
}

// SetTheme stores the appearance and applies it to the native chrome and to
// the pages, which follow prefers-color-scheme. The order is deliberate: a
// store that refuses the write leaves the appearance as it was, so the
// switcher never shows a choice that would be gone after a restart.
func (s *Service) SetTheme(source string) error {
	normalized, ok := normalizeTheme(source)
	if !ok {
		return domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.themeInvalid")}
	}
	if s.theme != nil {
		if err := s.theme.SetTheme(normalized); err != nil {
			slog.Error("app: save appearance", "error", err)
			return domain.Error{Code: CodeThemeSaveFailed, Message: s.t("app.themeSaveFailed")}
		}
	}
	s.applyTheme(normalized)
	return nil
}

// Locale returns the language choice: the stored source and the zh/en locale
// it resolves to.
func (s *Service) Locale() LocaleDTO { return s.locale.Get() }

// SetLocale stores the language and switches this run to it. A store that
// refuses the write still switches the run; the error then only says the
// choice will revert on the next launch.
func (s *Service) SetLocale(source string) (LocaleDTO, error) { return s.locale.Set(source) }

// StartCloudflareLogin opens Cloudflare's authorization page and waits for the
// loopback callback in the background. It returns the operation id used by
// CancelCloudflareLogin; progress arrives through CloudflareLoginEvent.
func (s *Service) StartCloudflareLogin() (string, error) {
	if s.auth == nil {
		return "", s.serviceUnavailable()
	}
	operationID, err := s.newOpID()
	if err != nil {
		return "", s.serviceUnavailable()
	}

	s.cfMu.Lock()
	if s.cfActive {
		s.cfMu.Unlock()
		return "", domain.Error{Code: CodeCloudflareLoginInProgress, Message: s.t("app.cloudflareLoginInProgress")}
	}
	session, err := s.auth.BeginLogin(context.Background())
	if err != nil {
		s.cfMu.Unlock()
		return "", safeAppError(err)
	}
	s.cfActive = true
	s.cfSession = session
	s.cfOperationID = operationID
	s.cfMu.Unlock()

	if s.browser == nil {
		s.finishCloudflareLogin(session)
		session.Cancel()
		return "", s.serviceUnavailable()
	}
	if err := s.browser.Open(session.AuthURL()); err != nil {
		s.finishCloudflareLogin(session)
		session.Cancel()
		return "", safeAppError(&auth.Error{Code: auth.ErrCodeOAuthExchangeFailed, Message: s.t("app.browserOpenFailed")})
	}
	s.emitCloudflare(CloudflareLoginDTO{OperationID: operationID, State: "waiting_browser"})
	go s.runCloudflareLogin(operationID, session)
	return operationID, nil
}

func (s *Service) runCloudflareLogin(operationID string, session auth.LoginSession) {
	ctx, cancel := context.WithTimeout(context.Background(), auth.LoginTimeout)
	defer cancel()

	result, err := session.Wait(ctx)
	if err != nil {
		state := "error"
		code := auth.Code(err)
		switch {
		case code == auth.ErrCodeOAuthDenied:
			state = "denied"
		case code == auth.ErrCodeOAuthTimeout || errors.Is(err, context.DeadlineExceeded):
			state = "timeout"
			code = auth.ErrCodeOAuthTimeout
		}
		if !s.finishCloudflareLogin(session) {
			// CancelCloudflareLogin already reported this login as cancelled.
			return
		}
		s.emitCloudflare(CloudflareLoginDTO{OperationID: operationID, State: state, Code: code})
		return
	}

	if len(result.Accounts) == 1 {
		s.completeCloudflareLogin(operationID, session, result.Accounts[0].ID)
		return
	}
	// Several accounts: keep the session open until the user picks one, but not
	// forever — an abandoned picker would block every later login attempt.
	s.cfMu.Lock()
	s.cfTimer = time.AfterFunc(auth.LoginTimeout, func() {
		if !s.finishCloudflareLogin(session) {
			return
		}
		session.Cancel()
		s.emitCloudflare(CloudflareLoginDTO{OperationID: operationID, State: "timeout", Code: auth.ErrCodeOAuthTimeout})
	})
	s.cfMu.Unlock()
	s.emitCloudflare(CloudflareLoginDTO{
		OperationID: operationID,
		State:       "select_account",
		Accounts:    accountDTOs(result.Accounts),
	})
}

// ConfirmCloudflareAccount finishes a login that offered several accounts.
func (s *Service) ConfirmCloudflareAccount(accountID string) error {
	s.cfMu.Lock()
	session := s.cfSession
	operationID := s.cfOperationID
	s.cfMu.Unlock()
	if session == nil {
		return domain.Error{Code: CodeCloudflareLoginNotFound, Message: s.t("app.cloudflareLoginWaiting")}
	}
	if err := session.Complete(context.Background(), strings.TrimSpace(accountID)); err != nil {
		return safeAppError(err)
	}
	// The credentials are on disk now, so the UI is told the truth even if a
	// cancel won the race: otherwise the screen says cancelled while the store
	// says connected.
	s.finishCloudflareLogin(session)
	s.emitCloudflare(CloudflareLoginDTO{OperationID: operationID, State: "connected"})
	return nil
}

// completeCloudflareLogin persists the only offered account and reports the
// outcome. It runs after Wait, so the session is finished either way.
func (s *Service) completeCloudflareLogin(operationID string, session auth.LoginSession, accountID string) {
	completeErr := session.Complete(context.Background(), accountID)
	s.finishCloudflareLogin(session)
	if completeErr != nil {
		s.emitCloudflare(CloudflareLoginDTO{OperationID: operationID, State: "error", Code: auth.Code(completeErr)})
		return
	}
	s.emitCloudflare(CloudflareLoginDTO{OperationID: operationID, State: "connected"})
}

// CancelCloudflareLogin stops an unfinished OAuth login.
func (s *Service) CancelCloudflareLogin(opID string) error {
	s.cfMu.Lock()
	session := s.cfSession
	active := s.cfActive
	operationID := s.cfOperationID
	s.cfMu.Unlock()
	if !active || session == nil || operationID != strings.TrimSpace(opID) {
		return domain.Error{Code: CodeCloudflareLoginNotFound, Message: s.t("app.loginNotFound")}
	}
	if !s.finishCloudflareLogin(session) {
		return domain.Error{Code: CodeCloudflareLoginNotFound, Message: s.t("app.loginNotFound")}
	}
	session.Cancel()
	s.emitCloudflare(CloudflareLoginDTO{OperationID: operationID, State: "cancelled"})
	return nil
}

// finishCloudflareLogin clears the in-flight session. It reports whether this
// call was the one that cleared it, so the loser of a cancel race stays quiet
// instead of emitting a second, contradictory event.
func (s *Service) finishCloudflareLogin(session auth.LoginSession) bool {
	s.cfMu.Lock()
	defer s.cfMu.Unlock()
	if s.cfSession != session {
		return false
	}
	if s.cfTimer != nil {
		s.cfTimer.Stop()
		s.cfTimer = nil
	}
	s.cfSession = nil
	s.cfOperationID = ""
	s.cfActive = false
	return true
}

func accountDTOs(accounts []auth.Account) []AccountDTO {
	out := make([]AccountDTO, 0, len(accounts))
	for _, account := range accounts {
		out = append(out, AccountDTO{ID: account.ID, Name: account.Name})
	}
	return out
}

// CloudflareStatus reports local connection state without an error channel.
func (s *Service) CloudflareStatus() ConnectionDTO {
	if s.auth == nil {
		return ConnectionDTO{State: auth.StateUnavailable}
	}
	connection, err := s.auth.Status(context.Background())
	if err != nil && connection.State == "" {
		return ConnectionDTO{State: auth.StateUnavailable}
	}
	return ConnectionDTO{
		State:       connection.State,
		AccountID:   connection.AccountID,
		AccountName: connection.AccountName,
	}
}

// BootState reports what the app needs to choose its first screen. It reads
// only local credentials, the target file and the journal; it never contacts
// Cloudflare.
func (s *Service) BootState() (BootStateDTO, error) {
	connection := s.CloudflareStatus()
	state := BootStateDTO{Connection: connection, Pending: []OperationDTO{}}
	if connection.State != auth.StateConnected {
		return state, nil
	}
	if s.store == nil {
		return BootStateDTO{}, s.serviceUnavailable()
	}
	target, ok, err := s.store.Load()
	if err != nil {
		return BootStateDTO{}, safeAppError(err)
	}
	if ok {
		if target.AccountID == connection.AccountID {
			state.TargetSelected = true
			state.TargetName = target.ScriptName
		} else {
			state.TargetMismatch = true
		}
	}
	if operations, err := s.PendingOperations(); err == nil {
		for _, operation := range operations {
			if operation.AccountID == "" || operation.AccountID == connection.AccountID {
				state.Pending = append(state.Pending, operation)
			}
		}
	}
	return state, nil
}

// DisconnectCloudflare revokes the authorization and removes local credentials.
func (s *Service) DisconnectCloudflare() error {
	if s.auth == nil {
		return s.serviceUnavailable()
	}
	if err := s.auth.Disconnect(context.Background()); err != nil {
		return err
	}
	if s.cache != nil {
		if err := s.cache.Clear(); err != nil {
			slog.Error("app: clear snapshot cache", "error", err)
		}
	}
	return nil
}

// ListWorkers lists Worker scripts in the connected account.
func (s *Service) ListWorkers() ([]WorkerDTO, error) {
	accountID, err := s.connectedAccount(context.Background())
	if err != nil {
		return []WorkerDTO{}, err
	}
	if s.scripts == nil {
		return []WorkerDTO{}, s.serviceUnavailable()
	}
	scripts, err := s.scripts.ListScripts(context.Background(), accountID)
	if err != nil {
		return []WorkerDTO{}, safeAppError(err)
	}
	workers := make([]WorkerDTO, 0, len(scripts))
	for _, script := range scripts {
		workers = append(workers, WorkerDTO{
			Name:         script.ID,
			ModifiedOn:   script.ModifiedOn,
			MigrationTag: script.MigrationTag,
		})
	}
	sort.Slice(workers, func(i, j int) bool { return workers[i].Name < workers[j].Name })
	return workers, nil
}

// SelectDeployment persists the managed Worker target in app data. The target
// is not a secret and never includes a token.
func (s *Service) SelectDeployment(scriptName string) error {
	ctx := context.Background()
	accountID, err := s.connectedAccount(ctx)
	if err != nil {
		return err
	}
	scriptName = strings.TrimSpace(scriptName)
	if err := cloudflare.ValidateWorkerName(scriptName); err != nil {
		return domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.workerNameInvalid")}
	}
	if s.store == nil {
		return s.serviceUnavailable()
	}
	return s.store.Save(domain.Target{AccountID: accountID, ScriptName: scriptName})
}

// InspectImport reads an existing deployment without writing anything.
func (s *Service) InspectImport() (ImportPreviewDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ImportPreviewDTO{}, err
	}
	if s.lifecycle == nil {
		return ImportPreviewDTO{}, s.serviceUnavailable()
	}
	preview, err := s.lifecycle.InspectImport(ctx, target)
	dto := ImportPreviewDTO{
		AccountID:           target.AccountID,
		WorkerName:          target.ScriptName,
		ReleaseVersion:      preview.ReleaseVersion,
		Legacy:              preview.Legacy,
		ConfigPresent:       preview.ConfigPresent,
		OwnerConfigured:     preview.OwnerConfigured,
		ModelsConfigured:    preview.ModelsConfigured,
		ActiveChannel:       preview.ActiveChannel,
		SecretNames:         visibleSecretNames(preview.SecretNames),
		PreserveSecretNames: visibleSecretNames(preview.PreserveSecretNames),
		RequiredInputs:      append([]string(nil), preview.RequiredInputs...),
		Warnings:            append([]string(nil), preview.Warnings...),
	}
	for _, migration := range preview.PlaintextSecrets {
		dto.PlaintextSecrets = append(dto.PlaintextSecrets, PlaintextSecretDTO{
			Field:      migration.Path,
			SecretName: migration.SecretName,
			Reference:  migration.Reference,
		})
	}
	if s.release != nil {
		if version := s.release.Version(); version != "" {
			dto.Warnings = append(dto.Warnings, s.t("app.importVersionWarning", version))
		}
	}
	return dto, safeAppError(err)
}

// ConfirmImport publishes the confirmed import through the versioned publish
// path.
func (s *Service) ConfirmImport(input ImportInputDTO) (ResultDTO, error) {
	ctx := context.Background()
	if _, err := s.releasePackage(); err != nil {
		return ResultDTO{}, err
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	if s.lifecycle == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	butler, err := optionalModelInput(modelRef(input.ButlerModel))
	if err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	task, err := optionalModelInput(modelRef(input.TaskModel))
	if err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	secretValues := make(map[string]string, len(input.Secrets))
	for _, secret := range input.Secrets {
		secretValues[secret.Name] = secret.Value
	}
	result, err := s.lifecycle.ConfirmImport(ctx, target, deployment.ImportConfirmation{
		BaseFingerprint: input.BaseFingerprint,
		TelegramUserIDs: cloneInt64Pointer(input.TelegramUserIDs),
		ButlerModel:     butler,
		TaskModel:       task,
		SecretValues:    secretValues,
	})
	failure := safeAppError(err, importSecretValues(input.Secrets)...)
	s.reportFeature(telemetry.FeatureImport, result.State, failure)
	return s.summaryFromResult(result, target.ScriptName), failure
}

// Install creates a new deployment.
func (s *Service) Install(input InstallInputDTO) (ResultDTO, error) {
	ctx := context.Background()
	if _, err := s.releasePackage(); err != nil {
		return ResultDTO{}, err
	}
	connected, err := s.connectedAccount(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	accountID := connected
	if requested := strings.TrimSpace(input.AccountID); requested != "" && !strings.EqualFold(requested, connected) {
		return ResultDTO{}, domain.Error{Code: CodeAccountMismatch, Message: s.t("app.installAccountMismatch")}
	}
	if s.lifecycle == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	butler, err := modelInput(ModelRefInput{Provider: input.ButlerModel.Provider, ID: input.ButlerModel.ID})
	if err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	task, err := modelInput(ModelRefInput{Provider: input.TaskModel.Provider, ID: input.TaskModel.ID})
	if err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	channel := normalizeChannel(input.ActiveChannel)
	if channel == "" {
		return ResultDTO{}, domain.Error{Code: CodeInvalidEntryChannel, Message: s.t("app.activeChannelInvalid")}
	}
	request := deployment.InstallRequest{
		AccountID:  accountID,
		WorkerName: strings.TrimSpace(input.WorkerName),
		BucketName: strings.TrimSpace(input.BucketName),
		Config: deployment.InstallConfig{
			TelegramUserIDs: append([]int64(nil), input.TelegramUserIDs...),
			ButlerModel:     butler,
			TaskModel:       task,
		},
		ActiveChannel: channel,
	}
	result, err := s.lifecycle.Install(ctx, request)
	failure := safeAppError(err)
	summary := s.summaryFromResult(result, request.WorkerName)
	if failure == nil && summary.State == deployment.StatePublished && s.store != nil {
		_ = s.store.Save(domain.Target{AccountID: accountID, ScriptName: request.WorkerName})
	}
	if len(input.TelegramUserIDs) == 0 {
		summary.Warnings = append(summary.Warnings, s.t("app.ownerMissing"))
	}
	// After the save: setup can only be evaluated against the deployment this
	// install just selected.
	s.reportFeature(telemetry.FeatureInstall, result.State, failure)
	return summary, failure
}

// UpgradeAvailable compares the embedded release with the active deployment.
func (s *Service) UpgradeAvailable() (UpgradeDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return UpgradeDTO{}, err
	}
	if _, err := s.releasePackage(); err != nil {
		return UpgradeDTO{Reason: releaseErrorCode(err)}, nil
	}
	availableVersion := ""
	if s.release != nil {
		availableVersion = s.release.Version()
	}
	if s.snapshots == nil {
		return UpgradeDTO{}, s.serviceUnavailable()
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return UpgradeDTO{}, safeAppError(err)
	}
	dto := UpgradeDTO{
		CurrentVersion:   snapshot.ReleaseVersion,
		AvailableVersion: availableVersion,
		ModelKeysMissing: missingModelKeys(snapshot),
	}
	if snapshot.ReleaseVersion == "" {
		dto.Reason = deployment.CodeVersionUnknownReimport
		return dto, nil
	}
	comparison, comparable := deployment.CompareVersions(snapshot.ReleaseVersion, availableVersion)
	if !comparable {
		dto.Reason = deployment.CodeVersionUnknown
		return dto, nil
	}
	switch {
	case comparison < 0:
		dto.Available = true
	case comparison == 0:
		dto.Reason = "UP_TO_DATE"
	default:
		dto.Reason = deployment.CodeDowngradeRejected
	}
	return dto, nil
}

// missingModelKeys lists the MODEL_KEY_* secrets the deployed configuration
// needs but the deployment does not have.
func missingModelKeys(snapshot domain.Snapshot) []string {
	if len(snapshot.ConfigJSON) == 0 {
		return nil
	}
	doc, err := modelcatalog.ParseModels(snapshot.ConfigJSON)
	if err != nil {
		return nil
	}
	existing := make(map[string]bool, len(snapshot.SecretNames))
	for _, name := range snapshot.SecretNames {
		existing[name] = true
	}
	missing := make([]string, 0)
	for _, name := range modelcatalog.RequiredSecretNames(doc) {
		if !existing[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

// Upgrade applies the embedded release to the managed deployment.
func (s *Service) Upgrade() (ResultDTO, error) {
	ctx := context.Background()
	pkg, err := s.releasePackage()
	if err != nil {
		return ResultDTO{}, err
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	if s.lifecycle == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	result, err := s.lifecycle.Upgrade(ctx, target, pkg)
	failure := safeAppError(err)
	s.reportFeature(telemetry.FeatureUpgrade, result.State, failure)
	return s.summaryFromResult(result, target.ScriptName), failure
}

// GetConfig reads the editable configuration summary.
func (s *Service) GetConfig() (ConfigDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ConfigDTO{}, err
	}
	if s.snapshots == nil {
		return ConfigDTO{}, s.serviceUnavailable()
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return ConfigDTO{}, safeAppError(err)
	}
	dto := ConfigDTO{
		AccountID:          target.AccountID,
		WorkerName:         target.ScriptName,
		Fingerprint:        snapshot.Fingerprint,
		ReleaseVersion:     snapshot.ReleaseVersion,
		ActiveVersionCount: snapshot.ActiveVersionCount,
		ConfigPresent:      len(snapshot.ConfigJSON) > 0,
		ActiveChannel:      ReadPlainVar(snapshot.SettingsJSON, "ACTIVE_CHANNEL"),
		OwnerUserIDs:       []int64{},
		CustomProviders:    []CustomProviderDTO{},
		McpServers:         json.RawMessage("[]"),
		Locale:             "zh",
		Secrets:            s.secretStatuses(snapshot),
	}
	if len(snapshot.ConfigJSON) > 0 {
		var document struct {
			Owner struct {
				TelegramUserIDs []int64 `json:"telegramUserIds"`
			} `json:"owner"`
			Models struct {
				Butler          *ModelDTO           `json:"butler"`
				Task            *ModelDTO           `json:"task"`
				CustomProviders []CustomProviderDTO `json:"customProviders"`
			} `json:"models"`
			McpServers json.RawMessage `json:"mcpServers"`
			Locale     string          `json:"locale"`
		}
		if err := json.Unmarshal(snapshot.ConfigJSON, &document); err != nil {
			return dto, domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: s.t("app.configInvalidJSON")}
		}
		if document.Owner.TelegramUserIDs != nil {
			dto.OwnerUserIDs = document.Owner.TelegramUserIDs
		}
		dto.ButlerModel = summarizeModel(document.Models.Butler)
		dto.TaskModel = summarizeModel(document.Models.Task)
		if document.Models.CustomProviders != nil {
			dto.CustomProviders = document.Models.CustomProviders
		}
		if raw := bytes.TrimSpace(document.McpServers); len(raw) > 0 && string(raw) != "null" {
			dto.McpServers = raw
		}
		if document.Locale == "en" {
			dto.Locale = "en"
		}
	}
	if s.cache != nil {
		if err := s.cache.SaveConfig(target, dto, s.now()); err != nil {
			slog.Error("app: save config snapshot", "error", err)
		}
	}
	return dto, nil
}

// CachedConfig returns the last config this app wrote for the managed target.
// It reads only local files and never contacts Cloudflare.
func (s *Service) CachedConfig() (CachedConfigDTO, error) {
	target, err := s.managedTarget(context.Background())
	if err != nil {
		return CachedConfigDTO{}, err
	}
	if s.cache == nil {
		return CachedConfigDTO{}, nil
	}
	data, at, ok := s.cache.LoadConfig(target)
	if !ok {
		return CachedConfigDTO{}, nil
	}
	return CachedConfigDTO{Data: &data, SavedAt: formatTime(at)}, nil
}

// CachedStatus returns the last status this app wrote for the managed target.
// It reads only local files and never contacts Cloudflare.
func (s *Service) CachedStatus() (CachedStatusDTO, error) {
	target, err := s.managedTarget(context.Background())
	if err != nil {
		return CachedStatusDTO{}, err
	}
	if s.cache == nil {
		return CachedStatusDTO{}, nil
	}
	data, at, ok := s.cache.LoadStatus(target)
	if !ok {
		return CachedStatusDTO{}, nil
	}
	return CachedStatusDTO{Data: data, SavedAt: formatTime(at)}, nil
}

// PreviewConfig validates and describes a publish without writing.
func (s *Service) PreviewConfig(input ConfigEditDTO) ([]StepDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return []StepDTO{}, err
	}
	if s.publish == nil {
		return []StepDTO{}, s.serviceUnavailable()
	}
	change, err := s.changeFromEdit(ctx, target, input)
	if err != nil {
		return []StepDTO{}, safeAppError(err, secretInputValues(input.Secrets)...)
	}
	steps, err := s.publish.Preview(ctx, target, change)
	converted := stepDTOs(steps)
	if !hasStepID(converted, "release") {
		if step, ok := s.releaseVersionStep(ctx, target); ok {
			converted = append([]StepDTO{step}, converted...)
		}
	}
	return converted, safeAppError(err, secretInputValues(input.Secrets)...)
}

// PublishConfig merges and publishes the editable configuration (保存并发布).
func (s *Service) PublishConfig(input ConfigEditDTO) (ResultDTO, error) {
	ctx := context.Background()
	if _, err := s.releasePackage(); err != nil {
		return ResultDTO{}, err
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	if s.publish == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	change, err := s.changeFromEdit(ctx, target, input)
	if err != nil {
		return ResultDTO{}, safeAppError(err, secretInputValues(input.Secrets)...)
	}
	result, err := s.publish.Apply(ctx, target, change)
	failure := safeAppError(err, secretInputValues(input.Secrets)...)
	s.reportFeature(telemetry.FeaturePublish, result.State, failure)
	return s.summaryFromResult(result, target.ScriptName), failure
}

// ResumeOperation reconciles one journaled operation by kind. Installs are
// replayed through Lifecycle.Install from the journaled request (idempotent
// resource discovery), upgrades reconcile the live release before any retry,
// and ordinary publishes use the publish state machine. An install or upgrade
// must never enter publish.Resume: that path would treat their record as a
// configuration publish and could delete the wrong pending secrets.
func (s *Service) ResumeOperation(id string) (ResultDTO, error) {
	ctx := context.Background()
	if _, err := s.releasePackage(); err != nil {
		return ResultDTO{}, err
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	if s.journal == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	operationID := strings.TrimSpace(id)
	record, err := s.journal.Load(operationID)
	if err != nil {
		return ResultDTO{OperationID: operationID}, safeAppError(err)
	}
	if record.Target != target {
		return ResultDTO{OperationID: operationID}, domain.Error{
			Code:    CodeTargetMismatch,
			Message: s.t("app.resumeOtherDeployment"),
		}
	}
	switch record.Kind {
	case deployment.KindInstall:
		return s.resumeInstall(ctx, record, target)
	case deployment.KindUpgrade:
		return s.resumeUpgrade(ctx, record, target)
	default:
		if s.publish == nil {
			return ResultDTO{}, s.serviceUnavailable()
		}
		result, err := s.publish.Resume(ctx, operationID)
		return s.summaryFromResult(result, target.ScriptName), safeAppError(err)
	}
}

func (s *Service) resumeInstall(ctx context.Context, record deployment.OperationRecord, target domain.Target) (ResultDTO, error) {
	if s.lifecycle == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	request, err := installRequestFromRecord(s.locale.Current(), record)
	if err != nil {
		return s.summaryFromRecord(record, target.ScriptName), safeAppError(err)
	}
	result, err := s.lifecycle.Install(ctx, request)
	summary := s.summaryFromResult(result, target.ScriptName)
	if err == nil && summary.State == deployment.StatePublished && s.store != nil {
		_ = s.store.Save(target)
	}
	return summary, safeAppError(err)
}

func (s *Service) resumeUpgrade(ctx context.Context, record deployment.OperationRecord, target domain.Target) (ResultDTO, error) {
	pkg, err := s.releasePackage()
	if err != nil {
		return s.summaryFromRecord(record, target.ScriptName), err
	}
	if s.snapshots == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return s.summaryFromRecord(record, target.ScriptName), safeAppError(err)
	}
	desiredVersion := record.ReleaseVersion
	if desiredVersion == "" {
		desiredVersion = pkg.Version()
	}
	if desiredVersion != "" && snapshot.ReleaseVersion == desiredVersion &&
		snapshot.ActiveVersionCount == 1 && snapshot.VersionID != "" {
		if identityErr := deployment.VerifyUpgradeIdentity(
			snapshot.SettingsJSON, pkg.Manifest().ResourceTemplate, record.BucketName,
		); identityErr == nil {
			record.State = deployment.StatePublished
			record.DeploymentID = snapshot.DeploymentID
			record.StagedVersionID = snapshot.VersionID
			record.ReleaseVersion = desiredVersion
			record.UpdatedAt = s.now()
			markStepsPublished(record.Steps)
			if saveErr := s.journal.Save(record); saveErr != nil {
				return s.summaryFromRecord(record, target.ScriptName), safeAppError(saveErr)
			}
			return s.summaryFromRecord(record, target.ScriptName), nil
		}
	}
	if !record.ScriptUploadAttempted {
		if s.lifecycle == nil {
			return ResultDTO{}, s.serviceUnavailable()
		}
		// A new Upgrade would see this unknown record as an unresolved
		// operation. No upload was sent, so it is safe to close the record as
		// NOT_SENT before starting the one allowed retry.
		record.State = deployment.StateFailed
		record.FailureCode = domain.NOT_SENT
		record.UpdatedAt = s.now()
		setLastStepNeedsInput(record.Steps, s.t("app.upgradePending"))
		if saveErr := s.journal.Save(record); saveErr != nil {
			return s.summaryFromRecord(record, target.ScriptName), safeAppError(saveErr)
		}
		result, upgradeErr := s.lifecycle.Upgrade(ctx, target, pkg)
		if upgradeErr == nil && result.State == deployment.StatePublished {
			record.State = deployment.StatePublished
			record.DeploymentID = result.DeploymentID
			record.StagedVersionID = result.VersionID
			record.ReleaseVersion = desiredVersion
			record.UpdatedAt = s.now()
			markStepsPublished(record.Steps)
			if saveErr := s.journal.Save(record); saveErr != nil {
				return s.summaryFromRecord(record, target.ScriptName), safeAppError(saveErr)
			}
			return s.summaryFromRecord(record, target.ScriptName), nil
		}
		return s.summaryFromResult(result, target.ScriptName), safeAppError(upgradeErr)
	}
	record.State = deployment.StateNeedsInput
	record.UpdatedAt = s.now()
	setLastStepNeedsInput(record.Steps, s.t("app.upgradeUnknown"))
	if saveErr := s.journal.Save(record); saveErr != nil {
		return s.summaryFromRecord(record, target.ScriptName), safeAppError(saveErr)
	}
	summary := s.summaryFromRecord(record, target.ScriptName)
	summary.Warnings = append(summary.Warnings, s.t("app.upgradeUnconfirmed"))
	return summary, nil
}

// AbandonOperation delegates to the state machine that owns the journal
// record. A publish abandon deletes its pending credential-store values;
// install and upgrade abandons never touch those references.
func (s *Service) AbandonOperation(id string) (ResultDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	if s.journal == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	operationID := strings.TrimSpace(id)
	record, err := s.journal.Load(operationID)
	if err != nil {
		return ResultDTO{OperationID: operationID}, safeAppError(err)
	}
	if record.Target != target {
		return ResultDTO{OperationID: operationID}, domain.Error{
			Code:    CodeTargetMismatch,
			Message: s.t("app.abandonOtherDeployment"),
		}
	}
	switch record.Kind {
	case deployment.KindInstall, deployment.KindUpgrade:
		if s.lifecycle == nil {
			return ResultDTO{}, s.serviceUnavailable()
		}
		result, abandonErr := s.lifecycle.Abandon(ctx, operationID)
		return s.summaryFromResult(result, target.ScriptName), safeAppError(abandonErr)
	default:
		if s.publish == nil {
			return ResultDTO{}, s.serviceUnavailable()
		}
		result, abandonErr := s.publish.Abandon(ctx, operationID)
		return s.summaryFromResult(result, target.ScriptName), safeAppError(abandonErr)
	}
}

func installRequestFromRecord(locale string, record deployment.OperationRecord) (deployment.InstallRequest, error) {
	if len(record.ConfigJSON) == 0 {
		return deployment.InstallRequest{}, domain.Error{
			Code:    deployment.CodeConfigMissing,
			Message: i18n.T(locale, "app.installConfigMissing"),
		}
	}
	var document struct {
		Owner struct {
			TelegramUserIDs []int64 `json:"telegramUserIds"`
		} `json:"owner"`
		Models struct {
			Butler json.RawMessage `json:"butler"`
			Task   json.RawMessage `json:"task"`
		} `json:"models"`
	}
	if err := json.Unmarshal(record.ConfigJSON, &document); err != nil {
		return deployment.InstallRequest{}, domain.Error{
			Code:    domain.UNSUPPORTED_SCHEMA,
			Message: i18n.T(locale, "app.installConfigInvalid"),
		}
	}
	config := deployment.InstallConfig{
		TelegramUserIDs: append([]int64(nil), document.Owner.TelegramUserIDs...),
	}
	if len(document.Models.Butler) > 0 {
		config.ButlerModel = append(json.RawMessage(nil), document.Models.Butler...)
	}
	if len(document.Models.Task) > 0 {
		config.TaskModel = append(json.RawMessage(nil), document.Models.Task...)
	}
	return deployment.InstallRequest{
		AccountID:     record.Target.AccountID,
		WorkerName:    record.Target.ScriptName,
		BucketName:    record.BucketName,
		Config:        config,
		ActiveChannel: record.ActiveChannel,
	}, nil
}

func markStepsPublished(steps []domain.Step) {
	for index := range steps {
		if steps[index].State != deployment.StatePublished {
			steps[index].State = deployment.StatePublished
		}
	}
}

func setLastStepNeedsInput(steps []domain.Step, message string) {
	if len(steps) == 0 {
		return
	}
	last := len(steps) - 1
	steps[last].State = deployment.StateNeedsInput
	steps[last].Message = message
}

func (s *Service) summaryFromRecord(record deployment.OperationRecord, workerName string) ResultDTO {
	return ResultDTO{
		OperationID:    record.OperationID,
		DeploymentID:   record.DeploymentID,
		VersionID:      record.StagedVersionID,
		State:          record.State,
		WorkerName:     workerName,
		ReleaseVersion: record.ReleaseVersion,
		ActiveChannel:  record.ActiveChannel,
		Steps:          stepDTOs(record.Steps),
	}
}

// PendingOperations lists unfinished journaled operations, newest first.
func (s *Service) PendingOperations() ([]OperationDTO, error) {
	if s.journal == nil {
		return []OperationDTO{}, s.serviceUnavailable()
	}
	records, err := s.journal.List()
	if err != nil {
		return []OperationDTO{}, safeAppError(err)
	}
	operations := make([]OperationDTO, 0, len(records))
	for _, record := range records {
		switch record.State {
		case deployment.StatePublished, deployment.StateCancelled:
			continue
		}
		operations = append(operations, OperationDTO{
			OperationID:    record.OperationID,
			Kind:           record.Kind,
			AccountID:      record.Target.AccountID,
			WorkerName:     record.Target.ScriptName,
			State:          record.State,
			ReleaseVersion: record.ReleaseVersion,
			ActiveChannel:  record.ActiveChannel,
			Steps:          stepDTOs(record.Steps),
			CreatedAt:      formatTime(record.CreatedAt),
			UpdatedAt:      formatTime(record.UpdatedAt),
		})
	}
	sort.Slice(operations, func(i, j int) bool { return operations[i].UpdatedAt > operations[j].UpdatedAt })
	return operations, nil
}

// StartWeChatLogin starts a QR login in the background and returns the
// operation id used by CancelWeChatLogin. Status is pushed through the
// login-status event; credentials never leave Go.
func (s *Service) StartWeChatLogin() (string, error) {
	ctx := context.Background()
	if _, err := s.releasePackage(); err != nil {
		return "", err
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return "", err
	}
	if s.entries == nil {
		return "", s.serviceUnavailable()
	}
	operationID, err := s.newOpID()
	if err != nil {
		return "", s.serviceUnavailable()
	}
	loginCtx, cancel := context.WithCancel(context.Background())
	s.loginMu.Lock()
	if s.loginActive {
		s.loginMu.Unlock()
		cancel()
		return "", domain.Error{Code: CodeLoginInProgress, Message: s.t("app.wechatLoginInProgress")}
	}
	if s.logins == nil {
		s.logins = map[string]context.CancelFunc{}
	}
	s.loginActive = true
	s.logins[operationID] = cancel
	s.loginMu.Unlock()

	go func() {
		cancelledEmitted := false
		defer func() {
			cancel()
			s.loginMu.Lock()
			delete(s.logins, operationID)
			s.loginActive = false
			s.loginMu.Unlock()
		}()
		result, loginErr := s.entries.ConnectWeChatWithStatus(loginCtx, target, func(status wechat.LoginStatus) {
			if status.State == wechat.LoginConfirmed {
				// The QR phase is over. Cancel is no longer meaningful, but the
				// publish that follows must still finish.
				s.loginMu.Lock()
				delete(s.logins, operationID)
				s.loginMu.Unlock()
			}
			if status.State == wechat.LoginCancelled {
				cancelledEmitted = true
			}
			s.emitLogin(LoginStatusDTO{
				OperationID: operationID,
				State:       status.State,
				QRContent:   status.QRContent,
				Message:     status.Message,
			})
		})

		switch {
		case loginErr == nil:
			s.emitLogin(LoginStatusDTO{
				OperationID: result.OperationID,
				State:       "published",
				Message:     s.t("app.wechatLoginPublished"),
			})
		case result.OperationID != "":
			code := appErrorCode(loginErr)
			message := s.t("app.wechatPublishFailed")
			if code != "" {
				message = s.t("app.wechatPublishFailedCode", code)
			}
			s.emitLogin(LoginStatusDTO{
				OperationID: result.OperationID,
				State:       "publish_failed",
				Message:     message,
				Code:        code,
			})
		case errors.Is(loginErr, context.Canceled):
			if !cancelledEmitted {
				s.emitLogin(LoginStatusDTO{OperationID: operationID, State: wechat.LoginCancelled, Message: s.t("app.wechatLoginCancelled")})
			}
		default:
			code := appErrorCode(loginErr)
			s.emitLogin(LoginStatusDTO{OperationID: operationID, State: "error", Message: s.t("app.wechatLoginFailed"), Code: code})
		}
	}()
	return operationID, nil
}

// CancelWeChatLogin cancels a running QR login by operation id.
func (s *Service) CancelWeChatLogin(opID string) error {
	opID = strings.TrimSpace(opID)
	s.loginMu.Lock()
	cancel, ok := s.logins[opID]
	s.loginMu.Unlock()
	if !ok {
		return domain.Error{Code: CodeLoginNotFound, Message: s.t("app.loginNotFound")}
	}
	cancel()
	return nil
}

// ConnectTelegram validates the bot token, publishes it and removes any
// registered webhook so the Worker can poll for updates.
func (s *Service) ConnectTelegram(token string) (ResultDTO, error) {
	ctx := context.Background()
	if _, err := s.releasePackage(); err != nil {
		return ResultDTO{}, err
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	if s.entries == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	result, err := s.entries.ConnectTelegram(ctx, target, strings.TrimSpace(token))
	summary := s.summaryFromResult(result, target.ScriptName)
	failure := safeAppError(err, token)
	if failure == nil && summary.State == deployment.StatePublished {
		// Connecting the channel is one of the ways setup completes, and this
		// path never reaches PublishConfig.
		s.reportConfigDone()
	}
	return summary, failure
}

// SelectEntry publishes ACTIVE_CHANNEL. An unconfigured entry is allowed with
// a warning and never falls back to the other channel.
func (s *Service) SelectEntry(channel string) (EntryResultDTO, error) {
	ctx := context.Background()
	if _, err := s.releasePackage(); err != nil {
		return EntryResultDTO{}, err
	}
	target, err := s.managedTarget(ctx)
	if err != nil {
		return EntryResultDTO{}, err
	}
	if s.entries == nil {
		return EntryResultDTO{}, s.serviceUnavailable()
	}
	selection, err := s.entries.SelectEntry(ctx, target, channel)
	dto := EntryResultDTO{
		OperationID:  selection.OperationID,
		DeploymentID: selection.DeploymentID,
		VersionID:    selection.VersionID,
		State:        selection.State,
		Channel:      selection.Channel,
		Configured:   selection.Configured,
		Warning:      selection.Warning,
	}
	failure := safeAppError(err)
	if failure == nil && dto.State == deployment.StatePublished {
		s.reportConfigDone()
	}
	return dto, failure
}

// Status returns one evidence-based status item per kind.
func (s *Service) Status() ([]StatusItemDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return []StatusItemDTO{}, err
	}
	if s.diagnostics == nil {
		return []StatusItemDTO{}, s.serviceUnavailable()
	}
	report, err := s.diagnostics.Status(ctx, target)
	if err != nil {
		return []StatusItemDTO{}, safeAppError(err)
	}
	items := make([]StatusItemDTO, 0, len(report.Items))
	for _, item := range report.Items {
		items = append(items, statusItemDTO(item))
	}
	if s.cache != nil {
		if err := s.cache.SaveStatus(target, items, s.now()); err != nil {
			slog.Error("app: save status snapshot", "error", err)
		}
	}
	return items, nil
}

// ExportDiagnostics returns the allowlisted, sanitized JSON export.
func (s *Service) ExportDiagnostics() (string, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return "", err
	}
	if s.diagnostics == nil {
		return "", s.serviceUnavailable()
	}
	data, err := s.diagnostics.ExportDiagnostics(ctx, target)
	if err != nil {
		return "", safeAppError(err)
	}
	s.reportAction(telemetry.FeatureDiagnostics, nil)
	return string(data), nil
}

// ProbeModel makes one user-triggered local model request. The key is used in
// memory only and never returned in the status item or an error.
func (s *Service) ProbeModel(provider, model, key, api, baseURL string) (StatusItemDTO, error) {
	evidence, err := ProbeModel(context.Background(), provider, model, key, api, baseURL)
	if err != nil {
		return StatusItemDTO{}, safeAppError(err, key)
	}
	items := diagnostics.Summarize(s.locale.Current(), []string{"model"}, []domain.Evidence{evidence}, "")
	if len(items) == 0 {
		return StatusItemDTO{}, domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.modelProbeNoStatus")}
	}
	return statusItemDTO(items[0]), nil
}

// ModelCatalog returns the built-in providers and models shared with the
// Worker and the desktop client.
func (s *Service) ModelCatalog() (ModelCatalogDTO, error) {
	locale := s.locale.Current()
	builtin := modelcatalog.Builtin()
	providers := make([]ModelProviderDTO, 0, len(builtin))
	for _, provider := range builtin {
		name := provider.Name
		if localized, ok := i18n.Lookup(locale, "catalog.provider."+provider.ID); ok {
			name = localized
		}
		models := make([]ModelEntryDTO, 0, len(provider.Models))
		for _, model := range provider.Models {
			models = append(models, ModelEntryDTO{ID: model.ID, Name: model.Name, Input: model.Input})
		}
		providers = append(providers, ModelProviderDTO{
			ID:      provider.ID,
			Name:    name,
			Keyless: provider.Keyless,
			Models:  models,
		})
	}
	return ModelCatalogDTO{Providers: providers}, nil
}

func (s *Service) releaseVersionStep(ctx context.Context, target domain.Target) (StepDTO, bool) {
	if s.snapshots == nil || s.release == nil {
		return StepDTO{}, false
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return StepDTO{}, false
	}
	cloudVersion := snapshot.ReleaseVersion
	if cloudVersion == "" {
		cloudVersion = s.t("app.versionUnknown")
	}
	clientVersion := s.release.Version()
	if clientVersion == "" {
		clientVersion = s.t("app.versionUnknown")
	}
	return StepDTO{
		ID:       "release",
		State:    "info",
		Message:  s.t("app.versionStatus", cloudVersion, clientVersion),
		Evidence: snapshot.VersionID,
	}, true
}

func hasStepID(steps []StepDTO, id string) bool {
	for _, step := range steps {
		if step.ID == id {
			return true
		}
	}
	return false
}

func (s *Service) changeFromEdit(ctx context.Context, target domain.Target, input ConfigEditDTO) (domain.Change, error) {
	change := domain.Change{BaseFingerprint: strings.TrimSpace(input.BaseFingerprint)}
	if s.snapshots == nil {
		return domain.Change{}, s.serviceUnavailable()
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Change{}, err
	}
	if change.BaseFingerprint == "" {
		change.BaseFingerprint = snapshot.Fingerprint
	}
	if input.OwnerUserIDs != nil {
		ids := append([]int64(nil), (*input.OwnerUserIDs)...)
		change.Patch.TelegramUserIDs = &ids
	}
	if input.ButlerModel != nil {
		raw, err := modelInput(ModelRefInput{Provider: input.ButlerModel.Provider, ID: input.ButlerModel.ID})
		if err != nil {
			return domain.Change{}, err
		}
		change.Patch.ButlerModel = &raw
	}
	if input.TaskModel != nil {
		raw, err := modelInput(ModelRefInput{Provider: input.TaskModel.Provider, ID: input.TaskModel.ID})
		if err != nil {
			return domain.Change{}, err
		}
		change.Patch.TaskModel = &raw
	}
	if input.CustomProviders != nil {
		raw, err := json.Marshal(*input.CustomProviders)
		if err != nil {
			return domain.Change{}, fmt.Errorf("app: encode custom providers: %w", err)
		}
		message := json.RawMessage(raw)
		change.Patch.CustomProviders = &message
	}
	if input.McpServers != nil {
		raw := append(json.RawMessage(nil), (*input.McpServers)...)
		change.Patch.McpServers = &raw
	}
	edited := make(map[string]bool, len(input.Secrets))
	for _, secret := range input.Secrets {
		if strings.TrimSpace(secret.Name) == hiddenSecretName {
			return domain.Change{}, domain.Error{Code: domain.INVALID_SECRET_EDIT, Message: s.t("app.secretAdminManaged")}
		}
		operation := strings.TrimSpace(secret.Operation)
		switch operation {
		case domain.SecretKeep, domain.SecretReplace, domain.SecretClear:
		default:
			return domain.Change{}, domain.Error{Code: domain.INVALID_SECRET_EDIT, Message: s.t("app.secretOperationInvalid")}
		}
		edited[secret.Name] = true
		change.Secrets = append(change.Secrets, domain.NewSecretEdit(secret.Name, operation, secret.Value))
	}
	deployed := make(map[string]bool, len(snapshot.SecretNames))
	for _, name := range snapshot.SecretNames {
		deployed[name] = true
	}
	for _, name := range legacyModelSecretNames {
		if deployed[name] && !edited[name] {
			change.Secrets = append(change.Secrets, domain.NewSecretEdit(name, domain.SecretClear, ""))
		}
	}
	return change, nil
}

func (s *Service) connectedAccount(ctx context.Context) (string, error) {
	if s.auth == nil {
		return "", s.serviceUnavailable()
	}
	connection, err := s.auth.Status(ctx)
	if err != nil && connection.State != auth.StateConnected {
		return "", safeAppError(err)
	}
	if connection.State != auth.StateConnected || connection.AccountID == "" {
		return "", domain.Error{Code: CodeAuthRequired, Message: s.t("app.authRequired")}
	}
	return connection.AccountID, nil
}

func (s *Service) managedTarget(ctx context.Context) (domain.Target, error) {
	accountID, err := s.connectedAccount(ctx)
	if err != nil {
		return domain.Target{}, err
	}
	if s.store == nil {
		return domain.Target{}, s.serviceUnavailable()
	}
	target, ok, err := s.store.Load()
	if err != nil {
		return domain.Target{}, safeAppError(err)
	}
	if !ok {
		return domain.Target{}, domain.Error{Code: CodeTargetNotSelected, Message: s.t("app.targetNotSelected")}
	}
	if target.AccountID != accountID {
		return domain.Target{}, domain.Error{Code: CodeAccountMismatch, Message: s.t("app.targetAccountMismatch")}
	}
	return target, nil
}

func (s *Service) releasePackage() (release.Package, error) {
	if s.release == nil {
		return release.Package{}, domain.Error{Code: CodeReleaseNotBundled, Message: s.t("app.releaseNotBundled")}
	}
	pkg, err := s.release.Package()
	if err != nil {
		return release.Package{}, s.releaseError(err)
	}
	return pkg, nil
}

func (s *Service) secretStatuses(snapshot domain.Snapshot) []SecretNameDTO {
	existing := make(map[string]bool, len(snapshot.SecretNames))
	for _, name := range snapshot.SecretNames {
		existing[name] = true
	}
	names := make(map[string]bool, len(existing))
	for name := range existing {
		if name == hiddenSecretName {
			continue
		}
		names[name] = true
	}
	if s.release != nil {
		for _, name := range s.release.Manifest().ResourceTemplate.SecretNames {
			if name == hiddenSecretName {
				continue
			}
			names[name] = true
		}
	}
	sorted := make([]string, 0, len(names))
	for name := range names {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	statuses := make([]SecretNameDTO, 0, len(sorted))
	for _, name := range sorted {
		statuses = append(statuses, SecretNameDTO{Name: name, Configured: existing[name]})
	}
	return statuses
}

func (s *Service) summaryFromResult(result domain.Result, workerName string) ResultDTO {
	summary := ResultDTO{
		OperationID:  result.OperationID,
		DeploymentID: result.DeploymentID,
		VersionID:    result.VersionID,
		State:        result.State,
		WorkerName:   workerName,
	}
	if result.OperationID == "" || s.journal == nil {
		return summary
	}
	record, err := s.journal.Load(result.OperationID)
	if err != nil {
		return summary
	}
	summary.WorkerName = record.Target.ScriptName
	summary.ReleaseVersion = record.ReleaseVersion
	summary.PublicBaseURL = record.PublicBaseURL
	summary.ActiveChannel = record.ActiveChannel
	summary.Steps = stepDTOs(record.Steps)
	return summary
}

func stepDTOs(steps []domain.Step) []StepDTO {
	if len(steps) == 0 {
		return nil
	}
	converted := make([]StepDTO, 0, len(steps))
	for _, step := range steps {
		converted = append(converted, StepDTO{
			ID:       step.ID,
			State:    step.State,
			Message:  step.Message,
			Evidence: step.Evidence,
		})
	}
	return converted
}

func statusItemDTO(item diagnostics.StatusItem) StatusItemDTO {
	return StatusItemDTO{
		Kind:       item.Kind,
		State:      item.State,
		Source:     item.Source,
		ObservedAt: item.ObservedAt,
		Detail:     item.Detail,
	}
}

func summarizeModel(model *ModelDTO) *ModelDTO {
	if model == nil || model.Provider == "" || model.ID == "" {
		return nil
	}
	return &ModelDTO{Provider: model.Provider, ID: model.ID}
}

func modelRef(model *ModelDTO) *ModelRefInput {
	if model == nil {
		return nil
	}
	return &ModelRefInput{Provider: model.Provider, ID: model.ID}
}

func normalizeChannel(channel string) string {
	switch strings.ToLower(strings.TrimSpace(channel)) {
	case EntryTelegram:
		return EntryTelegram
	case EntryWeChat:
		return EntryWeChat
	default:
		return ""
	}
}

func cloneInt64Pointer(values *[]int64) *[]int64 {
	if values == nil {
		return nil
	}
	cloned := append([]int64(nil), (*values)...)
	return &cloned
}

func secretInputValues(secrets []SecretEditDTO) []string {
	values := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		if secret.Value != "" {
			values = append(values, secret.Value)
		}
	}
	return values
}

func importSecretValues(secrets []ImportSecretDTO) []string {
	values := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		if secret.Value != "" {
			values = append(values, secret.Value)
		}
	}
	return values
}

func ReadPlainVar(settingsJSON []byte, name string) string {
	if len(settingsJSON) == 0 || name == "" {
		return ""
	}
	var document struct {
		Bindings []struct {
			Name string `json:"name"`
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"bindings"`
	}
	if err := json.Unmarshal(settingsJSON, &document); err != nil {
		return ""
	}
	for _, binding := range document.Bindings {
		if binding.Type == "plain_text" && binding.Name == name {
			return binding.Text
		}
	}
	return ""
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func (s *Service) serviceUnavailable() error {
	return domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.serviceUnavailable")}
}

func releaseErrorCode(err error) string {
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		return domainErr.Code
	}
	return CodeReleaseUnavailable
}

func (s *Service) releaseError(err error) error {
	switch {
	case errors.Is(err, release.ErrNotBundled):
		return domain.Error{Code: CodeReleaseNotBundled, Message: s.t("app.releaseNotBundled")}
	case errors.Is(err, release.ErrUntrusted):
		return domain.Error{Code: CodeReleaseUntrusted, Message: s.t("app.releaseUntrusted")}
	default:
		return domain.Error{Code: CodeReleaseUnavailable, Message: s.t("app.releaseUnavailable")}
	}
}

func appErrorCode(err error) string {
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		return domainErr.Code
	}
	return ""
}

// safeAppError preserves typed errors and redacts values that came from the
// current request. Lower layers already sanitize transport details.
func safeAppError(err error, values ...string) error {
	if err == nil {
		return nil
	}
	return redactedError(err, values...)
}

var operationRandReader io.Reader = rand.Reader

func randomOperationID() (string, error) {
	var random [16]byte
	if _, err := io.ReadFull(operationRandReader, random[:]); err != nil {
		return "", fmt.Errorf("app: generate operation id: %w", err)
	}
	return "login-" + hex.EncodeToString(random[:]), nil
}

// FileTargetStore persists the selected target as JSON in the app data
// directory. It contains no secret.
type FileTargetStore struct {
	path string
	mu   sync.Mutex
	// Locale supplies the language for validation messages; nil means zh.
	Locale func() string
}

func (s *FileTargetStore) lang() string {
	if s.Locale == nil {
		return i18n.ZH
	}
	return s.Locale()
}

type targetSettings struct {
	AccountID  string `json:"accountId"`
	ScriptName string `json:"scriptName"`
}

// NewFileTargetStore creates the app data directory if needed and returns a
// store at <dir>/settings.json.
func NewFileTargetStore(dir string) (*FileTargetStore, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("app: app data directory is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("app: create app data directory: %w", err)
	}
	return &FileTargetStore{path: filepath.Join(dir, "settings.json")}, nil
}

// Load returns the persisted target, or ok=false when none exists.
func (s *FileTargetStore) Load() (domain.Target, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return domain.Target{}, false, nil
	}
	if err != nil {
		return domain.Target{}, false, fmt.Errorf("app: read settings: %w", err)
	}
	var settings targetSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return domain.Target{}, false, fmt.Errorf("app: decode settings: %w", err)
	}
	if settings.AccountID == "" && settings.ScriptName == "" {
		return domain.Target{}, false, nil
	}
	if err := cloudflare.ValidateAccountID(settings.AccountID); err != nil {
		return domain.Target{}, false, fmt.Errorf("app: settings contain an invalid account id")
	}
	if err := cloudflare.ValidateWorkerName(settings.ScriptName); err != nil {
		return domain.Target{}, false, fmt.Errorf("app: settings contain an invalid Worker name")
	}
	return domain.Target{AccountID: settings.AccountID, ScriptName: settings.ScriptName}, true, nil
}

// Save writes the target atomically with owner-only permissions.
func (s *FileTargetStore) Save(target domain.Target) error {
	if err := cloudflare.ValidateAccountID(target.AccountID); err != nil {
		return domain.Error{Code: deployment.CodeInvalidRequest, Message: i18n.T(s.lang(), "app.accountIDInvalid")}
	}
	if err := cloudflare.ValidateWorkerName(target.ScriptName); err != nil {
		return domain.Error{Code: deployment.CodeInvalidRequest, Message: i18n.T(s.lang(), "app.workerNameInvalid")}
	}
	data, err := json.MarshalIndent(targetSettings{
		AccountID:  target.AccountID,
		ScriptName: target.ScriptName,
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("app: encode settings: %w", err)
	}
	data = append(data, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()
	return writeFileAtomic(s.path, data)
}
