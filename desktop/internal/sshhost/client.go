// Package sshhost runs one-shot commands on an SSH host and keeps the host
// key the application trusts for it. Connections are not reused: every
// operation dials, authenticates, runs, and closes.
package sshhost

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/platform"
)

const dialTimeout = 15 * time.Second

// Result is the outcome of a remote command. A nonzero ExitCode is not an
// error; errors mean the transport or authentication failed.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// ErrNotExist reports that a remote path does not exist.
var ErrNotExist = errors.New("sshhost: remote file does not exist")

// Client talks to one host. It is safe to use one Client from one goroutine
// at a time; Probe and Trust share the last probe through a mutex.
type Client struct {
	host           domain.HostRef
	creds          platform.CredentialStore
	knownHostsPath string

	mu                sync.Mutex
	probedKey         ssh.PublicKey
	probedFingerprint string
}

// New returns a client for host. creds may be nil when no credential is
// needed, such as during Probe.
func New(host domain.HostRef, creds platform.CredentialStore, knownHostsPath string) *Client {
	return &Client{host: host, creds: creds, knownHostsPath: knownHostsPath}
}

// CredentialKey names the secret for one host in the credential store.
func CredentialKey(host domain.HostRef) string {
	return fmt.Sprintf("ssh:%s@%s:%d", host.User, host.Address, host.Port)
}

// StoreSecret saves a password or private-key passphrase for host.
func StoreSecret(ctx context.Context, creds platform.CredentialStore, host domain.HostRef, secret string) error {
	if creds == nil {
		return errors.New("sshhost: no credential store")
	}
	return creds.Set(ctx, CredentialKey(host), secret)
}

// Forget removes the stored secret and the host's known_hosts line.
func Forget(ctx context.Context, creds platform.CredentialStore, knownHostsPath string, host domain.HostRef) error {
	var credErr error
	if creds != nil {
		if err := creds.Delete(ctx, CredentialKey(host)); err != nil && !errors.Is(err, platform.ErrCredentialNotFound) {
			credErr = err
		}
	}
	knownErr := removeKnownHost(knownHostsPath, host)
	return errors.Join(credErr, knownErr)
}

// QuotePath turns a validated path into a shell word. A leading "~/" becomes
// the quoted $HOME, so the path is never expanded as a bare word.
func QuotePath(path string) string {
	if path == "~" {
		return "'~'"
	}
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		return `"$HOME"/'` + rest + `'`
	}
	return "'" + path + "'"
}

// Probe performs the key exchange without authenticating. known reports that
// the fingerprint matches the recorded one; a recorded but different key is
// SSH_HOST_KEY_CHANGED.
func (c *Client) Probe(ctx context.Context) (fingerprint string, known bool, err error) {
	var key ssh.PublicKey
	client, handshakeErr := c.connect(ctx, nil, func(_ string, _ net.Addr, presented ssh.PublicKey) error {
		key = presented
		return nil
	})
	if client != nil {
		client.Close()
	}
	if key == nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", false, ctxErr
		}
		if handshakeErr == nil {
			handshakeErr = errors.New("no host key was presented")
		}
		return "", false, unreachableError(handshakeErr)
	}
	fingerprint = ssh.FingerprintSHA256(key)
	recorded, stored, err := readKnownHostFingerprint(c.knownHostsPath, c.host)
	if err != nil {
		return "", false, err
	}
	if stored && recorded != fingerprint {
		return "", false, codedError(domain.SSH_HOST_KEY_CHANGED, "the SSH host key does not match the recorded key")
	}
	c.mu.Lock()
	c.probedKey = key
	c.probedFingerprint = fingerprint
	c.mu.Unlock()
	return fingerprint, stored, nil
}

// Trust records the key seen by the last Probe. A fingerprint that does not
// match that probe writes nothing.
func (c *Client) Trust(fingerprint string) error {
	c.mu.Lock()
	key := c.probedKey
	probed := c.probedFingerprint
	c.mu.Unlock()
	if key == nil {
		return errors.New("sshhost: probe the host before trusting its key")
	}
	if fingerprint != probed || ssh.FingerprintSHA256(key) != probed {
		return errors.New("sshhost: the fingerprint does not match the probed host key")
	}
	return writeKnownHost(c.knownHostsPath, c.host, key)
}

