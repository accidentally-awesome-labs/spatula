/**
 * Tier 4 — OpenRouter Integration Tests
 *
 * These tests exercise the real OpenRouter API using Gemini Flash.
 * They verify:
 *   1. API key validity
 *   2. Simple text completion
 *   3. JSON mode completion
 *   4. Page classification prompt (real system prompt)
 *   5. Data extraction prompt (real system prompt)
 *   6. Token usage tracking across all calls
 *
 * All tests skip gracefully when OPENROUTER_API_KEY is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const MODEL = 'google/gemini-2.5-flash';
let hasKey = false;
let llmClient: any;
let totalTokens = 0;
let totalCalls = 0;

/** Track tokens from each response. */
function trackUsage(response: {
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}) {
  totalTokens += response.usage.totalTokens;
  totalCalls += 1;
}

beforeAll(async () => {
  hasKey = !!process.env.OPENROUTER_API_KEY;
  if (!hasKey) return;

  const { createLLMClient } = await import('@accidentally-awesome-labs/spatula-core');
  llmClient = createLLMClient({
    provider: 'openrouter',
    openrouter: { apiKey: process.env.OPENROUTER_API_KEY! },
  });
});

afterAll(() => {
  if (totalTokens > 0) {
    const cost = totalTokens * (0.15 / 1_000_000);
    console.log(`\nOpenRouter: ${totalCalls} calls, ~${totalTokens} tokens, ~$${cost.toFixed(4)}`);
  }
});

describe('OpenRouter integration', () => {
  // -----------------------------------------------------------------------
  // 1. API key is valid
  // -----------------------------------------------------------------------
  it('validates the API key against the models endpoint', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 2. Simple completion
  // -----------------------------------------------------------------------
  it('returns a simple text completion', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const response = await llmClient.complete({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello in exactly one word' }],
    });

    expect(response.content).toBeTruthy();
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBeGreaterThan(0);
    trackUsage(response);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 3. JSON mode completion
  // -----------------------------------------------------------------------
  it('returns valid JSON in json mode', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const response = await llmClient.complete({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: 'Return a JSON object with a single field "greeting" set to "hello"',
        },
      ],
      jsonMode: true,
    });

    expect(response.content).toBeTruthy();
    const parsed = JSON.parse(response.content);
    expect(parsed).toHaveProperty('greeting');
    trackUsage(response);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 4. Classification prompt
  // -----------------------------------------------------------------------
  it('classifies a page using the PageClassifier system prompt', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const systemPrompt =
      'You are a web page classifier. Your job is to determine what type of content a page contains relative to a data collection goal. Respond with JSON only.';

    const userPrompt = `Classify this web page for data collection.

## Data Collection Goal
Find product listings with prices

## Page URL
https://example.com/products

## Page Content
<h1>Products</h1>
<div class="product"><h2>Widget A</h2><span class="price">$9.99</span></div>
<div class="product"><h2>Widget B</h2><span class="price">$19.99</span></div>
<div class="product"><h2>Widget C</h2><span class="price">$29.99</span></div>

## Instructions
Classify this page into one of these categories:
- "single_entry": Detailed information about ONE item
- "multiple_entries": A list or grid of MULTIPLE items
- "navigation": Category index or navigation page
- "irrelevant": No content relevant to the data collection goal
- "partial": Contains some relevant data but incomplete

Choose the extraction strategy:
- "full_extraction": For single_entry or partial pages
- "list_extraction": For multiple_entries pages
- "links_only": For navigation pages
- "skip": For irrelevant pages

Respond with JSON:
{
  "classification": "single_entry|multiple_entries|navigation|irrelevant|partial",
  "strategy": "full_extraction|list_extraction|links_only|skip",
  "estimatedEntryCount": 1,
  "confidence": 0.95,
  "reasoning": "Brief explanation"
}`;

    const response = await llmClient.complete({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      jsonMode: true,
      temperature: 0,
      maxTokens: 512,
    });

    expect(response.content).toBeTruthy();
    const parsed = JSON.parse(response.content);
    expect(parsed).toHaveProperty('classification');
    expect(parsed).toHaveProperty('strategy');
    expect(parsed).toHaveProperty('confidence');
    expect(typeof parsed.confidence).toBe('number');
    expect(parsed.confidence).toBeGreaterThan(0);
    expect(parsed.confidence).toBeLessThanOrEqual(1);
    trackUsage(response);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 5. Extraction prompt
  // -----------------------------------------------------------------------
  it('extracts data using the StaticExtractor system prompt', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const systemPrompt =
      'You are a data extraction expert. Extract structured information from web pages according to a provided schema. Return JSON only.';

    const userPrompt = `Extract structured data from this web page.

## Data Description
Product listings with names and prices

## Schema
Fields:
  - name (string, required): The product name
  - price (number, required): The product price in USD

## Rules
1. Extract values exactly as they appear on the page.
2. For REQUIRED fields, make every effort to find the value. If truly absent, set to null.
3. For optional fields, include them only if clearly present on the page.
4. If you discover data on the page that doesn't fit any schema field but seems relevant, include it in the _unmapped array.
5. Return your confidence (0.0-1.0) in the overall extraction quality.

## Page
URL: https://example.com/products/widget-a

<h1>Widget A</h1>
<span class="price">$9.99</span>
<p>A fantastic widget for all your needs.</p>

## Response Format
Return JSON:
{
  "data": { /* extracted fields matching the schema */ },
  "_unmapped": [
    { "name": "field_name", "value": "extracted_value", "suggestedType": "string" }
  ],
  "confidence": 0.95
}`;

    const response = await llmClient.complete({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      jsonMode: true,
      temperature: 0,
      maxTokens: 4096,
    });

    expect(response.content).toBeTruthy();
    const parsed = JSON.parse(response.content);
    expect(parsed).toHaveProperty('data');
    expect(parsed).toHaveProperty('confidence');
    expect(typeof parsed.confidence).toBe('number');
    expect(parsed.confidence).toBeGreaterThan(0);
    trackUsage(response);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 6. Token usage tracking
  // -----------------------------------------------------------------------
  it('tracks cumulative token usage across all calls', (ctx) => {
    if (!hasKey) return ctx.skip();

    // This test runs after the previous ones; verify we accumulated usage.
    expect(totalTokens).toBeGreaterThan(0);
    expect(totalCalls).toBeGreaterThan(0);
    // Each prior call should have contributed prompt + completion tokens,
    // so totals must be at least as many as the number of calls.
    expect(totalTokens).toBeGreaterThanOrEqual(totalCalls);
  });
});
