//go:build !windows

package sshtunnel

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// forwardServer is a tiny sshd that answers direct-tcpip channels by dialing
// AdminAddr. It is the smallest thing that behaves like a real host.
type forwardServer struct {
	listener net.Listener

	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

func startForwardServer(t *testing.T) (*forwardServer, domain.HostRef) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatalf("host signer: %v", err)
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &forwardServer{listener: listener, conns: map[net.Conn]struct{}{}}
	go server.serve(config)
	t.Cleanup(server.stop)

	tcp := listener.Addr().(*net.TCPAddr)
	return server, domain.HostRef{
		Address: tcp.IP.String(),
		Port:    tcp.Port,
		User:    "tester",
		Dir:     "~/deskwand",
	}
}

func (s *forwardServer) serve(config *ssh.ServerConfig) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		go func() {
			defer func() {
				s.mu.Lock()
				delete(s.conns, conn)
				s.mu.Unlock()
			}()
			serveForwardConn(conn, config)
		}()
	}
}

// stop kills the listener and every live connection, the way a reboot or a
// dropped network would.
func (s *forwardServer) stop() {
	_ = s.listener.Close()
	s.mu.Lock()
	defer s.mu.Unlock()
	for conn := range s.conns {
		_ = conn.Close()
	}
}

func (s *forwardServer) addr() string { return s.listener.Addr().String() }

func serveForwardConn(conn net.Conn, config *ssh.ServerConfig) {
	defer conn.Close()
	_, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "direct-tcpip" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported channel")
			continue
		}
		target, err := net.Dial("tcp", AdminAddr)
		if err != nil {
			_ = newChannel.Reject(ssh.ConnectionFailed, err.Error())
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			_ = target.Close()
			continue
		}
		go ssh.DiscardRequests(channelRequests)
		go func() {
			_, _ = io.Copy(target, channel)
			_ = target.Close()
		}()
		go func() {
			_, _ = io.Copy(channel, target)
			_ = channel.Close()
		}()
	}
}

func dialer(t *testing.T, addr string) Opener {
	t.Helper()
	return func(_ context.Context, _ domain.HostRef) (*ssh.Client, error) {
		return ssh.Dial("tcp", addr, &ssh.ClientConfig{
			User:            "tester",
			HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		})
	}
}

// serveAdmin binds AdminAddr with the given handler and skips the test when
// something else already holds the port (a real container, a leftover tunnel).
func serveAdmin(t *testing.T, body string) {
	t.Helper()
	listener, err := net.Listen("tcp", AdminAddr)
	if err != nil {
		t.Skipf("127.0.0.1:8787 is busy: %v", err)
	}
	backend := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	})}
	go func() { _ = backend.Serve(listener) }()
	t.Cleanup(func() { _ = backend.Close() })
}

func TestOpenForwardsToTheAdminPort(t *testing.T) {
	serveAdmin(t, "ok")

	server, host := startForwardServer(t)
	manager := NewAt("127.0.0.1:0", dialer(t, server.addr()))
	t.Cleanup(manager.Close)

	baseURL, err := manager.Open(context.Background(), host)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !manager.Established() {
		t.Fatal("Established() = false after Open")
	}
	response, err := http.Get(baseURL + "/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response.Body.Close()
	got, _ := io.ReadAll(response.Body)
	if string(got) != "ok" {
		t.Fatalf("body = %q, want ok", got)
	}
}

func TestOpenReportsAPortInUse(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer busy.Close()

	server, host := startForwardServer(t)
	manager := NewAt(busy.Addr().String(), dialer(t, server.addr()))
	t.Cleanup(manager.Close)

	if _, err := manager.Open(context.Background(), host); !errors.Is(err, ErrPortBusy) {
		t.Fatalf("err = %v, want ErrPortBusy", err)
	}
}

func TestOpenIsIdempotentAndCloseReleasesThePort(t *testing.T) {
	server, host := startForwardServer(t)
	manager := NewAt("127.0.0.1:0", dialer(t, server.addr()))
	t.Cleanup(manager.Close)

	first, err := manager.Open(context.Background(), host)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if again, err := manager.Open(context.Background(), host); err != nil || again != first {
		t.Fatalf("second open = %q, %v; want %q, nil", again, err, first)
	}

	manager.Close()
	if manager.Established() {
		t.Fatal("Established() = true after Close")
	}
	if _, err := manager.Open(context.Background(), host); err != nil {
		t.Fatalf("reopen: %v", err)
	}
}

func TestADeadConnectionIsDroppedSoTheNextOpenRebuilds(t *testing.T) {
	serveAdmin(t, "ok")

	server, host := startForwardServer(t)
	manager := NewAt("127.0.0.1:0", dialer(t, server.addr()))
	t.Cleanup(manager.Close)

	baseURL, err := manager.Open(context.Background(), host)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	// Kill the host under the tunnel. The next request fails, and the tunnel
	// must notice instead of staying "established" forever.
	server.stop()
	if response, err := http.Get(baseURL + "/healthz"); err == nil {
		_ = response.Body.Close()
	}

	deadline := time.Now().Add(2 * time.Second)
	for manager.Established() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if manager.Established() {
		t.Fatal("the tunnel stayed up after its SSH connection died")
	}
	if _, err := manager.Open(context.Background(), host); err == nil {
		t.Fatal("Open against a dead host returned no error")
	}
}
