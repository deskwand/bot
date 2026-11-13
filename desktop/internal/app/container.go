package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"github.com/deskwand/bot/desktop/internal/config"
	"github.com/deskwand/bot/desktop/internal/container"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/egoist/mygo"
)

// ContainerRuntime is the SSH-hosted container implementation the app needs.
// *container.Service implements it.
type ContainerRuntime interface {
	Preflight(ctx context.Context, target domain.Target) (container.PreflightReport, error)
	Install(ctx context.Context, target domain.Target, request container.InstallRequest, onStep func(domain.Step)) (domain.Result, error)
	Status(ctx context.Context, target domain.Target) (container.RuntimeStatus, error)
	RestorePrevious(ctx context.Context, target domain.Target) (domain.Result, error)
	ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error)
}

// SSHProber probes and pins SSH host keys and keeps host credentials. The
// production implementation lives in main; Trust must probe again on the same
// client before recording a key.
type SSHProber interface {
	Probe(ctx context.Context, host domain.HostRef) (fingerprint string, known bool, err error)
	Trust(ctx context.Context, host domain.HostRef, fingerprint string) error
	StoreSecret(ctx context.Context, host domain.HostRef, secret string) error
	Forget(ctx context.Context, host domain.HostRef) error
}

// ContainerProgressEvent carries install step updates to the frontend.
// `mygo generate` turns it into `events.containerProgress`.
var ContainerProgressEvent = mygo.NewEvent[StepDTO]("container-progress")

// SSHHostInputDTO is one SSH host submitted by the setup flow. Secret is a
// password or private-key passphrase and is write-only: it is never returned,
// logged or persisted locally.
type SSHHostInputDTO struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	Auth    string `json:"auth"`
	KeyPath string `json:"keyPath,omitempty"`
	Secret  string `json:"secret,omitempty"`
	Dir     string `json:"dir,omitempty"`
}

// SSHProbeDTO is the host key first seen during a probe. Known reports that
// the key already matches the recorded one.
type SSHProbeDTO struct {
	Fingerprint string `json:"fingerprint"`
	Known       bool   `json:"known"`
}

// ContainerCheckDTO is one preflight result.
type ContainerCheckDTO struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
}

// ContainerExistingDTO describes an instance the remote directory already
// holds, so the user can take it over instead of installing again.
type ContainerExistingDTO struct {
	OwnerUserIDs   []int64   `json:"ownerUserIds"`
	ButlerModel    *ModelDTO `json:"butlerModel"`
	TaskModel      *ModelDTO `json:"taskModel"`
	ActiveChannel  string    `json:"activeChannel,omitempty"`
	ReleaseVersion string    `json:"releaseVersion,omitempty"`
}

// ContainerPreflightDTO is the preflight result. Existing is set only when the
// remote directory already holds this project's container.
type ContainerPreflightDTO struct {
	Checks   []ContainerCheckDTO   `json:"checks"`
	Passed   bool                  `json:"passed"`
	Existing *ContainerExistingDTO `json:"existing,omitempty"`
}

// ContainerInstallInputDTO is a from-scratch container install request. Secrets
// are write-only.
type ContainerInstallInputDTO struct {
	TelegramUserIDs []int64         `json:"telegramUserIds"`
	ButlerModel     ModelDTO        `json:"butlerModel"`
	TaskModel       ModelDTO        `json:"taskModel"`
	ActiveChannel   string          `json:"activeChannel"`
	Secrets         []SecretEditDTO `json:"secrets"`
}

// ContainerStatusDTO is the server page's runtime view.
type ContainerStatusDTO struct {
	Address    string `json:"address"`
	User       string `json:"user"`
	Dir        string `json:"dir"`
	Reachable  bool   `json:"reachable"`
	Running    bool   `json:"running"`
	Health     string `json:"health"`
	Image      string `json:"image"`
	StartedAt  string `json:"startedAt"`
	CanRestore bool   `json:"canRestore"`
}

