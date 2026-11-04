// Package netproxy lets the app's HTTP clients follow the macOS system proxy.
//
// Go's default transport only reads HTTPS_PROXY and friends from the
// environment. An app launched from Finder or as a login item has no such
// variables, so on a network that can only reach *.workers.dev through a local
// proxy every request to the Worker timed out. Install keeps the environment
// as the first choice and falls back to the proxy configured in System
// Settings, read through `scutil --proxy`.
package netproxy

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http/httpproxy"
)

const (
	systemCacheTTL = 30 * time.Second
	scutilTimeout  = 2 * time.Second
)

// Settings is the subset of the system proxy configuration the app follows.
// A nil proxy means that protocol is not proxied.
type Settings struct {
	HTTP       *url.URL
	HTTPS      *url.URL
	SOCKS      *url.URL
	Exceptions []string
}

// Install points http.DefaultTransport, which every client in the app uses,
// at the environment proxy or, failing that, the system proxy.
func Install() {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return
	}
	transport.Proxy = newProxyFunc(readSystemSettings)
}

func newProxyFunc(readSystem func() Settings) func(*http.Request) (*url.URL, error) {
	env := httpproxy.FromEnvironment()
	if env.HTTPProxy != "" || env.HTTPSProxy != "" {
		envProxy := env.ProxyFunc()
		return func(req *http.Request) (*url.URL, error) {
			return envProxy(req.URL)
		}
	}
	cache := &systemCache{read: readSystem}
	return func(req *http.Request) (*url.URL, error) {
		return cache.get().ProxyFor(req.URL)
	}
}

// systemCache rereads the system settings at most every systemCacheTTL, so a
// proxy switched on after launch is picked up without a restart.
type systemCache struct {
	read     func() Settings
	mu       sync.Mutex
	settings Settings
	readAt   time.Time
}

func (c *systemCache) get() Settings {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.readAt.IsZero() || time.Since(c.readAt) > systemCacheTTL {
		c.settings = c.read()
		c.readAt = time.Now()
	}
	return c.settings
}

func readSystemSettings() Settings {
	if runtime.GOOS != "darwin" {
		return Settings{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), scutilTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return Settings{}
	}
	return ParseScutil(string(out))
}

// ParseScutil reads the output of `scutil --proxy`. Anything it does not
// recognise is ignored, which leaves requests direct.
func ParseScutil(output string) Settings {
	values := map[string]string{}
	var exceptions []string
	inExceptions := false
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if inExceptions {
			if line == "}" {
				inExceptions = false
				continue
			}
			if _, value, ok := strings.Cut(line, " : "); ok {
				exceptions = append(exceptions, strings.TrimSpace(value))
			}
			continue
		}
		key, value, ok := strings.Cut(line, " : ")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "ExceptionsList" && strings.HasPrefix(value, "<array>") {
			inExceptions = true
			continue
		}
		values[key] = value
	}
	return Settings{
		HTTP:       proxyURL(values, "HTTP", "http"),
		HTTPS:      proxyURL(values, "HTTPS", "http"),
		SOCKS:      proxyURL(values, "SOCKS", "socks5"),
		Exceptions: exceptions,
	}
}

func proxyURL(values map[string]string, prefix, scheme string) *url.URL {
	if values[prefix+"Enable"] != "1" {
		return nil
	}
	host := values[prefix+"Proxy"]
	port := values[prefix+"Port"]
	if host == "" || port == "" {
		return nil
	}
	return &url.URL{Scheme: scheme, Host: net.JoinHostPort(host, port)}
}

// ProxyFor returns the proxy for target, or nil to connect directly.
func (s Settings) ProxyFor(target *url.URL) (*url.URL, error) {
	if target == nil || s.bypass(target.Hostname()) {
		return nil, nil
	}
	var proxy *url.URL
	switch target.Scheme {
	case "https":
		proxy = s.HTTPS
	case "http":
		proxy = s.HTTP
	}
	if proxy == nil {
		proxy = s.SOCKS
	}
	return proxy, nil
}

func (s Settings) bypass(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return true
	}
	for _, rule := range s.Exceptions {
		rule = strings.ToLower(strings.TrimSpace(rule))
		switch {
		case rule == "":
		case strings.Contains(rule, "/"):
			if _, network, err := net.ParseCIDR(rule); err == nil && ip != nil && network.Contains(ip) {
				return true
			}
		case strings.HasPrefix(rule, "*."):
			if strings.HasSuffix(host, rule[1:]) {
				return true
			}
		case strings.HasPrefix(rule, "."):
			if strings.HasSuffix(host, rule) {
				return true
			}
		case host == rule:
			return true
		}
	}
	return false
}
