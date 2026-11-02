package cloudflare

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// configBindingName is the single JSON binding that carries the editable
// deployment configuration. It must match contracts/release-template.json.
const configBindingName = "DESKWAND_CONFIG"

// supportedBindingTypes is the complete binding set the v1 client can
// round-trip. Anything else blocks editing rather than being dropped.
var supportedBindingTypes = map[string]bool{
	"durable_object_namespace": true,
	"r2_bucket":                true,
	"version_metadata":         true,
	"plain_text":               true,
	"json":                     true,
	"secret_text":              true,
}

// volatileSettingsFields change without a configuration or code change, so
// they must not affect the fingerprint. Secret binding values are removed
// separately; Cloudflare never returns them.
var volatileSettingsFields = map[string]bool{
	"last_analyzed_at": true,
}

// volatilePlacementFields are timestamp fields nested under settings.placement.
var volatilePlacementFields = map[string]bool{
	"last_analyzed_at": true,
}

type bindingDocument struct {
	Name string          `json:"name"`
	Type string          `json:"type"`
	JSON json.RawMessage `json:"json"`
}

type settingsDocument struct {
	Bindings []json.RawMessage `json:"bindings"`
	// Annotations are decoded as generic values so one unexpected annotation
	// type cannot fail the whole snapshot.
	Annotations map[string]any `json:"annotations"`
}

type deploymentDocument struct {
	ID       string `json:"id"`
	Versions []struct {
		VersionID  string  `json:"version_id"`
		Percentage float64 `json:"percentage"`
	} `json:"versions"`
}

type deploymentList struct {
	Deployments []deploymentDocument `json:"deployments"`
}

type versionList struct {
	Items []struct {
		ID string `json:"id"`
	} `json:"items"`
}

type fingerprintInput struct {
	Settings        json.RawMessage      `json:"settings"`
	DeploymentID    string               `json:"deploymentId"`
	ActiveVersions  []fingerprintVersion `json:"activeVersions"`
	SecretNames     []string             `json:"secretNames"`
	LatestVersionID string               `json:"latestVersionId"`
}

type fingerprintVersion struct {
	VersionID  string  `json:"versionId"`
	Percentage float64 `json:"percentage"`
}

// ReadSnapshot reads the script settings, latest deployment and latest
// uploaded version, then computes a fingerprint over everything a publish
// would replace. It never reads secret values.
//
// Endpoints and response shapes:
//   - https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
//   - https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
//   - https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/
func (c *Client) ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error) {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return domain.Snapshot{}, err
	}

	var rawSettings json.RawMessage
	if err := c.GetJSON(ctx, scriptPath+"/settings", nil, &rawSettings); err != nil {
		return domain.Snapshot{}, err
	}

	var deployments deploymentList
	if err := c.GetJSON(ctx, scriptPath+"/deployments", url.Values{"per_page": {"1"}}, &deployments); err != nil {
		return domain.Snapshot{}, err
	}
	if len(deployments.Deployments) == 0 {
		return domain.Snapshot{}, fmt.Errorf("cloudflare: script %q has no deployments", target.ScriptName)
	}
	deployment := deployments.Deployments[0]

	var versions versionList
	if err := c.GetJSON(ctx, scriptPath+"/versions", url.Values{"per_page": {"1"}}, &versions); err != nil {
		return domain.Snapshot{}, err
	}
	if len(versions.Items) == 0 {
		return domain.Snapshot{}, fmt.Errorf("cloudflare: script %q has no versions", target.ScriptName)
	}

	configJSON, settingsJSON, secretNames, releaseVersion, err := reduceSettings(rawSettings)
	if err != nil {
		return domain.Snapshot{}, err
	}

	active := make([]fingerprintVersion, 0, len(deployment.Versions))
	for _, version := range deployment.Versions {
		if version.Percentage > 0 {
			active = append(active, fingerprintVersion{
				VersionID:  version.VersionID,
				Percentage: version.Percentage,
			})
		}
	}
	if len(active) > 1 {
		return domain.Snapshot{}, domain.Error{
			Code:    domain.MULTI_VERSION_DEPLOYMENT,
			Message: "the deployment splits traffic across more than one version; consolidate to a single version before editing",
		}
	}
	sort.Slice(active, func(i, j int) bool {
		if active[i].VersionID == active[j].VersionID {
			return active[i].Percentage < active[j].Percentage
		}
		return active[i].VersionID < active[j].VersionID
	})

	versionID := ""
	if len(active) == 1 {
		versionID = active[0].VersionID
	}

	latestVersionID := versions.Items[0].ID
	fingerprint, err := snapshotFingerprint(settingsJSON, deployment.ID, active, secretNames, latestVersionID)
	if err != nil {
		return domain.Snapshot{}, err
	}

	return domain.Snapshot{
		Target:             target,
		DeploymentID:       deployment.ID,
		VersionID:          versionID,
		ConfigJSON:         configJSON,
		SettingsJSON:       settingsJSON,
		SecretNames:        secretNames,
		Fingerprint:        fingerprint,
		ActiveVersionCount: len(active),
		ReleaseVersion:     releaseVersion,
		LatestVersionID:    latestVersionID,
	}, nil
}

