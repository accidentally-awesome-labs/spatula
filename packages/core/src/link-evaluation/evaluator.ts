import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { ExtractedLink } from '../crawlers/link-extractor.js';
import type { SchemaDefinition } from '../types/schema.js';

const logger = createLogger('link-evaluator');

const BATCH_SIZE = 20;

// ─── Types ─────────────────────────────────────────────────────

export type ExpectedContentType =
  | 'single_entry'
  | 'listing'
  | 'pagination'
  | 'category'
  | 'unknown';

export type LinkPriority = 'high' | 'medium' | 'low';

export interface EvaluatedLink extends ExtractedLink {
  relevanceScore: number;
  expectedContent: ExpectedContentType;
  priority: LinkPriority;
  reasoning: string;
}

export interface LinkEvaluationContext {
  description: string;
  seedDomains: string[];
  currentDepth: number;
  maxDepth: number;
}

// ─── Interface ─────────────────────────────────────────────────

export interface LinkEvaluator {
  evaluate(
    links: ExtractedLink[],
    jobContext: LinkEvaluationContext,
    schema: SchemaDefinition,
  ): Promise<EvaluatedLink[]>;
}

// ─── LLM Implementation ───────────────────────────────────────

export class LLMLinkEvaluator implements LinkEvaluator {
  constructor(
    private readonly llm: LLMClient,
    private readonly model: string,
  ) {}

  async evaluate(
    links: ExtractedLink[],
    jobContext: LinkEvaluationContext,
    schema: SchemaDefinition,
  ): Promise<EvaluatedLink[]> {
    if (links.length === 0) return [];

    const results: EvaluatedLink[] = [];

    for (let i = 0; i < links.length; i += BATCH_SIZE) {
      const batch = links.slice(i, i + BATCH_SIZE);
      const evaluated = await this.evaluateBatch(batch, jobContext, schema);
      results.push(...evaluated);
    }

    return results;
  }

  private async evaluateBatch(
    links: ExtractedLink[],
    jobContext: LinkEvaluationContext,
    schema: SchemaDefinition,
  ): Promise<EvaluatedLink[]> {
    const fieldNames = schema.fields.map((f) => f.name).join(', ');
    const linksJson = links.map((l) => ({ url: l.url, text: l.text ?? '' }));

    const prompt = `Evaluate each link's relevance to this data extraction job.

Job description: ${jobContext.description}
Seed domains: ${jobContext.seedDomains.join(', ')}
Current crawl depth: ${jobContext.currentDepth}/${jobContext.maxDepth}
Target schema fields: ${fieldNames}

Links to evaluate:
${JSON.stringify(linksJson, null, 2)}

For each link, return a JSON array with objects containing:
- url: the link URL (exactly as provided)
- relevanceScore: 0-1 float (1 = highly relevant to extracting target data)
- expectedContent: one of "single_entry", "listing", "pagination", "category", "unknown"
- priority: "high", "medium", or "low"
- reasoning: brief explanation

Return ONLY the JSON array, no other text.`;

    try {
      const response = await this.llm.complete({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a web crawl link evaluator. You evaluate links for relevance to data extraction jobs. Respond only with JSON.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        jsonMode: true,
      });

      return this.parseResponse(response.content, links);
    } catch (err) {
      logger.warn(
        { err, linkCount: links.length },
        'LLM link evaluation failed, using fallback scores',
      );
      return this.fallbackScores(links);
    }
  }

  private parseResponse(content: string, originalLinks: ExtractedLink[]): EvaluatedLink[] {
    try {
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error('Response is not an array');

      const resultMap = new Map<string, any>();
      for (const item of parsed) {
        if (item.url) resultMap.set(item.url, item);
      }

      return originalLinks.map((link) => {
        const evaluated = resultMap.get(link.url);
        if (evaluated) {
          return {
            ...link,
            relevanceScore: clamp(Number(evaluated.relevanceScore) || 0.5, 0, 1),
            expectedContent: validateExpectedContent(evaluated.expectedContent),
            priority: validatePriority(evaluated.priority),
            reasoning: String(evaluated.reasoning || ''),
          };
        }
        return {
          ...link,
          relevanceScore: 0.5,
          expectedContent: 'unknown' as const,
          priority: 'medium' as const,
          reasoning: 'Not evaluated by LLM',
        };
      });
    } catch {
      logger.warn('Failed to parse LLM link evaluation response, using fallback');
      return this.fallbackScores(originalLinks);
    }
  }

  private fallbackScores(links: ExtractedLink[]): EvaluatedLink[] {
    return links.map((link) => ({
      ...link,
      relevanceScore: 0.5,
      expectedContent: 'unknown' as const,
      priority: 'medium' as const,
      reasoning: 'Fallback score — LLM evaluation unavailable',
    }));
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const VALID_CONTENT_TYPES = new Set([
  'single_entry',
  'listing',
  'pagination',
  'category',
  'unknown',
]);
function validateExpectedContent(value: unknown): ExpectedContentType {
  return VALID_CONTENT_TYPES.has(value as string) ? (value as ExpectedContentType) : 'unknown';
}

const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
function validatePriority(value: unknown): LinkPriority {
  return VALID_PRIORITIES.has(value as string) ? (value as LinkPriority) : 'medium';
}
