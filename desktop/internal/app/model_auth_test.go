package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestModelAuthStatusMapsTheWorkerPayload(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/admin/models/auth" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"providers":[{"id":"openai-codex","connected":true}]}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	status, err := fixture.service.ModelAuthStatus()
	if err != nil {
		t.Fatalf("ModelAuthStatus: %v", err)
	}
	if len(status) != 1 || status[0].Provider != "openai-codex" || !status[0].Connected {
		t.Fatalf("status = %#v", status)
	}
}

func TestStartModelLoginOpensTheVerificationPage(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/models/auth/openai-codex/start" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"deviceAuthId":"device-1","userCode":"ABCD-1234","verificationUrl":"https://auth.openai.com/codex/device","intervalSeconds":5}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	login, err := fixture.service.StartModelLogin()
	if err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}
	if login.UserCode != "ABCD-1234" || login.IntervalSeconds != 5 {
		t.Fatalf("login = %#v", login)
	}
	if len(fixture.browser.opened) != 1 || fixture.browser.opened[0] != "https://auth.openai.com/codex/device" {
		t.Fatalf("opened = %#v", fixture.browser.opened)
	}
	// The handle stays in Go and never appears in the returned DTO.
	if encoded, _ := json.Marshal(login); strings.Contains(string(encoded), "device-1") {
		t.Fatalf("DTO leaked the device handle: %s", encoded)
	}
}

func TestPollModelLoginForwardsTheDevicePair(t *testing.T) {
	var polls int
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/admin/models/auth/openai-codex/start":
			_, _ = w.Write([]byte(`{"deviceAuthId":"device-1","userCode":"ABCD-1234","verificationUrl":"https://auth.openai.com/codex/device","intervalSeconds":5}`))
		case "/admin/models/auth/openai-codex/poll":
			polls++
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["deviceAuthId"] != "device-1" || body["userCode"] != "ABCD-1234" {
				t.Errorf("body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"status":"done"}`))
		default:
			http.NotFound(w, r)
		}
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
	if _, err := fixture.service.StartModelLogin(); err != nil {
		t.Fatalf("StartModelLogin: %v", err)
	}

	status, err := fixture.service.PollModelLogin()
	if err != nil {
		t.Fatalf("PollModelLogin: %v", err)
	}
	if status != "done" || polls != 1 {
		t.Fatalf("status = %q, polls = %d", status, polls)
	}
	// The finished login is forgotten, so a stray poll cannot resurrect it.
	if _, err := fixture.service.PollModelLogin(); err == nil {
		t.Fatal("PollModelLogin after done = nil error, want a failure")
	}
}

func TestPollModelLoginWithoutAStartedLoginFails(t *testing.T) {
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, nil)

	_, err := fixture.service.PollModelLogin()
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v, want a domain.Error", err)
	}
}

func TestModelAuthUnsupportedDeploymentSaysSo(t *testing.T) {
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, http.NotFoundHandler())

	_, err := fixture.service.ModelAuthStatus()
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != "MODEL_AUTH_ADMIN_UNAVAILABLE" {
		t.Fatalf("error = %v, want MODEL_AUTH_ADMIN_UNAVAILABLE", err)
	}
}
