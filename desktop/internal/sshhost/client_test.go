//go:build !windows

package sshhost

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
)

type serverOptions struct {
	password            string
	interactivePassword string
	authorizedKey       ssh.PublicKey
}

type testServer struct {
	listener net.Listener
	config   *ssh.ServerConfig

	mu       sync.Mutex
	commands []string
	running  map[*exec.Cmd]struct{}

	closeOnce sync.Once
	accepting sync.WaitGroup
}

func startServer(t *testing.T, opts serverOptions) (*testServer, domain.HostRef, string) {
	t.Helper()
	return startServerAt(t, "127.0.0.1:0", opts)
}

func startServerAt(t *testing.T, address string, opts serverOptions) (*testServer, domain.HostRef, string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatalf("host signer: %v", err)
	}

	config := &ssh.ServerConfig{}
	if opts.password == "" && opts.interactivePassword == "" && opts.authorizedKey == nil {
		config.NoClientAuth = true
	}
	if opts.interactivePassword != "" {
		config.KeyboardInteractiveCallback = func(_ ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			answers, err := challenge("", "", []string{"Password: "}, []bool{false})
			if err != nil {
				return nil, err
			}
			if len(answers) == 1 && answers[0] == opts.interactivePassword {
				return nil, nil
			}
			return nil, errors.New("password rejected")
		}
	}
	if opts.password != "" {
		config.PasswordCallback = func(_ ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if string(password) == opts.password {
				return nil, nil
			}
			return nil, errors.New("password rejected")
		}
	}
	if opts.authorizedKey != nil {
		config.PublicKeyCallback = func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), opts.authorizedKey.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("key rejected")
		}
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("listen %s: %v", address, err)
	}
	server := &testServer{
		listener: listener,
		config:   config,
		running:  map[*exec.Cmd]struct{}{},
	}
	server.accepting.Add(1)
	go server.serve()
	t.Cleanup(server.Close)

	tcp := listener.Addr().(*net.TCPAddr)
	host := domain.HostRef{
		Address: tcp.IP.String(),
		Port:    tcp.Port,
		User:    "tester",
		Dir:     "~/deskwand",
	}
	return server, host, ssh.FingerprintSHA256(hostSigner.PublicKey())
}

func (s *testServer) serve() {
	defer s.accepting.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handleConn(conn)
	}
}

func (s *testServer) handleConn(conn net.Conn) {
	defer conn.Close()
	_, channels, requests, err := ssh.NewServerConn(conn, s.config)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			newChannel.Reject(ssh.UnknownChannelType, "unsupported channel")
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			return
		}
		go s.handleSession(channel, channelRequests)
	}
}

func (s *testServer) handleSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	for request := range requests {
		if request.Type != "exec" {
			request.Reply(false, nil)
			continue
		}
		var payload struct{ Command string }
		ssh.Unmarshal(request.Payload, &payload)
		s.mu.Lock()
		s.commands = append(s.commands, payload.Command)
		s.mu.Unlock()
		request.Reply(true, nil)
		go s.runCommand(channel, payload.Command)
	}
}

func (s *testServer) runCommand(channel ssh.Channel, command string) {
	cmd := exec.Command("sh", "-c", command)
	cmd.Stdin = channel
	cmd.Stdout = channel
	cmd.Stderr = channel.Stderr()
	s.mu.Lock()
	s.running[cmd] = struct{}{}
	s.mu.Unlock()
	err := cmd.Run()
	s.mu.Lock()
	delete(s.running, cmd)
	s.mu.Unlock()

	status := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			status = exitErr.ExitCode()
		} else {
			status = 1
		}
	}
	channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(status)}))
	channel.Close()
}

func (s *testServer) recordedCommands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...)
}

func (s *testServer) Close() {
	s.closeOnce.Do(func() {
		s.listener.Close()
		s.accepting.Wait()
		s.mu.Lock()
		defer s.mu.Unlock()
		for cmd := range s.running {
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
		}
	})
}

