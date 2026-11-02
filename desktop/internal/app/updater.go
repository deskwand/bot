package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// ClientUpdateKeyID is the key id used only for desktop client updates. It is
// deliberately separate from the Worker release key (deskwand-release-1): a
// client update can never be signed by the Worker release key, and a Worker
// release can never be installed as a desktop update.
const ClientUpdateKeyID = "deskwand-client-1"

// ClientUpdateFeedURL is the build-time desktop client update feed. It is
// empty by default, which disables the updater and makes the UI show
// "未配置更新源". Maintainers set it together with mygo.json's updates.url and
// updates.publicKey when they publish a client release.
//
// It is a variable rather than a constant so a packaged build can replace it
// with -ldflags -X without editing the source. Production builds must leave it
// empty unless the feed and public key are present.
var ClientUpdateFeedURL = ""

// Stable client-update error codes. They are shown as fixed Chinese messages
// and never include key material, download URLs or provider error bodies.
const (
	CodeClientUpdateNotConfigured  = "CLIENT_UPDATE_NOT_CONFIGURED"
	CodeClientUpdateSignatureError = "CLIENT_UPDATE_SIGNATURE_INVALID"
	CodeClientUpdateDowngrade      = "CLIENT_UPDATE_DOWNGRADE_REJECTED"
	CodeClientUpdateNotChecked     = "CLIENT_UPDATE_NOT_CHECKED"
	CodeClientUpdateFailed         = "CLIENT_UPDATE_FAILED"
)

var (
	ErrClientUpdateNotConfigured = errors.New("app: client update feed is not configured")
	ErrClientUpdateSignature     = errors.New("app: client update signature is invalid")
	ErrClientUpdateDowngrade     = errors.New("app: client update would downgrade the client")
	ErrClientUpdateFailed        = errors.New("app: client update failed")
)

// ClientUpdateInfo is a provider-neutral update description. token is opaque
// to the service and only the provider that produced it can install it, which
// keeps MyGo's *Update (with its signed manifest) out of DTOs.
type ClientUpdateInfo struct {
	Version string
	Notes   string
	Date    string
	token   any
}

// ClientUpdateProvider isolates the MyGo updater for tests. Production uses
// MyGoClientUpdateProvider; tests inject a fake that can reject a signature or
// return an older version.
type ClientUpdateProvider interface {
	Configured() bool
	CurrentVersion() string
	Check(ctx context.Context) (ClientUpdateInfo, error)
	Install(ctx context.Context, update ClientUpdateInfo) error
}

// MyGoClientUpdateProvider wraps the updater API of the pinned MyGo v0.7.4
// module. It never enables background checks or automatic installation.
type MyGoClientUpdateProvider struct {
	// Feed is the configured update feed. An empty feed disables the updater
	// even in a build that happens to embed MyGo update configuration.
	Feed string
}

// NewMyGoClientUpdateProvider returns the production client-update provider.
func NewMyGoClientUpdateProvider(feed string) *MyGoClientUpdateProvider {
	return &MyGoClientUpdateProvider{Feed: strings.TrimSpace(feed)}
}

// Configured reports whether this build may check for client updates.
func (p *MyGoClientUpdateProvider) Configured() bool {
	return p != nil && p.Feed != "" && mygo.Updater.Enabled()
}

// CurrentVersion reports the version MyGo linked into this build.
func (p *MyGoClientUpdateProvider) CurrentVersion() string {
	return mygo.App.Version()
}

// Check asks the pinned MyGo updater for a newer client version. MyGo reads
// the signed update manifest for this platform and returns nil when the app is
// up to date; archive signatures are verified by Install.
func (p *MyGoClientUpdateProvider) Check(ctx context.Context) (ClientUpdateInfo, error) {
	if !p.Configured() {
		return ClientUpdateInfo{}, ErrClientUpdateNotConfigured
	}
	update, err := mygo.Updater.Check(ctx)
	if err != nil {
		if errors.Is(err, mygo.ErrUpdatesDisabled) {
			return ClientUpdateInfo{}, ErrClientUpdateNotConfigured
		}
		return ClientUpdateInfo{}, classifyMyGoUpdateError(err)
	}
	current := p.CurrentVersion()
	if update == nil {
		return ClientUpdateInfo{Version: current}, nil
	}
	date := ""
	if !update.Date.IsZero() {
		date = update.Date.UTC().Format(time.RFC3339)
	}
	return ClientUpdateInfo{
		Version: update.Version,
		Notes:   update.Notes,
		Date:    date,
		token:   update,
	}, nil
}

// Install downloads and stages the update returned by Check. MyGo verifies
// the archive signature with the public key embedded at build time and
// replaces the app at the next launch; this method never relaunches the app
// and never touches the cloud deployment.
func (p *MyGoClientUpdateProvider) Install(ctx context.Context, update ClientUpdateInfo) error {
	mygoUpdate, ok := update.token.(*mygo.Update)
	if !ok || mygoUpdate == nil {
		return ErrClientUpdateFailed
	}
	if err := mygoUpdate.Install(ctx, nil); err != nil {
		return classifyMyGoUpdateError(err)
	}
	return nil
}

