package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

// ErrAlreadyExists reports that a named resource already exists. Callers must
// treat it as a collision unless their own journaled step created it.
var ErrAlreadyExists = errors.New("cloudflare: resource already exists")

// ErrNotFound reports that a named resource does not exist.
var ErrNotFound = errors.New("cloudflare: resource not found")

var subdomainPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// R2Bucket is one account R2 bucket returned by the list/get APIs.
type R2Bucket struct {
	Name         string `json:"name"`
	CreationDate string `json:"creation_date,omitempty"`
	Location     string `json:"location,omitempty"`
	StorageClass string `json:"storage_class,omitempty"`
}

// WorkersSubdomain returns the account workers.dev subdomain. Install needs it
// to build PUBLIC_BASE_URL; it never creates or changes the account subdomain.
func (c *Client) WorkersSubdomain(ctx context.Context, accountID string) (string, error) {
	base, err := accountBasePath(accountID)
	if err != nil {
		return "", err
	}
	var result struct {
		Subdomain string `json:"subdomain"`
	}
	if err := c.GetJSON(ctx, base+"/workers/subdomain", nil, &result); err != nil {
		return "", err
	}
	if result.Subdomain == "" {
		return "", errors.New("cloudflare: the account has no workers.dev subdomain")
	}
	if !subdomainPattern.MatchString(result.Subdomain) {
		return "", errors.New("cloudflare: the account workers.dev subdomain has an unexpected shape")
	}
	return result.Subdomain, nil
}

// EnableWorkersDev enables the script's workers.dev route.
//
// Source: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/
func (c *Client) EnableWorkersDev(ctx context.Context, target domain.Target) error {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return err
	}
	return c.SendJSON(ctx, "POST", scriptPath+"/subdomain", map[string]any{"enabled": true}, nil)
}

// ListR2Buckets returns every R2 bucket in the account, following cursor
// pagination. It is also the preflight permission check for R2.
func (c *Client) ListR2Buckets(ctx context.Context, accountID string) ([]R2Bucket, error) {
	base, err := accountBasePath(accountID)
	if err != nil {
		return nil, err
	}
	const perPage = 100
	all := make([]R2Bucket, 0)
	cursor := ""
	for page := 0; page < 1000; page++ {
		query := url.Values{"per_page": {"100"}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		var result struct {
			Buckets []R2Bucket `json:"buckets"`
		}
		info, err := c.GetJSONWithResultInfo(ctx, base+"/r2/buckets", query, &result)
		if err != nil {
			return nil, err
		}
		all = append(all, result.Buckets...)
		var meta struct {
			Cursor string `json:"cursor"`
		}
		if len(info) > 0 {
			_ = json.Unmarshal(info, &meta)
		}
		if meta.Cursor == "" || meta.Cursor == cursor || len(result.Buckets) < perPage {
			break
		}
		cursor = meta.Cursor
	}
	return all, nil
}

// GetR2Bucket reads one bucket. A missing bucket returns ErrNotFound.
func (c *Client) GetR2Bucket(ctx context.Context, accountID, name string) (R2Bucket, error) {
	path, err := r2BucketPath(accountID, name)
	if err != nil {
		return R2Bucket{}, err
	}
	var bucket R2Bucket
	if err := c.GetJSON(ctx, path, nil, &bucket); err != nil {
		return R2Bucket{}, mapNotFound(err)
	}
	return bucket, nil
}

// CreateR2Bucket creates one bucket. Already existing is reported as
// ErrAlreadyExists so a resumed install can decide whether it owns it.
func (c *Client) CreateR2Bucket(ctx context.Context, accountID, name string) error {
	base, err := accountBasePath(accountID)
	if err != nil {
		return err
	}
	if err := ValidateBucketName(name); err != nil {
		return err
	}
	if err := c.SendJSON(ctx, "POST", base+"/r2/buckets", map[string]any{"name": name}, nil); err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			message := strings.ToLower(apiErr.Message)
			if apiErr.Status == 409 || strings.Contains(message, "already exists") || strings.Contains(message, "already owned") {
				return ErrAlreadyExists
			}
		}
		return err
	}
	return nil
}

// DeleteR2Bucket deletes one bucket. It is used by explicit cleanup flows, not
// by install or upgrade.
func (c *Client) DeleteR2Bucket(ctx context.Context, accountID, name string) error {
	path, err := r2BucketPath(accountID, name)
	if err != nil {
		return err
	}
	if err := c.SendJSON(ctx, "DELETE", path, nil, nil); err != nil {
		return mapNotFound(err)
	}
	return nil
}

