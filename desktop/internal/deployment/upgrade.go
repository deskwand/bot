package deployment

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

// migrationState is the live Durable Object tag plus the migration steps that
// this release still has to apply.
type migrationState struct {
	LiveTag  string
	NewSteps []release.Migration
}

// liveMigrationState requires the live tag to be a prefix of the signed
// history. Import uses it to refuse code that would need migrations; upgrade
// uses it again under the target lock.
func (l *Lifecycle) liveMigrationState(ctx context.Context, target domain.Target, pkg release.Package) (migrationState, error) {
	scripts, err := l.api.ListScripts(ctx, target.AccountID)
	if err != nil {
		return migrationState{}, sanitizeError(err, nil)
	}
	if !scriptExists(scripts, target.ScriptName) {
		return migrationState{}, domain.Error{
			Code:    CodeServiceNotFound,
			Message: "the Worker script does not exist",
		}
	}
	liveTag := migrationTag(scripts, target.ScriptName)
	history := pkg.Manifest().Migrations
	start := -1
	for i, migration := range history {
		if migration.Tag == liveTag {
			start = i
			break
		}
	}
	if liveTag == "" || start < 0 {
		return migrationState{}, domain.Error{
			Code:    CodeMigrationHistoryMismatch,
			Message: "the live Durable Object migration tag is not a prefix of this release's migration history",
		}
	}
	return migrationState{LiveTag: liveTag, NewSteps: history[start+1:]}, nil
}

// Upgrade applies a verified release to an existing deployment. Releases with
// new Durable Object migrations use the immediate script upload (versions
// cannot carry migrations). Releases without new migrations use the Task 6
// versioned publish with an empty Change.
func (l *Lifecycle) Upgrade(ctx context.Context, target domain.Target, pkg release.Package) (domain.Result, error) {
	if len(pkg.ManifestJSON()) == 0 {
		return domain.Result{}, domain.Error{Code: CodeReleaseUnavailable, Message: "no verified release package is available"}
	}
	snapshot, err := l.api.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Result{}, sanitizeError(err, nil)
	}
	if snapshot.ActiveVersionCount != 1 {
		return domain.Result{State: StateFailed}, domain.Error{
			Code:    domain.MULTI_VERSION_DEPLOYMENT,
			Message: "the deployment does not have exactly one version receiving traffic",
		}
	}
	if snapshot.LatestVersionID != snapshot.VersionID {
		return domain.Result{State: StateFailed}, domain.Error{
			Code:    domain.LATEST_NOT_BASE,
			Message: "the latest uploaded version is not the active version; refresh before upgrading",
		}
	}
	if len(snapshot.ConfigJSON) == 0 {
		return domain.Result{State: StateNeedsInput}, domain.Error{
			Code:    CodeConfigMissing,
			Message: "DESKWAND_CONFIG is not set; import the existing service before upgrading",
		}
	}
	if snapshot.ReleaseVersion == "" {
		return domain.Result{State: StateNeedsInput}, domain.Error{
			Code:    CodeVersionUnknownReimport,
			Message: "the current release version is unknown; import the existing service again",
		}
	}

	manifest := pkg.Manifest()
	comparison, comparable := compareVersions(snapshot.ReleaseVersion, pkg.Version())
	if !comparable {
		return domain.Result{State: StateNeedsInput}, domain.Error{
			Code:    CodeVersionUnknown,
			Message: fmt.Sprintf("the current release version %q is not comparable", snapshot.ReleaseVersion),
		}
	}
	if comparison > 0 {
		return domain.Result{State: StateFailed}, domain.Error{
			Code:    CodeDowngradeRejected,
			Message: fmt.Sprintf("downgrading from %s to %s is not supported", snapshot.ReleaseVersion, pkg.Version()),
		}
	}
	if comparison < 0 && manifest.Upgrade.MinFromVersion != "" {
		if minComparison, ok := compareVersions(snapshot.ReleaseVersion, manifest.Upgrade.MinFromVersion); ok && minComparison < 0 {
			return domain.Result{State: StateFailed}, domain.Error{
				Code:    CodeUpgradeRequiresIntermediate,
				Message: fmt.Sprintf("release %s requires at least %s; upgrade through an intermediate supported release", pkg.Version(), manifest.Upgrade.MinFromVersion),
			}
		}
	}

	if _, err := inspectUpgradeBindings(snapshot.SettingsJSON, manifest.ResourceTemplate); err != nil {
		return domain.Result{State: StateFailed}, err
	}
	state, err := l.liveMigrationState(ctx, target, pkg)
	if err != nil {
		return domain.Result{State: StateFailed}, err
	}
	for _, migration := range state.NewSteps {
		for _, irreversible := range manifest.Upgrade.IrreversibleMigrations {
			if migration.Tag == irreversible {
				return domain.Result{State: StateFailed}, domain.Error{
					Code:    CodeIrreversibleMigration,
					Message: fmt.Sprintf("migration %q cannot be rolled back and no reviewed recovery option is available", irreversible),
				}
			}
		}
	}
	beforeIdentity, err := resourceIdentity(snapshot.SettingsJSON)
	if err != nil {
		return domain.Result{State: StateFailed}, err
	}

	if len(state.NewSteps) > 0 {
		return l.upgradeWithScriptUpload(ctx, target, pkg, snapshot, state)
	}
	return l.upgradeWithVersion(ctx, target, pkg, snapshot, beforeIdentity)
}