func (s *testServer) Address() string {
	return s.listener.Addr().String()
}

func writePrivateKey(t *testing.T, path string, passphrase string) ssh.PublicKey {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate client key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	var block *pem.Block
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(private, "")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(private, "", []byte(passphrase))
	}
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatalf("write private key: %v", err)
	}
	return signer.PublicKey()
}

func trustHost(t *testing.T, client *Client, fingerprint string) {
	t.Helper()
	got, known, err := client.Probe(context.Background())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if known {
		t.Fatalf("probe known = true for a fresh known_hosts")
	}
	if got != fingerprint {
		t.Fatalf("fingerprint = %s, want %s", got, fingerprint)
	}
	if err := client.Trust(got); err != nil {
		t.Fatalf("trust: %v", err)
	}
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var domainErr domain.Error
	if !errors.As(err, &domainErr) {
		t.Fatalf("error = %v, want domain.Error with code %s", err, code)
	}
	if domainErr.Code != code {
		t.Fatalf("error code = %s, want %s (%v)", domainErr.Code, code, err)
	}
}

func TestProbeThenTrustThenRun(t *testing.T) {
	_, host, fingerprint := startServer(t, serverOptions{password: "correct horse"})
	host.Auth = domain.SSHAuthPassword
	creds := platform.NewMemoryCredentialStore()
	if err := StoreSecret(context.Background(), creds, host, "correct horse"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	known := filepath.Join(t.TempDir(), "known_hosts")
	client := New(host, creds, known)

	got, knownHost, err := client.Probe(context.Background())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if got != fingerprint || knownHost {
		t.Fatalf("probe = (%s, %t), want (%s, false)", got, knownHost, fingerprint)
	}

	if _, err := client.Run(context.Background(), "printf hi", nil); err == nil {
		t.Fatal("Run before Trust succeeded")
	} else {
		requireCode(t, err, domain.SSH_HOST_KEY_UNKNOWN)
	}

	if err := client.Trust(fingerprint); err != nil {
		t.Fatalf("trust: %v", err)
	}
	got, knownHost, err = client.Probe(context.Background())
	if err != nil {
		t.Fatalf("probe after trust: %v", err)
	}
	if got != fingerprint || !knownHost {
		t.Fatalf("probe = (%s, %t), want (%s, true)", got, knownHost, fingerprint)
	}

	result, err := client.Run(context.Background(), "printf hi; exit 3", nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if string(result.Stdout) != "hi" || result.ExitCode != 3 {
		t.Fatalf("run = %q exit %d, want \"hi\" exit 3", result.Stdout, result.ExitCode)
	}
}

func TestTrustRejectsMismatchedFingerprint(t *testing.T) {
	_, host, _ := startServer(t, serverOptions{})
	known := filepath.Join(t.TempDir(), "known_hosts")
	client := New(host, nil, known)
	if _, _, err := client.Probe(context.Background()); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := client.Trust("SHA256:bogus"); err == nil {
		t.Fatal("Trust with a mismatched fingerprint succeeded")
	}
	data, err := os.ReadFile(known)
	if err == nil && strings.TrimSpace(string(data)) != "" {
		t.Fatalf("known_hosts after rejected trust = %q, want empty", data)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read known_hosts: %v", err)
	}
}

func TestHostKeyChangeIsRefused(t *testing.T) {
	first, host, firstFingerprint := startServer(t, serverOptions{password: "pw"})
	host.Auth = domain.SSHAuthPassword
	creds := platform.NewMemoryCredentialStore()
	if err := StoreSecret(context.Background(), creds, host, "pw"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	known := filepath.Join(t.TempDir(), "known_hosts")
	client := New(host, creds, known)
	trustHost(t, client, firstFingerprint)

	address := first.Address()
	first.Close()
	_, hostAgain, secondFingerprint := startServerAt(t, address, serverOptions{password: "pw"})
	if secondFingerprint == firstFingerprint {
		t.Fatal("the replacement server reused the first host key")
	}
	hostAgain.Auth = host.Auth
	hostAgain.Dir = host.Dir
	client = New(hostAgain, creds, known)

	if _, _, err := client.Probe(context.Background()); err == nil {
		t.Fatal("Probe accepted a changed host key")
	} else {
		requireCode(t, err, domain.SSH_HOST_KEY_CHANGED)
	}
	if _, err := client.Run(context.Background(), "true", nil); err == nil {
		t.Fatal("Run accepted a changed host key")
	} else {
		requireCode(t, err, domain.SSH_HOST_KEY_CHANGED)
	}
}

func TestPasswordAuth(t *testing.T) {
	t.Run("correct", func(t *testing.T) {
		_, host, fingerprint := startServer(t, serverOptions{password: "right"})
		host.Auth = domain.SSHAuthPassword
		creds := platform.NewMemoryCredentialStore()
		if err := StoreSecret(context.Background(), creds, host, "right"); err != nil {
			t.Fatalf("store secret: %v", err)
		}
		client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err != nil {
			t.Fatalf("run: %v", err)
		}
	})

	t.Run("wrong", func(t *testing.T) {
		_, host, fingerprint := startServer(t, serverOptions{password: "right"})
		host.Auth = domain.SSHAuthPassword
		creds := platform.NewMemoryCredentialStore()
		if err := StoreSecret(context.Background(), creds, host, "wrong"); err != nil {
			t.Fatalf("store secret: %v", err)
		}
		client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err == nil {
			t.Fatal("run with a wrong password succeeded")
		} else {
			requireCode(t, err, domain.SSH_AUTH_FAILED)
		}
	})

	t.Run("missing", func(t *testing.T) {
		_, host, fingerprint := startServer(t, serverOptions{password: "right"})
		host.Auth = domain.SSHAuthPassword
		creds := platform.NewMemoryCredentialStore()
		client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err == nil {
			t.Fatal("run without a stored password succeeded")
		} else {
			requireCode(t, err, domain.SSH_AUTH_FAILED)
		}
	})
}

func TestKeyAuth(t *testing.T) {
	t.Run("unencrypted", func(t *testing.T) {
		dir := t.TempDir()
		keyPath := filepath.Join(dir, "id_test")
		public := writePrivateKey(t, keyPath, "")
		_, host, fingerprint := startServer(t, serverOptions{authorizedKey: public})
		host.Auth, host.KeyPath = domain.SSHAuthKey, keyPath
		client := New(host, platform.NewMemoryCredentialStore(), filepath.Join(dir, "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err != nil {
			t.Fatalf("run: %v", err)
		}
	})

	t.Run("encrypted with passphrase", func(t *testing.T) {
		dir := t.TempDir()
		keyPath := filepath.Join(dir, "id_test")
		public := writePrivateKey(t, keyPath, "open sesame")
		_, host, fingerprint := startServer(t, serverOptions{authorizedKey: public})
		host.Auth, host.KeyPath = domain.SSHAuthKey, keyPath
		creds := platform.NewMemoryCredentialStore()
		if err := StoreSecret(context.Background(), creds, host, "open sesame"); err != nil {
			t.Fatalf("store secret: %v", err)
		}
		client := New(host, creds, filepath.Join(dir, "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err != nil {
			t.Fatalf("run: %v", err)
		}
	})

	t.Run("encrypted without passphrase", func(t *testing.T) {
		dir := t.TempDir()
		keyPath := filepath.Join(dir, "id_test")
		public := writePrivateKey(t, keyPath, "open sesame")
		_, host, fingerprint := startServer(t, serverOptions{authorizedKey: public})
		host.Auth, host.KeyPath = domain.SSHAuthKey, keyPath
		client := New(host, platform.NewMemoryCredentialStore(), filepath.Join(dir, "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err == nil {
			t.Fatal("run with an encrypted key and no passphrase succeeded")
		} else {
			requireCode(t, err, domain.SSH_AUTH_FAILED)
		}
	})

	t.Run("missing key file", func(t *testing.T) {
		dir := t.TempDir()
		_, host, fingerprint := startServer(t, serverOptions{})
		host.Auth, host.KeyPath = domain.SSHAuthKey, filepath.Join(dir, "missing")
		client := New(host, platform.NewMemoryCredentialStore(), filepath.Join(dir, "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err == nil {
			t.Fatal("run with a missing key file succeeded")
		} else {
			requireCode(t, err, domain.SSH_AUTH_FAILED)
		}
	})

	t.Run("home relative path", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		keyPath := filepath.Join(home, "id_test")
		public := writePrivateKey(t, keyPath, "")
		_, host, fingerprint := startServer(t, serverOptions{authorizedKey: public})
		host.Auth, host.KeyPath = domain.SSHAuthKey, "~/id_test"
		client := New(host, platform.NewMemoryCredentialStore(), filepath.Join(home, "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err != nil {
			t.Fatalf("run: %v", err)
		}
	})

	t.Run("unparsable key", func(t *testing.T) {
		dir := t.TempDir()
		keyPath := filepath.Join(dir, "id_test")
		if err := os.WriteFile(keyPath, []byte("not a key"), 0o600); err != nil {
			t.Fatalf("write key: %v", err)
		}
		_, host, fingerprint := startServer(t, serverOptions{})
		host.Auth, host.KeyPath = domain.SSHAuthKey, keyPath
		client := New(host, platform.NewMemoryCredentialStore(), filepath.Join(dir, "known_hosts"))
		trustHost(t, client, fingerprint)
		if _, err := client.Run(context.Background(), "true", nil); err == nil {
			t.Fatal("run with an unparsable key succeeded")
		} else {
			requireCode(t, err, domain.SSH_AUTH_FAILED)
		}
	})
}

func TestUnreachable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	address := listener.Addr().(*net.TCPAddr)
	listener.Close()

	host := domain.HostRef{
		Address: address.IP.String(),
		Port:    address.Port,
		User:    "tester",
		Auth:    domain.SSHAuthPassword,
		Dir:     "~/deskwand",
	}
	creds := platform.NewMemoryCredentialStore()
	if err := StoreSecret(context.Background(), creds, host, "pw"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
	if _, err := client.Run(context.Background(), "true", nil); err == nil {
		t.Fatal("run against a closed port succeeded")
	} else {
		requireCode(t, err, domain.SSH_UNREACHABLE)
	}
}

func TestContextCancelStopsRun(t *testing.T) {
	_, host, fingerprint := startServer(t, serverOptions{password: "pw"})
	host.Auth = domain.SSHAuthPassword
	creds := platform.NewMemoryCredentialStore()
	if err := StoreSecret(context.Background(), creds, host, "pw"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
	trustHost(t, client, fingerprint)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := client.Run(ctx, "sleep 30", nil)
	if err == nil {
		t.Fatal("run after cancellation succeeded")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("run returned after %s, want under 1s", elapsed)
	}
}

func TestWriteFileAtomicAndReadFile(t *testing.T) {
	server, host, fingerprint := startServer(t, serverOptions{password: "pw"})
	host.Auth = domain.SSHAuthPassword
	creds := platform.NewMemoryCredentialStore()
	if err := StoreSecret(context.Background(), creds, host, "pw"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
	trustHost(t, client, fingerprint)

	dir := t.TempDir()
	path := filepath.Join(dir, "app.env")
	const secret = "secret-value"
	if err := client.WriteFileAtomic(context.Background(), path, []byte(secret), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read local file: %v", err)
	}
	if string(data) != secret {
		t.Fatalf("file content = %q, want %q", data, secret)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode = %o, want 600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}

	read, err := client.ReadFile(context.Background(), path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(read) != secret {
		t.Fatalf("remote read = %q, want %q", read, secret)
	}
	if _, err := client.ReadFile(context.Background(), filepath.Join(dir, "missing")); !errors.Is(err, ErrNotExist) {
		t.Fatalf("read missing = %v, want ErrNotExist", err)
	}
	for _, command := range server.recordedCommands() {
		if strings.Contains(command, secret) {
			t.Fatalf("command leaked the file content: %s", command)
		}
	}
}

func TestQuotePath(t *testing.T) {
	cases := map[string]string{
		"~/deskwand": `"$HOME"/'deskwand'`,
		"/srv/bot":   `'/srv/bot'`,
		"~":          `'~'`,
	}
	for path, want := range cases {
		if got := QuotePath(path); got != want {
			t.Errorf("QuotePath(%q) = %s, want %s", path, got, want)
		}
	}
}

func TestForgetRemovesCredentialAndHostLine(t *testing.T) {
	ctx := context.Background()
	creds := platform.NewMemoryCredentialStore()
	known := filepath.Join(t.TempDir(), "known_hosts")

	_, hostA, fingerprintA := startServer(t, serverOptions{password: "pw"})
	hostA.Auth = domain.SSHAuthPassword
	if err := StoreSecret(ctx, creds, hostA, "pw"); err != nil {
		t.Fatalf("store secret A: %v", err)
	}
	clientA := New(hostA, creds, known)
	trustHost(t, clientA, fingerprintA)

	_, hostB, fingerprintB := startServer(t, serverOptions{password: "pw"})
	hostB.Auth = domain.SSHAuthPassword
	if err := StoreSecret(ctx, creds, hostB, "pw"); err != nil {
		t.Fatalf("store secret B: %v", err)
	}
	clientB := New(hostB, creds, known)
	trustHost(t, clientB, fingerprintB)

	if err := Forget(ctx, creds, known, hostA); err != nil {
		t.Fatalf("forget: %v", err)
	}
	if _, err := creds.Get(ctx, CredentialKey(hostA)); !errors.Is(err, platform.ErrCredentialNotFound) {
		t.Fatalf("credential A still present: %v", err)
	}
	data, err := os.ReadFile(known)
	if err != nil {
		t.Fatalf("read known_hosts: %v", err)
	}
	lines := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines++
		fields := strings.Fields(line)
		if fields[0] != fmt.Sprintf("[%s]:%d", hostB.Address, hostB.Port) {
			t.Fatalf("unexpected known_hosts line after forget: %s", line)
		}
	}
	if lines != 1 {
		t.Fatalf("known_hosts has %d lines, want 1", lines)
	}
	if _, err := creds.Get(ctx, CredentialKey(hostB)); err != nil {
		t.Fatalf("credential B missing: %v", err)
	}
}

func TestPasswordAuthOverKeyboardInteractive(t *testing.T) {
	_, host, fingerprint := startServer(t, serverOptions{interactivePassword: "right"})
	host.Auth = domain.SSHAuthPassword
	creds := platform.NewMemoryCredentialStore()
	if err := StoreSecret(context.Background(), creds, host, "right"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
	trustHost(t, client, fingerprint)
	if _, err := client.Run(context.Background(), "true", nil); err != nil {
		t.Fatalf("run: %v", err)
	}
}

func TestDialClientReturnsAConnectionTheCallerOwns(t *testing.T) {
	_, host, fingerprint := startServer(t, serverOptions{password: "right"})
	host.Auth = domain.SSHAuthPassword
	creds := platform.NewMemoryCredentialStore()
	if err := StoreSecret(context.Background(), creds, host, "right"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	client := New(host, creds, filepath.Join(t.TempDir(), "known_hosts"))
	trustHost(t, client, fingerprint)

	conn, err := client.DialClient(context.Background())
	if err != nil {
		t.Fatalf("DialClient: %v", err)
	}
	session, err := conn.NewSession()
	if err != nil {
		conn.Close()
		t.Fatalf("new session: %v", err)
	}
	_ = session.Close()
	if err := conn.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}
