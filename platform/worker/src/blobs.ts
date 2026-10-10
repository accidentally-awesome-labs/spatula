import type { BlobPort } from './refresh';

/** The blob port over R2: raw pages under `pages/`, snapshot files under `datasets/`. */
export function r2Blobs(bucket: R2Bucket): BlobPort {
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
  };
}