func (l *Lifecycle) upgradeWithScriptUpload(ctx context.Context, target domain.Target, pkg release.Package, original domain.Snapshot, state migrationState) (domain.Result, error) {
	unlock, err := l.locker.Lock(ctx, target)
	if err != nil {
		return domain.Result{}, sanitizeError(err, nil)
	}
	defer unlock()

	if unresolved, found, err := l.unresolvedOperation(target); err != nil {
		return domain.Result{}, err
	} else if found {
		return domain.Result{OperationID: unresolved.OperationID, State: unresolved.State}, domain.Error{
			Code:    CodeOperationInProgress,
			Message: "an earlier install or upgrade for this Worker is unresolved; reconcile it before upgrading",
		}
	}

	fresh, err := l.api.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Result{}, sanitizeError(err, nil)
	}
	if fresh.ActiveVersionCount != 1 {
		return domain.Result{State: StateFailed}, domain.Error{Code: domain.MULTI_VERSION_DEPLOYMENT, Message: "the deployment does not have exactly one active version"}
	}
	if fresh.LatestVersionID != fresh.VersionID {
		return domain.Result{State: StateFailed}, domain.Error{Code: domain.LATEST_NOT_BASE, Message: "the latest uploaded version changed; refresh before upgrading"}
	}
	if fresh.Fingerprint != original.Fingerprint {
		return domain.Result{State: StateFailed}, domain.Error{Code: domain.CONFIG_CONFLICT, Message: "the configuration changed before the upgrade upload; refresh before upgrading"}
	}
	freshState, err := l.liveMigrationState(ctx, target, pkg)
	if err != nil {
		return domain.Result{State: StateFailed}, err
	}
	if freshState.LiveTag != state.LiveTag {
		return domain.Result{State: StateFailed}, domain.Error{Code: domain.CONFIG_CONFLICT, Message: "the migration history changed before the upgrade upload"}
	}
	freshInspection, err := inspectUpgradeBindings(fresh.SettingsJSON, pkg.Manifest().ResourceTemplate)
	if err != nil {
		return domain.Result{State: StateFailed}, err
	}
	freshIdentity, err := resourceIdentity(fresh.SettingsJSON)
	if err != nil {
		return domain.Result{State: StateFailed}, err
	}
	bucketName, err := bucketNameForUpgrade(freshInspection, pkg.Manifest().ResourceTemplate)
	if err != nil {
		return domain.Result{State: StateFailed}, err
	}
	plainVars := make(map[string]string, len(freshInspection.PlainVars))
	for name, value := range freshInspection.PlainVars {
		plainVars[name] = value
	}

	operationID, err := newOperationID()
	if err != nil {
		return domain.Result{}, sanitizeError(err, nil)
	}
	record := OperationRecord{
		OperationID:           operationID,
		Kind:                  KindUpgrade,
		Target:                target,
		State:                 StateApplying,
		Steps:                 upgradeSteps(),
		BaseFingerprint:       fresh.Fingerprint,
		BaseVersionID:         fresh.VersionID,
		ReleaseVersion:        pkg.Version(),
		BucketName:            bucketName,
		ActiveChannel:         freshInspection.ActiveChannel,
		ScriptUploadAttempted: true,
		CreatedAt:             l.clock(),
	}
	setStep(&record, 0, StatePublished, "已确认迁移历史与单版本部署", freshState.LiveTag)
	setStep(&record, 1, StateApplying, "正在上传 Worker 脚本并应用数据库迁移", "")
	if err := l.save(&record); err != nil {
		return domain.Result{OperationID: operationID}, err
	}

	_, uploadErr := l.api.UploadScript(ctx, target, pkg.ManifestJSON(), pkg.Modules(), cloudflareScriptPlan(fresh.ConfigJSON, bucketName, plainVars, freshState.LiveTag, "DeskWand Bot upgrade "+pkg.Version()+" "+operationID))
	if uploadErr != nil {
		if isNotSent(uploadErr) || errCode(uploadErr) == CodeMigrationHistoryMismatch || definitiveClientError(uploadErr) {
			record.ScriptUploadAttempted = false
			record.State = StateFailed
			record.FailureCode = errCodeOrDefault(uploadErr, CodeUploadRejected)
			setStep(&record, 1, StateFailed, "升级上传被拒绝", errorEvidence(uploadErr))
			_ = l.save(&record)
		} else {
			record.State = StateUnknown
			setStep(&record, 1, StateUnknown, "升级上传结果未知；下次升级前需要核对远端", errorEvidence(uploadErr))
			_ = l.save(&record)
		}
		return operationResult(record), sanitizeError(uploadErr, nil)
	}

	upgraded, err := l.api.ReadSnapshot(ctx, target)
	if err != nil {
		record.State = StateUnknown
		setStep(&record, 2, StateUnknown, "无法读取升级后的部署", errorEvidence(err))
		_ = l.save(&record)
		return operationResult(record), sanitizeError(err, nil)
	}
	if err := l.verifyUpgradeState(ctx, target, pkg, fresh, freshIdentity, upgraded); err != nil {
		record.State = StateUnknown
		setStep(&record, 2, StateUnknown, "升级后核对失败；需要人工确认", errorEvidence(err))
		_ = l.save(&record)
		return operationResult(record), err
	}
	record.State = StatePublished
	record.DeploymentID = upgraded.DeploymentID
	record.StagedVersionID = upgraded.VersionID
	setStep(&record, 1, StatePublished, "Worker 脚本与迁移已应用", upgraded.VersionID)
	setStep(&record, 2, StatePublished, "已核对定时任务与资源标识", upgraded.VersionID)
	if err := l.save(&record); err != nil {
		return operationResult(record), err
	}
	return operationResult(record), nil
}

