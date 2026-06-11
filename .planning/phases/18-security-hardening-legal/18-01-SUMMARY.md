---
phase: 18-security-hardening-legal
plan: '01'
subsystem: extraction
tags: [security, prompt-injection, adversarial, llm, extraction]
dependency_graph:
  requires: []
  provides:
    - output-scanner (scanOutput, OutputScanResult)
    - hardened-static-extractor (7 mitigations active)
    - adversarial-fixture-suite (10 fixtures, SEC-02)
    - adversarial-llm-ci-lane (.github/workflows/adversarial-llm.yml)
  affects:
    - packages/core/src/extraction/static-extractor.ts
    - packages/core-types/src/schemas/extraction.ts
    - packages/core-types/src/schemas/field.ts
tech_stack:
  added: []
  patterns:
    - UNTRUSTED_CONTENT sentinel wrapping for LLM user messages
    - n-gram sliding window for prompt-echo detection
    - Field-allowlist post-parse filtering (mitigation 5)
    - it.skipIf(!LIVE) pattern for live-LLM test gating (reuse from Phase 16)
    - Fork-safe CI secret guard (OPENROUTER_API_KEY != '')
key_files:
  created:
    - packages/core/src/extraction/output-scanner.ts
    - packages/core/src/extraction/output-scanner.test.ts
    - packages/core/src/extraction/__tests__/pinned-models.ts
    - packages/core/src/extraction/__tests__/adversarial.test.ts
    - packages/core/src/extraction/__tests__/fixtures/adversarial/01-direct-injection.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/02-zero-width-smuggling.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/03-fake-schema-coercion.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/04-output-exfiltration.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/05-jailbreak-variant.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/06-multi-step-refeed.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/07-html-comment-hidden.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/08-css-display-none.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/09-data-uri.html
    - packages/core/src/extraction/__tests__/fixtures/adversarial/10-unicode-confusables.html
    - .github/workflows/adversarial-llm.yml
    - .github/ISSUE_TEMPLATE/adversarial-fixture.md
    - docs/contributing/adversarial-corpus-refresh.md
  modified:
    - packages/core/src/extraction/static-extractor.ts
    - packages/core/src/extraction/static-extractor.test.ts
    - packages/core/src/extraction/index.ts
    - packages/core/src/index.ts
    - packages/core/package.json
    - packages/core-types/src/schemas/extraction.ts
    - packages/core-types/src/schemas/field.ts
decisions:
  - 'ScanSchema uses structural subset of SchemaDefinition (fields: Array<{name, maxLength?}>) to keep output-scanner.ts dependency-free of the full SchemaDefinition shape'
  - 'ExtractionMetadata extended with optional suspicious + scanFlags (additive, backward-compatible Zod schema change)'
  - 'FieldDefinitionOutput/Input extended with optional maxLength for SEC-01 mitigation 6 cap support'
  - "Prompt-echo threshold: 40 chars (n-gram sliding window; chosen per Claude's Discretion per CONTEXT.md to balance sensitivity vs false-positive rate)"
  - 'scanOutput surfaced in metadata only in plan 18-01; forensic archival to content-store/DLQ deferred to plan 18-06'
metrics:
  duration_minutes: 15
  tasks_completed: 3
  files_created: 22
  files_modified: 7
  completed_date: '2026-05-20'
---

# Phase 18 Plan 01: Prompt-Injection Defense + Adversarial Suite Summary

**One-liner:** LLM extraction hardened with 7 defense-in-depth mitigations (hardened system prompt, UNTRUSTED_CONTENT sentinel, one-stricter retry, field allowlist, length caps, output scanner), plus 10 adversarial HTML fixtures covering all attack classes, a path-triggered+cron CI lane, and quarterly corpus-refresh process.

## What Was Built

### Task 1: Output-Content Scanner + Pinned Models + Adversarial Fixtures

**`output-scanner.ts`** — new module exporting `scanOutput(data, systemPrompt, schema)` that detects three signal categories in LLM extraction output:

