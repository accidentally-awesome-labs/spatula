# Support Matrix

Authoritative minimum-version support matrix for Spatula OSS. All components below are required for running the full stack (API + worker + migrate + CLI). See `docs/runbooks/` for operational runbooks.

---

## Component Versions

| Component             | Minimum  | Tested        | Notes                                                                                                            |
| --------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Node.js               | 22 (LTS) | 22            | All package manifests declare `"engines": { "node": ">=22" }`. Node 22 LTS is the only tested runtime.           |
| PostgreSQL (Postgres) | 14       | 14, 15, 16    | Postgres 14+ is required; `pg_dump 14+` emits `\restrict`/`\unrestrict` metacommands stripped by the normalizer. |
| Redis                 | 7        | 7             | BullMQ and the WebSocket token store require Redis 7+ (XREAD, LMPOP). Earlier versions are unsupported.          |
| pnpm                  | 9        | 9.15.x        | Package manager. Install via `corepack enable`. Earlier major versions are incompatible with the lockfile.       |
| Docker / buildx       | 24+      | 29.x / 0.32.x | Required only for building container images locally. Not needed to run the platform via docker-compose.          |

## Operating Systems

| OS             | Support Level | Notes                                                                                                      |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| Linux          | Supported     | Ubuntu 20.04+, Debian 11+, and equivalents. The primary production target.                                 |
| macOS          | Supported     | macOS 13 (Ventura)+ on Apple Silicon (arm64) and Intel (x86_64). Used as the primary developer platform.   |
| WSL (Windows)  | Supported     | WSL 2 with Ubuntu recommended. Commands documented in runbooks are tested on WSL 2.                        |
| Native Windows | Not supported | Native Windows shell (cmd, PowerShell) is explicitly out of scope. WSL 2 is the supported path on Windows. |

---

## Container Images

Production images shipped by Spatula OSS:

| Image     | Base                                  | Purpose                            |
| --------- | ------------------------------------- | ---------------------------------- |
| `api`     | `gcr.io/distroless/nodejs22-debian12` | HTTP API server                    |
| `worker`  | `gcr.io/distroless/nodejs22-debian12` | BullMQ job worker                  |
| `migrate` | `gcr.io/distroless/nodejs22-debian12` | One-shot database migration runner |
| `cli`     | `node:22-bookworm-slim`               | Ink TUI / remote-commands client   |

**No shell in api/worker/migrate images.** The distroless base has no shell, package manager, or runtime utilities. The non-root user is `nonroot` (uid 65532).

**CLI image: no browsers baked in.** The `cli` image uses Debian-slim (has a shell) but Playwright browsers are **not** pre-installed. Install them on the host with `spatula setup` before running local crawl jobs. This keeps the CLI image small and avoids baking browser binaries into the release artifact.

All four images are:

- Multi-arch: `linux/amd64` + `linux/arm64`
- cosign-signed (keyless, OIDC → Fulcio → Rekor transparency log)
- SBOM-attested (cyclonedx-json, both as OCI attestation and as a GitHub release asset)

Verify a signed image:

```bash
cosign verify \
  ghcr.io/accidentally-awesome-labs/spatula/api:<version> \
  --certificate-identity-regexp='https://github\.com/accidentally-awesome-labs/spatula/\.github/workflows/release\.yml@refs/tags/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

See `docs/runbooks/verify-images.md` for full verification instructions.

---

## How This Is Enforced

### Minimum-version CI matrix

`.github/workflows/support-matrix.yml` runs the heavier support test lanes against the supported minimum versions:

- **Matrix:** Node 22 × PostgreSQL 14 / 15 / 16 × Redis 7
- **Cadence:** on-release (push to `v*` tag) + nightly (`0 2 * * *` UTC) + `workflow_dispatch`
- **Not on every PR** — DB-heavy backup and upgrade tests are skipped from the standard PR gate to keep it fast

The matrix runs three test suites:

| Suite          | Script              | DB required | Description                                                  |
| -------------- | ------------------- | ----------- | ------------------------------------------------------------ |
| Config compat  | `pnpm test:config`  | No          | Verifies v1.0 `spatula.yaml` parses on current runtime       |
| Upgrade        | `pnpm test:upgrade` | Yes         | Seeds v1.0 DB, applies current migrations, verifies schema   |
| Backup/restore | `pnpm test:backup`  | Yes         | Full pg_dump → restore → row-count + content-hash round-trip |

### Package manifest enforcement

`engines: { node: ">=22" }` is declared in every package's `package.json`. Node versions below 22 will see an npm/pnpm install warning and may fail at runtime.

### PostgreSQL version caveat

The `pg_dump 14+` normalizer strips `\restrict`/`\unrestrict` random tokens from schema dumps — these tokens appear only in pg 14+ output and would otherwise make schema diffs non-deterministic. PostgreSQL 13 and below are not tested and may produce different normalizer output.

---

## Related Runbooks

- `docs/runbooks/upgrade.md` — upgrade policies (no-downgrade, expand-contract), version-to-version template
- `docs/runbooks/backup-restore.md` — backup, restore, and time-to-restore estimates
- `docs/runbooks/hardware-sizing.md` — measured 1k-page baseline (single Hetzner CX32 VM)
- `docs/runbooks/reverse-proxy.md` — nginx reverse proxy configuration (tested); traefik/caddy stubs

---

_Last reviewed: 2026-07-12._
