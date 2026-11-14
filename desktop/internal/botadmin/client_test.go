package botadmin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const listBody = `{"bots":[{"id":"b1","name":"价格哨兵","createdAt":1893456000000,` +
	`"meta":{"botId":"b1","name":"价格哨兵","mission":"盯着价格","status":"active",` +
	`"nextWakeAt":1893459600000,"defaultIntervalMs":3600000,"currentTaskId":null,` +
	`"consecutiveFailures":2,"wakesDay":"2026-11-14","wakesCount":3,"pendingSteer":[],"earner":false},` +
	`"lastRun":{"taskId":"t1","startedAt":1893456000000,"endedAt":1893456060000,` +
	`"outcome":"completed","summary":"已检查","note":null},"unavailable":false},` +
	`{"id":"b9","name":"孤儿","createdAt":1893456000000,"meta":null,"lastRun":null,"unavailable":false}]}`

func client(t *testing.T, handler http.HandlerFunc, token string) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewClient(server.URL, token, server.Client())
}

func TestListMapsThePayload(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/bots" || r.Header.Get("Authorization") != "Bearer tok" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(listBody))
	}, "tok")

	bots, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(bots) != 2 {
		t.Fatalf("bots = %#v", bots)
	}
	if bots[0].Meta == nil || bots[0].Meta.ConsecutiveFailures != 2 {
		t.Fatalf("meta = %#v", bots[0].Meta)
	}
	if bots[0].Meta.NextWakeAt == nil || *bots[0].Meta.NextWakeAt != 1893459600000 {
		t.Fatalf("nextWakeAt = %#v", bots[0].Meta.NextWakeAt)
	}
	if bots[0].LastRun == nil || bots[0].LastRun.Outcome == nil || *bots[0].LastRun.Outcome != "completed" {
		t.Fatalf("lastRun = %#v", bots[0].LastRun)
	}
	if bots[1].Meta != nil {
		t.Fatalf("orphan meta = %#v", bots[1].Meta)
	}
}

func TestListMapsAuthAndUnsupported(t *testing.T) {
	unauthorized := client(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}, "tok")
	if _, err := unauthorized.List(context.Background()); code(err) != "ADMIN_TOKEN_REJECTED" {
		t.Fatalf("401 code = %q", code(err))
	}

	old := client(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}, "tok")
	if _, err := old.List(context.Background()); code(err) != CodeUnsupported {
		t.Fatalf("404 code = %q", code(err))
	}
}

func TestDetailSeparatesNotFoundFromUnsupported(t *testing.T) {
	missing := client(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"BOTS_NOT_FOUND"}`))
	}, "tok")
	if _, err := missing.Detail(context.Background(), "b9"); code(err) != CodeNotFound {
		t.Fatalf("not found code = %q", code(err))
	}

	old := client(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}, "tok")
	if _, err := old.Detail(context.Background(), "b1"); code(err) != CodeUnsupported {
		t.Fatalf("unsupported code = %q", code(err))
	}
}

func TestDetailMapsDocsAndRuns(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/bots/b1" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"meta":{"botId":"b1","name":"价格哨兵","mission":"m","status":"paused",` +
			`"nextWakeAt":null,"defaultIntervalMs":3600000,"currentTaskId":null,"consecutiveFailures":0,` +
			`"wakesDay":null,"wakesCount":0,"pendingSteer":[]},` +
			`"docs":[{"name":"守则","content":"只读"}],"runs":[]}`))
	}, "tok")

	detail, err := c.Detail(context.Background(), "b1")
	if err != nil {
		t.Fatalf("Detail: %v", err)
	}
	if detail.Meta == nil || detail.Meta.Status != "paused" || detail.Meta.NextWakeAt != nil {
		t.Fatalf("meta = %#v", detail.Meta)
	}
	if len(detail.Docs) != 1 || detail.Docs[0].Name != "守则" {
		t.Fatalf("docs = %#v", detail.Docs)
	}
	if detail.Runs == nil {
		t.Fatal("runs must be an empty slice, never nil")
	}
}

func TestFailureAndBadJSONMapToReadFailed(t *testing.T) {
	broken := client(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"BOTS_READ_FAILED"}`))
	}, "tok")
	if _, err := broken.List(context.Background()); code(err) != CodeRequestFailed {
		t.Fatalf("503 code = %q", code(err))
	}

	garbage := client(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{`))
	}, "tok")
	if _, err := garbage.List(context.Background()); code(err) != CodeRequestFailed {
		t.Fatalf("bad json code = %q", code(err))
	}
}

func TestErrorDoesNotEchoTheResponseBody(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":"X","message":"boom tok"}`))
	}, "tok")
	_, err := c.List(context.Background())
	if err == nil {
		t.Fatal("List must fail on 500")
	}
	if strings.Contains(err.Error(), "boom") {
		t.Fatalf("the fixed message must not echo the body: %v", err)
	}
	if !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("the message should name the status: %v", err)
	}
}

func code(err error) string {
	var domainErr domain.Error
	if errors.As(err, &domainErr) {
		return domainErr.Code
	}
	return ""
}