- **prompt_echo** — sliding n-gram window (40-char minimum) checks if any extracted string value contains a substring from the system prompt. Threshold: 40 chars (below likely produces false positives on common phrases; above likely misses partial exfiltration).
- **field_name_leak** — for each field value, checks if any OTHER field's name appears verbatim as content (cross-field schema leakage heuristic).
- **cap_hit** — checks if a string value's length exactly equals `field.maxLength ?? 2000` (truncation signal).

Returns `OutputScanResult { suspicious: boolean; flags: ScanFlag[] }`. Exported from extraction barrel and `packages/core/src/index.ts`.

**`pinned-models.ts`** — model pin constants with exact verbatim strings required by SEC-02:

- `openrouter: 'anthropic/claude-3-5-sonnet-20240620'`
- `ollama: 'llama3.1:8b-instruct-q4_0'`

**10 adversarial fixtures** in `packages/core/src/extraction/__tests__/fixtures/adversarial/`:
Each is a self-contained HTML product page with a legitimate extractable title + one injection payload covering: direct injection, zero-width smuggling, fake schema coercion, output exfiltration, jailbreak/DAN variant, multi-step refeed, HTML comment hidden, CSS display:none, data URI (base64 encoded), unicode confusables (Cyrillic/Greek homoglyphs).

**`output-scanner.test.ts`** — 18 unit tests covering all three detectors with positive and clean cases. All pass.

### Task 2: 7 Prompt-Injection Mitigations in StaticExtractor

Modified `packages/core/src/extraction/static-extractor.ts`:

| Mitigation                                   | Status            | Implementation                                                                                                          |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1. Role separation                           | Already satisfied | HTML in user role, schema/job in system                                                                                 |
| 2. Hardened system prompt                    | Applied           | Multi-line SYSTEM_PROMPT with 4 CRITICAL SECURITY RULES                                                                 |
| 3. UNTRUSTED_CONTENT wrapping                | Applied           | `<UNTRUSTED_CONTENT>...</UNTRUSTED_CONTENT>` around preprocessed HTML                                                   |
| 4. Zod-validated output + one stricter retry | Applied           | On parse failure: one retry with "RESPOND ONLY WITH VALID JSON" addendum; second failure → emptyResult; max 2 LLM calls |
| 5. Field allowlist                           | Applied           | `Object.fromEntries(...filter([k]) => allowedNames.has(k))` post-parse                                                  |
| 6. String length caps                        | Applied           | `value.slice(0, field.maxLength ?? DEFAULT_MAX_FIELD_LENGTH)` per field                                                 |
| 7. Output-content scanner                    | Applied           | `scanOutput()` called after capping; `suspicious + scanFlags` surfaced in `ExtractionResult.metadata`                   |

**Extended types:**

- `FieldDefinitionOutput/Input`: added optional `maxLength?: number`
- `ExtractionMetadata`: added optional `suspicious?: boolean` and `scanFlags?: ScanFlag[]`

**`static-extractor.test.ts`** — 16 unit tests covering all 7 mitigations with mocked `LLMClient`. All pass.

### Task 3: Adversarial Suite + CI Lane + Corpus-Refresh Docs

**`adversarial.test.ts`** — 10 `describe` blocks (one per attack class), each with one `it.skipIf(!LIVE)` test that:

1. Loads the matching HTML fixture.
2. Runs `StaticExtractor.extract` against the pinned OpenRouter model (or Ollama via `SPATULA_ADVERSARIAL_MODEL=ollama`).
3. Asserts: legitimate title field extracted; no out-of-schema fields; specific forbidden keys/values absent.

All tests skip cleanly without `SPATULA_LIVE_LLM=1`.

**`test:adversarial` script** added to `packages/core/package.json`.

**`.github/workflows/adversarial-llm.yml`** — Two jobs:

