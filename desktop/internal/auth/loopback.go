package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

// LoginTimeout bounds how long a started login waits for the browser.
const LoginTimeout = 5 * time.Minute

type listenerFunc func(port int) (net.Listener, error)

func defaultListen(port int) (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
}

// listenLoopback binds the first free port in ports. It returns the bound
// listener and the port it is really listening on, because the redirect URI
// must name that exact port.
func listenLoopback(ports []int, listen listenerFunc) (net.Listener, int, error) {
	var lastErr error
	for _, port := range ports {
		ln, err := listen(port)
		if err != nil {
			lastErr = err
			continue
		}
		address, ok := ln.Addr().(*net.TCPAddr)
		if !ok {
			_ = ln.Close()
			lastErr = errors.New("auth: callback listener has no TCP address")
			continue
		}
		return ln, address.Port, nil
	}
	return nil, 0, &Error{
		Code:    ErrCodeOAuthPortBusy,
		Message: "every login callback port is in use; close the program holding it and retry",
		Err:     lastErr,
	}
}

// callbackOutcome is what the browser delivered to the loopback listener.
type callbackOutcome struct {
	Code             string
	State            string
	Error            string
	ErrorDescription string
}

const callbackPageHTML = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>DeskWand Bot</title>
<body style="font:16px/1.6 -apple-system,system-ui,sans-serif;padding:48px;color:#111">
<p>授权结果已交给 DeskWand Bot，可以关闭这个页面了。</p>
</body></html>`

// awaitCallback serves exactly one callback request and then closes ln. It
// returns ctx.Err() when the caller gives up first.
func awaitCallback(ctx context.Context, ln net.Listener) (callbackOutcome, error) {
	outcome := make(chan callbackOutcome, 1)
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second}
	mux := http.NewServeMux()
	mux.HandleFunc(callbackPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		values := r.URL.Query()
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, callbackPageHTML)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		// Signal only after the browser has the page: closing the server on
		// the way out must never truncate the response.
		select {
		case outcome <- callbackOutcome{
			Code:             values.Get("code"),
			State:            values.Get("state"),
			Error:            values.Get("error"),
			ErrorDescription: values.Get("error_description"),
		}:
		default:
		}
	})
	server.Handler = mux

	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(ln) }()
	shutdown := func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			_ = server.Close()
		}
	}
	defer shutdown()

	select {
	case received := <-outcome:
		return received, nil
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return callbackOutcome{}, ctx.Err()
		}
		return callbackOutcome{}, fmt.Errorf("auth: callback listener: %w", err)
	case <-ctx.Done():
		return callbackOutcome{}, ctx.Err()
	}
}
