# DSR Runbook: Deletion, Export, Rectification

> Operator runbook for processing Data Subject Rights (DSR) requests:
> tenant deletion (erasure), data export (portability), and data rectification.
>
> Engineering reference: [`docs/security-model.md`](../security-model.md)
> Privacy reference: [`docs/privacy.md`](../privacy.md)

---

## Prerequisites

- Spatula CLI installed and authenticated: `spatula --version`
- Admin API key with `admin` scope
- `SPATULA_REMOTE` environment variable or `--remote` flag pointing to your API instance
- Database access (for verification queries if needed)

```bash
export SPATULA_REMOTE=https://api.your-spatula-instance.example
```

---

## 1. Tenant deletion (right to erasure)

Use when a tenant requests complete data deletion. The deletion is **irreversible**.

### Step 1 — Verify the tenant ID

Confirm the tenant ID before proceeding. Tenant IDs are UUIDs.

```bash
# Via API
curl -H "Authorization: Bearer $SPATULA_API_KEY" \
     "$SPATULA_REMOTE/api/v1/admin/tenants/$TENANT_ID"
```

### Step 2 — Export a backup (optional but recommended)

Before deletion, export the tenant's data for your records:

```bash
spatula admin tenant export \
  --tenant "$TENANT_ID" \
  --out "backup-${TENANT_ID}-$(date +%Y%m%d).jsonl" \
  --remote "$SPATULA_REMOTE"
```

Store the backup securely. The deletion cannot be undone.

### Step 3 — Run the deletion

```bash
spatula admin tenant delete \
  --tenant "$TENANT_ID" \
  --yes \
  --remote "$SPATULA_REMOTE"
```

`--yes` skips the interactive confirmation prompt. Omit it to confirm interactively.

The CLI polls until the background job completes. Expected output:

```
Deleting tenant <id>...
Job <jobId> status: active
Job <jobId> status: active
Tenant deleted successfully.
```

### Step 4 — Verify deletion

```bash
# Should return 404
curl -H "Authorization: Bearer $SPATULA_API_KEY" \
     "$SPATULA_REMOTE/api/v1/admin/tenants/$TENANT_ID"
```

**Database verification (optional):**

```sql
-- All of these should return 0
SELECT COUNT(*) FROM jobs            WHERE tenant_id = '<tenantId>'::uuid;
SELECT COUNT(*) FROM api_keys        WHERE tenant_id = '<tenantId>'::uuid;
SELECT COUNT(*) FROM extractions     WHERE tenant_id = '<tenantId>'::uuid;
SELECT COUNT(*) FROM entities        WHERE tenant_id = '<tenantId>'::uuid;
SELECT COUNT(*) FROM content_store   WHERE key LIKE 'raw-pages/<tenantId>/%';
SELECT COUNT(*) FROM content_store   WHERE key LIKE 'exports/<tenantId>/%';
SELECT COUNT(*) FROM content_store   WHERE key LIKE 'forensic/<tenantId>/%';

-- Tombstone should exist (proves deletion happened)
SELECT id, action, resource_id, actor_id, metadata
FROM audit_log
WHERE tenant_id IS NULL
  AND action = 'tenant.deleted'
  AND resource_id = '<tenantId>';

-- Tenant row should be gone
SELECT id FROM tenants WHERE id = '<tenantId>'::uuid;
```

### What gets deleted

| Resource | What happens |
|----------|-------------|
| `jobs`, `crawl_tasks`, `raw_pages`, `extractions`, `entities`, `entity_sources` | Deleted |
| `actions`, `source_trust`, `exports`, `schemas` | Deleted |
| `api_keys`, `llm_usage`, `user_tenants` | Deleted |
| `dead_letter_queue` rows for this tenant | Deleted |
| Content-store blobs (`raw-pages/`, `exports/`, `forensic/`) | Deleted |
| `audit_log` rows | PII redacted in place (`ip_address=NULL`, `metadata={}`, `actor_id='[deleted]'`, `tenant_id=NULL`) — rows NOT deleted (D-08) |
| `audit_log` tombstone | Created: `tenant.deleted` row with `tenant_id=NULL`, `resource_id=<tenantId>` |
| `tenants` row | Deleted (final step) |

### Timing

Deletion runs as an async BullMQ job. The CLI polls every 2 seconds. For large tenants (many GB of content-store blobs), deletion may take several minutes.

### Failure handling

If the deletion job fails (CLI exits non-zero):

1. Check job status: `GET /api/v1/jobs/<jobId>`
2. Check dead-letter queue for the failed job.
3. The cascade is idempotent — re-triggering deletion is safe. Already-deleted rows are no-ops.
4. Re-run: `spatula admin tenant delete --tenant "$TENANT_ID" --yes`

---

## 2. Data export (right to portability)

Use when a tenant requests a machine-readable copy of their data.

### Export via CLI

```bash
spatula admin tenant export \
  --tenant "$TENANT_ID" \
  --out "export-${TENANT_ID}.jsonl" \
  --remote "$SPATULA_REMOTE"
```