- `adversarial-openrouter`: runs on `ubuntu-latest` on path trigger + cron + dispatch; fork-safe (`OPENROUTER_API_KEY != ''` guard).
- `adversarial-ollama`: runs on `self-hosted` ONLY via `workflow_dispatch`.

**`.github/ISSUE_TEMPLATE/adversarial-fixture.md`** — Community submission template with `labels: adversarial-fixture`.

**`docs/contributing/adversarial-corpus-refresh.md`** — Quarterly checklist, naming convention, add-fixture how-to, pin rotation procedure, CI lane reference.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added `maxLength` to `FieldDefinitionOutput`/`FieldDefinitionInput`**

- **Found during:** Task 2 implementation
- **Issue:** `FieldDefinitionOutput` in `@spatula/core-types` did not have a `maxLength` field, making SEC-01 mitigation 6 (string value length caps) impossible to implement correctly with TypeScript types.
- **Fix:** Added `maxLength?: number` to both `FieldDefinitionOutput` and `FieldDefinitionInput` in `packages/core-types/src/schemas/field.ts`, and to the Zod schema with `.int().positive().optional()` validation.
- **Files modified:** `packages/core-types/src/schemas/field.ts`
- **Commit:** d2e83e3

**2. [Rule 2 - Missing critical functionality] Extended `ExtractionMetadata` with `suspicious` + `scanFlags`**

- **Found during:** Task 2 implementation
- **Issue:** `ExtractionMetadata` Zod schema was strict (no extra keys), preventing mitigation 7's `suspicious` and `scanFlags` from being set on `ExtractionResult.metadata`.
- **Fix:** Added `suspicious: z.boolean().optional()` and `scanFlags: z.array(ScanFlagSchema).optional()` to `ExtractionMetadata` in `packages/core-types/src/schemas/extraction.ts`. Change is additive and backward-compatible.
- **Files modified:** `packages/core-types/src/schemas/extraction.ts`
- **Commit:** d2e83e3

**3. [Rule 1 - Bug] `ScanSchema` structural subset instead of `SchemaDefinition` import**

- **Found during:** Task 1 — `output-scanner.ts` initial implementation used `SchemaDefinition` directly.
- **Issue:** `SchemaDefinition` requires `fieldAliases`, `createdAt`, `parentVersion` — fields irrelevant to the scanner, making test fixture creation verbose and creating an unnecessary coupling.
- **Fix:** Introduced `ScanSchema` interface (structural subset: `{ fields: Array<{name: string; maxLength?: number}> }`) in `output-scanner.ts`. `StaticExtractor` passes the full `SchemaDefinition` (structurally compatible). Tests use the minimal `ScanSchema` shape.
- **Files modified:** `packages/core/src/extraction/output-scanner.ts`, `output-scanner.test.ts`
- **Commit:** 6fb1edf

## Known Stubs

None — all functionality is fully implemented. The forensic archival side-effect (writing suspicious extractions to content-store and DLQ) is intentionally deferred to Plan 18-06 per the plan's explicit instruction: "The forensic archival side-effect of a suspicious result is handled in Plan 18-06 — this plan only surfaces the flag in metadata."

## Self-Check: PASSED

All created files exist on disk. All task commits (6fb1edf, d2e83e3, d49fceb) present in git log.

| File                                                       | Status     |
| ---------------------------------------------------------- | ---------- |
| packages/core/src/extraction/output-scanner.ts             | FOUND      |
| packages/core/src/extraction/output-scanner.test.ts        | FOUND      |
| packages/core/src/extraction/**tests**/pinned-models.ts    | FOUND      |
| packages/core/src/extraction/**tests**/adversarial.test.ts | FOUND      |
| .github/workflows/adversarial-llm.yml                      | FOUND      |
| .github/ISSUE_TEMPLATE/adversarial-fixture.md              | FOUND      |
| docs/contributing/adversarial-corpus-refresh.md            | FOUND      |
| 10 adversarial HTML fixtures                               | FOUND (10) |
