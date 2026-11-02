package cloudflare

import (
	"fmt"
	"net/url"
	"regexp"
)

var (
	accountIDPattern  = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	scriptNamePattern = regexp.MustCompile(`^[a-z0-9-_]{1,63}$`)
)

// accountBasePath validates a Cloudflare account ID and returns its escaped
// API path. Only 32 hexadecimal characters are accepted.
func accountBasePath(accountID string) (string, error) {
	if !accountIDPattern.MatchString(accountID) {
		return "", fmt.Errorf("cloudflare: account id must be 32 hexadecimal characters")
	}
	return "/accounts/" + url.PathEscape(accountID), nil
}

// workerScriptPath validates both identifiers and returns the escaped path for
// one Worker script. Worker names are restricted to the characters Cloudflare
// accepts in a script name.
func workerScriptPath(accountID, scriptName string) (string, error) {
	base, err := accountBasePath(accountID)
	if err != nil {
		return "", err
	}
	if !scriptNamePattern.MatchString(scriptName) {
		return "", fmt.Errorf("cloudflare: script name must match ^[a-z0-9-_]{1,63}$")
	}
	return base + "/workers/scripts/" + url.PathEscape(scriptName), nil
}
