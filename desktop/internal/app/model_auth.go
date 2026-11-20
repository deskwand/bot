package app

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/modelauth"
)

// subscriptionProvider is the one provider whose credential is an OAuth
// subscription login. A second one would make these methods take a provider.
const subscriptionProvider = "openai-codex"

// Login methods: the browser flow is the default because enterprise
// workspaces can disable the device-code grant; the device code stays for
// headless hosts where no loopback callback is possible.
const (
	loginMethodBrowser = "browser"
	loginMethodDevice  = "device"
)

var (
	// browserLoginPort is fixed: it is the loopback callback registered
	// against the public Codex client, and the one Codex CLI uses. Tests point
	// it somewhere free.
	browserLoginPort = 1455
	// browserLoginTimeout bounds how long the desktop waits for the browser.
	browserLoginTimeout = 5 * time.Minute
)

// pendingLogin is a started login. Both one-time secrets (the device handle,
// the PKCE verifier) stay in Go and never reach the webview.
type pendingLogin struct {
	method       string
	deviceAuthID string
	userCode     string
	// Browser flow.
	state    string
	verifier string

	done chan struct{}
	once sync.Once

	// mu guards everything the loopback handler writes and the poll reads.
	mu     sync.Mutex
	code   string
	err    error
	server *http.Server
	timer  *time.Timer
}

func newPendingLogin(method string) *pendingLogin {
	return &pendingLogin{method: method, done: make(chan struct{})}
}

// settle records the outcome exactly once. A second callback, the timer and a
// cancel all race to call this; only the first one counts.
func (p *pendingLogin) settle(code string, err error) bool {
	settled := false
	p.once.Do(func() {
		p.mu.Lock()
		p.code, p.err = code, err
		timer := p.timer
		p.mu.Unlock()
		if timer != nil {
			timer.Stop()
		}
		close(p.done)
		settled = true
	})
	return settled
}

func (p *pendingLogin) result() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.code, p.err
}

func (p *pendingLogin) close() {
	p.mu.Lock()
	server := p.server
	p.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
}

// ModelAuthStatus lists the subscription providers and whether they are signed in.
func (s *Service) ModelAuthStatus() ([]ModelAuthDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return []ModelAuthDTO{}, err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return []ModelAuthDTO{}, safeAppError(err)
	}
	providers, err := client.Status(ctx)
	if err != nil {
		return []ModelAuthDTO{}, s.adminFailure(err)
	}
	out := make([]ModelAuthDTO, 0, len(providers))
	for _, provider := range providers {
		out = append(out, ModelAuthDTO{Provider: provider.ID, Connected: provider.Connected})
	}
	return out, nil
}

// StartModelLogin opens the browser sign-in (authorization code + PKCE) and
// listens on the loopback callback. PollModelLogin reports when it finishes.
func (s *Service) StartModelLogin() (ModelLoginDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ModelLoginDTO{}, err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return ModelLoginDTO{}, safeAppError(err)
	}
	started, err := client.StartBrowser(ctx, subscriptionProvider)
	if err != nil {
		return ModelLoginDTO{}, s.adminFailure(err)
	}
	opener := s.mcpBrowser
	if opener == nil {
		opener = s.browser
	}
	if opener == nil {
		return ModelLoginDTO{}, s.serviceUnavailable()
	}

	// A login still waiting would hold the port; release it before binding so
	// a "port busy" error really means somebody else has it.
	s.modelLoginMu.Lock()
	s.cancelModelLoginLocked()
	s.modelLoginMu.Unlock()

	listeners, err := listenBrowserCallback()
	if err != nil {
		return ModelLoginDTO{}, domain.Error{
			Code:    CodeServiceUnavailable,
			Message: s.t("app.modelLoginPortBusy", browserLoginPort),
		}
	}

	pending := newPendingLogin(loginMethodBrowser)
	pending.state = started.State
	pending.verifier = started.CodeVerifier

	mux := http.NewServeMux()
	mux.HandleFunc("/auth/callback", func(w http.ResponseWriter, r *http.Request) {
		s.handleBrowserCallback(pending, w, r)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	pending.mu.Lock()
	pending.server = server
	pending.timer = time.AfterFunc(browserLoginTimeout, func() {
		pending.settle("", domain.Error{
			Code:    CodeServiceUnavailable,
			Message: s.t("app.modelLoginTimeout"),
		})
		pending.close()
	})
	pending.mu.Unlock()

	s.modelLoginMu.Lock()
	s.modelLogin = pending
	s.modelLoginMu.Unlock()

	for _, listener := range listeners {
		go func(ln net.Listener) { _ = server.Serve(ln) }(listener)
	}

	if err := opener.Open(started.AuthorizeURL); err != nil {
		s.finishModelLogin(pending)
		return ModelLoginDTO{}, domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.browserOpenFailed")}
	}

	return ModelLoginDTO{
		Method:          loginMethodBrowser,
		VerificationURL: started.AuthorizeURL,
		IntervalSeconds: 2,
	}, nil
}

// StartModelDeviceLogin falls back to the device code for workspaces that
// allow it, or for hosts where nothing can receive the loopback callback.
func (s *Service) StartModelDeviceLogin() (ModelLoginDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return ModelLoginDTO{}, err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return ModelLoginDTO{}, safeAppError(err)
	}
	login, err := client.Start(ctx, subscriptionProvider)
	if err != nil {
		return ModelLoginDTO{}, s.adminFailure(err)
	}

	pending := newPendingLogin(loginMethodDevice)
	pending.deviceAuthID = login.DeviceAuthID
	pending.userCode = login.UserCode

	s.modelLoginMu.Lock()
	s.cancelModelLoginLocked()
	s.modelLogin = pending
	s.modelLoginMu.Unlock()

	opener := s.mcpBrowser
	if opener == nil {
		opener = s.browser
	}
	if opener == nil {
		return ModelLoginDTO{}, s.serviceUnavailable()
	}
	if err := opener.Open(login.VerificationURL); err != nil {
		s.finishModelLogin(s.pendingModelLogin())
		return ModelLoginDTO{}, domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.browserOpenFailed")}
	}

	return ModelLoginDTO{
		Method:          loginMethodDevice,
		UserCode:        login.UserCode,
		VerificationURL: login.VerificationURL,
		IntervalSeconds: login.IntervalSeconds,
	}, nil
}

