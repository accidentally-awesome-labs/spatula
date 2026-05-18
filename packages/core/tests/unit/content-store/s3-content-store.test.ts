import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AWS SDK before importing
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://bucket.s3.amazonaws.com/signed-url'),
}));

import { S3ContentStore } from '../../../src/content-store/s3-content-store.js';
import { S3Client } from '@aws-sdk/client-s3';

describe('S3ContentStore', () => {
  let store: S3ContentStore;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new S3ContentStore({
      bucket: 'test-bucket',
      region: 'us-east-1',
    });
    // Access the mock send function
    mockSend = (S3Client as any).mock.results[0].value.send;
  });

  describe('store', () => {
    it('uploads text content with text/ prefix and returns s3:// ref', async () => {
      mockSend.mockResolvedValue({});
      const ref = await store.store('my-key', 'hello world');
      expect(ref).toBe('s3://test-bucket/text/my-key');
    });
  });

  describe('storeBinary', () => {
    it('uploads binary content with binary/ prefix', async () => {
      mockSend.mockResolvedValue({});
      const data = new Uint8Array([1, 2, 3]);
      const ref = await store.storeBinary('my-key', data);
      expect(ref).toBe('s3://test-bucket/binary/my-key');
    });
  });

  describe('retrieve', () => {
    it('downloads and returns text content', async () => {
      mockSend.mockResolvedValue({
        Body: { transformToString: vi.fn().mockResolvedValue('hello world') },
      });
      const content = await store.retrieve('s3://test-bucket/text/my-key');
      expect(content).toBe('hello world');
    });
  });

  describe('retrieveBinary', () => {
    it('downloads and returns binary content', async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      mockSend.mockResolvedValue({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(bytes) },
      });
      const result = await store.retrieveBinary('s3://test-bucket/binary/my-key');
      expect(result).toEqual(bytes);
    });

    it('returns null when object not found', async () => {
      const err = new Error('NoSuchKey');
      (err as any).name = 'NoSuchKey';
      mockSend.mockRejectedValue(err);
      const result = await store.retrieveBinary('s3://test-bucket/binary/missing');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes the object', async () => {
      mockSend.mockResolvedValue({});
      await expect(store.delete('s3://test-bucket/text/my-key')).resolves.not.toThrow();
    });
  });

  describe('getDownloadUrl', () => {
    it('returns a presigned URL', async () => {
      const url = await store.getDownloadUrl('s3://test-bucket/text/my-key', 3600);
      expect(url).toContain('signed-url');
    });
  });

  describe('storage byte tracking', () => {
    it('calls incrementStorageBytes after store() when tenant context is set', async () => {
      mockSend.mockResolvedValue({});
      const mockTenantRepo = { incrementStorageBytes: vi.fn().mockResolvedValue(undefined) };
      store.setTenantContext('tenant-1', mockTenantRepo);

      await store.store('key', 'hello world');

      // Fire-and-forget — give a tick to execute
      await new Promise((r) => setTimeout(r, 10));
      expect(mockTenantRepo.incrementStorageBytes).toHaveBeenCalledWith(
        'tenant-1',
        Buffer.byteLength('hello world', 'utf-8'),
      );
    });

    it('calls incrementStorageBytes after storeBinary() when tenant context is set', async () => {
      mockSend.mockResolvedValue({});
      const mockTenantRepo = { incrementStorageBytes: vi.fn().mockResolvedValue(undefined) };
      store.setTenantContext('tenant-1', mockTenantRepo);

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await store.storeBinary('key', data);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockTenantRepo.incrementStorageBytes).toHaveBeenCalledWith('tenant-1', 5);
    });

    it('does NOT call incrementStorageBytes when tenant context is not set', async () => {
      mockSend.mockResolvedValue({});
      // No setTenantContext called
      await store.store('key', 'content');
      // Nothing to assert — just verify no error thrown
    });
  });

  describe('error handling', () => {
    it('store throws StorageError on S3 failure', async () => {
      mockSend.mockRejectedValue(new Error('AccessDenied'));
      await expect(store.store('key', 'content')).rejects.toThrow('Failed to store content in S3');
    });

    it('retrieve throws StorageError on S3 failure', async () => {
      mockSend.mockRejectedValue(new Error('InternalError'));
      await expect(store.retrieve('s3://test-bucket/text/key')).rejects.toThrow(
        'Failed to retrieve from S3',
      );
    });

    it('parseRef throws on invalid ref format', async () => {
      await expect(store.retrieve('pg://wrong-format')).rejects.toThrow('Invalid S3 ref format');
    });
  });
});
