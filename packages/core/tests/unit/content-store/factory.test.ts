import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

import { createContentStore } from '../../../src/content-store/factory.js';
import { S3ContentStore } from '../../../src/content-store/s3-content-store.js';

describe('createContentStore', () => {
  it('returns S3ContentStore when type is "s3"', () => {
    const store = createContentStore({
      type: 's3',
      s3: { bucket: 'test', region: 'us-east-1' },
    });
    expect(store).toBeInstanceOf(S3ContentStore);
  });

  it('throws for "postgres" type (PgContentStore is in @accidentally-awesome-labs/spatula-db, not @accidentally-awesome-labs/spatula-core)', () => {
    expect(() => createContentStore({ type: 'postgres' })).toThrow(
      'PgContentStore must be created via @accidentally-awesome-labs/spatula-db',
    );
  });

  it('throws for unknown type', () => {
    expect(() => createContentStore({ type: 'unknown' as any })).toThrow(
      'Unknown content store type: unknown',
    );
  });

  it('throws when s3 type is selected but s3 config is missing', () => {
    expect(() => createContentStore({ type: 's3' })).toThrow(
      'S3 configuration required when CONTENT_STORE=s3',
    );
  });
});
