package container

import (
	"context"
	"errors"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestAdminAccessReadsTheToken(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		envPath("~/deskwand"): []byte("ADMIN_TOKEN=abc123\nACTIVE_CHANNEL=telegram\n"),
	}}
	token, err := newService(host).AdminAccess(context.Background(), containerTarget())
	if err != nil {
		t.Fatalf("AdminAccess: %v", err)
	}
	if token != "abc123" {
		t.Fatalf("token = %q, want abc123", token)
	}
	if len(host.commands) != 0 {
		t.Fatalf("AdminAccess ran commands: %v", host.commands)
	}
}

func TestAdminAccessRejectsAMissingToken(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		envPath("~/deskwand"): []byte("ACTIVE_CHANNEL=telegram\n"),
	}}
	_, err := newService(host).AdminAccess(context.Background(), containerTarget())
	if !hasContainerCode(err, domain.ENV_FILE_INVALID) {
		t.Fatalf("error = %v, want %s", err, domain.ENV_FILE_INVALID)
	}
}

func TestAdminAccessRejectsAnEmptyToken(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		envPath("~/deskwand"): []byte("ADMIN_TOKEN=\n"),
	}}
	_, err := newService(host).AdminAccess(context.Background(), containerTarget())
	if !hasContainerCode(err, domain.ENV_FILE_INVALID) {
		t.Fatalf("error = %v, want %s", err, domain.ENV_FILE_INVALID)
	}
}

func TestAdminAccessRejectsAMissingEnvFile(t *testing.T) {
	host := &fakeHost{}
	_, err := newService(host).AdminAccess(context.Background(), containerTarget())
	if !hasContainerCode(err, domain.ENV_FILE_INVALID) {
		t.Fatalf("error = %v, want %s", err, domain.ENV_FILE_INVALID)
	}
}

func localContainerTarget() domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{
			Transport: domain.TransportLocal,
			Engine:    domain.EngineApple,
			Dir:       "~/Library/Application Support/DeskWand/local",
		},
	}
}

func TestAdminAccessReadsALocalTokenInThePlainDialect(t *testing.T) {
	dir := "~/Library/Application Support/DeskWand/local"
	host := &fakeHost{files: map[string][]byte{
		envPath(dir): []byte("ADMIN_TOKEN=local-token\nACTIVE_CHANNEL=telegram\n"),
	}}
	token, err := newService(host).AdminAccess(context.Background(), localContainerTarget())
	if err != nil {
		t.Fatalf("AdminAccess: %v", err)
	}
	if token != "local-token" {
		t.Fatalf("token = %q, want local-token", token)
	}
}

func TestAdminAccessKeepsTheTokenOutOfTheSnapshot(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		envPath("~/deskwand"): []byte("ADMIN_TOKEN=abc123\nACTIVE_CHANNEL=telegram\n"),
	}}
	snapshot, err := newService(host).ReadSnapshot(context.Background(), containerTarget())
	if err != nil {
		t.Fatalf("ReadSnapshot: %v", err)
	}
	for _, name := range snapshot.SecretNames {
		if name == "ADMIN_TOKEN" {
			return
		}
	}
	t.Fatalf("SecretNames = %v, want ADMIN_TOKEN among the names", snapshot.SecretNames)
}

func hasContainerCode(err error, code string) bool {
	var coded domain.Error
	if !errors.As(err, &coded) {
		return false
	}
	return coded.Code == code
}

func TestAdminAccessRejectsATokenWithControlCharacters(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		envPath("~/deskwand"): []byte("ADMIN_TOKEN=abc123\rACTIVE_CHANNEL=telegram\n"),
	}}
	_, err := newService(host).AdminAccess(context.Background(), containerTarget())
	if !hasContainerCode(err, domain.ENV_FILE_INVALID) {
		t.Fatalf("error = %v, want %s", err, domain.ENV_FILE_INVALID)
	}
}

func TestAdminAccessTrimsSurroundingSpaces(t *testing.T) {
	host := &fakeHost{files: map[string][]byte{
		envPath("~/deskwand"): []byte("ADMIN_TOKEN=' abc123 '\n"),
	}}
	token, err := newService(host).AdminAccess(context.Background(), containerTarget())
	if err != nil {
		t.Fatalf("AdminAccess: %v", err)
	}
	if token != "abc123" {
		t.Fatalf("token = %q, want abc123", token)
	}
}
