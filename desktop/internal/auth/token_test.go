package auth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/platform"
)

const testAccountID = "0123456789abcdef0123456789abcdef"
const testSentinel = "SENTINEL-refresh-token-never-log"
const testRefreshToken = "cfort_" + testSentinel

func TestStatusReportsReauthRequired(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	if err := store.Set(context.Background(), KeyRefreshToken, testRefreshToken); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = store.Set(context.Background(), KeyAccountID, testAccountID)
	_ = store.Set(context.Background(), KeyAccountName, "测试账户")

	service := NewTokenService(store)
	service.markReauthRequired()

	connection, err := service.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if connection.State != StateReauthRequired {
		t.Fatalf("state = %q, want %q", connection.State, StateReauthRequired)
	}
	if connection.AccountName != "测试账户" {
		t.Fatalf("account name = %q", connection.AccountName)
	}
}

func TestStatusIsDisconnectedWithoutRefreshToken(t *testing.T) {
	service := NewTokenService(platform.NewMemoryCredentialStore())
	connection, err := service.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if connection.State != StateDisconnected {
		t.Fatalf("state = %q, want %q", connection.State, StateDisconnected)
	}
}

func TestStatusRequiresAnAccountID(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	_ = store.Set(context.Background(), KeyRefreshToken, testRefreshToken)

	service := NewTokenService(store)
	connection, err := service.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if connection.State != StateDisconnected {
		t.Fatalf("state = %q, want %q: a refresh token alone cannot drive any operation", connection.State, StateDisconnected)
	}
}

func TestDisconnectRevokesAndDeletesEveryKey(t *testing.T) {
	var revoked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		revoked = r.PostForm.Get("token")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()

	store := platform.NewMemoryCredentialStore()
	_ = store.Set(context.Background(), KeyRefreshToken, testRefreshToken)
	_ = store.Set(context.Background(), KeyAccountID, testAccountID)
	_ = store.Set(context.Background(), KeyAccountName, "测试账户")
	service := NewTokenService(store)
	service.endpoints.Revoke = server.URL
	service.http = server.Client()

	if err := service.Disconnect(context.Background()); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
	if revoked != testRefreshToken {
		t.Fatalf("revoked = %q, want the stored refresh token", revoked)
	}
	for _, key := range []string{KeyRefreshToken, KeyAccountID, KeyAccountName} {
		if _, err := store.Get(context.Background(), key); !errors.Is(err, platform.ErrCredentialNotFound) {
			t.Fatalf("%s must be deleted, got %v", key, err)
		}
	}
}

func TestDisconnectSucceedsWhenRevokeFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"invalid_request"}`)
	}))
	defer server.Close()

	store := platform.NewMemoryCredentialStore()
	_ = store.Set(context.Background(), KeyRefreshToken, testRefreshToken)
	service := NewTokenService(store)
	service.endpoints.Revoke = server.URL
	service.http = server.Client()

	if err := service.Disconnect(context.Background()); err != nil {
		t.Fatalf("Disconnect must not fail on a rejected revoke: %v", err)
	}
	if _, err := store.Get(context.Background(), KeyRefreshToken); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatal("local credentials must be deleted even when revoke fails")
	}
}

func TestNewTokenServiceDeletesLegacyAPITokenKeys(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	_ = store.Set(context.Background(), "cloudflare.api-token", "cfut_legacy")
	_ = store.Set(context.Background(), "cloudflare.account-id", testAccountID)

	service := NewTokenService(store)

	for _, key := range []string{"cloudflare.api-token", "cloudflare.account-id"} {
		if _, err := store.Get(context.Background(), key); !errors.Is(err, platform.ErrCredentialNotFound) {
			t.Fatalf("%s must be deleted, got %v", key, err)
		}
	}
	connection, err := service.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if connection.State != StateDisconnected {
		t.Fatalf("state = %q, want %q", connection.State, StateDisconnected)
	}
}

func TestErrorsNeverLeakTheRefreshToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
	}))
	defer server.Close()

	store := platform.NewMemoryCredentialStore()
	_ = store.Set(context.Background(), KeyRefreshToken, testRefreshToken)
	service := NewTokenService(store)
	service.endpoints.Token = server.URL
	service.http = server.Client()

	_, err := service.Token(context.Background())
	if err == nil {
		t.Fatal("Token must fail on invalid_grant")
	}
	if strings.Contains(err.Error(), testSentinel) {
		t.Fatalf("error leaked the refresh token: %v", err)
	}
}
