package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/release"
)

// PreservePolicy carries the secret names that must be inherited from the
// latest uploaded version, plus the operation ID used in the version
// annotation. Secret values are never stored here.
type PreservePolicy struct {
	SecretNames []string
	OperationID string
}

type versionMetadata struct {
	MainModule         string            `json:"main_module"`
	CompatibilityDate  string            `json:"compatibility_date"`
	CompatibilityFlags []string          `json:"compatibility_flags,omitempty"`
	Bindings           []any             `json:"bindings"`
	Annotations        map[string]string `json:"annotations"`
}

type settingsBindingDocument struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	ClassName  string `json:"class_name"`
	BucketName string `json:"bucket_name"`
	Text       string `json:"text"`
}

type baseBinding struct {
	settingsBindingDocument
	Raw json.RawMessage
}

type versionUploadResult struct {
	ID string `json:"id"`
}

type versionListWithAnnotations struct {
	Items []struct {
		ID          string                     `json:"id"`
		Annotations map[string]json.RawMessage `json:"annotations"`
	} `json:"items"`
}

// FindVersionByOperation positively identifies a version uploaded by this
// operation. Cloudflare keeps annotations in the versions list, so the exact
// annotation is the only safe evidence that the latest upload belongs to us.
func (c *Client) FindVersionByOperation(ctx context.Context, target domain.Target, operationID string) (versionID string, isLatest bool, found bool, err error) {
	if strings.TrimSpace(operationID) == "" {
		return "", false, false, fmt.Errorf("cloudflare: operation id is empty")
	}
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return "", false, false, err
	}
	var versions versionListWithAnnotations
	if err := c.GetJSON(ctx, scriptPath+"/versions", url.Values{"per_page": {"20"}}, &versions); err != nil {
		return "", false, false, err
	}
	want := "DeskWand Bot publish " + operationID
	for index, item := range versions.Items {
		raw, ok := item.Annotations["workers/message"]
		if !ok {
			continue
		}
		var message string
		if err := json.Unmarshal(raw, &message); err != nil {
			continue
		}
		if message == want {
			return item.ID, index == 0, true, nil
		}
	}
	return "", false, false, nil
}

// CreateVersion uploads a version that changes configuration and secrets but
// never carries Durable Object migrations. It re-lists versions immediately
// before upload and refuses to inherit from anything except the version the
// caller snapshotted: Cloudflare resolves inherit only from the latest
// uploaded version.
//
// The returned id is the newly uploaded version. Callers must activate it with
// ActivateVersion before treating the change as published.
func (c *Client) CreateVersion(ctx context.Context, base domain.Snapshot, manifestJSON []byte, modules map[string][]byte, plan domain.PublishPlan, preserve PreservePolicy) (string, error) {
	if strings.TrimSpace(preserve.OperationID) == "" {
		return "", domain.Error{Code: domain.NOT_SENT, Message: "an operation id is required for a version upload"}
	}
	scriptPath, err := workerScriptPath(base.Target.AccountID, base.Target.ScriptName)
	if err != nil {
		return "", err
	}

	var versions versionList
	if err := c.GetJSON(ctx, scriptPath+"/versions", url.Values{"per_page": {"1"}}, &versions); err != nil {
		return "", notSentError("could not list versions before upload")
	}
	if len(versions.Items) == 0 {
		return "", domain.Error{Code: domain.LATEST_NOT_BASE, Message: "the Worker has no uploaded version to inherit from"}
	}
	latest := versions.Items[0].ID
	if base.VersionID == "" || latest != base.VersionID || latest != base.LatestVersionID {
		return "", domain.Error{
			Code:    domain.LATEST_NOT_BASE,
			Message: "the latest uploaded version changed since the snapshot was read; refresh before publishing",
		}
	}

	var manifest release.Manifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return "", notSentError("could not decode the verified release manifest")
	}

	metadata, err := buildVersionMetadata(base, manifest, plan, preserve)
	if err != nil {
		if code := domainErrorCode(err); code != "" {
			return "", err
		}
		return "", notSentError("could not build version metadata")
	}
	encodedMetadata, err := json.Marshal(metadata)
	if err != nil {
		return "", notSentError("could not encode version metadata")
	}

	parts := []Part{{
		Name:        "metadata",
		ContentType: "application/json",
		Data:        encodedMetadata,
	}}
	paths := make([]string, 0, len(modules))
	for modulePath := range modules {
		paths = append(paths, modulePath)
	}
	sort.Strings(paths)
	for _, modulePath := range paths {
		parts = append(parts, Part{
			Name:        modulePath,
			FileName:    modulePath,
			ContentType: moduleContentType(modulePath),
			Data:        modules[modulePath],
		})
	}

	var result versionUploadResult
	if err := c.SendMultipartQuery(ctx, "POST", scriptPath+"/versions", url.Values{"bindings_inherit": {"strict"}}, parts, &result); err != nil {
		return "", err
	}
	if result.ID == "" {
		return "", fmt.Errorf("cloudflare: version upload returned no version id")
	}
	return result.ID, nil
}

