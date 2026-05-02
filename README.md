# Traeky

Traeky is a fresh Go implementation of the Traeky concept: a local-first crypto portfolio dashboard whose UI runs in the user's browser, with an optional self-hosted Cloud service for encrypted backups.

## What changed

- New Go backend serving an embedded browser app and optional Cloud API.
- New dashboard layout with KPI tiles, allocation chart, timeline chart, holdings, expiring holding-period view, transaction filters, CSV import/export, downloadable PDF reports, and security settings.
- End-to-end encrypted sync: the Cloud server stores only encrypted vault envelopes and has no master key.
- Anonymous Cloud mapping: no accounts and no API login. A generated high-entropy Sync-Key identifies the encrypted remote vault.
- Optional per-vault Cloud Auth-Secret: users can set or generate an additional secret in the dashboard. The browser hashes it before sending it, the server stores only a salted PBKDF2 hash, and protected vaults cannot be downloaded, overwritten, or deleted with the Sync-Key alone.
- Collision-safe first upload: if the generated Sync-Key is already occupied, the Cloud API returns `409 Conflict` and does not overwrite existing data.
- Legacy migration: on first load the app detects old Traeky localStorage keys and old encrypted profile entries. CSV import remains available as fallback.
- CI, Docker build workflow, GHCR publishing, optional Docker Hub publishing, tests, and Dependabot config are included.

## Architecture

```text
Browser
  ├─ Web Crypto: PBKDF2-SHA-256 + AES-GCM
  ├─ localStorage: encrypted vault only
  ├─ CSV import/export and local PDF report generation
  └─ Optional sync push/pull via anonymous Sync-Key + optional Cloud Auth-Secret

Go binary
  ├─ serves embedded frontend
  ├─ /api/v1/info
  └─ /api/v1/vaults/{sync_key}: encrypted blob storage

Filesystem
  └─ /data/{sync_key}.json with revision metadata, optional auth hash, and encrypted JSON body
```

The Cloud service has no user accounts and no login endpoint. The generated Sync-Key is an unguessable locator for one encrypted vault. The user's vault passphrase remains in the browser and is never sent to the server.

For stronger access control, the dashboard also generates a Cloud Auth-Secret. This secret is **not** a decryption key and must not be confused with the vault passphrase. The browser sends a SHA-256 proof of the Auth-Secret in `X-Traeky-Vault-Auth`; the server stores only a salted PBKDF2-HMAC-SHA-256 hash of that proof. When enabled, someone who learns only the Sync-Key cannot fetch, overwrite, or delete the encrypted blob.

## Run locally

```bash
go run ./cmd/traeky
# open http://localhost:8080
```

## Docker

```bash
docker compose up --build
# open http://localhost:8080
```

Useful environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `TRAEKY_ADDR` | `:8080` | HTTP listen address |
| `TRAEKY_MODE` | `all` | `all`, `app`, or `cloud` |
| `TRAEKY_DATA_DIR` | `./data` | Cloud vault storage path |
| `TRAEKY_MAX_PAYLOAD_BYTES` | `26214400` | Max encrypted vault upload size |
| `TRAEKY_CORS_ORIGINS` | empty | Comma-separated allowed frontend origins for separate Cloud hosting |

## Cloud API

### Service info

```bash
curl http://localhost:8080/api/v1/info
```

### First upload of encrypted vault

Use a generated Sync-Key with at least 32 allowed characters. `If-None-Match: *` makes the first upload collision-safe: if the key is already occupied, the server responds with `409 Conflict`.

```bash
curl -X PUT http://localhost:8080/api/v1/vaults/vault_example_random_32_chars_minimum \
  -H 'If-None-Match: *' \
  -H 'Content-Type: application/json' \
  -H 'X-Traeky-Vault-Auth: ta1_client_side_auth_proof_optional' \
  -d '{"body":{"format":"traeky-vault","version":2,"ciphertext":"opaque"}}'
```

The `X-Traeky-Vault-Auth` header is optional. If it is present on first upload, the vault becomes protected and future GET, PUT, and DELETE requests must provide the same proof. The dashboard generates this proof from the Cloud Auth-Secret automatically.

### Update encrypted vault

After a successful upload or pull, use the returned `revision` or `ETag` as `If-Match`.

```bash
curl -X PUT http://localhost:8080/api/v1/vaults/vault_example_random_32_chars_minimum \
  -H 'If-Match: 1' \
  -H 'Content-Type: application/json' \
  -H 'X-Traeky-Vault-Auth: ta1_client_side_auth_proof_optional' \
  -d '{"body":{"format":"traeky-vault","version":2,"ciphertext":"opaque-v2"}}'
```

### Rotate Cloud Auth-Secret

A protected vault can rotate its Cloud Auth-Secret by proving the current secret and sending a new proof:

```bash
curl -X PUT http://localhost:8080/api/v1/vaults/vault_example_random_32_chars_minimum \
  -H 'If-Match: 2' \
  -H 'Content-Type: application/json' \
  -H 'X-Traeky-Vault-Auth: ta1_old_client_side_auth_proof' \
  -H 'X-Traeky-New-Vault-Auth: ta1_new_client_side_auth_proof' \
  -d '{"body":{"format":"traeky-vault","version":2,"ciphertext":"opaque-v3"}}'
```

### Download encrypted vault

```bash
curl http://localhost:8080/api/v1/vaults/vault_example_random_32_chars_minimum \
  -H 'X-Traeky-Vault-Auth: ta1_client_side_auth_proof_optional'
```

If the vault was created without a Cloud Auth-Secret, the header is not required. If the vault is protected and the header is missing or wrong, the server returns `401 Unauthorized`.

## PDF report export

The dashboard includes a client-side PDF report export under **Import / Export**. The PDF is generated in the browser from the decrypted local vault and contains:

- profile and generation timestamp
- portfolio summary
- holdings table
- transaction table with ID, chain links, timestamp, asset, type, amount, price, value, currency, source, TX-ID/note
- tax/legal disclaimer

No report data is sent to the Cloud service for PDF generation.

## Development

```bash
make fmt
make test
make vet
make build
```

The frontend intentionally has no npm dependency chain. The browser app is embedded into the Go binary using `embed`.

## Container publishing

`.github/workflows/docker-publish.yml` publishes multi-arch images to GHCR on `main` and version tags. Docker Hub publishing is enabled when these repository secrets exist:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

## Migration paths

1. **Automatic browser migration:** The start screen detects old keys such as `traeky:transactions`, `traeky:app-config`, `traeky:profiles:index`, and `traeky:profile:{id}:data`.
2. **Encrypted legacy profile migration:** Select the old profile and enter its passphrase; the new vault is re-encrypted in the new format.
3. **CSV fallback:** Import a Traeky CSV in the dashboard under Import / Export.

## Limits and next hardening steps

This implementation is complete enough to run and extend, but for a public release I recommend adding CSP nonce generation, rate limiting middleware, more browser-level E2E tests, optional passkey-based local unlock, and a formal external security review.
