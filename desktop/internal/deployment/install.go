package deployment

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/config"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
)

// Lifecycle error codes. They are stable values returned in domain.Error.Code.
const (
	CodeNameTaken                   = "NAME_TAKEN"
	CodeBucketTaken                 = "BUCKET_TAKEN"
	CodeSubdomainUnavailable        = "SUBDOMAIN_UNAVAILABLE"
	CodePlaintextSecretDetected     = "PLAINTEXT_SECRET_DETECTED"
	CodeVersionUnknown              = "VERSION_UNKNOWN"
	CodeVersionUnknownReimport      = "VERSION_UNKNOWN_REIMPORT"
	CodeDowngradeRejected           = "DOWNGRADE_REJECTED"
	CodeUpgradeRequiresIntermediate = "UPGRADE_REQUIRES_INTERMEDIATE"
	CodeMigrationHistoryMismatch    = "MIGRATION_HISTORY_MISMATCH"
	CodeIrreversibleMigration       = "IRREVERSIBLE_MIGRATION"
	CodeResourceIdentityChanged     = "RESOURCE_IDENTITY_CHANGED"
	CodeInstallConflict             = "INSTALL_CONFLICT"
	CodeOwnerRequired               = "OWNER_REQUIRED"
	CodeModelsRequired              = "MODELS_REQUIRED"
	CodeReleaseUnavailable          = "RELEASE_UNAVAILABLE"
	CodeVerifyFailed                = "VERIFY_FAILED"
	CodeInvalidRequest              = "INVALID_REQUEST"
	CodeConfigMissing               = "CONFIG_MISSING"
	CodeServiceNotFound             = "SERVICE_NOT_FOUND"
	CodeUpgradeRequiredFirst        = "UPGRADE_REQUIRED_FIRST"
	CodeUpgradeRequired             = "UPGRADE_REQUIRED"
	CodeOperationInProgress         = "OPERATION_IN_PROGRESS"
	CodeUploadRejected              = "UPLOAD_REJECTED"
	CodeIdentityUnverifiable        = "RESOURCE_IDENTITY_UNVERIFIABLE"
)

// Operation kinds recorded in the Task 6 journal.
const (
	KindInstall = "install"
	KindUpgrade = "upgrade"
)

// Message entry values accepted by ACTIVE_CHANNEL.
const (
	ChannelTelegram = "telegram"
	ChannelWeChat   = "wechat"
)

const (
	installStepPreflight = 0
	installStepBucket    = 1
	installStepScript    = 2
	installStepSubdomain = 3
	installStepPublicURL = 4
	installStepCron      = 5
	installStepVerify    = 6
)

// LifecycleAPI is the Cloudflare surface used by install, import and upgrade.
// cloudflare.Client implements it; tests inject a recording fake.
type LifecycleAPI interface {
	PublishAPI
	ListScripts(ctx context.Context, accountID string) ([]cloudflare.ScriptSummary, error)
	ListR2Buckets(ctx context.Context, accountID string) ([]cloudflare.R2Bucket, error)
	GetR2Bucket(ctx context.Context, accountID, name string) (cloudflare.R2Bucket, error)
	CreateR2Bucket(ctx context.Context, accountID, name string) error
	WorkersSubdomain(ctx context.Context, accountID string) (string, error)
	EnableWorkersDev(ctx context.Context, target domain.Target) error
	UploadScript(ctx context.Context, target domain.Target, manifestJSON []byte, modules map[string][]byte, plan cloudflare.ScriptUploadPlan) (cloudflare.ScriptResult, error)
	PutSchedules(ctx context.Context, target domain.Target, crons []string) error
	GetSchedules(ctx context.Context, target domain.Target) ([]string, error)
}

// InstallConfig is the owner and model input accepted by Install. Models must
// be JSON objects matching the shared schema. An empty owner list is valid:
// the Worker then ignores every Telegram user until an owner is published.
type InstallConfig struct {
	TelegramUserIDs []int64
	ButlerModel     json.RawMessage
	TaskModel       json.RawMessage
}

