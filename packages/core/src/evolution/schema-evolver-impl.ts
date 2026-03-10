import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import type { PipelineAction } from '../types/actions.js';
import type { SchemaEvolver } from '../interfaces/schema-evolver.js';
import { aggregateUnmappedFields } from './unmapped-aggregator.js';
import { FieldProposer } from './field-proposer.js';
import { SynonymDetector } from './synonym-detector.js';
import { NormalizationProposer } from './normalization-proposer.js';

const logger = createLogger('schema-evolver');

/**
 * Full pipeline orchestrator for schema evolution.
 *
 * Given a current schema and recent extractions, runs three analyzers in
 * parallel — field proposal, synonym detection, and normalization — then
 * combines the resulting actions into a single ordered list.
 */
export class SchemaEvolverImpl implements SchemaEvolver {
  private readonly fieldProposer: FieldProposer;
  private readonly synonymDetector: SynonymDetector;
  private readonly normalizationProposer: NormalizationProposer;

  constructor(
    llmClient: LLMClient,
    config: LLMConfig,
  ) {
    this.fieldProposer = new FieldProposer(llmClient, config);
    this.synonymDetector = new SynonymDetector(llmClient, config);
    this.normalizationProposer = new NormalizationProposer(llmClient, config);
  }

  async evolve(
    currentSchema: SchemaDefinition,
    recentExtractions: ExtractionResult[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    // Step 1: Aggregate unmapped fields from recent extractions
    const aggregated = aggregateUnmappedFields(recentExtractions);

    logger.debug(
      { aggregatedCount: aggregated.length, extractionCount: recentExtractions.length },
      'aggregated unmapped fields for schema evolution',
    );

    // Step 2: Run all three analyzers in parallel
    const [fieldActions, synonymActions, normActions] = await Promise.all([
      this.fieldProposer.propose(currentSchema, aggregated, jobDescription),
      this.synonymDetector.detect(currentSchema, aggregated, jobDescription),
      this.normalizationProposer.propose(currentSchema, recentExtractions, jobDescription),
    ]);

    // Step 3: Combine all actions
    const allActions = [...fieldActions, ...synonymActions, ...normActions];

    // Step 4: Log summary
    logger.info(
      {
        fieldProposals: fieldActions.length,
        synonymMerges: synonymActions.length,
        normRules: normActions.length,
        total: allActions.length,
      },
      'schema evolution pipeline complete',
    );

    return allActions;
  }
}
