import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

      // State getter is pure — still reports open until complete() is called
      expect(breaker.state).toBe('open');

      // Next call triggers OPEN -> HALF_OPEN promotion and goes through
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

      // Move to half-open via complete() call after timeout
      vi.advanceTimersByTime(1_001);

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

      // 2 successes -> closes
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

      // Move to half-open via next complete() call after timeout
      vi.advanceTimersByTime(1_001);

      // Failure in half-open -> re-opens
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

  describe('metrics emission', () => {
    function createMockMetrics() {
      return {
        circuitBreakerState: { add: vi.fn() },
        circuitBreakerRejectionsTotal: { add: vi.fn() },
        // Stubs for other required SpatulaMetrics fields
        httpRequestDuration: { record: vi.fn() },
        httpRequestsTotal: { add: vi.fn() },
        httpActiveConnections: { add: vi.fn() },
        queueJobDuration: { record: vi.fn() },
        queueJobsTotal: { add: vi.fn() },
        llmTokensUsed: { add: vi.fn() },
        llmRequestDuration: { record: vi.fn() },
        llmCostUsd: { add: vi.fn() },
        pagesProcessedTotal: { add: vi.fn() },
        pageCrawlDuration: { record: vi.fn() },
        entitiesCreatedTotal: { add: vi.fn() },
        exportSizeBytes: { record: vi.fn() },
      } as any;
    }

    it('emits circuitBreakerState open metric when circuit opens', async () => {
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const metrics = createMockMetrics();
      const breaker = new CircuitBreakerLLMClient(inner, { failureThreshold: 2 });
      breaker.setMetrics(metrics);

      // Trip the breaker
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      expect(breaker.state).toBe('open');

      expect(metrics.circuitBreakerState.add).toHaveBeenCalledWith(1, { state: 'open' });
    });

    it('emits circuitBreakerRejectionsTotal when request is rejected (circuit open)', async () => {
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const metrics = createMockMetrics();
      const breaker = new CircuitBreakerLLMClient(inner, {
        failureThreshold: 2,
        resetTimeoutMs: 60_000,
      });
      breaker.setMetrics(metrics);

      // Trip the breaker
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      expect(breaker.state).toBe('open');

      // Next call is rejected by circuit breaker
      await expect(breaker.complete(defaultRequest)).rejects.toThrow('Circuit breaker open');
      expect(metrics.circuitBreakerRejectionsTotal.add).toHaveBeenCalledWith(1);
    });

    it('emits circuitBreakerState closed metric when circuit closes', async () => {
      vi.useFakeTimers();
      const inner = createMockClient();
      (inner.complete as any).mockRejectedValue(new Error('down'));
      const metrics = createMockMetrics();
      const breaker = new CircuitBreakerLLMClient(inner, {
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        halfOpenMaxAttempts: 1,
      });
      breaker.setMetrics(metrics);

      // Trip the breaker
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      await expect(breaker.complete(defaultRequest)).rejects.toThrow();
      expect(breaker.state).toBe('open');

      // Move to half-open
      vi.advanceTimersByTime(1_001);

      // Successful call closes the circuit (halfOpenMaxAttempts = 1)
      (inner.complete as any).mockResolvedValueOnce({
        content: 'recovered', model: 'test',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      });
      await breaker.complete(defaultRequest);
      expect(breaker.state).toBe('closed');

      expect(metrics.circuitBreakerState.add).toHaveBeenCalledWith(1, { state: 'closed' });

      vi.useRealTimers();
    });
  });
});
