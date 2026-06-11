---
phase: 19
slug: deployment-self-host-excellence
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-10
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Phase 19 is infrastructure-heavy: most signals are CI jobs, smoke tests, and command exit codes rather than unit tests. See `19-RESEARCH.md` § Validation Architecture for the per-requirement signal map the planner expands here.

---

## Test Infrastructure

| Property                 | Value                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Framework**            | vitest (TS monorepo); plus shell/CI smoke gates for infra (kind, render, cosign)                                         |
| **Config file**          | `tests/vitest.config.ts` (root e2e); per-package `vitest.config.ts`                                                      |
| **Quick run command**    | `pnpm --filter <pkg> test`                                                                                               |
| **Full suite command**   | `pnpm test`                                                                                                              |
| **Infra smoke commands** | `kubectl apply -k deploy/k8s/overlays/dev` · `cosign verify ...` · `tests/e2e/backup` · `tests/upgrade` · `tests/config` |
| **Estimated runtime**    | unit ~quick; infra/e2e lanes minutes (default on-release+nightly per CONTEXT Claude's-discretion)                        |

---

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` command (unit/grep/exit-code).
- **After every plan wave:** Run the wave's relevant suite (`pnpm --filter ... test` or the infra smoke for that wave).
- **Before `/gsd:verify-work`:** Backup/upgrade/config e2e + min-version matrix green; `cosign verify` smoke documented.
- **Max feedback latency:** unit < 60s; infra lanes deferred (on-demand / nightly).

---

## Per-Task Verification Map

> Populated by the planner from `19-RESEARCH.md` § Validation Architecture. Every DEPLOY-01..11 requirement maps to at least one automatable signal (CI job, smoke test, grep, or command exit code).

| Task ID  | Plan | Wave | Requirement | Test Type      | Automated Command | File Exists | Status     |
| -------- | ---- | ---- | ----------- | -------------- | ----------------- | ----------- | ---------- |
| 19-XX-XX | XX   | X    | DEPLOY-XX   | infra/e2e/unit | `{command}`       | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `tests/e2e/backup/` — backup→restore round-trip harness (DEPLOY-05)
- [ ] `tests/upgrade/` — v1.0-seed → v1.x-migrate runtime verify (DEPLOY-10)
- [ ] `tests/config/` — v1.0 `spatula.yaml` parses on v1.1 runtime (DEPLOY-11)
- [ ] CI lanes: min-version matrix + cosign-verify smoke + kind/render smoke (DEPLOY-03/04/08)

_Planner refines this list against existing `tests/` conventions._

---

## Manual-Only Verifications

| Behavior                                                     | Requirement | Why Manual                                             | Test Instructions                                                                                |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Render free-tier full-stack deploy reachable on assigned URL | DEPLOY-02   | Requires a real Render free-tier account + fresh clone | Deploy `render.yaml` from a fresh clone; hit assigned URL; confirm api+embedded-worker healthy   |
| `cosign verify` on a fresh machine (amd64 + arm64)           | DEPLOY-04   | Cross-arch + fresh-machine trust-root needed           | Pull each of 4 images per arch; run documented keyless `cosign verify`; confirm SBOM attestation |
| Measured 1k-page sizing baseline (live LLM spend)            | DEPLOY-09   | Real LLM cost + wall-clock on defined cloud VM         | Run harness once per tier on the named VM; record timings + cost-per-page                        |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency target documented per lane
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
