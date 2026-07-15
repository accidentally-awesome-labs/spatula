import { z } from 'zod';
import { createLogger, generateId } from '@accidentally-awesome-labs/spatula-shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { PipelineAction } from '../types/actions.js';
import { FieldDefinition } from '../types/schema.js';
import { resolveModel } from '../llm/model-router.js';
import type { AggregatedField } from './unmapped-aggregator.js';

const logger = createLogger('synonym-detector');

const MergeProposal = z.object({
  canonicalName: z.string(),
  aliasNames: z.array(z.string()),
  canonicalDefinition: FieldDefinition,
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const LLMSynonymResponse = z.object({
  merges: z.array(MergeProposal),
});

export type MergeProposalResult = z.infer<typeof MergeProposal>;

const SYSTEM_PROMPT = `You are a schema evolution expert specializing in synonym detection. Your job is to identify fields that represent the same concept under different names and propose merges. Respond with JSON only.`;

function buildSynonymPrompt(
  currentFields: SchemaDefinition['fields'],
  aggregatedFields: AggregatedField[],
  jobDescription: string,
): string {
  const schemaSection = currentFields
    .map((f) => `- ${f.name} (${f.type}${f.required ? ', REQUIRED' : ''}): ${f.description}`)
    .join('\n');

  const unmappedSection = aggregatedFields
    .map((c) => {
      const samples = c.sampleValues
        .slice(0, 5)
        .map((v) => JSON.stringify(v))
        .join(', ');
      return `- "${c.normalizedName}" (observed ${c.occurrences} times, frequency ${(c.frequency * 100).toFixed(1)}%, dominant type: ${c.dominantType})
    Name variants: ${c.observedNames.join(', ')}
    Sample values: ${samples}`;
    })
    .join('\n');

  return `Analyze all the fields below and identify any that are synonyms of each other (i.e., represent the same concept under different names). Propose merges for synonym groups.

## Data Collection Goal
${jobDescription}

## Current Schema Fields
${schemaSection || '(no fields yet)'}

## Unmapped Fields
${unmappedSection || '(none)'}

## Instructions
Compare ALL fields (both schema fields and unmapped fields) and identify synonym groups — fields that represent the same underlying concept. For each synonym group:

1. Choose the best canonical name (snake_case, clear, descriptive)
2. List all other names as aliases
3. Provide the canonical field definition (name, description, type, required)
4. Explain your reasoning for the merge
5. Rate your confidence (0-1) that these fields are true synonyms

Examples of synonyms:
- "price" and "cost" and "unit_price"
- "product_name" and "title" and "item_name"
- "colour" and "color"
- "phone" and "telephone" and "phone_number"

Only propose merges when you are reasonably confident the fields represent the same concept. Do NOT merge fields that are merely related but distinct (e.g., "width" and "height" are related but not synonyms).

Respond with JSON:
{
  "merges": [
    {
      "canonicalName": "price",
      "aliasNames": ["cost", "unit_price"],
      "canonicalDefinition": {
        "name": "price",
        "description": "Product price",
        "type": "currency",
        "required": false
      },
      "reasoning": "These fields all represent the monetary cost of the product",
      "confidence": 0.95
    }
  ]
}

If no synonyms are found, return: { "merges": [] }`;
}

export class SynonymDetector {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async detect(
    currentSchema: SchemaDefinition,
    aggregatedFields: AggregatedField[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    const totalFields = currentSchema.fields.length + aggregatedFields.length;

    if (totalFields < 2) {
      logger.debug('fewer than 2 total fields, skipping synonym detection');
      return [];
    }

    const prompt = buildSynonymPrompt(currentSchema.fields, aggregatedFields, jobDescription);

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'schemaEvolution'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 4096,
      });

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(response.content);
      } catch {
        logger.warn('non-JSON response from LLM in synonym detector');
        return [];
      }

      const parsed = LLMSynonymResponse.safeParse(rawObject);

      if (!parsed.success) {
        logger.warn({ errors: parsed.error.issues }, 'invalid synonym response from LLM');
        return [];
      }

      logger.debug(
        { mergeCount: parsed.data.merges.length },
        'synonym merge proposals received from LLM',
      );

      return parsed.data.merges.map(
        (merge): PipelineAction => ({
          id: generateId(),
          jobId: generateId(),
          type: 'merge_fields',
          source: 'schema_evolution',
          reasoning: merge.reasoning,
          confidence: merge.confidence,
          payload: {
            canonicalName: merge.canonicalName,
            aliasNames: merge.aliasNames,
            canonicalDefinition: merge.canonicalDefinition,
            valueMappings: {},
          },
        }),
      );
    } catch (error) {
      logger.error({ error }, 'synonym detection LLM call failed');
      return [];
    }
  }
}
