import { eq, and, isNull, or, gt } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { apiKeys } from '../schema/api-keys.js';
import type { Database } from '../connection.js';

export interface RotateApiKeyInput {
  keyHash: string;
  keyPrefix: string;
}

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

  /**
   * Rotate an API key with a zero-downtime two-key grace window.
   *
   * In a single transaction:
   * 1. Reads the original key (throws StorageError if not found or already revoked).
   * 2. Inserts a new key inheriting the original's scopes verbatim.
   *    - `supersedes` = original key id
   *    - `supersededExpiresAt` = now + graceSeconds (stored on new row for the response)
   * 3. Updates the old key's `expiresAt` = now + graceSeconds so it keeps validating
   *    through the grace window and then auto-expires (`findByHash` filters expiresAt > now).
   *
   * @param keyId        - The id of the key to rotate.
   * @param tenantId     - Must match the key's tenantId (tenant isolation).
   * @param newKeyMaterial - `{ keyHash, keyPrefix }` — the raw key never enters the repo.
   * @param graceSeconds - Grace window duration in seconds. Already clamped by the caller.
   * @returns `{ oldKey, newKey }` — both rows as returned by Postgres (with all columns).
   */
  async rotate(
    keyId: string,
    tenantId: string,
    newKeyMaterial: RotateApiKeyInput,
    graceSeconds: number,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        // 1. Select the original row
        const [orig] = await tx
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)));

        // 2. Guard: not found
        if (!orig) {
          throw new StorageError(`API key ${keyId} not found`, {
            context: { keyId, tenantId },
          });
        }

        // 3. Guard: already revoked
        if (orig.revokedAt) {
          throw new StorageError(`API key ${keyId} is already revoked and cannot be rotated`, {
            context: { keyId },
          });
        }

        // 4. Compute grace window expiry
        const graceUntil = new Date(Date.now() + graceSeconds * 1000);

        // 5. Insert the new key; scopes copied verbatim.
        //    supersededExpiresAt stored on NEW row so the response can return
        //    it without a second query.
        const [newKey] = await tx
          .insert(apiKeys)
          .values({
            tenantId,
            keyHash: newKeyMaterial.keyHash,
            keyPrefix: newKeyMaterial.keyPrefix,
            name: `${orig.name} (rotated)`,
            scopes: orig.scopes,
            supersedes: orig.id,
            supersededExpiresAt: graceUntil,
          })
          .returning();

        // 6. Grace-expire the old key — findByHash filters expiresAt > now, so the
        //    old key stops authenticating exactly when the grace window closes.
        const [oldKey] = await tx
          .update(apiKeys)
          .set({ expiresAt: graceUntil })
          .where(eq(apiKeys.id, keyId))
          .returning();

        logger.info(
          { oldKeyId: keyId, newKeyId: newKey.id, tenantId, graceSeconds },
          'API key rotated',
        );

        return { oldKey, newKey };
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to rotate API key: ${(error as Error).message}`, {
        cause: error as Error,
        context: { keyId, tenantId },
      });
    }
  }
}
