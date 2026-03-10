import type { ExtractionResult, UnmappedField } from '../types/extraction.js';

/**
 * Aggregated view of an unmapped field across multiple extractions.
 */
export interface AggregatedField {
  /** Normalized field name: lowercase, whitespace replaced with underscores */
  normalizedName: string;
  /** All original name variants observed across extractions */
  observedNames: string[];
  /** Number of extractions that contained this field (deduplicated per extraction) */
  occurrences: number;
  /** Fraction of total extractions containing this field (0-1) */
  frequency: number;
  /** The most frequently observed suggestedType */
  dominantType: string;
  /** Count of each suggestedType observed */
  typeCounts: Record<string, number>;
  /** Deduplicated sample values, capped at 10 */
  sampleValues: unknown[];
}

const MAX_SAMPLE_VALUES = 10;

/**
 * Normalize a field name: lowercase, replace all whitespace sequences with underscores.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Determine the key with the highest count in a record.
 */
function dominantKey(counts: Record<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [key, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

interface FieldAccumulator {
  normalizedName: string;
  observedNames: Set<string>;
  extractionIds: Set<string>;
  typeCounts: Record<string, number>;
  sampleValues: unknown[];
  sampleSet: Set<string>;
}

/**
 * Collect unmapped fields from a batch of ExtractionResult objects and aggregate
 * them by normalized name (case-insensitive, whitespace→underscores).
 *
 * Fields are deduplicated within each extraction (same normalized name counts as
 * one occurrence even if multiple variants appear). Results are sorted by
 * occurrences descending.
 *
 * @param extractions - Array of extraction results to aggregate
 * @returns Aggregated fields sorted by occurrence count (descending)
 */
export function aggregateUnmappedFields(
  extractions: ExtractionResult[],
): AggregatedField[] {
  if (extractions.length === 0) {
    return [];
  }

  const accumulators = new Map<string, FieldAccumulator>();

  for (const extraction of extractions) {
    // Track which normalized names we've already counted for this extraction
    // to avoid double-counting within a single extraction
    const seenInExtraction = new Set<string>();

    for (const field of extraction.metadata.unmappedFields) {
      const normalized = normalizeName(field.name);

      let acc = accumulators.get(normalized);
      if (!acc) {
        acc = {
          normalizedName: normalized,
          observedNames: new Set(),
          extractionIds: new Set(),
          typeCounts: {},
          sampleValues: [],
          sampleSet: new Set(),
        };
        accumulators.set(normalized, acc);
      }

      // Track name variant
      acc.observedNames.add(field.name);

      // Count this extraction only once per normalized name
      if (!seenInExtraction.has(normalized)) {
        acc.extractionIds.add(extraction.id);
        seenInExtraction.add(normalized);
      }

      // Track type
      acc.typeCounts[field.suggestedType] =
        (acc.typeCounts[field.suggestedType] ?? 0) + 1;

      // Track sample value (deduplicated, capped)
      if (acc.sampleValues.length < MAX_SAMPLE_VALUES) {
        const serialized = JSON.stringify(field.value);
        if (!acc.sampleSet.has(serialized)) {
          acc.sampleSet.add(serialized);
          acc.sampleValues.push(field.value);
        }
      }
    }
  }

  const totalExtractions = extractions.length;

  const results: AggregatedField[] = [];
  for (const acc of accumulators.values()) {
    results.push({
      normalizedName: acc.normalizedName,
      observedNames: [...acc.observedNames],
      occurrences: acc.extractionIds.size,
      frequency: acc.extractionIds.size / totalExtractions,
      dominantType: dominantKey(acc.typeCounts),
      typeCounts: acc.typeCounts,
      sampleValues: acc.sampleValues,
    });
  }

  // Sort by occurrences descending
  results.sort((a, b) => b.occurrences - a.occurrences);

  return results;
}
