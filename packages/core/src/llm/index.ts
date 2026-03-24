export { OpenRouterClient } from './openrouter-client.js';
export { OllamaClient } from './ollama-client.js';
export { createLLMClient } from './llm-factory.js';
export { resolveModel } from './model-router.js';
export type { LLMTask, OpenRouterClientOptions, OllamaClientOptions, LLMProvider, LLMFactoryConfig } from './types.js';
export { CircuitBreakerLLMClient } from './circuit-breaker.js';
export type { CircuitBreakerConfig, CircuitState } from './circuit-breaker.js';
// Usage note: Apply CircuitBreakerLLMClient to OpenRouterClient (cloud, transient failures).
// Do NOT wrap OllamaClient — it has no retries by design (local server, failures are terminal).
// In the LLM factory or pipeline runner:
//   const llm = new CircuitBreakerLLMClient(new OpenRouterClient({...}));
