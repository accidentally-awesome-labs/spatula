import { z } from 'zod';
import { createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { PipelineAction } from '../types/actions.js';
import { TrustLevel } from '../types/reconciliation.js';
import { resolveModel } from '../llm/model-router.js';

const logger = createLogger('source-trust-evaluator');

// ---------------------------------------------------------------------------
// Zod schema for LLM response validation
// ---------------------------------------------------------------------------

const LLMTrustResponse = z.object({
  rankings: z.array(
    z.object({
      domain: z.string(),
      trustLevel: TrustLevel,
      reasoning: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are a data quality expert. Evaluate the trustworthiness of these data sources. Respond with JSON only.';

function buildTrustPrompt(domains: string[], jobDescription: string): string {
  const domainList = domains.map((d) => `- ${d}`).join('\n');

  return `Evaluate the trustworthiness of the following data sources for the given data collection task.

## Data Collection Goal
${jobDescription}

## Domains to Evaluate
${domainList}

## Instructions
For each domain, assign a trust level based on how reliable and authoritative it is for the given data collection goal:
- "authoritative": Official or primary source for this type of data (e.g., manufacturer website for product specs)
- "high": Well-known, reputable source with generally accurate data
- "medium": Reasonable source but may have inconsistencies or be secondary
- "low": Unreliable, user-generated, or potentially outdated source

Consider:
1. Is this domain a primary/official source for this kind of data?
2. How well-maintained and accurate is the data likely to be?
3. Is the domain a recognized authority in this space?

Respond with JSON:
{
  "rankings": [
    {
      "domain": "example.com",
      "trustLevel": "high",
      "reasoning": "Brief explanation of the trust level"
    }
  ]
}`;
}

// ---------------------------------------------------------------------------
// SourceTrustEvaluator
// ---------------------------------------------------------------------------

export class SourceTrustEvaluator {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly llmConfig: LLMConfig,
  ) {}

  /**
   * LLM-powered trust evaluation. Sends domains + job description to LLM,
   * gets trust rankings back. Returns a single set_source_trust PipelineAction.
   */
  async evaluate(domains: string[], jobDescription: string): Promise<PipelineAction[]> {
    if (domains.length === 0) return [];

    try {
      const model = resolveModel(this.llmConfig, 'entityMatching');
      const prompt = buildTrustPrompt(domains, jobDescription);

      const response = await this.llmClient.complete({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: Math.max(2048, domains.length * 200),
      });

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(response.content);
      } catch {
        logger.warn('non-JSON response from LLM in source trust evaluator');
        return [];
      }

      const parsed = LLMTrustResponse.safeParse(rawObject);

      if (!parsed.success) {
        logger.warn({ errors: parsed.error.issues }, 'invalid trust evaluation response from LLM');
        return [];
      }

      const requestedDomains = new Set(domains);
      const validRankings = parsed.data.rankings.filter((r) => requestedDomains.has(r.domain));
      if (validRankings.length < domains.length) {
        logger.warn(
          { expected: domains.length, received: validRankings.length },
          'LLM returned rankings for fewer domains than requested',
        );
      }

      logger.debug(
        { rankingCount: validRankings.length },
        'source trust rankings received from LLM',
      );

      const action: PipelineAction = {
        id: generateId(),
        jobId: generateId(),
        type: 'set_source_trust',
        source: 'reconciliation',
        reasoning: 'LLM-evaluated source trustworthiness rankings',
        confidence: 1,
        payload: {
          rankings: validRankings,
        },
      };

      return [action];
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'source trust evaluation LLM call failed',
      );
      return [];
    }
  }

  /**
   * Non-LLM trust evaluation based on user-provided source priority order.
   * First domain = authoritative, second = high, rest = medium.
   * Domains not in priority list get 'medium'.
   */
  evaluateWithPriority(domains: string[], sourcePriority: string[]): PipelineAction[] {
    if (domains.length === 0) return [];

    const rankings = domains.map((domain) => {
      const priorityIndex = sourcePriority.indexOf(domain);
      let trustLevel: z.infer<typeof TrustLevel>;
      let reasoning: string;

      if (priorityIndex === 0) {
        trustLevel = 'authoritative';
        reasoning = 'Highest priority source per user-defined ranking';
      } else if (priorityIndex === 1) {
        trustLevel = 'high';
        reasoning = 'Second priority source per user-defined ranking';
      } else if (priorityIndex >= 2) {
        trustLevel = 'medium';
        reasoning = 'Listed in user-defined priority ranking';
      } else {
        trustLevel = 'medium';
        reasoning = 'Not in user-defined priority list, assigned default trust';
      }

      return { domain, trustLevel, reasoning };
    });

    const action: PipelineAction = {
      id: generateId(),
      jobId: generateId(),
      type: 'set_source_trust',
      source: 'reconciliation',
      reasoning: 'Source trust rankings based on user-defined priority order',
      confidence: 1,
      payload: {
        rankings,
      },
    };

    return [action];
  }
}