// Run executes command and returns its output. A nonzero exit status is in
// Result, not in the error.
func (c *Client) Run(ctx context.Context, command string, stdin []byte) (Result, error) {
	client, err := c.dial(ctx)
	if err != nil {
		return Result{}, err
	}
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { client.Close() })
	defer stop()

	session, err := client.NewSession()
	if err != nil {
		return Result{}, c.commandError(ctx, err)
	}
	defer session.Close()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	if stdin != nil {
		session.Stdin = bytes.NewReader(stdin)
	}
	err = session.Run(command)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return Result{}, ctxErr
	}
	if err != nil {
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			return Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), ExitCode: exitErr.ExitStatus()}, nil
		}
		return Result{}, c.commandError(ctx, err)
	}
	return Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}, nil
}

// ReadFile returns a remote file's bytes. A missing file is ErrNotExist.
func (c *Client) ReadFile(ctx context.Context, path string) ([]byte, error) {
	quoted := QuotePath(path)
	result, err := c.Run(ctx, fmt.Sprintf("if [ -e %s ]; then cat -- %s; else exit 44; fi", quoted, quoted), nil)
	if err != nil {
		return nil, err
	}
	if result.ExitCode == 44 {
		return nil, ErrNotExist
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("sshhost: reading the remote file exited with status %d", result.ExitCode)
	}
	return result.Stdout, nil
}

// WriteFileAtomic writes data through stdin into a sibling temporary file,
// sets mode, then renames it over path.
func (c *Client) WriteFileAtomic(ctx context.Context, path string, data []byte, mode os.FileMode) error {
	quoted := QuotePath(path)
	command := fmt.Sprintf("umask 077 && cat > %s.tmp && chmod %03o %s.tmp && mv -f %s.tmp %s",
		quoted, mode.Perm(), quoted, quoted, quoted)
	result, err := c.Run(ctx, command, data)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("sshhost: writing the remote file exited with status %d", result.ExitCode)
	}
	return nil
}

