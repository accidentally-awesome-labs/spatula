import { z } from 'zod';
import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import { PageClassification, ExtractionStrategy } from '../types/extraction.js';
import { resolveModel } from '../llm/model-router.js';
import { preprocessHTML } from './html-preprocessor.js';

const logger = createLogger('page-classifier');

const ClassificationResponse = z.object({
  classification: PageClassification,
  strategy: ExtractionStrategy,
  estimatedEntryCount: z.number().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type PageClassificationResult = z.infer<typeof ClassificationResponse>;

export class PageClassifier {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async classify(
    html: string,
    url: string,
    jobDescription: string,
  ): Promise<PageClassificationResult> {
    const preprocessed = preprocessHTML(html, { maxTokens: 8000 });

    const prompt = buildClassificationPrompt(url, jobDescription, preprocessed.content);

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'pageRelevance'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 512,
      });

      const parsed = ClassificationResponse.safeParse(JSON.parse(response.content));

      if (!parsed.success) {
        logger.warn({ url, errors: parsed.error.issues }, 'invalid classification response');
        return safeDefault();
      }

      logger.debug(
        { url, classification: parsed.data.classification, confidence: parsed.data.confidence },
        'page classified',
      );

      return parsed.data;
    } catch (error) {
      logger.error({ url, error }, 'page classification failed');
      return safeDefault();
    }
  }
}

function safeDefault(): PageClassificationResult {
  return {
    classification: 'irrelevant',
    strategy: 'skip',
    confidence: 0,
    reasoning: 'Classification failed — defaulting to skip.',
  };
}

const SYSTEM_PROMPT = `You are a web page classifier. Your job is to determine what type of content a page contains relative to a data collection goal. Respond with JSON only.`;

function buildClassificationPrompt(url: string, jobDescription: string, content: string): string {
  return `Classify this web page for data collection.

## Data Collection Goal
${jobDescription}

## Page URL
${url}

## Page Content
${content}

## Instructions
Classify this page into one of these categories:
- "single_entry": Detailed information about ONE item (e.g., product detail page)
- "multiple_entries": A list or grid of MULTIPLE items (e.g., category/listing page)
- "navigation": Category index or navigation page with links but little extractable data
- "irrelevant": No content relevant to the data collection goal
- "partial": Contains some relevant data but incomplete

Choose the extraction strategy:
- "full_extraction": For single_entry or partial pages with detailed data
- "list_extraction": For multiple_entries pages
- "links_only": For navigation pages (discover links to follow)
- "skip": For irrelevant pages

Respond with JSON:
{
  "classification": "single_entry|multiple_entries|navigation|irrelevant|partial",
  "strategy": "full_extraction|list_extraction|links_only|skip",
  "estimatedEntryCount": 1,
  "confidence": 0.95,
  "reasoning": "Brief explanation"
}`;
}
