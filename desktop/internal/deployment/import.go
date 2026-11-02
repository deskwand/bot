package deployment

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

// SecretMigration is one inline credential that must become a named secret.
// It carries a field path and a reference, never the value.
type SecretMigration struct {
	Path       string `json:"path"`
	SecretName string `json:"secretName"`
	Reference  string `json:"reference"`
}

// ImportPreview describes an existing service before any write. Legacy means
// DESKWAND_CONFIG is absent, so owner/models are not readable from the remote
// and must be re-entered; MCP servers start empty.
type ImportPreview struct {
	Target              domain.Target     `json:"target"`
	ReleaseVersion      string            `json:"releaseVersion"`
	ActiveVersionCount  int               `json:"activeVersionCount"`
	BaseFingerprint     string            `json:"baseFingerprint"`
	Legacy              bool              `json:"legacy"`
	ConfigPresent       bool              `json:"configPresent"`
	OwnerConfigured     bool              `json:"ownerConfigured"`
	ModelsConfigured    bool              `json:"modelsConfigured"`
	ActiveChannel       string            `json:"activeChannel"`
	SecretNames         []string          `json:"secretNames"`
	PreserveSecretNames []string          `json:"preserveSecretNames"`
	PlaintextSecrets    []SecretMigration `json:"plaintextSecrets,omitempty"`
	RequiredInputs      []string          `json:"requiredInputs,omitempty"`
	Warnings            []string          `json:"warnings,omitempty"`
}

// ImportConfirmation supplies the user's re-entered values. SecretValues is
// keyed by the SecretName from the preview and is never returned to the UI.
type ImportConfirmation struct {
	BaseFingerprint string
	TelegramUserIDs *[]int64
	ButlerModel     *json.RawMessage
	TaskModel       *json.RawMessage
	SecretValues    map[string]string
}

type settingsBinding struct {
	Name       string
	Type       string
	ClassName  string
	BucketName string
	Text       string
	Raw        json.RawMessage
}

type bindingInspection struct {
	Binding       []settingsBinding
	ByTypeAndName map[string]settingsBinding
	PlainVars     map[string]string
	ConfigPresent bool
	ActiveChannel string
}

// InspectImport reads the current service. Existing bindings may be a subset of
// the release template (a migration can introduce a new Durable Object), but
// extra or mismatched bindings are refused as a fork. It returns a preview
// alongside a PLAINTEXT_SECRET_DETECTED error when inline credentials need
// migration.
func (l *Lifecycle) InspectImport(ctx context.Context, target domain.Target) (ImportPreview, error) {
	if len(l.pkg.ManifestJSON()) == 0 {
		return ImportPreview{}, domain.Error{Code: CodeReleaseUnavailable, Message: "no verified release package is available"}
	}
	snapshot, err := l.api.ReadSnapshot(ctx, target)
	if err != nil {
		return ImportPreview{}, sanitizeError(err, nil)
	}
	template := l.pkg.Manifest().ResourceTemplate
	inspection, err := inspectUpgradeBindings(snapshot.SettingsJSON, template)
	if err != nil {
		return ImportPreview{}, err
	}

	preview := ImportPreview{
		Target:              target,
		ReleaseVersion:      snapshot.ReleaseVersion,
		ActiveVersionCount:  snapshot.ActiveVersionCount,
		BaseFingerprint:     snapshot.Fingerprint,
		ConfigPresent:       inspection.ConfigPresent,
		SecretNames:         append([]string(nil), snapshot.SecretNames...),
		PreserveSecretNames: append([]string(nil), snapshot.SecretNames...),
		ActiveChannel:       inspection.ActiveChannel,
	}
	if snapshot.ReleaseVersion == "" {
		preview.Warnings = append(preview.Warnings, "无法读取当前发布版本；升级前需要确认版本。")
	}
	if !inspection.ConfigPresent || len(snapshot.ConfigJSON) == 0 {
		preview.Legacy = true
		preview.RequiredInputs = []string{"owner", "models"}
		preview.Warnings = append(preview.Warnings,
			"旧版本把 owner 和模型写在源码里，客户端不会执行或解析 Worker 代码；请重新填写 owner 与模型。",
			"MCP 服务器将从未配置开始；已存在的 secrets 会被保留。",
		)
		return preview, nil
	}

	preview.OwnerConfigured, preview.ModelsConfigured = configFlags(snapshot.ConfigJSON)
	if !preview.OwnerConfigured {
		preview.RequiredInputs = append(preview.RequiredInputs, "owner")
	}
	if !preview.ModelsConfigured {
		preview.RequiredInputs = append(preview.RequiredInputs, "models")
	}
	migrations, scanWarnings := scanPlaintextSecrets(snapshot.ConfigJSON, snapshot.SecretNames, template)
	preview.Warnings = append(preview.Warnings, scanWarnings...)
	if len(migrations) > 0 {
		preview.PlaintextSecrets = migrations
		preview.RequiredInputs = append(preview.RequiredInputs, "migratedSecrets")
		preview.Warnings = append(preview.Warnings,
			"现有 DESKWAND_CONFIG 中含有明文凭据。确认迁移时请为每个条目输入值；值只会写入 Cloudflare secrets，不会写入普通变量或日志。",
		)
		needsBearer := false
		for _, migration := range migrations {
			preview.Warnings = append(preview.Warnings,
				fmt.Sprintf("请轮换已迁移的凭据 %s；旧版本仍保留明文。", migration.SecretName))
			if strings.EqualFold(pointerLastSegment(migration.Path), "Authorization") {
				needsBearer = true
			}
		}
		if needsBearer {
			preview.Warnings = append(preview.Warnings,
				"Authorization 需要填写完整值（包括 `Bearer ` 前缀）。")
		}
		return preview, domain.Error{
			Code:    CodePlaintextSecretDetected,
			Message: "existing configuration contains inline credentials; provide values for the listed secrets before publishing",
		}
	}
	return preview, nil
}

