---
phase: 16-api-contract-sdk-packages
plan: 5
type: execute
wave: 4
depends_on:
  - 16-2
  - 16-3
files_modified:
  - release-please-config.json
  - .release-please-manifest.json
  - .github/workflows/release.yml
  - .github/workflows/release-dry-run.yml
  - apps/cli/package.json
  - apps/cli/tsup.config.ts
  - apps/cli/README.md
  - packages/core/README.md
  - packages/db/README.md
  - packages/queue/README.md
  - packages/api/README.md
  - packages/shared/README.md
  - packages/core/package.json
  - packages/db/package.json
  - packages/queue/package.json
  - packages/api/package.json
  - packages/shared/package.json
  - packages/client/README.md
  - packages/core-types/README.md
  - packages/db/bench/sqlite-comparison.ts
  - packages/db/bench/sqlite-comparison.results.md
  - packages/client/tests/integration/create-job.test.ts
  - packages/client/tests/integration/list-jobs.test.ts
  - packages/client/tests/integration/get-entities.test.ts
  - packages/client/tests/integration/get-job-events.test.ts
  - packages/client/tests/integration/version-probe.test.ts
  - packages/client/vitest.integration.config.ts
  - packages/client/package.json
  - docs/architecture.md
  - .planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md
  - .planning/phases/16-api-contract-sdk-packages/16-5-MIDPLAN-CHECKPOINT.md
autonomous: false
requirements:
  - SDK-04
  - SDK-05
  - SDK-06
  - SDK-07
  - SDK-08

must_haves:
  truths:
    - "BLOCK-04 is cleared before publish: npm @spatula org owned (verified) OR fallback scope chosen + documented"
    - "release-please-config.json includes all 8 packages with linked-versions plugin coupling @spatula/core-types and @spatula/client"
    - "node-workspace plugin has merge:false (Pitfall #3 protection)"
    - ".github/workflows/release.yml uses npm trusted publishing (id-token write at JOB level, NO NPM_TOKEN reference, provenance + access public)"
    - "release-please dry-run runs cleanly on a PR"
    - "@spatula/cli builds dual ESM+CJS via tsup; pnpm pack produces an installable tarball"
    - "5 internal packages (core, db, queue, api, shared) have a no-compat-guarantee notice in README.md"
    - "docs/architecture.md SQLite Backend Decision section contains FTS5 absence finding + decision (stay on better-sqlite3@12.10.0)"
    - "packages/client/tests/integration/ suite exercises 5 major endpoints; mocked by default; opt-in live via SPATULA_LIVE_LLM=1"
  artifacts:
    - path: ".planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md"
      provides: "BLOCK-04 verification evidence — npm org ls output OR fallback scope decision"
      contains: "BLOCK-04"
    - path: ".planning/phases/16-api-contract-sdk-packages/16-5-MIDPLAN-CHECKPOINT.md"
      provides: "Mid-plan checkpoint evidence — release-please dry-run output + release.yml permissions block + BLOCK-04 status snapshot (Task 5 of 16-5)"
      contains: "release-please"
    - path: "release-please-config.json"
      provides: "Monorepo manifest mode + linked-versions plugin + node-workspace merge:false"
      contains: "linked-versions"
    - path: ".github/workflows/release.yml"
      provides: "Trusted-publishing-OIDC publish job; per-package provenance + access public"
      contains: "id-token: write"
    - path: ".github/workflows/release-dry-run.yml"
      provides: "PR-time release-please dry-run; non-blocking"
      contains: "release-please"
    - path: "apps/cli/tsup.config.ts"
      provides: "Dual ESM+CJS bundler config for @spatula/cli publish prep"
      contains: "tsup"
    - path: "packages/db/bench/sqlite-comparison.ts"
      provides: "One-shot benchmark + FTS5 feature-gate check"
      contains: "better-sqlite3"
    - path: "docs/architecture.md"
      provides: "New SQLite Backend Decision section with benchmark numbers, FTS5 finding, decision to stay on better-sqlite3@12.10.0"
      contains: "SQLite Backend Decision"
    - path: "packages/client/tests/integration/version-probe.test.ts"
      provides: "Live integration of version-probe against running server"
      contains: "SPATULA_LIVE_LLM"
    - path: "packages/client/vitest.integration.config.ts"
      provides: "Integration test config; default mocked; live mode gated by SPATULA_LIVE_LLM=1"
      contains: "SPATULA_LIVE_LLM"
  key_links:
    - from: "release-please-config.json"
      to: "packages/core-types + packages/client"
      via: "linked-versions plugin groupName sdk-public components core-types, client"
      pattern: "linked-versions"
    - from: ".github/workflows/release.yml"
      to: "npm trusted publisher (per-package settings)"
      via: "id-token write + npm publish provenance access public"
      pattern: "id-token: write"
    - from: "apps/cli/package.json"
      to: "apps/cli/tsup.config.ts"
      via: "build script runs tsup producing dist/ with ESM + CJS + .d.ts outputs"
      pattern: "tsup"
    - from: "packages/db/bench/sqlite-comparison.ts"
      to: "docs/architecture.md SQLite Backend Decision"
      via: "Script output captured into doc; FTS5 gate documented"
      pattern: "FTS5"
---

<objective>
Land Phase 16's release infrastructure: clear BLOCK-04 (npm @spatula org or fallback), wire release-please for the 8-package manifest with @spatula/core-types and @spatula/client linked-versions, switch the release workflow to npm trusted publishing (id-token OIDC, provenance, access public; drop NPM_TOKEN), prep @spatula/cli for publish (tsup dual ESM+CJS, files allowlist, no postinstall), add the no-compat README header to every internal package, run the SQLite benchmark and commit the decision (stay on better-sqlite3 per the pre-decided FTS5-absent finding), and ship the SDK integration test suite (SDK-08) hitting every major endpoint with mocks by default and SPATULA_LIVE_LLM=1 opt-in.

