import { ConfigError } from '@spatula/shared';
import type { ContentStore } from '../interfaces/content-store.js';
import { S3ContentStore } from './s3-content-store.js';
import type { S3ContentStoreConfig } from './s3-content-store.js';

export interface ContentStoreConfig {
  type: 'postgres' | 's3';
  s3?: S3ContentStoreConfig;
}

// Example env var wiring for server bootstrap:
// const contentStoreType = getEnvOrDefault('CONTENT_STORE', 'postgres');
// const contentStore = contentStoreType === 's3'
//   ? createContentStore({ type: 's3', s3: { bucket: S3_BUCKET, region: S3_REGION, ... } })
//   : new PgContentStore(db);

export function createContentStore(config: ContentStoreConfig): ContentStore {
  switch (config.type) {
    case 's3':
      if (!config.s3) throw new ConfigError('S3 configuration required when CONTENT_STORE=s3');
      return new S3ContentStore(config.s3);
    case 'postgres':
      throw new ConfigError('PgContentStore must be created via @spatula/db');
    default:
      throw new ConfigError(`Unknown content store type: ${config.type}`);
  }
}
