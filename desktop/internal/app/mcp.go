package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/i18n"
	"github.com/deskwand/bot/desktop/internal/mcpadmin"
	"github.com/deskwand/bot/desktop/internal/mcpcatalog"
	"github.com/deskwand/bot/desktop/internal/telemetry"
)

// A server published moments ago is unknown to the Worker until the new
// version takes traffic; probe and OAuth start retry while it says so.
const CodeMcpServerNotFound = "MCP_SERVER_NOT_FOUND"

// Older Workers only sent the Chinese message, without a code.
const mcpServerMissing = "服务不存在" // i18n-ignore: legacy Worker response text

var (
	mcpPropagationTimeout  = 30 * time.Second
	propagationInterval = 2 * time.Second
)

// untilLive retries call while the Worker does not know the server
// yet. missing reports whether a result or error means "not live yet".
func untilLive[T any](ctx context.Context, call func() (T, error), missing func(T, error) bool) (T, error) {
	deadline := time.Now().Add(mcpPropagationTimeout)
	for {
		result, err := call()
		if !missing(result, err) || time.Now().After(deadline) {
			return result, err
		}
		select {
		case <-ctx.Done():
			return result, err
		case <-time.After(propagationInterval):
		}
	}
}

func isMcpServerMissing(err error) bool {
	var derr domain.Error
	return errors.As(err, &derr) &&
		(derr.Code == CodeMcpServerNotFound || derr.Message == mcpServerMissing)
}

// isMcpProbeMissing matches the probe's coded reason, falling back to the
// message an older Worker sent.
func isMcpProbeMissing(probe mcpadmin.Probe) bool {
	return !probe.OK &&
		(probe.ReasonCode == CodeMcpServerNotFound || probe.Reason == mcpServerMissing)
}

var (
	mcpServerNamePattern = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
	mcpSecretNamePattern = regexp.MustCompile(`^MCP_[A-Z0-9_]{1,64}$`)
)

// McpCatalogEntryDTO is one service offered by the built-in catalog.
type McpCatalogEntryDTO struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Category    string        `json:"category"`
	Description string        `json:"description"`
	OAuth       bool          `json:"oauth"`
	Fields      []McpFieldDTO `json:"fields"`
}

// McpFieldDTO describes one value the user supplies for a catalog entry.
type McpFieldDTO struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Help    string `json:"help"`
	HelpURL string `json:"helpUrl"`
}

// McpToolDTO is one tool reported by a probe.
type McpToolDTO struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Mode        string `json:"mode"` // disabled|approval|review|auto
}

// McpProbeDTO is the connection test shown on a service card.
type McpProbeDTO struct {
	OK     bool         `json:"ok"`
	Reason string       `json:"reason,omitempty"`
	Auth   string       `json:"auth,omitempty"` // ok|needs_reauth|unauthorized
	Tools  []McpToolDTO `json:"tools"`
}

// McpAuthDTO is one server's OAuth state.
type McpAuthDTO struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

// McpAddInput is the add-service form. Exactly one of CatalogID or Custom is
// set; Values carries the catalog fields.
type McpAddInput struct {
	CatalogID string            `json:"catalogId"`
	Name      string            `json:"name"`
	Values    map[string]string `json:"values,omitempty"`
	Custom    *McpCustomInput   `json:"custom,omitempty"`
}

// McpCustomInput describes a server entered by URL. Secret header values are
// write-only and never returned.
type McpCustomInput struct {
	URL     string           `json:"url"`
	OAuth   bool             `json:"oauth"`
	Headers []McpHeaderInput `json:"headers,omitempty"`
}

// McpHeaderInput is one custom header. Secret selects MCP_<NAME>_<HEADER>.
type McpHeaderInput struct {
	Name   string `json:"name"`
	Value  string `json:"value,omitempty"`
	Secret bool   `json:"secret"`
}

// McpCatalog returns the built-in service catalog.
func (s *Service) McpCatalog() ([]McpCatalogEntryDTO, error) {
	entries := mcpcatalog.All(s.locale.Current())
	out := make([]McpCatalogEntryDTO, 0, len(entries))
	for _, entry := range entries {
		fields := make([]McpFieldDTO, 0, len(entry.Fields))
		for _, field := range entry.Fields {
			fields = append(fields, McpFieldDTO{
				Key:     field.Key,
				Label:   field.Label,
				Help:    field.Help,
				HelpURL: field.HelpURL,
			})
		}
		out = append(out, McpCatalogEntryDTO{
			ID:          entry.ID,
			Name:        entry.Name,
			Category:    entry.Category,
			Description: entry.Description,
			OAuth:       entry.OAuth,
			Fields:      fields,
		})
	}
	return out, nil
}

