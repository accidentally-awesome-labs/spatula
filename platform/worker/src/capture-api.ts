import { captureById } from '@spatula/store';
import type { Hono } from 'hono';
import { ownerOnly, PRIVATE_NO_STORE, type ActorApi } from './actors';
import { r2Blobs } from './blobs';
import { readCapture, type ArchivePorts } from './captures';
import { withDatabase } from './database';

/**
 * What every answer of the capture route carries besides private, no-store (ruling 27). The answer
 * is JSON, with the page's text inside it as strings, never the page's markup as a document. These
 * keep it so: a browser that is sent to the address reads no HTML into it (nosniff), and one that
 * did would run nothing (sandbox, with no allow-scripts), so a script from a scraped page can't run
 * on the console's origin and pass the origin check on its writes.
 */
export const CAPTURE_HEADERS = {
  'cache-control': PRIVATE_NO_STORE,
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
} as const;

/**
 * One capture, as the owner's evidence (ADR 0008, ADR 0009): its row, and what Spatula read from
 * its page. Captures are private, so this is the one route that serves them, and only to the owner,
 * by the CLI's token or in the console. Register it on an app whose paths an actor guard covers
 * (bearerActor, accessActor): a consumer's token gets 403 from `ownerOnly`, and no token, 401 from
 * the guard.
 */
export function captureRoutes(app: Hono<ActorApi>): void {
  app.get('/datasets/:id/captures/:captureId', ownerOnly, async (c) => {
    for (const [name, value] of Object.entries(CAPTURE_HEADERS)) c.header(name, value);
    const datasetId = c.req.param('id');
    const ports: ArchivePorts = {
      withDb: (fn) => withDatabase(c.env, fn),
      blobs: r2Blobs(c.env.STORE),
    };
    const capture = await ports.withDb((db) => captureById(db, c.req.param('captureId')));
    // Another dataset's capture is no capture of this one, to whoever asks.
    if (capture === null || capture.datasetId !== datasetId) {
      return c.json({ error: `No such capture in ${datasetId}.` }, 404);
    }
    const read = await readCapture(ports, capture);
    return c.json({ capture: { ...capture, fetchedAt: capture.fetchedAt.toISOString() }, read });
  });
}