// InstallRequest is one from-scratch installation.
type InstallRequest struct {
	AccountID     string
	WorkerName    string
	BucketName    string
	Config        InstallConfig
	ActiveChannel string
}

// Lifecycle implements install, import and upgrade on top of the verified
// release package and the Task 6 journal.
type Lifecycle struct {
	api     LifecycleAPI
	journal *Journal
	pkg     release.Package
	creds   platform.CredentialStore
	clock   func() time.Time
	locker  *TargetLocker
	// Locale is inherited by the publish service Install, Import and Upgrade
	// create. Nil publishes no locale.
	Locale func() string
}

// NewLifecycle constructs the lifecycle service. The package must already be
// verified; a zero package is rejected by every operation that needs it.
func NewLifecycle(api LifecycleAPI, journal *Journal, pkg release.Package, creds platform.CredentialStore, clock func() time.Time) *Lifecycle {
	return NewLifecycleWithLocker(api, journal, pkg, creds, clock, NewTargetLocker())
}

// NewLifecycleWithLocker constructs the lifecycle service with a target lock
// shared with the configuration publish service, so install, import, upgrade
// and publish cannot interleave for the same Worker.
func NewLifecycleWithLocker(api LifecycleAPI, journal *Journal, pkg release.Package, creds platform.CredentialStore, clock func() time.Time, locker *TargetLocker) *Lifecycle {
	if clock == nil {
		clock = time.Now
	}
	if locker == nil {
		locker = NewTargetLocker()
	}
	return &Lifecycle{api: api, journal: journal, pkg: pkg, creds: creds, clock: clock, locker: locker}
}

// lang returns the locale used for user-facing text. A missing hook keeps the
// historical Chinese messages.
func (l *Lifecycle) lang() string {
	if l.Locale == nil {
		return i18n.ZH
	}
	return l.Locale()
}

func (l *Lifecycle) t(key string, args ...any) string {
	return i18n.T(l.lang(), key, args...)
}

// Install creates a new deployment. Every step is idempotent and journaled, so
// a lost response after a create is resolved on the next call instead of
// creating a second resource.
func (l *Lifecycle) Install(ctx context.Context, request InstallRequest) (domain.Result, error) {
	if l.journal == nil {
		return domain.Result{}, domain.Error{Code: CodeInvalidRequest, Message: "install requires an operation journal"}
	}
	if len(l.pkg.ManifestJSON()) == 0 {
		return domain.Result{}, domain.Error{Code: CodeReleaseUnavailable, Message: "no verified release package is available"}
	}
	if err := cloudflare.ValidateAccountID(request.AccountID); err != nil {
		return domain.Result{}, domain.Error{Code: CodeInvalidRequest, Message: err.Error()}
	}
	if err := cloudflare.ValidateWorkerName(request.WorkerName); err != nil {
		return domain.Result{}, domain.Error{Code: CodeInvalidRequest, Message: err.Error()}
	}
	if err := cloudflare.ValidateBucketName(request.BucketName); err != nil {
		return domain.Result{}, domain.Error{Code: CodeInvalidRequest, Message: err.Error()}
	}
	if request.ActiveChannel != ChannelTelegram && request.ActiveChannel != ChannelWeChat {
		return domain.Result{}, domain.Error{Code: CodeInvalidRequest, Message: "ACTIVE_CHANNEL must be telegram or wechat"}
	}
	configJSON, err := installConfigJSON(request, lifecycleLocale(l))
	if err != nil {
		return domain.Result{}, err
	}

	target := domain.Target{AccountID: request.AccountID, ScriptName: request.WorkerName}
	unlock, err := l.locker.Lock(ctx, target)
	if err != nil {
		return domain.Result{}, sanitizeError(err, nil)
	}
	defer unlock()
	record, found, err := l.findInstallRecord(target, request, configJSON)
	if err != nil {
		return domain.Result{}, err
	}
	if !found {
		operationID, err := newOperationID()
		if err != nil {
			return domain.Result{}, sanitizeError(err, nil)
		}
		record = OperationRecord{
			OperationID:    operationID,
			Kind:           KindInstall,
			Target:         target,
			State:          StatePlanned,
			Steps:          installSteps(l.lang()),
			ConfigJSON:     configJSON,
			BucketName:     request.BucketName,
			ReleaseVersion: l.pkg.Version(),
			ActiveChannel:  request.ActiveChannel,
			CreatedAt:      l.clock(),
		}
		if err := l.save(&record); err != nil {
			return operationResult(record), sanitizeError(err, nil)
		}
	}
	return l.runInstall(ctx, &record)
}

