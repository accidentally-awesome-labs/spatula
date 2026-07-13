# @spatula/client

Spatula API client — TypeScript SDK for the Spatula REST API.

## Properties

- ESM-only (no CommonJS shim — use `@spatula/cli`'s dual build if you need CJS)
- Browser + Node 22+ compatible
- Fetch-based — uses global `fetch` (override via constructor option)
- `sideEffects: false` — fully tree-shakeable
- **Measured surface ≤ 50 kB gzipped** for `{ SpatulaClient, createJob, listJobs, getEntities }` (see `size-limit.json`)

## Quick start

```typescript
import { SpatulaClient, createJob, listJobs, getEntities } from '@spatula/client';

const client = new SpatulaClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.SPATULA_API_KEY!,
});

const job = await createJob(client, { name: 'demo', seedUrls: ['https://example.com'] });
const { data: jobs, hasMore, nextCursor } = await listJobs(client, { limit: 50 });
const { data: entities } = await getEntities(client, job.id);
```

## Stability

See `docs/compat-policy.md` for the full SDK ↔ server ↔ `@spatula/core-types` compatibility matrix.

## Size budget

The 50 kB limit measures ONLY the named surface above (`SpatulaClient` + 3 methods). Importing the full module (e.g., `import * as client from '@spatula/client'`) pulls in additional methods + class-per-code error subclasses (26 classes) and will exceed 50 kB. This is by design — tree-shaking in your bundler eliminates unused subclasses.

## Experimental namespace

`client.experimental` contains explicitly unstable SDK surfaces. v1.0 ships one experimental surface: `client.experimental.forensic`, which calls the admin forensic-extractions endpoint. Any other property access throws.

```typescript
await client.experimental.forensic.listExtractions({ limit: 25 });

// Throws: no other experimental surface exists in v1.0.
client.experimental.anything;
```

## Generated error classes

Class-per-code error subclasses live in `src/errors/generated.ts` and are checked into git. The generator script (`scripts/gen-error-classes.ts`) is the source of truth and runs in CI via `pnpm gen:errors && git diff --exit-code` to catch drift between the frozen `ErrorCode` enum and the committed subclasses.

```typescript
import { SpatulaClient, JobNotFoundError, RateLimitExceededError } from '@spatula/client';

try {
  await createJob(client /* ... */);
} catch (err) {
  if (err instanceof JobNotFoundError) {
    /* ... */
  } else if (err instanceof RateLimitExceededError) {
    /* err.details.limit, err.details.resetAt */
  }
}
```
