package container

import (
	"context"
	"os"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/sshhost"
)

type fakeHost struct {
	files    map[string][]byte
	commands []string
	stdins   [][]byte
	respond  func(command string) (sshhost.Result, error)
	writeErr error
}

func (h *fakeHost) Run(_ context.Context, command string, stdin []byte) (sshhost.Result, error) {
	h.commands = append(h.commands, command)
	h.stdins = append(h.stdins, append([]byte(nil), stdin...))
	if h.respond != nil {
		return h.respond(command)
	}
	return sshhost.Result{}, nil
}

func (h *fakeHost) ReadFile(_ context.Context, path string) ([]byte, error) {
	data, ok := h.files[path]
	if !ok {
		return nil, sshhost.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (h *fakeHost) WriteFileAtomic(_ context.Context, path string, data []byte, _ os.FileMode) error {
	if h.writeErr != nil {
		return h.writeErr
	}
	if h.files == nil {
		h.files = make(map[string][]byte)
	}
	h.files[path] = append([]byte(nil), data...)
	return nil
}

func newService(host *fakeHost) *Service {
	return New(Options{
		Dial: func(domain.Target) (Host, error) {
			return host, nil
		},
		Version: "1.2.3",
		Sleep: func(context.Context, time.Duration) error {
			return nil
		},
	})
}

func containerTarget() domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{
			Address: "203.0.113.7",
			Port:    domain.DefaultSSHPort,
			User:    "root",
			Auth:    domain.SSHAuthPassword,
			Dir:     "~/deskwand",
		},
	}
}
