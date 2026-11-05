//go:build darwin

package i18n

import (
	"fmt"
	"os/exec"
)

// SystemLanguage returns the first language in macOS's preferred language
// list, for example "zh-Hans".
func SystemLanguage() (string, error) {
	out, err := exec.Command("defaults", "read", "-g", "AppleLanguages").Output()
	if err != nil {
		return "", fmt.Errorf("i18n: read AppleLanguages: %w", err)
	}
	return parseAppleLanguages(out)
}
