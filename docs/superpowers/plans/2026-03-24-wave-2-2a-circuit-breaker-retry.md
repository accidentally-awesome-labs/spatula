# Wave 2.2a: Circuit Breaker & Per-Queue Retry Config

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a circuit breaker pattern to prevent LLM cascade failures when OpenRouter/Ollama is degraded, and configure per-queue retry strategies for different failure modes.

**Architecture:** The circuit breaker wraps any `LLMClient` via the decorator pattern — `CircuitBreakerLLMClient implements LLMClient` and delegates to an inner client. It tracks consecutive failures and transitions through CLOSED → OPEN → HALF_OPEN states. The per-queue retry config replaces the single `DEFAULT_JOB_OPTIONS` with queue-specific backoff strategies.

**Tech Stack:** TypeScript, Vitest

**Spec references:**
- Phase 12 spec: section 5.2 (Circuit Breaker), section 5.3 (Queue-Level Retry)
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/core/src/llm/circuit-breaker.ts` | Circuit breaker wrapping LLMClient |
| `packages/core/tests/unit/llm/circuit-breaker.test.ts` | Circuit breaker tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/core/src/llm/index.ts` | Export CircuitBreakerLLMClient |
| `packages/queue/src/queues.ts` | Per-queue job options replacing DEFAULT_JOB_OPTIONS |

---

## Task 1: Circuit Breaker

**Files:**
- Create: `packages/core/src/llm/circuit-breaker.ts`
- Create: `packages/core/tests/unit/llm/circuit-breaker.test.ts`
- Modify: `packages/core/src/llm/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/llm/circuit-breaker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreakerLLMClient } from '../../../src/llm/circuit-breaker.js';
import type { LLMClient, LLMCompletionRequest, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';

function createMockClient(): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: 'test response',
      model: 'test-model',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const defaultRequest: LLMCompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'test' }],
};

describe('CircuitBreakerLLMClient', () => {
  describe('CLOSED state (normal operation)', () => {
    it('passes calls through to inner client', async () => {
      const inner = createMockClient();
      const breaker = new CircuitBreakerLLMClient(inner);

      const result = await breaker.complete(defaultRequest);

      expect(inner.complete).toHaveBeenCalledWith(defaultRequest);
      expect(result.content).toBe('test response');
    });

    it('counts consecutive failures', async () => {
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('LLM down'));
      const breaker = new CircuitBreakerLLMClient(inner, { failureThreshold: 3 });

      // First 2 failures — still closed
      await expect(breaker.complete(defaultRequest)).rejects.toThrow('LLM down');
      await expect(breaker.complete(defaultRequest)).rejects.toThrow('LLM down');
      expect(breaker.state).toBe('closed');

      // 3rd failure — opens
      await expect(breaker.complete(defaultRequest)).rejects.toThrow('LLM down');
      expect(breaker.state).toBe('open');
    });

    it('resets failure count on success', async () => {
      const inner = createMockClient();
      const breaker = new CircuitBreakerLLMClient(inner, { failureThreshold: 3 });

      // 2 failures
      (inner.complete as any).mockRejectedValueOnce(new Error('fail'));
      (inner.complete as any).mockRejectedValueOnce(new Error('fail'));
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();

      // 1 success — resets counter
      (inner.complete as any).mockResolvedValueOnce({
        content: 'ok', model: 'test', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop',
      });
      await breaker.complete(defaultRequest);
      expect(breaker.state).toBe('closed');

      // 2 more failures — still closed (counter was reset)
      (inner.complete as any).mockRejectedValue(new Error('fail'));
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      expect(breaker.state).toBe('closed');
    });
  });

  describe('OPEN state (rejecting all calls)', () => {
    it('rejects immediately with LLMError when open', async () => {
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const breaker = new CircuitBreakerLLMClient(inner, {
        failureThreshold: 2,
        resetTimeoutMs: 60_000, // long timeout so it stays open
      });

      // Trip the breaker
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      expect(breaker.state).toBe('open');

      // Next call rejected immediately without calling inner
      await expect(breaker.complete(defaultRequest)).rejects.toThrow('Circuit breaker open');
      expect(inner.complete).toHaveBeenCalledTimes(2); // NOT 3
    });

    it('transitions to half-open after resetTimeout on next call', async () => {
      vi.useFakeTimers();
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const breaker = new CircuitBreakerLLMClient(inner, {
        failureThreshold: 2,
        resetTimeoutMs: 30_000,
      });

      // Trip
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      expect(breaker.state).toBe('open');

      // Advance past timeout — state doesn't change until next complete() call
      vi.advanceTimersByTime(30_001);

      // Next call triggers OPEN → HALF_OPEN promotion and goes through
      (inner.complete as any).mockResolvedValueOnce({
        content: 'recovered', model: 'test',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      });
      await breaker.complete(defaultRequest);
      // After the call, state should be half_open (or closed if halfOpenMaxAttempts=1)
      // With default halfOpenMaxAttempts=2, one success keeps it half_open
      expect(['half_open', 'closed']).toContain(breaker.state);

      vi.useRealTimers();
    });
  });

  describe('HALF_OPEN state (testing recovery)', () => {
    it('allows one call through to test recovery', async () => {
      vi.useFakeTimers();
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const breaker = new CircuitBreakerLLMClient(inner, {
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        halfOpenMaxAttempts: 2,
      });

      // Trip
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();

      // Move to half-open
      vi.advanceTimersByTime(1_001);
      expect(breaker.state).toBe('half_open');

      // Success in half-open
      (inner.complete as any).mockResolvedValue({
        content: 'recovered', model: 'test',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      });
      const result = await breaker.complete(defaultRequest);
      expect(result.content).toBe('recovered');

      vi.useRealTimers();
    });

    it('closes after halfOpenMaxAttempts successes', async () => {
      vi.useFakeTimers();
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const breaker = new CircuitBreakerLLMClient(inner, {
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        halfOpenMaxAttempts: 2,
      });

      // Trip
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();

      // Move to half-open
      vi.advanceTimersByTime(1_001);

      // 2 successes → closes
      const successResponse = {
        content: 'ok', model: 'test',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      };
      (inner.complete as any).mockResolvedValue(successResponse);
      await breaker.complete(defaultRequest);
      await breaker.complete(defaultRequest);
      expect(breaker.state).toBe('closed');

      vi.useRealTimers();
    });

    it('re-opens on failure during half-open', async () => {
      vi.useFakeTimers();
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const breaker = new CircuitBreakerLLMClient(inner, {
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        halfOpenMaxAttempts: 2,
      });

      // Trip
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();

      // Move to half-open
      vi.advanceTimersByTime(1_001);
      expect(breaker.state).toBe('half_open');

      // Failure in half-open → re-opens
      await expect(breaker.complete(defaultRequest)).rejects.toThrow('down');
      expect(breaker.state).toBe('open');

      vi.useRealTimers();
    });
  });

  describe('defaults', () => {
    it('uses default failureThreshold of 5', async () => {
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('fail'));
      const breaker = new CircuitBreakerLLMClient(inner); // no config override

      // 4 failures — still closed (threshold is 5)
      for (let i = 0; i < 4; i++) {
        await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      }
      expect(breaker.state).toBe('closed');

      // 5th failure — opens
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      expect(breaker.state).toBe('open');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run circuit-breaker`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement circuit breaker**

