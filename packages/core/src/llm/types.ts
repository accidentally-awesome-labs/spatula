export type LLMTask =
  | 'pageRelevance'
  | 'extraction'
  | 'linkEvaluation'
  | 'schemaEvolution'
  | 'entityMatching'
  | 'conflictResolution'
  | 'qualityAudit'
  | 'documentation';

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  siteName?: string;
  siteUrl?: string;
}

export interface OllamaClientOptions {
  baseUrl?: string; // Default: 'http://localhost:11434'
  timeoutMs?: number; // Default: 120000 (local models are slower)
}

export type LLMProvider = 'openrouter' | 'ollama';

export interface LLMFactoryConfig {
  provider: LLMProvider;
  openrouter?: OpenRouterClientOptions;
  ollama?: OllamaClientOptions;
}
