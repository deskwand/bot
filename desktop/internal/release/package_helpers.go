package release

import (
	"encoding/json"
	"errors"
	"fmt"
)

var errEmptyKeyID = errors.New("release: manifest keyId is empty")

func jsonUnmarshal(data []byte, out any) error {
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("release: read manifest keyId: %w", err)
	}
	return nil
}

func untrustedKeyError(keyID string) error {
	return fmt.Errorf("release: untrusted release key %q", keyID)
}

func keyMismatchError(got, want string) error {
	return fmt.Errorf("release: manifest keyId %q does not match selected key %q", got, want)
}
