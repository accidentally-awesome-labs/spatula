import type { LLMClient, LLMCompletionRequest, JobConfig, ConfigAction } from '@spatula/core';
import type { ChatMessage } from '../store/index.js';

interface ConversationResult {
  responseText: string;
  actions: ConfigAction[];
}

/**
 * Service that interprets user messages via an LLM and produces ConfigActions
 * for building job configurations conversationally.
 */
export class ConfigConversationService {
  private readonly llm: LLMClient;
  private readonly model: string;

  constructor(llm: LLMClient, model: string) {
    this.llm = llm;
    this.model = model;
  }

  async processMessage(
    userMessage: string,
    currentConfig: JobConfig,
    history: ChatMessage[],
  ): Promise<ConversationResult> {
    const systemPrompt = this.buildSystemPrompt(currentConfig);
    const messages = this.buildMessages(systemPrompt, history, userMessage);

    const request: LLMCompletionRequest = {
      model: this.model,
      messages,
      temperature: 0.3,
      jsonMode: true,
    };

    let rawContent: string;
    try {
      const response = await this.llm.complete(request);
      rawContent = response.content;
    } catch {
      return {
        responseText:
          'I encountered an error communicating with the AI service. Please try again in a moment.',
        actions: [],
      };
    }

    return this.parseResponse(rawContent);
  }

  private buildSystemPrompt(currentConfig: JobConfig): string {
    return `You are a configuration assistant for Spatula, an intelligent web crawling platform. Your role is to help users build job configurations through natural conversation.

## Current Configuration State
\`\`\`json
${JSON.stringify(currentConfig, null, 2)}
\`\`\`

## Available ConfigAction Types

Each action must include: type, id (UUID), reasoning (string explaining why), and payload.

### Metadata
- **set_job_name**: Set the job name. Payload: { name: string }
- **set_job_description**: Set the job description. Payload: { description: string }

### Seed URLs
- **add_seed_urls**: Add seed URLs to crawl. Payload: { urls: [{ url: string, label?: string }] }
- **remove_seed_urls**: Remove seed URLs. Payload: { urls: string[], reason?: string }
- **replace_seed_urls**: Replace all seed URLs. Payload: { urls: [{ url: string, label?: string }] }

### Crawl Settings
- **set_crawl_depth**: Set max crawl depth (0-10). Payload: { maxDepth: number }
- **set_max_pages**: Set max pages to crawl. Payload: { maxPages: number }
- **set_concurrency**: Set crawl concurrency (1-20). Payload: { concurrency: number }
- **set_crawler_type**: Set crawler engine. Payload: { crawlerType: "playwright" | "firecrawl", reason?: string }

### Schema Fields
- **add_user_field**: Add a single field. Payload: { field: FieldDefinition, position?: "first" | "last" | "after", afterField?: string }
- **add_multiple_user_fields**: Add multiple fields. Payload: { fields: FieldDefinition[] }
- **remove_user_field**: Remove a field. Payload: { fieldName: string }
- **modify_user_field**: Modify a field. Payload: { fieldName: string, changes: { name?, description?, type?, required?, enumValues?, arrayItemType?, objectFields? } }
- **reorder_user_fields**: Reorder fields. Payload: { fieldOrder: string[] }
- **replace_all_user_fields**: Replace all fields. Payload: { fields: FieldDefinition[] }
- **define_nested_field**: Define nested sub-fields. Payload: { parentFieldName: string, subFields: FieldDefinition[] }

### Schema Mode
- **set_schema_mode**: Set schema mode. Payload: { mode: "fixed" | "discovery" | "hybrid" }
- **set_evolution_config**: Configure schema evolution. Payload: { enabled?, batchSize?, maxFields?, relevanceThresholds?, tableStrategy? }

### LLM Config
- **set_primary_model**: Set the primary LLM model. Payload: { model: string }
- **set_model_override**: Override model for a specific task. Payload: { task: LLMTask, model: string }
- **clear_model_override**: Clear a model override. Payload: { task: LLMTask }

### Reconciliation Config
- **set_match_strategy**: Set entity matching strategy. Payload: { matchStrategy: "exact_name" | "fuzzy_name" | "composite_key" | "llm_assisted", fuzzyMatchThreshold?, enableLLMMatching? }
- **set_conflict_resolution**: Set conflict resolution strategy. Payload: { strategy: "most_common" | "most_complete" | "source_priority" | "most_recent" | "llm_resolved" }
- **set_source_priority**: Set source trust rankings. Payload: { rankings: [{ domain: string, trustLevel: "authoritative" | "high" | "medium" | "low", reasoning?: string }] }

### Safety
- **set_action_approval_policy**: Set action approval policy. Payload: { preset?: "trust_ai" | "balanced" | "cautious" | "manual", overrides?: [{ actionType: string, policy: "always_auto" | "auto_above_threshold" | "always_review" | "batch_review", threshold?: number }] }

### Templates
- **save_as_template**: Save config as template. Payload: { templateName: string, description?: string }
- **load_template**: Load a template. Payload: { templateName: string, overrides?: Record<string, unknown> }
- **clone_job_config**: Clone from existing job. Payload: { sourceJobId: string (UUID), overrides?: Record<string, unknown> }

### Control
- **confirm_and_start**: Confirm configuration and start the job. Payload: {} (empty object)
- **reset_config**: Reset configuration. Payload: { keepFields?: Array<"name" | "description" | "seedUrls" | "userFields" | "crawlSettings" | "llmConfig"> }

## FieldDefinition Schema
{ name: string, description: string, type: "string" | "number" | "boolean" | "url" | "currency" | "enum" | "array" | "object", required?: boolean, enumValues?: string[], arrayItemType?: FieldDefinition, objectFields?: FieldDefinition[] }

## Response Format
You MUST respond with valid JSON in this exact format:
{
  "response": "Your natural language response to the user",
  "actions": [
    {
      "type": "action_type",
      "id": "uuid-v4",
      "reasoning": "Why this action is being taken",
      "payload": { ... }
    }
  ]
}

## Guidelines
- Be proactive: suggest sensible defaults and ask clarifying questions when needed.
- Use discovery mode by default for schema unless the user specifies exact fields.
- When the user indicates they are satisfied with the configuration, emit a "confirm_and_start" action.
- You can emit multiple actions in a single response when the user provides enough information.
- Always explain what actions you are taking and why.
- If you need more information before taking action, respond with an empty actions array and ask the user.`;
  }

