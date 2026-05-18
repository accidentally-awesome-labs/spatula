import { eq, and, isNull, or, gt } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { apiKeys } from '../schema/api-keys.js';
import type { Database } from '../connection.js';

const logger = createLogger('api-key-repository');

export interface CreateApiKeyInput {
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  expiresAt?: Date;
}

export class ApiKeyRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateApiKeyInput) {
    try {
      const [row] = await this.db
        .insert(apiKeys)
        .values({
          tenantId: input.tenantId,
          keyHash: input.keyHash,
          keyPrefix: input.keyPrefix,
          name: input.name,
          scopes: input.scopes,
          expiresAt: input.expiresAt,
        })
        .returning();

      logger.debug({ keyId: row.id, tenantId: input.tenantId }, 'API key created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create API key: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId: input.tenantId, name: input.name },
      });
    }
  }

  async findByHash(keyHash: string) {
    try {
      const [row] = await this.db
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.keyHash, keyHash),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        );

      if (row) {
        // Update last_used_at (fire-and-forget, don't block auth)
        this.db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.id, row.id))
          .then(() => {})
          .catch((err) => logger.warn({ keyId: row.id, err }, 'Failed to update last_used_at'));
      }

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find API key by hash: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  async listByTenant(tenantId: string) {
    try {
      return await this.db
        .select({
          id: apiKeys.id,
          keyPrefix: apiKeys.keyPrefix,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)));
    } catch (error) {
      throw new StorageError(`Failed to list API keys: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }

  async revoke(keyId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`API key ${keyId} not found`, { context: { keyId, tenantId } });
      }

      logger.info({ keyId, tenantId }, 'API key revoked');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to revoke API key: ${(error as Error).message}`, {
        cause: error as Error,
        context: { keyId, tenantId },
      });
    }
  }
}
