import { Hono } from 'hono';
import { accessActor } from '../access';
import type { ActorApi } from '../actors';
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_SCRIPT } from './page';

/**
 * The console's policy: the page runs only its own script and style, calls only this origin, posts
 * no form anywhere, and no site may frame it. With nothing inline allowed, markup that got into the
 * page couldn't run either.
 */
export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The headers every console file is served with: it's the owner's, so nothing keeps a copy. */
const served = (type: string) => ({
  'content-type': `${type}; charset=utf-8`,
  'content-security-policy': CONSOLE_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
});

/**
 * The console (ADR 0009): its page, script, and style, for the owner, behind Cloudflare Access.
 * The Worker checks Access's token itself too, so a request that reached it some other way isn't
 * served. Each route names `accessActor` rather than the app using it for every path, which would
 * check the console API's requests, under /console/api, a second time.
 */
export const consolePages = new Hono<ActorApi>()
  .get('/', accessActor, (c) => c.body(CONSOLE_HTML, 200, served('text/html')))
  .get('/app.js', accessActor, (c) => c.body(CONSOLE_SCRIPT, 200, served('text/javascript')))
  .get('/app.css', accessActor, (c) => c.body(CONSOLE_CSS, 200, served('text/css')));