func (l *Lifecycle) upgradeWithVersion(ctx context.Context, target domain.Target, pkg release.Package, snapshot domain.Snapshot, beforeIdentity resourceIDs) (domain.Result, error) {
	service := NewServiceWithLocker(l.api, l.journal, l.creds, pkg, l.clock, l.locker)
	result, err := service.Apply(ctx, target, domain.Change{
		BaseFingerprint:    snapshot.Fingerprint,
		AllowReleaseChange: true,
	})
	if err != nil {
		return result, err
	}
	unlock, lockErr := l.locker.Lock(ctx, target)
	if lockErr != nil {
		result.State = StateUnknown
		return result, sanitizeError(lockErr, nil)
	}
	defer unlock()
	upgraded, readErr := l.api.ReadSnapshot(ctx, target)
	if readErr != nil {
		result.State = StateUnknown
		return result, sanitizeError(readErr, nil)
	}
	if verifyErr := l.verifyUpgradeState(ctx, target, pkg, snapshot, beforeIdentity, upgraded); verifyErr != nil {
		result.State = StateUnknown
		return result, verifyErr
	}
	result.DeploymentID = upgraded.DeploymentID
	result.VersionID = upgraded.VersionID
	return result, nil
}

func (l *Lifecycle) verifyUpgradeState(ctx context.Context, target domain.Target, pkg release.Package, before domain.Snapshot, beforeIdentity resourceIDs, after domain.Snapshot) error {
	afterIdentity, err := resourceIdentity(after.SettingsJSON)
	if err != nil {
		return err
	}
	if !beforeIdentity.equal(afterIdentity) {
		return domain.Error{
			Code:    CodeResourceIdentityChanged,
			Message: "the upgrade changed a Durable Object namespace or R2 bucket binding",
		}
	}
	if !sameJSON(before.ConfigJSON, after.ConfigJSON) {
		return domain.Error{Code: CodeVerifyFailed, Message: "the upgrade changed DESKWAND_CONFIG"}
	}
	if after.ReleaseVersion != pkg.Version() {
		return domain.Error{Code: CodeVerifyFailed, Message: "the upgrade did not publish the expected release version"}
	}
	if after.VersionID == "" {
		return domain.Error{Code: CodeVerifyFailed, Message: "the upgrade has no active version"}
	}
	wantCrons := pkg.Manifest().ResourceTemplate.Crons
	crons, err := l.api.GetSchedules(ctx, target)
	if err != nil {
		return domain.Error{Code: CodeVerifyFailed, Message: "the upgrade could not read the cron schedules"}
	}
	if !sameStrings(crons, wantCrons) {
		if err := l.api.PutSchedules(ctx, target, wantCrons); err != nil {
			return domain.Error{Code: CodeVerifyFailed, Message: "the upgrade could not restore the cron schedules"}
		}
		crons, err = l.api.GetSchedules(ctx, target)
		if err != nil || !sameStrings(crons, wantCrons) {
			return domain.Error{Code: CodeVerifyFailed, Message: "the upgrade cron schedules do not match the release template"}
		}
	}
	return nil
}