// reduceSettings validates binding types, extracts the configuration binding,
// strips secret values from the retained settings document and collects the
// secret names. The ReleaseVersion comes from the script annotation
// `workers/tag`, which the release upload writes.
func reduceSettings(raw json.RawMessage) ([]byte, []byte, []string, string, error) {
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, nil, nil, "", fmt.Errorf("cloudflare: decode script settings: %w", err)
	}

	var document settingsDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, nil, nil, "", fmt.Errorf("cloudflare: decode script settings: %w", err)
	}

	var configJSON []byte
	secretNames := make([]string, 0)
	type parsedBinding struct {
		raw json.RawMessage
		doc bindingDocument
	}
	parsed := make([]parsedBinding, 0, len(document.Bindings))
	for _, rawBinding := range document.Bindings {
		var binding bindingDocument
		if err := json.Unmarshal(rawBinding, &binding); err != nil {
			return nil, nil, nil, "", fmt.Errorf("cloudflare: decode binding: %w", err)
		}
		if !supportedBindingTypes[binding.Type] {
			return nil, nil, nil, "", domain.Error{
				Code:    domain.UNSUPPORTED_BINDING,
				Message: fmt.Sprintf("binding %q has unsupported type %q", binding.Name, binding.Type),
			}
		}
		parsed = append(parsed, parsedBinding{raw: rawBinding, doc: binding})
	}
	// Sort by binding name so a semantically identical settings document
	// produces the same fingerprint regardless of API ordering.
	sort.SliceStable(parsed, func(i, j int) bool {
		if parsed[i].doc.Name != parsed[j].doc.Name {
			return parsed[i].doc.Name < parsed[j].doc.Name
		}
		if parsed[i].doc.Type != parsed[j].doc.Type {
			return parsed[i].doc.Type < parsed[j].doc.Type
		}
		return string(parsed[i].raw) < string(parsed[j].raw)
	})

	reducedBindings := make([]any, 0, len(parsed))
	for _, item := range parsed {
		binding := item.doc
		switch binding.Type {
		case "secret_text":
			secretNames = append(secretNames, binding.Name)
			reducedBindings = append(reducedBindings, map[string]any{
				"name": binding.Name,
				"type": binding.Type,
			})
			continue
		case "json":
			if binding.Name == configBindingName {
				if len(bytes.TrimSpace(binding.JSON)) > 0 && string(bytes.TrimSpace(binding.JSON)) != "null" {
					canonical, err := domain.CanonicalizeJSON(binding.JSON)
					if err != nil {
						return nil, nil, nil, "", fmt.Errorf("cloudflare: decode %s binding: %w", configBindingName, err)
					}
					configJSON = canonical
				}
			}
		}

		preserved, err := domain.DecodeJSON(item.raw)
		if err != nil {
			return nil, nil, nil, "", fmt.Errorf("cloudflare: decode binding: %w", err)
		}
		reducedBindings = append(reducedBindings, preserved)
	}

	sort.Strings(secretNames)
	uniqueSecrets := secretNames[:0]
	for _, name := range secretNames {
		if len(uniqueSecrets) == 0 || uniqueSecrets[len(uniqueSecrets)-1] != name {
			uniqueSecrets = append(uniqueSecrets, name)
		}
	}
	secretNames = uniqueSecrets

	encodedBindings, err := json.Marshal(reducedBindings)
	if err != nil {
		return nil, nil, nil, "", fmt.Errorf("cloudflare: encode reduced bindings: %w", err)
	}
	settings["bindings"] = encodedBindings

	settingsJSON, err := domain.CanonicalJSON(settings)
	if err != nil {
		return nil, nil, nil, "", fmt.Errorf("cloudflare: encode settings: %w", err)
	}
	releaseVersion := ""
	// `workers/tag` in settings annotations is not verified live. Task 6 writes
	// the tag; verify the actual readback there and keep this empty on unknown.
	if tag, ok := document.Annotations["workers/tag"].(string); ok {
		releaseVersion = tag
	}
	return configJSON, settingsJSON, secretNames, releaseVersion, nil
}

func snapshotFingerprint(settingsJSON []byte, deploymentID string, active []fingerprintVersion, secretNames []string, latestVersionID string) (string, error) {
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(settingsJSON, &settings); err != nil {
		return "", fmt.Errorf("cloudflare: decode settings for fingerprint: %w", err)
	}
	for name := range volatileSettingsFields {
		delete(settings, name)
	}
	if rawPlacement, ok := settings["placement"]; ok {
		var placement map[string]json.RawMessage
		if err := json.Unmarshal(rawPlacement, &placement); err == nil {
			for name := range volatilePlacementFields {
				delete(placement, name)
			}
			updated, err := domain.CanonicalJSON(placement)
			if err != nil {
				return "", fmt.Errorf("cloudflare: encode fingerprint placement: %w", err)
			}
			settings["placement"] = updated
		}
	}
	stableSettings, err := domain.CanonicalJSON(settings)
	if err != nil {
		return "", fmt.Errorf("cloudflare: encode fingerprint settings: %w", err)
	}

	input := fingerprintInput{
		Settings:        stableSettings,
		DeploymentID:    deploymentID,
		ActiveVersions:  active,
		SecretNames:     secretNames,
		LatestVersionID: latestVersionID,
	}
	if input.SecretNames == nil {
		input.SecretNames = []string{}
	}
	encoded, err := domain.CanonicalJSON(input)
	if err != nil {
		return "", fmt.Errorf("cloudflare: encode fingerprint: %w", err)
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}
