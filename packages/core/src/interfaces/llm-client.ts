export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMCompletionResponse {
  content: string;
  model: string;
  usage: LLMUsage;
  finishReason: string;
}

export interface LLMClient {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}

export interface LLMUsageRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  purpose?: string;
}

export interface LLMUsageRecorder {
  record(usage: LLMUsageRecord): void;
}
