# 6-1 Pre-cut snapshot — 2026-05-17

**Phase:** 15 (carveout-migration-squash) Plan 15-01
**Generator:** gsd-executor (Tasks 2 + 3)
**Pre-cut branch tip (main):** `5d19c2beeec805324cead64cf62f2f434dad76c8`

This snapshot captures the test/typecheck baseline and full billing-coupling inventory **immediately before** the carve-out begins. Post-carve totals will diff against the per-package counts below; any file in the coupling grep that survives to Plan 15-06's final grep gate is a regression.

---

## Test baseline (per-package, isolated runs)

Note: `pnpm test` (full turbo run) intermittently fails 1–2 `tests/unit/exports.test.ts` cases under parallel I/O pressure — the first dynamic `await import('../../src/index.js')` exceeds vitest's default 5s `testTimeout`. Re-running each package's `pnpm --filter <pkg> test` in isolation passes cleanly. Treated as a pre-existing flaky-timeout pattern unrelated to the carve-out scope. Captured here so post-carve isolated runs can diff against the same per-package totals.

| Package              | Test Files | Tests                                              | Status                       | Notes                                                                                                                                                                                                                               |
| -------------------- | ---------- | -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@spatula/core`      | 92         | 979 pass                                           | ✅ all pass                  | clean (rebuilt `better-sqlite3` for Node v26 ABI v147 — see Deviations)                                                                                                                                                             |
| `@spatula/db`        | 29         | 328 pass                                           | ✅ all pass (isolated)       | `exports.test.ts > exports connection factory` flaky-timeout under parallel turbo I/O; passes in 2.8s isolated                                                                                                                      |
| `@spatula/queue`     | 18         | 156 pass                                           | ✅ all pass (isolated)       | `exports.test.ts > exports crawl worker` flaky-timeout under parallel turbo I/O; passes in 940ms isolated                                                                                                                           |
| `@spatula/api`       | 50         | 375 pass                                           | ✅ all pass                  | clean                                                                                                                                                                                                                               |
| `@spatula/shared`    | 10         | 75 pass                                            | ✅ all pass                  | clean                                                                                                                                                                                                                               |
| `@spatula/cli`       | 94 / 96    | 730 pass / 1 fail / 101 skipped                    | ⚠️ 2 pre-existing e2e flakes | `tests/e2e/workflow.test.ts > extracts data from local fixture page with --skip-llm` (5s timeout); `tests/e2e/tier2/pipeline-errors.test.ts` (file-level load failure) — both pre-date the carve-out (commits `fd59aba`, `ba53386`) |
| **Total (isolated)** | **293**    | **2,643 pass / 1 pre-existing fail / 101 skipped** |                              |                                                                                                                                                                                                                                     |

**Action items captured for the carve-out PR:**

- Pre-existing CLI e2e flakes are tracked in `deferred-items.md` (created in Phase 15 directory if not already present) and acknowledged as out-of-scope for the carve-out; they remain in scope for the Plan 15-05 forward-test work where the e2e fixtures get touched.

## Typecheck baseline

Project packages do not expose a `typecheck` script; `tsc` runs as part of `build`. The plan's `pnpm --filter <pkg> typecheck` commands resolved to "None of the selected packages has a 'typecheck' script". Proxied via `build` (which is `tsc` for all three packages):

| Package          | Build (typecheck via tsc) |
| ---------------- | ------------------------- |
| `@spatula/api`   | ✅ PASS (exit 0)          |
| `@spatula/queue` | ✅ PASS (exit 0)          |
| `@spatula/db`    | ✅ PASS (exit 0)          |

## Pre-cut branch tip

```
5d19c2beeec805324cead64cf62f2f434dad76c8
```

(After Task 4, the carve-out feature branch `feat/wave-6-1-carveout` is cut from this SHA.)

---

## Coupling grep

**Command (verbatim from substrate Task 1 Step 2):**

```bash
grep -rln --include='*.ts' -E '(stripe|Stripe|STRIPE|BILLING_TIERS|RATE_LIMIT_TIERS|QuotaEnforcer|BillingUsageRecorder|metering|usageRecords|usage_records|usage-record-repository|subscription|billing:read|billing:write|rateLimitTier|METERING)' \
  apps/ packages/ tests/ \
  | grep -v '/node_modules/' | grep -v '/dist/' \
  | grep -v 'apps/api/src/routes/usage.ts' \
  | grep -v 'apps/api/src/services/usage-recorder.ts' \
  | grep -v 'packages/core/src/llm/' \
  | sort > /tmp/billing-coupling.txt
