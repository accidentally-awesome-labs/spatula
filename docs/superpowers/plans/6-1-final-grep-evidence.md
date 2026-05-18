# Phase 15 Plan 15-06 Task 4 — Final CARVE-04 Grep Gate Evidence

**Date:** 2026-05-17
**Branch:** `feat/wave-6-1-carveout`
**Phase:** 15 (carveout-migration-squash) Plan 15-06
**Verifier:** gsd-executor (Task 4)
**Result:** PASS — all three CARVE-04 grep scopes return zero hits.

This file is the permanent audit record of the ROADMAP Phase 15 success criterion #4 final gate.

---

## Scope 1 — Primary (apps/api + packages/db + packages/queue + .env.example)

**Command (verbatim from ROADMAP success #4):**

```bash
git grep -inE 'stripe|billing|usage_records|plan: ' \
  -- 'apps/api/**' 'packages/db/**' 'packages/queue/**' '.env.example' \
  | grep -v 'apps/api/src/routes/usage.ts' \
  | grep -v 'apps/api/src/services/usage-recorder.ts' \
  | grep -v 'packages/core/src/llm/' \
  | grep -v 'docs/superpowers/'
```

**Result:** **0 matches** (after the Task-4 fixes documented in Deviations below).

---

## Scope 2 — OpenAPI seed fixtures (apps/api/src/schemas + tests/e2e/fixtures)

**Command:**

```bash
git grep -inE 'stripe|billing|usage_records|plan: ' -- 'apps/api/src/schemas/**' 'tests/e2e/fixtures/**'
```

**Result:** **0 matches** (`fixtures clean`).

---

## Scope 3 — Architecture doc (docs/architecture.md)

**Command:**

```bash
git grep -inE 'stripe|billing|usage_records' -- 'docs/architecture.md'
```

**Result:** **0 matches** (`architecture clean`).

---

## Deviations (auto-fixed during Task 4)

The initial Task 4 grep returned 5 hits. Each was triaged and fixed:

| #   | File                                         | Line    | Type              | Fix                                                                                                                                                                                                                                                                                                                         | Rule                             |
| --- | -------------------------------------------- | ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | `apps/api/package.json`                      | 42      | **Real residue**  | Dropped `"stripe": "^22.0.0"` dep (no `stripe` imports remain in apps/api/src or tests — confirmed by `grep -rn "from 'stripe'"`). Re-ran `pnpm install` + `pnpm --filter @spatula/api build` → exit 0                                                                                                                      | Rule 1 (bug — left-over SDK dep) |
| 2   | `apps/api/src/app.ts`                        | 129     | Negation comment  | Rewrote `// Auth introspection — replaces the CLI's billing-subscription probe` → `// Auth introspection endpoint — see apps/api/src/routes/auth.ts`                                                                                                                                                                        | Rewrite per plan's case (b)      |
| 3   | `apps/api/src/routes/auth.ts`                | 10      | Negation comment  | Rewrote `// ...Replaces the pre-carve GET /api/v1/billing/subscription probe.` → `// ...This is the canonical auth-introspection endpoint as of v1.1.`                                                                                                                                                                      | Rewrite per plan's case (b)      |
| 4   | `apps/api/tests/unit/routes/exports.test.ts` | 207-214 | Negation comments | Rewrote `describe('export format availability (post-carveout: no plan gating)', ...)` → `'no tier gating'`; rewrote `it('...billing gating removed)')` → `'tier gating removed'`; rewrote inline comment `// All formats now available — no billing tier check` → `// All formats now available — no per-tier feature gate` | Rewrite per plan's case (b)      |

**Test impact:** `pnpm --filter @spatula/api test -- --run tests/unit/routes/exports.test.ts` exits 0 (15/15 pass). `pnpm --filter @spatula/api test -- --run tests/unit/routes/auth.test.ts` exits 0 (3/3 pass). `pnpm --filter @spatula/api build` exits 0.

---

## ROADMAP success criterion #4 — VERIFIED GREEN

> #4. `git grep -i 'stripe\|billing\|usage_records\|plan: '` returns zero hits under `apps/api/`, `packages/db/`, `packages/queue/`, `.env.example`, and OpenAPI seed fixtures; `docs/architecture.md` republished with the new dependency diagram and zero billing mentions.

All four sub-conditions of success criterion #4 are satisfied as of branch tip after the Task 4 commit.