// AddMcpServer builds one catalog or custom entry, appends it to the current
// list, and publishes the secrets and configuration together.
func (s *Service) AddMcpServer(input McpAddInput) (ResultDTO, error) {
	ctx := context.Background()
	name := strings.TrimSpace(input.Name)
	if !mcpServerNamePattern.MatchString(name) {
		return ResultDTO{}, invalidMcpName(s.locale.Current())
	}
	cfg, servers, err := s.currentMcpServers(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	for _, raw := range servers {
		if mcpServerName(raw) == name {
			return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.mcpNameExists")}
		}
	}

	values := make([]string, 0, len(input.Values))
	for _, value := range input.Values {
		values = append(values, value)
	}

	var server map[string]any
	var secrets []domain.SecretEdit
	if input.Custom != nil {
		for _, header := range input.Custom.Headers {
			values = append(values, header.Value)
		}
		server, secrets, err = buildCustomMcpServer(s.locale.Current(), name, *input.Custom)
	} else {
		entry, ok := mcpcatalog.Lookup(s.locale.Current(), strings.TrimSpace(input.CatalogID))
		if !ok {
			return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.mcpCatalogEntryMissing")}
		}
		server, secrets, err = mcpcatalog.Build(s.locale.Current(), entry, name, input.Values)
	}
	if err != nil {
		return ResultDTO{}, safeAppError(err, values...)
	}

	encoded, err := json.Marshal(server)
	if err != nil {
		return ResultDTO{}, safeAppError(fmt.Errorf("app: encode mcp server: %w", err), values...)
	}
	updated := append(append([]json.RawMessage{}, servers...), encoded)
	result, err := s.publishMcpServers(cfg, updated, secrets, values...)
	// Adding a server is its own action, so both `mcp` and the `publish` the
	// helper reports are counted on purpose. Updates and removals are not.
	s.reportFeature(telemetry.FeatureMcp, result.State, err)
	return result, err
}

// UpdateMcpServer replaces one entry. The embedded name must stay the same so
// a tool list edit cannot silently rename a card.
func (s *Service) UpdateMcpServer(name string, server json.RawMessage, secrets []SecretEditDTO) (ResultDTO, error) {
	ctx := context.Background()
	name = strings.TrimSpace(name)
	cfg, servers, err := s.currentMcpServers(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	var candidate map[string]any
	if err := json.Unmarshal(server, &candidate); err != nil {
		return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.mcpConfigInvalidJSON")}
	}
	if candidateName, _ := candidate["name"].(string); candidateName != name {
		return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.mcpRenameForbidden")}
	}

	index := -1
	for i, raw := range servers {
		if mcpServerName(raw) == name {
			index = i
			break
		}
	}
	if index < 0 {
		return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.mcpServerNotFound")}
	}
	updated := append([]json.RawMessage{}, servers...)
	updated[index] = append(json.RawMessage(nil), bytes.TrimSpace(server)...)
	return s.publishMcpServers(cfg, updated, domainSecrets(secrets), secretDTOValues(secrets)...)
}

// RemoveMcpServer removes one entry, clears MCP_* secrets only it referenced,
// and asks the Worker to forget its OAuth client and tokens.
func (s *Service) RemoveMcpServer(name string) (ResultDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ResultDTO{}, err
	}
	name = strings.TrimSpace(name)
	cfg, servers, err := s.currentMcpServers(ctx)
	if err != nil {
		return ResultDTO{}, err
	}

	index := -1
	for i, raw := range servers {
		if mcpServerName(raw) == name {
			index = i
			break
		}
	}
	if index < 0 {
		return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.mcpServerNotFound")}
	}

	var removed map[string]any
	if err := json.Unmarshal(servers[index], &removed); err != nil {
		return ResultDTO{}, domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: s.t("app.mcpConfigInvalidJSON")}
	}
	keptRaw := append(append([]json.RawMessage{}, servers[:index]...), servers[index+1:]...)
	kept := make([]map[string]any, 0, len(keptRaw))
	for _, raw := range keptRaw {
		var server map[string]any
		_ = json.Unmarshal(raw, &server)
		kept = append(kept, server)
	}

	configured := make(map[string]bool, len(cfg.Secrets))
	for _, secret := range cfg.Secrets {
		configured[secret.Name] = secret.Configured
	}
	secrets := make([]domain.SecretEdit, 0)
	for _, secretName := range mcpcatalog.Orphaned(removed, kept) {
		if configured[secretName] {
			secrets = append(secrets, domain.NewSecretEdit(secretName, domain.SecretClear, ""))
		}
	}

	result, err := s.publishMcpServers(cfg, keptRaw, secrets)
	if err != nil {
		return result, err
	}
	if oauth, _ := removed["oauth"].(bool); oauth {
		// The configuration is already gone; a failed cleanup must not make
		// the card reappear. A later authorization replaces the old entry.
		if client, err := s.mcpClient(ctx, target); err == nil {
			_ = client.Revoke(ctx, name)
		}
	}
	return result, nil
}

