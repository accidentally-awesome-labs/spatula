import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ContentStore } from '../interfaces/content-store.js';
import { StorageError, createLogger } from '@accidentally-awesome-labs/spatula-shared';

const logger = createLogger('s3-content-store');

export interface S3ContentStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3ContentStore implements ContentStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private tenantId?: string;
  private tenantRepo?: { incrementStorageBytes(tenantId: string, bytes: number): Promise<void> };

  /**
   * Set tenant context for storage byte tracking.
   * Same pattern as PgContentStore.setTenantContext().
   * Per decomposition spec: "3-3a wires the same tracking into S3ContentStore."
   */
  setTenantContext(
    tenantId: string,
    tenantRepo: { incrementStorageBytes(tenantId: string, bytes: number): Promise<void> },
  ): void {
    this.tenantId = tenantId;
    this.tenantRepo = tenantRepo;
  }

  constructor(config: S3ContentStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  }

  async store(key: string, content: string): Promise<string> {
    const s3Key = `text/${key}`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: content,
          ContentType: 'text/plain; charset=utf-8',
        }),
      );
      const ref = `s3://${this.bucket}/${s3Key}`;
      logger.debug({ ref, key }, 'text content stored');

      // Track storage bytes (fire-and-forget, same pattern as PgContentStore)
      if (this.tenantId && this.tenantRepo) {
        const bytes = Buffer.byteLength(content, 'utf-8');
        void this.tenantRepo
          .incrementStorageBytes(this.tenantId, bytes)
          .catch((err: unknown) => logger.warn({ err }, 'Failed to track storage bytes'));
      }

      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store content in S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key, bucket: this.bucket },
      });
    }
  }

  async storeBinary(key: string, data: Uint8Array): Promise<string> {
    const s3Key = `binary/${key}`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: data,
          ContentType: 'application/octet-stream',
        }),
      );
      const ref = `s3://${this.bucket}/${s3Key}`;
      logger.debug({ ref, key, size: data.byteLength }, 'binary content stored');

      // Track storage bytes (fire-and-forget)
      if (this.tenantId && this.tenantRepo) {
        void this.tenantRepo
          .incrementStorageBytes(this.tenantId, data.byteLength)
          .catch((err: unknown) => logger.warn({ err }, 'Failed to track storage bytes'));
      }

      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store binary in S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key, bucket: this.bucket },
      });
    }
  }

  async retrieve(ref: string): Promise<string> {
    const { bucket, key } = this.parseRef(ref);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) {
        throw new StorageError('S3 returned empty body', { context: { ref } });
      }
      return await response.Body.transformToString();
    } catch (error) {
      throw new StorageError(`Failed to retrieve from S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async retrieveBinary(ref: string): Promise<Uint8Array | null> {
    const { bucket, key } = this.parseRef(ref);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) return null;
      return await response.Body.transformToByteArray();
    } catch (error) {
      if ((error as any).name === 'NoSuchKey') return null;
      throw new StorageError(`Failed to retrieve binary from S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async delete(ref: string): Promise<void> {
    const { bucket, key } = this.parseRef(ref);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      logger.debug({ ref }, 'content deleted from S3');
    } catch (error) {
      throw new StorageError(`Failed to delete from S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async getDownloadUrl(ref: string, expiresInSeconds = 3600): Promise<string> {
    const { bucket, key } = this.parseRef(ref);
    try {
      return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    } catch (error) {
      throw new StorageError(`Failed to generate presigned URL: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  private parseRef(ref: string): { bucket: string; key: string } {
    if (!ref.startsWith('s3://')) {
      throw new StorageError(`Invalid S3 ref format: ${ref}`, { context: { ref } });
    }
    const withoutProtocol = ref.slice(5); // Remove "s3://"
    const slashIndex = withoutProtocol.indexOf('/');
    if (slashIndex === -1) {
      throw new StorageError(`Invalid S3 ref format: ${ref}`, { context: { ref } });
    }
    return {
      bucket: withoutProtocol.slice(0, slashIndex),
      key: withoutProtocol.slice(slashIndex + 1),
    };
  }
}
