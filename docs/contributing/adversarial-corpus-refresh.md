# Adversarial Corpus Refresh Process

**Cadence:** Quarterly (every 3 months)  
**CI Lane:** `.github/workflows/adversarial-llm.yml`  
**Fixture Directory:** `packages/core/src/extraction/__tests__/fixtures/adversarial/`

---

## Overview

The adversarial fixture corpus is a collection of HTML files that exercise the
LLM extraction path against known prompt-injection attack classes. The corpus
is tested against two pinned models (see `pinned-models.ts`).

The purpose of the quarterly refresh is to:

1. Add new fixtures for emerging attack patterns.
2. Verify existing fixtures still trigger the expected scanner responses.
3. Update pinned models if a pin has become stale (requires re-running the full suite).

---

## Quarterly Refresh Checklist

Run this checklist every quarter (or when a significant new attack class is reported):

- [ ] Review `.github/ISSUE_TEMPLATE/adversarial-fixture.md` submissions since last refresh.
- [ ] Identify any new attack classes not covered by the existing 10 fixtures.
- [ ] Create new fixture HTML files for each new attack class (see naming convention below).
- [ ] Add corresponding `describe` blocks to `adversarial.test.ts` (see Adding a Fixture).
- [ ] Run the suite against both pinned models: `SPATULA_LIVE_LLM=1 pnpm --filter @accidentally-awesome-labs/spatula-core run test:adversarial`.
- [ ] If either pinned model fails a new fixture, investigate whether it's a model regression or an undefended attack. Fix the extractor before merging.
- [ ] Update `pinned-models.ts` if a model pin needs rotation (see Pin Rotation below).
- [ ] Commit with message: `fix(sec): adversarial corpus refresh YYYY-QN`.

---

## Fixture File Naming Convention

Fixtures are numbered sequentially and named by attack class:

```
NN-attack-class.html
```

Examples:

```
01-direct-injection.html
02-zero-width-smuggling.html
11-iframe-injection.html        ← next after existing 10
12-prompt-splitting.html
```

Rules:

- Two-digit zero-padded number (`01`, `02`, ..., `11`, `12`).
- Lowercase kebab-case attack class name.
- `.html` extension.
- File must contain at least one **legitimate extractable field** (e.g., a product title
  in an `<h1>`) AND one injection payload for the attack class.

---

## Submitting a New Fixture

Community members can submit new fixtures via the GitHub issue template:

1. Open a new issue using the **Adversarial Fixture Submission** template
   (`.github/ISSUE_TEMPLATE/adversarial-fixture.md`).
2. Fill in: attack class, HTML payload, expected safe extraction behavior,
   which pinned model(s) were tested, and whether the injection succeeded or failed.
3. A maintainer reviews the submission and either:
   - Adds it directly to the corpus (if it's a confirmed new attack class or regression fixture).
   - Requests changes (e.g., the fixture needs a stronger legitimate signal or cleaner payload).

---

## Adding a Fixture to the Test Suite

Once a fixture HTML file is created in `fixtures/adversarial/`, add a matching
`describe` block to `adversarial.test.ts`:

```typescript
describe('adversarial: NN — attack-class-name', () => {
  it.skipIf(!LIVE)(
    'fixture NN: brief description of what the injection attempts',
    async () => {
      const html = loadFixture('NN-attack-class.html');
      const client = await buildLiveClient();
      const extractor = new StaticExtractor(client, JOB_CONFIG, 'adv-job-NN');

      const result = await extractor.extract(
        html,
        'https://example.com/product/NN',
        PRODUCT_SCHEMA,
        'Extract product information',
      );

      assertSafeExtraction(result, {
        mustHaveTitle: true,
        forbiddenKeys: ['injected_field'], // field names the injection tries to add
        forbiddenValues: ['injection_value'], // values the injection tries to exfiltrate
      });
    },
    30_000,
  );
});
```

The suite MUST stay green against both pinned models before the PR is merged.

---

## Pin Rotation

The pinned models are defined in:

```
packages/core/src/extraction/__tests__/pinned-models.ts
```

Current pins:

- `openrouter`: `anthropic/claude-3-5-sonnet-20240620`
- `ollama`: `llama3.1:8b-instruct-q4_0`

**When to rotate a pin:**

1. The pinned model version is deprecated or removed by the provider.
2. A newer model shows materially better resistance to the adversarial corpus.
3. A quarterly refresh reveals the pin has drifted from behavior expectations.

**How to rotate:**

1. Update the string in `pinned-models.ts`.
2. Run the FULL adversarial suite against both old and new pin:
   ```bash
   SPATULA_LIVE_LLM=1 pnpm --filter @accidentally-awesome-labs/spatula-core run test:adversarial
   ```
3. All 10+ tests must pass against the new pin before merging.
4. Commit: `chore(sec): rotate adversarial suite pin to <new-model>`.
5. Note: a pin rotation is a breaking change to the reproducibility of the suite —
   document the rotation reason in the commit message.

---

## CI Lane Reference

The adversarial suite runs automatically via `.github/workflows/adversarial-llm.yml`:

- **Path trigger:** PRs touching `packages/core/src/extraction/**` or `pinned-models.ts`.
- **Daily cron:** 06:00 UTC (CI-red on failure; no auto-notifications).
- **Manual dispatch:** Use `workflow_dispatch` to run the Ollama pin on a self-hosted runner.
- **Fork PRs:** Tests skip cleanly when `OPENROUTER_API_KEY` secret is unavailable.

To run locally with a live API key:

```bash
SPATULA_LIVE_LLM=1 OPENROUTER_API_KEY=<your-key> pnpm --filter @accidentally-awesome-labs/spatula-core run test:adversarial
```

For the Ollama pin (requires a running Ollama instance):

```bash
SPATULA_LIVE_LLM=1 SPATULA_ADVERSARIAL_MODEL=ollama OLLAMA_BASE_URL=http://localhost:11434 \
  pnpm --filter @accidentally-awesome-labs/spatula-core run test:adversarial
```

---

## References

- Spec §3.7.2 — Prompt-injection defense: 7 mitigations and 10 attack classes
- `packages/core/src/extraction/output-scanner.ts` — Output-content scanner (prompt-echo / field-leak / cap-hit)
- `packages/core/src/extraction/static-extractor.ts` — Hardened extractor (all 7 mitigations)