// Abandon cancels an unfinished install or upgrade record without changing any
// remote resource. Resources already created by that operation remain; an
// upgrade whose upload may have been sent requires a reconciliation before
// another upgrade.
func (l *Lifecycle) Abandon(ctx context.Context, operationID string) (domain.Result, error) {
	if l.journal == nil {
		return domain.Result{OperationID: operationID}, domain.Error{Code: CodeInvalidRequest, Message: "abandon requires an operation journal"}
	}
	record, err := l.journal.Load(operationID)
	if err != nil {
		return domain.Result{OperationID: operationID}, sanitizeError(err, nil)
	}
	if record.Kind != KindInstall && record.Kind != KindUpgrade {
		return operationResult(record), domain.Error{Code: CodeInvalidRequest, Message: "only install or upgrade operations can be abandoned here"}
	}
	unlock, err := l.locker.Lock(ctx, record.Target)
	if err != nil {
		return operationResult(record), sanitizeError(err, nil)
	}
	defer unlock()
	if record.State == StatePublished {
		return operationResult(record), errors.New("deployment: cannot abandon a published operation")
	}
	if record.State == StateCancelled {
		return operationResult(record), nil
	}
	record.State = StateCancelled
	if record.Kind == KindUpgrade {
		setStep(&record, 1, StateCancelled, l.t("deployment.abandonUpgradeCancelled"), "")
	} else {
		setStep(&record, installStepPreflight, StateCancelled, l.t("deployment.abandonInstallCancelled"), "")
	}
	if err := l.save(&record); err != nil {
		return operationResult(record), err
	}
	return operationResult(record), nil
}

func definitiveClientError(err error) bool {
	var apiErr *cloudflare.APIError
	return errors.As(err, &apiErr) && apiErr.Status >= 400 && apiErr.Status < 500 && apiErr.Status != 409
}

func lifecycleLocale(l *Lifecycle) string {
	if l.Locale == nil {
		return ""
	}
	return l.Locale()
}

func installConfigJSON(request InstallRequest, locale string) ([]byte, error) {
	ids := append([]int64(nil), request.Config.TelegramUserIDs...)
	patch := domain.EditablePatch{TelegramUserIDs: &ids}
	if locale != "" {
		patch.Locale = &locale
	}
	if len(request.Config.ButlerModel) > 0 {
		raw := append(json.RawMessage(nil), request.Config.ButlerModel...)
		patch.ButlerModel = &raw
	}
	if len(request.Config.TaskModel) > 0 {
		raw := append(json.RawMessage(nil), request.Config.TaskModel...)
		patch.TaskModel = &raw
	}
	base := domain.Snapshot{
		Target:      domain.Target{AccountID: request.AccountID, ScriptName: request.WorkerName},
		Fingerprint: "install",
		VersionID:   "install",
	}
	plan, err := config.Merge(base, domain.Change{BaseFingerprint: "install", Patch: patch})
	if err != nil {
		return nil, err
	}
	return plan.ConfigJSON, nil
}

