# Tier 2+3: LLM Pipeline Integration Testing Design

**Status:** Draft
**Created:** 2026-04-04
**Scope:** End-to-end testing of the LLM-dependent pipeline paths using a mock Ollama server (Tier 2, deterministic, CI-friendly) and optionally real Ollama (Tier 3, conditional, nondeterministic).

---

## 1. Overview

Tier 1 testing (532 tests) covers all CLI commands that work without external services. The LLM-dependent pipeline paths — page classification, data extraction, schema evolution, entity reconciliation, link evaluation, and conversational configuration — remain untested. These paths represent the core intelligence of the system.

**Strategy:** A mock Ollama server returns canned JSON responses keyed on system prompt content + user prompt context. This tests the full integration plumbing (prompt construction, response parsing, entity creation, schema evolution, cross-command workflows) deterministically and fast. A parallel conditional test suite uses real Ollama for structural smoke tests.

**Dependencies:** Playwright (for crawling fixture pages). Tests skip gracefully if Playwright browsers are not installed.

---

## 2. Fixture Server

A local HTTP server on a random port serving static HTML pages. All pages include realistic boilerplate (nav bar, footer, script tags) so HTML preprocessing is exercised.

### Pages

| Path | Content | Pipeline Behavior |
|------|---------|-------------------|
| `/` | Listing page with links to all content pages + external link (`https://twitter.com/spatula`) + `/admin` link | Classify as `multiple_entries`/`navigation`, follow product/recipe links via link evaluator |
| `/products/widget-pro` | Product page: title "Widget Pro", price $29.99, image, description. Links to `/products/widget-pro-deluxe` (depth 2) | Classify as `single_entry`, extract product entity |
| `/products/widget-pro-deluxe` | Product page: title "Widget Pro" (same name, different price $34.99). Reached at depth 2 | Classify as `single_entry`, extract — reconciler detects duplicate by title |
| `/products/widget-pro/` | 301 redirect to `/products/widget-pro` | Redirect following + URL deduplication |
| `/products/comparison` | Table with 3 products side-by-side: Widget A ($19.99), Widget B ($24.99), Widget C ($29.99) | Classify as `multiple_entries`, `list_extraction` strategy, extract 3 entities |
| `/recipes/pasta-carbonara` | Recipe page: title, ingredients list, cook time (25 min), servings (4) | Classify as `single_entry`, extract recipe entity (different category triggers cross-category schema evolution) |
| `/about` | Company history, team bios, no structured product/recipe data | Classify as `irrelevant`, skip extraction |
| `/blog/review` | Half product review (Widget Pro), half opinion/editorial | Classify as `partial`, extract with low confidence |
| `/page/2` | Second listing page with 1 additional product link | Classify as `navigation`, follow links (pagination) |
| `/slow` | 3-second delayed response, then 200 with simple product page | Tests concurrency — pipeline should process other pages while waiting |
| `/broken-link` | Returns 404 | Error handling — no crash, pipeline continues |
| `/robots.txt` | `User-agent: *\nDisallow: /admin` | Robots.txt compliance |
| `/admin` | Admin panel HTML — should never be fetched | Verify pipeline never requests this |

### Request Logging

The fixture server logs every incoming request:

```typescript
interface FixtureRequest {
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
}
```

Tests inspect this log to verify which pages were crawled, which were skipped, and that `/admin` was never requested.

### HTML Structure

All content pages include realistic boilerplate to exercise HTML preprocessing:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Page Title</title>
  <script>var analytics = true;</script>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
  
  <!-- Main content (extraction target) -->
  <main>
    ...page-specific content...
  </main>
  
  <footer>Copyright 2026 Acme Corp. <a href="https://twitter.com/spatula">Twitter</a></footer>
  <script src="/analytics.js"></script>
