import { describe, it, expect } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import type { AppDeps } from '../../apps/api/src/types.js';

// These tests assert the post-carve-out OpenAPI surface. They do not need real
// dependencies — the OpenAPI document is generated from route declarations and
// is reachable without auth (authMiddleware skips /api/openapi.json).
//
// Forbidden surface:
//   - Any path containing "billing" or "stripe"
//   - Any schema/component named Subscription, UsageRecord, StripeEvent,
//     BillingTier (or PascalCase variants thereof)

async function fetchOpenApiDoc() {
  // createApp tolerates a partial deps object for tests that only hit
  // unauthenticated routes; the auth middleware is wired to a stub provider
  // only when AUTH_STRATEGY != 'none'. /api/openapi.json is in SKIP_AUTH_PATHS.
  const app = createApp({} as AppDeps);
  const res = await app.request('/api/openapi.json');
  expect(res.status).toBe(200);
  return res.json();
}

describe('OpenAPI shape (post-carve-out)', () => {
  it('has no /api/v1/billing* paths', async () => {
    const doc = (await fetchOpenApiDoc()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(doc.paths ?? {});
    const billingPaths = paths.filter((p) => /billing/i.test(p));
    expect(billingPaths).toEqual([]);
  });

  it('has no stripe/webhook stripe paths', async () => {
    const doc = (await fetchOpenApiDoc()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(doc.paths ?? {});
    const stripePaths = paths.filter((p) => /stripe/i.test(p));
    expect(stripePaths).toEqual([]);
  });

  it('has no Subscription / UsageRecord / StripeEvent / BillingTier schemas', async () => {
    const doc = (await fetchOpenApiDoc()) as {
      components?: { schemas?: Record<string, unknown> };
    };
    const schemas = Object.keys(doc.components?.schemas ?? {});
    const forbidden = schemas.filter((s) =>
      /^(Subscription|UsageRecord|StripeEvent|BillingTier)/i.test(s),
    );
    expect(forbidden).toEqual([]);
  });
});
