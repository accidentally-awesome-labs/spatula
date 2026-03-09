import { z } from 'zod';
import { ExtractionError, createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { Extractor } from '../interfaces/extractor.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition, FieldDefinitionOutput } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import { UnmappedField } from '../types/extraction.js';
import { resolveModel } from '../llm/model-router.js';
import { preprocessHTML } from './html-preprocessor.js';
import { schemaToPrompt } from './schema-to-prompt.js';

const logger = createLogger('static-extractor');

const LLMExtractionResponse = z.object({
  data: z.record(z.unknown()),
  _unmapped: z.array(UnmappedField).optional().default([]),
  confidence: z.number().min(0).max(1),
});

export class StaticExtractor implements Extractor {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
    private readonly jobId: string,
  ) {}

  async extract(
    html: string,
    url: string,
    schema: SchemaDefinition,
    jobDescription: string,
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    const preprocessed = preprocessHTML(html);
    const schemaPrompt = schemaToPrompt(schema.fields as FieldDefinitionOutput[]);
    const prompt = buildExtractionPrompt(url, jobDescription, schemaPrompt, preprocessed.content);

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'extraction'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 4096,
      });

      const extractionTimeMs = Date.now() - startTime;

      let parsed: z.infer<typeof LLMExtractionResponse>;
      try {
        parsed = LLMExtractionResponse.parse(JSON.parse(response.content));
      } catch {
        logger.warn({ url }, 'invalid extraction response from LLM');
        return this.emptyResult(schema.version, extractionTimeMs, response.model, 0);
      }

      logger.debug(
        { url, confidence: parsed.confidence, fields: Object.keys(parsed.data).length },
        'extraction completed',
      );

      return {
        id: generateId(),
        jobId: this.jobId,
        pageId: generateId(),
        schemaVersion: schema.version,
        data: parsed.data,
        metadata: {
          confidence: parsed.confidence,
          modelUsed: response.model,
          tokensUsed: response.usage.totalTokens,
          extractionTimeMs,
          unmappedFields: parsed._unmapped ?? [],
        },
      };
    } catch (error) {
      if (error instanceof ExtractionError) throw error;

      throw new ExtractionError(`Extraction failed for ${url}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { url, jobId: this.jobId },
      });
    }
  }

  private emptyResult(
    schemaVersion: number,
    extractionTimeMs: number,
    model: string,
    tokensUsed: number,
  ): ExtractionResult {
    return {
      id: generateId(),
      jobId: this.jobId,
      pageId: generateId(),
      schemaVersion,
      data: {},
      metadata: {
        confidence: 0,
        modelUsed: model,
        tokensUsed,
        extractionTimeMs,
        unmappedFields: [],
      },
    };
  }
}

const SYSTEM_PROMPT = `You are a data extraction expert. Extract structured information from web pages according to a provided schema. Return JSON only.`;

function buildExtractionPrompt(
  url: string,
  jobDescription: string,
  schemaPrompt: string,
  content: string,
): string {
  return `Extract structured data from this web page.

## Data Description
${jobDescription}

## Schema
${schemaPrompt}

## Rules
1. Extract values exactly as they appear on the page.
2. For REQUIRED fields, make every effort to find the value. If truly absent, set to null.
3. For optional fields, include them only if clearly present on the page.
4. If you discover data on the page that doesn't fit any schema field but seems relevant to "${jobDescription}", include it in the _unmapped array.
5. Return your confidence (0.0-1.0) in the overall extraction quality.

## Page
URL: ${url}

${content}

## Response Format
Return JSON:
{
  "data": { /* extracted fields matching the schema */ },
  "_unmapped": [
    { "name": "field_name", "value": "extracted_value", "suggestedType": "string|number|boolean|url|currency|enum|array|object" }
  ],
  "confidence": 0.95
}`;
}
