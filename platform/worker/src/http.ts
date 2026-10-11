import { addressError, PRODUCT_TOKEN } from '@spatula/core';
import type { HttpPort, HttpResult } from './refresh';

/*
 * Spatula's HTTP client. It names itself in its user agent, never follows a redirect on its own
 * (the pipeline sends each hop through its host's gate), stops waiting after 30 seconds, and
 * reads at most 5 MB of a page. It asks only for the addresses a definition may name (public
 * HTTPS ones). Every hop, page, and robots.txt goes through here, and a redirect's address comes
 * from the site, so this is where a redirect to the local network is stopped.
 */

export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `Spatula/<version> (+<where to read about it>)`, so a site can tell who's asking and why. The
 * product token is the one robots.txt is matched against, so the two can't drift apart.
 */
export function userAgent(version: string, aboutUrl: string): string {
  return `${PRODUCT_TOKEN}/${version} (+${aboutUrl})`;
}

export function createHttpFetcher(options: {
  userAgent: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): HttpPort {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  // The global fetch is looked up on each call, so a mock installed after this runs is used.
  const send =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));

  return {
    async get(url, headers): Promise<HttpResult> {
      if (!url.startsWith('https://')) return { ok: false, error: `${url} isn’t an HTTPS address` };
      if (!URL.canParse(url)) return { ok: false, error: `${url} isn’t an address` };
      const parsed = new URL(url);
      const reason = addressError(parsed);
      if (reason !== null) return { ok: false, error: `${url} is ${reason}` };
      let response: Response;
      try {
        // What is sent is the address that was just judged, not the text it was parsed from.
        response = await send(parsed.href, {
          method: 'GET',
          redirect: 'manual',
          headers: requestHeaders(headers, options.userAgent),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { ok: false, error: describe(error, timeoutMs) };
      }

      const answered: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        answered[name.toLowerCase()] = value;
      });
      if (response.status < 200 || response.status >= 300) {
        // The body isn't wanted, and one that has already failed mustn't fail the answer.
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: true,
          status: response.status,
          headers: answered,
          body: new Uint8Array(),
          truncated: false,
        };
      }
      try {
        return {
          ok: true,
          status: response.status,
          headers: answered,
          ...(await readCapped(response, maxBytes)),
        };
      } catch (error) {
        return { ok: false, error: describe(error, timeoutMs) };
      }
    },
  };
}

/**
 * The caller's headers on top of ours, except that the user agent is always ours. A `Headers`
 * object counts names that differ only in case as one, so setting the agent last replaces
 * whatever the caller sent, however it spelled the name.
 */
function requestHeaders(headers: Record<string, string>, userAgent: string): Headers {
  const sent = new Headers({ accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' });
  for (const [name, value] of Object.entries(headers)) sent.set(name, value);
  sent.set('user-agent', userAgent);
  return sent;
}

/** Reads a body up to `maxBytes`, and stops there. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (response.body === null) return { body: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      // The body has all it will keep, so a stream that has failed since can't fail the answer.
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}

function describe(error: unknown, timeoutMs: number): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  if (name === 'TimeoutError') return `no answer within ${timeoutMs / 1000} s`;
  return error instanceof Error ? error.message : String(error);
}
