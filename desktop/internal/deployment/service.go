package deployment

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/config"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
	"github.com/deskwand/bot/desktop/internal/release"
)

// Publish states. planned/applying/verifying are in-flight; published and
// failed are terminal; needs_input waits for credentials; unknown means a
// mutation may have happened and Resume must reconcile before anything else.
const (
	StatePlanned    = "planned"
	StateApplying   = "applying"
	StateVerifying  = "verifying"
	StatePublished  = "published"
	StateNeedsInput = "needs_input"
	StateUnknown    = "unknown"
	StateFailed     = "failed"
	StateCancelled  = "cancelled"
)

const (
	stepStage    = 0
	stepActivate = 1
	stepVerify   = 2
)

// PublishAPI is the consumer-owned subset of cloudflare.Client used by the
// publish state machine. Tests inject a recording fake with the same shape.
type PublishAPI interface {
	ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error)
	CreateVersion(ctx context.Context, base domain.Snapshot, manifestJSON []byte, modules map[string][]byte, plan domain.PublishPlan, preserve cloudflare.PreservePolicy) (string, error)
	ActivateVersion(ctx context.Context, target domain.Target, versionID string) (domain.Result, error)
	FindVersionByOperation(ctx context.Context, target domain.Target, operationID string) (versionID string, isLatest bool, found bool, err error)
}

// TargetLocker serializes operations for one account/script across Service
// instances and the lifecycle operations. A nil locker is not usable; use
// NewTargetLocker.
type TargetLocker struct {
	mu    sync.Mutex
	locks map[string]chan struct{}
}

// NewTargetLocker constructs an empty per-target lock set.
func NewTargetLocker() *TargetLocker {
	return &TargetLocker{locks: map[string]chan struct{}{}}
}

