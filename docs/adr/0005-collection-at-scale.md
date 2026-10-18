# 0005. Collection at scale: sitemaps, run plans, pacing, and signatures

- Status: proposed with slice 1
- Date: 2026-10-12

## Context

Slice 0 read pages a person listed. A maker's catalog is hundreds of pages that come and go, and
Shopify challenged Spatula's Workers when requests came a second apart (2026-10-11). Spatula has
to find pages by itself, read them within Workflows' limits, and stay a polite, identifiable
visitor.

## Decision

- **Sitemap sources.** A source names its sitemaps: XML or text, gzipped or not, a list or an
  index.
  - An index's children are read only when their path matches the source's `follow` patterns
    (all of them when it has none). Shopify's product sitemap carries ID ranges that drift, so
    definitions name the index.
  - Pages are chosen by `include` and `exclude` path patterns with robots.txt's rules (`*`, and
    `$` at the end), on the sitemap's own host, up to `maxPages` (default 1,000).
  - `useLastmod` says whether a sitemap's `lastmod` can be trusted. Four of the six pilot
    sitemaps stamp every entry with the time of the request.
- **What counts as gone.**
  - A page goes gone after two gone answers in a row, each a 404, a 410, or a redirect away from
    it (to an address whose path its source's patterns wouldn't list and whose last path segment
    differs from the page's, since a locale or market prefix moves a page without removing it; a
    pages source's redirects are followed), or after three complete sitemap reads in a row
    without it.
  - A read that failed partway (an error on a child sitemap, a soft 404, a body cut off at the
    cap), that lists more pages than `maxPages` keeps, or that lists none that match, marks
    nothing missing.
  - A page gone because it left its sitemaps comes back when a read of them lists it again. A
    page gone after 404s or 410s, or a redirect away from it, stays gone even while its sitemap
    still lists it, because sitemaps go stale. It comes back when `pnpm spatula revive` names it.
- **The run plan.**
  - A run reads at most `budget.itemsPerRun` pages (default 1,000), least recently read first,
    interleaved by host.
  - A page read within `freshness.maxAgeDays` (default 7) waits, unless its trusted `lastmod`
    moved, its statements came from older code, or its last fetch failed, was blocked, or found
    it gone.
  - That keeps a run within Workflows' 10,000 steps, and its requests few.
  - Extraction is tagged with the definition's revision, and every part of the definition is in
    its hash, settings included (freshness, gates, publication, decisions, budget, consumers). So
    any edit to a definition, even one that only adds a consumer or raises the budget, makes
    every page due once: the next runs re-read each page (with conditional requests) and extract
    again. Under `balanced`, the first publication after the edit is held (ADR 0004). This is
    deliberate: a tag over chosen parts could leave extractions stale after a change that
    matters.
- **Pacing.**
  - Within a run, each host's next request waits a full interval after the previous answer
    arrived. Runs can overlap on a host: two datasets can share one, and a run that outlives six
    hours stops blocking its dataset's next start (ADR 0004). Then the interval in force is
    whichever reservation came last, and a slot reserved before an answer arrives isn't moved by
    it.
  - The interval is the dataset's `perHostIntervalMs` (at least 1,000) or the site's Crawl-delay,
    whichever is longer, and reading robots.txt counts as a request: it waits for the host like
    any other. A robots.txt answered with a challenge keeps the rules stored before it (with none
    stored, the host is treated as refusing everything until robots.txt can be read).
  - A 429, a 5xx, a block (HTTP 401–403), or no answer at all backs the host off, with a break
    that doubles with each strain, or the longer one its Retry-After asks for.
  - Three blocks in a row that the host answered (HTTP 401–403, or a challenge) pause the source
    for the rest of the run. A refusal by robots.txt sends no request, so it counts toward no
    pause. A page blocked three times in a row of its own is refused until `pnpm spatula revive`.
- **Signatures (Web Bot Auth).**
  - With the `WEB_BOT_AUTH_KEY` secret (an Ed25519 private key as a JWK), every request carries
    `Signature-Agent`, `Signature-Input`, and `Signature` headers (RFC 9421) over its authority
    and its Signature-Agent.
  - The Worker serves the public key at `/.well-known/http-message-signatures-directory`,
    signed for the host that asked.
  - Without the key, nothing is signed and the directory answers 404. Registering the key with
    Cloudflare is an optional owner step.
- **Reading a page.** A page whose elements nest more than 1,000 deep, as htmlparser2 builds its
  tree, isn't read: the run's notes say the page couldn't be read, and why. It stays live with its
  statements as they were, is tagged to retry, and is tried again every run. The parser's own
  stack decides (a DomHandler that refuses past `MAX_NESTING`), because a separate estimate
  disagreed with the parser and let hostile pages through. Reading a page, the parse and every
  walk over its tree alike, takes time that grows with its depth, and a Worker can't catch
  running out of CPU. The trade-off: markup that leaves out end tags in long lists can reach the
  limit (htmlparser2 doesn't close an open `<p>` when a new `<li>` starts, so 500 or more
  `<li><p>Item` entries nest 1,000 deep), and such a page goes unread, not misread.
- **The fetch log** records sitemap reads beside page reads.

## Consequences

- A dataset of several makers is one definition, and its pages follow the makers' catalogs
  without a person listing them.
- At 15 seconds a request, a host with 130 pages takes about half an hour, while the other hosts
  are read in the same run.
- The pacing test of 2026-10-12 and 13, at 15 seconds a request, found the gap between runs
  matters as much as the spacing within one: no page of 21 was challenged in the first run, 2
  were in a run an hour later, and none in a run a day after the first. Runs on Shopify makers
  are kept a day apart; daily offers wait for signed requests to earn trust.
