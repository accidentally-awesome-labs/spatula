import { basename } from 'node:path';
import { expandFieldShorthand } from './yaml-parser.js';
import type { SpatulaYaml, GlobalConfig, CliFlags } from './types.js';
import type { JobConfig } from '../types/job.js';
import type { FieldDefinitionOutput } from '../types/schema.js';

export interface YamlToJobConfigOptions {
  tenantId: string;
  projectId: string;
  projectRoot: string;
  globalConfig?: GlobalConfig | null;
  cliFlags?: CliFlags;
}

/**
 * Convert a parsed SpatulaYaml + optional global config + optional CLI flags
 * into a fully resolved JobConfig.
 *
 * Resolution order (highest priority wins):
 *   Built-in defaults -> Global config -> Project YAML -> CLI flags
 */
export function yamlToJobConfig(
  yaml: SpatulaYaml,
  options: YamlToJobConfigOptions,
): JobConfig {
  const { tenantId, projectRoot, globalConfig, cliFlags } = options;

  // Resolve crawler type: CLI > project > global > default
  const crawlerType =
    cliFlags?.crawler ??
    yaml.crawler ??
    globalConfig?.crawler ??
    'playwright';

  // Resolve LLM model: CLI > project > global > default
  const primaryModel =
    cliFlags?.model ??
    yaml.llm?.model ??
    globalConfig?.llm?.model ??
    'anthropic/claude-sonnet-4-20250514';

  // Resolve depth/limit: CLI > project > default
  const maxDepth = cliFlags?.depth ?? yaml.depth ?? 2;
  const maxPages = cliFlags?.limit ?? yaml.limit ?? 1000;
  const concurrency = cliFlags?.concurrency ?? yaml.crawl?.concurrency ?? 5;

  // Expand field shorthand into FieldDefinitionOutput[].
  // expandFieldShorthand returns basic fields (name, type, description, required)
  // which are a valid subset of FieldDefinitionOutput (other fields are optional).
  const userFields: FieldDefinitionOutput[] | undefined = yaml.fields?.map((f) => {
    const expanded = expandFieldShorthand(f);
    return {
      name: expanded.name,
      type: expanded.type,
      description: expanded.description,
      required: expanded.required ?? false,
    };
  });

  // Determine schema mode: explicit > inferred from fields
  const schemaMode = yaml.schema?.mode ?? (userFields?.length ? 'hybrid' : 'discovery');

  // Derive name from project root if not specified
  const name = yaml.name ?? basename(projectRoot);
  const description = yaml.description ?? `Crawl data from ${yaml.seeds[0]}`;

  const config: JobConfig = {
    tenantId,
    name,
    description,
    seedUrls: yaml.seeds,
    crawl: {
      maxDepth,
      maxPages,
      concurrency,
      crawlerType,
      proxy: yaml.crawl?.proxy,
      cookies: yaml.crawl?.cookies?.map((c) => ({
        ...c,
        path: c.path ?? '/',
      })),
    },
    schema: {
      mode: schemaMode,
      userFields,
      evolutionConfig: yaml.schema?.evolution
        ? {
            enabled: true,
            batchSize: yaml.schema.evolution.batchSize ?? 10,
            maxFields: yaml.schema.evolution.maxFields ?? 50,
            tableStrategy: 'auto' as const,
            relevanceThresholds: {
              requiredMin: 0.85,
              optionalMin: 0.4,
              rareBelow: 0.4,
              minCategorySampleSize: 5,
            },
          }
        : undefined,
    },
    llm: {
      primaryModel,
      modelOverrides: yaml.llm?.overrides,
    },
    reconciliation: yaml.reconciliation
      ? {
          matchStrategy: yaml.reconciliation.strategy ?? 'composite_key',
          conflictResolution: yaml.reconciliation.conflictResolution ?? 'most_complete',
          fuzzyMatchThreshold: yaml.reconciliation.fuzzyThreshold ?? 0.85,
          enableLLMMatching: true,
        }
      : undefined,
  };

  return config;
}
