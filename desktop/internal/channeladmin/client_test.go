package channeladmin

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func client(t *testing.T, handler http.HandlerFunc, token string) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewClient(server.URL, token, server.Client())
}

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var failure domain.Error
	if !errors.As(err, &failure) {
		t.Fatalf("error = %v, want domain.Error", err)
	}
	return failure.Code
}

func TestChannelsListsAndSendsTheToken(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/channels" || r.Header.Get("Authorization") != "Bearer tok" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"channels":[
			{"channelId":"owner","label":"我","account":"05d5@im.bot","state":"running","lastErrorCode":null,"teen":false},
			{"channelId":"m1","label":"小宝","account":"e8d1@im.bot","state":"needs_reset","lastErrorCode":"SEND_EXHAUSTED","teen":true}]}`))
	}, "tok")

	rows, err := c.Channels(context.Background())
	if err != nil {
		t.Fatalf("Channels: %v", err)
	}
	if len(rows) != 2 || rows[1].State != "needs_reset" {
		t.Fatalf("rows = %#v", rows)
	}
	if rows[0].Teen || !rows[1].Teen {
		t.Fatalf("teen = %v/%v", rows[0].Teen, rows[1].Teen)
	}
	if rows[1].LastErrorCode == nil || *rows[1].LastErrorCode != "SEND_EXHAUSTED" {
		t.Fatalf("lastErrorCode = %#v", rows[1].LastErrorCode)
	}
}

func TestRestartRefusesAnExpiredChannel(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/channels/c1/restart" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"REBIND_REQUIRED"}`))
	}, "tok")

	if got := codeOf(t, c.Restart(context.Background(), "c1")); got != CodeRebindNeeded {
		t.Fatalf("code = %s", got)
	}
}

func TestRemoveUsesDelete(t *testing.T) {
	var method string
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		if r.URL.Path != "/admin/channels/c1" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}, "tok")

	if err := c.Remove(context.Background(), "c1"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if method != http.MethodDelete {
		t.Fatalf("method = %s", method)
	}
}

func TestMissingRouteIsUnsupported(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}, "tok")

	if got := codeOf(t, c.Restart(context.Background(), "c1")); got != CodeUnsupported {
		t.Fatalf("code = %s", got)
	}
}

func TestSubmitPinMapsAnExhaustedBudget(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/channels/bindings/inv-1/pin" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"code":"PIN_ATTEMPTS_EXHAUSTED"}`))
	}, "tok")

	_, err := c.SubmitPin(context.Background(), "inv-1", "123456")
	if got := codeOf(t, err); got != CodePinExhausted {
		t.Fatalf("code = %s", got)
	}
}

func TestCreateInviteCarriesTheFlag(t *testing.T) {
	var body string
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"inviteId":"inv-1","expiresAt":1893456000000}`))
	}, "tok")

	if _, err := c.CreateInvite(context.Background(), "小宝", true); err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if body != `{"label":"小宝","teen":true}` {
		t.Fatalf("body = %s", body)
	}
}

func TestSetTeenPostsTheFlag(t *testing.T) {
	var method, path, body string
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		method, path, body = r.Method, r.URL.Path, string(raw)
		w.WriteHeader(http.StatusNoContent)
	}, "tok")

	if err := c.SetTeen(context.Background(), "m1", true); err != nil {
		t.Fatalf("SetTeen: %v", err)
	}
	if method != http.MethodPost || path != "/admin/channels/m1/teen" {
		t.Fatalf("request = %s %s", method, path)
	}
	if body != `{"teen":true}` {
		t.Fatalf("body = %s", body)
	}
}

func TestSetTeenMapsFixedCodes(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"CHANNEL_IMMUTABLE"}`))
	}, "tok")

	if code := codeOf(t, c.SetTeen(context.Background(), "owner", true)); code != CodeImmutable {
		t.Fatalf("code = %s", code)
	}
}
