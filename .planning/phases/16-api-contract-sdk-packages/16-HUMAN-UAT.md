---
status: partial
phase: 16-api-contract-sdk-packages
source: [16-VERIFICATION.md]
started: 2026-05-19T12:20:00Z
updated: 2026-05-19T12:20:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. BLOCK-04 — confirm npm @spatula org ownership OR accept fallback scope @spatulaai
expected: `npm org ls @spatula` (run as accidentally-awesome-labs publishing identity) exits 0 OR the user accepts the documented fallback rename plan in 16-5-BLOCK04.md
result: [pending]

### 2. npm trusted-publisher dashboard configuration for all 8 packages
expected: For each of @spatula/{client,core-types,cli,core,db,queue,shared,api} the npm web UI has a trusted publisher registered with Organization=accidentally-awesome-labs, Repository=spatula, Workflow=release.yml
result: [pending]

### 3. release-please CI dry-run produces a valid plan once config lands on main
expected: First PR after merge of release-please-config + release-dry-run.yml runs `.github/workflows/release-dry-run.yml` and surfaces the 8-package monorepo plan (artifact uploaded)
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
