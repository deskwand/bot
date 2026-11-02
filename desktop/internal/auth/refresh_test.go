package auth

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/platform"
)

func newRefreshService(t *testing.T, handler http.HandlerFunc) (*TokenService, *platform.MemoryCredentialStore) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	store := platform.NewMemoryCredentialStore()
	if err := store.Set(context.Background(), KeyRefreshToken, "cfort_old"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	service := NewTokenService(store)
	service.endpoints.Token = server.URL
	service.http = server.Client()
	return service, store
}

func TestTokenCachesAccessToken(t *testing.T) {
	var calls atomic.Int32
	service, _ := newRefreshService(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"cfoat_a","refresh_token":"cfort_b","expires_in":3600}`))
	})
	for i := 0; i < 3; i++ {
		token, err := service.Token(context.Background())
		if err != nil {
			t.Fatalf("Token: %v", err)
		}
		if token != "cfoat_a" {
			t.Fatalf("token = %q", token)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", calls.Load())
	}
}

func TestTokenPersistsRotatedRefreshToken(t *testing.T) {
	service, store := newRefreshService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"cfoat_a","refresh_token":"cfort_new","expires_in":3600}`))
	})
	if _, err := service.Token(context.Background()); err != nil {
		t.Fatalf("Token: %v", err)
	}
	stored, err := store.Get(context.Background(), KeyRefreshToken)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored != "cfort_new" {
		t.Fatalf("stored refresh token = %q, want the rotated value", stored)
	}
}

func TestTokenRefreshIsSingleFlight(t *testing.T) {
	var calls atomic.Int32
	service, _ := newRefreshService(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(`{"access_token":"cfoat_a","refresh_token":"cfort_new","expires_in":3600}`))
	})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := service.Token(context.Background()); err != nil {
				t.Errorf("Token: %v", err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent refresh calls = %d, want 1", calls.Load())
	}
}

func TestTokenInvalidGrantMarksReauthRequired(t *testing.T) {
	service, store := newRefreshService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
	})
	_ = store.Set(context.Background(), KeyAccountID, testAccountID)
	_, err := service.Token(context.Background())
	if Code(err) != ErrCodeReauthRequired {
		t.Fatalf("code = %q, want %q (err %v)", Code(err), ErrCodeReauthRequired, err)
	}
	status, _ := service.Status(context.Background())
	if status.State != StateReauthRequired {
		t.Fatalf("state = %q, want %q", status.State, StateReauthRequired)
	}
}

// failingSetStore rejects writes while keeping reads working, so the test can
// reach the persist step of a refresh.
type failingSetStore struct {
	platform.CredentialStore
	err error
}

func (f failingSetStore) Set(context.Context, string, string) error { return f.err }

func TestTokenDoesNotReturnAccessTokenWhenPersistFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"cfoat_a","refresh_token":"cfort_new","expires_in":3600}`))
	}))
	defer server.Close()

	store := platform.NewMemoryCredentialStore()
	if err := store.Set(context.Background(), KeyRefreshToken, "cfort_old"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	service := NewTokenService(failingSetStore{CredentialStore: store, err: errors.New("vault is read-only")})
	service.endpoints.Token = server.URL
	service.http = server.Client()

	if _, err := service.Token(context.Background()); Code(err) != ErrCodeCredentialStoreFailure {
		t.Fatalf("code = %q, want %q (err %v)", Code(err), ErrCodeCredentialStoreFailure, err)
	}
	if service.access != "" {
		t.Fatal("a failed persist must not leave an access token in memory")
	}
}

func TestTokenMarksReauthRequiredOnABareUnauthorizedStatus(t *testing.T) {
	service, store := newRefreshService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"success":false}`))
	})
	_ = store.Set(context.Background(), KeyAccountID, testAccountID)

	if _, err := service.Token(context.Background()); Code(err) != ErrCodeReauthRequired {
		t.Fatalf("code = %q, want %q", Code(err), ErrCodeReauthRequired)
	}
}

func TestBeginLoginReportsBusyPorts(t *testing.T) {
	service := NewTokenService(platform.NewMemoryCredentialStore())
	service.listen = func(int) (net.Listener, error) { return nil, errors.New("busy") }
	if _, err := service.BeginLogin(context.Background()); Code(err) != ErrCodeOAuthPortBusy {
		t.Fatalf("code = %q, want %q", Code(err), ErrCodeOAuthPortBusy)
	}
}

func TestStoreLoginWritesEveryKeyAndCachesToken(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	service := NewTokenService(store)
	set := tokenSet{Access: "cfoat_a", Refresh: "cfort_b", ExpiresIn: 3600}
	if err := service.storeLogin(context.Background(), set, Account{ID: testAccountID, Name: "测试账户"}); err != nil {
		t.Fatalf("storeLogin: %v", err)
	}
	connection, err := service.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if connection.State != StateConnected || connection.AccountID != testAccountID || connection.AccountName != "测试账户" {
		t.Fatalf("unexpected connection: %+v", connection)
	}
	token, ok := service.cachedToken()
	if !ok || token != "cfoat_a" {
		t.Fatalf("access token must be cached, got %q ok=%v", token, ok)
	}
}

func TestStoreLoginRollsBackWhenAWriteFails(t *testing.T) {
	inner := platform.NewMemoryCredentialStore()
	_ = inner.Set(context.Background(), KeyRefreshToken, "cfort_previous")
	_ = inner.Set(context.Background(), KeyAccountID, "previous-account")

	service := NewTokenService(failingSetStore{CredentialStore: inner, err: errors.New("vault is read-only")})
	set := tokenSet{Access: "cfoat_a", Refresh: "cfort_b", ExpiresIn: 3600}
	if err := service.storeLogin(context.Background(), set, Account{ID: testAccountID}); err == nil {
		t.Fatal("storeLogin must fail when the store rejects writes")
	}
	// The rollback write also fails, so the previous values survive untouched.
	if value, err := inner.Get(context.Background(), KeyRefreshToken); err != nil || value != "cfort_previous" {
		t.Fatalf("refresh token = %q err=%v, want the previous value", value, err)
	}
}
