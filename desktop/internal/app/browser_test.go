package app

import (
	"net/http"
	"testing"
	"time"
)

func browserHandler(t *testing.T, handler http.Handler) *mcpFixture {
	t.Helper()
	return newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)
}

func TestBrowserStatusPassesReasonThrough(t *testing.T) {
	fixture := browserHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"available":false,"reason":"image-too-old"}`))
	}))

	status, err := fixture.service.BrowserStatus()
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if status.Available || status.Reason != "image-too-old" {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestBrowserInputReportsStale(t *testing.T) {
	fixture := browserHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":false,"code":"STALE"}`))
	}))

	ok, err := fixture.service.BrowserInput(1, nil)
	if err != nil {
		t.Fatalf("input failed: %v", err)
	}
	if ok {
		t.Fatal("stale input must not report success")
	}
}

func TestBrowserOpenForwardsTheUrl(t *testing.T) {
	var body string
	fixture := browserHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(buf)
		body = string(buf)
		_, _ = w.Write([]byte(`{"url":"https://a.example","title":"A"}`))
	}))

	opened, err := fixture.service.BrowserOpen("https://a.example")
	if err != nil {
		t.Fatalf("open failed: %v", err)
	}
	if opened.URL != "https://a.example" || opened.Title != "A" {
		t.Fatalf("opened = %#v", opened)
	}
	if body != `{"url":"https://a.example"}` {
		t.Fatalf("body = %s", body)
	}
}

func TestBrowserStreamEmitsFramesAndStops(t *testing.T) {
	fixture := browserHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/browser/mirror" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("event: state\ndata: {\"url\":\"https://a.example\"}\n\nevent: frame\ndata: {\"seq\":1,\"jpeg\":\"/9j/\",\"w\":1280,\"h\":800}\n\nevent: end\ndata: {\"reason\":\"closed\"}\n\n"))
	}))
	frames := make(chan BrowserFrameDTO, 8)
	states := make(chan BrowserStreamDTO, 8)
	fixture.service.emitBrowserFrame = func(frame BrowserFrameDTO) { frames <- frame }
	fixture.service.emitBrowserStream = func(state BrowserStreamDTO) { states <- state }

	if err := fixture.service.BrowserStreamStart(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	frame := <-frames
	if frame.Seq != 1 || frame.JPEG != "/9j/" {
		t.Fatalf("unexpected frame: %+v", frame)
	}
	if state := <-states; state.Kind != "state" || state.URL != "https://a.example" {
		t.Fatalf("unexpected state: %+v", state)
	}
	if end := <-states; end.Kind != "end" || end.Reason != "closed" {
		t.Fatalf("unexpected end: %+v", end)
	}
	fixture.service.BrowserStreamStop()
	if fixture.service.browserTakenOver() {
		t.Fatal("stop must clear the stream")
	}
	// A second start after stop must work again: the page re-opens the panel.
	if err := fixture.service.BrowserStreamStart(); err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	fixture.service.BrowserStreamStop()
}

func TestBrowserStreamFreesItsSlotWhenItEndsByItself(t *testing.T) {
	fixture := browserHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("event: end\ndata: {\"reason\":\"superseded\"}\n\n"))
	}))
	ended := make(chan BrowserStreamDTO, 1)
	fixture.service.emitBrowserStream = func(state BrowserStreamDTO) { ended <- state }

	if err := fixture.service.BrowserStreamStart(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	<-ended
	// The goroutine clears the slot in its own defer, which runs after the
	// handler returns; give it the same goroutine's close to be observed.
	for i := 0; i < 100 && fixture.service.browserTakenOver(); i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if fixture.service.browserTakenOver() {
		t.Fatal("a stream that ended on its own must free the slot")
	}
	if err := fixture.service.BrowserStreamStart(); err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	fixture.service.BrowserStreamStop()
}

func TestBrowserStreamReportsSilenceToThePanel(t *testing.T) {
	fixture := browserHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/browser/mirror" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done() // never sends anything: only the watchdog can end this
	}))
	fixture.service.browserSilentAfter = 100 * time.Millisecond

	ended := make(chan BrowserStreamDTO, 4)
	fixture.service.emitBrowserStream = func(state BrowserStreamDTO) { ended <- state }

	if err := fixture.service.BrowserStreamStart(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	select {
	case state := <-ended:
		if state.Kind != "end" || state.Reason != "silent" {
			t.Fatalf("want end/silent, got %+v", state)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no end event: the panel would sit on a dead frame forever")
	}
	// The watchdog already cancelled it; Stop must still return promptly.
	fixture.service.BrowserStreamStop()
}
