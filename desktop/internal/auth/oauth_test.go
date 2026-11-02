package auth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// RFC 7636 Appendix B publishes this verifier/challenge pair.
func TestCodeChallengeMatchesRFC7636Vector(t *testing.T) {
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	const want = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := codeChallenge(verifier); got != want {
		t.Fatalf("codeChallenge = %q, want %q", got, want)
	}
}

func TestRandomURLIsBase64URLWithoutPadding(t *testing.T) {
	value, err := randomURL(48)
	if err != nil {
		t.Fatalf("randomURL: %v", err)
	}
	if len(value) != 64 {
		t.Fatalf("48 bytes must encode to 64 chars, got %d", len(value))
	}
	if strings.ContainsAny(value, "+/=") {
		t.Fatalf("value must be base64url without padding: %q", value)
	}
}

func TestAuthorizeURLCarriesPKCEAndScopes(t *testing.T) {
	raw := authorizeURL(CloudflareOAuthEndpoints, "http://127.0.0.1:8756/callback", "STATE", "CHALLENGE")
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := parsed.Scheme + "://" + parsed.Host + parsed.Path; got != "https://dash.cloudflare.com/oauth2/auth" {
		t.Fatalf("unexpected authorize endpoint: %s", got)
	}
	query := parsed.Query()
	want := map[string]string{
		"client_id":             OAuthClientID,
		"redirect_uri":          "http://127.0.0.1:8756/callback",
		"response_type":         "code",
		"state":                 "STATE",
		"code_challenge":        "CHALLENGE",
		"code_challenge_method": "S256",
	}
	for key, value := range want {
		if query.Get(key) != value {
			t.Fatalf("%s = %q, want %q", key, query.Get(key), value)
		}
	}
	scopes := strings.Fields(query.Get("scope"))
	for _, required := range []string{"offline_access", "workers-scripts.edit", "workers-r2.write"} {
		found := false
		for _, scope := range scopes {
			if scope == required {
				found = true
			}
		}
		if !found {
			t.Fatalf("scope %q missing from %v", required, scopes)
		}
	}
}

func TestExchangeCodePostsPKCEVerifier(t *testing.T) {
	var got url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		got = r.PostForm
		io.WriteString(w, `{"access_token":"cfoat_abc","refresh_token":"cfort_def","token_type":"bearer","expires_in":3600}`)
	}))
	defer server.Close()

	endpoints := CloudflareOAuthEndpoints
	endpoints.Token = server.URL
	result, err := exchangeCode(context.Background(), server.Client(), endpoints, "CODE", "VERIFIER", "http://127.0.0.1:8756/callback")
	if err != nil {
		t.Fatalf("exchangeCode: %v", err)
	}
	if result.Access != "cfoat_abc" || result.Refresh != "cfort_def" || result.ExpiresIn != 3600 {
		t.Fatalf("unexpected token set: %+v", result)
	}
	for key, want := range map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     OAuthClientID,
		"code":          "CODE",
		"code_verifier": "VERIFIER",
		"redirect_uri":  "http://127.0.0.1:8756/callback",
	} {
		if got.Get(key) != want {
			t.Fatalf("%s = %q, want %q", key, got.Get(key), want)
		}
	}
	if got.Has("client_secret") {
		t.Fatal("a public PKCE client must not send a client secret")
	}
}

func TestExchangeCodeRejectsResponsesWithoutRefreshToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"access_token":"cfoat_abc","token_type":"bearer","expires_in":3600}`)
	}))
	defer server.Close()
	endpoints := CloudflareOAuthEndpoints
	endpoints.Token = server.URL
	_, err := exchangeCode(context.Background(), server.Client(), endpoints, "CODE", "VERIFIER", "http://127.0.0.1:8756/callback")
	if Code(err) != ErrCodeOAuthExchangeFailed {
		t.Fatalf("code = %q, want %q (err %v)", Code(err), ErrCodeOAuthExchangeFailed, err)
	}
}

func TestExchangeCodeSurfacesScopeRejection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":"invalid_scope","error_description":"Scope workers-r2.write is not configured for this client"}`)
	}))
	defer server.Close()
	endpoints := CloudflareOAuthEndpoints
	endpoints.Token = server.URL
	_, err := exchangeCode(context.Background(), server.Client(), endpoints, "CODE", "VERIFIER", "http://127.0.0.1:8756/callback")
	if Code(err) != ErrCodeOAuthExchangeFailed {
		t.Fatalf("code = %q, want %q (err %v)", Code(err), ErrCodeOAuthExchangeFailed, err)
	}
	if !strings.Contains(err.Error(), "invalid_scope") {
		t.Fatalf("error must name the Cloudflare error for debugging: %v", err)
	}
}

func TestRefreshAccessReportsInvalidGrant(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":"invalid_grant"}`)
	}))
	defer server.Close()
	endpoints := CloudflareOAuthEndpoints
	endpoints.Token = server.URL
	_, err := refreshAccess(context.Background(), server.Client(), endpoints, "cfort_old")
	if !errors.Is(err, errInvalidGrant) {
		t.Fatalf("err = %v, want errInvalidGrant", err)
	}
}

func TestRevokeAccessUsesRefreshToken(t *testing.T) {
	var got url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		got = r.PostForm
		io.WriteString(w, `{}`)
	}))
	defer server.Close()
	endpoints := CloudflareOAuthEndpoints
	endpoints.Revoke = server.URL
	if err := revokeAccess(context.Background(), server.Client(), endpoints, "cfort_def"); err != nil {
		t.Fatalf("revokeAccess: %v", err)
	}
	if got.Get("token") != "cfort_def" || got.Get("client_id") != OAuthClientID {
		t.Fatalf("unexpected revoke form: %v", got)
	}
}
