import { eq, and } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { sourceTrust } from '../schema/source-trust.js';
import type { trustLevelEnum } from '../schema/enums.js';
import type { Database } from '../connection.js';

const logger = createLogger('source-trust-repository');

export type TrustLevel = (typeof trustLevelEnum.enumValues)[number];

export interface UpsertSourceTrustInput {
  jobId: string;
  tenantId: string;
  domain: string;
  trustLevel: TrustLevel;
  reasoning: string;
}

export class SourceTrustRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: UpsertSourceTrustInput) {
    try {
      // Wrap delete+insert in a transaction for atomicity
      return await this.db.transaction(async (tx) => {
        await tx
          .delete(sourceTrust)
          .where(and(eq(sourceTrust.jobId, input.jobId), eq(sourceTrust.domain, input.domain)));

        const [row] = await tx
          .insert(sourceTrust)
          .values({
            jobId: input.jobId,
            tenantId: input.tenantId,
            domain: input.domain,
            trustLevel: input.trustLevel,
            reasoning: input.reasoning,
          })
          .returning();

        logger.debug(
          { trustId: row.id, domain: input.domain, trustLevel: input.trustLevel },
          'source trust upserted',
        );
        return row;
      });
    } catch (error) {
      throw new StorageError(`Failed to upsert source trust: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId, domain: input.domain },
      });
    }
  }

  async findByJob(jobId: string, tenantId: string) {
    try {
      return await this.db
        .select()
        .from(sourceTrust)
        .where(and(eq(sourceTrust.jobId, jobId), eq(sourceTrust.tenantId, tenantId)));
    } catch (error) {
      throw new StorageError(`Failed to find source trust records: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findByDomain(domain: string, jobId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(sourceTrust)
        .where(
          and(
            eq(sourceTrust.domain, domain),
            eq(sourceTrust.jobId, jobId),
            eq(sourceTrust.tenantId, tenantId),
          ),
        );

      return row ?? null;
    } catch (error) {
      throw new StorageError(
        `Failed to find source trust for domain: ${(error as Error).message}`,
        {
          cause: error as Error,
          context: { domain, jobId },
        },
      );
    }
  }
}
