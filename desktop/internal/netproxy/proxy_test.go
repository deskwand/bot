package netproxy

import (
	"net/http"
	"net/url"
	"testing"
)

const scutilEnabled = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
    3 : 192.168.0.0/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}
`

const scutilDisabled = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
`

const scutilSocksOnly = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 10.0.0.2
}
`

func request(t *testing.T, raw string) *http.Request {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Request{URL: u}
}

func resolve(t *testing.T, settings Settings, raw string) string {
	t.Helper()
	proxy, err := settings.ProxyFor(request(t, raw).URL)
	if err != nil {
		t.Fatalf("ProxyFor(%s): %v", raw, err)
	}
	if proxy == nil {
		return ""
	}
	return proxy.String()
}

func TestParseScutilPicksSchemeSpecificProxy(t *testing.T) {
	settings := ParseScutil(scutilEnabled)
	if got := resolve(t, settings, "https://bot.example.workers.dev/admin"); got != "http://127.0.0.1:7891" {
		t.Fatalf("https proxy = %q", got)
	}
	if got := resolve(t, settings, "http://example.com/"); got != "http://127.0.0.1:7890" {
		t.Fatalf("http proxy = %q", got)
	}
}

func TestParseScutilHonorsExceptions(t *testing.T) {
	settings := ParseScutil(scutilEnabled)
	for _, raw := range []string{
		"http://localhost:8080/",
		"http://127.0.0.1/",
		"http://printer.local/",
		"http://192.168.1.20/",
	} {
		if got := resolve(t, settings, raw); got != "" {
			t.Fatalf("%s should bypass the proxy, got %q", raw, got)
		}
	}
}

func TestParseScutilDisabledMeansDirect(t *testing.T) {
	settings := ParseScutil(scutilDisabled)
	if got := resolve(t, settings, "https://example.com/"); got != "" {
		t.Fatalf("disabled proxy resolved to %q", got)
	}
}

func TestParseScutilFallsBackToSocks(t *testing.T) {
	settings := ParseScutil(scutilSocksOnly)
	if got := resolve(t, settings, "https://example.com/"); got != "socks5://10.0.0.2:1080" {
		t.Fatalf("socks proxy = %q", got)
	}
}

func TestParseScutilIgnoresGarbage(t *testing.T) {
	settings := ParseScutil("not a dictionary")
	if got := resolve(t, settings, "https://example.com/"); got != "" {
		t.Fatalf("garbage resolved to %q", got)
	}
}

func TestProxyFuncPrefersEnvironment(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://env-proxy:3128")
	calls := 0
	proxy := newProxyFunc(func() Settings {
		calls++
		return ParseScutil(scutilEnabled)
	})
	got, err := proxy(request(t, "https://example.com/"))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.String() != "http://env-proxy:3128" {
		t.Fatalf("proxy = %v, want the environment proxy", got)
	}
	if calls != 0 {
		t.Fatalf("system settings were read %d times despite an environment proxy", calls)
	}
}

func TestProxyFuncFallsBackToSystem(t *testing.T) {
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"} {
		t.Setenv(key, "")
	}
	proxy := newProxyFunc(func() Settings { return ParseScutil(scutilEnabled) })
	got, err := proxy(request(t, "https://example.com/"))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.String() != "http://127.0.0.1:7891" {
		t.Fatalf("proxy = %v, want the system proxy", got)
	}
}
