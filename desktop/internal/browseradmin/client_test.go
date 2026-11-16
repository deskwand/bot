package browseradmin

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStreamParsesFramesOfAnySize(t *testing.T) {
	var builder strings.Builder
	builder.WriteString("event: idle\ndata: {}\n\n")
	small := strings.Repeat("A", 15*1024)
	large := strings.Repeat("B", 200*1024)
	builder.WriteString(`event: frame` + "\n" + `data: {"seq":1,"jpeg":"` + small + `","w":1280,"h":800}` + "\n\n")
	builder.WriteString(`event: frame` + "\n" + `data: {"seq":2,"jpeg":"` + large + `","w":1280,"h":800}` + "\n\n")
	builder.WriteString("event: end\ndata: {\"reason\":\"closed\"}\n\n")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte(builder.String()))
	}))
	defer server.Close()

	client := NewClient(server.URL, "t", server.Client())
	var frames []Frame
	var states []StreamState
	err := client.Stream(context.Background(), func(frame Frame) error {
		frames = append(frames, frame)
		return nil
	}, func(state StreamState) error {
		states = append(states, state)
		return nil
	})
	if err != nil {
		t.Fatalf("stream failed: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("want 2 frames, got %d", len(frames))
	}
	if len(frames[1].JPEG) != len(large) {
		t.Fatalf("large frame truncated: %d vs %d", len(frames[1].JPEG), len(large))
	}
	if len(states) != 1 || states[0].Kind != "end" || states[0].Reason != "closed" {
		t.Fatalf("stream states = %#v", states)
	}
}

func TestStatusMapsReasons(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"available":false,"reason":"image-too-old"}`))
	}))
	defer server.Close()

	status, err := NewClient(server.URL, "t", server.Client()).Status(context.Background())
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if status.Available || status.Reason != "image-too-old" {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestTokenNeverAppearsInTheURL(t *testing.T) {
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.String()
		if r.Header.Get("authorization") != "Bearer secret" {
			t.Errorf("token missing from the header: %q", r.Header.Get("authorization"))
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	if err := NewClient(server.URL, "secret", server.Client()).Close(context.Background()); err != nil {
		t.Fatalf("close failed: %v", err)
	}
	if strings.Contains(seen, "secret") {
		t.Fatalf("token leaked into the request url: %s", seen)
	}
}

func TestCancelStopsTheStream(t *testing.T) {
	hold := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		select {
		case <-hold:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(hold)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- NewClient(server.URL, "t", server.Client()).Stream(ctx, func(Frame) error { return nil }, func(StreamState) error { return nil })
	}()
	cancel()
	if err := <-done; err == nil {
		t.Fatal("a cancelled stream must report an error, not a clean EOF")
	}
}

func TestStreamReturnsErrSilentWhenNothingArrives(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("event: frame\ndata: {\"seq\":1,\"jpeg\":\"AA==\",\"w\":1024,\"h\":640}\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done() // hang until the client gives up
	}))
	defer server.Close()

	client := NewClient(server.URL, "t", server.Client())
	client.SilentAfter = 100 * time.Millisecond

	started := time.Now()
	err := client.Stream(context.Background(), func(Frame) error { return nil }, func(StreamState) error { return nil })
	if !errors.Is(err, ErrSilent) {
		t.Fatalf("want ErrSilent, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("watchdog took %v, want under 2s", elapsed)
	}
}

func TestStreamKeepsAliveOnHeartbeats(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				_, _ = w.Write([]byte("event: idle\ndata: {}\n\n"))
				w.(http.Flusher).Flush()
			}
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "t", server.Client())
	client.SilentAfter = 100 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel) // three watchdog windows, no frame ever

	// Heartbeats alone must hold the stream open: a static page sends no frames.
	if err := client.Stream(ctx, func(Frame) error { return nil }, func(StreamState) error { return nil }); errors.Is(err, ErrSilent) {
		t.Fatal("heartbeats must reset the watchdog")
	}
}

func TestStreamReportsAPeerThatHangsUpWithoutEnding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("event: frame\ndata: {\"seq\":1,\"jpeg\":\"AA==\",\"w\":1024,\"h\":640}\n\n"))
		w.(http.Flusher).Flush()
		// Returning closes the socket like a killed container: the client sees EOF
		// with no end event, and the panel must not keep the last frame forever.
	}))

	client := NewClient(server.URL, "t", server.Client())
	err := client.Stream(context.Background(), func(Frame) error { return nil }, func(StreamState) error { return nil })
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("want io.ErrUnexpectedEOF, got %v", err)
	}
}

func TestStreamReturnsNilWhenTheServerEndsTheStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("event: end\ndata: {\"reason\":\"superseded\"}\n\n"))
	}))

	client := NewClient(server.URL, "t", server.Client())
	if err := client.Stream(context.Background(), func(Frame) error { return nil }, func(StreamState) error { return nil }); err != nil {
		t.Fatalf("an explicit end must read as a clean finish, got %v", err)
	}
}
