// packages/core/src/config/diff-types.ts
import type { FieldDefinitionOutput } from '../types/schema.js';

export interface PropertyChange {
  property: string; // 'type', 'required', 'selector', 'description'
  from: unknown;
  to: unknown;
  nestedChanges?: PropertyChange[];
  addedFields?: string[];
  removedFields?: string[];
}

/**
 * Describes how a field was modified between config snapshots.
 */
export interface FieldChange {
  name: string;
  changes: PropertyChange[];
}

/**
 * Potential field rename detected by heuristic (same type, removed + added).
 * The caller decides whether to treat as rename or as remove + add.
 *
 * Note: Spec section 6.3 calls this `fieldsRenamed`, but these are CANDIDATES
 * that require user confirmation (spec section 6.5). The CLI prompt converts
 * confirmed renames into actual field renames. Unconfirmed ones revert to
 * fieldsAdded + fieldsRemoved.
 */
export interface PotentialRename {
  from: string;
  to: string;
  type: string;
}

/**
 * Computed impact of config changes — what work needs to happen.
 */
export interface DiffImpact {
  newTasksToEnqueue: number;
  pagesNeedingReextraction: number | null; // null = needs DB query
  reextractionCostEstimate: number;
  failedTasksToRetry: number | null; // null = needs DB query
  skippedTasksToReenqueue: number | null; // null = needs DB query
  forceFullReconciliation: boolean;
}

/**
 * Full diff between two JobConfig snapshots.
 *
 * Named JobConfigDiff (not ConfigDiff) to avoid collision with the existing
 * ConfigDiff type in interfaces/config-executor.ts, which tracks generic
 * path-based config changes. This type is the richer diff engine result
 * used by the LocalPipelineRunner for re-run impact analysis.
 */
export interface JobConfigDiff {
  hasChanges: boolean;

  // Seeds
  seedsAdded: string[];
  seedsRemoved: string[];

  // Schema fields
  fieldsAdded: FieldDefinitionOutput[];
  fieldsRemoved: string[];
  fieldsModified: FieldChange[];
  potentialRenames: PotentialRename[];
  schemaModeChanged?: { from: string; to: string };

  // Crawl settings
  crawlChanged: {
    maxDepth?: { from: number; to: number };
    maxPages?: { from: number; to: number };
    concurrency?: { from: number; to: number };
    crawlerType?: { from: string; to: string };
    proxyChanged: boolean;
    cookiesChanged: boolean;
    // Note: robotsTxtToggled is not detectable from JobConfig alone —
    // it lives in GlobalConfig.politeness.respectRobotsTxt (or SpatulaYaml.crawl).
    // The LocalPipelineRunner must detect this from the SpatulaYaml diff, not
    // from diffConfigs(). When detected, set skippedTasksToReenqueue = null.
  };

  // Other
  llmChanged: boolean;
  reconciliationChanged: boolean;
  safetyChanged: boolean;

  // Derived work
  impact: DiffImpact;
}
