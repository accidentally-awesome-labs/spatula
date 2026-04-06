// ---------------------------------------------------------------------------
// Declarative tier definitions for the Spatula CLI test runner
// ---------------------------------------------------------------------------
// Each tier declares the services it needs and the test globs it runs.
// Tiers can extend a parent, inheriting both services and globs.
// ---------------------------------------------------------------------------

export interface TierDefinition {
  name: string;
  description: string;
  extends?: string;
  services: string[];
  globs: string[];
  budgetCap?: number;
  skipIfMissing?: boolean;
}

export const TIERS: Record<string, TierDefinition> = {
  '1': {
    name: 'Local',
    description: 'Unit + integration + E2E (no external deps)',
    services: [],
    globs: [
      'tests/unit',
      'tests/integration',
      'tests/e2e/contracts-and-resilience.test.ts',
      'tests/e2e/resource-cleanup.test.ts',
      'tests/e2e/workflow.test.ts',
      'tests/e2e/tui-rendering.test.ts',
    ],
  },
  '2': {
    name: 'Mock LLM',
    description: 'Tier 1 + mock Ollama pipeline tests',
    extends: '1',
    services: [],
    globs: [
      'tests/e2e/tier2/pipeline-mock-llm.test.ts',
      'tests/e2e/tier2/pipeline-errors.test.ts',
      'tests/e2e/tier2/conversation.test.ts',
    ],
  },
  '3': {
    name: 'Real LLM',
    description: 'Tier 2 + real Ollama',
    extends: '2',
    services: ['ollama'],
    globs: ['tests/e2e/tier2/pipeline-real-llm.test.ts'],
  },
  '4': {
    name: 'Cloud APIs + Server',
    description: 'Tier 3 + OpenRouter + Firecrawl + API server',
    extends: '3',
    services: ['ollama', 'docker-postgres', 'docker-redis', 'openrouter', 'firecrawl'],
    globs: ['tests/e2e/tier4/'],
    budgetCap: 0.50,
    skipIfMissing: true,
  },
  '5a': {
    name: 'Queue/Worker Integration',
    description: 'Tier 4 + BullMQ workers processing jobs end-to-end',
    extends: '4',
    services: ['ollama', 'docker-postgres', 'docker-redis'],
    globs: ['tests/e2e/tier5/tier5a/'],
  },
  ci: {
    name: 'CI',
    description: 'Deterministic tests only (Tier 2)',
    extends: '2',
    services: [],
    globs: [], // Empty = inherit all from parent, add nothing
  },
  binary: {
    name: 'CLI Binary',
    description: 'CLI subprocess tests',
    services: [],
    globs: ['tests/e2e/cli-binary.test.ts'],
  },
  all: {
    name: 'All',
    description: 'Everything except binary',
    extends: '3',
    services: [],
    globs: ['tests/e2e/tier4/'],
  },
};

/**
 * Recursively resolve the full list of test globs for a tier,
 * including all inherited globs from parent tiers.
 */
export function resolveGlobs(tierKey: string): string[] {
  const tier = TIERS[tierKey];
  if (!tier) return [];
  const parentGlobs = tier.extends ? resolveGlobs(tier.extends) : [];
  return [...parentGlobs, ...tier.globs];
}

/**
 * Recursively resolve the full set of services for a tier,
 * including all inherited services from parent tiers. Deduplicates.
 */
export function resolveServices(tierKey: string): string[] {
  const tier = TIERS[tierKey];
  if (!tier) return [];
  const parentServices = tier.extends ? resolveServices(tier.extends) : [];
  return [...new Set([...parentServices, ...tier.services])];
}
