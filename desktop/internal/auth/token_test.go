package auth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/deskwand/bot/desktop/internal/cloudflare"
	"github.com/deskwand/bot/desktop/internal/cloudflare/cloudflaretest"
	"github.com/deskwand/bot/desktop/internal/platform"
)

const (
	testAccountID = "0123456789abcdef0123456789abcdef"
	testSentinel  = "SENTINEL-api-token-never-log"
	testToken     = "cfut_" + testSentinel
)

type fakeAPI struct {
	mu sync.Mutex

	calls []string

	verifyStatus string
	verifyErr    error

	accountName string
	accountErr  error
}

func (f *fakeAPI) GetJSON(ctx context.Context, path string, query url.Values, out any) error {
	f.mu.Lock()
	f.calls = append(f.calls, path)
	f.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}
	switch {
	case strings.Contains(path, "/tokens/verify"):
		if f.verifyErr != nil {
			return f.verifyErr
		}
		status := f.verifyStatus
		if status == "" {
			status = "active"
		}
		*out.(*tokenVerify) = tokenVerify{ID: "token-id", Status: status}
		return nil
	case strings.HasPrefix(path, "/accounts/"):
		if f.accountErr != nil {
			return f.accountErr
		}
		*out.(*accountResult) = accountResult{ID: testAccountID, Name: f.accountName}
		return nil
	default:
		return fmt.Errorf("unexpected path %q", path)
	}
}

func testService(store platform.CredentialStore, api *fakeAPI) *TokenService {
	if api == nil {
		api = &fakeAPI{verifyStatus: "active", accountName: "Example Account"}
	}
	return &TokenService{
		store: store,
		newAPI: func(string) cloudflareAPI {
			return api
		},
	}
}

func (f *fakeAPI) callList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func TestConnectRejectsInvalidFormatWithoutNetworkCall(t *testing.T) {
	cases := []struct {
		name      string
		accountID string
		token     string
		code      string
	}{
		{"short account", "abc", testToken, ErrCodeInvalidAccountID},
		{"non-hex account", strings.Repeat("z", 32), testToken, ErrCodeInvalidAccountID},
		{"account whitespace", testAccountID[:31] + " ", testToken, ErrCodeInvalidAccountID},
		{"empty token", testAccountID, "", ErrCodeInvalidToken},
		{"short token", testAccountID, "cfut_short", ErrCodeInvalidToken},
		{"dot token", testAccountID, "cfut_abc.def-ghi-jkl-mno", ErrCodeInvalidToken},
		{"whitespace token", testAccountID, "cfut_abc def", ErrCodeInvalidToken},
		{"newline token", testAccountID, "cfut_abc\ndef", ErrCodeInvalidToken},
		{"oversized token", testAccountID, strings.Repeat("a", 513), ErrCodeInvalidToken},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			svc := &TokenService{
				store: platform.NewMemoryCredentialStore(),
				newAPI: func(string) cloudflareAPI {
					calls++
					return &fakeAPI{}
				},
			}
			_, err := svc.Connect(context.Background(), tc.accountID, tc.token)
			if got := Code(err); got != tc.code {
				t.Fatalf("code = %q, want %q (err=%v)", got, tc.code, err)
			}
			if calls != 0 {
				t.Fatalf("formed a client %d times for invalid input", calls)
			}
		})
	}
}

func TestConnectRejectsInvalidTokenAndStoresNothing(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	api := &fakeAPI{
		verifyErr: &cloudflare.APIError{
			Status:  401,
			Code:    1000,
			Message: "invalid token " + testSentinel,
		},
	}
	svc := testService(store, api)

	_, err := svc.Connect(context.Background(), testAccountID, testToken)
	if got := Code(err); got != ErrCodeInvalidToken {
		t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeInvalidToken, err)
	}
	assertNoSentinel(t, err)
	assertNotStored(t, store, KeyAPIToken)
	assertNotStored(t, store, KeyAccountID)
}

func TestConnectRejectsInactiveTokenAndStoresNothing(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	svc := testService(store, &fakeAPI{verifyStatus: "disabled", accountName: "Example"})

	_, err := svc.Connect(context.Background(), testAccountID, testToken)
	if got := Code(err); got != ErrCodeInvalidToken {
		t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeInvalidToken, err)
	}
	assertNotStored(t, store, KeyAPIToken)
	assertNotStored(t, store, KeyAccountID)
}

