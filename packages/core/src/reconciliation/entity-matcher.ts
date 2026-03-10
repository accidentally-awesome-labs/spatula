import { z } from 'zod';
import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import { resolveModel } from '../llm/model-router.js';
import type { ExtractionResult } from '../types/extraction.js';

const logger = createLogger('entity-matcher');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionWithSource extends ExtractionResult {
  sourceUrl: string;
  sourceDomain: string;
  crawledAt: Date;
}

// ---------------------------------------------------------------------------
// Union-Find with path compression
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(private readonly size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array(size).fill(0);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(x: number, y: number): void {
    const rootX = this.find(x);
    const rootY = this.find(y);

    if (rootX === rootY) return;

    // union by rank
    if (this.rank[rootX] < this.rank[rootY]) {
      this.parent[rootX] = rootY;
    } else if (this.rank[rootX] > this.rank[rootY]) {
      this.parent[rootY] = rootX;
    } else {
      this.parent[rootY] = rootX;
      this.rank[rootX]++;
    }
  }

  groups(): number[][] {
    const groupMap = new Map<number, number[]>();
    for (let i = 0; i < this.size; i++) {
      const root = this.find(i);
      let group = groupMap.get(root);
      if (!group) {
        group = [];
        groupMap.set(root, group);
      }
      group.push(i);
    }
    return Array.from(groupMap.values());
  }
}

// ---------------------------------------------------------------------------
// normalizeKeyValue
// ---------------------------------------------------------------------------

export function normalizeKeyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.toLowerCase().trim();
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// matchEntitiesExact
// ---------------------------------------------------------------------------

/**
 * Groups extractions where all key field values match exactly.
 *
 * - Case-insensitive for string values
 * - Build a composite key from all keyFields joined by `\0`
 * - Extractions with missing/null/undefined key field values get their own
 *   unique key (won't match anything)
 */
export function matchEntitiesExact(
  extractions: ExtractionWithSource[],
  keyFields: string[],
): ExtractionWithSource[][] {
  if (extractions.length === 0) return [];

  const groupMap = new Map<string, ExtractionWithSource[]>();
  let missingCounter = 0;

  for (const extraction of extractions) {
    const hasMissing = keyFields.some((field) => {
      const val = extraction.data[field];
      return val === null || val === undefined;
    });

    let compositeKey: string;

    if (hasMissing) {
      // Unique key so it won't match anything
      compositeKey = `__missing__${missingCounter++}`;
    } else {
      compositeKey = keyFields.map((field) => normalizeKeyValue(extraction.data[field])).join('\0');
    }

    let group = groupMap.get(compositeKey);
    if (!group) {
      group = [];
      groupMap.set(compositeKey, group);
    }
    group.push(extraction);
  }

  return Array.from(groupMap.values());
}

// ---------------------------------------------------------------------------
// matchEntitiesCompositeKey
// ---------------------------------------------------------------------------

/**
 * Groups extractions using composite key matching with partial overlap.
 *
 * - Two extractions match if `matchingKeys / comparableKeys >= threshold`
 * - A key is "comparable" if at least one of the two extractions has a
 *   non-empty value for it
 * - A key "matches" if both have non-empty values and they're equal
 *   (case-insensitive for strings)
 * - If both are empty for a key, it's NOT comparable (skip)
 * - Uses union-find for transitive closure
 */
export function matchEntitiesCompositeKey(
  extractions: ExtractionWithSource[],
  keyFields: string[],
  threshold: number,
): ExtractionWithSource[][] {
  if (extractions.length === 0) return [];

  const n = extractions.length;
  const uf = new UnionFind(n);

  // Pre-compute normalized key values for each extraction
  const normalized: string[][] = extractions.map((ext) =>
    keyFields.map((field) => normalizeKeyValue(ext.data[field])),
  );

  // Compare all pairs
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let comparable = 0;
      let matching = 0;

      for (let k = 0; k < keyFields.length; k++) {
        const valI = normalized[i][k];
        const valJ = normalized[j][k];
        const emptyI = valI === '';
        const emptyJ = valJ === '';

        if (emptyI && emptyJ) {
          // Both empty → not comparable, skip
          continue;
        }

        comparable++;

        if (!emptyI && !emptyJ && valI === valJ) {
          matching++;
        }
      }

      if (comparable > 0 && matching / comparable >= threshold) {
        uf.union(i, j);
      }
    }
  }

  // Collect groups
  const indexGroups = uf.groups();
  return indexGroups.map((indices) => indices.map((i) => extractions[i]));
}

// ---------------------------------------------------------------------------
// levenshteinSimilarity
// ---------------------------------------------------------------------------

