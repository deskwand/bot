package memberadmin

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

func TestListMapsUsersAndSendsTheToken(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/members" || r.Header.Get("Authorization") != "Bearer tok" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"users":[{"memberId":"owner","label":"我","role":"owner",
			"status":"active","connection":"running","inviteId":null},
			{"memberId":"m1","label":"小王","role":"member","status":"active",
			"connection":"expired","inviteId":"inv-1"}]}`))
	}, "tok")

	users, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(users) != 2 || users[1].Connection != "expired" {
		t.Fatalf("users = %#v", users)
	}
	if users[1].InviteID == nil || *users[1].InviteID != "inv-1" {
		t.Fatalf("inviteId = %#v", users[1].InviteID)
	}
}

func TestCreateInvitePostsTheLabel(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || string(body) != `{"label":"小王"}` {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"inviteId":"inv-1","expiresAt":1893456000000,
			"bindUrl":"http://localhost:8787/members/bind/#x"}`))
	}, "tok")

	invite, err := c.CreateInvite(context.Background(), "小王")
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if invite.InviteID != "inv-1" || invite.ExpiresAt != 1893456000000 {
		t.Fatalf("invite = %#v", invite)
	}
}

func TestSubmitPinMapsAnExhaustedBudget(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/members/invites/inv-1/pin" {
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

func TestMaintenanceMapsToItsCode(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"MAINTENANCE_ACTIVE"}`))
	}, "tok")

	if got := codeOf(t, mustError(c.CancelInvite(context.Background(), "inv-1"))); got != CodeMaintenance {
		t.Fatalf("cancel code = %s", got)
	}
	if got := codeOf(t, mustError2(c.CreateInvite(context.Background(), "小王"))); got != CodeMaintenance {
		t.Fatalf("create code = %s", got)
	}
}

func TestPendingInviteMapsToItsCode(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"INVITE_PENDING"}`))
	}, "tok")

	if got := codeOf(t, mustError2(c.CreateInvite(context.Background(), "小王"))); got != CodeInvitePending {
		t.Fatalf("create code = %s", got)
	}
}

func TestMissingRouteIsUnsupported(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}, "tok")

	if got := codeOf(t, mustError(c.Revoke(context.Background(), "m1"))); got != CodeUnsupported {
		t.Fatalf("code = %s", got)
	}
}

func TestStateKeepsCapabilityStringsInMemory(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"inviteId":"inv-1","label":"小王","status":"pending",
			"stage":"realname","expiresAt":1893456000000,"realnameDeadline":1893455000000,
			"realnameUrl":"https://liteapp.weixin.qq.com/q/x","qrContent":null,"failure":null}`))
	}, "tok")

	state, err := c.InviteState(context.Background(), "inv-1")
	if err != nil {
		t.Fatalf("InviteState: %v", err)
	}
	if state.Stage != "realname" || state.RealnameURL == nil || state.RealnameDeadline == nil {
		t.Fatalf("state = %#v", state)
	}
	if state.QRContent != nil {
		t.Fatalf("qrContent should be absent in the real-name stage")
	}
}

func mustError(err error) error { return err }

func mustError2(_ Invite, err error) error { return err }