// ProbeSSHHost reports the host key without connecting as a user. Nothing is
// stored.
func (s *Service) ProbeSSHHost(input SSHHostInputDTO) (SSHProbeDTO, error) {
	host, err := sshHostRef(input)
	if err != nil {
		return SSHProbeDTO{}, safeAppError(err)
	}
	if s.ssh == nil {
		return SSHProbeDTO{}, s.serviceUnavailable()
	}
	fingerprint, known, err := s.ssh.Probe(context.Background(), host)
	if err != nil {
		return SSHProbeDTO{}, safeAppError(err)
	}
	return SSHProbeDTO{Fingerprint: fingerprint, Known: known}, nil
}

// ConnectSSHHost pins a first-seen host key, stores the password or passphrase
// and runs the preflight, which authenticates for real. A failed
// authentication forgets the credential and trust it just wrote.
func (s *Service) ConnectSSHHost(input SSHHostInputDTO, fingerprint string) (ContainerPreflightDTO, error) {
	ctx := context.Background()
	host, err := sshHostRef(input)
	if err != nil {
		return ContainerPreflightDTO{}, safeAppError(err)
	}
	if s.ssh == nil || s.container == nil {
		return ContainerPreflightDTO{}, s.serviceUnavailable()
	}
	probed, known, err := s.ssh.Probe(ctx, host)
	if err != nil {
		return ContainerPreflightDTO{}, safeAppError(err)
	}
	if !known {
		if strings.TrimSpace(fingerprint) != probed {
			return ContainerPreflightDTO{}, domain.Error{
				Code:    domain.SSH_HOST_KEY_CHANGED,
				Message: "the SSH host key changed since it was shown",
			}
		}
		if err := s.ssh.Trust(ctx, host, fingerprint); err != nil {
			return ContainerPreflightDTO{}, safeAppError(err)
		}
	}
	if input.Secret != "" {
		if err := s.ssh.StoreSecret(ctx, host, input.Secret); err != nil {
			return ContainerPreflightDTO{}, safeAppError(err)
		}
	}
	report, err := s.preflightContainerHost(ctx, host, true)
	if err != nil {
		var domainErr domain.Error
		if errors.As(err, &domainErr) && domainErr.Code == domain.SSH_AUTH_FAILED {
			_ = s.ssh.Forget(ctx, host)
		}
		return ContainerPreflightDTO{}, safeAppError(err)
	}
	s.setPendingHost(host)
	return report, nil
}

// ContainerPreflight re-runs the preflight for the host being set up.
func (s *Service) ContainerPreflight() (ContainerPreflightDTO, error) {
	host, err := s.pendingHostRef()
	if err != nil {
		return ContainerPreflightDTO{}, err
	}
	if s.container == nil {
		return ContainerPreflightDTO{}, s.serviceUnavailable()
	}
	return s.preflightContainerHost(context.Background(), host, true)
}

// InstallContainer writes the compose file and .env, starts the container and
// waits until it is healthy. The target is saved only after the install
// succeeds.
func (s *Service) InstallContainer(input ContainerInstallInputDTO) (ResultDTO, error) {
	ctx := context.Background()
	host, err := s.pendingHostRef()
	if err != nil {
		return ResultDTO{}, err
	}
	if s.container == nil || s.store == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	channel := normalizeChannel(input.ActiveChannel)
	if channel == "" {
		return ResultDTO{}, domain.Error{Code: CodeInvalidEntryChannel, Message: s.t("app.activeChannelInvalid")}
	}
	target := domain.Target{Kind: domain.TargetContainer, Host: host}
	configJSON, err := s.containerInstallConfig(target, input)
	if err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	secrets := make([]domain.SecretEdit, 0, len(input.Secrets))
	for _, secret := range input.Secrets {
		secrets = append(secrets, domain.NewSecretEdit(secret.Name, domain.SecretReplace, secret.Value))
	}
	result, err := s.container.Install(ctx, target, container.InstallRequest{
		ConfigJSON:    configJSON,
		ActiveChannel: channel,
		Secrets:       secrets,
	}, func(step domain.Step) {
		s.emitContainer(StepDTO{ID: step.ID, State: step.State, Message: step.Message, Evidence: step.Evidence})
	})
	failure := safeAppError(err, secretInputValues(input.Secrets)...)
	summary := s.summaryFromResult(result, target.DisplayName())
	if failure != nil {
		return summary, failure
	}
	if err := s.store.Save(target); err != nil {
		return summary, safeAppError(err)
	}
	s.clearPendingHost()
	s.clearSnapshotCache()
	return summary, nil
}

