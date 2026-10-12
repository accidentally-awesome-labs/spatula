import { secret } from './config';

/** The list item for a deployment that signs its requests. */
const SIGNING_ITEM = `<li>It signs its requests with Web Bot Auth (HTTP Message Signatures), so a
site can check that a request naming Spatula came from Spatula. Its public key is at
<a href="/.well-known/http-message-signatures-directory"><code>/.well-known/http-message-signatures-directory</code></a>.</li>
`;

/** What Spatula is and how it behaves, for any site that follows the address in its user agent. */
export function aboutPage(env: Env): string {
  // Without a key nothing is signed and the key directory answers 404, so the page says Spatula
  // signs only where this deployment does.
  const signing = secret(env, 'WEB_BOT_AUTH_KEY') === undefined ? '' : SIGNING_ITEM;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spatula</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
</style>
</head>
<body>
<main>
<h1>Spatula</h1>
<p>Spatula ${escapeHtml(env.SPATULA_VERSION)} keeps product facts current for the apps that depend on them:
names, identifiers such as GTINs and part numbers, and specifications. Its first app is Crowdio,
a site about audio gear.</p>
<h2>How it behaves</h2>
<ul>
<li>It obeys robots.txt: the rules for <code>Spatula</code>, or for <code>*</code> when none name it.
While a site's robots.txt can't be reached, or answers with a server error or 429, it fetches
nothing from that site. A site with no robots.txt (any other 4xx answer) has no rules for it.</li>
<li>It waits at least a second between requests to a site, longer when robots.txt sets a
Crawl-delay, and backs off when a site is busy or failing.</li>
<li>It follows Content Signals: it reads a page with an AI model unless the site's Content Signals
say <code>ai-input=no</code>. Nothing it reads is used to train AI models.</li>
<li>It collects facts only, never descriptions or photos. A block is an answer: it never tries
to get around one.</li>
${signing}</ul>
<h2>Opting out</h2>
<p>Add this to your robots.txt:</p>
<pre><code>User-agent: Spatula
Disallow: /</code></pre>
<p>For anything else, <a href="https://github.com/accidentally-awesome-labs/spatula/issues">open an issue</a>.</p>
</main>
</body>
</html>
`;
}

/** Text as it can sit in HTML: the five characters that begin or end markup. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
