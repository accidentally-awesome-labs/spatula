# Webhooks

> HMAC-SHA256-signed event delivery with backoff retry. Implementation lives in `packages/queue/src/webhook-sender.ts` + `packages/queue/src/webhook-worker.ts`.

Spatula emits events for asynchronous job-lifecycle and pipeline transitions. Each event is delivered as a signed HTTP POST to the URL you register on the job's `webhookConfig`.

## Event envelope

Every event has this shape:

```json
{
  "id": "evt_<12-char-uuid-slice>",
  "type": "job.completed",
  "timestamp": "2026-05-19T15:42:11.000Z",
  "data": { "...": "event-type-specific" }
}
```

- `id` is unique per delivery attempt (UUIDv4 slice). Use this for deduplication.
- `type` follows `<resource>.<verb>` (e.g., `job.completed`, `extraction.failed`, `export.ready`).
- `timestamp` is ISO 8601 UTC.

## Headers

| Header                 | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `Content-Type`         | `application/json`                                        |
| `User-Agent`           | `Spatula-Webhook/1.0`                                     |
| `X-Spatula-Signature`  | `sha256=<hex>` — HMAC-SHA256 of the raw request body      |
| `X-Spatula-Event-Id`   | Mirrors `event.id` for header-level inspection            |
| `X-Spatula-Event-Type` | Mirrors `event.type` for routing without parsing the body |

The signature header is ONLY sent when you configured a `secret` on the webhook. Unsigned webhooks are supported for development but discouraged in production.

## Verification (Node.js / TypeScript)

```typescript
import crypto from 'node:crypto';

/**
 * Verify a Spatula webhook signature.
 *
 * @param rawBody  The raw HTTP request body (string OR Buffer — NOT the parsed
 *                 JSON). You MUST verify against the raw bytes; re-serializing
 *                 the parsed JSON will produce a different signature.
 * @param signature  The value of `X-Spatula-Signature` header, e.g.
 *                   `'sha256=abcd1234...'`.
 * @param secret  The shared secret you configured on the webhook.
 */
export function verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Constant-time comparison to prevent timing attacks.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

## Verification (Python)

```python
import hmac
import hashlib

def verify_webhook(raw_body: bytes, signature: str, secret: str) -> bool:
    """Verify a Spatula webhook signature.

    raw_body  – the raw HTTP request body (bytes), NOT the parsed JSON
    signature – the value of X-Spatula-Signature header, e.g. 'sha256=abcd...'
    secret    – the shared secret you configured on the webhook
    """
    expected = 'sha256=' + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)
```

## Retry schedule

Delivery uses HMAC-SHA256-signed `POST`. Non-2xx responses (4xx OR 5xx OR network error) trigger backoff retry:

| Attempt | Delay before this attempt | Cumulative elapsed |
| ------- | ------------------------- | ------------------ |
| 1       | — (immediate)             | 0                  |
| 2       | 1m                        | 1m                 |
| 3       | 5m                        | 6m                 |
| —       | DLQ → `events.failed`     | —                  |

After the final attempt fails, the event lands in the dead-letter queue and the per-tenant `events.failed` BullMQ stream surfaces the failure to operators. The worker backoff strategy is capped at 30 minutes for future additional attempts, but v1 configures three attempts.

## Dedup pattern

Receivers MUST de-duplicate by `event.id`. The same `event.id` MAY arrive more than once (e.g., your handler succeeded but the response was lost in flight — Spatula retries because the 200 never arrived).

```typescript
async function handleWebhook(rawBody: string, signature: string) {
  if (!verifyWebhook(rawBody, signature, process.env.SPATULA_WEBHOOK_SECRET!)) {
    return new Response('invalid signature', { status: 401 });
  }
  const event = JSON.parse(rawBody);

  // Idempotent processing: SETNX with a TTL window. If the id was already
  // seen, return 200 immediately so Spatula stops retrying.
  const wasNew = await redis.set(`webhook:seen:${event.id}`, '1', 'EX', 86400, 'NX');
  if (!wasNew) return new Response('duplicate', { status: 200 });

  await processEvent(event); // Your business logic. MUST be idempotent.
  return new Response('ok', { status: 200 });
}
```

The 24-hour `seen` window is conservative — Spatula retries finish within ~10.5h, but operator-replays via the DLQ can come hours later.

## Event types

The v1 surface emits these event types:

| Type                   | When emitted                                      | `data` payload                           |
| ---------------------- | ------------------------------------------------- | ---------------------------------------- |
| `job.queued`           | Job accepted into BullMQ                          | `{ jobId, tenantId }`                    |
| `job.running`          | Worker picked up the job                          | `{ jobId, workerId }`                    |
| `job.completed`        | All pipeline stages finished                      | `{ jobId, stats }`                       |
| `job.failed`           | Pipeline stage exhausted retries                  | `{ jobId, error }`                       |
| `extraction.completed` | Extraction finished for a page                    | `{ jobId, extractionId, fieldCount }`    |
| `export.ready`         | Export materialization complete                   | `{ jobId, exportId, format, sizeBytes }` |
| `schema.evolved`       | Schema-evolution action applied to a job's schema | `{ jobId, schemaVersion, action }`       |

Subscribe to a subset by setting `webhookConfig.events: ['job.completed', 'export.ready']` on the job; un-subscribed types are filtered server-side BEFORE enqueue (you'll never see them).

## Local testing

Use a tunnel (e.g., `ngrok http 3000`) to expose your local handler; configure that URL on a test job's `webhookConfig`. Inspect delivery failures through the admin DLQ endpoints or queue dashboard on the self-hosted API server.

## Cross-references

- `docs/api-errors.md` — `WEBHOOK.SIGNATURE_INVALID` envelope shape.
- `packages/queue/src/webhook-sender.ts` — sender (HMAC-SHA256 + 10s timeout).
- `packages/queue/src/webhook-worker.ts` — BullMQ worker + backoff strategy.
- `packages/shared/src/types/webhook.ts` — `WebhookEvent` / `WebhookEventType` / `WebhookConfig` types.
