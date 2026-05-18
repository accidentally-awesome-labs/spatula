# tests/private-contract

**Reverse-contract test suite.** This suite freezes the TypeScript + SQL surface
that the (private) `accidentally-awesome-labs/spatula-saas` repo consumes from
this OSS monorepo. It runs on every PR and fails the build when a consumed
symbol is silently removed or renamed.

This is **not** a test of OSS behavior — that's covered by the per-package
unit suites and `tests/carveout/` (forward contract). This suite asks the
narrower question: "does the surface the private consumer reaches for still
exist with the same shape?"

## How to run

### Locally

```bash
# TS-surface test only (no database needed)
pnpm exec vitest run --config tests/private-contract/vitest.config.ts \
  tests/private-contract/oss-surface.test.ts

# Full suite (TS surface + SQL schema lint) — requires Postgres on localhost:5432
createdb -h localhost -U spatula spatula_private_contract_test 2>/dev/null || true
TEST_DATABASE_URL="postgresql://spatula:spatula@localhost:5432/spatula_private_contract_test" \
  pnpm exec vitest run --config tests/private-contract/vitest.config.ts
dropdb -h localhost -U spatula spatula_private_contract_test
```

The TS-surface test runs without any database; the schema-lint sibling test
requires a fresh empty Postgres so it can apply `packages/db/drizzle/
0000_v1_baseline.sql` and snapshot the result.

### In CI

Wired into `.github/workflows/ci.yml` as a step that runs on every PR push
(per CONTEXT.md D-04 cadence). No manual cron, no nightly job — the PR-time
gate is the merge gate.

## What this catches

- **Renamed exports.** Renaming `processCrawlTask` → `runCrawlTask` in
  `@spatula/core` makes the destructure at the top of `oss-surface.test.ts`
  throw at import time; the PR turns red.
- **Removed exports.** Deleting `JobManager` from `@spatula/queue` does the
  same thing.
- **Changed kind.** Turning `DEFAULT_RATE_LIMIT` from an object into a function
  fails the `typeof` assertion.
- **Accidentally re-introduced billing/stripe symbols.** If a future PR adds
  `BILLING_TIERS` back to `@spatula/shared` (or a `usageRecord*` to `@spatula/
db`), the negative-filter describe at the bottom of `oss-surface.test.ts`
  flags it.
- **Adding a new export with a forbidden name.** Same filter — anything
  matching `/stripe|billing|quotaEnforcer|usageRecord|metering/i` is flagged.

## What this does NOT catch

- **Runtime-behavior drift.** A function whose signature is unchanged but
  whose semantics shift (returns different shape, swallows different errors,
  changes side-effect order) passes this test unscathed. That's an
  acknowledged residual risk; spatula-saas's own integration suite owns
  behavioral pinning.
- **SQL FK / RLS / trigger changes.** The TS-surface test is type-shape only.
  The sibling `schema-lint.test.ts` covers tables / columns / FKs / indexes,
  but RLS policy changes and trigger-function changes are an
  introspection-coverage gap — documented in `docs/private-contract.md` as a
  residual risk (created by Plan 15-06).
- **Type-shape (parameter / return) drift inside an unchanged symbol.** TypeScript
  catches this at saas-side build time; this test only asserts presence and
  `typeof`. A consumer-side `tsc` step is the catch-all for type drift.

## When something fails

1. **Identify which describe block failed** — it tells you which package's
   surface drifted.
2. **Open a mirror PR** in `accidentally-awesome-labs/spatula-saas` that
   updates its consumer to the new surface.
3. **Label the OSS PR** `private-contract-change` so reviewers know to wait
   for the spatula-saas mirror PR to land.
4. **Reference the spatula-saas PR** in the OSS PR description.
5. **Update this test** to the new surface as part of the OSS PR.

For SQL schema changes specifically, see the `SQL schema lint` section below.

## SQL schema lint (`schema-lint.test.ts`)

Applies `packages/db/drizzle/0000_v1_baseline.sql` to an ephemeral Postgres via
`pnpm --filter @spatula/db exec tsx src/run-migrate.ts` (which honors the
namespaced `__drizzle_migrations_oss` journal from Plan 15-04), runs `pg_dump
--schema-only --no-owner --no-acl` against the result, pipes through
`scripts/normalize-schema-dump.sh` (the Wave-4 normalizer that strips pg_dump
14+ `\restrict`/`\unrestrict` random tokens + preamble + journal-row noise),
and asserts the output equals `tests/private-contract/baseline.schema.sql`
byte-for-byte.

**Why pg_dump and not `drizzle-kit introspect`?** Per CONTEXT.md D-03 the
planner chose between the two. We picked pg_dump because:

1. It reuses the Wave-4 normalizer (already battle-tested for `\restrict`
   token noise and journal-row stripping)
2. pg_dump output is human-readable SQL — PR diffs against `baseline.schema.sql`
   tell a reviewer "you added a column" in plain text
3. drizzle-kit introspect's JSON output shape is undocumented and varies
   across drizzle-kit versions — fragile across minor upgrades
4. Plan 15-04 already uses pg_dump as the authoritative ground truth for the
   migration-equivalence gate — same tool, same normalizer, one consistent
   story

**This catches:** table additions / removals, column additions / removals /
type changes, FK changes, index additions / removals, constraint changes
(including CHECK constraints from `0000_v1_baseline.sql`), enum-type changes,
sequence changes.

**This does NOT catch:**

- RLS (Row-Level Security) policy changes — pg_dump emits them as `ALTER TABLE
... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` statements, but the OSS
  schema doesn't use RLS today; if added later, the normalizer + baseline
  pick them up automatically.
- Trigger-function semantics — pg_dump emits the trigger declaration and the
  function body, so signature changes ARE caught; runtime semantic drift
  inside an unchanged function body is NOT.
- Database-level grants / roles — stripped by `--no-acl`.
- Migration-journal state — stripped by the normalizer.

### Updating the baseline after an intentional schema change

1. Apply your schema change in `packages/db/src/schema/*.ts` (or hand-edit
   `packages/db/drizzle/0000_v1_baseline.sql` if it's a raw-SQL change like
   the CHECK constraints from Plan 15-04).
2. Apply the migration to a fresh empty Postgres:
   ```bash
   createdb -h localhost -U spatula spatula_baseline_regen
   DATABASE_URL="postgresql://spatula:spatula@localhost:5432/spatula_baseline_regen" \
     pnpm --filter @spatula/db exec tsx src/run-migrate.ts
   ```
3. Regenerate `baseline.schema.sql`:
   ```bash
   pg_dump --schema-only --no-owner --no-acl \
     "postgresql://spatula:spatula@localhost:5432/spatula_baseline_regen" \
     | bash scripts/normalize-schema-dump.sh \
     > tests/private-contract/baseline.schema.sql
   dropdb -h localhost -U spatula spatula_baseline_regen
   ```
4. Open a mirror PR in `accidentally-awesome-labs/spatula-saas` that adapts
   the consumer to the new schema (column rename → consumer query update, FK
   drop → consumer relation handling update, etc.).
5. Reference the spatula-saas PR in the OSS PR description and label the OSS
   PR `private-contract-change`.
6. Commit the regenerated `baseline.schema.sql` in the OSS PR alongside the
   schema change.
