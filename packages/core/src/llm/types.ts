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
