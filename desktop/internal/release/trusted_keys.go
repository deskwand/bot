package release

import (
	"crypto/ed25519"
	"crypto/x509"
	"embed"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
)

// ProductionReleaseKeyID is the only key id this client trusts for Worker
// releases. The matching public key is maintained by the release process; the
// private key never enters this repository or the app.
const ProductionReleaseKeyID = "deskwand-release-1"

const productionKeyPath = "keys/deskwand-release-1.pub.pem"

// keysFS embeds the public key directory. The directory exists with a
// .gitkeep file even when no key has been generated yet, so a checkout without
// release credentials still builds and returns an empty trusted-key set.
//
//go:embed all:keys
var keysFS embed.FS

// TrustedReleaseKeys returns the production trusted key set. A missing public
// key is not an error: the app runs, and Install/Upgrade report
// RELEASE_UNTRUSTED because no key can validate the bundle.
func TrustedReleaseKeys() (TrustedKeys, error) {
	data, err := fs.ReadFile(keysFS, productionKeyPath)
	if errors.Is(err, fs.ErrNotExist) {
		return TrustedKeys{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("release: read production public key: %w", err)
	}

	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, errors.New("release: production public key is not a PEM PUBLIC KEY")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, errors.New("release: production public key is not valid PKIX")
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("release: production public key is not Ed25519")
	}
	return TrustedKeys{ProductionReleaseKeyID: publicKey}, nil
}
