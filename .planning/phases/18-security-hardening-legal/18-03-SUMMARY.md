---
phase: 18-security-hardening-legal
plan: '03'
subsystem: ci-security
tags: [security, ci, license, supply-chain, dependabot, renovate, trufflehog, gitleaks, osv, legal]
dependency_graph:
  requires: []
  provides: [hardened-audit-ci, dependency-monitoring, third-party-notices]
  affects: [.github/workflows/audit.yml, package.json, THIRD_PARTY_NOTICES.md]
tech_stack:
  added:
    - license-checker-rseidelsohn@4.4.2 (devDependency, exact pin)
    - google/osv-scanner-action@v1 (GitHub Action)
    - gitleaks/gitleaks-action@v2 (GitHub Action)
    - trufflesecurity/trufflehog@main (GitHub Action)
    - Dependabot v2 (GitHub native)
    - Renovate (GitHub App)
  patterns:
    - Three-job CI security audit (osv-scan / license-check / secret-scan)
    - Dual dependency monitoring (Dependabot as baseline + Renovate for richer grouping)
    - Auto-generated THIRD_PARTY_NOTICES with header prepend on every run
key_files:
  created:
    - .github/dependabot.yml
    - renovate.json
    - scripts/notices-template.json
    - THIRD_PARTY_NOTICES.md
  modified:
    - .github/workflows/audit.yml
    - package.json
    - pnpm-lock.yaml
decisions:
  - 'Both Dependabot and Renovate are intentionally present: Dependabot as the always-on GitHub-native baseline; Renovate as the richer grouping/scheduling engine. Operators can disable either.'
  - 'generate:notices uses --start apps/api to traverse the apps/api node_modules tree (pnpm hoists prod deps there). Root node_modules only has devDependencies hoisted at workspace level, so license-checker-rseidelsohn found zero packages from root.'
  - 'Script auto-prepends the LEGAL-04 header (regenerate-per-release notice) via an inline node one-liner appended with &&, so the header is preserved on every run without a separate wrapper script.'
  - '--markdown flag confirmed supported in license-checker-rseidelsohn@4.4.2 (preferred over --csv for readability)'
metrics:
  duration_minutes: 4
  completed_date: '2026-05-20'
  tasks_completed: 3
  files_changed: 6
---

# Phase 18 Plan 03: Supply-Chain Security + Third-Party Notices Summary

**One-liner:** Hardened audit.yml with OSV+gitleaks+trufflehog daily CI, Dependabot+Renovate dual monitoring, and auto-generated THIRD_PARTY_NOTICES.md via pinned license-checker-rseidelsohn.

## Tasks Completed

| Task | Name                                      | Commit  | Key Files                                                           |
| ---- | ----------------------------------------- | ------- | ------------------------------------------------------------------- |
| 1    | Harden audit.yml                          | 5a9a246 | .github/workflows/audit.yml                                         |
| 2    | Dependabot + Renovate configs             | a60500e | .github/dependabot.yml, renovate.json                               |
| 3    | generate:notices + THIRD_PARTY_NOTICES.md | d82da9e | package.json, scripts/notices-template.json, THIRD_PARTY_NOTICES.md |

## What Was Built

### Task 1: Hardened audit.yml (SEC-11)

Replaced the minimal `pnpm audit --audit-level=high` weekly workflow with a three-job security audit:

- **`osv-scan`** — calls the reusable `google/osv-scanner-action` workflow against `pnpm-lock.yaml`. More comprehensive than `pnpm audit` (OSV database covers advisories pnpm audit misses).
- **`license-check`** — installs deps then runs `license-checker-rseidelsohn` with `--excludePrivatePackages` (Pitfall 5 avoidance), `--failOn "GPL;AGPL;LGPL;CC-BY-SA;OSL"`, `--onlyAllow` the approved SPDX identifiers. Fails CI if any new dep introduces a copyleft or share-alike license.
- **`secret-scan`** — runs `gitleaks/gitleaks-action@v2` + `trufflesecurity/trufflehog@main` with `fetch-depth: 0` (full history scan) and `--only-verified` (reduces false positives).

Trigger upgraded: daily cron (`0 9 * * *`) instead of weekly, plus push to `main` and `workflow_dispatch`.

### Task 2: Dependabot + Renovate dual monitoring (SEC-12)

`.github/dependabot.yml` (version 2):

- `npm` ecosystem at `/` — covers pnpm workspaces from root, weekly, 10 PR limit, `deps` prefix
- `github-actions` ecosystem at `/` — keeps Action pinned versions fresh, weekly, `ci` prefix

`renovate.json`:

- Extends `config:recommended`
- `schedule: ["before 6am on monday"]` + `prConcurrentLimit: 10`
- `packageRules`: groups devDependencies together; labels production deps as `production-deps` for individual review

Design decision: both tools coexist. Dependabot is the always-on GitHub-native baseline (no external App setup needed); Renovate provides richer grouping and scheduling once installed as a GitHub App.

### Task 3: generate:notices + THIRD_PARTY_NOTICES.md (LEGAL-04)

- `license-checker-rseidelsohn` installed at workspace root as exact-pinned `4.4.2` devDependency (no caret drift).
- `scripts/notices-template.json` defines the custom output format: `name / version / licenses / repository / licenseText`.
- `generate:notices` script added to root `package.json`:
  ```
  license-checker-rseidelsohn --excludePrivatePackages --production --markdown \
    --start apps/api --out THIRD_PARTY_NOTICES.md \
    --customPath scripts/notices-template.json \
  && node -e "...prepend LEGAL-04 header if missing..."
  ```
- `--start apps/api` required because pnpm hoists production dependencies into `apps/api/node_modules`; the workspace root `node_modules` only contains devDependencies.
- Initial `THIRD_PARTY_NOTICES.md` generated and committed (~3800 lines, all Apache-2.0/MIT/BSD/ISC — no GPL contamination found).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `license-checker-rseidelsohn` found zero packages from workspace root**

- **Found during:** Task 3
- **Issue:** Running `license-checker-rseidelsohn` from the workspace root yielded "No packages found in this path" because pnpm virtual store symlinks are in `.pnpm/` and the tool's `read-installed-packages` cannot traverse them from root.
- **Fix:** Added `--start apps/api` to point the tool at `apps/api/node_modules` which contains the full hoisted production dependency tree. This is the correct behavior for pnpm monorepos.
- **Files modified:** `package.json` (generate:notices script)
- **Commit:** d82da9e

**2. [Rule 2 - Missing functionality] Header lost on re-run**

- **Found during:** Task 3 verification (second run of `pnpm run generate:notices` wiped the manually-prepended header)
- **Fix:** Appended a `node -e "..."` one-liner to the script that checks if the file starts with `<!--` and prepends the LEGAL-04 header if missing. Idempotent — re-runs do not double-add the header.
- **Files modified:** `package.json` (generate:notices script inline)
- **Commit:** d82da9e

## Known Stubs

None — all deliverables in this plan are fully functional CI configs and a generated file. No placeholder data or hardcoded empty values.

## Self-Check: PASSED

Files:

- FOUND: .github/workflows/audit.yml (modified)
- FOUND: .github/dependabot.yml (created)
- FOUND: renovate.json (created)
- FOUND: scripts/notices-template.json (created)
- FOUND: THIRD_PARTY_NOTICES.md (created)

Commits:

- FOUND: 5a9a246 — feat(18-03): harden audit.yml
- FOUND: a60500e — feat(18-03): add Dependabot + Renovate configs
- FOUND: d82da9e — feat(18-03): add generate:notices + THIRD_PARTY_NOTICES.md
