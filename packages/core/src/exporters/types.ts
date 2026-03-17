export interface FieldStats {
  fillRate: number;
  uniqueCount: number;
  sampleValues: unknown[];
  min?: number;
  max?: number;
}

export interface FieldDocumentation {
  name: string;
  type: string;
  description: string;
  required: boolean;
  aliases: string[];
  stats: FieldStats;
}

export interface DataDictionary {
  jobId: string;
  schemaVersion: number;
  generatedAt: string;
  entityCount: number;
  sampled?: boolean;
  sampleSize?: number;
  fields: FieldDocumentation[];
}