</body>
</html>
```

---

## 3. Mock Ollama Server

A lightweight HTTP server impersonating Ollama's `/api/chat` endpoint. Inspects incoming prompts to determine which pipeline component is calling and what context it's operating in, then returns canned JSON responses.

### Endpoint

`POST /api/chat`

**Request body** (from OllamaClient):
```json
{
  "model": "string",
  "messages": [{ "role": "system|user|assistant", "content": "string" }],
  "stream": false,
  "options": { "temperature": 0.1, "num_predict": 4096 },
  "format": "json"
}
```

**Response body** (Ollama format):
```json
{
  "message": { "content": "<JSON string>" },
  "model": "llama3.2:1b",
  "done": true,
  "prompt_eval_count": 150,
  "eval_count": 80
}
```

### Routing Logic

1. Read system prompt (`messages[0].content`) to identify the component
2. Read user prompt (last user message) to identify page/context
3. Select canned response from response map

| System Prompt Pattern | Component | Context Detection |
|----------------------|-----------|-------------------|
| `"web page classifier"` | PageClassifier | HTML content keywords in user prompt |
| `"data extraction expert"` | StaticExtractor | HTML content + schema field count (detects re-extraction) |
| `"link evaluation"` | LLMLinkEvaluator | URLs listed in user prompt |
| `"propose new schema fields"` | FieldProposer | Unmapped field names in prompt |
| `"synonym detection"` | SynonymDetector | Always returns empty merges |
| `"normalization expert"` | NormalizationProposer | Field names in prompt |
| `"trustworthiness"` | SourceTrustEvaluator | Domain names in prompt |
| `"entity resolution"` | EntityMatcher | Extraction summaries — groups by matching titles |
| `"Infer missing"` | GapFiller | Always returns empty inferences |
| Contains `"ConfigAction"` | ConfigConversationService | User message count in history (multi-turn state) |

### Canned Responses

#### PageClassifier

| Page Detected (by HTML keywords) | Response |
|----------------------------------|----------|
| Listing page (multiple product links) | `{ classification: "multiple_entries", strategy: "links_only", confidence: 0.95, reasoning: "Product listing page with multiple items" }` |
| Widget Pro / Widget Pro Deluxe (product) | `{ classification: "single_entry", strategy: "full_extraction", estimatedEntryCount: 1, confidence: 0.92, reasoning: "Single product page" }` |
| Comparison table | `{ classification: "multiple_entries", strategy: "list_extraction", estimatedEntryCount: 3, confidence: 0.88, reasoning: "Product comparison table" }` |
| Pasta Carbonara (recipe) | `{ classification: "single_entry", strategy: "full_extraction", estimatedEntryCount: 1, confidence: 0.90, reasoning: "Recipe page" }` |
| About page | `{ classification: "irrelevant", strategy: "skip", confidence: 0.95, reasoning: "Company info, no extractable data" }` |
| Blog review | `{ classification: "partial", strategy: "full_extraction", confidence: 0.6, reasoning: "Mixed content — partial product data" }` |
| Navigation/pagination | `{ classification: "navigation", strategy: "links_only", confidence: 0.85, reasoning: "Pagination page" }` |
| Default | `{ classification: "irrelevant", strategy: "skip", confidence: 0.5, reasoning: "Unrecognized" }` |

#### StaticExtractor

First extraction (schema has only user-defined fields `title`, `price`):

| Page | Response |
|------|----------|
| Widget Pro | `{ data: { title: "Widget Pro", price: "$29.99", imageUrl: "https://example.com/widget.jpg", description: "The finest widget" }, _unmapped: [{ name: "brand", value: "Acme", suggestedType: "string" }], confidence: 0.91 }` |
| Widget Pro Deluxe | `{ data: { title: "Widget Pro", price: "$34.99", imageUrl: "https://example.com/widget-deluxe.jpg", description: "The deluxe widget" }, _unmapped: [{ name: "brand", value: "Acme", suggestedType: "string" }], confidence: 0.89 }` |
| Comparison Widget A | `{ data: { title: "Widget A", price: "$19.99" }, _unmapped: [], confidence: 0.85 }` |
| Comparison Widget B | `{ data: { title: "Widget B", price: "$24.99" }, _unmapped: [], confidence: 0.85 }` |
| Comparison Widget C | `{ data: { title: "Widget C", price: "$29.99" }, _unmapped: [], confidence: 0.85 }` |
| Pasta Carbonara | `{ data: { title: "Pasta Carbonara", cookTime: "25 min", servings: "4" }, _unmapped: [{ name: "cuisine", value: "Italian", suggestedType: "string" }, { name: "ingredients", value: ["pasta", "eggs", "pecorino", "guanciale"], suggestedType: "array" }], confidence: 0.93 }` |
| Blog review | `{ data: { title: "Widget Pro Review" }, _unmapped: [], confidence: 0.55 }` |

Re-extraction (detected by schema containing `brand` or `cuisine` fields):

| Page | Response |
|------|----------|
| Widget Pro | Same as above but `brand: "Acme"` moves from `_unmapped` to `data`, `_unmapped: []` |
| Pasta Carbonara | Same but `cuisine: "Italian"` and `ingredients` move from `_unmapped` to `data` |

#### LLMLinkEvaluator

| Links in Prompt | Response |
|----------------|----------|
| Product/recipe URLs from listing | `[{ url: "/products/widget-pro", follow: true, reasoning: "Product page" }, { url: "/recipes/pasta-carbonara", follow: true, reasoning: "Recipe content" }, { url: "/products/comparison", follow: true, reasoning: "Product data" }, { url: "/about", follow: true, reasoning: "Might contain data" }, { url: "/blog/review", follow: true, reasoning: "Product review" }, { url: "https://twitter.com/spatula", follow: false, reasoning: "External domain" }, { url: "/admin", follow: true, reasoning: "Might contain data" }]` |
| Links from product page (depth 2) | `[{ url: "/products/widget-pro-deluxe", follow: true, reasoning: "Related product" }]` |
| Pagination links | `[{ url: "/page/2", follow: true, reasoning: "More listings" }]` |

Note: The link evaluator returns `follow: true` for `/admin` — it's the robots.txt checker that prevents the actual crawl. This tests that robots.txt enforcement happens independently of link evaluation.

#### FieldProposer

```json
{
  "proposals": [
    {
      "name": "brand", "description": "Product brand name", "type": "string",
      "required": false, "reasoning": "Found in 2 of 5 product extractions",
      "confidence": 0.85,
      "relevance": {
        "globalFrequency": 0.4, "categoryBreakdown": [],
        "classification": "categorical_optional", "applicableCategories": ["product"]
      }
    },
    {
      "name": "cuisine", "description": "Cuisine type", "type": "string",
      "required": false, "reasoning": "Found in recipe extractions",
      "confidence": 0.8,
      "relevance": {
        "globalFrequency": 0.2, "categoryBreakdown": [],
        "classification": "categorical_optional", "applicableCategories": ["recipe"]
      }
    }
  ]
}
```

#### SynonymDetector

```json
{ "merges": [] }
```

#### NormalizationProposer

```json
{
  "rules": [{
    "fieldName": "price", "rule": { "type": "currency", "config": { "currency": "USD" } },
    "examples": [{ "before": "$29.99", "after": 29.99 }],
    "reasoning": "Standardize price to numeric USD", "confidence": 0.95
  }],
  "enumUpdates": []
}
```

#### SourceTrustEvaluator

```json
{
  "rankings": [{
    "domain": "localhost", "trustLevel": "high",
    "reasoning": "Primary crawl target"
  }]
}
```

#### EntityMatcher

Reads extraction summaries from the user prompt. Groups extractions with matching `title` values:

```json
{
  "groups": [
    { "extractionIds": ["<widget-pro-id>", "<widget-pro-deluxe-id>"], "reasoning": "Same product name: Widget Pro", "confidence": 0.88 },
    { "extractionIds": ["<widget-a-id>"], "reasoning": "Unique product", "confidence": 1.0 },
    { "extractionIds": ["<widget-b-id>"], "reasoning": "Unique product", "confidence": 1.0 },
    { "extractionIds": ["<widget-c-id>"], "reasoning": "Unique product", "confidence": 1.0 },
    { "extractionIds": ["<carbonara-id>"], "reasoning": "Unique recipe", "confidence": 1.0 },
    { "extractionIds": ["<review-id>"], "reasoning": "Unique review", "confidence": 1.0 }
  ]
}
```

The mock parses extraction IDs from the user prompt dynamically — it can't use hardcoded UUIDs.

#### GapFiller

```json
{ "inferences": [] }
```

#### ConfigConversationService (multi-turn)

Routes by counting user messages in the history:

| Turn (user message count) | Response |
|--------------------------|----------|
| 1 ("I want to scrape products from example.com") | `{ response: "I'll set up a product scraping project for example.com.", actions: [{ type: "set_name", id: "<uuid>", reasoning: "Project name", payload: { name: "Example Products" } }, { type: "set_seed_urls", id: "<uuid>", reasoning: "Seed URL", payload: { urls: ["https://example.com"] } }] }` |
| 2 ("also track the brand") | `{ response: "Added brand as a tracked field.", actions: [{ type: "add_user_field", id: "<uuid>", reasoning: "User requested", payload: { field: { name: "brand", type: "string", required: false, description: "Product brand" } } }] }` |
| 3 ("looks good, start") | `{ response: "Starting the crawl!", actions: [{ type: "confirm_and_start", id: "<uuid>", reasoning: "User confirmed", payload: {} }] }` |

### Error Simulation Modes

The mock accepts a configuration object:

```typescript
interface MockOllamaConfig {
  mode: 'happy' | 'malformed-json' | 'timeout' | 'zod-failure';
  failOnComponent?: string;   // e.g., 'classifier', 'extractor'
  failOnNthCall?: number;     // fail on the Nth call to that component
  timeoutDelayMs?: number;    // for timeout mode (default: 130_000)
}
```

- `malformed-json`: Returns `{broken json!!!` for the targeted call
- `timeout`: Delays response past OllamaClient's 120s timeout
- `zod-failure`: Returns valid JSON but missing required fields (e.g., omits `confidence`)

### Request Logging

Every request is recorded:

```typescript
interface MockOllamaRequest {
  timestamp: number;
  model: string;
  component: string;          // resolved from system prompt routing
  systemPromptPreview: string; // first 200 chars
  userPromptPreview: string;   // first 200 chars
  fullPrompt: string;          // complete prompt text (for snapshot tests)
  responsePreview: string;     // first 200 chars of canned response
}
```

The log supports:
- `getLog()`: full request array
- `getLogByComponent(component)`: filtered by component name
- `resetLog()`: clear for re-run tests
- `getCallCount()`: total LLM calls made

---

## 4. Shared Test Helpers (`helpers.ts`)

### `createFixtureProject(fixturePort, ollamaPort)`

Creates a temp directory with:
- `spatula.yaml` configured with:
  - `seeds: ["http://localhost:<fixturePort>/"]`
  - `depth: 2`, `limit: 20`
  - `crawlerType: 'playwright'`
  - User-defined fields: `title` (string, required), `price` (currency)
  - LLM config pointing to mock Ollama URL
- `.spatula/` directory with initialized project DB

Returns `{ projectDir, projectId, cleanup() }`.

### `buildPipelineRunner(projectDir, opts)`

Assembles the full DI graph matching `run.ts`:
- `OllamaClient` pointed at mock/real Ollama URL
- Playwright crawler
- All LLM-dependent components (PageClassifier, StaticExtractor, SchemaEvolverImpl, DataReconcilerImpl, LLMLinkEvaluator)
- `RobotsTxtChecker`, `InMemoryDomainRateLimiter`
- `LocalPipelineRunner` with all wiring

Returns `{ runner, adapter, dataSource, crawler, closeAll() }`.

### `isPlaywrightAvailable()`

Checks if Playwright browsers are installed by attempting to launch and close a headless Chromium instance. Returns boolean.

### `isOllamaAvailable()`

Fetches `GET http://localhost:11434/api/tags` with a 3-second timeout. Returns boolean.

---

## 5. Test Files

### 5.1 `pipeline-mock-llm.test.ts` — Full pipeline happy path (29 tests)

Tests 1-27 share a single pipeline run (executed once in `beforeAll`, asserted in each `it`). Tests 28-29 (re-run and graceful stop) execute additional pipeline runs within their own `it` blocks.

**Crawl verification (7 tests):**

| Test | Assertion |
|------|-----------|
| Pipeline completes without errors | `runner.run()` resolves, no throw |
| Crawled expected pages | Fixture server log contains requests for all content pages |
| Never fetched /admin | Fixture server log has no /admin request |
| Followed redirect and deduplicated URL | Only one extraction for widget-pro (not two from /widget-pro and /widget-pro/) |
| Followed pagination to page 2 | Fixture server log contains /page/2 |
| Did not follow external domain links | No requests to twitter.com |
| Handled 404 gracefully | Pipeline continued after /broken-link 404 |

**Classification verification (2 tests):**

| Test | Assertion |
|------|-----------|
| Classified pages correctly | Mock log shows correct classification per page type |
| Skipped irrelevant about page | No extraction call for about page content |

**Extraction verification (5 tests):**

| Test | Assertion |
|------|-----------|
| Extracted product entity with correct fields | Entity with title "Widget Pro" has price, imageUrl |
| Extracted recipe entity with category-specific fields | Entity with title "Pasta Carbonara" has cookTime, servings |
| Extracted multiple entities from comparison table | Entities Widget A, Widget B, Widget C exist |
| Partial page produced low-confidence entity | Blog review entity has lower qualityScore than product entities |
| Handled slow page without blocking pipeline | Slow page was eventually processed OR timed out; other pages completed concurrently |

**Reconciliation verification (2 tests):**

| Test | Assertion |
|------|-----------|
| Merged duplicate Widget Pro entities | Exactly ONE entity with title "Widget Pro", sourceCount === 2 |
| Non-duplicate entities remain separate | Widget A, Widget B, Widget C, Pasta Carbonara are separate entities |

**Schema evolution verification (3 tests):**

| Test | Assertion |
|------|-----------|
| Schema evolved beyond user-defined fields | Schema fields count > 2 (title + price) |
| Schema has multiple versions | getSchemaVersions().length >= 2 |
| Pending review actions created | getActions('pending_review').length > 0, each has type/confidence/reasoning/source |

**Pipeline state verification (4 tests):**

| Test | Assertion |
|------|-----------|
| Content store has page files | `.spatula/pages/` has files for each crawled page |
| Run record has correct stats | status 'completed', pagesCrawled > 0, entitiesCreated > 0 |
| LLM token usage tracked | llmUsageRepo total tokens > 0 |
| Model routing correct | Mock log shows correct model name per component (pageRelevance, extraction, schemaEvolution tasks) |

**Cross-command verification (4 tests):**

| Test | Assertion |
|------|-----------|
| `spatula status` shows pipeline results | Entity count and schema fields in output |
| `spatula schema` shows evolved schema | Output contains user-defined + discovered fields |
| `spatula export` produces file with extracted entities | JSON file contains Widget Pro, Pasta Carbonara |
| `spatula review` shows pending actions, approve works | Actions displayed, approveAction() changes status |

**Re-run and lifecycle (2 tests):**

| Test | Assertion |
|------|-----------|
| Re-run with new seed URL only crawls new pages | Add URL to yaml, re-run, mock log shows only new URL classified |
| Graceful stop completes cleanly | runner.stop() mid-run → status 'completed', no orphaned in_progress tasks |

### 5.2 `pipeline-real-llm.test.ts` — Real Ollama (6 tests, conditional)

Skips entirely if Ollama not available. Uses real Ollama with `llama3.2:1b`. Same fixture server and project setup. 5-minute timeout per test.

**Structural assertions only (nondeterministic):**

| Test | Assertion |
|------|-----------|
| Pipeline completes | No throw |
| Entities created | totalEntities > 0 |
| Schema has fields | schema.definition.fields.length > 0 |
| Run record complete | status 'completed' |
| About page skipped | No entity from about page content |
| Product entities exist | At least one entity with price-like data |

### 5.3 `pipeline-errors.test.ts` — Failure modes (4 tests)

Each test runs its own pipeline with a specific error mode configured.

| Test | Mock Mode | Assertion |
|------|-----------|-----------|
| Classifier malformed JSON → page skipped | `malformed-json` on `classifier` | Other pages extracted, pipeline completed |
| Extractor timeout → extraction skipped | `timeout` on `extractor` | Other extractions succeeded, pipeline completed |
| Schema evolution Zod failure → no broken actions | `zod-failure` on `field-proposer` | No actions with missing fields in DB, pipeline completed |
| All LLM calls fail → crawl-only mode | `malformed-json` on all components | Pages stored in content store, zero entities, run status 'completed' |

### 5.4 `conversation.test.ts` — `spatula new` conversation (2 tests)

No Playwright needed — tests the ConfigConversationService directly.

| Test | Assertion |
|------|-----------|
| 3-turn conversation produces valid config | After 3 processMessage calls with mock responses, config has seedUrls, name, userFields including 'brand', validates successfully |
| LLM error in conversation handled gracefully | Mock returns malformed JSON on turn 2, error message returned, can retry on turn 3 |

### 5.5 `prompt-snapshots.test.ts` — Prompt regression detection (6 tests)

Captures the full prompt text for each major component and snapshots it.

| Test | Component |
|------|-----------|
| Classifier prompt structure | PageClassifier |
| Extractor prompt structure | StaticExtractor |
| Field proposer prompt structure | FieldProposer |
| Link evaluator prompt structure | LLMLinkEvaluator |
| Entity matcher prompt structure | EntityMatcher |
| Conversation system prompt structure | ConfigConversationService |

Uses vitest's `toMatchInlineSnapshot()` or file snapshots. When a prompt intentionally changes, the developer updates the snapshot. Runs its own pipeline (vitest runs files in isolation).

---

## 6. File Structure

```
apps/cli/tests/e2e/tier2/
  fixtures/
    pages.ts                    ← HTML strings for all fixture pages
  fixture-server.ts             ← HTTP server with request logging
  mock-ollama.ts                ← Mock Ollama with routing, canned responses, error modes, request logging
  helpers.ts                    ← createFixtureProject, buildPipelineRunner, isPlaywrightAvailable, isOllamaAvailable
  pipeline-mock-llm.test.ts     ← 29 tests, always runs (needs Playwright)
  pipeline-real-llm.test.ts     ← 6 tests, skipIf(!ollama) (needs Playwright + Ollama)
  pipeline-errors.test.ts       ← 4 tests, always runs (needs Playwright)
  conversation.test.ts          ← 2 tests, always runs (no Playwright needed)
  prompt-snapshots.test.ts      ← 6 tests, always runs (needs Playwright for one pipeline run)
```

---

## 7. Test Counts and Runtime

| File | Tests | Needs Playwright | Needs Ollama | Est. Runtime |
|------|-------|-----------------|-------------|-------------|
| pipeline-mock-llm.test.ts | 29 | Yes | No | ~30s |
| pipeline-real-llm.test.ts | 6 | Yes | Yes | ~3-5min |
| pipeline-errors.test.ts | 4 | Yes | No | ~20s |
| conversation.test.ts | 2 | No | No | ~5s |
| prompt-snapshots.test.ts | 6 | Yes | No | ~15s |
| **Total** | **47** | | | ~70s (mock) / ~5min (real) |

All mock tests are deterministic and CI-friendly. Playwright-dependent tests skip if browsers aren't installed. Real Ollama tests skip if Ollama isn't running.

---

## 8. Infrastructure Notes

### Port Management

Each test file creates its own fixture server and mock Ollama on random ports (port 0). No port collisions between parallel test files.

### Cleanup

`afterAll` in each file:
1. Force-close Playwright browser
2. Release project lock (if held)
3. Close all DB connections
4. Stop fixture server and mock Ollama
5. Remove temp directory

If tests fail mid-pipeline, the `try/finally` pattern ensures cleanup runs.

### Test Isolation

- Each test file gets its own servers, project directory, and DB
- `pipeline-mock-llm.test.ts` runs the pipeline once in `beforeAll`, then asserts in each `it` (shared state, fast)
- `pipeline-errors.test.ts` runs a separate pipeline per test (each with different error mode)
- `prompt-snapshots.test.ts` shares the pipeline run with `pipeline-mock-llm.test.ts` if possible, or runs its own

### Playwright Availability Check

```typescript
async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch { return false; }
}
```

Used as: `describe.skipIf(!playwrightAvailable)(...)`
