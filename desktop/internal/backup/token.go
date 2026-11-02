package backup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
)

// AdminTokenSecret is the Worker secret that authenticates /admin/* requests.
const AdminTokenSecret = "ADMIN_TOKEN"

const adminTokenBytes = 32

// AdminTokenKey returns the credential-store key holding one deployment's
// admin token.
func AdminTokenKey(target domain.Target) string {
	return "admin-token/" + target.AccountID + "/" + target.ScriptName
}

// SnapshotReader reads the target deployment's current state.
type SnapshotReader interface {
	ReadSnapshot(ctx context.Context, target domain.Target) (domain.Snapshot, error)
}

// Publisher applies a secret-only change through the normal publish flow.
type Publisher interface {
	Apply(ctx context.Context, target domain.Target, change domain.Change) (domain.Result, error)
}

// TokenDeps are the services EnsureAdminToken needs.
type TokenDeps struct {
	Snapshots   SnapshotReader
	Publisher   Publisher
	Credentials platform.CredentialStore
	Random      io.Reader
}

// EnsureAdminToken returns the deployment's admin token, generating and
// storing one when the vault has none, and publishing it when the deployment's
// secret list does not name ADMIN_TOKEN yet. published reports whether this
// call published a new secret version.
func EnsureAdminToken(ctx context.Context, deps TokenDeps, target domain.Target) (token string, published bool, err error) {
	snapshot, err := deps.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return "", false, err
	}
	token, err = storedAdminToken(ctx, deps, target)
	if err != nil {
		return "", false, err
	}
	if hasSecret(snapshot.SecretNames, AdminTokenSecret) {
		return token, false, nil
	}
	if err := publishAdminToken(ctx, deps, target, snapshot, token); err != nil {
		return "", false, err
	}
	return token, true, nil
}

// RepublishAdminToken pushes the vault's token through the publish flow again.
// It is the recovery path after the Worker answered 401: the deployment may
// have been replaced by a version that lost the ADMIN_TOKEN binding.
func RepublishAdminToken(ctx context.Context, deps TokenDeps, target domain.Target) (string, error) {
	snapshot, err := deps.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return "", err
	}
	token, err := storedAdminToken(ctx, deps, target)
	if err != nil {
		return "", err
	}
	if err := publishAdminToken(ctx, deps, target, snapshot, token); err != nil {
		return "", err
	}
	return token, nil
}

// storedAdminToken reads the vault, generating and storing a token first when
// none exists. A generated token is stored before the publish attempt so a
// failed publish can be retried with the same value.
func storedAdminToken(ctx context.Context, deps TokenDeps, target domain.Target) (string, error) {
	key := AdminTokenKey(target)
	token, err := deps.Credentials.Get(ctx, key)
	if err == nil {
		return token, nil
	}
	if !errors.Is(err, platform.ErrCredentialNotFound) {
		return "", err
	}
	token, err = newAdminToken(deps.Random)
	if err != nil {
		return "", err
	}
	if err := deps.Credentials.Set(ctx, key, token); err != nil {
		return "", err
	}
	return token, nil
}

func newAdminToken(random io.Reader) (string, error) {
	if random == nil {
		random = rand.Reader
	}
	buffer := make([]byte, adminTokenBytes)
	if _, err := io.ReadFull(random, buffer); err != nil {
		return "", fmt.Errorf("backup: generate admin token: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

func publishAdminToken(ctx context.Context, deps TokenDeps, target domain.Target, snapshot domain.Snapshot, token string) error {
	result, err := deps.Publisher.Apply(ctx, target, domain.Change{
		BaseFingerprint: snapshot.Fingerprint,
		Secrets: []domain.SecretEdit{
			domain.NewSecretEdit(AdminTokenSecret, domain.SecretReplace, token),
		},
	})
	if err != nil {
		return err
	}
	if result.State != deployment.StatePublished {
		return domain.Error{
			Code:    CodeAdminUnavailable,
			Message: fmt.Sprintf("ADMIN_TOKEN publish finished in state %q", result.State),
		}
	}
	return nil
}

func hasSecret(names []string, want string) bool {
	for _, name := range names {
		if name == want {
			return true
		}
	}
	return false
}
