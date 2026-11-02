package cloudflare

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const (
	activationPollAttempts = 30
	activationPollInterval = time.Second
)

// VersionPercentage is one entry in a deployment's traffic split.
type VersionPercentage struct {
	VersionID  string  `json:"version_id"`
	Percentage float64 `json:"percentage"`
}

// DeploymentState is the current deployment and its traffic split.
type DeploymentState struct {
	ID       string
	Versions []VersionPercentage
}

// ActiveVersionID returns the single version receiving traffic, or an empty
// string when the deployment is missing, split, or unreadable.
func (d DeploymentState) ActiveVersionID() string {
	active := ""
	for _, version := range d.Versions {
		if version.Percentage <= 0 {
			continue
		}
		if active != "" && active != version.VersionID {
			return ""
		}
		active = version.VersionID
	}
	return active
}

type deploymentStateDocument struct {
	Deployments []deploymentDocument `json:"deployments"`
}

// CurrentDeployment reads the latest deployment and its active version(s).
func (c *Client) CurrentDeployment(ctx context.Context, target domain.Target) (DeploymentState, error) {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return DeploymentState{}, err
	}
	var list deploymentStateDocument
	if err := c.GetJSON(ctx, scriptPath+"/deployments", url.Values{"per_page": {"1"}}, &list); err != nil {
		return DeploymentState{}, err
	}
	if len(list.Deployments) == 0 {
		return DeploymentState{}, fmt.Errorf("cloudflare: script %q has no deployments", target.ScriptName)
	}
	document := list.Deployments[0]
	state := DeploymentState{ID: document.ID, Versions: make([]VersionPercentage, 0, len(document.Versions))}
	for _, version := range document.Versions {
		state.Versions = append(state.Versions, VersionPercentage{
			VersionID:  version.VersionID,
			Percentage: version.Percentage,
		})
	}
	return state, nil
}

// ActivateVersion creates a 100% deployment for versionID and then confirms
// the result from the deployments list. The create response carries only a
// deployment id, so polling is the authoritative confirmation.
func (c *Client) ActivateVersion(ctx context.Context, target domain.Target, versionID string) (domain.Result, error) {
	scriptPath, err := workerScriptPath(target.AccountID, target.ScriptName)
	if err != nil {
		return domain.Result{}, err
	}
	if strings.TrimSpace(versionID) == "" {
		return domain.Result{}, fmt.Errorf("cloudflare: version id is empty")
	}

	body := map[string]any{
		"strategy": "percentage",
		"versions": []any{map[string]any{
			"version_id": versionID,
			"percentage": 100,
		}},
		"annotations": map[string]any{
			"workers/message": "DeskWand Bot activate " + versionID,
		},
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := c.SendJSON(ctx, "POST", scriptPath+"/deployments", body, &created); err != nil {
		return domain.Result{}, err
	}
	if created.ID == "" {
		return domain.Result{}, fmt.Errorf("cloudflare: deployment creation returned no deployment id")
	}

	for attempt := 0; attempt < activationPollAttempts; attempt++ {
		state, err := c.CurrentDeployment(ctx, target)
		if err != nil {
			return domain.Result{}, err
		}
		if state.ActiveVersionID() == versionID {
			return domain.Result{
				DeploymentID: state.ID,
				VersionID:    versionID,
				State:        "active",
			}, nil
		}
		if attempt == activationPollAttempts-1 {
			break
		}
		if err := c.sleep(ctx, activationPollInterval); err != nil {
			return domain.Result{}, err
		}
	}
	return domain.Result{}, fmt.Errorf("cloudflare: deployment %s did not activate version %s", created.ID, versionID)
}
