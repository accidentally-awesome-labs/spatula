import { z } from 'zod';
import { createLogger, generateId } from '@accidentally-awesome-labs/spatula-shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import type { PipelineAction } from '../types/actions.js';
import { NormalizationRule } from '../types/normalization.js';
import { resolveModel } from '../llm/model-router.js';

const logger = createLogger('normalization-proposer');

const NormRuleProposal = z.object({
  fieldName: z.string(),
  rule: NormalizationRule,
  examples: z.array(z.object({ before: z.unknown(), after: z.unknown() })),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const EnumUpdateProposal = z.object({
  fieldName: z.string(),
  additions: z.record(z.string()),
  newCanonicalValues: z.array(z.string()).optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const LLMNormalizationResponse = z.object({
  rules: z.array(NormRuleProposal),
  enumUpdates: z.array(EnumUpdateProposal),
});

const SYSTEM_PROMPT = `You are a data normalization expert. Your job is to analyze extracted data values and propose normalization rules that will standardize the data for consistency. Respond with JSON only.`;

export function collectValueSamples(
  fieldNames: string[],
  extractions: ExtractionResult[],
): Record<string, unknown[]> {
  const samples: Record<string, unknown[]> = {};
  for (const name of fieldNames) {
    samples[name] = [];
  }

  for (const extraction of extractions) {
    for (const name of fieldNames) {
      if (samples[name].length >= 10) continue;
      const value = extraction.data[name];
      if (value !== undefined && value !== null) {
        samples[name].push(value);
      }
    }
  }

  return samples;
}

function buildNormalizationPrompt(
  fields: SchemaDefinition['fields'],
  valueSamples: Record<string, unknown[]>,
  jobDescription: string,
): string {
  const fieldSection = fields
    .filter((f) => f.name in valueSamples && valueSamples[f.name].length > 0)
    .map((f) => {
      const samples = valueSamples[f.name].map((v) => JSON.stringify(v)).join(', ');
      return `- ${f.name} (${f.type}${f.required ? ', REQUIRED' : ''}): ${f.description}
    Sample values: ${samples}`;
    })
    .join('\n');

  return `Analyze these schema fields and their sample extracted values, then propose normalization rules to standardize the data.

## Data Collection Goal
${jobDescription}

## Fields and Sample Values
${fieldSection}

## Instructions
For each field that would benefit from normalization, propose a rule with one of these types:
- "currency": standardize currency values (config: targetCurrency, decimalPlaces)
- "enum": map variant strings to canonical values (config: canonicalValues, synonymMap)
- "list": split delimited values into arrays (config: separator)
- "text": normalize casing/whitespace (config: casing, trim, collapseWhitespace)
- "measurement": standardize measurement units (config: targetUnit, format)
- "boolean": map truthy/falsy strings to boolean (config: trueValues, falseValues)
- "llm": use LLM for complex normalization (config: instruction)

Also propose enum map updates for fields that already have enum normalization but need new mappings.

For each rule, provide before/after examples showing how values would be transformed.

Only propose rules for fields where normalization would genuinely improve data consistency.

Respond with JSON:
{
  "rules": [
    {
      "fieldName": "field_name",
      "rule": { "type": "text", "config": { "casing": "title", "trim": true, "collapseWhitespace": true } },
      "examples": [{ "before": "  messy  text ", "after": "Messy Text" }],
      "reasoning": "Why this normalization helps",
      "confidence": 0.9
    }
  ],
  "enumUpdates": [
    {
      "fieldName": "field_name",
      "additions": { "variant_value": "canonical_value" },
      "newCanonicalValues": ["new_canonical"],
      "reasoning": "Why these mappings are needed",
      "confidence": 0.85
    }
  ]
}`;
}

export class NormalizationProposer {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async propose(
    schema: SchemaDefinition,
    extractions: ExtractionResult[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    // Fields without normalization rules (candidates for new rules)
    const fieldsNeedingRules = schema.fields.filter((f) => !f.normalization);
    // Fields with enum normalization (candidates for enum map updates)
    const fieldsWithEnumNorm = schema.fields.filter((f) => f.normalization?.type === 'enum');

    const eligibleFields = [...fieldsNeedingRules, ...fieldsWithEnumNorm];

    if (eligibleFields.length === 0) {
      logger.debug('no fields need normalization — all already have non-enum rules');
      return [];
    }

    // Step 2: Collect sample values
    const fieldNames = eligibleFields.map((f) => f.name);
    const valueSamples = collectValueSamples(fieldNames, extractions);

    // Step 3: Check if any values were found
    const fieldsWithValues = fieldNames.filter((name) => valueSamples[name].length > 0);

    if (fieldsWithValues.length === 0) {
      logger.debug('no sample values found for eligible fields');
      return [];
    }

    // Step 4: Build prompt and call LLM
    const prompt = buildNormalizationPrompt(eligibleFields, valueSamples, jobDescription);

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
        logger.warn('non-JSON response from LLM in normalization proposer');
        return [];
      }

      const parsed = LLMNormalizationResponse.safeParse(rawObject);

      if (!parsed.success) {
        logger.warn(
          { errors: parsed.error.issues },
          'invalid normalization proposal response from LLM',
        );
        return [];
      }

      logger.debug(
        {
          ruleCount: parsed.data.rules.length,
          enumUpdateCount: parsed.data.enumUpdates.length,
        },
        'normalization proposals received from LLM',
      );

      // Step 5: Map to PipelineAction array
      const actions: PipelineAction[] = [];

      for (const rule of parsed.data.rules) {
        actions.push({
          id: generateId(),
          jobId: generateId(),
          type: 'set_normalization_rule',
          source: 'schema_evolution',
          reasoning: rule.reasoning,
          confidence: rule.confidence,
          payload: {
            fieldName: rule.fieldName,
            rule: rule.rule,
            examples: rule.examples,
          },
        });
      }

      for (const update of parsed.data.enumUpdates) {
        actions.push({
          id: generateId(),
          jobId: generateId(),
          type: 'update_enum_map',
          source: 'schema_evolution',
          reasoning: update.reasoning,
          confidence: update.confidence,
          payload: {
            fieldName: update.fieldName,
            additions: update.additions,
            ...(update.newCanonicalValues ? { newCanonicalValues: update.newCanonicalValues } : {}),
          },
        });
      }

      return actions;
    } catch (error) {
      logger.error({ error }, 'normalization proposal LLM call failed');
      return [];
    }
  }
}
