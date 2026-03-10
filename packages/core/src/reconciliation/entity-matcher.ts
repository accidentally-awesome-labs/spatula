import type { ExtractionResult } from '../types/extraction.js';

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