// Lock waits for the target lock and returns its release function.
func (l *TargetLocker) Lock(ctx context.Context, target domain.Target) (func(), error) {
	if l == nil {
		return nil, errors.New("deployment: no target locker is configured")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := target.AccountID + "/" + target.ScriptName
	l.mu.Lock()
	semaphore := l.locks[key]
	if semaphore == nil {
		semaphore = make(chan struct{}, 1)
		semaphore <- struct{}{}
		l.locks[key] = semaphore
	}
	l.mu.Unlock()

	select {
	case <-semaphore:
		return func() { semaphore <- struct{}{} }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Service executes Preview/Apply/Resume/Abandon with a per-target lock, a
// durable journal and a verified release package.
type Service struct {
	api     PublishAPI
	journal *Journal
	creds   platform.CredentialStore
	pkg     release.Package
	clock   func() time.Time
	locker  *TargetLocker
}

// NewService constructs a publish service. clock may be nil; time.Now is used.
func NewService(api PublishAPI, journal *Journal, creds platform.CredentialStore, pkg release.Package, clock func() time.Time) *Service {
	return NewServiceWithLocker(api, journal, creds, pkg, clock, NewTargetLocker())
}

// NewServiceWithLocker constructs a publish service sharing a target lock set
// with other lifecycle operations.
func NewServiceWithLocker(api PublishAPI, journal *Journal, creds platform.CredentialStore, pkg release.Package, clock func() time.Time, locker *TargetLocker) *Service {
	if clock == nil {
		clock = time.Now
	}
	if locker == nil {
		locker = NewTargetLocker()
	}
	return &Service{
		api:     api,
		journal: journal,
		creds:   creds,
		pkg:     pkg,
		clock:   clock,
		locker:  locker,
	}
}

// Preview reads the current snapshot and merges the change without writing
// anything. The returned steps describe what Apply would do and include the
// documented race where another actor replaces only a secret value.
func (s *Service) Preview(ctx context.Context, target domain.Target, change domain.Change) ([]domain.Step, error) {
	snapshot, err := s.api.ReadSnapshot(ctx, target)
	if err != nil {
		return nil, sanitizeError(err, nil)
	}
	steps := previewStepsFor(snapshot, s.pkg.Version())
	if err := s.checkReleaseVersion(snapshot, change.AllowReleaseChange); err != nil {
		return steps, sanitizeError(err, secretValues(change.Secrets))
	}
	_, err = config.Merge(snapshot, change)
	if err != nil {
		return steps, sanitizeError(err, secretValues(change.Secrets))
	}
	return steps, nil
}

// checkReleaseVersion prevents an ordinary configuration publish from silently
// changing the deployed release: every versioned upload carries the embedded
// Worker code. Import and upgrade set AllowReleaseChange explicitly.
func (s *Service) checkReleaseVersion(snapshot domain.Snapshot, allowChange bool) error {
	if allowChange {
		return nil
	}
	clientVersion := s.pkg.Version()
	if snapshot.ReleaseVersion == "" {
		return domain.Error{
			Code:    CodeVersionUnknownReimport,
			Message: "云端版本未知（可能用命令行部署过）；请在“连接已有服务”中重新导入",
		}
	}
	if clientVersion == "" {
		return domain.Error{Code: CodeUpgradeRequired, Message: "请先在“更新”页升级云端服务"}
	}
	comparison, comparable := CompareVersions(snapshot.ReleaseVersion, clientVersion)
	if !comparable {
		return domain.Error{Code: CodeUpgradeRequired, Message: "请先在“更新”页升级云端服务"}
	}
	if comparison > 0 {
		return domain.Error{Code: CodeDowngradeRejected, Message: "云端版本较新，请先升级客户端"}
	}
	if comparison < 0 {
		return domain.Error{Code: CodeUpgradeRequired, Message: "请先在“更新”页升级云端服务"}
	}
	return nil
}

func previewStepsFor(snapshot domain.Snapshot, clientVersion string) []domain.Step {
	cloudVersion := snapshot.ReleaseVersion
	if cloudVersion == "" {
		cloudVersion = "未知"
	}
	if clientVersion == "" {
		clientVersion = "未知"
	}
	steps := make([]domain.Step, 0, len(previewSteps())+1)
	steps = append(steps, domain.Step{
		ID:       "release",
		State:    "info",
		Message:  fmt.Sprintf("云端版本 %s；客户端版本 %s", cloudVersion, clientVersion),
		Evidence: snapshot.VersionID,
	})
	steps = append(steps, previewSteps()...)
	return steps
}

// Apply always allocates an operation id first, journals the operation, then
// stages and activates the verified release. It never repeats a mutation
// whose response was lost; those operations return state unknown together
// with the operation id.
func (s *Service) Apply(ctx context.Context, target domain.Target, change domain.Change) (domain.Result, error) {
	opID, err := newOperationID()
	if err != nil {
		return domain.Result{}, sanitizeError(err, nil)
	}
	unlock, err := s.lockTarget(ctx, target)
	if err != nil {
		return domain.Result{OperationID: opID}, sanitizeError(err, nil)
	}
	defer unlock()

	record := OperationRecord{
		OperationID:        opID,
		Target:             target,
		State:              StatePlanned,
		Steps:              applySteps(),
		AllowReleaseChange: change.AllowReleaseChange,
		CreatedAt:          s.clock(),
		UpdatedAt:          s.clock(),
	}
	if err := s.journal.Save(record); err != nil {
		return operationResult(record), sanitizeError(err, secretValues(change.Secrets))
	}

	snapshot, err := s.api.ReadSnapshot(ctx, target)
	if err != nil {
		return s.fail(&record, stepStage, err, secretValues(change.Secrets))
	}
	if err := s.checkReleaseVersion(snapshot, change.AllowReleaseChange); err != nil {
		return s.fail(&record, stepStage, err, secretValues(change.Secrets))
	}
	plan, err := config.Merge(snapshot, change)
	if err != nil {
		return s.fail(&record, stepStage, err, secretValues(change.Secrets))
	}

	record.BaseFingerprint = snapshot.Fingerprint
	record.BaseVersionID = snapshot.VersionID
	record.ConfigJSON = append(json.RawMessage(nil), plan.ConfigJSON...)
	record.Vars = cloneVars(plan.Vars)
	record.SecretEdits = cloneSecretEdits(plan.Secrets)

	if err := ctx.Err(); err != nil {
		record.State = StateCancelled
		setStep(&record, stepStage, StateCancelled, "发布已取消，尚未修改任何远端状态", "")
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(record)
		return operationResult(record), sanitizeError(err, secretValues(plan.Secrets))
	}

	refs, err := s.storePendingSecrets(ctx, opID, plan.Secrets)
	record.SecretRefs = refs
	if err != nil {
		record.State = StateNeedsInput
		setStep(&record, stepStage, StateNeedsInput, "需要重新输入 secrets：系统凭据库不可用", "")
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(record)
		cleanupErr := s.cleanupPending(context.Background(), &record)
		return operationResult(record), errors.Join(sanitizeError(err, secretValues(plan.Secrets)), cleanupErr)
	}
	if err := s.journal.Save(record); err != nil {
		cleanupErr := s.cleanupPending(context.Background(), &record)
		return operationResult(record), errors.Join(sanitizeError(err, secretValues(plan.Secrets)), cleanupErr)
	}

	staged, err := s.stage(ctx, &record, snapshot, plan)
	if err != nil {
		return operationResult(record), err
	}
	return s.activateAndVerify(ctx, &record, staged)
}

// Resume reconciles the journaled operation against the current deployment
// before doing anything else. It positively identifies our uploaded version
// by its operation annotation. A staged version that is already active is
// published without re-activating; an inactive staged version is activated
// once; a stage that never happened is retried only while the pending secret
// values remain in the credential store and nobody else changed the snapshot.
func (s *Service) Resume(ctx context.Context, operationID string) (domain.Result, error) {
	record, err := s.journal.Load(operationID)
	if err != nil {
		return domain.Result{OperationID: operationID}, sanitizeError(err, nil)
	}
	unlock, err := s.lockTarget(ctx, record.Target)
	if err != nil {
		return operationResult(record), sanitizeError(err, nil)
	}
	defer unlock()

	switch record.State {
	case StatePublished, StateCancelled:
		// I6: a cancelled operation must never be activated by Resume.
		cleanupErr := s.cleanupPending(context.Background(), &record)
		return operationResult(record), cleanupErr
	case StateFailed:
		if record.StagedVersionID == "" && record.FailureCode != domain.NOT_SENT {
			cleanupErr := s.cleanupPending(context.Background(), &record)
			return operationResult(record), errors.Join(failureError(record), cleanupErr)
		}
	}
	if record.CleanupPending {
		if cleanupErr := s.cleanupPending(context.Background(), &record); cleanupErr != nil {
			return operationResult(record), cleanupErr
		}
	}

	snapshot, err := s.api.ReadSnapshot(ctx, record.Target)
	if err != nil {
		return operationResult(record), sanitizeError(err, s.pendingValues(context.Background(), record))
	}

	// Already active: we can prove this operation succeeded without another
	// activation. This short-circuit precedes the base-version check below.
	if record.StagedVersionID != "" && snapshot.VersionID == record.StagedVersionID {
		return s.markPublished(&record, snapshot)
	}

	if err := s.checkReleaseVersion(snapshot, record.AllowReleaseChange); err != nil {
		return s.fail(&record, stepStage, err, s.pendingValues(context.Background(), record))
	}

	// I1: only activate from the version this operation was based on. Any
	// other active version means somebody else changed the deployment.
	if record.BaseVersionID == "" || snapshot.VersionID != record.BaseVersionID {
		return s.fail(&record, stepStage, domain.Error{
			Code:    domain.CONFIG_CONFLICT,
			Message: "the active version changed after this operation started; refresh before publishing",
		}, s.pendingValues(context.Background(), record))
	}

	if record.StageAttempted {
		versionID, isLatest, found, err := s.api.FindVersionByOperation(ctx, record.Target, record.OperationID)
		if err != nil {
			return operationResult(record), sanitizeError(err, s.pendingValues(context.Background(), record))
		}
		switch {
		case found && isLatest:
			record.StagedVersionID = versionID
			setStep(&record, stepStage, StateApplying, "已确认本操作上传的版本，继续部署", versionID)
			record.UpdatedAt = s.clock()
			if err := s.journal.Save(record); err != nil {
				return operationResult(record), sanitizeError(err, s.pendingValues(context.Background(), record))
			}
			return s.activateAndVerify(ctx, &record, versionID)
		case found && !isLatest:
			return s.fail(&record, stepStage, domain.Error{
				Code:    domain.CONFIG_CONFLICT,
				Message: "another version was uploaded after this operation's version; refresh before publishing",
			}, s.pendingValues(context.Background(), record))
		case snapshot.LatestVersionID != record.BaseVersionID:
			return s.fail(&record, stepStage, domain.Error{
				Code:    domain.CONFIG_CONFLICT,
				Message: "the latest uploaded version is not owned by this operation; refresh before publishing",
			}, s.pendingValues(context.Background(), record))
		}
		// Not found and still at the base: a pre-upload failure may be safely
		// retried after checking the fingerprint and pending secret values.
	} else if snapshot.LatestVersionID != record.BaseVersionID {
		return s.fail(&record, stepStage, domain.Error{
			Code:    domain.CONFIG_CONFLICT,
			Message: "the latest uploaded version changed by another actor; refresh before publishing",
		}, s.pendingValues(context.Background(), record))
	}

	if snapshot.Fingerprint != record.BaseFingerprint {
		return s.fail(&record, stepStage, domain.Error{
			Code:    domain.CONFIG_CONFLICT,
			Message: "the configuration changed after this operation started; refresh before publishing",
		}, s.pendingValues(context.Background(), record))
	}

	plan, err := s.planFromJournal(ctx, record)
	if err != nil {
		record.State = StateNeedsInput
		setStep(&record, stepStage, StateNeedsInput, "需要重新输入 secrets：待发布的值已不在系统凭据库中", "")
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(record)
		cleanupErr := s.cleanupPending(context.Background(), &record)
		return operationResult(record), errors.Join(sanitizeError(err, s.pendingValues(context.Background(), record)), cleanupErr)
	}

	staged, err := s.stage(ctx, &record, snapshot, plan)
	if err != nil {
		return operationResult(record), err
	}
	return s.activateAndVerify(ctx, &record, staged)
}

// Abandon cancels an operation only when it has no active or pending staged
// version. Pending credential values are deleted and cleanup failures are
// journaled for a later Resume.
func (s *Service) Abandon(ctx context.Context, operationID string) (domain.Result, error) {
	record, err := s.journal.Load(operationID)
	if err != nil {
		return domain.Result{OperationID: operationID}, sanitizeError(err, nil)
	}
	unlock, err := s.lockTarget(ctx, record.Target)
	if err != nil {
		return operationResult(record), sanitizeError(err, nil)
	}
	defer unlock()

	if record.State == StateCancelled {
		cleanupErr := s.cleanupPending(context.Background(), &record)
		return operationResult(record), cleanupErr
	}
	if record.State == StatePublished {
		return operationResult(record), errors.New("deployment: cannot abandon a published operation")
	}

	snapshot, err := s.api.ReadSnapshot(ctx, record.Target)
	if err != nil {
		return operationResult(record), sanitizeError(err, s.pendingValues(context.Background(), record))
	}
	if record.StagedVersionID != "" {
		if snapshot.VersionID == record.StagedVersionID || snapshot.LatestVersionID == record.StagedVersionID {
			return operationResult(record), errors.New("deployment: cannot abandon while a staged version is active or pending")
		}
	}
	if record.StageAttempted {
		versionID, isLatest, found, err := s.api.FindVersionByOperation(ctx, record.Target, record.OperationID)
		if err != nil {
			return operationResult(record), sanitizeError(err, s.pendingValues(context.Background(), record))
		}
		if found && (isLatest || snapshot.VersionID == versionID) {
			return operationResult(record), errors.New("deployment: cannot abandon while a staged version is active or pending")
		}
	}

	record.State = StateCancelled
	setStep(&record, stepStage, StateCancelled, "操作已取消", "")
	record.UpdatedAt = s.clock()
	if err := s.journal.Save(record); err != nil {
		return operationResult(record), sanitizeError(err, s.pendingValues(context.Background(), record))
	}
	cleanupErr := s.cleanupPending(context.Background(), &record)
	return operationResult(record), cleanupErr
}

func (s *Service) stage(ctx context.Context, record *OperationRecord, snapshot domain.Snapshot, plan domain.PublishPlan) (string, error) {
	if err := ctx.Err(); err != nil {
		record.State = StateCancelled
		setStep(record, stepStage, StateCancelled, "发布已取消，尚未上传版本", "")
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(*record)
		cleanupErr := s.cleanupPending(context.Background(), record)
		return "", errors.Join(sanitizeError(err, secretValues(plan.Secrets)), cleanupErr)
	}

	record.State = StateApplying
	record.StageAttempted = true
	setStep(record, stepStage, StateApplying, "正在上传新版本（配置与 secrets）", "")
	record.UpdatedAt = s.clock()
	if err := s.journal.Save(*record); err != nil {
		return "", sanitizeError(err, secretValues(plan.Secrets))
	}

	preserve := cloudflare.PreservePolicy{
		SecretNames: append([]string(nil), snapshot.SecretNames...),
		OperationID: record.OperationID,
	}
	staged, err := s.api.CreateVersion(ctx, snapshot, s.pkg.ManifestJSON(), s.pkg.Modules(), plan, preserve)
	if err != nil {
		switch {
		case isLatestNotBase(err):
			record.StageAttempted = false
			_, sanitized := s.failWithValues(record, stepStage, err, secretValues(plan.Secrets))
			return "", sanitized
		case isNotSent(err):
			// The upload never left the client. Keep pending secret values so
			// a later Resume or a new Apply can retry without re-entry.
			record.StageAttempted = false
			record.State = StateFailed
			record.FailureCode = domain.NOT_SENT
			setStep(record, stepStage, StateFailed, "上传未发出，可稍后重试", errorEvidence(err))
			record.UpdatedAt = s.clock()
			_ = s.journal.Save(*record)
			return "", sanitizeError(err, secretValues(plan.Secrets))
		default:
			record.State = StateUnknown
			setStep(record, stepStage, StateUnknown, "上传结果未知；不会自动重试，请恢复并核对远端版本", errorEvidence(err))
			record.UpdatedAt = s.clock()
			_ = s.journal.Save(*record)
			return "", sanitizeError(err, secretValues(plan.Secrets))
		}
	}
	if staged == "" {
		err := fmt.Errorf("deployment: version upload returned no version id")
		record.State = StateUnknown
		setStep(record, stepStage, StateUnknown, "上传结果未知；不会自动重试，请恢复并核对远端版本", "")
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(*record)
		return "", err
	}

	record.StagedVersionID = staged
	setStep(record, stepStage, StatePublished, "新版本已上传", staged)
	record.UpdatedAt = s.clock()
	if err := s.journal.Save(*record); err != nil {
		return "", sanitizeError(err, secretValues(plan.Secrets))
	}
	return staged, nil
}

func (s *Service) activateAndVerify(ctx context.Context, record *OperationRecord, staged string) (domain.Result, error) {
	values := s.pendingValues(context.Background(), *record)

	if err := ctx.Err(); err != nil {
		record.State = StateCancelled
		setStep(record, stepActivate, StateCancelled, "发布已取消，未创建新部署", "")
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(*record)
		cleanupErr := s.cleanupPending(context.Background(), record)
		return operationResult(*record), errors.Join(sanitizeError(err, values), cleanupErr)
	}

	setStep(record, stepActivate, StateApplying, "正在将新版本部署到 100% 流量", "")
	record.UpdatedAt = s.clock()
	if err := s.journal.Save(*record); err != nil {
		return operationResult(*record), sanitizeError(err, values)
	}

	activation, err := s.api.ActivateVersion(ctx, record.Target, staged)
	if err != nil {
		record.State = StateUnknown
		setStep(record, stepActivate, StateUnknown, "部署结果未知；不会自动重试，请恢复并核对当前部署", errorEvidence(err))
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(*record)
		return operationResult(*record), sanitizeError(err, values)
	}

	record.State = StateVerifying
	record.DeploymentID = activation.DeploymentID
	setStep(record, stepActivate, StatePublished, "已创建 100% 部署", activation.DeploymentID)
	setStep(record, stepVerify, StateApplying, "正在读取部署确认活动版本", "")
	record.UpdatedAt = s.clock()
	if err := s.journal.Save(*record); err != nil {
		return operationResult(*record), sanitizeError(err, values)
	}

	snapshot, err := s.api.ReadSnapshot(ctx, record.Target)
	if err != nil {
		record.State = StateUnknown
		setStep(record, stepVerify, StateUnknown, "无法确认活动版本；不会自动重试", errorEvidence(err))
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(*record)
		return operationResult(*record), sanitizeError(err, values)
	}
	if snapshot.VersionID != staged {
		err := fmt.Errorf("deployment: active version is not the staged version")
		record.State = StateUnknown
		setStep(record, stepVerify, StateUnknown, "活动版本与已上传版本不一致；需要恢复确认", snapshot.VersionID)
		record.UpdatedAt = s.clock()
		_ = s.journal.Save(*record)
		return operationResult(*record), sanitizeError(err, values)
	}

	return s.markPublished(record, snapshot)
}

func (s *Service) markPublished(record *OperationRecord, snapshot domain.Snapshot) (domain.Result, error) {
	record.State = StatePublished
	record.StagedVersionID = snapshot.VersionID
	if snapshot.DeploymentID != "" {
		record.DeploymentID = snapshot.DeploymentID
	}
	setStep(record, stepActivate, StatePublished, "100% 流量已指向新版本", snapshot.DeploymentID)
	setStep(record, stepVerify, StatePublished, "已读取部署确认活动版本", snapshot.VersionID)
	record.UpdatedAt = s.clock()
	if err := s.journal.Save(*record); err != nil {
		return operationResult(*record), sanitizeError(err, s.pendingValues(context.Background(), *record))
	}
	cleanupErr := s.cleanupPending(context.Background(), record)
	return operationResult(*record), cleanupErr
}

func (s *Service) fail(record *OperationRecord, step int, err error, values []string) (domain.Result, error) {
	record.State = StateFailed
	record.FailureCode = errCode(err)
	setStep(record, step, StateFailed, "发布失败", errorEvidence(err))
	record.UpdatedAt = s.clock()
	_ = s.journal.Save(*record)
	cleanupErr := s.cleanupPending(context.Background(), record)
	return operationResult(*record), errors.Join(sanitizeError(err, values), cleanupErr)
}

func (s *Service) failWithValues(record *OperationRecord, step int, err error, values []string) (string, error) {
	_, sanitized := s.fail(record, step, err, values)
	return "", sanitized
}

func failureError(record OperationRecord) error {
	if record.FailureCode != "" {
		return domain.Error{
			Code:    record.FailureCode,
			Message: "this operation already failed; start a new publish after refreshing",
		}
	}
	return errors.New("deployment: this operation already failed; start a new publish after refreshing")
}

func (s *Service) planFromJournal(ctx context.Context, record OperationRecord) (domain.PublishPlan, error) {
	if len(record.ConfigJSON) == 0 {
		return domain.PublishPlan{}, fmt.Errorf("deployment: operation has no merged configuration to retry")
	}
	edits, err := s.editsWithPendingValues(ctx, record)
	if err != nil {
		return domain.PublishPlan{}, err
	}
	return domain.PublishPlan{
		BaseVersionID: record.BaseVersionID,
		ConfigJSON:    append([]byte(nil), record.ConfigJSON...),
		Secrets:       edits,
		Vars:          cloneVars(record.Vars),
	}, nil
}

func (s *Service) storePendingSecrets(ctx context.Context, operationID string, edits []domain.SecretEdit) ([]string, error) {
	refs := make([]string, 0)
	for _, edit := range edits {
		if edit.Operation != domain.SecretReplace {
			continue
		}
		if s.creds == nil {
			return refs, platform.ErrCredentialStoreUnavailable
		}
		key := pendingSecretKey(operationID, edit.Name)
		if err := s.creds.Set(ctx, key, edit.Value()); err != nil {
			if errors.Is(err, platform.ErrCredentialStoreUnavailable) {
				return refs, platform.ErrCredentialStoreUnavailable
			}
			return refs, errors.New("deployment: could not write a pending secret to the credential store")
		}
		refs = append(refs, key)
	}
	return refs, nil
}

func (s *Service) editsWithPendingValues(ctx context.Context, record OperationRecord) ([]domain.SecretEdit, error) {
	edits := make([]domain.SecretEdit, 0, len(record.SecretEdits))
	for _, edit := range record.SecretEdits {
		if edit.Operation != domain.SecretReplace {
			edits = append(edits, domain.NewSecretEdit(edit.Name, edit.Operation, ""))
			continue
		}
		if s.creds == nil {
			return nil, platform.ErrCredentialStoreUnavailable
		}
		value, err := s.creds.Get(ctx, pendingSecretKey(record.OperationID, edit.Name))
		if err != nil {
			if errors.Is(err, platform.ErrCredentialStoreUnavailable) {
				return nil, platform.ErrCredentialStoreUnavailable
			}
			return nil, errors.New("deployment: a pending secret is no longer in the credential store")
		}
		edits = append(edits, domain.NewSecretEdit(edit.Name, edit.Operation, value))
	}
	return edits, nil
}

func (s *Service) pendingValues(ctx context.Context, record OperationRecord) []string {
	values := make([]string, 0, len(record.SecretEdits))
	for _, edit := range record.SecretEdits {
		if edit.Operation != domain.SecretReplace || s.creds == nil {
			continue
		}
		if value, err := s.creds.Get(ctx, pendingSecretKey(record.OperationID, edit.Name)); err == nil {
			values = append(values, value)
		}
	}
	return values
}

func (s *Service) cleanupPending(ctx context.Context, record *OperationRecord) error {
	if len(record.SecretRefs) == 0 {
		if record.CleanupPending {
			record.CleanupPending = false
			record.UpdatedAt = s.clock()
			if err := s.journal.Save(*record); err != nil {
				return sanitizeError(err, nil)
			}
		}
		return nil
	}
	if err := s.deleteKeys(ctx, record.SecretRefs); err != nil {
		record.CleanupPending = true
		record.UpdatedAt = s.clock()
		if saveErr := s.journal.Save(*record); saveErr != nil {
			return errors.Join(sanitizeError(err, nil), sanitizeError(saveErr, nil))
		}
		return sanitizeError(err, nil)
	}
	if record.CleanupPending {
		record.CleanupPending = false
		record.UpdatedAt = s.clock()
		if err := s.journal.Save(*record); err != nil {
			return sanitizeError(err, nil)
		}
	}
	return nil
}

func (s *Service) deleteKeys(ctx context.Context, keys []string) error {
	if s.creds == nil {
		return nil
	}
	failures := make([]error, 0)
	for _, key := range keys {
		if err := s.creds.Delete(ctx, key); err != nil {
			if errors.Is(err, platform.ErrCredentialStoreUnavailable) {
				failures = append(failures, platform.ErrCredentialStoreUnavailable)
			} else {
				failures = append(failures, errors.New("deployment: could not delete a pending secret"))
			}
		}
	}
	return errors.Join(failures...)
}

func pendingSecretKey(operationID, secretName string) string {
	return "deployment.op." + operationID + "." + secretName
}

func (s *Service) lockTarget(ctx context.Context, target domain.Target) (func(), error) {
	return s.locker.Lock(ctx, target)
}

// LockTarget exposes the shared per-target lock to lifecycle operations.
func (s *Service) LockTarget(ctx context.Context, target domain.Target) (func(), error) {
	return s.lockTarget(ctx, target)
}

var operationRand io.Reader = rand.Reader

func newOperationID() (string, error) {
	var random [16]byte
	if _, err := io.ReadFull(operationRand, random[:]); err != nil {
		return "", fmt.Errorf("deployment: generate operation id: %w", err)
	}
	return "op-" + hex.EncodeToString(random[:]), nil
}

func previewSteps() []domain.Step {
	return []domain.Step{
		{ID: "stage", State: "planned", Message: "上传新版本（配置与 secrets）"},
		{ID: "activate", State: "planned", Message: "将新版本部署到 100% 流量"},
		{ID: "verify", State: "planned", Message: "读取部署并确认活动版本"},
		{ID: "conflict-note", State: "info", Message: "注意：Cloudflare 没有条件写入；其他客户端仅替换 secret 值（名称不变）时本客户端无法检测。读取与上传之间仍存在竞争窗口。"},
	}
}

func applySteps() []domain.Step {
	return []domain.Step{
		{ID: "stage", State: StatePlanned, Message: "等待上传新版本"},
		{ID: "activate", State: StatePlanned, Message: "等待创建 100% 部署"},
		{ID: "verify", State: StatePlanned, Message: "等待读取部署确认活动版本"},
	}
}

func setStep(record *OperationRecord, index int, state, message, evidence string) {
	if index < 0 || index >= len(record.Steps) {
		return
	}
	record.Steps[index].State = state
	record.Steps[index].Message = message
	record.Steps[index].Evidence = evidence
}

func operationResult(record OperationRecord) domain.Result {
	return domain.Result{
		OperationID:  record.OperationID,
		DeploymentID: record.DeploymentID,
		VersionID:    record.StagedVersionID,
		State:        record.State,
	}
}

func cloneVars(vars map[string]string) map[string]string {
	if vars == nil {
		return nil
	}
	cloned := make(map[string]string, len(vars))
	for name, value := range vars {
		cloned[name] = value
	}
	return cloned
}

func cloneSecretEdits(edits []domain.SecretEdit) []domain.SecretEdit {
	if edits == nil {
		return nil
	}
	cloned := make([]domain.SecretEdit, len(edits))
	copy(cloned, edits)
	return cloned
}

func secretValues(edits []domain.SecretEdit) []string {
	values := make([]string, 0)
	for _, edit := range edits {
		if edit.Value() != "" {
			values = append(values, edit.Value())
		}
	}
	return values
}

func errCode(err error) string {
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		return domainErr.Code
	}
	return ""
}

func isLatestNotBase(err error) bool {
	return errCode(err) == domain.LATEST_NOT_BASE
}

func isNotSent(err error) bool {
	return errCode(err) == domain.NOT_SENT
}

func errorEvidence(err error) string {
	if err == nil {
		return ""
	}
	if code := errCode(err); code != "" {
		return "code=" + code
	}
	var apiErr *cloudflare.APIError
	if errors.As(err, &apiErr) {
		return fmt.Sprintf("http=%d code=%d", apiErr.Status, apiErr.Code)
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "error"
}

func sanitizeError(err error, values []string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		domainErr.Message = redact(domainErr.Message, values)
		return domainErr
	}
	return errors.New(redact(err.Error(), values))
}

func sanitizeMessage(err error, values []string) string {
	sanitized := sanitizeError(err, values)
	if sanitized == nil {
		return ""
	}
	return sanitized.Error()
}

func redact(message string, values []string) string {
	for _, value := range values {
		// Short values are too ambiguous to replace safely; journal evidence
		// never contains raw server bodies, so they cannot leak through steps.
		if len(value) < 8 {
			continue
		}
		message = strings.ReplaceAll(message, value, "[REDACTED]")
	}
	return message
}