// ConfirmImport publishes re-entered owner/models and any migrated secrets via
// the Task 6 versioned publish service. It never writes a plaintext credential
// into a variable and never executes downloaded Worker code.
func (l *Lifecycle) ConfirmImport(ctx context.Context, target domain.Target, confirmation ImportConfirmation) (domain.Result, error) {
	if len(l.pkg.ManifestJSON()) == 0 {
		return domain.Result{}, domain.Error{Code: CodeReleaseUnavailable, Message: "no verified release package is available"}
	}
	preview, err := l.InspectImport(ctx, target)
	if err != nil && !isCode(err, CodePlaintextSecretDetected) {
		return domain.Result{}, err
	}
	migrationState, err := l.liveMigrationState(ctx, target, l.pkg)
	if err != nil {
		return domain.Result{}, err
	}
	if len(migrationState.NewSteps) > 0 {
		return domain.Result{State: StateNeedsInput}, domain.Error{
			Code:    CodeUpgradeRequiredFirst,
			Message: "先导入当前版本再升级",
		}
	}
	if preview.Legacy {
		if confirmation.TelegramUserIDs == nil {
			return domain.Result{State: StateNeedsInput}, domain.Error{Code: CodeOwnerRequired, Message: "legacy deployments require an owner list, which may be empty"}
		}
		if confirmation.ButlerModel == nil || confirmation.TaskModel == nil {
			return domain.Result{State: StateNeedsInput}, domain.Error{Code: CodeModelsRequired, Message: "legacy deployments require both role models"}
		}
	}

	patch := domain.EditablePatch{
		TelegramUserIDs: confirmation.TelegramUserIDs,
		ButlerModel:     confirmation.ButlerModel,
		TaskModel:       confirmation.TaskModel,
	}
	values := make([]string, 0, len(preview.PlaintextSecrets))
	edits := make([]domain.SecretEdit, 0, len(preview.PlaintextSecrets))
	references := make([]domain.ConfigReference, 0, len(preview.PlaintextSecrets))
	for _, migration := range preview.PlaintextSecrets {
		value := confirmation.SecretValues[migration.SecretName]
		if value == "" {
			return domain.Result{State: StateNeedsInput}, domain.Error{
				Code:    CodePlaintextSecretDetected,
				Message: fmt.Sprintf("a value is required for migrated secret %q", migration.SecretName),
			}
		}
		values = append(values, value)
		edits = append(edits, domain.NewSecretEdit(migration.SecretName, domain.SecretReplace, value))
		references = append(references, domain.ConfigReference{Path: migration.Path, Reference: migration.Reference})
	}

	baseFingerprint := confirmation.BaseFingerprint
	if baseFingerprint == "" {
		baseFingerprint = preview.BaseFingerprint
	}
	change := domain.Change{
		BaseFingerprint: baseFingerprint,
		Patch:           patch,
		Secrets:         edits,
		References:      references,
	}
	service := NewServiceWithLocker(l.api, l.journal, l.creds, l.pkg, l.clock, l.locker)
	result, applyErr := service.Apply(ctx, target, change)
	return result, sanitizeError(applyErr, values)
}

