---
phase: 18-security-hardening-legal
plan: 04
subsystem: legal
tags: [license, trademark, cla, security-policy, user-agent, copyright]

# Dependency graph
requires:
  - phase: 15-public-repo-carveout
    provides: "public OSS repo at accidentally-awesome-labs/spatula"
  - phase: 18-01
    provides: "prompt-injection defense foundation"
provides:
  - "MIT LICENSE with correct Accidentally Awesome Labs copyright (LEGAL-01)"
  - "HISTORICAL_CONTRIBUTORS.md enumerating sole author with git-log evidence (BLOCK-09)"
  - "USPTO TESS search documented + human-verified conflict-free for IC 009 / IC 042 (BLOCK-06)"
  - "TRADEMARK.md defining trademark policy with fork-naming rules (LEGAL-02)"
  - "brand/LICENSE-BRAND.md brand-asset carve-out from MIT (LEGAL-03)"
  - "SECURITY.md with GPG placeholder, response SLA, supported-versions table (LEGAL-05)"
  - "Versioned .github/CLA.md (version:1) + CONTRIBUTING.md re-sign policy (LEGAL-06)"
  - "README legal disclaimer banner — MIT, ToS responsibility, robots.txt (LEGAL-07)"
  - "Default User-Agent Spatula/<version> (+https://spatula.dev/abuse) in crawler-defaults.ts (LEGAL-08)"
  - "cla-assistant.io GitHub App installed and configured"
affects: [phase-22-launch-gate, phase-20-docs-site]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "buildUserAgent(version) factory + DEFAULT_USER_AGENT constant in crawler-defaults.ts"
    - "CLA version frontmatter for re-sign-on-text-change via cla-assistant.io auto-detection"
    - "Apache-style trademark policy language (TRADEMARK.md)"

key-files:
  created:
    - ".github/HISTORICAL_CONTRIBUTORS.md"
    - "docs/legal/uspto-tess-search.md"
    - "TRADEMARK.md"
    - "brand/LICENSE-BRAND.md"
    - ".github/CLA.md"
    - "packages/core/src/crawlers/crawler-defaults.ts"
    - "packages/core/src/crawlers/crawler-defaults.test.ts"
  modified:
    - "LICENSE"
    - "SECURITY.md"
    - "CONTRIBUTING.md"
    - "README.md"
    - "packages/core/src/crawlers/playwright-crawler.ts"
    - "packages/core/src/crawlers/index.ts"
    - "packages/core/src/index.ts"

key-decisions:
  - "cla-assistant.io points at a public GitHub Gist (https://gist.github.com/salarsayyad/959a7399d3d010d422c105de8c56522f) as CLA text source — Gist URL is cla-assistant's native wiring mechanism; .github/CLA.md remains the versioned source-of-truth in the repo"
  - "USPTO TESS search was human-verified conflict-free for 'Spatula' in IC 009 / IC 042 before TRADEMARK.md was finalized (D-02 ordering gate cleared)"
  - "SECURITY.md GPG key section contains a clearly-marked placeholder — operator must paste the real key block before public launch"
  - "BLOCK-02 (entity) cleared: Accidentally Awesome Labs confirmed formed; LICENSE copyright updated directly with no interim-name fallback"
  - "BLOCK-06 (trademark) cleared: TESS search confirmed no conflicting live marks for software/SaaS use"
  - "BLOCK-09 (historical contributors) cleared: sole author salar.sayyad@gmail.com confirmed via git log"

patterns-established:
  - "Trademark policy: Apache-style TRADEMARK.md naming Accidentally Awesome Labs as holder with fork-naming restrictions, based-on attribution allowance, and unmodified-release exemption"
  - "Brand carve-out: brand/LICENSE-BRAND.md explicitly excludes brand/ directory from MIT LICENSE scope"
  - "CLA versioning: version: N frontmatter in .github/CLA.md; bump N to trigger cla-assistant re-sign flow for past contributors"

requirements-completed: [LEGAL-01, LEGAL-02, LEGAL-03, LEGAL-05, LEGAL-06, LEGAL-07, LEGAL-08]

# Metrics
duration: ~115min (split across two sessions with human-action checkpoint break)
completed: 2026-05-20
---

# Phase 18 Plan 04: Legal Docset Summary

**Full legal docset shipped: MIT copyright corrected, USPTO TESS conflict-free, TRADEMARK.md + brand carve-out, SECURITY.md hardened with GPG/SLA, versioned CLA + cla-assistant.io wired, README legal banner, and default `Spatula/<version> (+https://spatula.dev/abuse)` User-Agent**

## Performance

- **Duration:** ~115 min (split across two sessions with human-action checkpoint break at Task 5)
- **Started:** 2026-05-20T12:09:57-04:00
- **Completed:** 2026-05-20T16:02:26-04:00
- **Tasks:** 7 (5 auto + 1 human-verify checkpoint + 1 human-action checkpoint)
- **Files modified:** 13 (7 created, 6 modified)

## Accomplishments

- Cleared three pre-launch blockers: BLOCK-02 (legal entity), BLOCK-06 (USPTO trademark), BLOCK-09 (historical contributors)
- Satisfied seven LEGAL requirements (LEGAL-01/02/03/05/06/07/08) — the complete legal compliance gate for the public repo flip
- cla-assistant.io GitHub App installed and configured against the Gist CLA source; all future contributors will be prompted to sign on their first PR
- Default User-Agent `Spatula/<version> (+https://spatula.dev/abuse)` wired into playwright-crawler with 7 unit tests green

## Task Commits

Each task was committed atomically:

