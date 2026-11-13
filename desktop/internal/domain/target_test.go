package domain

import (
	"errors"
	"testing"
)

func TestHostRefValidate(t *testing.T) {
	passwordHost := HostRef{
		Address: "203.0.113.7",
		Port:    22,
		User:    "root",
		Auth:    SSHAuthPassword,
		Dir:     "~/deskwand",
	}
	keyHost := HostRef{
		Address: "host.example",
		Port:    2222,
		User:    "deploy",
		Auth:    SSHAuthKey,
		KeyPath: "/k",
		Dir:     "/srv/bot",
	}
	for name, host := range map[string]HostRef{"password": passwordHost, "key": keyHost} {
		if err := host.Validate(); err != nil {
			t.Fatalf("%s host is invalid: %v", name, err)
		}
	}

	invalid := map[string]func(*HostRef){
		"address with space": func(h *HostRef) { h.Address = "a b" },
		"zero port":          func(h *HostRef) { h.Port = 0 },
		"user starting with digit": func(h *HostRef) {
			h.User = "1x"
		},
		"unknown auth": func(h *HostRef) { h.Auth = "x" },
		"key without path": func(h *HostRef) {
			h.Auth = SSHAuthKey
			h.KeyPath = ""
		},
		"tilde with user":    func(h *HostRef) { h.Dir = "~root/x" },
		"dir with space":     func(h *HostRef) { h.Dir = "/a b" },
		"dir with semicolon": func(h *HostRef) { h.Dir = "/a;rm" },
		"inner tilde":        func(h *HostRef) { h.Dir = "/a~b" },
		"relative dir":       func(h *HostRef) { h.Dir = "deskwand" },
		"option-like dir":    func(h *HostRef) { h.Dir = "-rf" },
		"empty dir":          func(h *HostRef) { h.Dir = "" },
	}
	for name, breakHost := range invalid {
		host := passwordHost
		breakHost(&host)
		if err := host.Validate(); err == nil {
			t.Fatalf("%s host was accepted", name)
		}
	}
}

func TestTargetKindHelpers(t *testing.T) {
	if (Target{}).IsContainer() {
		t.Fatal("zero target reported as container")
	}
	container := Target{Kind: TargetContainer, Host: HostRef{Address: "h"}}
	if !container.IsContainer() {
		t.Fatal("container target not reported as container")
	}
	if got := container.DisplayName(); got != "h" {
		t.Fatalf("DisplayName() = %q, want host address", got)
	}
	if got := (Target{ScriptName: "w"}).DisplayName(); got != "w" {
		t.Fatalf("DisplayName() = %q, want script name", got)
	}
}

func TestLocalHostRefValidates(t *testing.T) {
	host := HostRef{Transport: TransportLocal, Engine: EngineApple, Dir: DefaultLocalDir}
	if err := host.Validate(); err != nil {
		t.Fatalf("local host is invalid: %v", err)
	}
}

func TestLocalHostRefRejectsBadDir(t *testing.T) {
	for _, dir := range []string{"relative/x", "/a/~b", "/a;b"} {
		host := HostRef{Transport: TransportLocal, Engine: EngineApple, Dir: dir}
		err := host.Validate()
		var coded Error
		if !errors.As(err, &coded) || coded.Code != codeInvalidRequest {
			t.Errorf("local dir %q error = %v, want INVALID_REQUEST", dir, err)
		}
	}
}

func TestSSHHostRefRejectsAppleEngine(t *testing.T) {
	host := HostRef{
		Address: "203.0.113.7",
		Port:    22,
		User:    "root",
		Auth:    SSHAuthPassword,
		Dir:     "~/deskwand",
		Engine:  EngineApple,
	}
	err := host.Validate()
	var coded Error
	if !errors.As(err, &coded) || coded.Code != codeInvalidRequest {
		t.Fatalf("error = %v, want INVALID_REQUEST", err)
	}
}

func TestSSHHostRefRejectsSpaceInDir(t *testing.T) {
	host := HostRef{
		Address: "203.0.113.7",
		Port:    22,
		User:    "root",
		Auth:    SSHAuthPassword,
		Dir:     "/a b",
	}
	err := host.Validate()
	var coded Error
	if !errors.As(err, &coded) || coded.Code != codeInvalidRequest {
		t.Fatalf("error = %v, want INVALID_REQUEST", err)
	}
}