func notSentError(message string) error {
	return domain.Error{Code: domain.NOT_SENT, Message: message}
}

func domainErrorCode(err error) string {
	var domainErr domain.Error
	if err != nil && errors.As(err, &domainErr) {
		return domainErr.Code
	}
	return ""
}

func moduleContentType(modulePath string) string {
	switch strings.ToLower(path.Ext(modulePath)) {
	case ".js", ".mjs":
		return "application/javascript+module"
	default:
		return "application/octet-stream"
	}
}

func buildVersionMetadata(base domain.Snapshot, manifest release.Manifest, plan domain.PublishPlan, preserve PreservePolicy) (versionMetadata, error) {
	template := manifest.ResourceTemplate
	metadata := versionMetadata{
		MainModule:        manifest.Entrypoint,
		CompatibilityDate: manifest.Compatibility.Date,
		Bindings:          make([]any, 0),
		Annotations: map[string]string{
			"workers/tag": manifest.Version,
		},
	}
	if len(manifest.Compatibility.Flags) > 0 {
		metadata.CompatibilityFlags = append([]string(nil), manifest.Compatibility.Flags...)
	}
	metadata.Annotations["workers/message"] = "DeskWand Bot publish " + preserve.OperationID

	baseBindings, err := decodeBaseBindings(base.SettingsJSON)
	if err != nil {
		return versionMetadata{}, err
	}

	rebuilt := map[string]bool{}
	for _, binding := range template.DurableObjects {
		metadata.Bindings = append(metadata.Bindings, map[string]any{
			"type":       "durable_object_namespace",
			"name":       binding.Name,
			"class_name": binding.ClassName,
		})
		rebuilt[binding.Name] = true
	}
	for _, binding := range template.R2Buckets {
		bucketName := ""
		if existing, ok := baseBindings[binding.Name]; ok && existing.Type == "r2_bucket" {
			bucketName = existing.BucketName
		}
		if bucketName == "" {
			return versionMetadata{}, fmt.Errorf("cloudflare: R2 binding %q has no bucket name in the current settings", binding.Name)
		}
		metadata.Bindings = append(metadata.Bindings, map[string]any{
			"type":        "r2_bucket",
			"name":        binding.Name,
			"bucket_name": bucketName,
		})
		rebuilt[binding.Name] = true
	}
	if template.VersionMetadata.Name != "" {
		metadata.Bindings = append(metadata.Bindings, map[string]any{
			"type": "version_metadata",
			"name": template.VersionMetadata.Name,
		})
		rebuilt[template.VersionMetadata.Name] = true
	}
	if template.ConfigBinding.Name != "" {
		rebuilt[template.ConfigBinding.Name] = true
		config := plan.ConfigJSON
		if len(config) == 0 {
			config = base.ConfigJSON
		}
		if len(config) > 0 {
			var value any
			decoder := json.NewDecoder(bytes.NewReader(config))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil {
				return versionMetadata{}, fmt.Errorf("cloudflare: decode %s binding: %w", template.ConfigBinding.Name, err)
			}
			metadata.Bindings = append(metadata.Bindings, map[string]any{
				"type": template.ConfigBinding.Type,
				"name": template.ConfigBinding.Name,
				"json": value,
			})
		}
	}

	// Carry through every supported binding the template does not rebuild.
	// Extra Durable Object bindings are rejected because silently dropping a
	// class would change the Worker's resource wiring.
	extraNames := make([]string, 0)
	for name, binding := range baseBindings {
		if name == "" || rebuilt[name] || binding.Type == "plain_text" || binding.Type == "secret_text" {
			continue
		}
		extraNames = append(extraNames, name)
	}
	sort.Strings(extraNames)
	for _, name := range extraNames {
		binding := baseBindings[name]
		switch binding.Type {
		case "durable_object_namespace":
			return versionMetadata{}, domain.Error{
				Code:    domain.UNSUPPORTED_BINDING,
				Message: fmt.Sprintf("binding %q is a Durable Object not declared by the release template", name),
			}
		case "json", "r2_bucket", "version_metadata", "plain_text", "secret_text":
			metadata.Bindings = append(metadata.Bindings, json.RawMessage(append([]byte(nil), binding.Raw...)))
		default:
			return versionMetadata{}, domain.Error{
				Code:    domain.UNSUPPORTED_BINDING,
				Message: fmt.Sprintf("binding %q has unsupported type %q", name, binding.Type),
			}
		}
	}

	// Validate variable overrides before building anything that could be
	// uploaded. Only names the signed release template declares as plain
	// variables may be changed by a publish.
	allowedVars := make(map[string]bool, len(template.PlainVars))
	for _, name := range template.PlainVars {
		allowedVars[name] = true
	}
	for name := range plan.Vars {
		if !allowedVars[name] {
			return versionMetadata{}, domain.Error{
				Code:    domain.NOT_SENT,
				Message: fmt.Sprintf("variable %q is not declared by the release template", name),
			}
		}
	}

	// Copy every plain-text variable from the current settings. This keeps
	// variables the UI never exposes intact even when they are not listed in
	// the release template, then applies the explicit overrides from the
	// publish plan (for example ACTIVE_CHANNEL).
	plainNames := make([]string, 0)
	plainSeen := make(map[string]bool, len(baseBindings)+len(plan.Vars))
	for name, binding := range baseBindings {
		if binding.Type == "plain_text" && name != template.ConfigBinding.Name {
			plainNames = append(plainNames, name)
			plainSeen[name] = true
		}
	}
	for name := range plan.Vars {
		if !plainSeen[name] {
			plainNames = append(plainNames, name)
			plainSeen[name] = true
		}
	}
	sort.Strings(plainNames)
	for _, name := range plainNames {
		text := baseBindings[name].Text
		if value, ok := plan.Vars[name]; ok {
			text = value
		}
		metadata.Bindings = append(metadata.Bindings, map[string]any{
			"type": "plain_text",
			"name": name,
			"text": text,
		})
	}

	replaced := map[string]bool{}
	cleared := map[string]bool{}
	replaceValues := map[string]string{}
	for _, edit := range plan.Secrets {
		switch edit.Operation {
		case domain.SecretReplace:
			replaced[edit.Name] = true
			replaceValues[edit.Name] = edit.Value()
		case domain.SecretClear:
			cleared[edit.Name] = true
		}
	}
	inherit := map[string]bool{}
	for _, name := range base.SecretNames {
		if !replaced[name] && !cleared[name] {
			inherit[name] = true
		}
	}
	for _, name := range preserve.SecretNames {
		if !replaced[name] && !cleared[name] {
			inherit[name] = true
		}
	}
	for _, name := range sortedKeys(replaceValues) {
		metadata.Bindings = append(metadata.Bindings, map[string]any{
			"type": "secret_text",
			"name": name,
			"text": replaceValues[name],
		})
	}
	for _, name := range sortedKeysBool(inherit) {
		metadata.Bindings = append(metadata.Bindings, map[string]any{
			"type": "inherit",
			"name": name,
		})
	}

	return metadata, nil
}

func decodeBaseBindings(settingsJSON []byte) (map[string]baseBinding, error) {
	document := struct {
		Bindings []json.RawMessage `json:"bindings"`
	}{}
	if len(bytes.TrimSpace(settingsJSON)) > 0 {
		if err := json.Unmarshal(settingsJSON, &document); err != nil {
			return nil, fmt.Errorf("cloudflare: decode current settings bindings: %w", err)
		}
	}
	bindings := make(map[string]baseBinding, len(document.Bindings))
	for _, raw := range document.Bindings {
		var binding settingsBindingDocument
		if err := json.Unmarshal(raw, &binding); err != nil {
			return nil, fmt.Errorf("cloudflare: decode current setting binding: %w", err)
		}
		if binding.Name != "" {
			bindings[binding.Name] = baseBinding{
				settingsBindingDocument: binding,
				Raw:                     append(json.RawMessage(nil), raw...),
			}
		}
	}
	return bindings, nil
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedKeysBool(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key, enabled := range values {
		if enabled {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}