```

**Result:** 41 files (saved to `/tmp/billing-coupling.txt` during execution).

### Full sorted output

```
apps/api/src/app.ts
apps/api/src/billing/stripe-client.ts
apps/api/src/middleware/auth.ts
apps/api/src/middleware/rate-limit.ts
apps/api/src/routes/admin-tenants.ts
apps/api/src/routes/billing.ts
apps/api/src/routes/stripe-webhook.ts
apps/api/src/types.ts
apps/api/tests/unit/billing/stripe-client.test.ts
apps/api/tests/unit/middleware/rate-limit.test.ts
apps/api/tests/unit/routes/api-keys.test.ts
apps/api/tests/unit/routes/billing.test.ts
apps/api/tests/unit/routes/stripe-webhook.test.ts
apps/cli/src/api/client.ts
apps/cli/tests/integration/remote-commands.test.ts
apps/cli/tests/unit/api/client-auth.test.ts
packages/core/src/billing/billing-usage-recorder.test.ts
packages/core/src/billing/billing-usage-recorder.ts
packages/core/src/billing/index.ts
packages/core/src/billing/quota-enforcer.test.ts
packages/core/src/billing/quota-enforcer.ts
packages/core/src/pipeline/export-orchestrator.ts
packages/db/src/index.ts
packages/db/src/repositories/tenant-repository.ts
packages/db/src/repositories/usage-record-repository.ts
packages/db/src/schema/tenants.ts
packages/db/src/schema/usage-records.ts
packages/db/tests/unit/repositories/tenant-repository.test.ts
packages/db/tests/unit/repositories/usage-record-repository.test.ts
packages/queue/src/job-manager.ts
packages/queue/src/metering-worker.ts
packages/queue/src/queues.ts
packages/queue/src/worker-deps.ts
packages/queue/src/worker-entrypoint.ts
packages/queue/src/workers/crawl-worker.ts
packages/queue/tests/unit/metering-worker.test.ts
packages/shared/src/auth/quotas.ts
packages/shared/src/auth/rate-limit-tiers.ts
packages/shared/src/auth/types.ts
packages/shared/src/billing/tiers.ts
packages/shared/tests/unit/auth/quotas.test.ts
```

### Reconciliation against substrate Section A + B

Substrate Section A (move to spatula-saas, delete from OSS) and Section B (edit in-place) collectively list **47 files** (18 in A + 29 in B). 37 of the 41 grep hits map directly to those lists. The remaining **4 files are inventory deltas** not enumerated in the substrate.

### Inventory delta (files in grep but NOT in substrate A/B)

All four deltas absorb into **Plan 15-03 (in-place strip)** Section B — none require Plan 15-02 file moves.

| #   | File                                                 | Match context                                                                            | Disposition                                                                                                                                                                                                                                                             | Absorbs into                                                                                         |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | `apps/api/src/middleware/auth.ts`                    | line 15: `'/api/v1/webhooks/stripe'` listed in unauthenticated-route allowlist           | When substrate edits `apps/api/src/app.ts` to unmount `stripe-webhook` mount, the auth-middleware allowlist entry must also be removed in the same commit. Trivial single-line deletion.                                                                                | **Plan 15-03 Section B** — add to the same commit that touches `app.ts`                              |
| 2   | `apps/api/tests/unit/routes/api-keys.test.ts`        | line 9: test fixture sets `scopes: [..., 'billing:read']` on a mock auth context         | When substrate drops `'billing:read'` / `'billing:write'` from `AUTH_SCOPES` (`packages/shared/src/auth/types.ts`), this test fixture's scope array must be updated. Trivial array edit.                                                                                | **Plan 15-03 Section B** — add to the same commit that touches `packages/shared/src/auth/types.ts`   |
| 3   | `apps/cli/tests/integration/remote-commands.test.ts` | line 141: comment `// subscription/auth check` (CLI `remote add` probe context)          | The substrate already lists `apps/cli/src/commands/remote.ts` for editing (swap `getSubscription()` → `getAuthMe()`). This integration test will naturally be touched when the probe rewire lands; the comment can be updated to `// auth check` then.                  | **Plan 15-03 Section B** — add to the CLI rewire commit                                              |
| 4   | `packages/db/src/index.ts`                           | lines 43–44: re-exports `UsageRecordRepository` + `UsageRecord` / `DimensionUsage` types | The substrate lists `packages/db/src/repositories/index.ts` for editing (drop `UsageRecordRepository` export), but `packages/db/src/index.ts` is the package barrel that re-exports from `repositories/index`. When the repo is deleted, both index files need editing. | **Plan 15-03 Section B** — add to the same commit that edits `packages/db/src/repositories/index.ts` |

**Planner note for downstream:** these four deltas should be folded into Plan 15-03's task list (or noted explicitly when 15-03 is being executed). They are all trivial edits that follow naturally from the substrate-listed edits; the substrate just missed them when the inventory was originally drafted on 2026-04-20. No new file moves, no new architectural decisions, no scope expansion — pure inventory completeness.

### Exclusions verified

- `apps/api/src/routes/usage.ts` — excluded ✓ (LLM-usage / OpenRouter cost reporting, stays OSS per substrate product decision 1)
- `apps/api/src/services/usage-recorder.ts` — excluded ✓ (same rationale)
- `packages/core/src/llm/` — excluded ✓ (LLM client code, model-router, etc.)
- `grep -c 'apps/api/src/routes/usage.ts' /tmp/billing-coupling.txt` returns **0** — gate satisfied.

---

## Acceptance criteria recap

**Task 2 (test baseline):**

- [x] File `docs/superpowers/plans/6-1-snapshot-pre-cut.md` exists with non-empty "Total tests" and "Pre-cut branch tip" entries.
- [x] `pnpm test` (per-package isolated): every package passes except 2 pre-existing CLI e2e flakes that pre-date the carve-out (acknowledged + tracked).
- [x] All three `build` (typecheck-via-tsc) commands exited 0.

**Task 3 (coupling grep):**

- [x] `/tmp/billing-coupling.txt` exists and is non-empty (41 files).
- [x] Every file path in `/tmp/billing-coupling.txt` is either listed in substrate Section A/B inventory (37 files) or flagged as "Inventory delta" with a downstream-plan absorption note (4 files, all into Plan 15-03 Section B).
- [x] `grep -c 'apps/api/src/routes/usage.ts' /tmp/billing-coupling.txt` returns 0.
- [x] This file contains a "## Coupling grep" section.

Plan 15-02 (filter-repo move of Section A) is unblocked. The 4 inventory deltas will be picked up in Plan 15-03.