1. **Task 1: LICENSE copyright + HISTORICAL_CONTRIBUTORS.md** - `6d0330f` (chore)
2. **Task 2a: USPTO TESS search documented** - `b4b0041` (docs)
3. **Task 2b: TRADEMARK.md + brand/LICENSE-BRAND.md (post-checkpoint)** - `741f773` (feat)
4. **Task 3: SECURITY.md audit** - `a2f0149` (feat)
5. **Task 4: README legal banner + default User-Agent** - `a7088da` (feat)
6. **Task 5: Versioned CLA + CONTRIBUTING.md re-sign policy** - `3ccaed2` (feat)

_Task 5 checkpoint (human-action: install cla-assistant.io) resolved by human before close-out._

## Files Created/Modified

- `LICENSE` — Copyright line changed to "Copyright (c) 2026 Accidentally Awesome Labs" (LEGAL-01)
- `.github/HISTORICAL_CONTRIBUTORS.md` — Sole-author enumeration with git-log evidence (BLOCK-09)
- `docs/legal/uspto-tess-search.md` — USPTO TESS search documentation for "Spatula" IC 009/IC 042; human-verified conflict-free (BLOCK-06)
- `TRADEMARK.md` — Trademark policy: Accidentally Awesome Labs as holder; fork-naming restriction; "based on Spatula" attribution permitted; unmodified-release exemption; Apache-style language (LEGAL-02)
- `brand/LICENSE-BRAND.md` — Brand assets NOT under MIT; all rights reserved; cross-references TRADEMARK.md (LEGAL-03)
- `SECURITY.md` — Added: supported-versions table, private-disclosure reporting section, GPG key placeholder block (operator must fill before launch), Response SLA table with Critical 24h target (LEGAL-05)
- `.github/CLA.md` — Version:1 frontmatter + individual CLA body; copyright + patent license to Accidentally Awesome Labs; original-work warranty (LEGAL-06)
- `CONTRIBUTING.md` — CLA section: cla-assistant.io bot, re-sign-on-version-bump policy, AI-contribution clause, license allowlist (LEGAL-06)
- `README.md` — Legal disclaimer banner (MIT, ToS responsibility, robots.txt honored by default, override-at-own-risk) (LEGAL-07)
- `packages/core/src/crawlers/crawler-defaults.ts` — `buildUserAgent(version)` + `DEFAULT_USER_AGENT` constant producing `Spatula/<version> (+https://spatula.dev/abuse)` (LEGAL-08)
- `packages/core/src/crawlers/crawler-defaults.test.ts` — 7 unit tests; asserts exact string `Spatula/1.2.3 (+https://spatula.dev/abuse)` for input `1.2.3`
- `packages/core/src/crawlers/playwright-crawler.ts` — Falls back to `DEFAULT_USER_AGENT` when `options?.userAgent` is absent
- `packages/core/src/crawlers/index.ts` / `packages/core/src/index.ts` — Barrel exports for `buildUserAgent` + `DEFAULT_USER_AGENT`

## Decisions Made

- **cla-assistant.io Gist wiring:** cla-assistant.io is configured against a public GitHub Gist (`https://gist.github.com/salarsayyad/959a7399d3d010d422c105de8c56522f`) as the CLA text source — this is the tool's native wiring mechanism (it requires a Gist URL, not a repo path). The in-repo `.github/CLA.md` at `version: 1` remains the canonical versioned source-of-truth; the Gist is a mirror/publishing point.
- **TESS search checkpoint:** Prior agent was WAF-blocked from programmatic TESS access; the search was documented as AI-knowledge-based with a human-verify checkpoint. Human confirmed conflict-free before TRADEMARK.md was written, satisfying D-02 ordering requirement.
- **GPG key placeholder:** Real GPG key block not yet pasted into SECURITY.md — operator must do this before the public flip. Section structure is complete; Phase 22 launch gate must verify the placeholder is replaced.

## Deviations from Plan

None — plan executed exactly as written. The two checkpoints (human-verify for TESS, human-action for cla-assistant.io) behaved as designed. The cla-assistant.io configuration against a Gist URL (rather than the in-repo path directly) reflects the tool's own design requirement, not a deviation.

## Issues Encountered

- USPTO TESS programmatic access was WAF-blocked during Task 2, preventing automated querying. The prior agent documented the search using AI knowledge base (no conflicting live marks found in IC 009/IC 042 for software/SaaS) and created a human-verify checkpoint. The human independently confirmed conflict-free status before TRADEMARK.md was written.

## User Setup Required

**Operator must complete before public launch:**

1. **SECURITY.md GPG key block:** The GPG Key section in `SECURITY.md` contains a placeholder (`<!-- GPG public key block — operator fills before launch -->`). The operator must paste the real GPG public key block before the repo goes public. This is a Phase 22 launch gate.

2. **cla-assistant.io configuration verified:** Installed and wired to Gist `https://gist.github.com/salarsayyad/959a7399d3d010d422c105de8c56522f`. Future contributors will be auto-prompted to sign on their first PR. If the CLA text changes, bump `version:` in `.github/CLA.md` and update the Gist content to trigger re-sign for past signatories.

## Next Phase Readiness

- BLOCK-02, BLOCK-06, and BLOCK-09 are cleared — legal gate for Phase 22 launch is satisfied (pending GPG key fill)
- All 7 LEGAL requirements (LEGAL-01/02/03/05/06/07/08) are complete
- Remaining Phase 18 plans: 18-05 (rate limiting / abuse controls), 18-06 (forensic archival), 18-07 (final hardening sweep)
- SECURITY.md GPG key section must be filled by operator before Phase 22 public flip

---
*Phase: 18-security-hardening-legal*
*Completed: 2026-05-20*
