import { z } from 'zod';
import { createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { PipelineAction } from '../types/actions.js';
import { resolveModel } from '../llm/model-router.js';

const logger = createLogger('gap-filler');

// ---------------------------------------------------------------------------
// Zod schema for LLM response validation
// ---------------------------------------------------------------------------

const LLMInferenceResponse = z.object({
  inferences: z.array(
    z.object({
      fieldName: z.string(),
      inferredValue: z.unknown(),
      inferredFrom: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are a data quality expert. Infer missing values for the given entity based on available data and domain knowledge. Respond with JSON only.';

function buildGapFillerPrompt(
  entityData: Record<string, unknown>,
  missingFields: Array<{ name: string; description: string; type: string }>,
  jobDescription: string,
): string {
  const existingDataJson = JSON.stringify(entityData, null, 2);

  const missingFieldsList = missingFields
    .map((f) => `- "${f.name}" (${f.type}): ${f.description}`)
    .join('\n');

  return `Infer the missing required field values for the following entity.

## Data Collection Goal
${jobDescription}

## Existing Entity Data
${existingDataJson}

## Missing Required Fields
${missingFieldsList}

## Instructions
For each missing field, try to infer its value from the existing data and your domain knowledge.
Only provide inferences you are reasonably confident about.

Respond with JSON:
{
  "inferences": [
    {
      "fieldName": "field_name",
      "inferredValue": "the inferred value",
      "inferredFrom": "Brief explanation of how the value was inferred",
      "confidence": 0.95
    }
  ]
}`;
}

// ---------------------------------------------------------------------------
// GapFiller
// ---------------------------------------------------------------------------

export class GapFiller {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly llmConfig: LLMConfig,
  ) {}

  /**
   * Identify missing required fields and ask LLM to infer values.
   * Returns infer_value PipelineActions for each inferred field.
   * Skips LLM call entirely if no required fields are missing.
   */
  async fillGaps(
    entityId: string,
    mergedData: Record<string, unknown>,
    schema: SchemaDefinition,
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    // Find missing required fields
    const missingRequired = schema.fields.filter(
      (field) =>
        field.required === true &&
        (mergedData[field.name] === undefined || mergedData[field.name] === null),
    );

    // Early return if no missing required fields
    if (missingRequired.length === 0) {
      return [];
    }

    try {
      const model = resolveModel(this.llmConfig, 'conflictResolution');
      const prompt = buildGapFillerPrompt(
        mergedData,
        missingRequired.map((f) => ({ name: f.name, description: f.description, type: f.type })),
        jobDescription,
      );

      const response = await this.llmClient.complete({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 2048,
      });

      // Parse JSON response
      let rawObject: unknown;
      try {
        rawObject = JSON.parse(response.content);
      } catch {
        logger.warn('non-JSON response from LLM in gap filler');
        return [];
      }

      // Validate with Zod
      const parsed = LLMInferenceResponse.safeParse(rawObject);
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.issues }, 'invalid gap filler response from LLM');
        return [];
      }

      // Filter: only accept inferences for fields that are actually in the missing list
      const missingFieldNames = new Set(missingRequired.map((f) => f.name));
      const validInferences = parsed.data.inferences.filter((inf) =>
        missingFieldNames.has(inf.fieldName),
      );

      logger.debug(
        { inferenceCount: validInferences.length, missingCount: missingRequired.length },
        'gap filler inferences received from LLM',
      );

      // Build infer_value actions
      const actions: PipelineAction[] = validInferences.map((inference) => ({
        id: generateId(),
        jobId: generateId(), // stamped by worker later
        type: 'infer_value' as const,
        source: 'reconciliation' as const,
        reasoning: inference.inferredFrom,
        confidence: inference.confidence,
        payload: {
          entityId,
          fieldName: inference.fieldName,
          inferredValue: inference.inferredValue,
          inferredFrom: inference.inferredFrom,
        },
      }));

      return actions;
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'gap filler LLM call failed',
      );
      return [];
    }
  }
}
