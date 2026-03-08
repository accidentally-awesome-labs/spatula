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
