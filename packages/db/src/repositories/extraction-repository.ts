import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { extractions } from '../schema/extractions.js';
import type { Database } from '../connection.js';

const logger = createLogger('extraction-repository');

export interface StoreExtractionInput {
  jobId: string;
  tenantId: string;
  pageId: string;
  schemaVersion: number;
  data: Record<string, unknown>;
  unmappedFields: unknown[];
  metadata: Record<string, unknown>;
}

export class ExtractionRepository {
  constructor(private readonly db: Database) {}

  async store(input: StoreExtractionInput) {
    try {
      const [row] = await this.db
        .insert(extractions)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          pageId: input.pageId,
          schemaVersion: input.schemaVersion,
          data: input.data,
          unmappedFields: input.unmappedFields,
          metadata: input.metadata,
        })
        .returning();

      logger.debug({ extractionId: row.id, pageId: input.pageId }, 'extraction stored');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to store extraction: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId, pageId: input.pageId },
      });
    }
  }

  async findByJob(jobId: string, options?: { schemaVersion?: number; limit?: number }) {
    try {
      let query = this.db
        .select()
        .from(extractions)
        .where(
          options?.schemaVersion
            ? and(eq(extractions.jobId, jobId), eq(extractions.schemaVersion, options.schemaVersion))
            : eq(extractions.jobId, jobId),
        )
        .orderBy(desc(extractions.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find extractions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findByPage(pageId: string) {
    try {
      return await this.db
        .select()
        .from(extractions)
        .where(eq(extractions.pageId, pageId))
        .orderBy(desc(extractions.createdAt));
    } catch (error) {
      throw new StorageError(`Failed to find extractions for page: ${(error as Error).message}`, {
        cause: error as Error,
        context: { pageId },
      });
    }
  }
}
