package app

import (
	"net/http"
	"testing"
)

func TestBotsMapsTheWorkerPayload(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/admin/bots" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"bots":[{"id":"b1","name":"价格哨兵","createdAt":1893456000000,` +
			`"meta":{"botId":"b1","name":"价格哨兵","mission":"盯着价格","status":"active",` +
			`"nextWakeAt":1893459600000,"defaultIntervalMs":3600000,"currentTaskId":"t1",` +
			`"consecutiveFailures":2,"wakesDay":"2026-11-14","wakesCount":3,"pendingSteer":[],"earner":true},` +
			`"lastRun":{"taskId":"t1","startedAt":1893456000000,"endedAt":1893456060000,` +
			`"outcome":"completed","summary":"已检查","note":null},"unavailable":false},` +
			`{"id":"b9","name":"孤儿","createdAt":1893456000000,"meta":null,"lastRun":null,"unavailable":true}]}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	bots, err := fixture.service.Bots()
	if err != nil {
		t.Fatalf("Bots: %v", err)
	}
	if len(bots.Bots) != 2 {
		t.Fatalf("bots = %#v", bots)
	}
	first := bots.Bots[0]
	if first.ID != "b1" || first.Meta == nil || first.Meta.Status != "active" {
		t.Fatalf("first = %#v", first)
	}
	if first.Meta.ConsecutiveFailures != 2 || !first.Meta.Earner {
		t.Fatalf("meta = %#v", first.Meta)
	}
	if first.Meta.NextWakeAt == nil || *first.Meta.NextWakeAt != 1893459600000 {
		t.Fatalf("nextWakeAt = %#v", first.Meta.NextWakeAt)
	}
	if first.LastRun == nil || first.LastRun.Outcome == nil || *first.LastRun.Outcome != "completed" {
		t.Fatalf("lastRun = %#v", first.LastRun)
	}
	if bots.Bots[1].Meta != nil || !bots.Bots[1].Unavailable {
		t.Fatalf("orphan = %#v", bots.Bots[1])
	}
}

func TestBotsNeverReturnsNilSlices(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"bots":[]}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	bots, err := fixture.service.Bots()
	if err != nil {
		t.Fatalf("Bots: %v", err)
	}
	if bots.Bots == nil {
		t.Fatal("Bots must be an empty slice, never nil")
	}
}

func TestBotsSurfacesUnsupported(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	_, err := fixture.service.Bots()
	if err == nil || !hasCode(err, "BOTS_UNSUPPORTED") {
		t.Fatalf("err = %v", err)
	}
}

func TestBotDetailSeparatesNotFound(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"BOTS_NOT_FOUND"}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	_, err := fixture.service.BotDetail("b9")
	if err == nil || !hasCode(err, "BOTS_NOT_FOUND") {
		t.Fatalf("err = %v", err)
	}
}

func TestBotDetailMapsDocsAndRuns(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/bots/b1" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"meta":{"botId":"b1","name":"价格哨兵","mission":"m","status":"paused",` +
			`"nextWakeAt":null,"defaultIntervalMs":3600000,"currentTaskId":null,"consecutiveFailures":0,` +
			`"wakesDay":null,"wakesCount":0,"pendingSteer":[]},` +
			`"docs":[{"name":"守则","content":"只读"}],"runs":[]}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	detail, err := fixture.service.BotDetail("b1")
	if err != nil {
		t.Fatalf("BotDetail: %v", err)
	}
	if detail.Meta == nil || detail.Meta.Status != "paused" || detail.Meta.NextWakeAt != nil {
		t.Fatalf("meta = %#v", detail.Meta)
	}
	if len(detail.Docs) != 1 || detail.Docs[0].Name != "守则" {
		t.Fatalf("docs = %#v", detail.Docs)
	}
	if detail.Runs == nil {
		t.Fatal("Runs must be an empty slice, never nil")
	}
}
