/** What Spatula is and how it behaves, for any site that follows the address in its user agent. */
export function aboutPage(env: Env): string {
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
<p>Spatula ${env.SPATULA_VERSION} keeps product facts current for the apps that depend on them:
names, identifiers such as GTINs and part numbers, and specifications. Its first app is Crowdio,
a site about audio gear.</p>
<h2>How it behaves</h2>
<ul>
<li>It obeys robots.txt: the rules for <code>Spatula</code>, or for <code>*</code> when none name it.
While a site's robots.txt can't be read, it fetches nothing from that site.</li>
<li>It waits at least a second between requests to a site, longer when robots.txt sets a
Crawl-delay, and backs off when a site is busy or failing.</li>
<li>It follows Content Signals: it reads a page with an AI model only where the site allows
<code>ai-input</code>. Nothing it reads is used to train AI models.</li>
<li>It collects facts only, never descriptions or photos. A block is an answer: it never tries
to get around one.</li>
</ul>
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
