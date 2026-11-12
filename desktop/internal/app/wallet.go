package app

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/walletadmin"
)

var (
	walletPrivateKeyPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
	walletAddressPattern    = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
)

// walletProblem carries the i18n key: the caller turns it into a domain
// error in the owner's language.
type walletProblem struct {
	Key string
}

// validateWalletEdit checks only the formats a local save can check cheaply.
// The checksum is left to the Worker's walletConfig, which treats a bad
// owner address as an unconfigured wallet.
func validateWalletEdit(input WalletEditDTO) *walletProblem {
	privateKey := strings.TrimSpace(input.PrivateKey)
	if privateKey != "" && !walletPrivateKeyPattern.MatchString(privateKey) {
		return &walletProblem{Key: "app.walletPrivateKeyInvalid"}
	}
	ownerAddress := strings.TrimSpace(input.OwnerAddress)
	if ownerAddress != "" && !walletAddressPattern.MatchString(ownerAddress) {
		return &walletProblem{Key: "app.walletOwnerAddressInvalid"}
	}
	return nil
}

// walletConfigEdit turns the write-only inputs into secret edits plus the
// public wallet section patch. Empty fields mean unchanged.
func walletConfigEdit(input WalletEditDTO) (ConfigEditDTO, error) {
	edit := ConfigEditDTO{}
	if privateKey := strings.TrimSpace(input.PrivateKey); privateKey != "" {
		edit.Secrets = append(edit.Secrets, SecretEditDTO{
			Name:      "WALLET_PRIVATE_KEY",
			Operation: domain.SecretReplace,
			Value:     privateKey,
		})
	}
	if ownerAddress := strings.TrimSpace(input.OwnerAddress); ownerAddress != "" {
		edit.Secrets = append(edit.Secrets, SecretEditDTO{
			Name:      "WALLET_OWNER_ADDRESS",
			Operation: domain.SecretReplace,
			Value:     ownerAddress,
		})
	}
	if rpcURL := strings.TrimSpace(input.RPCURL); rpcURL != "" {
		edit.Wallet = &WalletSectionDTO{RPCURL: rpcURL}
	}
	return edit, nil
}

func walletSectionPatch(input WalletSectionDTO) ([]byte, error) {
	section := struct {
		RPCURL string `json:"rpcUrl"`
	}{RPCURL: strings.TrimSpace(input.RPCURL)}
	encoded, err := json.Marshal(section)
	if err != nil {
		return nil, fmt.Errorf("app: encode wallet section: %w", err)
	}
	return encoded, nil
}

// walletClient mirrors exchangeClient: the ADMIN_TOKEN flow is shared with
// backups, so the page works before the user ever opens the backup page.
func (s *Service) walletClient(ctx context.Context, target domain.Target) (*walletadmin.Client, error) {
	if s.snapshots == nil || s.publish == nil || s.credentials == nil {
		return nil, s.serviceUnavailable()
	}
	// A Connect may publish a Worker version; see adminConnectMu.
	s.adminConnectMu.Lock()
	client, err := walletadmin.Connect(ctx, walletadmin.Deps{
		Token: backup.TokenDeps{
			Snapshots:   s.snapshots,
			Publisher:   s.publish,
			Credentials: s.credentials,
		},
		Locale: s.locale.Current,
	}, target)
	s.adminConnectMu.Unlock()
	if err != nil {
		return nil, err
	}
	client.Locale = s.locale.Current
	return client, nil
}

// WalletStatus reads the deployed wallet's public state.
func (s *Service) WalletStatus() (WalletStatusDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return WalletStatusDTO{}, err
	}
	client, err := s.walletClient(ctx, target)
	if err != nil {
		return WalletStatusDTO{}, safeAppError(err)
	}
	status, err := client.Status(ctx)
	if err != nil {
		return WalletStatusDTO{}, safeAppError(err)
	}
	return WalletStatusDTO{
		Configured: status.Configured,
		Address:    status.Address,
		ValueUSD:   status.ValueUSD,
	}, nil
}

// SaveWallet writes the wallet secrets and the optional RPC URL, then
// publishes. An empty field leaves that value untouched.
func (s *Service) SaveWallet(input WalletEditDTO) (ResultDTO, error) {
	if problem := validateWalletEdit(input); problem != nil {
		return ResultDTO{}, domain.Error{Code: deployment.CodeInvalidRequest, Message: s.t(problem.Key)}
	}
	edit, err := walletConfigEdit(input)
	if err != nil {
		return ResultDTO{}, err
	}
	return s.PublishConfig(edit)
}