func (c *Client) dial(ctx context.Context) (*ssh.Client, error) {
	auth, cleanup, err := c.authMethods(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	var hostKeyErr error
	client, err := c.connect(ctx, auth, func(_ string, _ net.Addr, key ssh.PublicKey) error {
		verifyErr := c.verifyHostKey(key)
		if verifyErr != nil {
			hostKeyErr = verifyErr
		}
		return verifyErr
	})
	if err == nil {
		return client, nil
	}
	if hostKeyErr != nil {
		return nil, hostKeyErr
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if strings.Contains(err.Error(), "unable to authenticate") {
		return nil, codedError(domain.SSH_AUTH_FAILED, "SSH authentication failed")
	}
	return nil, unreachableError(err)
}

func (c *Client) connect(ctx context.Context, auth []ssh.AuthMethod, callback ssh.HostKeyCallback) (*ssh.Client, error) {
	address := c.address()
	dialer := net.Dialer{Timeout: dialTimeout}
	raw, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { raw.Close() })
	defer stop()

	config := &ssh.ClientConfig{
		User:            c.host.User,
		Auth:            auth,
		HostKeyCallback: callback,
		Timeout:         dialTimeout,
	}
	conn, channels, requests, err := ssh.NewClientConn(raw, address, config)
	if err != nil {
		raw.Close()
		return nil, err
	}
	return ssh.NewClient(conn, channels, requests), nil
}

func (c *Client) address() string {
	return net.JoinHostPort(c.host.Address, strconv.Itoa(c.host.Port))
}

func (c *Client) verifyHostKey(key ssh.PublicKey) error {
	recorded, stored, err := readKnownHostFingerprint(c.knownHostsPath, c.host)
	if err != nil {
		return err
	}
	if !stored {
		return codedError(domain.SSH_HOST_KEY_UNKNOWN, "the SSH host key is not trusted yet")
	}
	if recorded != ssh.FingerprintSHA256(key) {
		return codedError(domain.SSH_HOST_KEY_CHANGED, "the SSH host key does not match the recorded key")
	}
	return nil
}

func (c *Client) authMethods(ctx context.Context) ([]ssh.AuthMethod, func(), error) {
	switch c.host.Auth {
	case domain.SSHAuthKey:
		method, err := c.keyAuth(ctx)
		if err != nil {
			return nil, func() {}, err
		}
		return []ssh.AuthMethod{method}, func() {}, nil
	case domain.SSHAuthAgent:
		socket := os.Getenv("SSH_AUTH_SOCK")
		if socket == "" {
			return nil, func() {}, codedError(domain.SSH_AUTH_FAILED, "ssh-agent is not available")
		}
		conn, err := net.Dial("unix", socket)
		if err != nil {
			return nil, func() {}, codedError(domain.SSH_AUTH_FAILED, "ssh-agent is not available")
		}
		signers, err := agent.NewClient(conn).Signers()
		if err != nil {
			conn.Close()
			return nil, func() {}, codedError(domain.SSH_AUTH_FAILED, "ssh-agent could not list its keys")
		}
		if len(signers) == 0 {
			conn.Close()
			return nil, func() {}, codedError(domain.SSH_AUTH_FAILED, "ssh-agent holds no keys")
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signers...)}, func() { conn.Close() }, nil
	case domain.SSHAuthPassword:
		password, err := c.credential(ctx)
		if err != nil {
			if errors.Is(err, platform.ErrCredentialNotFound) {
				return nil, func() {}, codedError(domain.SSH_AUTH_FAILED, "no password is stored for this host")
			}
			return nil, func() {}, codedError(domain.SSH_AUTH_FAILED, "the stored password could not be read")
		}
		// Many servers offer the password prompt only as keyboard-interactive.
		answer := func(_, _ string, questions []string, _ []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for i := range answers {
				answers[i] = password
			}
			return answers, nil
		}
		return []ssh.AuthMethod{ssh.Password(password), ssh.KeyboardInteractive(answer)}, func() {}, nil
	default:
		return nil, func() {}, codedError(domain.SSH_AUTH_FAILED, "unsupported SSH authentication method")
	}
}

func (c *Client) keyAuth(ctx context.Context) (ssh.AuthMethod, error) {
	path, err := expandHome(c.host.KeyPath)
	if err != nil {
		return nil, codedError(domain.SSH_AUTH_FAILED, "the SSH private key path could not be resolved")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, codedError(domain.SSH_AUTH_FAILED, "the SSH private key could not be read")
	}
	signer, err := ssh.ParsePrivateKey(data)
	if err == nil {
		return ssh.PublicKeys(signer), nil
	}
	var missingPassphrase *ssh.PassphraseMissingError
	if !errors.As(err, &missingPassphrase) {
		return nil, codedError(domain.SSH_AUTH_FAILED, "the SSH private key could not be parsed")
	}
	passphrase, credErr := c.credential(ctx)
	if credErr != nil {
		if errors.Is(credErr, platform.ErrCredentialNotFound) {
			return nil, codedError(domain.SSH_AUTH_FAILED, "the SSH private key is encrypted and no passphrase is stored")
		}
		return nil, codedError(domain.SSH_AUTH_FAILED, "the stored SSH key passphrase could not be read")
	}
	signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
	if err != nil {
		return nil, codedError(domain.SSH_AUTH_FAILED, "the SSH private key could not be decrypted with the stored passphrase")
	}
	return ssh.PublicKeys(signer), nil
}

func (c *Client) credential(ctx context.Context) (string, error) {
	if c.creds == nil {
		return "", platform.ErrCredentialNotFound
	}
	return c.creds.Get(ctx, CredentialKey(c.host))
}

func (c *Client) commandError(ctx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return unreachableError(err)
}

func expandHome(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if path == "~" {
			return home, nil
		}
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}

func codedError(code, message string) error {
	return domain.Error{Code: code, Message: message}
}

func unreachableError(err error) error {
	return domain.Error{Code: domain.SSH_UNREACHABLE, Message: "the SSH host could not be reached: " + err.Error()}
}
