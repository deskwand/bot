package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/deskwand/bot/desktop/internal/platform"
)

// fakeAccountsAPI answers only the account listing the login needs.
type fakeAccountsAPI struct {
	accounts []Account
	err      error
}

func (f fakeAccountsAPI) GetJSON(_ context.Context, path string, _ url.Values, out any) error {
	if f.err != nil {
		return f.err
	}
	if path != "/accounts" {
		return fmt.Errorf("unexpected path %q", path)
	}
	target, ok := out.(*[]Account)
	if !ok {
		return fmt.Errorf("unexpected out type %T", out)
	}
	*target = f.accounts
	return nil
}

type loginFixture struct {
	service *TokenService
	store   *platform.MemoryCredentialStore
	calls   *atomic.Int32
}

func newLoginFixture(t *testing.T, accounts ...Account) *loginFixture {
	t.Helper()
	calls := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"cfoat_login","refresh_token":"cfort_login","expires_in":3600}`))
	}))
	t.Cleanup(server.Close)

	store := platform.NewMemoryCredentialStore()
	service := NewTokenService(store)
	service.endpoints.Token = server.URL
	service.http = server.Client()
	service.listen = func(int) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	service.newAPI = func(string) cloudflareAPI { return fakeAccountsAPI{accounts: accounts} }
	return &loginFixture{service: service, store: store, calls: calls}
}

// stateFromAuthURL pulls the state the browser would echo back.
func stateFromAuthURL(t *testing.T, authURL string) string {
	t.Helper()
	parsed, err := url.Parse(authURL)
	if err != nil {
		t.Fatalf("parse auth url: %v", err)
	}
	state := parsed.Query().Get("state")
	if state == "" {
		t.Fatal("auth url carries no state")
	}
	return state
}

// hitCallback imitates the browser following Cloudflare's redirect.
func hitCallback(t *testing.T, session LoginSession, query string) {
	t.Helper()
	parsed, err := url.Parse(session.AuthURL())
	if err != nil {
		t.Fatalf("parse auth url: %v", err)
	}
	redirect := parsed.Query().Get("redirect_uri")
	resp, err := http.Get(redirect + "?" + query)
	if err != nil {
		t.Fatalf("hit callback: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
}

func TestLoginSessionExchangesCodeAndListsAccounts(t *testing.T) {
	f := newLoginFixture(t, Account{ID: testAccountID, Name: "测试账户"})
	session, err := f.service.BeginLogin(context.Background())
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer session.Cancel()

	hitCallback(t, session, "code=CODE&state="+stateFromAuthURL(t, session.AuthURL()))
	result, err := session.Wait(context.Background())
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if len(result.Accounts) != 1 || result.Accounts[0].ID != testAccountID {
		t.Fatalf("accounts = %+v", result.Accounts)
	}
	if err := session.Complete(context.Background(), testAccountID); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	connection, err := f.service.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if connection.State != StateConnected || connection.AccountName != "测试账户" {
		t.Fatalf("unexpected connection: %+v", connection)
	}
}

func TestLoginSessionRejectsMismatchedState(t *testing.T) {
	f := newLoginFixture(t, Account{ID: testAccountID})
	session, err := f.service.BeginLogin(context.Background())
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer session.Cancel()

	hitCallback(t, session, "code=CODE&state=forged")
	_, err = session.Wait(context.Background())
	if Code(err) != ErrCodeOAuthStateMismatch {
		t.Fatalf("code = %q, want %q (err %v)", Code(err), ErrCodeOAuthStateMismatch, err)
	}
	if f.calls.Load() != 0 {
		t.Fatal("a mismatched state must not reach the token endpoint")
	}
}

func TestLoginSessionReportsUserDenial(t *testing.T) {
	f := newLoginFixture(t, Account{ID: testAccountID})
	session, err := f.service.BeginLogin(context.Background())
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer session.Cancel()

	hitCallback(t, session, "error=access_denied&error_description=User+denied")
	_, err = session.Wait(context.Background())
	if Code(err) != ErrCodeOAuthDenied {
		t.Fatalf("code = %q, want %q (err %v)", Code(err), ErrCodeOAuthDenied, err)
	}
	if !strings.Contains(err.Error(), "access_denied") {
		t.Fatalf("error should name the Cloudflare failure: %v", err)
	}
}

func TestLoginSessionReportsNoAccount(t *testing.T) {
	f := newLoginFixture(t)
	session, err := f.service.BeginLogin(context.Background())
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer session.Cancel()

	hitCallback(t, session, "code=CODE&state="+stateFromAuthURL(t, session.AuthURL()))
	_, err = session.Wait(context.Background())
	if Code(err) != ErrCodeNoAccount {
		t.Fatalf("code = %q, want %q (err %v)", Code(err), ErrCodeNoAccount, err)
	}
}

func TestLoginSessionCancelReleasesThePort(t *testing.T) {
	f := newLoginFixture(t, Account{ID: testAccountID})
	session, err := f.service.BeginLogin(context.Background())
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	parsed, err := url.Parse(session.AuthURL())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	session.Cancel()

	if _, err := session.Wait(context.Background()); err == nil {
		t.Fatal("Wait must fail after Cancel")
	}
	resp, err := http.Get(parsed.Query().Get("redirect_uri") + "?code=CODE&state=x")
	if err == nil {
		resp.Body.Close()
		t.Fatal("the callback port must be closed after Cancel")
	}
}

func TestCompleteRejectsAnAccountThatWasNotOffered(t *testing.T) {
	f := newLoginFixture(t, Account{ID: testAccountID})
	session, err := f.service.BeginLogin(context.Background())
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer session.Cancel()
	hitCallback(t, session, "code=CODE&state="+stateFromAuthURL(t, session.AuthURL()))
	if _, err := session.Wait(context.Background()); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if err := session.Complete(context.Background(), "ffffffffffffffffffffffffffffffff"); Code(err) != ErrCodeNoAccount {
		t.Fatalf("code = %q, want %q", Code(err), ErrCodeNoAccount)
	}
	if _, err := f.store.Get(context.Background(), KeyRefreshToken); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatal("nothing may be stored when the account is rejected")
	}
}
