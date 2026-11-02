package backup

import (
	"context"
	"crypto/rand"
	"errors"
	"regexp"
	"testing"

	"github.com/deskwand/bot/desktop/internal/deployment"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
)

const adminTokenPattern = `^[0-9a-f]{64}$`

type fakeSnapshots struct {
	queue []domain.Snapshot
	index int
	err   error
}

func (f *fakeSnapshots) ReadSnapshot(context.Context, domain.Target) (domain.Snapshot, error) {
	if f.err != nil {
		return domain.Snapshot{}, f.err
	}
	if len(f.queue) == 0 {
		return domain.Snapshot{}, nil
	}
	index := f.index
	if index >= len(f.queue) {
		index = len(f.queue) - 1
	}
	f.index++
	return f.queue[index], nil
}

type fakePublisher struct {
	changes []domain.Change
	result  domain.Result
	err     error
}

func (f *fakePublisher) Apply(_ context.Context, _ domain.Target, change domain.Change) (domain.Result, error) {
	f.changes = append(f.changes, change)
	if f.err != nil {
		return domain.Result{}, f.err
	}
	return f.result, nil
}

func newTokenDeps(snapshots *fakeSnapshots, publisher *fakePublisher) (TokenDeps, *platform.MemoryCredentialStore) {
	credentials := platform.NewMemoryCredentialStore()
	return TokenDeps{
		Snapshots:   snapshots,
		Publisher:   publisher,
		Credentials: credentials,
		Random:      rand.Reader,
	}, credentials
}

func TestEnsureAdminTokenGeneratesOnce(t *testing.T) {
	target := domain.Target{AccountID: "acc", ScriptName: "deskwand-bot"}
	snapshots := &fakeSnapshots{queue: []domain.Snapshot{
		{Fingerprint: "fp-1"},
		{Fingerprint: "fp-2", SecretNames: []string{AdminTokenSecret}},
	}}
	publisher := &fakePublisher{result: domain.Result{State: deployment.StatePublished}}
	deps, credentials := newTokenDeps(snapshots, publisher)
	ctx := context.Background()

	token, published, err := EnsureAdminToken(ctx, deps, target)
	if err != nil {
		t.Fatal(err)
	}
	if !published {
		t.Fatal("first call did not publish the token")
	}
	if !regexp.MustCompile(adminTokenPattern).MatchString(token) {
		t.Fatalf("token = %q", token)
	}
	if len(publisher.changes) != 1 {
		t.Fatalf("apply calls = %d", len(publisher.changes))
	}
	change := publisher.changes[0]
	if change.BaseFingerprint != "fp-1" || len(change.Secrets) != 1 {
		t.Fatalf("change = %+v", change)
	}
	if change.Secrets[0].Name != AdminTokenSecret || change.Secrets[0].Operation != domain.SecretReplace {
		t.Fatalf("secret edit = %+v", change.Secrets[0])
	}
	if change.Secrets[0].Value() != token {
		t.Fatal("published value differs from the returned token")
	}

	key := AdminTokenKey(target)
	if key != "admin-token/acc/deskwand-bot" {
		t.Fatalf("key = %q", key)
	}
	stored, err := credentials.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if stored != token {
		t.Fatal("vault value differs from the returned token")
	}

	second, republished, err := EnsureAdminToken(ctx, deps, target)
	if err != nil {
		t.Fatal(err)
	}
	if republished {
		t.Fatal("second call published a token that was already deployed")
	}
	if second != token {
		t.Fatal("second call generated a new token")
	}
	if len(publisher.changes) != 1 {
		t.Fatalf("apply calls after second run = %d", len(publisher.changes))
	}
}

func TestEnsureAdminTokenRepublishesWhenSecretMissing(t *testing.T) {
	target := domain.Target{AccountID: "acc", ScriptName: "deskwand-bot"}
	snapshots := &fakeSnapshots{queue: []domain.Snapshot{{Fingerprint: "fp-1"}}}
	publisher := &fakePublisher{result: domain.Result{State: deployment.StatePublished}}
	deps, credentials := newTokenDeps(snapshots, publisher)
	ctx := context.Background()

	stored := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := credentials.Set(ctx, AdminTokenKey(target), stored); err != nil {
		t.Fatal(err)
	}

	token, published, err := EnsureAdminToken(ctx, deps, target)
	if err != nil {
		t.Fatal(err)
	}
	if !published {
		t.Fatal("missing secret name was not published")
	}
	if token != stored {
		t.Fatal("a stored token was replaced")
	}
	if len(publisher.changes) != 1 || publisher.changes[0].Secrets[0].Value() != stored {
		t.Fatal("the stored token was not the one published")
	}
}

func TestEnsureAdminTokenRequiresPublishedState(t *testing.T) {
	target := domain.Target{AccountID: "acc", ScriptName: "deskwand-bot"}
	snapshots := &fakeSnapshots{queue: []domain.Snapshot{{Fingerprint: "fp-1"}}}
	publisher := &fakePublisher{result: domain.Result{State: deployment.StateFailed}}
	deps, credentials := newTokenDeps(snapshots, publisher)
	ctx := context.Background()

	_, published, err := EnsureAdminToken(ctx, deps, target)
	if published {
		t.Fatal("a failed publish reported success")
	}
	if code := adminErrorCode(t, err); code != CodeAdminUnavailable {
		t.Fatalf("code = %q", code)
	}
	stored, err := credentials.Get(ctx, AdminTokenKey(target))
	if err != nil {
		t.Fatal(err)
	}
	if stored == "" {
		t.Fatal("the generated token was not kept in the vault")
	}
}

func TestEnsureAdminTokenPassesPublishErrors(t *testing.T) {
	target := domain.Target{AccountID: "acc", ScriptName: "deskwand-bot"}
	snapshots := &fakeSnapshots{queue: []domain.Snapshot{{Fingerprint: "fp-1"}}}
	publishErr := domain.Error{Code: "VERSION_UNKNOWN_REIMPORT", Message: "import the deployment first"}
	publisher := &fakePublisher{err: publishErr}
	deps, _ := newTokenDeps(snapshots, publisher)

	_, _, err := EnsureAdminToken(context.Background(), deps, target)
	if code := adminErrorCode(t, err); code != publishErr.Code {
		t.Fatalf("code = %q", code)
	}
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Message != publishErr.Message {
		t.Fatalf("error = %v", err)
	}
}
