package i18n

import (
	"errors"
	"strings"
)

// parseAppleLanguages returns the first language in the old-style plist array
// printed by `defaults read -g AppleLanguages`. Values may be quoted or bare.
func parseAppleLanguages(out []byte) (string, error) {
	text := strings.TrimSpace(string(out))
	text = strings.TrimPrefix(text, "(")
	text = strings.TrimSuffix(text, ")")
	for _, item := range strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\r'
	}) {
		item = strings.TrimSpace(item)
		item = strings.Trim(item, `"`)
		item = strings.TrimSpace(item)
		if item != "" {
			return item, nil
		}
	}
	return "", errors.New("i18n: AppleLanguages has no language")
}