// handleBrowserCallback settles the pending login. Only a GET carrying the
// state this desktop issued may do so: a stray request (a page refresh, an
// image tag on some other page) gets a 400 and the login keeps waiting.
func (s *Service) handleBrowserCallback(
	pending *pendingLogin,
	w http.ResponseWriter,
	r *http.Request,
) {
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query()
	code := query.Get("code")
	state := query.Get("state")
	failure := query.Get("error_description")
	if failure == "" {
		failure = query.Get("error")
	}

	if state != pending.state {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("<!doctype html><meta charset=\"utf-8\"><p>" +
			s.t("app.modelLoginCallbackFailed") + "</p>"))
		return
	}

	if failure != "" || code == "" {
		pending.settle("", domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.modelLoginDenied")})
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("<!doctype html><meta charset=\"utf-8\"><p>" +
			s.t("app.modelLoginCallbackFailed") + "</p>"))
		return
	}

	// The listener stays up until the poll collects this result, so a refresh
	// of the callback page is answered instead of refused. settle is a no-op
	// the second time.
	pending.settle(code, nil)
	_, _ = w.Write([]byte("<!doctype html><meta charset=\"utf-8\"><p>" +
		s.t("app.modelLoginCallbackPage") + "</p>"))
}

// PollModelLogin reports the state of the started login: pending, slow_down
// or done. The browser flow reads its own loopback result here.
func (s *Service) PollModelLogin() (string, error) {
	pending := s.pendingModelLogin()
	if pending == nil {
		return "", domain.Error{Code: CodeServiceUnavailable, Message: s.t("app.modelLoginNotStarted")}
	}

	if pending.method == loginMethodBrowser {
		select {
		case <-pending.done:
		default:
			return "pending", nil
		}
		code, browserErr := pending.result()
		if browserErr != nil {
			// Release the listener; a retry re-binds it.
			s.finishModelLogin(pending)
			return "", browserErr
		}
		ctx := context.Background()
		target, err := s.managedTarget(ctx)
		if err != nil {
			return "", err
		}
		client, err := s.modelAuthClient(ctx, target)
		if err != nil {
			return "", safeAppError(err)
		}
		if err := client.CompleteBrowser(ctx, subscriptionProvider, code, pending.verifier, pending.state); err != nil {
			return "", s.adminFailure(err)
		}
		s.finishModelLogin(pending)
		return "done", nil
	}

	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return "", err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return "", safeAppError(err)
	}
	result, err := client.Poll(ctx, subscriptionProvider, pending.deviceAuthID, pending.userCode)
	if err != nil {
		return "", s.adminFailure(err)
	}
	if result.Status == "done" {
		s.finishModelLogin(pending)
	}
	return result.Status, nil
}

// CancelModelLogin stops a login that is still waiting for the browser. It is
// safe to call when nothing is pending.
func (s *Service) CancelModelLogin() error {
	s.modelLoginMu.Lock()
	defer s.modelLoginMu.Unlock()
	s.cancelModelLoginLocked()
	return nil
}

func (s *Service) pendingModelLogin() *pendingLogin {
	s.modelLoginMu.Lock()
	defer s.modelLoginMu.Unlock()
	return s.modelLogin
}

// finishModelLogin clears the pending login only if it is still the one the
// caller owns, so a cancelled-then-restarted login is not forgotten.
func (s *Service) finishModelLogin(pending *pendingLogin) {
	s.modelLoginMu.Lock()
	defer s.modelLoginMu.Unlock()
	if s.modelLogin == pending {
		s.cancelModelLoginLocked()
	}
}

// cancelModelLoginLocked drops the pending login, settles it as cancelled and
// releases its listener.
func (s *Service) cancelModelLoginLocked() {
	pending := s.modelLogin
	if pending == nil {
		return
	}
	s.modelLogin = nil
	pending.settle("", domain.Error{
		Code:    CodeServiceUnavailable,
		Message: s.t("app.modelLoginDenied"),
	})
	pending.close()
}

// listenBrowserCallback binds the loopback callback on both address families:
// the redirect names `localhost`, and a browser that picks ::1 must not wait
// for a five-minute timeout.
func listenBrowserCallback() ([]net.Listener, error) {
	addresses := []string{
		fmt.Sprintf("127.0.0.1:%d", browserLoginPort),
		fmt.Sprintf("[::1]:%d", browserLoginPort),
	}
	listeners := make([]net.Listener, 0, len(addresses))
	var firstErr error
	for _, address := range addresses {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		listeners = append(listeners, listener)
	}
	if len(listeners) == 0 {
		return nil, firstErr
	}
	return listeners, nil
}

// DisconnectModel forgets the deployment's subscription credential.
func (s *Service) DisconnectModel() error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.modelAuthClient(ctx, target)
	if err != nil {
		return safeAppError(err)
	}
	if err := client.Disconnect(ctx, subscriptionProvider); err != nil {
		return s.adminFailure(err)
	}
	s.modelLoginMu.Lock()
	s.cancelModelLoginLocked()
	s.modelLoginMu.Unlock()
	return nil
}

func (s *Service) modelAuthClient(ctx context.Context, target domain.Target) (*modelauth.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := modelauth.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}