// findInstallRecord finds an unfinished install for the same target. A
// different bucket or configuration is a conflict because retrying with new
// inputs could attach the new Worker to resources owned by the earlier run.
func (l *Lifecycle) findInstallRecord(target domain.Target, request InstallRequest, configJSON []byte) (OperationRecord, bool, error) {
	records, err := l.journal.List()
	if err != nil {
		return OperationRecord{}, false, sanitizeError(err, nil)
	}
	var latest *OperationRecord
	for i := range records {
		record := records[i]
		if record.Kind != KindInstall || record.Target != target {
			continue
		}
		if record.State == StatePublished || record.State == StateCancelled {
			continue
		}
		// A failed preflight created nothing and must not trap a corrected
		// retry under the old operation.
		if record.State == StateFailed && !record.BucketCreateAttempted && !record.ScriptUploadAttempted {
			continue
		}
		if latest == nil || record.UpdatedAt.After(latest.UpdatedAt) {
			copied := record
			latest = &copied
		}
	}
	if latest == nil {
		return OperationRecord{}, false, nil
	}
	if latest.BucketName != request.BucketName || latest.ActiveChannel != request.ActiveChannel || !sameJSONIgnoringLocale(latest.ConfigJSON, configJSON) {
		return OperationRecord{}, false, domain.Error{
			Code:    CodeInstallConflict,
			Message: "an unfinished install for this Worker uses different settings; finish or cancel it before starting another",
		}
	}
	return *latest, true, nil
}

func (l *Lifecycle) runInstall(ctx context.Context, record *OperationRecord) (domain.Result, error) {
	if err := ctx.Err(); err != nil {
		record.State = StateCancelled
		record.UpdatedAt = l.clock()
		_ = l.journal.Save(*record)
		return operationResult(*record), sanitizeError(err, nil)
	}

	if err := l.installPreflight(ctx, record); err != nil {
		return operationResult(*record), err
	}
	if err := l.installBucket(ctx, record); err != nil {
		return operationResult(*record), err
	}
	if err := l.installScript(ctx, record); err != nil {
		return operationResult(*record), err
	}
	if err := l.installSubdomain(ctx, record); err != nil {
		return operationResult(*record), err
	}
	if err := l.installPublicURL(record); err != nil {
		return operationResult(*record), err
	}
	if err := l.installCron(ctx, record); err != nil {
		return operationResult(*record), err
	}
	if err := l.installVerify(ctx, record); err != nil {
		return operationResult(*record), err
	}
	return operationResult(*record), nil
}

func (l *Lifecycle) installPreflight(ctx context.Context, record *OperationRecord) error {
	target := record.Target
	scripts, err := l.api.ListScripts(ctx, target.AccountID)
	if err != nil {
		return l.installFailure(record, installStepPreflight, StateFailed, CodeInvalidRequest, l.t("deployment.listScriptsPermission"), err)
	}
	buckets, err := l.api.ListR2Buckets(ctx, target.AccountID)
	if err != nil {
		return l.installFailure(record, installStepPreflight, StateFailed, CodeInvalidRequest, l.t("deployment.listBucketsPermission"), err)
	}
	subdomain, err := l.api.WorkersSubdomain(ctx, target.AccountID)
	if err != nil {
		return l.installFailure(record, installStepPreflight, StateFailed, CodeSubdomainUnavailable, l.t("deployment.subdomainUnavailable"), err)
	}

	if scriptExists(scripts, target.ScriptName) && !record.ScriptUploadAttempted {
		return l.installFailure(record, installStepPreflight, StateFailed, CodeNameTaken, l.t("deployment.workerNameTakenTakeover"), nil)
	}
	if bucketExists(buckets, record.BucketName) && !record.BucketCreateAttempted {
		return l.installFailure(record, installStepPreflight, StateFailed, CodeBucketTaken, l.t("deployment.bucketTakenTakeover"), nil)
	}
	if record.PublicBaseURL == "" {
		record.PublicBaseURL = "https://" + target.ScriptName + "." + subdomain + ".workers.dev"
	}
	setStep(record, installStepPreflight, StatePublished, l.t("deployment.preflightConfirmed"), "")
	record.State = StateApplying
	return l.saveChecked(record)
}