// AdoptContainer takes over an existing instance without writing anything
// remote.
func (s *Service) AdoptContainer() (ResultDTO, error) {
	ctx := context.Background()
	host, err := s.pendingHostRef()
	if err != nil {
		return ResultDTO{}, err
	}
	if s.container == nil || s.store == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	target := domain.Target{Kind: domain.TargetContainer, Host: host}
	report, err := s.container.Preflight(ctx, target)
	if err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	if !report.Existing {
		return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.containerNotExisting")}
	}
	snapshot, err := s.container.ReadSnapshot(ctx, target)
	if err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	if err := s.store.Save(target); err != nil {
		return ResultDTO{}, safeAppError(err)
	}
	s.clearPendingHost()
	s.clearSnapshotCache()
	return ResultDTO{
		State:          deployment.StatePublished,
		WorkerName:     target.DisplayName(),
		ReleaseVersion: snapshot.ReleaseVersion,
	}, nil
}

// ContainerStatus reports the host and container state for the server page.
func (s *Service) ContainerStatus() (ContainerStatusDTO, error) {
	target, err := s.containerTarget()
	if err != nil {
		return ContainerStatusDTO{}, err
	}
	if s.container == nil {
		return ContainerStatusDTO{}, s.serviceUnavailable()
	}
	status, err := s.container.Status(context.Background(), target)
	dto := ContainerStatusDTO{
		Address:    target.Host.Address,
		User:       target.Host.User,
		Dir:        target.Host.Dir,
		Reachable:  status.Reachable,
		Running:    status.Running,
		Health:     status.Health,
		Image:      status.Image,
		StartedAt:  status.StartedAt,
		CanRestore: status.CanRestore,
	}
	return dto, safeAppError(err)
}

// RestoreContainerConfig puts the previous .env back and restarts the
// container.
func (s *Service) RestoreContainerConfig() (ResultDTO, error) {
	target, err := s.containerTarget()
	if err != nil {
		return ResultDTO{}, err
	}
	if s.container == nil {
		return ResultDTO{}, s.serviceUnavailable()
	}
	result, err := s.container.RestorePrevious(context.Background(), target)
	return s.summaryFromResult(result, target.DisplayName()), safeAppError(err)
}

// DisconnectContainer forgets the host credential and the pinned key and
// clears the local target. It runs no remote command.
func (s *Service) DisconnectContainer() error {
	ctx := context.Background()
	if s.store != nil {
		target, ok, err := s.store.Load()
		if err != nil {
			return safeAppError(err)
		}
		if ok && target.IsContainer() && s.ssh != nil {
			if err := s.ssh.Forget(ctx, target.Host); err != nil {
				return safeAppError(err)
			}
		}
		if err := s.store.Clear(); err != nil {
			return safeAppError(err)
		}
	}
	s.clearPendingHost()
	s.clearSnapshotCache()
	return nil
}

func sshHostRef(input SSHHostInputDTO) (domain.HostRef, error) {
	port := input.Port
	if port == 0 {
		port = domain.DefaultSSHPort
	}
	dir := input.Dir
	if dir == "" {
		dir = domain.DefaultRemoteDir
	}
	host := domain.HostRef{
		Address: input.Address,
		Port:    port,
		User:    input.User,
		Auth:    input.Auth,
		KeyPath: input.KeyPath,
		Dir:     dir,
	}
	if err := host.Validate(); err != nil {
		return domain.HostRef{}, err
	}
	return host, nil
}

