---
phase: 19-deployment-self-host-excellence
plan: "05"
subsystem: infra
tags: [render, blueprint, deploy, embedded-worker, postgres, keyvalue, distroless, pnpm, node]

requires:
  - phase: 19-deployment-self-host-excellence
    provides: "Plan 01 — apps/api/dist/main.js bootstrap + SPATULA_EMBEDDED_WORKER=1 embedded-worker shim"

provides:
  - "render.yaml at repo root — one-click Render blueprint: free Web Service (API + embedded worker), free Key Value (Redis), free Postgres"
  - "docs/runbooks/render-deploy.md — try-it/demo framing, deploy steps, manual migration step, honest free-tier caveats"
  - "Verified-live deploy: build → boot → DB → embedded worker → /health → migrations, proven end-to-end on a paid mirror branch"
  - "Repaired build recipe (corepack-free, --prod=false, Node 22 pin) ported to the public template"

affects: [deployment-render, deployment-distroless, 19-09]

tech-stack:
  added: []
  patterns:
    - "Render build: NEVER `corepack enable` (its shim dir /usr/bin is read-only → EROFS); Render auto-provides pnpm from pnpm-lock.yaml"
    - "Render build under NODE_ENV=production MUST use `pnpm install --prod=false` or devDeps (turbo/tsup/tsc) are skipped → `turbo: not found`"
    - "Node version pinned two ways: NODE_VERSION env (render.yaml) + repo-level .node-version (read on build clone, survives an unsynced blueprint)"
    - "Blueprint sync ≠ deploy: `render deploys create` rebuilds with the service's STORED config; render.yaml changes need a dashboard Blueprint Sync (CLI only validates, cannot sync)"

key-files:
  created:
    - render.yaml (Task 1 — free-tier blueprint)
    - docs/runbooks/render-deploy.md (Task 2 — deploy runbook + caveats)
    - .node-version (Task 3 fix — repo-level Node 22 pin)
  modified:
    - render.yaml (Task 3 fix — drop corepack, add --prod=false, add NODE_VERSION=22)

key-decisions:
  - "SC#2 verified on a PAID mirror branch (render-paid-demo), not literal free tier — the workspace's single free Postgres + single free Key Value slots were already in use (the exact constraint documented in the runbook). render.yaml structure is identical; only plan names differ (starter/basic-256mb vs free)."
  - "Two real template defects were found ONLY via the live deploy and fixed: (1) `corepack enable` EROFS, (2) NODE_ENV=production skipping devDeps. Both would have blocked a free-tier deploy too — fixes ported to main's public template (b25fc9e)."
  - "DEFER-19-A (@spatula/client clean isolated build) did NOT bite on Render because --prod=false installs hoisted @types/node — consistent with the deferred note's prediction. The Render build is NOT a clean isolated build, so DEFER-19-A remains open."
  - "Render Key Value defaults to allkeys-lru eviction; BullMQ wants noeviction. Logged as an operational caveat (jobs could be evicted under memory pressure); not configurable on starter."

patterns-established:
  - "Live-deploy checkpoints catch deployment-only defects (read-only FS, prod-install dep pruning, Node default drift) that no local build or CI exercises."

requirements-completed: [DEPLOY-02]

duration: live-deploy checkpoint (multi-session)
completed: "2026-06-11"
---

# Phase 19 Plan 05: Render Free-Tier Blueprint + Live Deploy Verification

**Shipped `render.yaml` (one-click full-stack Render deploy via a single free Web Service running the API + embedded BullMQ worker, with managed free Postgres + Key Value) and an honest try-it runbook — then verified the whole stack live end-to-end, fixing two deployment-only template defects the live test exposed.**

> ⚠️ **CAVEAT (2026-06-12, added after the fact):** SC#2 was verified as build green + `/health`/`/health/ready` 200 + embedded worker **starting** (7 queues + heartbeat) + migrations complete. It was **NOT** verified that the embedded worker can **process a crawl** — and it cannot. A later 19-09 sizing smoke proved the BullMQ worker throws `WorkerDeps not initialized` on every job (deps are constructed nowhere in production; the queued/hosted crawl path is unwired). So this Render deploy serves health and boots the worker, but **a real crawl will not run** until **Phase 19.1 (Hosted Execution Path Completion)** lands. 19.1/EXEC-05 re-verifies this deploy with an actual crawl to clear this caveat. See `.planning/phases/19.1-hosted-execution-path/` and STATE.md Blockers.