```typescript
// packages/core/src/llm/circuit-breaker.ts
import { LLMError } from '@spatula/shared';
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '../interfaces/llm-client.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening (default: 5) */
  failureThreshold: number;
  /** Time in OPEN before trying HALF_OPEN, in ms (default: 30_000) */
  resetTimeoutMs: number;
  /** Successful calls needed in HALF_OPEN to close (default: 2) */
  halfOpenMaxAttempts: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 2,
};

/**
 * Circuit breaker wrapping an LLMClient.
 *
 * States:
 * - CLOSED: Normal operation. Counts consecutive failures. Opens after failureThreshold.
 * - OPEN: Immediately rejects all calls with LLMError. After resetTimeoutMs, transitions to HALF_OPEN.
 * - HALF_OPEN: Allows calls through. If halfOpenMaxAttempts succeed, closes. If any fail, re-opens.
 *
 * TODO: Emit metrics (circuit_breaker_state gauge, circuit_breaker_rejections_total counter)
 * when Phase 12 Workstream C (Observability) metrics infrastructure is available.
 *
 * This is a per-process circuit breaker (not shared across workers).
 * In a multi-worker deployment, each worker has its own breaker state.
 * This is acceptable because each worker has its own LLM connection.
 */
export class CircuitBreakerLLMClient implements LLMClient {
  private _state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(
    private readonly inner: LLMClient,
    config?: Partial<CircuitBreakerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Read-only state accessor. No side effects. */
  get state(): CircuitState {
    return this._state;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    // Promote OPEN → HALF_OPEN if timeout has elapsed
    if (this._state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.resetTimeoutMs) {
        this._state = 'half_open';
        this.halfOpenSuccesses = 0;
      }
    }

    const currentState = this._state;

    if (currentState === 'open') {
      throw new LLMError('Circuit breaker open — LLM provider is unavailable', {
        retryable: true,
        context: { state: 'open', model: request.model },
      });
    }

    try {
      const result = await this.inner.complete(request);

      // Success handling
      if (currentState === 'half_open') {
        this.halfOpenSuccesses++;
        if (this.halfOpenSuccesses >= this.config.halfOpenMaxAttempts) {
          this.close();
        }
      } else {
        // CLOSED: reset failure counter on success
        this.consecutiveFailures = 0;
      }

      return result;
    } catch (error) {
      // Failure handling
      if (currentState === 'half_open') {
        // Any failure in half-open → re-open
        this.open();
      } else {
        // CLOSED: count consecutive failures
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.config.failureThreshold) {
          this.open();
        }
      }

      throw error;
    }
  }

  private open(): void {
    this._state = 'open';
    this.openedAt = Date.now();
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
  }

  private close(): void {
    this._state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
  }
}
```