// DeleteScript deletes a Worker script with force=true, which also allows a
// Worker that owns Durable Object namespaces to be removed.
func (c *Client) DeleteScript(ctx context.Context, target domain.Target) error {
	path, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return err
	}
	if err := c.SendJSONQuery(ctx, "DELETE", path, url.Values{"force": {"true"}}, nil, nil); err != nil {
		return mapNotFound(err)
	}
	return nil
}

func mapNotFound(err error) error {
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == 404 {
		return ErrNotFound
	}
	return err
}

type cronSchedule struct {
	Cron string `json:"cron"`
}

// GetSchedules returns the Worker's cron expressions.
func (c *Client) GetSchedules(ctx context.Context, target domain.Target) ([]string, error) {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return nil, err
	}
	var result struct {
		Schedules []cronSchedule `json:"schedules"`
	}
	if err := c.GetJSON(ctx, scriptPath+"/schedules", nil, &result); err != nil {
		return nil, err
	}
	crons := make([]string, 0, len(result.Schedules))
	for _, schedule := range result.Schedules {
		if schedule.Cron != "" {
			crons = append(crons, schedule.Cron)
		}
	}
	return crons, nil
}

// PutSchedules replaces the Worker's cron triggers. The API body is a bare
// array, not an object.
//
// Source: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/
func (c *Client) PutSchedules(ctx context.Context, target domain.Target, crons []string) error {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return err
	}
	body := make([]cronSchedule, 0, len(crons))
	for _, cron := range crons {
		if strings.TrimSpace(cron) == "" || strings.ContainsAny(cron, "\r\n\x00") {
			return errors.New("cloudflare: cron expression is empty or contains a control character")
		}
		body = append(body, cronSchedule{Cron: cron})
	}
	return c.SendJSON(ctx, "PUT", scriptPath+"/schedules", body, nil)
}

// ScriptUploadPlan carries the non-secret values rebuilt by a non-versioned
// script upload. The template (bindings, compatibility, migrations) comes from
// the verified release manifest.
type ScriptUploadPlan struct {
	ConfigJSON []byte
	BucketName string
	// PlainVars carries every plain-text variable to write, including
	// ACTIVE_CHANNEL and unknowns preserved from a snapshot.
	PlainVars map[string]string
	// BaseTag is the live Durable Object migration tag. An empty tag means a
	// first install and applies the full manifest history.
	BaseTag string
	Message string
}

// ScriptResult is the immediate script upload response. The API may not return
// a version id; the caller confirms it by reading the snapshot afterwards.
type ScriptResult struct {
	ScriptID     string
	MigrationTag string
}

