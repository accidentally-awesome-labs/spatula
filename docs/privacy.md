# Privacy & Data Handling

> This document describes how Spatula handles personal data, what data is collected,
> how it is used, and the rights available to data subjects under GDPR and similar laws.
> Engineering reference: [`docs/security-model.md`](security-model.md).
> Operator runbook: [`docs/runbooks/dsr-rectification.md`](runbooks/dsr-rectification.md).

---

## Table of contents

1. [Data we collect](#data-we-collect)
2. [Data we do NOT collect](#data-we-do-not-collect)
3. [Retention periods](#retention-periods)
4. [Data subject rights (DSR)](#data-subject-rights-dsr)
5. [Lawful basis for processing](#lawful-basis-for-processing)
6. [Sub-processors](#sub-processors)
7. [Data residency](#data-residency)
8. [Telemetry and observability](#telemetry-and-observability)
9. [Self-hoster DSR obligations](#self-hoster-dsr-obligations)
10. [Breach notification](#breach-notification)
11. [Children's data](#childrens-data)
12. [Contact](#contact)

---

## Data we collect

Spatula collects data in two distinct contexts:

### 1. Tenant operator data

Data provided by operators (companies/developers) who use the Spatula API:

| Data                                  | Purpose                    | Stored where                               |
| ------------------------------------- | -------------------------- | ------------------------------------------ |
| Tenant name                           | Account identification     | `tenants.name`                             |
| API keys (hash only)                  | Authentication             | `api_keys.key_hash` (raw key never stored) |
| Job configuration (seed URLs, schema) | Crawl execution            | `jobs.config` (jsonb)                      |
| LLM usage statistics                  | Billing, quota enforcement | `llm_usage`                                |
| Audit events (actor IP, actor ID)     | Security, compliance       | `audit_log`                                |

### 2. Crawled web content

Data extracted from URLs provided by the operator:

| Data                          | Purpose                      | Stored where                                  |
| ----------------------------- | ---------------------------- | --------------------------------------------- |
| Raw HTML / page content       | Extraction source            | `content_store` (via `raw_pages.content_ref`) |
| Extracted structured data     | Operator's requested dataset | `extractions.data`, `entities.merged_data`    |
| Forensic extraction snapshots | Debugging, audit trail       | `content_store` (forensic/ prefix)            |
| Export files                  | Operator download            | `content_store` (exports/ prefix)             |

Crawled content belongs to the operator who configured the job. Spatula acts as a data processor (not controller) for crawled content.

---

## Data we do NOT collect

- End-user credentials or payment information (handled by the billing provider).
- Browser cookies or fingerprinting identifiers from end-users of operator applications.
- Any data beyond what is explicitly needed for the crawl + extraction pipeline.

---

## Retention periods

| Data category                                                 | Retention                                    | Basis                   |
| ------------------------------------------------------------- | -------------------------------------------- | ----------------------- |
| `jobs`, `crawl_tasks`, `raw_pages`, `extractions`, `entities` | Until tenant deletion request                | Contractual necessity   |
| `exports` (blobs)                                             | Until tenant deletion request                | Contractual necessity   |
| `api_keys`                                                    | Until revoked or tenant deleted              | Security                |
| `audit_log` rows                                              | Indefinite (PII redacted on tenant deletion) | Legal compliance (D-08) |
| Content-store blobs (`raw-pages/`, `exports/`, `forensic/`)   | Until tenant deletion request                | Contractual necessity   |
| Tombstone audit row (`tenant.deleted`)                        | Indefinite                                   | Legal proof of erasure  |

Operators may request earlier deletion at any time (see [DSR: erasure](#dsr-erasure-right-to-be-forgotten)).

---

## Data subject rights (DSR)

Spatula's DSR implementation satisfies GDPR Articles 15–20. Operators are the data controllers for crawled content; Spatula is the processor and provides the tools for operators to fulfill end-user DSR requests.

### DSR: Access (right to know)

Operators can retrieve all data for a tenant via:

```bash
spatula admin tenant export --tenant <id> --out dump.jsonl
# or
GET /api/v1/admin/tenants/:id/export?format=jsonl
```

The JSONL dump includes `api_keys` (the primary credential resource). Full extraction/entity data is available via the standard Jobs and Extractions API.

### DSR: Erasure (right to be forgotten)

Operators can submit a deletion request via:

```bash
spatula admin tenant delete --tenant <id> --yes
# or
DELETE /api/v1/admin/tenants/:id
```

The deletion pipeline (SEC-09):

1. Cascades deletion across all 14 tenant-scoped tables in FK-safe order.
2. Deletes all content-store blobs keyed under `raw-pages/<tenantId>/`, `exports/<tenantId>/`, `forensic/<tenantId>/`.
3. Redacts PII from `audit_log` rows (`ip_address = NULL`, `metadata = {}`, `actor_id = '[deleted]'`, `tenant_id = NULL`).
4. Inserts one un-redacted `tenant.deleted` tombstone row (legal proof of erasure).
5. Deletes the `tenants` row.

After deletion: no tenant data remains except the anonymized audit tombstone. The tombstone contains no PII — only the deleted tenant's UUID and the timestamp of deletion.

For step-by-step operator instructions, see [`docs/runbooks/dsr-rectification.md`](runbooks/dsr-rectification.md).

### DSR: Portability (right to data portability)

Export via the API or CLI (see DSR Access above). The JSONL format is machine-readable and can be imported into another Spatula instance:

```bash
spatula admin tenant import --tenant <id> --in dump.jsonl
```

Import is idempotent: re-running with the same dump produces the same result (duplicates are skipped). The security invariant ensures imported rows are always associated with the target tenant — a dump from one tenant cannot be replayed into another.

### DSR: Rectification (right to correct)

Operators can update tenant configuration and API key metadata via the standard API. For corrections to crawled content, operators re-run jobs with updated configurations. See [`docs/runbooks/dsr-rectification.md`](runbooks/dsr-rectification.md) for guided procedures.

---

## Lawful basis for processing

| Processing activity                          | Lawful basis                                          |
| -------------------------------------------- | ----------------------------------------------------- |
| Running crawl jobs on operator-provided URLs | Contract (API Terms of Service)                       |
| Storing audit log events                     | Legitimate interest (security), Legal obligation      |
| LLM API calls to process crawled content     | Contract                                              |
| Retention of tombstone after tenant deletion | Legal obligation (GDPR Art. 5(1)(e) — accountability) |

---

## Sub-processors

| Sub-processor                     | Purpose                                 | Data transferred                |
| --------------------------------- | --------------------------------------- | ------------------------------- |
| PostgreSQL (operator-chosen host) | Primary data storage                    | All tenant data                 |
| Redis (operator-chosen host)      | Job queue                               | Job payloads (may include URLs) |
| OpenRouter / LLM providers        | Content extraction and schema inference | Crawled page excerpts           |

Operators who are GDPR data controllers must ensure their chosen infrastructure providers have appropriate DPAs in place.

---

## Data residency

Spatula is infrastructure-agnostic. Data resides in the PostgreSQL and Redis instances configured by the operator. Operators are responsible for choosing infrastructure that meets their data residency requirements.

---

## Telemetry and observability

**Spatula sends no telemetry to Accidentally Awesome Labs or any third party.** There is no phone-home mechanism, no usage reporting, and no analytics beaconing built into the Spatula runtime. This is an unconditional guarantee, not a configuration option.

Spatula ships optional integrations for Sentry (error tracking) and OpenTelemetry (distributed tracing). These integrations are **operator-configured observability endpoints** — not Spatula telemetry. Specifically:

- If you configure `SENTRY_DSN`, error events flow to **your** Sentry project (a DSN you control), not to Accidentally Awesome Labs.
- If you configure `OTEL_EXPORTER_ENDPOINT`, trace and metric data flows to **your** collector (Grafana, Honeycomb, Jaeger, or any OTel-compatible backend you choose), not to Accidentally Awesome Labs.

Operators who choose not to configure these environment variables receive no observability data at all — which is the correct default for privacy-sensitive deployments.

---

## Self-hoster DSR obligations

When you self-host Spatula, you are the **data controller** for any personal data processed by your instance. Accidentally Awesome Labs has no access to your data and cannot fulfill data-subject requests on your behalf.

As a self-hosting data controller you must:

1. **Meet the 30-day GDPR erasure window.** When a data subject submits a right-to-erasure (right-to-be-forgotten) request, you must complete the deletion within 30 days as required by GDPR Article 17. Spatula's DSR deletion pipeline (`spatula admin tenant delete --tenant <id>`) provides the tooling; triggering it within the deadline is your responsibility.
2. **Fulfill access and portability requests.** Use `spatula admin tenant export` (or `GET /api/v1/admin/tenants/:id/export`) to produce a machine-readable JSONL dump in response to Article 15 (access) or Article 20 (portability) requests.
3. **Maintain a record of processing activities.** GDPR Article 30 requires controllers to maintain records of data processing activities. Your Spatula deployment processes crawled web content on behalf of (and directed by) operators; document this in your Article 30 register.

For step-by-step DSR procedures, see [`docs/runbooks/dsr-rectification.md`](runbooks/dsr-rectification.md).

---

## Breach notification

In the event of a suspected breach affecting tenant data:

1. Engineering on-call is notified within 1 hour of detection.
2. Affected tenants are notified within 72 hours (GDPR Art. 33/34 timeline).
3. A post-mortem is published internally within 14 days.

Report suspected breaches: security@spatula.dev.

---

## Children's data

Spatula's platform is not directed at children under 13 (COPPA) or under 16 (GDPR). Operators must not configure crawl jobs targeting content directed at children without appropriate safeguards.

---

## Contact

Data protection inquiries: privacy@spatula.dev

For operator-level DSR requests (deletion, export, rectification): use the CLI or API endpoints described above, or contact support@spatula.dev with your tenant ID.