  private buildMessages(
    systemPrompt: string,
    history: ChatMessage[],
    userMessage: string,
  ): LLMCompletionRequest['messages'] {
    const messages: LLMCompletionRequest['messages'] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: userMessage });

    return messages;
  }

  private parseResponse(rawContent: string): ConversationResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return {
        responseText:
          'I had trouble processing the response. Could you try rephrasing your request?',
        actions: [],
      };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return {
        responseText:
          'I had trouble processing the response. Could you try rephrasing your request?',
        actions: [],
      };
    }

    const obj = parsed as Record<string, unknown>;
    const responseText =
      typeof obj.response === 'string'
        ? obj.response
        : 'I had trouble processing the response. Could you try rephrasing your request?';

    const rawActions = Array.isArray(obj.actions) ? obj.actions : [];
    const actions = rawActions.filter((action): action is ConfigAction => {
      return this.isValidAction(action);
    });

    return { responseText, actions };
  }

  private isValidAction(action: unknown): boolean {
    if (typeof action !== 'object' || action === null) {
      return false;
    }
    const obj = action as Record<string, unknown>;
    return (
      typeof obj.type === 'string' &&
      typeof obj.id === 'string' &&
      typeof obj.reasoning === 'string' &&
      typeof obj.payload === 'object' &&
      obj.payload !== null
    );
  }
}
