# Security model

Traeky is local-first. The browser owns the plaintext state while the vault is unlocked. Persistent local storage and remote sync payloads are encrypted before they are written or uploaded.

## Cryptography

- Vault encryption: AES-GCM 256 via the browser Web Crypto API.
- Key derivation: PBKDF2-HMAC-SHA-256 with 600,000 iterations and a random 128-bit salt.
- IV: random 96-bit IV per vault seal.
- Remote sync: the Cloud API stores only the encrypted vault envelope under an anonymous, high-entropy Sync-Key.
- The Cloud API never receives the user passphrase or an unwrapped data key.
- The Sync-Key is not a decryption key and is not used as a KDF input.

## Anonymous Cloud mapping

Traeky intentionally has no Cloud accounts and no API login. The generated Sync-Key is the remote assignment handle for one encrypted vault. On first upload, the frontend sends `If-None-Match: *`; if the key already exists, the server returns `409 Conflict` and leaves the existing ciphertext untouched. Updates use `If-Match` with the last known revision to avoid accidental overwrites.

## Optional Cloud Auth-Secret

A vault can additionally be protected with a Cloud Auth-Secret configured in the dashboard. This is a separate remote access secret, not the vault passphrase and not a master key.

Client behavior:

- The dashboard generates a high-entropy Auth-Secret by default for new profiles.
- Before sending it to the server, the browser computes a domain-separated SHA-256 proof: `SHA-256("traeky-cloud-auth-v1:" + secret)`.
- The proof is sent via `X-Traeky-Vault-Auth`.
- To rotate the Auth-Secret, the browser authenticates with the current proof and sends the new proof via `X-Traeky-New-Vault-Auth`.

Server behavior:

- The server stores only a random salt, an iteration count, and `PBKDF2-HMAC-SHA-256(proof, salt, 210000 iterations)`.
- Protected vaults require a valid auth proof for GET, PUT, and DELETE.
- The comparison is constant-time.
- The server still cannot decrypt the vault body. The Auth-Secret only gates access to encrypted blobs.

If no Cloud Auth-Secret is configured, possession of the Sync-Key is sufficient to download the encrypted blob. The blob still cannot be decrypted without the user's vault passphrase, but enabling the Auth-Secret is recommended because it prevents read/write/delete access to ciphertext with the Sync-Key alone.

## Operational notes

- Use HTTPS in production. Web Crypto is only reliable in secure browser contexts, and Sync-Keys/Auth proofs must not leak through plaintext transport.
- Use a high-entropy vault passphrase. Remote encrypted backups can be copied by a hostile server operator and attacked offline.
- Put the Cloud service behind a reverse proxy with request logging hygiene, rate limiting, request-size limits, and backups of `/data`.
- Avoid logging full request paths if your reverse proxy would persist Sync-Keys in access logs.
- Avoid logging `X-Traeky-Vault-Auth` or `X-Traeky-New-Vault-Auth` headers.
