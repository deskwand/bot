// Package sshtunnel forwards one loopback port to the admin port a container
// publishes on an SSH host. MCP's OAuth callback is redirected to
// http://localhost:8787, so a real listener on that port is the only way the
// browser can reach the deployment.
package sshtunnel

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// AdminAddr is where the container serves /admin/* and /healthz, on this
// machine and on the SSH host alike.
const AdminAddr = "127.0.0.1:8787"

// ErrPortBusy reports that the loopback port is already in use. The port is
// not negotiable: the OAuth redirect_uri names it.
var ErrPortBusy = errors.New("sshtunnel: the loopback admin port is in use")

const (
	keepaliveInterval = 30 * time.Second
	// keepaliveTimeout bounds one ping: a black-holed connection parks the
	// reply forever otherwise, and the tunnel would never drop itself.
	keepaliveTimeout = 10 * time.Second
)

// Opener dials one authenticated connection to host. The tunnel owns the
// result and closes it when it stops.
type Opener func(ctx context.Context, host domain.HostRef) (*ssh.Client, error)

// Manager keeps at most one tunnel. Every method is safe for concurrent use.
type Manager struct {
	opener Opener
	addr   string

	mu       sync.Mutex
	listener net.Listener
	client   *ssh.Client
	host     domain.HostRef
}

// New returns a manager that listens on AdminAddr.
func New(opener Opener) *Manager { return NewAt(AdminAddr, opener) }

// NewAt is New with an explicit listen address, for tests.
func NewAt(addr string, opener Opener) *Manager {
	return &Manager{opener: opener, addr: addr}
}

// Open starts the tunnel for host and returns its base URL. Calling it again
// for the same host is a no-op.
func (m *Manager) Open(ctx context.Context, host domain.HostRef) (string, error) {
	m.mu.Lock()
	if m.listener != nil && m.host == host {
		addr := m.listener.Addr().String()
		m.mu.Unlock()
		return "http://" + addr, nil
	}
	m.mu.Unlock()

	// Dial outside the lock: a slow or unreachable host must not block
	// Established() or Close(), which the server page calls.
	client, err := m.opener(ctx, host)
	if err != nil {
		return "", err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.listener != nil && m.host == host {
		// Another caller won the race while this one was dialing.
		_ = client.Close()
		return "http://" + m.listener.Addr().String(), nil
	}
	m.stopLocked()
	listener, err := net.Listen("tcp", m.addr)
	if err != nil {
		_ = client.Close()
		return "", ErrPortBusy
	}
	m.listener, m.client, m.host = listener, client, host
	go m.serve(listener, client)
	go m.keepalive(client)
	return "http://" + listener.Addr().String(), nil
}

// Established reports whether a tunnel is up.
func (m *Manager) Established() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listener != nil
}

// Close stops the tunnel. It is safe to call when none is up.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
}

func (m *Manager) stopLocked() {
	if m.listener != nil {
		_ = m.listener.Close()
	}
	if m.client != nil {
		_ = m.client.Close()
	}
	m.listener, m.client, m.host = nil, nil, domain.HostRef{}
}

func (m *Manager) serve(listener net.Listener, client *ssh.Client) {
	for {
		local, err := listener.Accept()
		if err != nil {
			return
		}
		go m.forward(local, client)
	}
}

func (m *Manager) forward(local net.Conn, client *ssh.Client) {
	remote, err := client.Dial("tcp", AdminAddr)
	if err != nil {
		_ = local.Close()
		m.drop(client)
		return
	}
	go func() {
		_, _ = io.Copy(remote, local)
		_ = remote.Close()
	}()
	_, _ = io.Copy(local, remote)
	_ = local.Close()
}

func (m *Manager) keepalive(client *ssh.Client) {
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	for range ticker.C {
		done := make(chan error, 1)
		go func() {
			_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
			done <- err
		}()
		select {
		case err := <-done:
			if err != nil {
				m.drop(client)
				return
			}
		case <-time.After(keepaliveTimeout):
			// Close first: that unblocks the pending request and any forward
			// stuck in client.Dial, so they can drop the tunnel too.
			_ = client.Close()
			m.drop(client)
			return
		}
	}
}

// drop closes the tunnel that belongs to client so the next Open rebuilds it.
// A keepalive for an already replaced client is ignored.
func (m *Manager) drop(client *ssh.Client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.client != client {
		return
	}
	m.stopLocked()
}
