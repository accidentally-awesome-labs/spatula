/**
 * Inline mirror of FieldProvenanceEntry from @spatula/core.
 * Defined here to avoid a circular dependency (core depends on shared).
 */
export interface FieldProvenanceEntry {
  finalValue: unknown;
  provenanceType: string;
  sources: Array<{
    sourceUrl: string;
    rawValue: unknown;
    normalizedValue: unknown;
  }>;
  hadConflict: boolean;
  resolution?: string;
}

/** Entity as returned by the list endpoint (no provenance detail). */
export interface Entity {
  id: string;
  jobId: string;
  mergedData: Record<string, unknown>;
  categories: string[];
  qualityScore: number;
  createdAt: string;
  sourceCount: number;
}

/** Entity as returned by the detail endpoint (with full provenance). */
export interface EntityWithProvenance extends Entity {
  provenance: Record<string, FieldProvenanceEntry>;
  sources: Array<{
    extractionId: string;
    matchConfidence: number;
    sourceUrl?: string;
  }>;
}