Purpose: This is the wire-up plan. Code from plans 16-1..16-4 exists; this plan makes it publishable. After this plan lands, Phase 16's success criteria #3 (release-please dry-run publishes all 8 packages cleanly), #4 (SDK integration suite), and #6 (SQLite decision committed) are all met.

Output:
- Cleared BLOCK-04 (or documented fallback)
- release-please-config + release.yml + release-dry-run.yml fully wired
- @spatula/cli publish prep
- 5 internal-package READMEs with no-compat notice
- SQLite benchmark + decision in docs/architecture.md
- packages/client/tests/integration/ suite green (mocked) + opt-in live
- Plan is NOT autonomous — two checkpoints: (a) Task 1 BLOCK-04 verification, (b) Task 5 mid-plan release-infra checkpoint (after Tasks 1-4 complete, before Tasks 6-9 execute)
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<user_setup>
- service: npm
  why: "Publish all 8 @spatula/* scoped packages with provenance"
  env_vars: []
  account_setup:
    - "Own the npm @spatula org (BLOCK-04) OR commit to a fallback scope (@spatulaai, @aalabs/spatula)"
  dashboard_config:
    - task: "For each of the 8 packages, in npm web UI add GitHub Actions trusted publisher"
      location: "https://www.npmjs.com/package/{name}/access"
      values: "Organization accidentally-awesome-labs; Repository spatula; Workflow filename release.yml"
</user_setup>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md
@.planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md
@.planning/phases/16-api-contract-sdk-packages/16-VALIDATION.md
@.planning/phases/16-api-contract-sdk-packages/16-2-SUMMARY.md
@.planning/phases/16-api-contract-sdk-packages/16-3-SUMMARY.md
@.planning/phases/16-api-contract-sdk-packages/16-4-SUMMARY.md
@docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md
@release-please-config.json
@.release-please-manifest.json
@.github/workflows/release.yml
@.github/workflows/release-please.yml

<interfaces>
Current release-please-config.json (pre-Phase-16) has 7 packages (root + 6 workspace). Plan 16-5 EXTENDS to 9 entries (root + 8 workspace: existing 6 + new core-types + client) and adds the plugins block.

Current .release-please-manifest.json has 7 keys at 0.0.1. Plan 16-5 ADDS packages/core-types and packages/client.

Current .github/workflows/release.yml triggers on tag push, runs docker build + GitHub Release; does NOT have an npm publish job — Phase 16 ADDS one.