func TestConnectReportsTransientVerifyFailures(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"transport", &cloudflare.APIError{Status: 0}},
		{"rate limited", &cloudflare.APIError{Status: 429, Code: 10000}},
		{"server error", &cloudflare.APIError{Status: 503, Code: 10000}},
		{"non-JSON", &cloudflare.APIError{Status: 401, Message: "non-JSON response"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := platform.NewMemoryCredentialStore()
			svc := testService(store, &fakeAPI{verifyErr: tc.err})
			_, err := svc.Connect(context.Background(), testAccountID, testToken)
			if got := Code(err); got != ErrCodeVerifyFailed {
				t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeVerifyFailed, err)
			}
			if !strings.Contains(err.Error(), "try again") {
				t.Fatalf("error does not tell the user to try again: %v", err)
			}
			assertNotStored(t, store, KeyAPIToken)
			assertNotStored(t, store, KeyAccountID)
		})
	}
}

func TestConnectReportsTransientAccountLookupFailures(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"transport", &cloudflare.APIError{Status: 0}},
		{"rate limited", &cloudflare.APIError{Status: 429, Code: 10000}},
		{"server error", &cloudflare.APIError{Status: 503, Code: 10000}},
		{"non-JSON", &cloudflare.APIError{Status: 400, Message: "non-JSON response"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := platform.NewMemoryCredentialStore()
			svc := testService(store, &fakeAPI{
				verifyStatus: "active",
				accountErr:   tc.err,
			})
			_, err := svc.Connect(context.Background(), testAccountID, testToken)
			if got := Code(err); got != ErrCodeAccountLookupFailed {
				t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeAccountLookupFailed, err)
			}
			if !strings.Contains(err.Error(), "try again") {
				t.Fatalf("error does not tell the user to try again: %v", err)
			}
			assertNotStored(t, store, KeyAPIToken)
			assertNotStored(t, store, KeyAccountID)
		})
	}
}

func TestConnectTrimsSurroundingTokenWhitespace(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	svc := testService(store, &fakeAPI{verifyStatus: "active", accountName: "Example"})
	if _, err := svc.Connect(context.Background(), testAccountID, "  "+testToken+"\n"); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	stored, err := store.Get(context.Background(), KeyAPIToken)
	if err != nil || stored != testToken {
		t.Fatalf("stored token = %q, err=%v; want trimmed token", stored, err)
	}
}

func TestConnectDoesNotLeakGenericVerifyError(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	svc := testService(store, &fakeAPI{verifyErr: errors.New("dial failed for token " + testSentinel)})

	_, err := svc.Connect(context.Background(), testAccountID, testToken)
	if err == nil {
		t.Fatal("expected error")
	}
	assertNoSentinel(t, err)
	assertNotStored(t, store, KeyAPIToken)
	assertNotStored(t, store, KeyAccountID)
}

func TestConnectReportsCredentialStoreUnavailable(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	store.FailWith(platform.ErrCredentialStoreUnavailable)
	svc := testService(store, &fakeAPI{verifyStatus: "active", accountName: "Example"})

	_, err := svc.Connect(context.Background(), testAccountID, testToken)
	if got := Code(err); got != ErrCodeCredentialStoreUnavailable {
		t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeCredentialStoreUnavailable, err)
	}
	assertNoSentinel(t, err)
}

func TestConnectSuccessStoresBothCredentials(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	api := &fakeAPI{verifyStatus: "active", accountName: "Example Account"}
	svc := testService(store, api)

	account, err := svc.Connect(context.Background(), testAccountID, testToken)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if account.ID != testAccountID || account.Name != "Example Account" {
		t.Fatalf("account = %+v", account)
	}

	token, err := store.Get(context.Background(), KeyAPIToken)
	if err != nil || token != testToken {
		t.Fatalf("stored token err=%v", err)
	}
	accountID, err := store.Get(context.Background(), KeyAccountID)
	if err != nil || accountID != testAccountID {
		t.Fatalf("stored account id = %q, err=%v", accountID, err)
	}

	conn, err := svc.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if conn.State != StateConnected || conn.AccountID != testAccountID {
		t.Fatalf("connection = %+v", conn)
	}
	gotToken, err := svc.Token(context.Background())
	if err != nil || gotToken != testToken {
		t.Fatalf("Token err=%v", err)
	}

	calls := api.callList()
	if len(calls) < 2 || calls[0] != "/user/tokens/verify" {
		t.Fatalf("verify calls = %v, want user token verify first", calls)
	}
	if calls[len(calls)-1] != "/accounts/"+testAccountID {
		t.Fatalf("last call = %q, want account lookup", calls[len(calls)-1])
	}
}