### Export via API

```bash
curl -H "Authorization: Bearer $SPATULA_API_KEY" \
     "$SPATULA_REMOTE/api/v1/admin/tenants/$TENANT_ID/export?format=jsonl" \
     -o "export-${TENANT_ID}.jsonl"
```

### JSONL format

Each line is a JSON object:
```json
{"table": "api_keys", "rows": [{"id": "...", "tenantId": "...", "keyHash": "...", "keyPrefix": "...", "name": "...", "scopes": ["read"]}]}
```

The file can be re-imported to a new Spatula tenant (see [3. Data import](#3-data-import-portability)).

### What is exported

Currently exported: `api_keys` (credential resources — the primary portable resource).

Full extraction/entity data is available via the standard API:
- `GET /api/v1/jobs` → list all jobs
- `GET /api/v1/jobs/:id/extractions` → extraction results
- `GET /api/v1/jobs/:id/export` → download a full data export

---

## 3. Data import (portability)

Use to restore exported data to the same or a different tenant. Useful after an erasure+re-creation cycle or for migrating between instances.

### Import via CLI

```bash
spatula admin tenant import \
  --tenant "$TARGET_TENANT_ID" \
  --in "export-${TENANT_ID}.jsonl" \
  --remote "$SPATULA_REMOTE"
```

### Import via API

```bash
curl -X POST \
     -H "Authorization: Bearer $SPATULA_API_KEY" \
     -H "Content-Type: application/x-ndjson" \
     --data-binary @"export-${TENANT_ID}.jsonl" \
     "$SPATULA_REMOTE/api/v1/admin/tenants/$TARGET_TENANT_ID/import"
```

### Security invariant

All imported rows have `tenantId` overridden to `$TARGET_TENANT_ID` — the dump's original tenant values are ignored. A dump from Tenant A cannot be replayed into Tenant B without your explicit intent to target Tenant B.

### Idempotency

Import is idempotent. Running the same dump twice produces the same result (duplicate keys are skipped). The response includes per-table insert counts:

```json
{"imported": {"api_keys": 3}}
```

A second import of the same dump returns `{"imported": {"api_keys": 0}}`.

---

## 4. Data rectification (right to correct)

Use when a data subject requests correction of inaccurate personal data.

### Correct tenant metadata

```bash
# Update tenant name via API
curl -X PATCH \
     -H "Authorization: Bearer $SPATULA_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"name": "Corrected Name"}' \
     "$SPATULA_REMOTE/api/v1/admin/tenants/$TENANT_ID"
```

### Correct crawled/extracted data

Crawled data is immutable by design — extractions reflect what was on the page at crawl time. To correct:

1. Re-run the job with updated configuration (corrected seed URLs, updated schema).
2. The new extraction overwrites or supplements the old extraction data.
3. If old extractions contain incorrect data that must be purged, delete and re-crawl:

```bash
# Cancel and delete the old job
curl -X DELETE \
     -H "Authorization: Bearer $SPATULA_API_KEY" \
     "$SPATULA_REMOTE/api/v1/jobs/$JOB_ID"

# Create a new job with corrected configuration
curl -X POST \
     -H "Authorization: Bearer $SPATULA_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"name": "Corrected Job", "seedUrls": [...], "description": "..."}' \
     "$SPATULA_REMOTE/api/v1/jobs"
```

### Audit log entries

Audit log entries cannot be modified (append-only by design). This is intentional: audit logs are evidence of what happened, and modifying them would undermine their legal value. If an audit entry contains incorrect PII (e.g., wrong IP address due to a proxy), document the correction in a new audit event rather than editing the original.

---

## 5. Incident response: DSR request timeline

Under GDPR, DSR requests must be responded to within 30 days (extendable to 90 days for complex requests).

| Day | Action |
|-----|--------|
| 0 | Receive DSR request. Log request ID, tenant ID, request type, timestamp. |
| 1 | Verify requester identity (confirm they are the tenant data controller). |
| 3 | Export backup if needed. Begin deletion/export/rectification procedure. |
| 5 | Verify completion (run database verification queries). |
| 7 | Respond to requester with confirmation + tombstone ID (for erasure requests). |
| 30 | Hard deadline for response (GDPR Art. 12(3)). |

---

## 6. Checklist: erasure request completion

Copy this checklist into your incident ticket:

```
[ ] Requester identity verified
[ ] Tenant ID confirmed (not a typo)
[ ] Pre-deletion backup exported and stored securely
[ ] `spatula admin tenant delete` executed successfully
[ ] CLI exited 0 (not with error)
[ ] API 404 verified for tenant endpoint
[ ] Tombstone query returns exactly 1 row
[ ] All table counts return 0 (job verification query above run)
[ ] Content-store blob counts return 0 (raw-pages + exports + forensic)
[ ] Confirmation sent to requester with tombstone row ID
[ ] Incident ticket closed
```