func (l *Lifecycle) unresolvedOperation(target domain.Target) (OperationRecord, bool, error) {
	if l.journal == nil {
		return OperationRecord{}, false, nil
	}
	records, err := l.journal.List()
	if err != nil {
		return OperationRecord{}, false, sanitizeError(err, nil)
	}
	for _, record := range records {
		if record.Target != target {
			continue
		}
		switch record.State {
		case StatePublished, StateCancelled, StateFailed:
			continue
		}
		return record, true, nil
	}
	return OperationRecord{}, false, nil
}

func upgradeSteps() []domain.Step {
	return []domain.Step{
		{ID: "preflight", State: StatePlanned, Message: "等待检查迁移历史和部署状态"},
		{ID: "script", State: StatePlanned, Message: "等待上传带迁移的 Worker 脚本"},
		{ID: "verify", State: StatePlanned, Message: "等待核对定时任务与资源标识"},
	}
}

type resourceIDs struct {
	DurableObjects map[string]string
	R2Buckets      map[string]string
}

// equal reports that every resource that existed before the upgrade still has
// the same identity. A new Durable Object class introduced by a migration is
// expected to add a namespace, so extra after entries are allowed.
func (r resourceIDs) equal(other resourceIDs) bool {
	for name, value := range r.DurableObjects {
		if other.DurableObjects[name] != value {
			return false
		}
	}
	for name, value := range r.R2Buckets {
		if other.R2Buckets[name] != value {
			return false
		}
	}
	return true
}

func resourceIdentity(settingsJSON []byte) (resourceIDs, error) {
	bindings, err := parseSettingsBindings(settingsJSON)
	if err != nil {
		return resourceIDs{}, err
	}
	ids := resourceIDs{DurableObjects: map[string]string{}, R2Buckets: map[string]string{}}
	for _, binding := range bindings {
		var raw struct {
			NamespaceID string `json:"namespace_id"`
			ClassName   string `json:"class_name"`
			BucketName  string `json:"bucket_name"`
		}
		if err := jsonUnmarshalBinding(binding.Raw, &raw); err != nil {
			return resourceIDs{}, err
		}
		switch binding.Type {
		case "durable_object_namespace":
			if raw.NamespaceID == "" {
				return resourceIDs{}, domain.Error{
					Code:    CodeIdentityUnverifiable,
					Message: fmt.Sprintf("Durable Object binding %q has no namespace_id; resource identity cannot be verified", binding.Name),
				}
			}
			ids.DurableObjects[binding.Name] = raw.NamespaceID
		case "r2_bucket":
			if raw.BucketName == "" {
				return resourceIDs{}, domain.Error{
					Code:    CodeIdentityUnverifiable,
					Message: fmt.Sprintf("R2 binding %q has no bucket_name; resource identity cannot be verified", binding.Name),
				}
			}
			ids.R2Buckets[binding.Name] = raw.BucketName
		}
	}
	return ids, nil
}

