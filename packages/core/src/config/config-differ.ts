// packages/core/src/config/config-differ.ts
import { diffSeeds } from './url-normalizer.js';
import type { JobConfig } from '../types/job.js';
import type { FieldDefinitionOutput } from '../types/schema.js';
import type { JobConfigDiff, FieldChange, PotentialRename, DiffImpact } from './diff-types.js';

/**
 * Compare two JobConfig objects and produce a JobConfigDiff.
 *
 * @param current  The config from the current spatula.yaml
 * @param previous The config snapshot from the last completed/paused run
 * @returns JobConfigDiff with categorized changes and computed impact
 */
export function diffConfigs(current: JobConfig, previous: JobConfig): JobConfigDiff {
  // Seeds
  const { added: seedsAdded, removed: seedsRemoved } = diffSeeds(
    current.seedUrls,
    previous.seedUrls,
  );

  // Schema fields
  const currentFields = current.schema.userFields ?? [];
  const previousFields = previous.schema.userFields ?? [];
  const { added: fieldsAdded, removed: fieldsRemoved, modified: fieldsModified, renames: potentialRenames } =
    diffFields(currentFields, previousFields);

  // Schema mode
  const schemaModeChanged =
    current.schema.mode !== previous.schema.mode
      ? { from: previous.schema.mode, to: current.schema.mode }
      : undefined;

  // Crawl settings
  const crawlChanged = diffCrawlSettings(current, previous);

  // LLM
  const llmChanged =
    current.llm.primaryModel !== previous.llm.primaryModel ||
    JSON.stringify(current.llm.modelOverrides) !== JSON.stringify(previous.llm.modelOverrides);

  // Reconciliation
  const reconciliationChanged =
    JSON.stringify(current.reconciliation) !== JSON.stringify(previous.reconciliation);

  // Safety (compared via name/description as proxy since safetyPreset isn't in JobConfig)
  const safetyChanged = false; // Safety is not in JobConfig — always false for now

  // Check if anything changed
  // safetyChanged is always false today but is included here so that when
  // safety detection is implemented (Phase 13 Step 4), hasChanges automatically
  // reflects it without a latent bug lurking.
  const hasChanges =
    seedsAdded.length > 0 ||
    seedsRemoved.length > 0 ||
    fieldsAdded.length > 0 ||
    fieldsRemoved.length > 0 ||
    fieldsModified.length > 0 ||
    potentialRenames.length > 0 ||
    schemaModeChanged !== undefined ||
    crawlChanged.maxDepth !== undefined ||
    crawlChanged.maxPages !== undefined ||
    crawlChanged.concurrency !== undefined ||
    crawlChanged.crawlerType !== undefined ||
    crawlChanged.proxyChanged ||
    crawlChanged.cookiesChanged ||
    llmChanged ||
    reconciliationChanged ||
    safetyChanged;

  // Compute impact
  const impact = computeImpact({
    seedsAdded,
    fieldsAdded,
    fieldsModified,
    crawlChanged,
    reconciliationChanged,
  });

  return {
    hasChanges,
    seedsAdded,
    seedsRemoved,
    fieldsAdded,
    fieldsRemoved,
    fieldsModified,
    potentialRenames,
    schemaModeChanged,
    crawlChanged,
    llmChanged,
    reconciliationChanged,
    safetyChanged,
    impact,
  };
}

function diffFields(
  current: FieldDefinitionOutput[],
  previous: FieldDefinitionOutput[],
): {
  added: FieldDefinitionOutput[];
  removed: string[];
  modified: FieldChange[];
  renames: PotentialRename[];
} {
  const currentByName = new Map(current.map((f) => [f.name, f]));
  const previousByName = new Map(previous.map((f) => [f.name, f]));

  const added: FieldDefinitionOutput[] = [];
  const removed: string[] = [];
  const modified: FieldChange[] = [];

  // Find added and modified
  for (const [name, field] of currentByName) {
    const prev = previousByName.get(name);
    if (!prev) {
      added.push(field);
    } else {
      const changes = diffFieldProperties(field, prev);
      if (changes.length > 0) {
        modified.push({ name, changes });
      }
    }
  }

  // Find removed
  for (const name of previousByName.keys()) {
    if (!currentByName.has(name)) {
      removed.push(name);
    }
  }

  // Detect potential renames: one removed + one added with same type.
  // Built in a separate pass to avoid splice-during-iteration bugs.
  //
  // Note: Matching is greedy and order-dependent when multiple fields share
  // the same type. The first removed field of a given type claims the first
  // added field of that type. This is acceptable because these are only
  // potential rename candidates requiring user confirmation — the user can
  // reject a wrong match and it reverts to a normal add + remove.
  const renames: PotentialRename[] = [];
  const usedAdded = new Set<string>();
  const usedRemoved = new Set<string>();

  if (added.length > 0 && removed.length > 0) {
    for (const removedName of removed) {
      const removedField = previousByName.get(removedName)!;
      for (const addedField of added) {
        if (usedAdded.has(addedField.name)) continue;
        if (addedField.type === removedField.type) {
          renames.push({
            from: removedName,
            to: addedField.name,
            type: addedField.type,
          });
          usedAdded.add(addedField.name);
          usedRemoved.add(removedName);
          break; // One rename per removed field
        }
      }
    }

    // Filter out matched entries from added/removed
    const filteredAdded = added.filter((f) => !usedAdded.has(f.name));
    const filteredRemoved = removed.filter((n) => !usedRemoved.has(n));
    added.length = 0;
    added.push(...filteredAdded);
    removed.length = 0;
    removed.push(...filteredRemoved);
  }

  return { added, removed, modified, renames };
}

