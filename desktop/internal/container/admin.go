package container

import (
	"context"
	"errors"
	"strings"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/hostexec"
)

// AdminAccess returns the ADMIN_TOKEN the container was installed with. It is
// the only secret the desktop reads back: snapshots still carry names only,
// and the value never leaves memory.
func (s *Service) AdminAccess(ctx context.Context, target domain.Target) (string, error) {
	host, err := s.dial(target)
	if err != nil {
		return "", err
	}
	readCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()

	data, err := host.ReadFile(readCtx, envPath(target.Host.Dir))
	if err != nil {
		if errors.Is(err, hostexec.ErrNotExist) {
			return "", envFileError("the remote .env file is missing")
		}
		return "", err
	}
	file, err := envfile.ParseDialect(data, s.engine(target).Dialect())
	if err != nil {
		return "", envFileError("the remote .env file cannot be parsed")
	}
	token, ok := file.Get("ADMIN_TOKEN")
	token = strings.TrimSpace(token)
	if !ok || token == "" {
		return "", envFileError("ADMIN_TOKEN is missing from the remote .env")
	}
	// A lone-CR file or trailing junk parses into a token that cannot be sent
	// as an HTTP header. Reject it here so the page offers the restore path
	// instead of failing every request with a transport error.
	for _, r := range token {
		if r < 0x21 || r > 0x7e {
			return "", envFileError("ADMIN_TOKEN contains characters that cannot be sent")
		}
	}
	return token, nil
}