func jsonUnmarshalBinding(raw []byte, out any) error {
	if err := json.Unmarshal(raw, out); err != nil {
		return domain.Error{Code: domain.UNSUPPORTED_BINDING, Message: "a binding could not be decoded"}
	}
	return nil
}

// inspectUpgradeBindings validates the existing bindings without requiring
// every new-template binding to exist already: a migration may introduce a new
// Durable Object class. Extra or mismatched existing resources still block.
func inspectUpgradeBindings(settingsJSON []byte, template release.ResourceTemplate) (bindingInspection, error) {
	bindings, err := parseSettingsBindings(settingsJSON)
	if err != nil {
		return bindingInspection{}, err
	}
	inspection := bindingInspection{
		Binding:       bindings,
		ByTypeAndName: make(map[string]settingsBinding, len(bindings)),
		PlainVars:     map[string]string{},
	}
	for _, binding := range bindings {
		inspection.ByTypeAndName[binding.Type+"/"+binding.Name] = binding
		switch binding.Type {
		case "durable_object_namespace":
			if !templateHasDO(template, binding.Name) || templateDOClass(template, binding.Name) != binding.ClassName {
				return bindingInspection{}, domain.Error{
					Code:    domain.UNSUPPORTED_BINDING,
					Message: fmt.Sprintf("Durable Object binding %q does not match the release template", binding.Name),
				}
			}
		case "r2_bucket":
			if !templateHasR2(template, binding.Name) {
				return bindingInspection{}, domain.Error{
					Code:    domain.UNSUPPORTED_BINDING,
					Message: fmt.Sprintf("binding %q is an R2 bucket not declared by the release template", binding.Name),
				}
			}
		case "version_metadata":
			if binding.Name != template.VersionMetadata.Name {
				return bindingInspection{}, domain.Error{
					Code:    domain.UNSUPPORTED_BINDING,
					Message: fmt.Sprintf("version metadata binding %q is not declared by the release template", binding.Name),
				}
			}
		case "json":
			if binding.Name != template.ConfigBinding.Name {
				return bindingInspection{}, domain.Error{
					Code:    domain.UNSUPPORTED_BINDING,
					Message: fmt.Sprintf("JSON binding %q is not the configuration binding", binding.Name),
				}
			}
			inspection.ConfigPresent = true
		case "plain_text":
			inspection.PlainVars[binding.Name] = binding.Text
			if binding.Name == "ACTIVE_CHANNEL" {
				inspection.ActiveChannel = binding.Text
			}
		case "secret_text":
			// Preserved by keep_bindings or version inheritance.
		default:
			return bindingInspection{}, domain.Error{
				Code:    domain.UNSUPPORTED_BINDING,
				Message: fmt.Sprintf("binding %q has unsupported type %q", binding.Name, binding.Type),
			}
		}
	}
	return inspection, nil
}

// VerifyUpgradeIdentity checks that a live deployment still has the bindings
// and resource identifiers an upgrade promised to preserve. It is used when a
// resumed upgrade has to decide whether an earlier upload is already live.
func VerifyUpgradeIdentity(settingsJSON []byte, template release.ResourceTemplate, bucketName string) error {
	inspection, err := inspectUpgradeBindings(settingsJSON, template)
	if err != nil {
		return err
	}
	if _, err := resourceIdentity(settingsJSON); err != nil {
		return err
	}
	currentBucket, err := bucketNameForUpgrade(inspection, template)
	if err != nil {
		return err
	}
	if bucketName != "" && currentBucket != "" && currentBucket != bucketName {
		return domain.Error{
			Code:    CodeResourceIdentityChanged,
			Message: "the upgrade changed the R2 bucket binding",
		}
	}
	return nil
}

func templateDOClass(template release.ResourceTemplate, name string) string {
	for _, binding := range template.DurableObjects {
		if binding.Name == name {
			return binding.ClassName
		}
	}
	return ""
}

func bucketNameForUpgrade(inspection bindingInspection, template release.ResourceTemplate) (string, error) {
	if len(template.R2Buckets) == 0 {
		return "", nil
	}
	name := template.R2Buckets[0].Name
	for _, binding := range inspection.Binding {
		if binding.Type == "r2_bucket" && binding.Name == name && binding.BucketName != "" {
			return binding.BucketName, nil
		}
	}
	return "", domain.Error{Code: domain.UNSUPPORTED_BINDING, Message: "the R2 bucket binding has no bucket name"}
}

