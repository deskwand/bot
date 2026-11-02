package cloudflare

import (
	"fmt"
	"net/url"
	"regexp"
)

var (
	accountIDPattern  = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	scriptNamePattern = regexp.MustCompile(`^[a-z0-9-_]{1,63}$`)
	bucketNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
)

// ValidateAccountID checks the Cloudflare account identifier shape used by
// every account-scoped request.
func ValidateAccountID(accountID string) error {
	if !accountIDPattern.MatchString(accountID) {
		return fmt.Errorf("cloudflare: account id must be 32 hexadecimal characters")
	}
	return nil
}

// ValidateWorkerName checks the Worker script name shape accepted by the API.
func ValidateWorkerName(name string) error {
	if !scriptNamePattern.MatchString(name) {
		return fmt.Errorf("cloudflare: script name must match ^[a-z0-9-_]{1,63}$")
	}
	return nil
}

// ValidateBucketName checks the R2 bucket name shape accepted by the API.
func ValidateBucketName(name string) error {
	if !bucketNamePattern.MatchString(name) {
		return fmt.Errorf("cloudflare: bucket name must be 3-63 lowercase letters, digits or hyphens and start and end with a letter or digit")
	}
	return nil
}

// accountBasePath validates a Cloudflare account ID and returns its escaped
// API path. Only 32 hexadecimal characters are accepted.
func accountBasePath(accountID string) (string, error) {
	if err := ValidateAccountID(accountID); err != nil {
		return "", err
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
	if err := ValidateWorkerName(scriptName); err != nil {
		return "", err
	}
	return base + "/workers/scripts/" + url.PathEscape(scriptName), nil
}

// r2BucketPath validates an R2 bucket name and returns its escaped API path.
func r2BucketPath(accountID, bucketName string) (string, error) {
	base, err := accountBasePath(accountID)
	if err != nil {
		return "", err
	}
	if err := ValidateBucketName(bucketName); err != nil {
		return "", err
	}
	return base + "/r2/buckets/" + url.PathEscape(bucketName), nil
}
