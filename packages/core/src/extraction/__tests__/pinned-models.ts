/**
 * Pinned model constants for the adversarial extraction suite.
 *
 * Any change to these strings constitutes a pin rotation and requires
 * re-running the full adversarial suite against the new model(s) before merging.
 *
 * OpenRouter pin: anthropic/claude-3-5-sonnet-20240620
 * Ollama pin: llama3.1:8b-instruct-q4_0
 *
 * CI lane: .github/workflows/adversarial-llm.yml
 * Corpus-refresh docs: docs/contributing/adversarial-corpus-refresh.md
 */
export const PINNED_MODELS = {
  openrouter: 'anthropic/claude-3-5-sonnet-20240620',
  ollama: 'llama3.1:8b-instruct-q4_0',
} as const;
