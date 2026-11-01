# TEST ONLY release fixture

This directory is test material for the TypeScript builder and the Go release
verifier. It is never a production release and the key is never trusted by
production code.

- `manifest.json` — canonical manifest bytes (signature covers exactly these bytes)
- `manifest.sig` — detached Ed25519 signature, base64
- `files/` — the module bytes listed by the manifest
- `TEST-ONLY-signing-key.pem` — TEST ONLY private key, committed on purpose
- `TEST-ONLY-signing-key.pub.pem` — matching public key
- keyId: `test-only-do-not-use`

Do not add these keys to a production `release.TrustedKeys` set.