- [ ] **Step 4: Update LLM barrel exports**

In `packages/core/src/llm/index.ts`, add:

```typescript
export { CircuitBreakerLLMClient } from './circuit-breaker.js';
export type { CircuitBreakerConfig, CircuitState } from './circuit-breaker.js';
// Usage note: Apply CircuitBreakerLLMClient to OpenRouterClient (cloud, transient failures).
// Do NOT wrap OllamaClient — it has no retries by design (local server, failures are terminal).
// In the LLM factory or pipeline runner:
//   const llm = new CircuitBreakerLLMClient(new OpenRouterClient({...}));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run circuit-breaker`
Expected: All tests PASS

- [ ] **Step 6: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/llm/circuit-breaker.ts packages/core/src/llm/index.ts packages/core/tests/unit/llm/circuit-breaker.test.ts
git commit -m "feat(core): add circuit breaker for LLM client with CLOSED/OPEN/HALF_OPEN states"
```

---

## Task 2: Per-Queue Retry Config

**Files:**
- Modify: `packages/queue/src/queues.ts`

- [ ] **Step 1: Replace DEFAULT_JOB_OPTIONS with per-queue options**

Currently all queues share the same `DEFAULT_JOB_OPTIONS` (3 attempts, exponential 2s). Replace with per-queue configs per spec section 5.3:

In `packages/queue/src/queues.ts`, replace the single `DEFAULT_JOB_OPTIONS` constant with:

```typescript
/**
 * Per-queue retry configurations. Different failure modes need different strategies:
 * - Crawl: transient network failures → longer delays, more attempts
 * - Schema evolution: lock contention → flat retry, fewer attempts
 * - Export: resource exhaustion → moderate backoff
 */
const QUEUE_JOB_OPTIONS = {
  [QUEUE_NAMES.CRAWL]: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 5_000 },  // 5s, 10s, 20s
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.EXTRACT]: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 2_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.SCHEMA_EVOLUTION]: {
    attempts: 2,
    backoff: { type: 'fixed' as const, delay: 10_000 },       // flat 10s retry (lock contention)
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.RECONCILIATION]: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 2_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.EXPORT]: {
    attempts: 2,
    backoff: { type: 'exponential' as const, delay: 3_000 },  // 3s, 6s
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
} as const;
```

Then update `createQueues` to use per-queue options:

```typescript
const crawl = new Queue<CrawlJobData>(QUEUE_NAMES.CRAWL, {
  connection,
  defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.CRAWL],
});
const extract = new Queue<ExtractJobData>(QUEUE_NAMES.EXTRACT, {
  connection,
  defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.EXTRACT],
});
const schemaEvolution = new Queue<SchemaEvolutionJobData>(QUEUE_NAMES.SCHEMA_EVOLUTION, {
  connection,
  defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.SCHEMA_EVOLUTION],
});
const reconciliation = new Queue<ReconciliationJobData>(QUEUE_NAMES.RECONCILIATION, {
  connection,
  defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.RECONCILIATION],
});
const exportQueue = new Queue<ExportJobPayload>(QUEUE_NAMES.EXPORT, {
  connection,
  defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.EXPORT],
});
```

Also export `QUEUE_JOB_OPTIONS` for transparency/testing:

```typescript
export { QUEUE_JOB_OPTIONS };
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue build`
Expected: Build succeeds

- [ ] **Step 3: Run queue tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS (queue creation uses the new per-queue options but behavior is identical for tests)

- [ ] **Step 4: Commit**

```bash
git add packages/queue/src/queues.ts
git commit -m "feat(queue): add per-queue retry strategies for different failure modes"
```

---

## Task 3: Integration Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full core test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run`
Expected: All tests PASS

- [ ] **Step 2: Run full queue test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS

- [ ] **Step 3: Run core + queue builds**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build && pnpm --filter @spatula/queue build`
Expected: Both build successfully

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test: verify Wave 2.2a — circuit breaker and per-queue retry config"
```