// ProbeMcp connects to one server through the Worker and returns its tools.
func (s *Service) ProbeMcp(name string) (McpProbeDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return McpProbeDTO{}, err
	}
	client, err := s.mcpClient(ctx, target)
	if err != nil {
		return McpProbeDTO{}, safeAppError(err)
	}
	result, err := untilLive(ctx,
		func() (mcpadmin.Probe, error) { return client.Probe(ctx, strings.TrimSpace(name)) },
		func(probe mcpadmin.Probe, err error) bool {
			return err == nil && isMcpProbeMissing(probe)
		})
	if err != nil {
		return McpProbeDTO{}, safeAppError(err)
	}
	dto := McpProbeDTO{
		OK:     result.OK,
		Reason: result.Reason,
		Auth:   result.Auth,
		Tools:  make([]McpToolDTO, 0, len(result.Tools)),
	}
	for _, tool := range result.Tools {
		dto.Tools = append(dto.Tools, McpToolDTO{Name: tool.Name, Description: tool.Description, Mode: tool.Mode})
	}
	return dto, nil
}

// McpStatus lists every configured server's authorization state.
func (s *Service) McpStatus() ([]McpAuthDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return []McpAuthDTO{}, err
	}
	client, err := s.mcpClient(ctx, target)
	if err != nil {
		return []McpAuthDTO{}, safeAppError(err)
	}
	statuses, err := client.Status(ctx)
	if err != nil {
		return []McpAuthDTO{}, safeAppError(err)
	}
	out := make([]McpAuthDTO, 0, len(statuses))
	for _, status := range statuses {
		out = append(out, McpAuthDTO{Name: status.Name, State: status.State})
	}
	return out, nil
}

// StartMcpOAuth asks the Worker for an authorization URL and opens it in the
// system browser. The token never leaves the Worker.
func (s *Service) StartMcpOAuth(name string) error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.mcpClient(ctx, target)
	if err != nil {
		return safeAppError(err)
	}
	authorizeURL, err := untilLive(ctx,
		func() (string, error) { return client.StartOAuth(ctx, strings.TrimSpace(name)) },
		func(_ string, err error) bool { return isMcpServerMissing(err) })
	if err != nil {
		return safeAppError(err)
	}
	if authorizeURL == "" {
		return domain.Error{Code: mcpadmin.CodeRequestFailed, Message: s.t("app.mcpNoAuthorizeURL")}
	}
	opener := s.mcpBrowser
	if opener == nil {
		opener = s.browser
	}
	if opener == nil {
		return s.serviceUnavailable()
	}
	if err := opener.Open(authorizeURL); err != nil {
		return domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.browserOpenFailed")}
	}
	return nil
}

func (s *Service) mcpClient(ctx context.Context, target domain.Target) (*mcpadmin.Client, error) {
	if s.snapshots == nil || s.publish == nil || s.credentials == nil {
		return nil, s.serviceUnavailable()
	}
	client, err := mcpadmin.Connect(ctx, mcpadmin.Deps{
		Token: backup.TokenDeps{
			Snapshots:   s.snapshots,
			Publisher:   s.publish,
			Credentials: s.credentials,
		},
		Locale: s.locale.Current,
	}, target)
	if err != nil {
		return nil, err
	}
	client.Locale = s.locale.Current
	return client, nil
}