func (l *Lifecycle) installBucket(ctx context.Context, record *OperationRecord) error {
	if record.Steps[installStepBucket].State == StatePublished {
		return nil
	}
	setStep(record, installStepBucket, StateApplying, l.t("deployment.creatingBucket"), "")
	record.State = StateApplying
	if err := l.saveChecked(record); err != nil {
		return err
	}

	_, err := l.api.GetR2Bucket(ctx, record.Target.AccountID, record.BucketName)
	switch {
	case err == nil:
		if !record.BucketCreateAttempted {
			return l.installFailure(record, installStepBucket, StateFailed, CodeBucketTaken, l.t("deployment.bucketTaken"), nil)
		}
	case !errors.Is(err, cloudflare.ErrNotFound):
		return l.installUnknown(record, installStepBucket, err)
	}

	if errors.Is(err, cloudflare.ErrNotFound) || (err == nil && !record.BucketCreateAttempted) {
		record.BucketCreateAttempted = true
		record.UpdatedAt = l.clock()
		if err := l.journal.Save(*record); err != nil {
			return sanitizeError(err, nil)
		}
		if createErr := l.api.CreateR2Bucket(ctx, record.Target.AccountID, record.BucketName); createErr != nil {
			if errors.Is(createErr, cloudflare.ErrAlreadyExists) {
				if record.BucketCreateAttempted {
					setStep(record, installStepBucket, StatePublished, l.t("deployment.bucketPreviousConfirmed"), record.BucketName)
					return l.saveChecked(record)
				}
				return l.installFailure(record, installStepBucket, StateFailed, CodeBucketTaken, l.t("deployment.bucketAlreadyExists"), createErr)
			}
			if definitiveClientError(createErr) {
				record.BucketCreateAttempted = false
				return l.installFailure(record, installStepBucket, StateFailed, CodeInvalidRequest, l.t("deployment.bucketCreateRejected"), createErr)
			}
			return l.installUnknown(record, installStepBucket, createErr)
		}
	}
	setStep(record, installStepBucket, StatePublished, l.t("deployment.bucketReady"), record.BucketName)
	return l.saveChecked(record)
}

func (l *Lifecycle) installScript(ctx context.Context, record *OperationRecord) error {
	if record.Steps[installStepScript].State == StatePublished {
		return nil
	}
	setStep(record, installStepScript, StateApplying, l.t("deployment.scriptUploading"), "")
	record.State = StateApplying
	if err := l.saveChecked(record); err != nil {
		return err
	}

	scripts, err := l.api.ListScripts(ctx, record.Target.AccountID)
	if err != nil {
		return l.installFailure(record, installStepScript, StateFailed, CodeInvalidRequest, l.t("deployment.listScriptsFailed"), err)
	}
	exists := scriptExists(scripts, record.Target.ScriptName)
	if exists && !record.ScriptUploadAttempted {
		return l.installFailure(record, installStepScript, StateFailed, CodeNameTaken, l.t("deployment.workerNameTakenTakeover"), nil)
	}
	if exists && record.Steps[installStepScript].State == StatePublished {
		return nil
	}

	baseTag := ""
	if exists {
		baseTag = migrationTag(scripts, record.Target.ScriptName)
	}
	manifest := l.pkg.Manifest()
	plainVars := map[string]string{}
	for _, name := range manifest.ResourceTemplate.PlainVars {
		switch name {
		case "PUBLIC_BASE_URL":
			plainVars[name] = record.PublicBaseURL
		case "ACTIVE_CHANNEL":
			plainVars[name] = record.ActiveChannel
		default:
			plainVars[name] = ""
		}
	}

	record.ScriptUploadAttempted = true
	record.UpdatedAt = l.clock()
	if err := l.journal.Save(*record); err != nil {
		return sanitizeError(err, nil)
	}
	result, err := l.api.UploadScript(ctx, record.Target, l.pkg.ManifestJSON(), l.pkg.Modules(), cloudflare.ScriptUploadPlan{
		ConfigJSON: record.ConfigJSON,
		BucketName: record.BucketName,
		PlainVars:  plainVars,
		BaseTag:    baseTag,
		Message:    "DeskWand Bot install " + record.OperationID,
	})
	if err != nil {
		if isNotSent(err) || errCode(err) == CodeMigrationHistoryMismatch || definitiveClientError(err) {
			record.ScriptUploadAttempted = false
			code := errCodeOrDefault(err, CodeInvalidRequest)
			if definitiveClientError(err) {
				code = CodeUploadRejected
			}
			return l.installFailure(record, installStepScript, StateFailed, code, l.t("deployment.uploadRejected"), err)
		}
		return l.installUnknown(record, installStepScript, err)
	}
	setStep(record, installStepScript, StatePublished, l.t("deployment.scriptUploaded"), result.MigrationTag)
	return l.saveChecked(record)
}

