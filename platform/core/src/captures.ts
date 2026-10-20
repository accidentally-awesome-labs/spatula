import type { JsonLdNode, Page } from './page';

/*
 * The page archive (ADR 0008). Every page a run reads is kept as it arrived, compressed, beside what
 * Spatula read from it, so a later change can read a page again without fetching it, and every
 * value can show the page it came from. Captures are private evidence: they never reach a snapshot
 * or a consumer. What a capture keeps is plain JSON, and gzip is the runtime's own, which Node and
 * Workers share.
 */

/** Bump when what a read keeps changes. A capture records the version that read its page. */
export const PAGE_READ_VERSION = 1;

/** A page as Spatula read it: what `parsePage` found, as plain JSON. */
export interface PageRead {
  reader: number;
  /** The address the page came from, after redirects. */
  url: string;
  canonicalUrl: string;
  title: string | null;
  breadcrumbs: string[];
  jsonLd: JsonLdNode[];
  jsonLdErrors: number;
  /** The meta tags' content by property or name, lowercased, as the page gave them. */
  meta: Record<string, string[]>;
  text: string;
}

/**
 * What Spatula read from a page, to keep with its capture. The meta tags become an object of their
 * own keys: `Object.fromEntries` defines each key, so one a page calls `__proto__` stays a key.
 */
export function pageRead(page: Page): PageRead {
  return {
    reader: PAGE_READ_VERSION,
    url: page.url,
    canonicalUrl: page.canonicalUrl,
    title: page.title,
    breadcrumbs: page.breadcrumbs,
    jsonLd: page.jsonLd,
    jsonLdErrors: page.jsonLdErrors,
    meta: Object.fromEntries(page.meta),
    text: page.text,
  };
}

const isStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * A kept read, as JSON.parse gave it back, or null when it isn't one. Its shape is checked, and its
 * objects are left as JSON.parse made them, whose keys are all their own.
 */
export function parsePageRead(value: unknown): PageRead | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const read = value as Record<string, unknown>;
  const meta = read.meta;
  const ok =
    typeof read.reader === 'number' &&
    typeof read.url === 'string' &&
    typeof read.canonicalUrl === 'string' &&
    (read.title === null || typeof read.title === 'string') &&
    isStrings(read.breadcrumbs) &&
    Array.isArray(read.jsonLd) &&
    typeof read.jsonLdErrors === 'number' &&
    typeof meta === 'object' &&
    meta !== null &&
    !Array.isArray(meta) &&
    Object.values(meta).every(isStrings) &&
    typeof read.text === 'string';
  return ok ? (value as PageRead) : null;
}

/** Bytes through a compression stream, whole. */
async function through(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bytes, gzipped. */
export function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new CompressionStream('gzip'));
}

/** Gzipped bytes, unzipped. It rejects bytes that aren't gzip. */
export function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new DecompressionStream('gzip'));
}
