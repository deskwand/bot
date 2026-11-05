//go:build !darwin && !windows

package i18n

import (
	"errors"
	"os"
	"strings"
)

// SystemLanguage returns the language named by LC_ALL or LANG. Both empty is
// an error.
func SystemLanguage() (string, error) {
	for _, key := range []string{"LC_ALL", "LANG"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value, nil
		}
	}
	return "", errors.New("i18n: no locale environment variable is set")
}
