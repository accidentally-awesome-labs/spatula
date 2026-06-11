---
phase: 17
slug: browser-auth-sse-cors
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-19
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| **Framework**          | vitest                                                         |
| **Config file**        | repo `vitest.config.ts` per-package; `tests/` workspace config |
| **Quick run command**  | `pnpm vitest run --changed`                                    |
| **Full suite command** | `pnpm vitest run`                                              |
| **Estimated runtime**  | ~60–120 seconds (e2e/isolation suites add Docker boot time)    |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --changed`
- **After every plan wave:** Run `pnpm vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

> Populated by gsd-planner from RESEARCH.md §Validation Architecture. Each AUTH-XX
> requirement maps to concrete test files below.

| Requirement | Test Type      | Test File (target)                                | Notes                                                                                           |
| ----------- | -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| AUTH-01     | integration    | `apps/api/tests/sse/job-events.test.ts`           | SSE headers, monotonic id, Last-Event-ID resume, 5-min replay, 15s keep-alive, replay_truncated |
| AUTH-02     | integration    | `apps/api/tests/sse/stream-token.test.ts`         | single-use `?token=` consume via GETDEL, 60s TTL, WS+SSE dual-purpose                           |
| AUTH-03     | integration    | `apps/api/tests/cors/origin-matrix.test.ts`       | exact-list + `https://*.spatula.dev` wildcard request matrix; boot fail-fast                    |
| AUTH-04     | e2e            | `tests/e2e/browser/oidc-sse-flow.spec.ts`         | `docker compose up` Dex boot + Playwright full chain                                            |
| AUTH-05     | integration    | `apps/api/tests/routes/api-keys-rotate.test.ts`   | two-key grace window, scope inheritance, audit emit                                             |
| AUTH-06     | unit + CI gate | `apps/api/tests/docs/api-auth-scope-sync.test.ts` | doc scope table matches `DEFAULT_API_KEY_SCOPES`                                                |
| AUTH-07     | integration    | `tests/isolation/cross-tenant.test.ts`            | OpenAPI-driven enumeration; every authed route 403/404                                          |
| AUTH-08     | e2e            | `tests/e2e/m2m/client-credentials.spec.ts`        | Dex `client_credentials` → SDK createJob → listJobs → getEntities                               |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] Drizzle migration: add `supersedes` / `supersededBy` columns to `api_keys` table (AUTH-05 blocker)
- [ ] ErrorCode enum: resolve `RESOURCE_NOT_FOUND` vs per-resource codes for isolation assertions (AUTH-07 blocker — see RESEARCH open question 1)
- [ ] `examples/auth-dex/` Docker fixture must boot before AUTH-04 / AUTH-08 e2e suites can run
- [ ] Playwright dependency + browser binaries for `tests/e2e/browser/` (verify installed)

_Confirm against RESEARCH.md §Validation Architecture before Wave 1._

---

## Manual-Only Verifications

| Behavior                                               | Requirement | Why Manual                                                           | Test Instructions                                                              |
| ------------------------------------------------------ | ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `docker compose up` boots Dex IDP in <10s on clean Mac | AUTH-04     | Wall-clock perf on operator hardware not CI-reproducible             | Fresh checkout → `cd examples/auth-dex && docker compose up` → time to healthy |
| Token-in-URL log-leak masking documented behavior      | AUTH-02     | Reverse-proxy masking is Phase 19; Phase 17 only documents it exists | Read `docs/api-auth.md` Stream Tokens section confirms masking note            |

_Most phase behaviors have automated verification — only the two above are manual._

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