func cloudflareScriptPlan(configJSON []byte, bucketName string, plainVars map[string]string, baseTag, message string) cloudflare.ScriptUploadPlan {
	return cloudflare.ScriptUploadPlan{
		ConfigJSON: configJSON,
		BucketName: bucketName,
		PlainVars:  plainVars,
		BaseTag:    baseTag,
		Message:    message,
	}
}

// CompareVersions compares two semver-like release versions. It returns
// comparable=false when either value is not a version this client understands.
func CompareVersions(left, right string) (int, bool) {
	return compareVersions(left, right)
}

// compareVersions compares semver-like versions, including prerelease
// precedence. A release is newer than its own prerelease, so upgrading
// 1.0.0 to 1.0.0-beta is rejected as a downgrade. Build metadata is ignored.
func compareVersions(left, right string) (int, bool) {
	leftVersion, ok := parseVersion(left)
	if !ok {
		return 0, false
	}
	rightVersion, ok := parseVersion(right)
	if !ok {
		return 0, false
	}
	size := len(leftVersion.core)
	if len(rightVersion.core) > size {
		size = len(rightVersion.core)
	}
	for i := 0; i < size; i++ {
		var a, b int
		if i < len(leftVersion.core) {
			a = leftVersion.core[i]
		}
		if i < len(rightVersion.core) {
			b = rightVersion.core[i]
		}
		if a < b {
			return -1, true
		}
		if a > b {
			return 1, true
		}
	}
	switch {
	case !leftVersion.hasPre && !rightVersion.hasPre:
		return 0, true
	case !leftVersion.hasPre:
		return 1, true
	case !rightVersion.hasPre:
		return -1, true
	}
	size = len(leftVersion.pre)
	if len(rightVersion.pre) > size {
		size = len(rightVersion.pre)
	}
	for i := 0; i < size; i++ {
		if i >= len(leftVersion.pre) {
			return -1, true
		}
		if i >= len(rightVersion.pre) {
			return 1, true
		}
		a, b := leftVersion.pre[i], rightVersion.pre[i]
		aNumber, aNumeric := numericIdentifier(a)
		bNumber, bNumeric := numericIdentifier(b)
		switch {
		case aNumeric && bNumeric:
			if aNumber < bNumber {
				return -1, true
			}
			if aNumber > bNumber {
				return 1, true
			}
		case aNumeric:
			return -1, true
		case bNumeric:
			return 1, true
		default:
			if a < b {
				return -1, true
			}
			if a > b {
				return 1, true
			}
		}
	}
	return 0, true
}

type parsedVersion struct {
	core   []int
	pre    []string
	hasPre bool
}

func parseVersion(value string) (parsedVersion, bool) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(value, "v"))
	if trimmed == "" {
		return parsedVersion{}, false
	}
	if index := strings.IndexByte(trimmed, '+'); index >= 0 {
		trimmed = trimmed[:index]
	}
	var prerelease string
	if index := strings.IndexByte(trimmed, '-'); index >= 0 {
		prerelease = trimmed[index+1:]
		trimmed = trimmed[:index]
	}
	if trimmed == "" {
		return parsedVersion{}, false
	}
	parts := strings.Split(trimmed, ".")
	if len(parts) > 8 {
		return parsedVersion{}, false
	}
	result := parsedVersion{core: make([]int, len(parts))}
	for i, part := range parts {
		if part == "" {
			return parsedVersion{}, false
		}
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return parsedVersion{}, false
		}
		result.core[i] = number
	}
	if prerelease != "" {
		identifiers := strings.Split(prerelease, ".")
		result.hasPre = true
		result.pre = identifiers
		for _, identifier := range identifiers {
			if identifier == "" {
				return parsedVersion{}, false
			}
			for _, r := range identifier {
				if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
					return parsedVersion{}, false
				}
			}
		}
	}
	return result, true
}

func numericIdentifier(value string) (int, bool) {
	number, err := strconv.Atoi(value)
	if err != nil || number < 0 {
		return 0, false
	}
	return number, true
}
