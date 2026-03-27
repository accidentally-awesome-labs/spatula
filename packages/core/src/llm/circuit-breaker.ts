import { LLMError, ConfigError } from '@spatula/shared';
import type { SpatulaMetrics } from '@spatula/shared';
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '../interfaces/llm-client.js';
import { OllamaClient } from './ollama-client.js';

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
  private metrics?: SpatulaMetrics;

  constructor(
    private readonly inner: LLMClient,
    config?: Partial<CircuitBreakerConfig> & { allowOllama?: boolean },
  ) {
    if (inner instanceof OllamaClient && !config?.allowOllama) {
      throw new ConfigError(
        'CircuitBreakerLLMClient should not wrap OllamaClient — Ollama failures are terminal (local server), ' +
        'not transient. Use CircuitBreakerLLMClient with cloud providers like OpenRouter.',
      );
    }
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setMetrics(metrics: SpatulaMetrics): void {
    this.metrics = metrics;
  }

  /** Read-only state accessor. No side effects. */
  get state(): CircuitState {
    return this._state;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    // Promote OPEN -> HALF_OPEN if timeout has elapsed
    if (this._state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.resetTimeoutMs) {
        this._state = 'half_open';
        this.halfOpenSuccesses = 0;
        this.metrics?.circuitBreakerState.add(1, { state: 'half_open' });
        this.metrics?.circuitBreakerState.add(-1, { state: 'open' });
      }
    }

    const currentState = this._state;

    if (currentState === 'open') {
      this.metrics?.circuitBreakerRejectionsTotal.add(1);
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
        // Any failure in half-open -> re-open
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
    this.metrics?.circuitBreakerState.add(1, { state: 'open' });
    this.metrics?.circuitBreakerState.add(-1, { state: 'closed' });
  }

  private close(): void {
    this._state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.metrics?.circuitBreakerState.add(-1, { state: 'open' });
    this.metrics?.circuitBreakerState.add(1, { state: 'closed' });
  }
}
