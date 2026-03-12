import type { ConfigAction } from '../types/config-actions.js';
import type { JobConfig } from '../types/job.js';
import type {
  ConfigExecutor,
  ConfigValidationResult,
  ConfigDiff,
} from '../interfaces/config-executor.js';
import type { FieldDefinition } from '../types/schema.js';

/**
 * Default implementation of ConfigExecutor that handles all 30 ConfigAction types.
 *
 * Every `apply` call uses `structuredClone` to guarantee immutability of the
 * input config. No-op actions (templates, approval policy, confirm_and_start,
 * clone) return the clone unchanged.
 */
export class DefaultConfigExecutor implements ConfigExecutor {
  apply(config: JobConfig, action: ConfigAction): JobConfig {
    const next = structuredClone(config);
    return this.applyMut(next, action);
  }

  applyBatch(config: JobConfig, actions: ConfigAction[]): JobConfig {
    let current = structuredClone(config);
    for (const action of actions) {
      current = this.applyMut(current, action);
    }
    return current;
  }

  validate(config: JobConfig): ConfigValidationResult {
    const missing: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (!config.name || config.name.trim() === '') {
      missing.push('name');
    }

    if (config.seedUrls.length === 0) {
      missing.push('seedUrls');
    }

    if (!config.description || config.description.trim() === '') {
      warnings.push('No description set — consider adding one for documentation.');
    }

    if (!config.schema.userFields || config.schema.userFields.length === 0) {
      warnings.push('No user fields defined — the schema has no extraction targets.');
    }

    if (!config.reconciliation) {
      suggestions.push('Consider configuring reconciliation settings for multi-source crawls.');
    }

    return {
      valid: missing.length === 0,
      missing,
      warnings,
      suggestions,
    };
  }

