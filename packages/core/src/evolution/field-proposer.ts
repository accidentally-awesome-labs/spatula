import { z } from 'zod';
import { createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { PipelineAction } from '../types/actions.js';
import { FieldRelevance } from '../types/schema.js';
import { resolveModel } from '../llm/model-router.js';
import type { AggregatedField } from './unmapped-aggregator.js';

const logger = createLogger('field-proposer');

const FieldProposal = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
  required: z.boolean(),
  enumValues: z.array(z.string()).optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  relevance: FieldRelevance,
});

const LLMFieldProposalResponse = z.object({
  proposals: z.array(FieldProposal),
});

export type FieldProposalResult = z.infer<typeof FieldProposal>;

const SYSTEM_PROMPT = `You are a schema evolution expert. Your job is to analyze unmapped fields discovered during web data extraction and propose new schema fields. Respond with JSON only.`;

function buildProposalPrompt(
  currentFields: SchemaDefinition['fields'],
  candidates: AggregatedField[],
  jobDescription: string,
): string {
  const schemaSection = currentFields
    .map((f) => `- ${f.name} (${f.type}${f.required ? ', REQUIRED' : ''}): ${f.description}`)
    .join('\n');

  const candidateSection = candidates
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

  return `Analyze these unmapped fields and propose which ones should be added to the schema.

## Data Collection Goal
${jobDescription}

## Current Schema Fields
${schemaSection || '(no fields yet)'}

## Candidate Unmapped Fields
${candidateSection}

## Instructions
For each candidate field worth adding to the schema, create a proposal with:
1. A clear, descriptive name (snake_case)
2. A description of what the field represents
3. The appropriate data type
4. Whether it should be required or optional
5. If type is "enum", provide the enumValues
6. Your reasoning for including this field
7. Your confidence (0-1) that this field belongs in the schema
8. A relevance assessment with:
   - globalFrequency: fraction of all extractions containing this field (use the candidate's frequency)
   - categoryBreakdown: array of category-specific frequency data (if applicable, otherwise empty array)
   - classification: one of "universal_required", "universal_optional", "categorical_required", "categorical_optional", "rare"
   - applicableCategories: array of category names where this field is relevant (null if universal)

Only propose fields that are genuinely useful for the data collection goal. Skip fields that are:
- Navigation artifacts or page metadata
- Duplicates of existing schema fields under different names
- Too rare or noisy to be useful

Respond with JSON:
{
  "proposals": [
    {
      "name": "field_name",
      "description": "What this field represents",
      "type": "string",
      "required": false,
      "enumValues": ["val1", "val2"],
      "reasoning": "Why this field should be added",
      "confidence": 0.85,
      "relevance": {
        "globalFrequency": 0.75,
        "categoryBreakdown": [],
        "classification": "universal_optional",
        "applicableCategories": null
      }
    }
  ]
}`;
}

export class FieldProposer {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async propose(
    currentSchema: SchemaDefinition,
    aggregatedFields: AggregatedField[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    // Filter out fields already in the schema
    const existingNames = new Set(currentSchema.fields.map((f) => f.name.toLowerCase()));
    const candidates = aggregatedFields.filter(
      (f) => !existingNames.has(f.normalizedName),
    );

    if (candidates.length === 0) {
      logger.debug('no candidate unmapped fields after filtering existing schema fields');
      return [];
    }

    const prompt = buildProposalPrompt(currentSchema.fields, candidates, jobDescription);

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
        logger.warn('non-JSON response from LLM in field proposer');
        return [];
      }

      const parsed = LLMFieldProposalResponse.safeParse(rawObject);

      if (!parsed.success) {
        logger.warn({ errors: parsed.error.issues }, 'invalid field proposal response from LLM');
        return [];
      }

      logger.debug(
        { proposalCount: parsed.data.proposals.length },
        'field proposals received from LLM',
      );

      return parsed.data.proposals.map((proposal): PipelineAction => ({
        id: generateId(),
        jobId: generateId(),
        type: 'add_field',
        source: 'schema_evolution',
        reasoning: proposal.reasoning,
        confidence: proposal.confidence,
        payload: {
          field: {
            name: proposal.name,
            description: proposal.description,
            type: proposal.type,
            required: proposal.required,
            ...(proposal.enumValues ? { enumValues: proposal.enumValues } : {}),
          },
          relevance: proposal.relevance,
        },
      }));
    } catch (error) {
      logger.error({ error }, 'field proposal LLM call failed');
      return [];
    }
  }
}
