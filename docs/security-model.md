# Spatula Security Model

> Authoritative reference for Spatula's security architecture: multi-tenancy isolation,
> authentication, authorization, audit trail, data retention, and GDPR-facing deletion/portability.
> Requirements: SEC-01 through SEC-10.

---

## Table of contents

1. [Threat model](#threat-model)
2. [Multi-tenant isolation](#multi-tenant-isolation)
3. [Authentication](#authentication)
4. [Authorization and scopes](#authorization-and-scopes)
5. [API key lifecycle](#api-key-lifecycle)
6. [Audit log](#audit-log)
7. [Content-store blob security](#content-store-blob-security)
8. [DSR: deletion (SEC-09)](#dsr-deletion-sec-09)
9. [DSR: portability (SEC-10)](#dsr-portability-sec-10)
10. [Secret management](#secret-management)
11. [Rate limiting and abuse prevention](#rate-limiting-and-abuse-prevention)
12. [Dependency and supply chain](#dependency-and-supply-chain)
13. [Security contacts](#security-contacts)

---

## Threat model

Spatula is a multi-tenant SaaS API. The primary attack surface:

| Vector | Risk | Mitigation |
|--------|------|------------|
| API key theft | Full tenant data access | Key shown once, hash-only stored, scoped |
| Cross-tenant data leak | Tenant A reads Tenant B data | `tenant_id` FK on every row, enforced in middleware |
| Privilege escalation | Tenant user gains admin access | Scope list on each key, admin endpoints gated to `admin` scope |
| JWT forgery | Unauthenticated access | JWKS-backed RS256 validation, `iss`/`aud`/`exp` checked |
| DLQ replay poisoning | Dead-letter jobs re-enqueued for wrong tenant | `tenant_id` FK on DLQ rows, verified before re-enqueue |
| Forensic data exfiltration | Content-store blobs accessible without auth | Blobs keyed by `<prefix>/<tenantId>/…`, API auth required for all access |
| Audit log tampering | Deleting evidence of breach | Audit log is append-only; no delete endpoint exists |
| GDPR deletion bypass | Data persists after erasure request | Cascade deletion + tombstone + content-store blob sweep |

Out of scope for this document: network-layer security (TLS termination, WAF rules, DDoS mitigation) — those are handled at the infrastructure layer.

---

## Multi-tenant isolation

Every tenant-scoped table carries a `tenant_id uuid NOT NULL` foreign key referencing `tenants.id`. The FK is set in the Drizzle schema definitions and enforced by PostgreSQL.

**Middleware enforcement** (`packages/api/src/middleware/auth.ts`):
- After authentication, the resolved `tenantId` is stored on the Hono context.
- Every repository method receives `tenantId` from the context, never from the request body/path (with the exception of admin-scoped endpoints, which are gated to `scope: admin`).
- There is no code path that reads another tenant's rows without an explicit privilege check.

**Tables with `tenant_id`:**

| Table | Notes |
|-------|-------|
| `jobs` | Primary work unit per tenant |
| `crawl_tasks` | FK to `jobs`, transitively scoped |
| `raw_pages` | Content hash + blob ref |
| `extractions` | LLM output per page |
| `entities` | Deduplicated objects |
| `entity_sources` | Junction: `entity_id` + `extraction_id` (no direct `tenant_id` — FK chain via `entities`) |
| `actions` | Schema evolution proposals |
| `source_trust` | Per-domain trust scores |
| `exports` | Export jobs + blob ref |
| `schemas` | Versioned schema definitions |
| `api_keys` | Per-tenant access credentials |
| `llm_usage` | Token/cost metering |
| `dead_letter_queue` | Failed BullMQ jobs (`tenant_id` nullable — set null on tenant delete) |
| `audit_log` | Append-only event ledger (`tenant_id` nullable — nulled on tenant delete per D-08) |

---

## Authentication

See [`docs/api-auth.md`](api-auth.md) for the full reference. Summary:

| Strategy | `AUTH_STRATEGY` value | Use case |
|----------|----------------------|----------|
| `NoAuth` | `none` | Local dev only — **never production** |
| API key | `api-key` | CLI, CI, machine-to-machine |
| JWT-OIDC | `jwt` | Browser apps, SSO |

All three strategies resolve to a `{ tenantId, scopes }` tuple stored on the Hono context. Downstream code only sees `tenantId` — it never knows which strategy was used.

---

## Authorization and scopes

API keys carry an explicit `scopes: text[]` list. Scopes are checked by the `requireScope(scope)` middleware helper before route handlers execute.

**Scope catalog:**

| Scope | Grants |
|-------|--------|
| `jobs:read` | List/get jobs, tasks, raw pages |
| `jobs:write` | Create/update/cancel jobs |
| `extractions:read` | Read extraction results |
| `extractions:write` | Trigger re-extraction |
| `exports:read` | Download export files |
| `exports:write` | Create export jobs |
| `admin` | All of the above + tenant management endpoints |

Default scopes for a new key: `jobs:read jobs:write extractions:read exports:read exports:write`.

---

## API key lifecycle

1. **Creation:** Raw key generated with `crypto.randomBytes(32)`, hex-encoded, prefixed `sk_live_`. SHA-256 hash stored in `api_keys.key_hash`. Raw key returned exactly once.
2. **Verification:** On each request, server re-hashes the Bearer value and compares to stored hash.
3. **Rotation:** Delete existing key, create new key, update callers. No grace period — old key is invalid immediately on deletion.
4. **Deletion:** `DELETE /api/v1/api-keys/:id`. Row removed from `api_keys`; all subsequent requests using the old raw key return 401.

---

## Audit log

The `audit_log` table is the tamper-evident ledger for security-relevant events. Design invariants:

- **Append-only:** No `UPDATE` or `DELETE` endpoint exists for `audit_log`.
- **Tenant-linked:** `tenant_id` FK (nullable) links events to the owning tenant while the tenant exists.
- **PII field:** `ip_address` and `metadata` may contain PII. These are redacted (set to `NULL` / `{}`) on DSR deletion (D-08).
- **Tombstone on deletion:** When a tenant is deleted, one un-redacted `tenant.deleted` row is inserted with `tenant_id = NULL` and `resource_id = <deletedTenantId>` — proving deletion occurred even after the tenant row is gone.
- **actor_id = '[deleted]'** after redaction: signals that the audit record was sanitized and the real actor identity has been removed.

**Querying tombstones:**
```sql
SELECT * FROM audit_log
WHERE tenant_id IS NULL
  AND action = 'tenant.deleted'
  AND resource_id = '<tenantId>';
```

---

## Content-store blob security

Blobs are stored in the `content_store` table via `PgContentStore`. Each blob has a `key` (human-readable path) and an `id` (UUID, referenced as `pg://<uuid>`).

Key naming convention enforces tenant isolation:
```
raw-pages/<tenantId>/<pageId>.html
forensic/<tenantId>/extraction-<extractionId>.json
exports/<tenantId>/<exportId>.jsonl
```

The `content_ref` column in `raw_pages` / `exports` stores the `pg://<uuid>` ref, not the key. API routes that return blob content resolve the ref via `PgContentStore.get(ref)` — only after the caller's `tenantId` is verified to own the row.

On tenant deletion, blobs are swept by key prefix using `listKeys(prefix)` + `delete(ref)` (see [DSR deletion](#dsr-deletion-sec-09)).

---

## DSR: deletion (SEC-09)

Full implementation: `packages/db/src/repositories/tenant-data-repository.ts` + `packages/queue/src/workers/tenant-delete-worker.ts`.

Operator runbook: [`docs/runbooks/dsr-rectification.md`](runbooks/dsr-rectification.md).

### Deletion cascade order (FK-safe)

```
entity_sources  →  entities  →  actions  →  extractions
→  source_trust  →  raw_pages  →  exports  →  schemas
→  crawl_tasks  →  jobs  →  llm_usage  →  api_keys
→  user_tenants  →  dead_letter_queue
```

Then: `redactTenantAuditLog` (nulls `tenant_id`, clears PII, sets `actor_id='[deleted]'`)
Then: content-store blob sweep (raw-pages, exports, forensic)
Then: `insertDeletionTombstone` (un-redacted `tenant.deleted` row)
Then: `DELETE FROM tenants WHERE id = ?`

### Idempotency

All operations are safe to re-run: `DELETE` on already-empty tables is a no-op, `UPDATE` on already-redacted rows writes the same values, blob delete on missing refs is silently skipped.

### Proof of deletion

The tombstone row in `audit_log` (action = `tenant.deleted`, `tenant_id IS NULL`, `resource_id = <tenantId>`) serves as legal proof of erasure.

---

## DSR: portability (SEC-10)

Full implementation: `TenantDataRepository.importTenantData` + `GET /api/v1/admin/tenants/:id/export` + `spatula admin tenant export/import` CLI commands.

### Export

`GET /api/v1/admin/tenants/:id/export?format=jsonl` returns a JSONL dump with one line per table. Each line: `{ "table": "<name>", "rows": [...] }`.

Currently exported tables: `api_keys` (the primary credential resource).

### Import

`POST /api/v1/admin/tenants/:id/import` accepts the same JSONL format. Server-side: `TenantDataRepository.importTenantData(targetTenantId, dump)`.

**Security invariant:** All imported rows have `tenantId` overridden to the *target* tenant — the dump's embedded tenant values are ignored. This prevents a dump from one tenant being replayed into another.

**Idempotency:** Duplicate primary keys (23505) are silently skipped. Running import twice produces the same result as running it once.

### CLI

```
spatula admin tenant export --tenant <id> --out dump.jsonl
spatula admin tenant import --tenant <id> --in dump.jsonl
spatula admin tenant delete --tenant <id> [--yes]
```

---

## Secret management

| Secret | Where stored | Rotation |
|--------|-------------|----------|
| `DATABASE_URL` | Environment variable / secret store | Manual, per-deploy |
| `REDIS_URL` | Environment variable / secret store | Manual, per-deploy |
| `JWT_JWKS_URL` / `JWT_ISSUER` | Environment variable | OIDC provider rotation |
| `OPENROUTER_API_KEY` | Environment variable | Manual, per-billing cycle |
| API keys (raw) | Shown to user once, never stored | User-driven rotation |

No secrets are committed to the repository. `.env` files are gitignored.

---

## Rate limiting and abuse prevention

API-level rate limiting is enforced at the ingress/gateway layer (not documented here — see infrastructure runbooks). Application-level safeguards:

- Job creation: maximum concurrent jobs per tenant is enforced by the job service (`quotas.maxConcurrentJobs` on the `tenants` row).
- LLM token usage: tracked in `llm_usage` per job; quota enforcement is in the roadmap.

---

## Dependency and supply chain

- All dependencies are pinned in `pnpm-lock.yaml`.
- `pnpm audit` runs in CI on every PR targeting `main`.
- No external HTTP calls are made at import time (LLM, crawler, JWKS are all runtime-only, behind interfaces).

---

## Security contacts

Report vulnerabilities to: security@spatula.dev (or via GitHub private advisory on the public repo).

Response SLA: acknowledgement within 48 hours, patch timeline communicated within 7 days.