// UploadScript performs a non-versioned PUT of the verified release. It applies
// Durable Object migrations, keeps existing secret_text bindings explicitly,
// and never uploads a secret value.
func (c *Client) UploadScript(ctx context.Context, target domain.Target, manifestJSON []byte, modules map[string][]byte, plan ScriptUploadPlan) (ScriptResult, error) {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the Worker name is invalid"}
	}
	var manifest release.Manifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the verified release manifest could not be decoded"}
	}
	template := manifest.ResourceTemplate
	if template.Entrypoint == "" {
		return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the release manifest has no entrypoint"}
	}
	if _, ok := modules[template.Entrypoint]; !ok {
		return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the release package is missing its entrypoint module"}
	}
	if len(template.R2Buckets) > 0 {
		if err := ValidateBucketName(plan.BucketName); err != nil {
			return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the R2 bucket name is invalid"}
		}
	}

	bindings := make([]any, 0)
	for _, binding := range template.DurableObjects {
		if binding.Name == "" || binding.ClassName == "" {
			return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the release template contains an invalid Durable Object binding"}
		}
		bindings = append(bindings, map[string]any{
			"type":       "durable_object_namespace",
			"name":       binding.Name,
			"class_name": binding.ClassName,
		})
	}
	for _, binding := range template.R2Buckets {
		if binding.Name == "" {
			return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the release template contains an invalid R2 binding"}
		}
		bindings = append(bindings, map[string]any{
			"type":        "r2_bucket",
			"name":        binding.Name,
			"bucket_name": plan.BucketName,
		})
	}
	for _, binding := range template.AIBindings {
		if binding.Name == "" {
			return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the release template contains an invalid AI binding"}
		}
		bindings = append(bindings, map[string]any{
			"type": "ai",
			"name": binding.Name,
		})
	}
	if template.VersionMetadata.Name != "" {
		bindings = append(bindings, map[string]any{
			"type": "version_metadata",
			"name": template.VersionMetadata.Name,
		})
	}
	if len(bytes.TrimSpace(plan.ConfigJSON)) > 0 {
		var config any
		decoder := json.NewDecoder(bytes.NewReader(plan.ConfigJSON))
		decoder.UseNumber()
		if err := decoder.Decode(&config); err != nil {
			return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the configuration binding is not valid JSON"}
		}
		bindings = append(bindings, map[string]any{
			"type": template.ConfigBinding.Type,
			"name": template.ConfigBinding.Name,
			"json": config,
		})
	}
	plainNames := make([]string, 0, len(plan.PlainVars))
	for name := range plan.PlainVars {
		if name == "" {
			return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "a plain variable name is empty"}
		}
		plainNames = append(plainNames, name)
	}
	sort.Strings(plainNames)
	for _, name := range plainNames {
		bindings = append(bindings, map[string]any{
			"type": "plain_text",
			"name": name,
			"text": plan.PlainVars[name],
		})
	}

	migrations, err := scriptMigrations(template.Migrations, plan.BaseTag)
	if err != nil {
		return ScriptResult{}, err
	}

	message := strings.TrimSpace(plan.Message)
	if message == "" {
		message = "DeskWand Bot script upload"
	}
	metadata := map[string]any{
		"main_module":        template.Entrypoint,
		"compatibility_date": template.Compatibility.Date,
		"keep_bindings":      []string{"secret_text"},
		"bindings":           bindings,
		"annotations": map[string]any{
			"workers/tag":     manifest.Version,
			"workers/message": message,
		},
	}
	// Install and upgrade use the non-versioned script upload, so the
	// script-level observability settings must travel in this metadata. The
	// values come from the signed release template, never from user input.
	if template.Observability != nil {
		metadata["observability"] = *template.Observability
	}
	if len(template.Compatibility.Flags) > 0 {
		metadata["compatibility_flags"] = append([]string(nil), template.Compatibility.Flags...)
	}
	if migrations != nil {
		metadata["migrations"] = migrations
	}
	encodedMetadata, err := json.Marshal(metadata)
	if err != nil {
		return ScriptResult{}, domain.Error{Code: domain.NOT_SENT, Message: "the script metadata could not be encoded"}
	}

	parts := []Part{{
		Name:        "metadata",
		ContentType: "application/json",
		Data:        encodedMetadata,
	}}
	paths := make([]string, 0, len(modules))
	for path := range modules {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		parts = append(parts, Part{
			Name:        path,
			FileName:    path,
			ContentType: moduleContentType(path),
			Data:        modules[path],
		})
	}

	var result struct {
		ID           string `json:"id"`
		MigrationTag string `json:"migration_tag"`
	}
	if err := c.SendMultipart(ctx, "PUT", scriptPath, parts, &result); err != nil {
		return ScriptResult{}, err
	}
	return ScriptResult{ScriptID: result.ID, MigrationTag: result.MigrationTag}, nil
}

// scriptMigrations turns the signed migration history into the immediate
// upload metadata. It applies only steps after the live tag. With no new steps
// it omits the field entirely, so a redeploy never repeats a migration.
func scriptMigrations(history []release.Migration, baseTag string) (map[string]any, error) {
	if len(history) == 0 {
		return nil, nil
	}
	start := 0
	if baseTag != "" {
		found := false
		for i, migration := range history {
			if migration.Tag == baseTag {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, domain.Error{
				Code:    "MIGRATION_HISTORY_MISMATCH",
				Message: "the live Durable Object migration tag is not in this release history",
			}
		}
	}
	if start >= len(history) {
		return nil, nil
	}
	steps := history[start:]
	if len(steps) == 1 {
		migration := map[string]any{"new_tag": steps[0].Tag}
		if baseTag != "" {
			migration["old_tag"] = baseTag
		}
		if len(steps[0].NewSQLiteClasses) > 0 {
			migration["new_sqlite_classes"] = append([]string(nil), steps[0].NewSQLiteClasses...)
		}
		return migration, nil
	}

	path := make([]map[string]any, 0, len(steps))
	for _, step := range steps {
		entry := map[string]any{}
		if len(step.NewSQLiteClasses) > 0 {
			entry["new_sqlite_classes"] = append([]string(nil), step.NewSQLiteClasses...)
		}
		path = append(path, entry)
	}
	migration := map[string]any{
		"new_tag": steps[len(steps)-1].Tag,
		"steps":   path,
	}
	if baseTag != "" {
		migration["old_tag"] = baseTag
	}
	return migration, nil
}