func configFlags(configJSON []byte) (ownerConfigured, modelsConfigured bool) {
	if len(configJSON) == 0 {
		return false, false
	}
	value, err := domain.DecodeJSON(configJSON)
	if err != nil {
		return false, false
	}
	document, ok := value.(map[string]any)
	if !ok {
		return false, false
	}
	if owner, ok := document["owner"].(map[string]any); ok {
		if ids, ok := owner["telegramUserIds"].([]any); ok && len(ids) > 0 {
			ownerConfigured = true
		}
	}
	if models, ok := document["models"].(map[string]any); ok {
		if _, ok := models["butler"].(map[string]any); ok {
			if _, ok := models["task"].(map[string]any); ok {
				modelsConfigured = true
			}
		}
	}
	return ownerConfigured, modelsConfigured
}

func parseSettingsBindings(settingsJSON []byte) ([]settingsBinding, error) {
	var document struct {
		Bindings []json.RawMessage `json:"bindings"`
	}
	if len(settingsJSON) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(settingsJSON, &document); err != nil {
		return nil, domain.Error{Code: domain.UNSUPPORTED_BINDING, Message: "the current settings bindings are not readable"}
	}
	bindings := make([]settingsBinding, 0, len(document.Bindings))
	for _, raw := range document.Bindings {
		var value struct {
			Name       string `json:"name"`
			Type       string `json:"type"`
			ClassName  string `json:"class_name"`
			BucketName string `json:"bucket_name"`
			Text       string `json:"text"`
		}
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, domain.Error{Code: domain.UNSUPPORTED_BINDING, Message: "a current settings binding is not readable"}
		}
		bindings = append(bindings, settingsBinding{
			Name:       value.Name,
			Type:       value.Type,
			ClassName:  value.ClassName,
			BucketName: value.BucketName,
			Text:       value.Text,
			Raw:        append(json.RawMessage(nil), raw...),
		})
	}
	return bindings, nil
}

func templateHasDO(template release.ResourceTemplate, name string) bool {
	for _, binding := range template.DurableObjects {
		if binding.Name == name {
			return true
		}
	}
	return false
}

func templateHasR2(template release.ResourceTemplate, name string) bool {
	for _, binding := range template.R2Buckets {
		if binding.Name == name {
			return true
		}
	}
	return false
}

var secretNameCleaner = regexp.MustCompile(`[^A-Z0-9]+`)

type plaintextScanner struct {
	used       map[string]bool
	reserved   map[string]bool
	migrations []SecretMigration
	warnings   []string
	seen       map[string]bool
	warned     map[string]bool
}

func scanPlaintextSecrets(configJSON []byte, existingSecretNames []string, template release.ResourceTemplate) ([]SecretMigration, []string) {
	if len(configJSON) == 0 {
		return nil, nil
	}
	value, err := domain.DecodeJSON(configJSON)
	if err != nil {
		return nil, nil
	}
	document, ok := value.(map[string]any)
	if !ok {
		return nil, nil
	}
	reserved := reservedTemplateNames(template)
	used := map[string]bool{}
	for name := range reserved {
		used[name] = true
	}
	for _, name := range existingSecretNames {
		used[name] = true
	}
	scanner := &plaintextScanner{
		used:     used,
		reserved: reserved,
		seen:     map[string]bool{},
		warned:   map[string]bool{},
	}
	scanner.walk(document, nil, "")
	return scanner.migrations, scanner.warnings
}

func reservedTemplateNames(template release.ResourceTemplate) map[string]bool {
	names := map[string]bool{
		template.ConfigBinding.Name:   true,
		template.VersionMetadata.Name: true,
	}
	for _, name := range template.SecretNames {
		names[name] = true
	}
	for _, name := range template.PlainVars {
		names[name] = true
	}
	for _, binding := range template.DurableObjects {
		names[binding.Name] = true
	}
	for _, binding := range template.R2Buckets {
		names[binding.Name] = true
	}
	for _, variable := range template.Vars {
		names[variable.Name] = true
	}
	return names
}

func (s *plaintextScanner) walk(value any, path []string, serverName string) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := typed[key]
			childPath := append(append([]string(nil), path...), key)
			if strings.EqualFold(key, "headers") && len(path) >= 2 && path[0] == "mcpServers" {
				s.scanHeaders(child, childPath, serverName)
				continue
			}
			if text, ok := child.(string); ok {
				if isCredentialKey(key) && !isEnvReference(text) {
					s.warn(fmt.Sprintf("字段 %s 看起来包含凭据，但不在 MCP header 中，未自动迁移；请手动处理并轮换。", jsonPointer(childPath)))
				}
				continue
			}
			s.walk(child, childPath, serverName)
		}
	case []any:
		for index, child := range typed {
			childPath := append(append([]string(nil), path...), fmt.Sprintf("%d", index))
			name := serverName
			if len(path) == 1 && path[0] == "mcpServers" {
				if server, ok := child.(map[string]any); ok {
					if text, ok := server["name"].(string); ok {
						name = text
					}
					s.warnServerFields(server, name)
				}
			}
			s.walk(child, childPath, name)
		}
	}
}