/**
 * Compute Levenshtein distance-based similarity (0–1) between two strings.
 *
 * - Case-insensitive (converts both to lowercase)
 * - Returns 1 for identical strings (including both empty)
 * - Returns 0 for completely different strings
 * - Formula: `1 - distance / Math.max(a.length, b.length)`
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();

  if (al === bl) return 1;
  if (al.length === 0 || bl.length === 0) return 0;

  const m = al.length;
  const n = bl.length;

  // Use two-row optimisation for O(min(m,n)) space
  let prev = Array.from<number>({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[n];
  return 1 - distance / Math.max(m, n);
}

// ---------------------------------------------------------------------------
// matchEntitiesFuzzy
// ---------------------------------------------------------------------------

/**
 * Groups extractions using fuzzy string matching across key fields.
 *
 * For each pair of extractions, computes average Levenshtein similarity across
 * all comparable key fields. A field is "comparable" if at least one of the two
 * extractions has a non-empty value for it. Both empty → skip (not comparable).
 * One-sided empty → comparable with 0 similarity.
 *
 * Uses union-find for transitive closure.
 */
export function matchEntitiesFuzzy(
  extractions: ExtractionWithSource[],
  keyFields: string[],
  threshold: number,
): ExtractionWithSource[][] {
  if (extractions.length === 0) return [];

  const n = extractions.length;
  const uf = new UnionFind(n);

  // Pre-compute normalized key values
  const normalized: string[][] = extractions.map((ext) =>
    keyFields.map((field) => normalizeKeyValue(ext.data[field])),
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let comparable = 0;
      let totalSimilarity = 0;

      for (let k = 0; k < keyFields.length; k++) {
        const valI = normalized[i][k];
        const valJ = normalized[j][k];
        const emptyI = valI === '';
        const emptyJ = valJ === '';

        if (emptyI && emptyJ) {
          // Both empty → not comparable, skip
          continue;
        }

        comparable++;

        if (emptyI || emptyJ) {
          // One-sided empty → comparable with 0 similarity
          // totalSimilarity += 0 (no-op)
        } else {
          totalSimilarity += levenshteinSimilarity(valI, valJ);
        }
      }

      if (comparable > 0 && totalSimilarity / comparable >= threshold) {
        uf.union(i, j);
      }
    }
  }

  const indexGroups = uf.groups();
  return indexGroups.map((indices) => indices.map((i) => extractions[i]));
}

// ---------------------------------------------------------------------------
// matchEntitiesLLM
// ---------------------------------------------------------------------------

const LLMMatchResponseSchema = z.object({
  groups: z.array(
    z.object({
      extractionIds: z.array(z.string()).min(1),
      reasoning: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/**
 * Uses an LLM to intelligently group extractions that refer to the same entity.
 *
 * Builds a prompt summarising each extraction (id, data, source domain) and
 * asks the LLM to return groups of matching extraction IDs.  The response is
 * validated with Zod; any extraction not covered by the LLM output is placed
 * in its own singleton group.
 *
 * Falls back to singleton groups on any error (LLM failure, invalid JSON,
 * validation failure).
 */
export async function matchEntitiesLLM(
  extractions: ExtractionWithSource[],
  llmClient: LLMClient,
  llmConfig: LLMConfig,
): Promise<ExtractionWithSource[][]> {
  if (extractions.length === 0) return [];

  const singletonFallback = (): ExtractionWithSource[][] => extractions.map((e) => [e]);

  try {
    const model = resolveModel(llmConfig, 'entityMatching');

    const extractionSummaries = extractions.map((e) => ({
      id: e.id,
      data: e.data,
      sourceDomain: e.sourceDomain,
    }));

    const systemPrompt = [
      'You are an entity resolution expert. Your task is to identify which extractions refer to the same real-world entity.',
      'Respond with JSON matching this schema:',
      '{ "groups": [{ "extractionIds": string[], "reasoning": string, "confidence": number }] }',
      'Each extraction should appear in exactly one group. Group extractions that refer to the same entity together.',
      'Singletons (entities appearing only once) should still be in their own group.',
    ].join('\n');

    const userPrompt = [
      'Here are the extractions to group:',
      '',
      JSON.stringify(extractionSummaries, null, 2),
      '',
      'Return the groups as JSON.',
    ].join('\n');

    const response = await llmClient.complete({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      jsonMode: true,
      temperature: 0,
    });

    const parsed = JSON.parse(response.content);
    const validated = LLMMatchResponseSchema.parse(parsed);

    // Build an index of extraction id → ExtractionWithSource for quick lookup
    const extractionMap = new Map<string, ExtractionWithSource>();
    for (const e of extractions) {
      extractionMap.set(e.id, e);
    }

    const coveredIds = new Set<string>();
    const groups: ExtractionWithSource[][] = [];

    for (const group of validated.groups) {
      const members: ExtractionWithSource[] = [];
      for (const id of group.extractionIds) {
        if (coveredIds.has(id)) {
          logger.warn({ id }, 'LLM returned duplicate extraction ID across groups, skipping');
          continue;
        }
        const ext = extractionMap.get(id);
        if (ext) {
          members.push(ext);
          coveredIds.add(id);
        }
      }
      if (members.length > 0) {
        groups.push(members);
      }
    }

    // Any extractions not covered by the LLM response go into singleton groups
    for (const e of extractions) {
      if (!coveredIds.has(e.id)) {
        groups.push([e]);
      }
    }

    return groups;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'LLM entity matching failed, falling back to singleton groups',
    );
    return singletonFallback();
  }
}