## Performance

- **Duration:** Tasks 1–2 authored earlier in the phase; Task 3 (human-verify live deploy) completed as a checkpoint session
- **Completed:** 2026-06-11
- **Tasks:** 3/3 (2 auto + 1 human-verify checkpoint)

## Accomplishments

- **Task 1 — `render.yaml`:** repo-root blueprint. One `type: web` service (NOT paid `type: worker`) runs the API + embedded worker in-process via `SPATULA_EMBEDDED_WORKER=1` (Plan 01 shim); `type: keyvalue` Redis; managed Postgres; `DATABASE_URL`/`REDIS_URL` wired from the managed datastores; `startCommand: node apps/api/dist/main.js`; secrets `sync: false`.
- **Task 2 — `docs/runbooks/render-deploy.md`:** demo/try-it framing, deploy steps, manual migration step, and honest caveats (15-min spin-down, non-persistent free KV, Postgres expiry linked to render.com/docs/free, one free PG + one free KV per workspace, production splits api/worker).
- **Task 3 — live deploy (SC#2), VERIFIED:** deployed the blueprint to a real Render workspace and proved the full path live.

### Live verification evidence

| Check | Result |
| --- | --- |
| Build | ✅ green — `turbo run build` 8/8 tasks, Node 22.22.3, pnpm from lockfile |
| `GET /health` | ✅ 200 `{"status":"ok"}` |
| `GET /health/ready` | ✅ `{"redis":"ok","queue":"ok","database":"ok"}` (real pool query) |
| Embedded worker | ✅ `Embedded worker started (SPATULA_EMBEDDED_WORKER=1)` — 7 queues + heartbeat |
| Migrations | ✅ one-off job → `Migrations complete` (drizzle, `__drizzle_migrations_oss`) |
| Service | ✅ live at https://spatula-api.onrender.com |

- Service `srv-d8lh2q6rnols73dedvog` · deploy `dep-d8lhvm28qa3s73d0bp30` · DB `dpg-d8lgrscvikkc739aqo80-a` · KV `red-d8lh23ernols73dedgd0` · migrate job `job-d8li1vjeo5us73f9rsvg`.

### Defects found by the live test (and fixed)

1. **`corepack enable` → `EROFS: read-only file system, unlink '/usr/bin/pnpm'`** — Render's build image has corepack's shim dir read-only. Fix: drop corepack; Render auto-provides pnpm from `pnpm-lock.yaml`.
2. **`turbo: not found`** — `NODE_ENV=production` makes `pnpm install` skip devDependencies, but the build needs them. Fix: `pnpm install --frozen-lockfile --prod=false` (runtime keeps `NODE_ENV=production`).
3. **Render defaulted to Node 24** (matrix is 22+). Fix: `NODE_VERSION=22` env + repo-level `.node-version`.

All three fixes ported to the public free-tier template on `main` (`b25fc9e`) — without them the one-click template would fail for every self-hoster.

## SC#2 caveat (honest)

The literal **free-tier** wording could not be exercised in this workspace: its single free Postgres + single free Key Value slots were already occupied (the exact limit the runbook documents). The deploy was mirrored onto paid tiers (`render-paid-demo` branch: `starter`/`basic-256mb`) — identical blueprint structure, only plan names differ. Everything SC#2 checks (build, boot, DB wiring, embedded worker, health, migrations) is proven; the public `main` template remains all-`free` and now carries the repaired build recipe.

## Task Commits

1. **Task 1: render.yaml blueprint** — `2a6ee02` (feat)
2. **Task 2: render-deploy.md runbook** — `892822c` (docs)
3. **Task 3: live-deploy fixes → public template** — `b25fc9e` (fix: corepack + devDeps + Node pin on main)
   - Paid mirror branch `render-paid-demo`: `276af5d` (corepack), `9459a95` (.node-version), `786630d` (--prod=false) — the live-tested commits.

## Open follow-ups

- **DEFER-19-A** (`@spatula/client` clean isolated TS build) remains open — the Render build passed only because `--prod=false` hoists `@types/node`; a truly isolated build is still untested. Tracked in `deferred-items.md`.
- **Redis eviction policy:** Render KV is `allkeys-lru`; BullMQ wants `noeviction`. Operational caveat for the runbook.