func (s *Service) currentMcpServers(ctx context.Context) (ConfigDTO, []json.RawMessage, error) {
	cfg, err := s.GetConfig()
	if err != nil {
		return ConfigDTO{}, nil, err
	}
	servers, err := decodeMcpServers(s.locale.Current(), cfg.McpServers)
	if err != nil {
		return ConfigDTO{}, nil, err
	}
	return cfg, servers, nil
}

func (s *Service) publishMcpServers(cfg ConfigDTO, servers []json.RawMessage, secrets []domain.SecretEdit, values ...string) (ResultDTO, error) {
	raw, err := json.Marshal(servers)
	if err != nil {
		return ResultDTO{}, fmt.Errorf("app: encode mcp servers: %w", err)
	}
	message := json.RawMessage(raw)
	edits := make([]SecretEditDTO, 0, len(secrets))
	for _, secret := range secrets {
		edits = append(edits, SecretEditDTO{Name: secret.Name, Operation: secret.Operation, Value: secret.Value()})
		if value := secret.Value(); value != "" {
			values = append(values, value)
		}
	}
	result, err := s.PublishConfig(ConfigEditDTO{
		BaseFingerprint: cfg.Fingerprint,
		McpServers:      &message,
		Secrets:         edits,
	})
	return result, safeAppError(err, values...)
}

func secretDTOValues(secrets []SecretEditDTO) []string {
	values := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		if secret.Value != "" {
			values = append(values, secret.Value)
		}
	}
	return values
}

func decodeMcpServers(locale string, raw json.RawMessage) ([]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	var servers []json.RawMessage
	if err := json.Unmarshal(trimmed, &servers); err != nil {
		return nil, domain.Error{Code: domain.UNSUPPORTED_SCHEMA, Message: i18n.T(locale, "app.mcpServersNotArray")}
	}
	return servers, nil
}

func mcpServerName(raw json.RawMessage) string {
	var server struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &server); err != nil {
		return ""
	}
	return server.Name
}

func buildCustomMcpServer(locale, name string, custom McpCustomInput) (map[string]any, []domain.SecretEdit, error) {
	serverURL := strings.TrimSpace(custom.URL)
	if serverURL == "" {
		return nil, nil, domain.Error{Code: deployment.CodeInvalidRequest, Message: i18n.T(locale, "app.mcpURLRequired")}
	}
	server := map[string]any{
		"name":           name,
		"url":            serverURL,
		"oauth":          custom.OAuth,
		"approvalPolicy": "writes",
	}
	headers := map[string]any{}
	secrets := make([]domain.SecretEdit, 0, len(custom.Headers))
	for _, header := range custom.Headers {
		headerName := strings.TrimSpace(header.Name)
		value := strings.TrimSpace(header.Value)
		if headerName == "" {
			continue
		}
		if value == "" {
			return nil, nil, fmt.Errorf("%s", i18n.T(locale, "app.mcpHeaderValueRequired", headerName))
		}
		if header.Secret {
			secretName := mcpHeaderSecretName(name, headerName)
			if !mcpSecretNamePattern.MatchString(secretName) {
				return nil, nil, fmt.Errorf("%s", i18n.T(locale, "app.mcpHeaderSecretInvalid", headerName))
			}
			headers[headerName] = "env:" + secretName
			secrets = append(secrets, domain.NewSecretEdit(secretName, domain.SecretReplace, value))
			continue
		}
		headers[headerName] = value
	}
	if len(headers) > 0 {
		server["headers"] = headers
	}
	return server, secrets, nil
}

func mcpHeaderSecretName(server, header string) string {
	return "MCP_" + strings.ToUpper(server) + "_" + strings.ToUpper(strings.ReplaceAll(header, "-", "_"))
}

func domainSecrets(secrets []SecretEditDTO) []domain.SecretEdit {
	out := make([]domain.SecretEdit, 0, len(secrets))
	for _, secret := range secrets {
		out = append(out, domain.NewSecretEdit(secret.Name, secret.Operation, secret.Value))
	}
	return out
}

func invalidMcpName(locale string) error {
	return domain.Error{
		Code:    deployment.CodeInvalidRequest,
		Message: i18n.T(locale, "app.mcpNameInvalid"),
	}
}
