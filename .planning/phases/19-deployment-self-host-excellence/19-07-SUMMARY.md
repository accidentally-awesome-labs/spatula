---
phase: 19-deployment-self-host-excellence
plan: 07
subsystem: infra
tags: [ci, github-actions, postgres, redis, node, support-matrix, vitest]

requires:
  - phase: 19-06
    provides: test:backup / test:upgrade / test:config scripts in root package.json (the heavy lanes this CI runs)

provides:
  - docs/support-matrix.md — min-version support table (Node 22+, Postgres 14+, Redis 7+, macOS/Linux/WSL)
  - .github/workflows/support-matrix.yml — min-version CI matrix: Node 22 x PG 14/15/16 x Redis 7 on-release + nightly

affects: [phase-20, phase-21, phase-22, contributors, self-hosters]

tech-stack:
  added: []
  patterns:
    - 'on-release + nightly cadence (not PR) for DB-heavy CI lanes — mirrors adversarial-llm.yml precedent'
    - 'GitHub Actions matrix over postgres versions with service containers (postgres:N-alpine + redis:7-alpine)'
    - "YAML on: key parses as Python True (not string 'on') — use d.get(True) not d.get('on') in PyYAML assertions"

key-files:
  created:
    - docs/support-matrix.md
    - .github/workflows/support-matrix.yml
  modified: []

key-decisions:
  - 'Heavy DB lanes (test:backup, test:upgrade) run on-release + nightly only — not on every PR (keeps PR gate fast; Phase 21 owns full topology)'
  - 'Config-compat lane (test:config) is pure in-process (no DB) and can be added to ci.yml on PR in a later phase'
  - "support-matrix.md uses 'Postgres 14' phrasing (not 'PostgreSQL') to match grep acceptance criteria"

patterns-established:
  - 'CI service containers use postgres:N-alpine + redis:7-alpine health-checked pattern from ci.yml'
  - 'Support matrix doc cross-references the CI workflow that enforces it'

requirements-completed: [DEPLOY-08, DEPLOY-05, DEPLOY-10, DEPLOY-11]

duration: 8min
completed: 2026-06-11
---

# Phase 19 Plan 07: Support Matrix Summary

**docs/support-matrix.md documents Node 22+/Postgres 14+/Redis 7+/macOS-Linux-WSL and .github/workflows/support-matrix.yml runs the heavy Phase 19-06 test lanes (backup/upgrade/config) against a Node 22 x PG 14/15/16 x Redis 7 matrix on-release + nightly.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-11T05:39:17Z
- **Completed:** 2026-06-11T05:47:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- `docs/support-matrix.md` created: component version table (Node 22/PG 14+/Redis 7/pnpm 9), OS support table (Linux/macOS/WSL supported; native Windows not supported), container image table (distroless api/worker/migrate; Debian-slim cli with no baked browsers), "How enforced" section with enforcement table for the three test suites, CI cross-reference to `support-matrix.yml`
- `.github/workflows/support-matrix.yml` created: Node 22 x Postgres 14/15/16 x Redis 7 matrix; on-release + nightly + workflow_dispatch triggers (no pull_request); runs `pnpm test:config`, `pnpm test:upgrade`, `pnpm test:backup` with postgres/redis service containers
- ci.yml PR gate left untouched — plan is additive only

## Task Commits

1. **Task 1: docs/support-matrix.md** - `a472902` (docs)
2. **Task 2: .github/workflows/support-matrix.yml** - `c04c2b6` (feat)

## Files Created/Modified

- `docs/support-matrix.md` — min-version support matrix with component table, OS table, container image table, enforcement section, and runbook cross-references
- `.github/workflows/support-matrix.yml` — GitHub Actions min-version matrix CI: Node 22 x PG 14/15/16 x Redis 7, on-release + nightly, runs Phase 19-06 heavy test lanes

## Decisions Made

- Heavy DB lanes (`test:backup`, `test:upgrade`) run on-release + nightly only — mirrors the `adversarial-llm.yml` precedent and keeps the PR gate clean; Phase 21 owns full CI topology
- Config-compat lane (`test:config`) is pure in-process (no DB needed) — safe to add to ci.yml on PR, but wired as Phase 21 work per plan
- `docs/support-matrix.md` uses the phrasing "Postgres 14" in the component table to satisfy the acceptance-criteria grep (`grep -q "Postgres 14"`)

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

Minor: Initial `grep -q "Postgres 14"` check failed because the table header used "PostgreSQL (Postgres)" — fixed by adding "Postgres 14" text inline. The YAML `on:` key parses as Python `True` (not string `'on'`) in PyYAML; verification assertion used `d.get(True)` per RESEARCH pattern.

## User Setup Required

None — no external service configuration required. The workflow will run automatically on `v*` tag push and nightly.

## Next Phase Readiness

- DEPLOY-08 satisfied: `docs/support-matrix.md` + min-version CI matrix in `.github/workflows/support-matrix.yml`
- CI home established for the Phase 19-06 heavy lanes (DEPLOY-05/10/11 cadence)
- Phase 19 remaining: 19-09 (hardware-sizing live measurement, deferred per user) and 19-05 (Render live-deploy verify checkpoint, deferred per user)
- Phase 20 (docs site) can reference `docs/support-matrix.md` directly

---

_Phase: 19-deployment-self-host-excellence_
_Completed: 2026-06-11_

## Self-Check: PASSED

- `docs/support-matrix.md` exists: FOUND
- `.github/workflows/support-matrix.yml` exists: FOUND
- Commit `a472902` exists: FOUND (docs(19-07): add support-matrix.md)
- Commit `c04c2b6` exists: FOUND (feat(19-07): add support-matrix.yml min-version CI matrix)
