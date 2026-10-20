import type { BlobPort } from './refresh';

/** R2 deletes at most this many keys in one call. */
const DELETE_BATCH = 1000;

/**
 * The blob port over R2: page bodies under `pages/`, what Spatula read from them under
 * `captures/` (ADR 0008), and snapshot files under `datasets/`.
 */
export function r2Blobs(bucket: R2Bucket): BlobPort {
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
    async delete(keys) {
      for (let start = 0; start < keys.length; start += DELETE_BATCH) {
        await bucket.delete(keys.slice(start, start + DELETE_BATCH));
      }
    },
  };
}