func (s *Service) preflightContainerHost(ctx context.Context, host domain.HostRef, withExisting bool) (ContainerPreflightDTO, error) {
	target := domain.Target{Kind: domain.TargetContainer, Host: host}
	report, err := s.container.Preflight(ctx, target)
	if err != nil {
		return ContainerPreflightDTO{}, safeAppError(err)
	}
	dto := ContainerPreflightDTO{Passed: report.Passed(), Checks: make([]ContainerCheckDTO, 0, len(report.Checks))}
	for _, check := range report.Checks {
		dto.Checks = append(dto.Checks, ContainerCheckDTO{ID: check.ID, OK: check.OK, Detail: check.Detail, Fix: check.Fix})
	}
	if withExisting && report.Existing {
		snapshot, err := s.container.ReadSnapshot(ctx, target)
		if err != nil {
			return ContainerPreflightDTO{}, safeAppError(err)
		}
		dto.Existing = existingContainerDTO(snapshot)
	}
	return dto, nil
}

func existingContainerDTO(snapshot domain.Snapshot) *ContainerExistingDTO {
	dto := &ContainerExistingDTO{
		OwnerUserIDs:   []int64{},
		ActiveChannel:  ReadPlainVar(snapshot.SettingsJSON, "ACTIVE_CHANNEL"),
		ReleaseVersion: snapshot.ReleaseVersion,
	}
	if len(snapshot.ConfigJSON) == 0 {
		return dto
	}
	var document struct {
		Owner struct {
			TelegramUserIDs []int64 `json:"telegramUserIds"`
		} `json:"owner"`
		Models struct {
			Butler *ModelDTO `json:"butler"`
			Task   *ModelDTO `json:"task"`
		} `json:"models"`
	}
	if err := json.Unmarshal(snapshot.ConfigJSON, &document); err != nil {
		return dto
	}
	if document.Owner.TelegramUserIDs != nil {
		dto.OwnerUserIDs = document.Owner.TelegramUserIDs
	}
	dto.ButlerModel = summarizeModel(document.Models.Butler)
	dto.TaskModel = summarizeModel(document.Models.Task)
	return dto
}

func (s *Service) containerInstallConfig(target domain.Target, input ContainerInstallInputDTO) ([]byte, error) {
	butler, err := modelInput(ModelRefInput{Provider: input.ButlerModel.Provider, ID: input.ButlerModel.ID})
	if err != nil {
		return nil, err
	}
	task, err := modelInput(ModelRefInput{Provider: input.TaskModel.Provider, ID: input.TaskModel.ID})
	if err != nil {
		return nil, err
	}
	ids := append([]int64(nil), input.TelegramUserIDs...)
	patch := domain.EditablePatch{TelegramUserIDs: &ids, ButlerModel: &butler, TaskModel: &task}
	if locale := s.locale.Current(); locale != "" {
		patch.Locale = &locale
	}
	plan, err := config.Merge(domain.Snapshot{
		Target:      target,
		Fingerprint: "install",
		VersionID:   "install",
	}, domain.Change{BaseFingerprint: "install", Patch: patch})
	if err != nil {
		return nil, err
	}
	return plan.ConfigJSON, nil
}

func (s *Service) pendingHostRef() (domain.HostRef, error) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if s.pendingHost == nil {
		return domain.HostRef{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t("app.containerHostPending")}
	}
	return *s.pendingHost, nil
}

func (s *Service) setPendingHost(host domain.HostRef) {
	s.pendingMu.Lock()
	s.pendingHost = &host
	s.pendingMu.Unlock()
}

func (s *Service) clearPendingHost() {
	s.pendingMu.Lock()
	s.pendingHost = nil
	s.pendingMu.Unlock()
}

func (s *Service) containerTarget() (domain.Target, error) {
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
	if !target.IsContainer() {
		return domain.Target{}, s.targetUnsupported()
	}
	return target, nil
}

func (s *Service) clearSnapshotCache() {
	if s.cache == nil {
		return
	}
	if err := s.cache.Clear(); err != nil {
		slog.Error("app: clear snapshot cache", "error", err)
	}
}