function diffFieldProperties(
  current: FieldDefinitionOutput,
  previous: FieldDefinitionOutput,
): Array<{ property: string; from: unknown; to: unknown }> {
  const changes: Array<{ property: string; from: unknown; to: unknown }> = [];

  if (current.type !== previous.type) {
    changes.push({ property: 'type', from: previous.type, to: current.type });
  }
  if (current.required !== previous.required) {
    changes.push({ property: 'required', from: previous.required, to: current.required });
  }
  if (current.description !== previous.description) {
    changes.push({ property: 'description', from: previous.description, to: current.description });
  }
  if (JSON.stringify(current.enumValues) !== JSON.stringify(previous.enumValues)) {
    changes.push({ property: 'enumValues', from: previous.enumValues, to: current.enumValues });
  }
  if (JSON.stringify(current.normalization) !== JSON.stringify(previous.normalization)) {
    changes.push({ property: 'normalization', from: previous.normalization, to: current.normalization });
  }
  // TODO: recursive comparison for objectFields and arrayItemType

  return changes;
}

function diffCrawlSettings(
  current: JobConfig,
  previous: JobConfig,
): JobConfigDiff['crawlChanged'] {
  return {
    maxDepth:
      current.crawl.maxDepth !== previous.crawl.maxDepth
        ? { from: previous.crawl.maxDepth, to: current.crawl.maxDepth }
        : undefined,
    maxPages:
      current.crawl.maxPages !== previous.crawl.maxPages
        ? { from: previous.crawl.maxPages, to: current.crawl.maxPages }
        : undefined,
    concurrency:
      current.crawl.concurrency !== previous.crawl.concurrency
        ? { from: previous.crawl.concurrency, to: current.crawl.concurrency }
        : undefined,
    crawlerType:
      current.crawl.crawlerType !== previous.crawl.crawlerType
        ? { from: previous.crawl.crawlerType, to: current.crawl.crawlerType }
        : undefined,
    proxyChanged:
      JSON.stringify(current.crawl.proxy) !== JSON.stringify(previous.crawl.proxy),
    cookiesChanged:
      JSON.stringify(current.crawl.cookies) !== JSON.stringify(previous.crawl.cookies),
  };
}

function computeImpact(context: {
  seedsAdded: string[];
  fieldsAdded: FieldDefinitionOutput[];
  fieldsModified: FieldChange[];
  crawlChanged: JobConfigDiff['crawlChanged'];
  reconciliationChanged: boolean;
}): DiffImpact {
  const needsReextraction =
    context.fieldsAdded.length > 0 ||
    context.fieldsModified.some((f) =>
      f.changes.some((c) => c.property === 'type' || c.property === 'normalization'),
      // Note: 'selector' changes are not detectable here because selectors
      // are not carried through to FieldDefinitionOutput/JobConfig.
      // See design note above about selector change detection.
    );

  return {
    newTasksToEnqueue: context.seedsAdded.length,
    // null = needs DB query from caller (LocalPipelineRunner)
    // 0 = definitively no work needed
    pagesNeedingReextraction: needsReextraction ? null : 0,
    reextractionCostEstimate: 0, // Computed by caller using estimateCost()
    failedTasksToRetry: context.crawlChanged.proxyChanged || context.crawlChanged.cookiesChanged ? null : 0,
    skippedTasksToReenqueue: null, // Always needs DB query (robots.txt toggle detected externally)
    forceFullReconciliation: context.reconciliationChanged,
  };
}