func (s *plaintextScanner) warnServerFields(server map[string]any, serverName string) {
	if rawURL, ok := server["url"].(string); ok {
		if message, found := mcpURLWarning(serverName, rawURL); found {
			s.warn(message)
		}
	}
	if args, ok := server["args"].([]any); ok && len(args) > 0 {
		s.warn(fmt.Sprintf("MCP 服务器 %q 的 args 可能包含凭据，未自动迁移；请检查并轮换。", serverName))
	}
}

func (s *plaintextScanner) scanHeaders(value any, path []string, serverName string) {
	headers, ok := value.(map[string]any)
	if !ok {
		return
	}
	keys := make([]string, 0, len(headers))
	for key := range headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		text, ok := headers[key].(string)
		if !ok || isEnvReference(text) {
			continue
		}
		if sensitiveHeader(key) || looksLikeSecretValue(text) {
			s.add(append(append([]string(nil), path...), key), key, serverName)
		}
	}
}

func (s *plaintextScanner) add(path []string, key, serverName string) {
	pointer := jsonPointer(path)
	if s.seen[pointer] {
		return
	}
	s.seen[pointer] = true
	name := s.secretName(key, serverName)
	reference := "env:" + name
	s.used[name] = true
	s.migrations = append(s.migrations, SecretMigration{Path: pointer, SecretName: name, Reference: reference})
}

func (s *plaintextScanner) warn(message string) {
	if s.warned[message] {
		return
	}
	s.warned[message] = true
	s.warnings = append(s.warnings, message)
}

func (s *plaintextScanner) secretName(key, serverName string) string {
	if serverName == "" {
		serverName = "SERVER"
	}
	base := "MCP_" + normalizeSecretName(serverName) + "_" + normalizeSecretName(key)
	if len(base) > 60 {
		base = base[:60]
	}
	candidate := base
	for suffix := 2; s.used[candidate] || s.reserved[candidate]; suffix++ {
		candidate = fmt.Sprintf("%s_%d", base, suffix)
	}
	return candidate
}

func normalizeSecretName(value string) string {
	cleaned := secretNameCleaner.ReplaceAllString(strings.ToUpper(value), "_")
	cleaned = strings.Trim(cleaned, "_")
	if cleaned == "" {
		return "SECRET"
	}
	return cleaned
}

func mcpURLWarning(serverName, raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	if parsed.User != nil {
		return fmt.Sprintf("MCP 服务器 %q 的 URL 含有用户信息，未自动迁移；请改用 secret 引用并轮换。", serverName), true
	}
	for key, values := range parsed.Query() {
		if isCredentialKey(key) {
			return fmt.Sprintf("MCP 服务器 %q 的 URL 查询参数含有凭据，未自动迁移；请改用 secret 引用并轮换。", serverName), true
		}
		for _, value := range values {
			if looksLikeSecretValue(value) {
				return fmt.Sprintf("MCP 服务器 %q 的 URL 查询参数含有凭据，未自动迁移；请改用 secret 引用并轮换。", serverName), true
			}
		}
	}
	return "", false
}

// isCredentialKey uses normalized contains matching so api_key, apiKey,
// accessKey and refresh-token are all recognized.
func isCredentialKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.ToLower(key))
	for _, marker := range []string{"token", "secret", "password", "passwd", "apikey", "accesskey", "credential", "auth"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func sensitiveHeader(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	switch normalized {
	case "authorization", "x-api-key", "api-key", "cookie":
		return true
	}
	return strings.Contains(normalized, "token") || strings.Contains(normalized, "secret")
}

func looksLikeSecretValue(value string) bool {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	for _, prefix := range []string{"bearer ", "sk-", "ghp_", "xox", "cfut_", "cfat_"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

func pointerLastSegment(path string) string {
	index := strings.LastIndex(path, "/")
	if index < 0 {
		return ""
	}
	segment := path[index+1:]
	segment = strings.ReplaceAll(segment, "~1", "/")
	return strings.ReplaceAll(segment, "~0", "~")
}

func isEnvReference(value string) bool {
	return strings.HasPrefix(strings.TrimSpace(value), "env:")
}

func jsonPointer(path []string) string {
	var builder strings.Builder
	for _, segment := range path {
		builder.WriteByte('/')
		segment = strings.ReplaceAll(segment, "~", "~0")
		segment = strings.ReplaceAll(segment, "/", "~1")
		builder.WriteString(segment)
	}
	return builder.String()
}

func isCode(err error, code string) bool {
	var domainErr domain.Error
	return errors.As(err, &domainErr) && domainErr.Code == code
}