func TestConnectAccountTokenUsesAccountVerify(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	api := &fakeAPI{verifyStatus: "active", accountName: "Example Account"}
	svc := testService(store, api)

	accountToken := "cfat_" + testSentinel
	if _, err := svc.Connect(context.Background(), testAccountID, accountToken); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	calls := api.callList()
	if len(calls) == 0 || calls[0] != "/accounts/"+testAccountID+"/tokens/verify" {
		t.Fatalf("calls = %v, want account token verify", calls)
	}
	for _, path := range calls {
		if path == "/user/tokens/verify" {
			t.Fatalf("account token used user verify: %v", calls)
		}
	}
}

func TestDisconnectRemovesLocalCredentialsOnly(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	api := &fakeAPI{verifyStatus: "active", accountName: "Example Account"}
	svc := testService(store, api)
	if _, err := svc.Connect(context.Background(), testAccountID, testToken); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	callsBefore := len(api.callList())

	if err := svc.Disconnect(context.Background()); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
	assertNotStored(t, store, KeyAPIToken)
	assertNotStored(t, store, KeyAccountID)
	if got := len(api.callList()); got != callsBefore {
		t.Fatalf("Disconnect made %d network calls", got-callsBefore)
	}
	if _, err := svc.Token(context.Background()); Code(err) != ErrCodeNotConnected {
		t.Fatalf("Token after Disconnect err = %v", err)
	}
	conn, err := svc.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if conn.State != StateDisconnected {
		t.Fatalf("state = %q, want disconnected", conn.State)
	}
}

func TestStatusReportsUnavailable(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	store.FailWith(platform.ErrCredentialStoreUnavailable)
	svc := testService(store, nil)
	_, err := svc.Status(context.Background())
	if got := Code(err); got != ErrCodeCredentialStoreUnavailable {
		t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeCredentialStoreUnavailable, err)
	}
	conn, _ := svc.Status(context.Background())
	if conn.State != StateUnavailable {
		t.Fatalf("state = %q, want unavailable", conn.State)
	}
}

func TestResultsAndLogsNeverContainToken(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	svc := testService(store, &fakeAPI{verifyStatus: "active", accountName: "Example Account"})
	account, err := svc.Connect(context.Background(), testAccountID, testToken)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	conn, err := svc.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}

	for _, rendered := range []string{
		fmt.Sprintf("%v", account),
		fmt.Sprintf("%+v", account),
		fmt.Sprintf("%#v", account),
		fmt.Sprintf("%v", conn),
		fmt.Sprintf("%+v", conn),
		fmt.Sprintf("%#v", conn),
	} {
		if strings.Contains(rendered, testSentinel) {
			t.Fatalf("result rendering contains token: %s", rendered)
		}
	}

	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	errorSvc := testService(store, &fakeAPI{
		verifyErr: &cloudflare.APIError{Status: 401, Code: 1000, Message: "bad token " + testSentinel},
	})
	_, err = errorSvc.Connect(context.Background(), testAccountID, testToken)
	if err == nil {
		t.Fatal("expected the error path to fail")
	}
	logger.Error("connect failed", "err", err)
	logger.Info("connected", "account", account, "connection", conn)
	if strings.Contains(buf.String(), testSentinel) {
		t.Fatalf("slog output contains token: %s", buf.String())
	}
	if strings.Contains(fmt.Sprintf("%+v", err), testSentinel) {
		t.Fatalf("%%+v of error contains token: %+v", err)
	}
}

func TestConnectRealClientRedactsTokenInErrorsAndLogs(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintf(w, `{"success":false,"errors":[{"code":1000,"message":"bad header %s and token %s"}]}`,
			r.Header.Get("Authorization"), cloudflaretest.TestToken)
	})
	client, _ := cloudflaretest.NewServerClient(t, handler)

	store := platform.NewMemoryCredentialStore()
	svc := NewTokenService(store)
	svc.newAPI = func(string) cloudflareAPI { return client }

	_, err := svc.Connect(context.Background(), testAccountID, cloudflaretest.TestToken)
	if got := Code(err); got != ErrCodeInvalidToken {
		t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeInvalidToken, err)
	}
	renderings := []string{
		err.Error(),
		fmt.Sprintf("%v", err),
		fmt.Sprintf("%+v", err),
		fmt.Sprintf("%#v", err),
	}
	for _, rendered := range renderings {
		if strings.Contains(rendered, cloudflaretest.TestToken) {
			t.Fatalf("error rendering contains token: %s", rendered)
		}
	}
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	logger.Error("connect failed", "err", err)
	if strings.Contains(buf.String(), cloudflaretest.TestToken) {
		t.Fatalf("JSON slog output contains token: %s", buf.String())
	}
	assertNotStored(t, store, KeyAPIToken)
	assertNotStored(t, store, KeyAccountID)
}

