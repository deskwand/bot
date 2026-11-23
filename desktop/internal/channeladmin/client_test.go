package channeladmin

import (
	"context"
	"errors"
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
			{"channelId":"owner","label":"我","account":"05d5@im.bot","state":"running","lastErrorCode":null},
			{"channelId":"m1","label":"小宝","account":"e8d1@im.bot","state":"needs_reset","lastErrorCode":"SEND_EXHAUSTED"}]}`))
	}, "tok")

	rows, err := c.Channels(context.Background())
	if err != nil {
		t.Fatalf("Channels: %v", err)
	}
	if len(rows) != 2 || rows[1].State != "needs_reset" {
		t.Fatalf("rows = %#v", rows)
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