func classifyMyGoUpdateError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "not signed with the app's key"),
		strings.Contains(message, "signature"):
		return fmt.Errorf("%w: %v", ErrClientUpdateSignature, err)
	default:
		return fmt.Errorf("%w: %v", ErrClientUpdateFailed, err)
	}
}

// CheckClientUpdate performs a user-triggered check. A configured feed that is
// up to date returns state "up_to_date"; a newer client returns "available".
// Unconfigured builds return "not_configured" without attempting a network
// request. Signature and downgrade failures use fixed error codes.
func (s *Service) CheckClientUpdate() (ClientUpdateDTO, error) {
	current := s.clientVersion()
	if s.clientUpdates == nil || !s.clientUpdates.Configured() {
		return ClientUpdateDTO{
			State:          "not_configured",
			CurrentVersion: current,
			Reason:         CodeClientUpdateNotConfigured,
			Message:        "未配置更新源",
		}, nil
	}
	info, err := s.clientUpdates.Check(context.Background())
	if err != nil {
		return ClientUpdateDTO{}, clientUpdateError(err)
	}
	current = s.clientUpdates.CurrentVersion()
	if current == "" {
		current = s.clientVersion()
	}
	dto := ClientUpdateDTO{State: "up_to_date", CurrentVersion: current}
	if info.Version == "" {
		s.clearCheckedClientUpdate()
		return dto, nil
	}
	comparison, comparable := deployment.CompareVersions(info.Version, current)
	if !comparable {
		s.clearCheckedClientUpdate()
		return ClientUpdateDTO{}, domain.Error{
			Code:    CodeClientUpdateFailed,
			Message: "无法比较客户端版本，未执行更新",
		}
	}
	switch {
	case comparison > 0:
		dto.State = "available"
		dto.AvailableVersion = info.Version
		dto.Notes = info.Notes
		dto.Date = info.Date
		s.setCheckedClientUpdate(&info)
	case comparison < 0:
		s.clearCheckedClientUpdate()
		return ClientUpdateDTO{}, domain.Error{
			Code:    CodeClientUpdateDowngrade,
			Message: "更新源版本低于当前客户端，已拒绝降级",
		}
	default:
		s.clearCheckedClientUpdate()
	}
	return dto, nil
}

// InstallClientUpdate installs the update found by the most recent
// CheckClientUpdate call. It is never automatic and never modifies the cloud
// deployment. MyGo stages the update; the new version runs at the next launch.
func (s *Service) InstallClientUpdate() (ClientUpdateResultDTO, error) {
	info, ok := s.takeCheckedClientUpdate()
	if !ok {
		return ClientUpdateResultDTO{
			State:          "not_checked",
			CurrentVersion: s.clientVersion(),
		}, domain.Error{Code: CodeClientUpdateNotChecked, Message: "请先检查客户端更新，再执行安装"}
	}
	if s.clientUpdates == nil {
		return ClientUpdateResultDTO{State: "failed", CurrentVersion: s.clientVersion()},
			domain.Error{Code: CodeClientUpdateFailed, Message: "客户端更新服务不可用"}
	}
	if err := s.clientUpdates.Install(context.Background(), info); err != nil {
		return ClientUpdateResultDTO{
			State:          "failed",
			CurrentVersion: s.clientUpdates.CurrentVersion(),
			Version:        info.Version,
		}, clientUpdateError(err)
	}
	return ClientUpdateResultDTO{
		State:          "installed",
		CurrentVersion: s.clientUpdates.CurrentVersion(),
		Version:        info.Version,
		Message:        "客户端更新已安装，重启客户端后生效",
	}, nil
}

func (s *Service) clientVersion() string {
	if s.clientUpdates != nil {
		if version := s.clientUpdates.CurrentVersion(); version != "" {
			return version
		}
	}
	return ""
}

func (s *Service) setCheckedClientUpdate(info *ClientUpdateInfo) {
	s.clientUpdateMu.Lock()
	defer s.clientUpdateMu.Unlock()
	copied := *info
	s.checkedClientUpdate = &copied
}

func (s *Service) takeCheckedClientUpdate() (ClientUpdateInfo, bool) {
	s.clientUpdateMu.Lock()
	defer s.clientUpdateMu.Unlock()
	if s.checkedClientUpdate == nil {
		return ClientUpdateInfo{}, false
	}
	info := *s.checkedClientUpdate
	s.checkedClientUpdate = nil
	return info, true
}

func (s *Service) clearCheckedClientUpdate() {
	s.clientUpdateMu.Lock()
	defer s.clientUpdateMu.Unlock()
	s.checkedClientUpdate = nil
}

func clientUpdateError(err error) error {
	switch {
	case errors.Is(err, ErrClientUpdateNotConfigured):
		return domain.Error{Code: CodeClientUpdateNotConfigured, Message: "未配置更新源"}
	case errors.Is(err, ErrClientUpdateSignature):
		return domain.Error{Code: CodeClientUpdateSignatureError, Message: "客户端更新签名无效，已拒绝安装"}
	case errors.Is(err, ErrClientUpdateDowngrade):
		return domain.Error{Code: CodeClientUpdateDowngrade, Message: "更新源版本低于当前客户端，已拒绝降级"}
	default:
		return domain.Error{Code: CodeClientUpdateFailed, Message: "客户端更新失败，请稍后重试"}
	}
}
