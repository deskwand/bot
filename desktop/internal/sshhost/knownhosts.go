package sshhost

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// hostLabel is the known_hosts host field for one HostRef. The port is always
// included, so a host trusted on one port is not trusted on another.
func hostLabel(host domain.HostRef) string {
	return fmt.Sprintf("[%s]:%d", host.Address, host.Port)
}

// readKnownHostFingerprint returns the recorded SHA256 fingerprint for host.
func readKnownHostFingerprint(path string, host domain.HostRef) (string, bool, error) {
	lines, err := readKnownHostLines(path)
	if err != nil {
		return "", false, err
	}
	label := hostLabel(host)
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] != label {
			continue
		}
		blob, err := base64.StdEncoding.DecodeString(fields[2])
		if err != nil {
			continue
		}
		key, err := ssh.ParsePublicKey(blob)
		if err != nil {
			continue
		}
		return ssh.FingerprintSHA256(key), true, nil
	}
	return "", false, nil
}

func writeKnownHost(path string, host domain.HostRef, key ssh.PublicKey) error {
	lines, err := readKnownHostLines(path)
	if err != nil {
		return err
	}
	label := hostLabel(host)
	fields := strings.Fields(string(ssh.MarshalAuthorizedKey(key)))
	if len(fields) < 2 {
		return errors.New("sshhost: the host key could not be encoded")
	}
	entry := label + " " + fields[0] + " " + fields[1]

	kept := make([]string, 0, len(lines)+1)
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		existing := strings.Fields(line)
		if len(existing) > 0 && existing[0] == label {
			continue
		}
		kept = append(kept, line)
	}
	kept = append(kept, entry)
	return writeKnownHostFile(path, []byte(strings.Join(kept, "\n")+"\n"))
}

func removeKnownHost(path string, host domain.HostRef) error {
	lines, err := readKnownHostLines(path)
	if err != nil {
		return err
	}
	label := hostLabel(host)
	kept := make([]string, 0, len(lines))
	removed := false
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == label {
			removed = true
			continue
		}
		kept = append(kept, line)
	}
	if !removed {
		return nil
	}
	return writeKnownHostFile(path, []byte(strings.Join(kept, "\n")))
}

func readKnownHostLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return strings.Split(string(data), "\n"), nil
}

func writeKnownHostFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