type failOnceStore struct {
	*platform.MemoryCredentialStore
	mu       sync.Mutex
	failures map[string]error
}

func newFailOnceStore() *failOnceStore {
	return &failOnceStore{
		MemoryCredentialStore: platform.NewMemoryCredentialStore(),
		failures:              map[string]error{},
	}
}

func (s *failOnceStore) FailOnce(key string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[key] = err
}

func (s *failOnceStore) Set(ctx context.Context, key, value string) error {
	s.mu.Lock()
	err := s.failures[key]
	if err != nil {
		delete(s.failures, key)
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.MemoryCredentialStore.Set(ctx, key, value)
}

func TestConnectRestoresPreviousCredentialsWhenWriteFails(t *testing.T) {
	const (
		oldAccount = "aaaabbbbccccddddeeeeffff00001111"
		newAccount = "11112222333344445555666677778888"
		oldToken   = "cfut_old-token-0123456789"
		newToken   = "cfut_new-token-0123456789"
	)
	for _, failKey := range []string{KeyAccountID, KeyAPIToken} {
		t.Run(failKey, func(t *testing.T) {
			store := newFailOnceStore()
			svc := testService(store, &fakeAPI{verifyStatus: "active", accountName: "Example"})
			if _, err := svc.Connect(context.Background(), oldAccount, oldToken); err != nil {
				t.Fatalf("seed Connect: %v", err)
			}
			store.FailOnce(failKey, platform.ErrCredentialStoreUnavailable)

			_, err := svc.Connect(context.Background(), newAccount, newToken)
			if got := Code(err); got != ErrCodeCredentialStoreUnavailable {
				t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeCredentialStoreUnavailable, err)
			}
			storedAccount, err := store.Get(context.Background(), KeyAccountID)
			if err != nil || storedAccount != oldAccount {
				t.Fatalf("account id = %q, err=%v; want previous %q", storedAccount, err, oldAccount)
			}
			storedToken, err := store.Get(context.Background(), KeyAPIToken)
			if err != nil || storedToken != oldToken {
				t.Fatalf("token = %q, err=%v; want previous token restored", storedToken, err)
			}
		})
	}
}

func TestConnectLeavesNothingWhenFirstConnectionWriteFails(t *testing.T) {
	const newAccount = "11112222333344445555666677778888"
	const newToken = "cfut_new-token-0123456789"
	for _, failKey := range []string{KeyAccountID, KeyAPIToken} {
		t.Run(failKey, func(t *testing.T) {
			store := newFailOnceStore()
			svc := testService(store, &fakeAPI{verifyStatus: "active", accountName: "Example"})
			store.FailOnce(failKey, platform.ErrCredentialStoreUnavailable)

			if _, err := svc.Connect(context.Background(), newAccount, newToken); err == nil {
				t.Fatal("Connect succeeded despite write failure")
			}
			assertNotStored(t, store, KeyAPIToken)
			assertNotStored(t, store, KeyAccountID)
		})
	}
}

func TestConnectAccountLookupAuthRejectionIsInvalidToken(t *testing.T) {
	store := platform.NewMemoryCredentialStore()
	svc := testService(store, &fakeAPI{
		verifyStatus: "active",
		accountErr:   &cloudflare.APIError{Status: 403, Code: 10000},
	})
	_, err := svc.Connect(context.Background(), testAccountID, testToken)
	if got := Code(err); got != ErrCodeInvalidToken {
		t.Fatalf("code = %q, want %q (err=%v)", got, ErrCodeInvalidToken, err)
	}
	assertNotStored(t, store, KeyAPIToken)
	assertNotStored(t, store, KeyAccountID)
}

func assertNotStored(t *testing.T, store platform.CredentialStore, key string) {
	t.Helper()
	if _, err := store.Get(context.Background(), key); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("credential %q was stored: %v", key, err)
	}
}

func assertNoSentinel(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), testSentinel) {
		t.Fatalf("error leaks token sentinel: %v", err)
	}
}