From spec §3.6: Each package publishes with provenance + access public; trusted publishing via GitHub OIDC (id-token write at JOB level — Pitfall #4); npm 11.5.1+ required (Node 22 LTS bundles npm 10.x — workflow MUST upgrade).

From 16-RESEARCH Pitfalls:
- #3: release-please node-workspace + linked-versions can double-bump; set merge:false on node-workspace.
- #4: id-token write MUST be at JOB level, not workflow level.
- #7: SQLite gate FTS5 — already research-decidable; stay on better-sqlite3.

From 16-RESEARCH Open Questions #3: @spatula/cli dual build via tsup (recommended).
</interfaces>
</context>

<tasks>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 1: BLOCK-04 verification — npm @spatula org owned (or fallback scope chosen + documented)</name>
  <files>.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md</files>
  <read_first>
    - .planning/STATE.md § "Blockers/Concerns" (BLOCK-04 status as of phase start)
    - .planning/REQUIREMENTS.md § "Pre-Launch Blockers" (BLOCK-04 verbatim definition)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-03 (BLOCK-04 gates only sub-plan 16-5)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Environment Availability" (fallback scope options)
  </read_first>
  <what-built>
    Pre-publish gate verification. Plan 16-5 publishes 8 packages to npm; the @spatula scope (or a chosen fallback like @spatulaai or @aalabs/spatula) MUST be owned by accidentally-awesome-labs BEFORE any publish attempt.

    Before this checkpoint, the plan executor has run `npm org ls @spatula 2>&1 | tee /tmp/npm-org-check.txt` to confirm ownership status AND created `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md` documenting one of:
    (a) @spatula org owned — evidence: command output + npm web UI screenshot timestamp
    (b) @spatula org NOT owned — fallback scope decision (e.g., @spatulaai) + plan to rename all 8 packages
  </what-built>
  <action>
    Automation BEFORE the human checkpoint:
    Step 1: Run `npm org ls @spatula 2>&1 | tee /tmp/npm-org-check.txt` from the publishing identity.
    Step 2: If exit code = 0 (org owned): create `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md` with status "OWNED", paste the command output verbatim, record the owning user + date.
    Step 3: If exit code ≠ 0 (org NOT owned): create `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md` with status "FALLBACK PROPOSED", proposed scope (default: @spatulaai), and a rename plan listing every package.json file that needs `name` field updated.
    Step 4: Surface the BLOCK04.md file path + status to the human via the resume-signal pathway below.
  </action>
  <how-to-verify>
    1. Open `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md` and read the status section.
    2. If status is OWNED: visit https://www.npmjs.com/settings/spatula (or https://www.npmjs.com/~accidentally-awesome-labs) and confirm the @spatula scope is listed under Organizations with admin access. Alternatively, run `npm org ls @spatula` directly from a terminal logged in as the publishing identity.
    3. If status is FALLBACK PROPOSED: review the proposed scope. Decide between (a) attempt to claim @spatula now (visit https://www.npmjs.com/org/create) and re-run this checkpoint, or (b) accept the fallback scope.
    4. Reply with one of the signals listed below.
  </how-to-verify>
  <verify>
    <automated>test -f .planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md && grep -qE "OWNED|FALLBACK" .planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md</automated>
  </verify>
  <resume-signal>
    Reply: `approved @spatula`, `approved fallback @<scope>`, or `defer`.
    On `approved @spatula`: Task 2 uses the existing package names unchanged.
    On `approved fallback @<scope>`: Task 2 renames every package.json name field AND all cross-references in the same commit.
    On `defer`: Phase 16 sub-plan 16-5 pauses; user resumes by re-running this checkpoint.
  </resume-signal>
  <done>
    Either: (a) `npm org ls @spatula` returned 0 AND human approved with `approved @spatula`, OR (b) a fallback scope was chosen AND human approved with `approved fallback @<scope>`. In both cases, the chosen scope is recorded in 16-5-BLOCK04.md and Task 2 can proceed.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add packages/core-types + packages/client to release-please-config + manifest; add linked-versions + node-workspace plugins</name>
  <files>
    release-please-config.json,
    .release-please-manifest.json,
    packages/core/package.json,
    packages/db/package.json,
    packages/queue/package.json,
    packages/api/package.json,
    packages/shared/package.json
  </files>
  <read_first>
    - release-please-config.json (current 7-package manifest mode)
    - .release-please-manifest.json (current 7 packages at 0.0.1)
    - .github/workflows/release-please.yml (existing — orchestrates release-PR cycle; unchanged here)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md Claude's Discretion section on release-please topology
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md Architecture Patterns Pattern 3 + Common Pitfalls Pitfall #3
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.2.5 + §3.6
    - If Task 1 resolved with fallback scope: read every package.json name field for atomic rename
  </read_first>
  <behavior>
    - release-please-config.json EXTENDED to include packages/core-types and packages/client (component names core-types and client).
    - Adds a top-level "plugins" array with node-workspace (updatePeerDependencies true, merge false) and linked-versions (groupName sdk-public, components core-types + client).
    - .release-please-manifest.json gets two new keys at 0.0.1.
    - For each internal package (core, db, queue, shared, apps/api): if private:true → set to false; add publishConfig.access:public; update repository.url to accidentally-awesome-labs.
    - If Task 1 chose fallback scope: rename every @spatula/* to @<scope>/* across package.json files + workspace deps + docs + READMEs.
  </behavior>
  <action>
    Step 1: Update release-please-config.json to include 9 manifest entries (root + 8 packages) plus the plugins array. Use the verbatim snippet from 16-RESEARCH Pattern 3.

    Step 2: Update .release-please-manifest.json to include all 9 keys at 0.0.1.

    Step 3: For each internal package (packages/core, db, queue, shared; apps/api): read package.json, remove private:true if set, add publishConfig.access:public, update repository.url to accidentally-awesome-labs/spatula.

    Step 4: For the two PUBLIC packages (packages/core-types, packages/client): confirm publishConfig.access:public + provenance:true present (plan 16-2 added); update repository.url.

    Step 5: If Task 1 chose fallback scope, perform the rename across all 8 packages + cross-references. Single search-and-replace pass; refresh pnpm-lock.yaml via pnpm install; confirm tests still pass.

    Step 6: Run pnpm install --frozen-lockfile=false to refresh the lockfile. Confirm pnpm typecheck + pnpm test:contract still green.
  </action>
  <verify>
    <automated>jq -e '.packages."packages/core-types"' release-please-config.json && jq -e '.packages."packages/client"' release-please-config.json && jq -e '.plugins[] | select(.type=="linked-versions")' release-please-config.json && jq -e '.plugins[] | select(.type=="node-workspace" and .merge==false)' release-please-config.json && jq -e '."packages/core-types"' .release-please-manifest.json && jq -e '."packages/client"' .release-please-manifest.json && pnpm install --frozen-lockfile=false && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - release-please-config.json contains entries for all 9 manifest locations — jq '.packages | keys | length' returns 9
    - release-please-config.json has a plugins array with TWO entries: node-workspace AND linked-versions — jq '.plugins | length' returns 2
    - node-workspace plugin has merge:false (Pitfall #3) — jq '.plugins[] | select(.type=="node-workspace") | .merge' returns false
    - linked-versions plugin lists [core-types, client] — verified via jq
    - .release-please-manifest.json has 9 keys
    - Every internal package's package.json has publishConfig.access=="public" AND private != true
    - pnpm install + pnpm typecheck succeed
    - If fallback scope chosen: ZERO occurrences of @spatula/ remain in source tree (excluding node_modules + pnpm-lock.yaml)
    - Implements per D-01 8-package topology + Pitfall #3 protection.
  </acceptance_criteria>
  <done>
    release-please-config.json + manifest cover all 8 packages; linked-versions + node-workspace plugins wired with merge:false; internal packages flipped to publishable + access:public.
  </done>
</task>

<task type="auto">
  <name>Task 3: Switch release.yml to npm trusted publishing (id-token write, provenance, access public, no NPM_TOKEN); add release-dry-run.yml</name>
  <files>
    .github/workflows/release.yml,
    .github/workflows/release-dry-run.yml
  </files>
  <read_first>
    - .github/workflows/release.yml (current — docker + GitHub Release jobs; this task ADDS publish-npm job)
    - .github/workflows/release-please.yml (existing — unchanged in this plan)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md Architecture Patterns Pattern 5 (full workflow snippet) + Pitfalls Pitfall #4
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md Environment Availability (npm 11.5.1+ required)
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.6
  </read_first>
  <behavior>
    - .github/workflows/release.yml: ADD a new publish-npm job after existing CI + docker jobs.
    - The new job has permissions { contents read, id-token write } AT THE JOB LEVEL (Pitfall #4).
    - Steps: checkout, pnpm setup, node setup with registry-url, upgrade npm via global install, pnpm install frozen-lockfile, pnpm build, then one pnpm publish per package (8 total) with --provenance --access public --no-git-checks.
    - NO references to NPM_TOKEN or NODE_AUTH_TOKEN anywhere in release.yml.
    - .github/workflows/release-dry-run.yml: NEW workflow. Triggers on pull_request AND push:main. Runs pnpm dlx release-please release-pr --dry-run. Non-blocking; reports output as PR comment.
  </behavior>
  <action>
    Step 1: Read .github/workflows/release.yml. Identify where the existing GitHub Release job sits. Add the new publish-npm job per the verbatim snippet in 16-RESEARCH Pattern 5. Replace @spatula with fallback scope from Task 1 if applicable.

    Step 2: Search release.yml for any NPM_TOKEN or NODE_AUTH_TOKEN reference. DELETE those lines. Trusted publishing uses GitHub OIDC; the token mechanism is automatic per id-token write permission.

    Step 3: Write .github/workflows/release-dry-run.yml. Triggers on pull_request + push:main. Steps: checkout with fetch-depth 0, pnpm setup, node setup, pnpm install frozen-lockfile, then `pnpm dlx release-please@17.6.0 release-pr --dry-run --config-file=release-please-config.json --manifest-file=.release-please-manifest.json --token="${{ secrets.GITHUB_TOKEN }}" --repo-url="https://github.com/${{ github.repository }}.git" 2>&1 | tee /tmp/release-please-dryrun.txt`. Upload output as artifact + comment on PR if PR event.

    Step 4: Smoke-test by pushing a scratch branch and confirming the dry-run job exits 0 with sensible bump proposals.
  </action>
  <verify>
    <automated>grep -q "id-token: write" .github/workflows/release.yml && ! grep -qE "NPM_TOKEN|NODE_AUTH_TOKEN" .github/workflows/release.yml && grep -q "publish --provenance --access public" .github/workflows/release.yml && test -f .github/workflows/release-dry-run.yml && grep -q "release-please" .github/workflows/release-dry-run.yml && grep -q "release-pr" .github/workflows/release-dry-run.yml</automated>
  </verify>
  <acceptance_criteria>
    - .github/workflows/release.yml contains a publish-npm job with id-token write at JOB level (Pitfall #4)
    - release.yml does NOT reference NPM_TOKEN or NODE_AUTH_TOKEN
    - Workflow upgrades npm before publishing via global install of latest
    - 8 publish steps total (one per package), each using --provenance --access public
    - .github/workflows/release-dry-run.yml exists and runs release-please release-pr --dry-run
    - release-dry-run workflow triggers on pull_request AND push:main
    - Implements SDK-07 release publishing + addresses Pitfall #4.
  </acceptance_criteria>
  <done>
    release.yml publishes all 8 packages via trusted publishing (no NPM_TOKEN); release-dry-run.yml runs on every PR + main push.
  </done>
</task>

<task type="auto">
  <name>Task 4: Add no-compat README header to packages/{core,db,queue,api,shared}; finalize public-package READMEs</name>
  <files>
    packages/core/README.md,
    packages/db/README.md,
    packages/queue/README.md,
    packages/api/README.md,
    packages/shared/README.md,
    packages/core-types/README.md,
    packages/client/README.md,
    apps/cli/README.md
  </files>
  <read_first>
    - packages/core-types/README.md (plan 16-2 — verify stable doc)
    - packages/client/README.md (plan 16-2 — verify stable doc)
    - apps/cli/README.md (existing — needs publish-prep notes)
    - docs/private-contract.md (Phase 15 — canonical no-compat reference)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md Claude's Discretion internal-package no-compat notice format
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.2.4
  </read_first>
  <behavior>
    - Each of 5 internal package README.md files gets a CANONICAL HEADER repeated verbatim at the top: "NO COMPAT GUARANTEE AT TS-API LEVEL. This is an INTERNAL Spatula package published to npm so the private spatula-saas repo can install it. Breaking changes to its TypeScript surface may land in any MINOR release. Outside consumers should not rely on it. The PUBLIC packages with semver-stable TypeScript surfaces are: @spatula/client, @spatula/core-types, @spatula/cli. See docs/compat-policy.md for the full matrix."
    - Same warning ALSO appears in the package.json description field: "Internal Spatula utilities — NO TS-API compat guarantee. Public SDK is @spatula/client. See docs/compat-policy.md."
    - Public packages: confirm READMEs unchanged from plan 16-2; finalize apps/cli/README.md with publish-prep notes.
  </behavior>
  <action>
    Step 1: For each internal package: if README.md exists, prepend the canonical header. If not, create with header + brief purpose. Update package.json description to start with "Internal".

    Step 2: Verify public-package READMEs (core-types, client) reference docs/compat-policy.md from plan 16-3.

    Step 3: Update apps/cli/README.md with Publishing section pointing to Task 6's tsup build, install command, basic usage, link to docs/compat-policy.md.

    Step 4: Run grep gate from 16-VALIDATION.md row SDK-06: for f in packages/{core,db,queue,api,shared}/README.md; do grep -q 'no compat guarantee' "$f" || exit 1; done.
  </action>
  <verify>
    <automated>for f in packages/core/README.md packages/db/README.md packages/queue/README.md packages/api/README.md packages/shared/README.md; do test -f "$f" && grep -qi 'no compat guarantee' "$f" || exit 1; done && test -f packages/core-types/README.md && test -f packages/client/README.md && test -f apps/cli/README.md</automated>
  </verify>
  <acceptance_criteria>
    - All 5 internal packages have a README with the canonical no-compat header
    - The header contains "no compat guarantee" (case-insensitive)
    - Each header cross-links to docs/compat-policy.md
    - Each internal package's package.json description starts with "Internal"
    - packages/core-types/README.md and packages/client/README.md exist
    - apps/cli/README.md exists
    - 16-VALIDATION.md row SDK-06 grep gate passes
    - Implements SDK-06.
  </acceptance_criteria>
  <done>
    Every internal package README + description carries the no-compat notice; public packages' READMEs finalized; compat-policy.md cross-linked.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 5: Mid-plan checkpoint — release infra (release-please + workflow + internal READMEs) wired; verify before CLI/SDK/SQLite push</name>
  <files>.planning/phases/16-api-contract-sdk-packages/16-5-MIDPLAN-CHECKPOINT.md</files>
  <read_first>
    - release-please-config.json (Task 2 output)
    - .release-please-manifest.json (Task 2 output)
    - .github/workflows/release.yml (Task 3 output)
    - .github/workflows/release-dry-run.yml (Task 3 output)
    - packages/{core,db,queue,api,shared}/README.md (Task 4 output)
    - .planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md (Task 1 output)
  </read_first>
  <what-built>
    Halfway through 16-5. The release infra is wired:
    - Task 1: BLOCK-04 resolved (npm @spatula org owned OR fallback scope chosen + documented in 16-5-BLOCK04.md).
    - Task 2: release-please-config.json + .release-please-manifest.json extended to 9 entries (root + 8 packages); linked-versions plugin couples @spatula/core-types + @spatula/client; node-workspace plugin has merge:false (Pitfall #3 protection).
    - Task 3: .github/workflows/release.yml switched to trusted publishing (id-token: write at JOB level; NO NPM_TOKEN / NODE_AUTH_TOKEN reference; --provenance --access public per publish step). .github/workflows/release-dry-run.yml ships and runs on PR + main push.
    - Task 4: 5 internal-package READMEs (core, db, queue, api, shared) carry the canonical "NO COMPAT GUARANTEE AT TS-API LEVEL" header.

    The plan PAUSES here so the human can verify the release machinery before Tasks 6-9 (CLI tsup conversion + SDK integration test suite + SQLite benchmark + final dry-run smoke test) execute. The remainder of the plan depends on the release infra being correct.
  </what-built>
  <action>
    Automation BEFORE the human checkpoint:
    Step 1: Run `pnpm dlx release-please@17.6.0 release-pr --dry-run --config-file=release-please-config.json --manifest-file=.release-please-manifest.json --token="$(gh auth token)" --repo-url="https://github.com/accidentally-awesome-labs/spatula.git" 2>&1 | tee /tmp/midplan-dryrun.txt` from the publishing identity.
    Step 2: Capture key outputs (proposed release branch, per-package bumps if any, linked-versions group state) into `.planning/phases/16-api-contract-sdk-packages/16-5-MIDPLAN-CHECKPOINT.md` along with:
       - BLOCK-04 status (from 16-5-BLOCK04.md)
       - release.yml permissions block verbatim (proof of id-token: write at JOB level + absence of NPM_TOKEN)
       - 5 internal READMEs' "no compat guarantee" header presence (grep result)
    Step 3: Surface the checkpoint file path + summary to the human via the resume-signal pathway below.
  </action>
  <how-to-verify>
    1. Confirm `pnpm dlx release-please release-pr --dry-run --config-file=release-please-config.json --manifest-file=.release-please-manifest.json` produces a clean release manifest for all 8 packages (no fatal errors; sensible per-package bumps; linked-versions group active for core-types + client). Read /tmp/midplan-dryrun.txt or `.planning/phases/16-api-contract-sdk-packages/16-5-MIDPLAN-CHECKPOINT.md`.
    2. Confirm `.github/workflows/release.yml` references `id-token: write` AT JOB LEVEL (not workflow level — Pitfall #4) AND contains NEITHER `NPM_TOKEN` NOR `NODE_AUTH_TOKEN`. Run: `grep -A 5 "permissions:" .github/workflows/release.yml | grep -q "id-token: write" && ! grep -qE "NPM_TOKEN|NODE_AUTH_TOKEN" .github/workflows/release.yml`.
    3. Confirm BLOCK-04 is resolved (either npm `@spatula` org owned per `npm org ls @spatula` exit 0, OR a fallback scope is documented in `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md` AND every package.json `name` field uses that fallback scope).
    4. Reply with one of the signals listed below.
  </how-to-verify>
  <verify>
    <automated>test -f .planning/phases/16-api-contract-sdk-packages/16-5-MIDPLAN-CHECKPOINT.md && grep -A 5 "permissions:" .github/workflows/release.yml | grep -q "id-token: write" && ! grep -qE "NPM_TOKEN|NODE_AUTH_TOKEN" .github/workflows/release.yml && for f in packages/core/README.md packages/db/README.md packages/queue/README.md packages/api/README.md packages/shared/README.md; do grep -qi "no compat guarantee" "$f" || exit 1; done && test -f .planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md</automated>
  </verify>
  <resume-signal>
    Reply: `approved`, `fix release infra and pause`, or `defer`.
    On `approved`: Tasks 6-9 (CLI tsup conversion + SDK integration suite + SQLite benchmark + publish dry-run smoke) proceed.
    On `fix release infra and pause`: planner / executor returns to Tasks 2-4 to fix the flagged issue; this checkpoint re-runs after the fix.
    On `defer`: 16-5 pauses; user resumes by re-running this checkpoint.
  </resume-signal>
  <done>
    Human verified that (1) release-please dry-run is clean for all 8 packages, (2) release.yml has id-token: write at JOB level + zero NPM_TOKEN references, (3) BLOCK-04 is resolved. Tasks 6-9 proceed.
  </done>
</task>

<task type="auto">
  <name>Task 6: @spatula/cli publish prep — tsup dual ESM+CJS build + files allowlist + engines + no postinstall</name>
  <files>
    apps/cli/package.json,
    apps/cli/tsup.config.ts,
    apps/cli/README.md
  </files>
  <read_first>
    - apps/cli/package.json (current — tsc-only build)
    - apps/cli/src/index.tsx (entry point)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md Open Questions #3 (tsup recommended)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md SDK-04 scope
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.2.3
  </read_first>
  <behavior>
    - apps/cli/package.json: remove private:true; add publishConfig:{access:public, provenance:true}; add files:["dist","README.md"]; add engines.node ">=22"; change main to ./dist/index.cjs; add module: ./dist/index.js, types: ./dist/index.d.ts; update exports to dual (import + require); change build script from tsc to tsup --config tsup.config.ts.
    - CONFIRM NO postinstall script (Playwright browsers install via `spatula setup` per SDK-04).
    - apps/cli/tsup.config.ts (NEW): defineConfig with entry { index: src/index.tsx, cli: src/index.tsx }, format ['esm','cjs'], dts true, sourcemap true, clean true, target node22, splitting false, treeshake true, shims true, external [playwright, @spatula/core, @spatula/db, @spatula/shared].
    - apps/cli/README.md Publishing section: built via tsup (dual ESM+CJS), install `npm install -g @spatula/cli`, Playwright requires `spatula setup` post-install.
    - Smoke: pnpm build + pnpm pack; install tarball globally; spatula --version prints version.
  </behavior>
  <action>
    Step 1: Update apps/cli/package.json per behavior. Use jq for atomic edits or careful manual edit.

    Step 2: Add tsup as devDep: pnpm --filter @spatula/cli add -D tsup@latest.

    Step 3: Create apps/cli/tsup.config.ts with config per behavior. Externalize workspace packages so they resolve from node_modules at consumer-install time.

    Step 4: Run pnpm --filter @spatula/cli build. Verify dist/ contains index.js (ESM), index.cjs (CJS), cli.cjs (bin shim), index.d.ts.

    Step 5: Run pnpm --filter @spatula/cli pack. Install locally via the tarball. Smoke-test spatula --version + spatula --help. Uninstall.

    Step 6: Update apps/cli/README.md with the Publishing section.

    Step 7: Verify existing CLI test suite still passes: pnpm --filter @spatula/cli test:ci.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/cli build && test -f apps/cli/dist/index.js && test -f apps/cli/dist/index.cjs && test -f apps/cli/dist/index.d.ts && jq -e '.publishConfig.access=="public"' apps/cli/package.json && jq -e '.files | contains(["dist"])' apps/cli/package.json && jq -e '.engines.node | contains(">=22")' apps/cli/package.json && (! jq -e '.scripts.postinstall' apps/cli/package.json) && pnpm --filter @spatula/cli pack</automated>
  </verify>
  <acceptance_criteria>
    - apps/cli/package.json has publishConfig.access:"public"
    - private field absent OR false
    - files array allowlist includes "dist"
    - engines.node matches ">=22"
    - NO postinstall script
    - exports dual-format with both import and require
    - apps/cli/tsup.config.ts exists with format ['esm','cjs']
    - pnpm --filter @spatula/cli build succeeds AND produces dist/index.js + dist/index.cjs + dist/index.d.ts
    - pnpm --filter @spatula/cli pack produces an installable tarball (smoke-tested with global install)
    - Implements SDK-04.
  </acceptance_criteria>
  <done>
    @spatula/cli builds dual ESM+CJS via tsup; package.json publish-ready; files allowlist; engines pinned; no postinstall. Smoke-tested.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 7: SDK integration test suite (SDK-08) — 5 endpoints, mocked by default, opt-in live via SPATULA_LIVE_LLM=1</name>
  <files>
    packages/client/vitest.integration.config.ts,
    packages/client/tests/integration/create-job.test.ts,
    packages/client/tests/integration/list-jobs.test.ts,
    packages/client/tests/integration/get-entities.test.ts,
    packages/client/tests/integration/get-job-events.test.ts,
    packages/client/tests/integration/version-probe.test.ts,
    packages/client/package.json
  </files>
  <read_first>
    - packages/client/src/client.ts (plan 16-2 + 16-3 — SpatulaClient shape)
    - packages/client/src/methods/* (plan 16-2 — createJob, listJobs, getEntities, getJobEvents stubs)
    - packages/client/src/version-probe.ts (plan 16-3)
    - tests/contract/helpers/server-harness.ts (plan 16-4 — REUSE the http.Server adapter)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md SDK-08 row + Open Questions #4
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md SDK-08 scope
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.2.1
  </read_first>
  <behavior>
    - packages/client/vitest.integration.config.ts: separate vitest config; include tests/integration/**/*.test.ts; testTimeout 60_000; passWithNoTests true.
    - packages/client/package.json: add test:integration script.
    - Five test files: create-job, list-jobs, get-entities, get-job-events (stub for Phase 16; SSE wiring is Phase 17), version-probe (integration variant).
    - Default mode (SPATULA_LIVE_LLM unset): mock LLM via vi.stubGlobal or contract server harness stubs.
    - Live mode (SPATULA_LIVE_LLM=1): real OpenRouter via OPENROUTER_API_KEY.
    - Each test branches via `if (process.env.SPATULA_LIVE_LLM === '1')`.
  </behavior>
  <action>
    Step 1: Write packages/client/vitest.integration.config.ts with include + testTimeout + passWithNoTests.

    Step 2: Update packages/client/package.json scripts to add test:integration.

    Step 3: Write 5 integration tests reusing tests/contract/helpers/server-harness.ts (relative import from packages/client/tests/integration/). Each test boots the server, instantiates SpatulaClient pointing at the server URL, exercises the relevant method, asserts shape. get-job-events test uses it.skipIf or stub assertion (SSE lands in Phase 17).

    Step 4: Run pnpm --filter @spatula/client test:integration (mocked default). Confirm green.

    Step 5: Optional: run with SPATULA_LIVE_LLM=1 + OPENROUTER_API_KEY=... to verify live mode works. Not required to land this plan.

    Step 6: Confirm packages/client default test script does NOT run integration tests. Live tests run via separate workflow_dispatch or scheduled job — defer the CI wiring to Phase 21.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/client test:integration && test -f packages/client/vitest.integration.config.ts && grep -q "SPATULA_LIVE_LLM" packages/client/tests/integration/create-job.test.ts && grep -q "test:integration" packages/client/package.json && ls packages/client/tests/integration/*.test.ts | wc -l | awk '$1 == 5 { exit 0 } { exit 1 }'</automated>
  </verify>
  <acceptance_criteria>
    - packages/client/vitest.integration.config.ts exists with passWithNoTests true
    - packages/client/package.json contains test:integration script
    - Exactly 5 integration test files exist
    - Each test file references SPATULA_LIVE_LLM for mode switching
    - pnpm --filter @spatula/client test:integration exits 0 in default (mocked) mode
    - Files cover: createJob, listJobs, getEntities, getJobEvents (stub for Phase 16), version-probe
    - Implements SDK-08.
  </acceptance_criteria>
  <done>
    5 SDK integration tests; mocked default (CI-safe); opt-in live via SPATULA_LIVE_LLM=1. Reuses contract server harness.
  </done>
</task>

<task type="auto">
  <name>Task 8: SQLite benchmark + decision committed to docs/architecture.md (better-sqlite3 stays; FTS5 gap is decisive)</name>
  <files>
    packages/db/bench/sqlite-comparison.ts,
    packages/db/bench/sqlite-comparison.results.md,
    docs/architecture.md
  </files>
  <read_first>
    - packages/db/src/* (existing schemas + queries — identify FTS5 usage)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md Claude's Discretion SQLite benchmark gate timing
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md Pitfall #7 + Summary (research-decidable) + State of the Art
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.2.3
    - docs/architecture.md (current — find insertion point)
  </read_first>
  <behavior>
    - First step: feature-parity gate (Pitfall #7 — NOT a perf benchmark first).
    - Enumerate SQLite features the codebase uses via grep for "fts5|FTS5|loadExtension|PRAGMA" in packages/db/src/ and packages/core/src/.
    - If FTS5 usage found → node:sqlite cannot satisfy spec §3.2.3 gate #1. Decision pre-determined.
    - packages/db/bench/sqlite-comparison.ts: one-shot script lists features used, attempts to construct FTS5 virtual table with node:sqlite (expected: throws), runs CRUD perf comparison for context only, writes results to packages/db/bench/sqlite-comparison.results.md.
    - docs/architecture.md: new section "SQLite Backend Decision" with Method, Findings (FTS5 absent), Decision (stay on better-sqlite3@12.10.0), Re-evaluation criteria.
  </behavior>
  <action>
    Step 1: Grep for SQLite features used in the codebase.

    Step 2: Create packages/db/bench/ directory + packages/db/bench/sqlite-comparison.ts. Script: import better-sqlite3 + node:sqlite, attempt CREATE VIRTUAL TABLE fts5 on each, document result, run 10000-insert CRUD perf comparison for context, write packages/db/bench/sqlite-comparison.results.md.

    Step 3: Run pnpm tsx packages/db/bench/sqlite-comparison.ts. Inspect output. Confirm FTS5 result matches research expectation (NOT AVAILABLE in node:sqlite).

    Step 4: Commit packages/db/bench/sqlite-comparison.ts AND .results.md.

    Step 5: Edit docs/architecture.md to add "SQLite Backend Decision" section. Insertion point: after existing "Storage / Persistence" section. Include Method, Findings, Decision (stay on better-sqlite3@12.10.0), Re-evaluation criteria. Ensure the literal phrase "SQLite Backend Decision" appears (16-VALIDATION.md gate). Preserve the "5 formats frozen" string from plan 16-4.
  </action>
  <verify>
    <automated>test -f packages/db/bench/sqlite-comparison.ts && test -f packages/db/bench/sqlite-comparison.results.md && grep -q "SQLite Backend Decision" docs/architecture.md && grep -qE "better-sqlite3|FTS5" docs/architecture.md && grep -q "5 formats frozen" docs/architecture.md</automated>
  </verify>
  <acceptance_criteria>
    - packages/db/bench/sqlite-comparison.ts exists and is executable (pnpm tsx runs it)
    - packages/db/bench/sqlite-comparison.results.md exists with FTS5 gate result
    - docs/architecture.md contains section heading "SQLite Backend Decision"
    - docs/architecture.md mentions FTS5 + better-sqlite3@12.10.0
    - docs/architecture.md preserves "5 formats frozen" from plan 16-4 (regression check)
    - Decision is stay on better-sqlite3
    - Implements SDK-05 + Pitfall #7.
  </acceptance_criteria>
  <done>
    SQLite benchmark run; results committed; decision committed to docs/architecture.md; FTS5 absence in node:sqlite documented. v1.0 ships better-sqlite3@12.10.0.
  </done>
</task>

<task type="auto">
  <name>Task 9: Smoke-test release-please dry-run end-to-end against the new config</name>
  <files>
    .planning/phases/16-api-contract-sdk-packages/16-5-dryrun.log
  </files>
  <read_first>
    - release-please-config.json (Task 2 output)
    - .release-please-manifest.json (Task 2 output)
    - .github/workflows/release-dry-run.yml (Task 3 output)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md Pitfall #3 (no double-bump)
  </read_first>
  <behavior>
    - Run release-please dry-run locally to confirm config is valid + plugins compose correctly.
    - Capture output to 16-5-dryrun.log for review traceability.
    - Verify no double-bump: if core-types is bumped, client is bumped to the SAME version (linked-versions); if NEITHER had a triggering commit, both skipped, not patched.
  </behavior>
  <action>
    Step 1: Set GITHUB_TOKEN if not set: export GITHUB_TOKEN=$(gh auth token).

    Step 2: Run pnpm dlx release-please@17.6.0 release-pr --dry-run --config-file=release-please-config.json --manifest-file=.release-please-manifest.json --token="$GITHUB_TOKEN" --repo-url="https://github.com/accidentally-awesome-labs/spatula.git" 2>&1 | tee .planning/phases/16-api-contract-sdk-packages/16-5-dryrun.log

    Step 3: Inspect output. Confirm all 8 packages are recognized; linked-versions groups core-types + client together; no double-bump warnings; proposed release branch + PR body looks reasonable.

    Step 4: If issues surface (config schema errors etc.), fix in Task 2 files and re-run.

    Step 5: Commit 16-5-dryrun.log as evidence.
  </action>
  <verify>
    <automated>test -f .planning/phases/16-api-contract-sdk-packages/16-5-dryrun.log && grep -qi "core-types\|client" .planning/phases/16-api-contract-sdk-packages/16-5-dryrun.log && ! grep -qiE "double.bump|fatal" .planning/phases/16-api-contract-sdk-packages/16-5-dryrun.log</automated>
  </verify>
  <acceptance_criteria>
    - 16-5-dryrun.log exists with release-please dry-run output
    - Output mentions core-types AND client (linked-versions group active)
    - No "double-bump" or "fatal" strings (Pitfall #3 verified)
    - Output proposes sensible release PR shape
    - Implements SDK-07 dry-run verification.
  </acceptance_criteria>
  <done>
    release-please dry-run runs cleanly against the new 8-package config; output captured; no double-bump; ready to publish on next tag.
  </done>
</task>

</tasks>

<verification>
1. pnpm install --frozen-lockfile=false + pnpm build + pnpm test + pnpm test:contract + pnpm test:carveout + pnpm test:private-contract — full stack green.
2. pnpm --filter @spatula/cli pack — installable tarball verification.
3. pnpm --filter @spatula/client test:integration — 5 integration tests green (mocked default).
4. release-please dry-run log (Task 9) clean.
5. Grep gates per 16-VALIDATION.md (SDK-04 pack succeeds; SDK-05 architecture.md SQLite section; SDK-06 5 internal READMEs; SDK-07 dry-run clean; SDK-08 integration tests pass).
6. CI gate: release-dry-run.yml runs on synthetic PR; non-blocking; reports output.
7. BLOCK-04 evidence at 16-5-BLOCK04.md exists and records resolution.
</verification>

<success_criteria>
- SDK-04: @spatula/cli builds dual ESM+CJS via tsup; publish-ready package.json; pnpm pack produces installable tarball.
- SDK-05: SQLite decision committed; FTS5 finding documented; stay on better-sqlite3@12.10.0.
- SDK-06: All 5 internal packages have the no-compat README header.
- SDK-07: release-please dry-run clean for all 8 packages; trusted publishing wired; provenance + access public per package.
- SDK-08: 5 SDK integration tests green by default (mocked); opt-in live via SPATULA_LIVE_LLM=1.
- BLOCK-04 cleared (either @spatula owned or fallback scope applied).
- Pitfall protections verified: #3 (no double-bump), #4 (id-token job level), #7 (FTS5 gate over perf).
</success_criteria>

<output>
After completion, create .planning/phases/16-api-contract-sdk-packages/16-5-SUMMARY.md recording:
- BLOCK-04 resolution: scope used (@spatula or fallback) + evidence file path
- Final release-please-config.json shape (8 packages + 2 plugins; merge:false on node-workspace)
- release.yml publish job permissions block (id-token write at JOB level)
- CLI publish dry-run: installable tarball name + spatula --version output
- SDK integration test count (5) + runtime
- SQLite benchmark numbers + decision restated
- release-please dry-run log file path
- Internal-package README inventory: 5 READMEs with no-compat header (canonical template once)
- Cross-reference: Phase 16 ROADMAP success criteria #1..#6 — confirm each is met
- Note: post-Phase-16 cleanup — legacy NotFoundError + ValidationError subclasses still in packages/shared/src/errors.ts as @deprecated; remove in v2.0
</output>
