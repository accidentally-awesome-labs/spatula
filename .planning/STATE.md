---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Public Launch (Wave 6 / Phase 14)
status: Roadmap approved; ready to discuss/plan phase 15
stopped_at: Phase 15 context gathered
last_updated: "2026-05-12T15:59:13.491Z"
last_activity: 2026-05-12 — ROADMAP.md created mapping 120 v1.1 requirements across 8 phases (15–22)
progress:
  total_phases: 1
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-11)

**Core value:** Turn "I want X data from these sites" into a production-quality dataset with provenance.
**Current focus:** v1.1 Public Launch (Wave 6 / Phase 14) — roadmap approved; Phase 15 next.

## Current Position

Phase: 15 of 22 (Carve-out & Migration Squash) — first v1.1 phase
Plan: — (no plans drafted yet)
Status: Roadmap approved; ready to discuss/plan phase 15
Last activity: 2026-05-12 — ROADMAP.md created mapping 120 v1.1 requirements across 8 phases (15–22)

Progress: [░░░░░░░░░░] 0% (0/8 v1.1 phases complete)

## Performance Metrics

**Velocity (v1.0 cumulative, carried over):**

- v1.0 shipped 2026-04-20 across Phases 1–13 (Waves 1–5 + 2026-04-20 cleanup)
- ~294 test files; 2,302 unit + 71 integration tests at close

**v1.1 (this milestone):**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 15 | — | — | — |

*v1.1 metrics will populate as plans execute.*

## Accumulated Context

### Decisions

Full decision log lives in PROJECT.md Key Decisions table. Recent decisions relevant to v1.1:

- Wave 6 carve-out + migration squash planned but unexecuted at v1.0 close — Phase 15 entry.
- Reference web UI is a non-goal for v1.1; ship web-UI **enablement** (SDK + OpenAPI + SSE + browser OIDC) only.
- Internal packages (`@spatula/core`, `db`, `queue`, `api`, `shared`) carry no TS-API compat guarantee; only `@spatula/cli`, `@spatula/client`, `@spatula/core-types` follow strict semver.
- Two separate Drizzle migration tracking tables (`__drizzle_migrations_oss`, `__drizzle_migrations_saas`) — no shared journal.

### Pending Todos

None captured yet.

### Blockers/Concerns

All 9 pre-launch blockers are open as of 2026-05-12 (see PROJECT.md "Pre-launch blockers" list and REQUIREMENTS.md BLOCK-01..BLOCK-09). Each is mapped to the phase it gates in `.planning/ROADMAP.md`:

- BLOCK-01 → Phase 15 entry gate (private `spatula-saas` repo)
- BLOCK-02 → Phase 18 / Phase 22 (legal entity or interim-name fallback)
- BLOCK-03 → Phase 20 entry gate (`spatula.dev` / `docs.spatula.dev` domains)
- BLOCK-04 → Phase 16 entry gate (npm `@spatula` org)
- BLOCK-05 → Phase 22 entry gate (GitHub namespace)
- BLOCK-06 → Phase 18 / Phase 22 (USPTO trademark search)
- BLOCK-07 → Phase 22 entry gate (beta invitee list)
- BLOCK-08 → Phase 20 entry gate (Cloudflare Pages + DNS)
- BLOCK-09 → Phase 18 / Phase 22 (historical-contributor enumeration + outreach)

### Pending Decisions

- Phase 15 first move: confirm private `spatula-saas` repo created before carve-out PR.
- Legal entity timing: form before public flip or accept interim-name LICENSE path.
- npm org / GitHub namespace / domain availability checks.
- SQLite driver decision in Phase 16 (`better-sqlite3` vs `node:sqlite`).

## Session Continuity

Last session: 2026-05-12T15:59:13.487Z
Stopped at: Phase 15 context gathered
Resume file: .planning/phases/15-carveout-migration-squash/15-CONTEXT.md