  diff(before: JobConfig, after: JobConfig): ConfigDiff {
    const changes: ConfigDiff['changes'] = [];

    // Top-level scalar fields
    if (before.name !== after.name) {
      changes.push({
        path: 'name',
        before: before.name,
        after: after.name,
        description: `Job name changed from "${before.name}" to "${after.name}"`,
      });
    }

    if (before.description !== after.description) {
      changes.push({
        path: 'description',
        before: before.description,
        after: after.description,
        description: `Job description changed`,
      });
    }

    // Seed URLs
    if (!arraysEqual(before.seedUrls, after.seedUrls)) {
      changes.push({
        path: 'seedUrls',
        before: before.seedUrls,
        after: after.seedUrls,
        description: `Seed URLs changed (${before.seedUrls.length} → ${after.seedUrls.length})`,
      });
    }

    // Crawl settings
    this.diffCrawl(before, after, changes);

    // Schema
    this.diffSchema(before, after, changes);

    // LLM config
    this.diffLLM(before, after, changes);

    // Reconciliation
    if (!deepEqual(before.reconciliation, after.reconciliation)) {
      changes.push({
        path: 'reconciliation',
        before: before.reconciliation,
        after: after.reconciliation,
        description: 'Reconciliation config changed',
      });
    }

    return { changes };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply an action to a config that is already a mutable clone.
   * This avoids double-cloning in `applyBatch`.
   */
  private applyMut(config: JobConfig, action: ConfigAction): JobConfig {
    switch (action.type) {
      // --- Metadata ---
      case 'set_job_name':
        config.name = action.payload.name;
        break;

      case 'set_job_description':
        config.description = action.payload.description;
        break;

      // --- Seed URLs ---
      case 'add_seed_urls': {
        const existing = new Set(config.seedUrls);
        for (const entry of action.payload.urls) {
          if (!existing.has(entry.url)) {
            config.seedUrls.push(entry.url);
            existing.add(entry.url);
          }
        }
        break;
      }

      case 'remove_seed_urls': {
        const toRemove = new Set(action.payload.urls);
        config.seedUrls = config.seedUrls.filter((u) => !toRemove.has(u));
        break;
      }

      case 'replace_seed_urls':
        config.seedUrls = action.payload.urls.map((u) => u.url);
        break;

      // --- Crawl Settings ---
      case 'set_crawl_depth':
        config.crawl.maxDepth = action.payload.maxDepth;
        break;

      case 'set_max_pages':
        config.crawl.maxPages = action.payload.maxPages;
        break;

      case 'set_concurrency':
        config.crawl.concurrency = action.payload.concurrency;
        break;

      case 'set_crawler_type':
        config.crawl.crawlerType = action.payload.crawlerType;
        break;

      // --- Schema Fields ---
      case 'add_user_field': {
        const fields = config.schema.userFields ?? [];
        const field = action.payload.field as FieldDefinition;
        const position = action.payload.position ?? 'last';

        if (position === 'first') {
          fields.unshift(field);
        } else if (position === 'after' && action.payload.afterField) {
          const idx = fields.findIndex((f) => f.name === action.payload.afterField);
          if (idx >= 0) {
            fields.splice(idx + 1, 0, field);
          } else {
            fields.push(field);
          }
        } else {
          // 'last' or fallback
          fields.push(field);
        }
        config.schema.userFields = fields;
        break;
      }

      case 'add_multiple_user_fields': {
        const fields = config.schema.userFields ?? [];
        for (const field of action.payload.fields as FieldDefinition[]) {
          fields.push(field);
        }
        config.schema.userFields = fields;
        break;
      }

      case 'remove_user_field': {
        if (config.schema.userFields) {
          config.schema.userFields = config.schema.userFields.filter(
            (f) => f.name !== action.payload.fieldName,
          );
        }
        break;
      }

      case 'modify_user_field': {
        if (config.schema.userFields) {
          const field = config.schema.userFields.find(
            (f) => f.name === action.payload.fieldName,
          );
          if (field) {
            const changes = action.payload.changes;
            if (changes.name !== undefined) field.name = changes.name;
            if (changes.description !== undefined) field.description = changes.description;
            if (changes.type !== undefined) field.type = changes.type;
            if (changes.required !== undefined) field.required = changes.required;
            if (changes.enumValues !== undefined) field.enumValues = changes.enumValues;
            if (changes.arrayItemType !== undefined) {
              field.arrayItemType = changes.arrayItemType as FieldDefinition;
            }
            if (changes.objectFields !== undefined) {
              field.objectFields = changes.objectFields as FieldDefinition[];
            }
          }
        }
        break;
      }

      case 'reorder_user_fields': {
        if (config.schema.userFields) {
          const byName = new Map<string, FieldDefinition>();
          for (const f of config.schema.userFields) {
            byName.set(f.name, f);
          }
          const reordered: FieldDefinition[] = [];
          for (const name of action.payload.fieldOrder) {
            const f = byName.get(name);
            if (f) {
              reordered.push(f);
              byName.delete(name);
            }
          }
          // Append any fields not in the order list at the end
          for (const f of byName.values()) {
            reordered.push(f);
          }
          config.schema.userFields = reordered;
        }
        break;
      }

      case 'replace_all_user_fields':
        config.schema.userFields = action.payload.fields as FieldDefinition[];
        break;

      case 'define_nested_field': {
        if (config.schema.userFields) {
          const parent = config.schema.userFields.find(
            (f) => f.name === action.payload.parentFieldName,
          );
          if (parent) {
            parent.objectFields = action.payload.subFields as FieldDefinition[];
          }
        }
        break;
      }

      // --- Schema Mode ---
      case 'set_schema_mode':
        config.schema.mode = action.payload.mode;
        break;

      case 'set_evolution_config': {
        const existing = config.schema.evolutionConfig;
        const payload = action.payload;

        if (existing) {
          // Merge with existing
          if (payload.enabled !== undefined) existing.enabled = payload.enabled;
          if (payload.batchSize !== undefined) existing.batchSize = payload.batchSize;
          if (payload.maxFields !== undefined) existing.maxFields = payload.maxFields;
          if (payload.tableStrategy !== undefined) existing.tableStrategy = payload.tableStrategy;
          if (payload.relevanceThresholds) {
            existing.relevanceThresholds = {
              ...existing.relevanceThresholds,
              ...payload.relevanceThresholds,
            };
          }
        } else {
          // Create with defaults, then apply payload
          config.schema.evolutionConfig = {
            enabled: payload.enabled ?? false,
            batchSize: payload.batchSize ?? 10,
            maxFields: payload.maxFields ?? 50,
            relevanceThresholds: {
              requiredMin: 0.85,
              optionalMin: 0.4,
              rareBelow: 0.4,
              minCategorySampleSize: 5,
              ...(payload.relevanceThresholds ?? {}),
            },
            tableStrategy: payload.tableStrategy ?? 'auto',
          };
        }
        break;
      }

      // --- LLM Config ---
      case 'set_primary_model':
        config.llm.primaryModel = action.payload.model;
        break;

      case 'set_model_override': {
        const overrides = config.llm.modelOverrides ?? {};
        overrides[action.payload.task] = action.payload.model;
        config.llm.modelOverrides = overrides;
        break;
      }

      case 'clear_model_override': {
        if (config.llm.modelOverrides) {
          delete config.llm.modelOverrides[action.payload.task];
        }
        break;
      }

      // --- Reconciliation Config ---
      case 'set_match_strategy': {
        const recon = this.ensureReconciliation(config);
        recon.matchStrategy = action.payload.matchStrategy;
        if (action.payload.fuzzyMatchThreshold !== undefined) {
          recon.fuzzyMatchThreshold = action.payload.fuzzyMatchThreshold;
        }
        if (action.payload.enableLLMMatching !== undefined) {
          recon.enableLLMMatching = action.payload.enableLLMMatching;
        }
        break;
      }

      case 'set_conflict_resolution': {
        const recon = this.ensureReconciliation(config);
        recon.conflictResolution = action.payload.strategy;
        break;
      }

      case 'set_source_priority': {
        const recon = this.ensureReconciliation(config);
        recon.sourcePriority = action.payload.rankings.map((r) => r.domain);
        break;
      }

      // --- Safety (no-op) ---
      case 'set_action_approval_policy':
        break;

      // --- Templates (no-op) ---
      case 'save_as_template':
      case 'load_template':
      case 'clone_job_config':
        break;

      // --- Control ---
      case 'confirm_and_start':
        // No-op — handled at orchestration layer
        break;

      case 'reset_config': {
        const keepFields = action.payload.keepFields ?? [];
        const keepSet = new Set(keepFields);
        const tenantId = config.tenantId;

        const resetName = keepSet.has('name') ? config.name : '';
        const resetDescription = keepSet.has('description') ? config.description : '';
        const resetSeedUrls = keepSet.has('seedUrls') ? config.seedUrls : [];
        const resetUserFields = keepSet.has('userFields') ? config.schema.userFields : undefined;
        const resetCrawl = keepSet.has('crawlSettings')
          ? config.crawl
          : { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const };
        const resetLlm = keepSet.has('llmConfig')
          ? config.llm
          : { primaryModel: 'anthropic/claude-sonnet-4-20250514' };

        config.tenantId = tenantId;
        config.name = resetName;
        config.description = resetDescription;
        config.seedUrls = resetSeedUrls;
        config.crawl = resetCrawl;
        config.schema = {
          mode: 'discovery',
          userFields: resetUserFields,
        };
        config.llm = resetLlm;
        config.reconciliation = undefined;
        break;
      }

      default: {
        // Exhaustive check
        const _exhaustive: never = action;
        throw new Error(`Unknown config action type: ${(_exhaustive as ConfigAction).type}`);
      }
    }

    return config;
  }

  /**
   * Ensure reconciliation config exists with sensible defaults, returning
   * the (mutable) reference.
   */
  private ensureReconciliation(config: JobConfig) {
    if (!config.reconciliation) {
      config.reconciliation = {
        matchStrategy: 'composite_key',
        conflictResolution: 'most_complete',
        fuzzyMatchThreshold: 0.85,
        enableLLMMatching: true,
      };
    }
    return config.reconciliation;
  }

  // --- Diff helpers ---

  private diffCrawl(
    before: JobConfig,
    after: JobConfig,
    changes: ConfigDiff['changes'],
  ) {
    const crawlKeys = ['maxDepth', 'maxPages', 'concurrency', 'crawlerType'] as const;
    for (const key of crawlKeys) {
      if (before.crawl[key] !== after.crawl[key]) {
        changes.push({
          path: `crawl.${key}`,
          before: before.crawl[key],
          after: after.crawl[key],
          description: `Crawl ${key} changed from ${String(before.crawl[key])} to ${String(after.crawl[key])}`,
        });
      }
    }
  }

  private diffSchema(
    before: JobConfig,
    after: JobConfig,
    changes: ConfigDiff['changes'],
  ) {
    if (before.schema.mode !== after.schema.mode) {
      changes.push({
        path: 'schema.mode',
        before: before.schema.mode,
        after: after.schema.mode,
        description: `Schema mode changed from "${before.schema.mode}" to "${after.schema.mode}"`,
      });
    }

    if (!deepEqual(before.schema.userFields, after.schema.userFields)) {
      changes.push({
        path: 'schema.userFields',
        before: before.schema.userFields,
        after: after.schema.userFields,
        description: 'Schema user fields changed',
      });
    }

    if (!deepEqual(before.schema.evolutionConfig, after.schema.evolutionConfig)) {
      changes.push({
        path: 'schema.evolutionConfig',
        before: before.schema.evolutionConfig,
        after: after.schema.evolutionConfig,
        description: 'Schema evolution config changed',
      });
    }
  }

  private diffLLM(
    before: JobConfig,
    after: JobConfig,
    changes: ConfigDiff['changes'],
  ) {
    if (before.llm.primaryModel !== after.llm.primaryModel) {
      changes.push({
        path: 'llm.primaryModel',
        before: before.llm.primaryModel,
        after: after.llm.primaryModel,
        description: `Primary model changed from "${before.llm.primaryModel}" to "${after.llm.primaryModel}"`,
      });
    }

    if (!deepEqual(before.llm.modelOverrides, after.llm.modelOverrides)) {
      changes.push({
        path: 'llm.modelOverrides',
        before: before.llm.modelOverrides,
        after: after.llm.modelOverrides,
        description: 'LLM model overrides changed',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, i) => val === b[i]);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keysA = Object.keys(aObj);
    const keysB = Object.keys(bObj);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
