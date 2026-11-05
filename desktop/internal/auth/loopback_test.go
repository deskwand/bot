package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCallbackPageIsBilingual(t *testing.T) {
	page := callbackPage()
	for _, want := range []string{
		"授权结果已交给 DeskWand Bot，可以关闭这个页面了。",
		"The authorization result has been sent to DeskWand Bot. You can close this page.",
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("callback page is missing %q: %s", want, page)
		}
	}
}

func TestListenLoopbackFallsBackWhenPortIsTaken(t *testing.T) {
	var tried []int
	listen := func(port int) (net.Listener, error) {
		tried = append(tried, port)
		if port == 8756 {
			return nil, errors.New("bind: address already in use")
		}
		return net.Listen("tcp", "127.0.0.1:0")
	}
	ln, port, err := listenLoopback([]int{8756, 8757}, listen)
	if err != nil {
		t.Fatalf("listenLoopback: %v", err)
	}
	defer ln.Close()
	if len(tried) != 2 || tried[0] != 8756 || tried[1] != 8757 {
		t.Fatalf("tried = %v, want the first two ports in order", tried)
	}
	if address, ok := ln.Addr().(*net.TCPAddr); !ok || port != address.Port {
		t.Fatalf("port = %d, want the port actually bound", port)
	}
}

func TestListenLoopbackReportsBusyPorts(t *testing.T) {
	listen := func(int) (net.Listener, error) { return nil, errors.New("address already in use") }
	_, _, err := listenLoopback([]int{8756, 8757}, listen)
	if Code(err) != ErrCodeOAuthPortBusy {
		t.Fatalf("code = %q, want %q", Code(err), ErrCodeOAuthPortBusy)
	}
}

func TestAwaitCallbackDeliversCodeAndState(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	type answer struct {
		status int
		body   string
		err    error
	}
	answered := make(chan answer, 1)
	go func() {
		time.Sleep(20 * time.Millisecond)
		resp, err := http.Get(fmt.Sprintf("http://%s/callback?code=CODE&state=STATE", ln.Addr().String()))
		if err != nil {
			answered <- answer{err: err}
			return
		}
		defer resp.Body.Close()
		body, readErr := io.ReadAll(resp.Body)
		answered <- answer{status: resp.StatusCode, body: string(body), err: readErr}
	}()
	outcome, err := awaitCallback(context.Background(), ln)
	if err != nil {
		t.Fatalf("awaitCallback: %v", err)
	}
	if outcome.Code != "CODE" || outcome.State != "STATE" {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
	// The browser must receive the whole page, not a connection reset.
	page := <-answered
	if page.err != nil {
		t.Fatalf("the callback response was truncated: %v", page.err)
	}
	if page.status != http.StatusOK || !strings.Contains(page.body, "DeskWand Bot") {
		t.Fatalf("status = %d body = %q, want the completion page", page.status, page.body)
	}
}

func TestAwaitCallbackReportsDenial(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		time.Sleep(20 * time.Millisecond)
		_, _ = http.Get(fmt.Sprintf("http://%s/callback?error=access_denied&error_description=User+said+no", ln.Addr().String()))
	}()
	outcome, err := awaitCallback(context.Background(), ln)
	if err != nil {
		t.Fatalf("awaitCallback: %v", err)
	}
	if outcome.Error != "access_denied" || outcome.ErrorDescription != "User said no" {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
}

func TestAwaitCallbackIgnoresOtherPaths(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		time.Sleep(20 * time.Millisecond)
		resp, err := http.Get(fmt.Sprintf("http://%s/health", ln.Addr().String()))
		if err == nil {
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("status = %d, want 404 for a non-callback path", resp.StatusCode)
			}
			resp.Body.Close()
		}
		_, _ = http.Get(fmt.Sprintf("http://%s/callback?code=CODE&state=STATE", ln.Addr().String()))
	}()
	if _, err := awaitCallback(context.Background(), ln); err != nil {
		t.Fatalf("awaitCallback: %v", err)
	}
}

func TestAwaitCallbackStopsOnContextCancel(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	if _, err := awaitCallback(ctx, ln); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if _, err := http.Get(fmt.Sprintf("http://%s/callback?code=CODE&state=STATE", ln.Addr().String())); err == nil {
		t.Fatal("listener must be closed after the context is cancelled")
	}
}
