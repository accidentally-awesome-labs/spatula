/*
 * IDs, hashes, and a stable JSON form for hashing. They use the Web Crypto API, which Node and
 * Workers share, so core needs no runtime of its own.
 */

/** Crockford's base32, lowercase: no i, l, o, or u to misread. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SLOT_MS = 5 * 60 * 1000;

/**
 * A new random ID: the prefix, an underscore, and 20 base32 characters (100 bits). IDs are
 * opaque. Nothing is read from them, and they're never derived from values.
 */
export function newId(prefix: string): string {
  let id = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(20))) id += ALPHABET.charAt(byte & 31);
  return `${prefix}_${id}`;
}

/**
 * An ID that comes out the same every time it's made from the same parts: the prefix, an
 * underscore, and 20 base32 characters of their SHA-256. A Workflow step that runs again after a
 * crash makes the same ID, so what it writes is written once. Like `newId`'s, these IDs are
 * opaque: nothing is read from them.
 */
export async function stableId(prefix: string, ...parts: (string | number)[]): Promise<string> {
  // A NUL can't appear in an ID or a URL, so no two lists of parts join to the same text.
  const hash = await sha256Hex(parts.map(String).join('\u0000'));
  let id = '';
  for (let index = 0; index < 20; index += 1) {
    id += ALPHABET.charAt(Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16) & 31);
  }
  return `${prefix}_${id}`;
}

/**
 * A run's ID: its dataset and the five-minute slot it starts in, in UTC. A second start in the
 * same slot asks for the same run, so a duplicate trigger is harmless.
 */
export function runIdFor(datasetId: string, at: Date): string {
  const slot = new Date(Math.floor(at.getTime() / SLOT_MS) * SLOT_MS);
  return `${datasetId}-${slot.toISOString().slice(0, 16).replace(/[-:T]/gu, '')}`;
}

/**
 * JSON with object keys sorted at every level, so equal values always hash alike. As in
 * JSON.stringify, a value that has a `toJSON` method is written as what it returns, so a Date is
 * its ISO string.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  // Ask for the JSON form first. A Date has no keys of its own, so sorting its keys would turn it
  // into {}.
  const json = hasToJSON(value) ? value.toJSON() : value;
  if (Array.isArray(json)) return json.map(sortKeys);
  if (json === null || typeof json !== 'object') return json;
  const record = json as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, sortKeys(record[key])]),
  );
}

function hasToJSON(value: unknown): value is { toJSON: () => unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

/** The SHA-256 of text (as UTF-8) or of bytes, as 64 lowercase hex digits. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 of the data under the key, in hex: how consumers sign their acknowledgments. */
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', imported, encoder.encode(data));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