func (l *Lifecycle) installSubdomain(ctx context.Context, record *OperationRecord) error {
	if record.Steps[installStepSubdomain].State == StatePublished {
		return nil
	}
	setStep(record, installStepSubdomain, StateApplying, l.t("deployment.enablingSubdomain"), "")
	if err := l.saveChecked(record); err != nil {
		return err
	}
	if err := l.api.EnableWorkersDev(ctx, record.Target); err != nil {
		return l.installFailure(record, installStepSubdomain, StateFailed, CodeInvalidRequest, l.t("deployment.enableSubdomainFailed"), err)
	}
	setStep(record, installStepSubdomain, StatePublished, l.t("deployment.subdomainEnabled"), record.PublicBaseURL)
	return l.saveChecked(record)
}

func (l *Lifecycle) installPublicURL(record *OperationRecord) error {
	if record.Steps[installStepPublicURL].State == StatePublished {
		return nil
	}
	parsed, err := url.Parse(record.PublicBaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return l.installFailure(record, installStepPublicURL, StateFailed, CodeSubdomainUnavailable, l.t("deployment.publicURLInvalid"), err)
	}
	setStep(record, installStepPublicURL, StatePublished, l.t("deployment.publicURLConfirmed"), record.PublicBaseURL)
	return l.saveChecked(record)
}

func (l *Lifecycle) installCron(ctx context.Context, record *OperationRecord) error {
	if record.Steps[installStepCron].State == StatePublished {
		return nil
	}
	crons := append([]string(nil), l.pkg.Manifest().ResourceTemplate.Crons...)
	current, err := l.api.GetSchedules(ctx, record.Target)
	if err != nil {
		return l.installFailure(record, installStepCron, StateFailed, CodeInvalidRequest, l.t("deployment.readSchedulesFailed"), err)
	}
	if !sameStrings(current, crons) {
		setStep(record, installStepCron, StateApplying, l.t("deployment.writingSchedules"), "")
		if err := l.saveChecked(record); err != nil {
			return err
		}
		if err := l.api.PutSchedules(ctx, record.Target, crons); err != nil {
			return l.installUnknown(record, installStepCron, err)
		}
	}
	setStep(record, installStepCron, StatePublished, l.t("deployment.schedulesReady"), strings.Join(crons, ","))
	return l.saveChecked(record)
}

func (l *Lifecycle) installVerify(ctx context.Context, record *OperationRecord) error {
	setStep(record, installStepVerify, StateApplying, l.t("deployment.readingInstallResult"), "")
	record.State = StateVerifying
	if err := l.saveChecked(record); err != nil {
		return err
	}
	snapshot, err := l.api.ReadSnapshot(ctx, record.Target)
	if err != nil {
		return l.installUnknown(record, installStepVerify, err)
	}
	if snapshot.VersionID == "" || snapshot.ActiveVersionCount != 1 {
		return l.installUnknown(record, installStepVerify, fmt.Errorf("deployment has no single active version"))
	}
	if !sameJSON(snapshot.ConfigJSON, record.ConfigJSON) {
		return l.installFailure(record, installStepVerify, StateUnknown, CodeVerifyFailed, l.t("deployment.installConfigMismatch"), nil)
	}
	if snapshot.ReleaseVersion != l.pkg.Version() {
		return l.installFailure(record, installStepVerify, StateUnknown, CodeVerifyFailed, l.t("deployment.installVersionMismatch"), nil)
	}
	record.DeploymentID = snapshot.DeploymentID
	record.StagedVersionID = snapshot.VersionID
	record.State = StatePublished
	setStep(record, installStepVerify, StatePublished, l.t("deployment.installComplete"), snapshot.VersionID)
	return l.saveChecked(record)
}

