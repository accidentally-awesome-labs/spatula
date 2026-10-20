import {
  gunzip,
  gzip,
  PAGE_READ_VERSION,
  pageRead,
  parsePage,
  parsePageRead,
  type Page,
  type PageRead,
} from '@spatula/core';
import {
  deleteCaptures,
  freedKeys,
  prunableCaptures,
  setCaptureRead,
  type CaptureRow,
} from '@spatula/store';
import { pageKey, type BlobPort, type Context, type RefreshPorts } from './pipeline';
import { storable } from './text';

/*
 * The page archive's files (ADR 0008). A page's body is kept gzipped under its SHA-256, so an
 * unchanged page is stored once, whichever page or dataset holds it. What Spatula read from a page
 * is kept per capture. Copies stored before the archive were kept raw under the bare hash, and
 * still read. A later change reads a page again from here, without fetching it: the store's
 * `latestCapture` and `latestCaptures` find a page's capture, and `readCapture` reads it.
 */

/** Where a page stored before the archive is kept: its body as it arrived, under its SHA-256. */
export const rawPageKey = (contentHash: string) => `pages/${contentHash}`;

/** Where what Spatula read from a capture's page is kept. */
export const readKey = (datasetId: string, captureId: string) =>
  `captures/${datasetId}/${captureId}.json.gz`;

/** What the archive's files need: the database, and the blob store. */
export type ArchivePorts = Pick<RefreshPorts, 'withDb' | 'blobs'>;

/** Keeps a page's body, gzipped, under its hash, and returns the gzipped size. */
export async function storeBody(
  blobs: BlobPort,
  contentHash: string,
  body: Uint8Array,
): Promise<number> {
  const packed = await gzip(body);
  await blobs.put(pageKey(contentHash), packed, 'application/gzip');
  return packed.byteLength;
}

/** A page's body, from the archive or from a copy stored before it; null when neither is there. */
export async function readPageBody(
  blobs: BlobPort,
  contentHash: string,
): Promise<Uint8Array | null> {
  const packed = await blobs.get(pageKey(contentHash));
  if (packed !== null) return gunzip(packed);
  return blobs.get(rawPageKey(contentHash));
}

/**
 * Keeps what Spatula read from a capture's page, unless the capture has its read already. The row
 * names the file before the file is written. Cleanup and a purge find reads only through the row's
 * key, so a write that fails between the two must leave a key with no file, which they delete
 * harmlessly and `readCapture` makes again, not a file no row names, which they would never delete.
 */
export async function storeRead(
  ports: ArchivePorts,
  capture: Pick<CaptureRow, 'id' | 'datasetId' | 'readKey'>,
  page: Page,
): Promise<void> {
  if (capture.readKey !== null) return;
  const key = readKey(capture.datasetId, capture.id);
  const json = new TextEncoder().encode(JSON.stringify(pageRead(page)));
  const packed = await gzip(json);
  await ports.withDb((db) =>
    setCaptureRead(db, { id: capture.id, readKey: key, reader: PAGE_READ_VERSION }),
  );
  await ports.blobs.put(key, packed, 'application/gzip');
}

/**
 * What Spatula read from a capture's page: the read kept with it, or, for a capture without one, a
 * read made now from its body, and kept. Null when the body is gone (a purge took it) or can't be
 * read (it nests too deep, ADR 0005). This is how a later change reads a page again without
 * fetching it.
 */
export async function readCapture(
  ports: ArchivePorts,
  capture: CaptureRow,
): Promise<PageRead | null> {
  if (capture.readKey !== null) {
    const kept = await ports.blobs.get(capture.readKey);
    const read = kept === null ? null : await gunzip(kept).then(parseKept, () => null);
    if (read !== null) return read;
  }
  const body = await readPageBody(ports.blobs, capture.contentHash);
  if (body === null) return null;
  let page: Page;
  try {
    page = parsePage(new TextDecoder().decode(body), capture.finalUrl);
  } catch {
    return null;
  }
  // A read whose file was missing is made again, and kept under the same key.
  await storeRead(ports, { ...capture, readKey: null }, page);
  return pageRead(page);
}

/** A kept read's bytes as a read, or null when they aren't one. */
function parseKept(bytes: Uint8Array): PageRead | null {
  try {
    return parsePageRead(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** At most this many captures are deleted in one run; the next run goes on (ADR 0008). */
export const MAX_PRUNED_PER_RUN = 1_000;

/**
 * The archive's cleanup, a step of every run (ADR 0008): the dataset's captures that retention no
 * longer keeps, their reads, and the bodies nothing else holds. The files go first and the rows
 * after, so a step that runs again finds the same rows and finishes the job. The run's start is its
 * clock, so a run that replays its steps prunes the same captures. A failure is a note, never a
 * failed run: the snapshot is out by now, and the next run cleans up.
 */
export async function cleanUpCaptures(
  context: Pick<Context, 'datasetId' | 'startedAt'>,
  ports: ArchivePorts,
): Promise<{ pruned: number; note: string | null }> {
  try {
    return await ports.withDb(async (db) => {
      const ids = await prunableCaptures(db, {
        datasetId: context.datasetId,
        now: context.startedAt,
        limit: MAX_PRUNED_PER_RUN,
      });
      if (ids.length === 0) return { pruned: 0, note: null };
      const freed = await freedKeys(db, ids);
      await ports.blobs.delete([
        ...freed.hashes.flatMap((hash) => [pageKey(hash), rawPageKey(hash)]),
        ...freed.reads,
      ]);
      return { pruned: await deleteCaptures(db, ids), note: null };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { pruned: 0, note: storable(`The archive wasn’t cleaned up this run: ${message}`) };
  }
}