func (l *Lifecycle) save(record *OperationRecord) error {
	record.UpdatedAt = l.clock()
	if err := l.journal.Save(*record); err != nil {
		return sanitizeError(err, nil)
	}
	return nil
}

func (l *Lifecycle) saveChecked(record *OperationRecord) error {
	record.UpdatedAt = l.clock()
	if err := l.journal.Save(*record); err != nil {
		return sanitizeError(err, nil)
	}
	return nil
}

func (l *Lifecycle) installFailure(record *OperationRecord, step int, state, code, message string, cause error) error {
	if code == "" {
		code = CodeInvalidRequest
	}
	record.State = state
	record.FailureCode = code
	setStep(record, step, state, message, errorEvidence(cause))
	_ = l.save(record)
	return domain.Error{Code: code, Message: message}
}

func (l *Lifecycle) installUnknown(record *OperationRecord, step int, cause error) error {
	record.State = StateUnknown
	setStep(record, step, StateUnknown, l.t("deployment.unknownResult"), errorEvidence(cause))
	_ = l.save(record)
	return sanitizeError(cause, nil)
}

func installSteps(locale string) []domain.Step {
	return []domain.Step{
		{ID: "preflight", State: StatePlanned, Message: i18n.T(locale, "deployment.installPreflightWaiting")},
		{ID: "bucket", State: StatePlanned, Message: i18n.T(locale, "deployment.installBucketWaiting")},
		{ID: "script", State: StatePlanned, Message: i18n.T(locale, "deployment.installScriptWaiting")},
		{ID: "subdomain", State: StatePlanned, Message: i18n.T(locale, "deployment.installSubdomainWaiting")},
		{ID: "public-url", State: StatePlanned, Message: i18n.T(locale, "deployment.installPublicURLWaiting")},
		{ID: "cron", State: StatePlanned, Message: i18n.T(locale, "deployment.installCronWaiting")},
		{ID: "verify", State: StatePlanned, Message: i18n.T(locale, "deployment.installVerifyWaiting")},
	}
}

func scriptExists(scripts []cloudflare.ScriptSummary, name string) bool {
	for _, script := range scripts {
		if script.ID == name {
			return true
		}
	}
	return false
}

func migrationTag(scripts []cloudflare.ScriptSummary, name string) string {
	for _, script := range scripts {
		if script.ID == name {
			return script.MigrationTag
		}
	}
	return ""
}

func bucketExists(buckets []cloudflare.R2Bucket, name string) bool {
	for _, bucket := range buckets {
		if bucket.Name == name {
			return true
		}
	}
	return false
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	left := append([]string(nil), a...)
	right := append([]string(nil), b...)
	sort.Strings(left)
	sort.Strings(right)
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func sameJSON(a, b []byte) bool {
	canonicalA, errA := domain.CanonicalizeJSON(a)
	canonicalB, errB := domain.CanonicalizeJSON(b)
	if errA != nil || errB != nil {
		return false
	}
	return string(canonicalA) == string(canonicalB)
}

// sameJSONIgnoringLocale compares two configuration documents without their
// top-level locale. Resuming an install must tolerate a language change or a
// record written by a client that did not publish a locale yet; the resumed
// upload still uses the recorded configuration.
func sameJSONIgnoringLocale(a, b []byte) bool {
	left, okLeft := withoutLocale(a)
	right, okRight := withoutLocale(b)
	if !okLeft || !okRight {
		return sameJSON(a, b)
	}
	return sameJSON(left, right)
}

func withoutLocale(raw []byte) ([]byte, bool) {
	value, err := domain.DecodeJSON(raw)
	if err != nil {
		return nil, false
	}
	document, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	delete(document, "locale")
	canonical, err := domain.CanonicalJSON(document)
	if err != nil {
		return nil, false
	}
	return canonical, true
}

func errCodeOrDefault(err error, fallback string) string {
	if code := errCode(err); code != "" {
		return code
	}
	return fallback
}
