# 0002. Dataset definitions

- Status: accepted for slice 0; revised for slice 1, proposed with slice 1
- Date: 2026-10-09, revised 2026-10-12 for slice 1

## Context

Owners declare each dataset in their own repository, preview the change, then apply it (ADR
0001). Slice 0 set the format's first subset. Slice 1 reads makers' sitemaps, decides what rules
can't, publishes through gates, and serves consumers, and the format grows to say how.

## Decision

A definition is YAML, sent as JSON, and checked by `@spatula/core`'s `definitionSchema` in the
CLI and again in the API. Unknown keys are errors, so a misspelling never passes silently. Every
key added after slice 0 has a default, so older definitions still parse; the store reads stored
definitions through the schema again, so they get the defaults too.

- **`dataset`:** a slug, up to 63 characters. It also names the snapshots' `project`.
- **`recordTypes`:** exactly one, for now. Each has:
  - an optional `pack`, such as `products/product`, that reads its fields from structured data;
  - `identity`: `identifiers` (fields marked `identifier: true`, strongest first) and `keys`
    (groups of single text or enum fields, such as `[brand, name]`);
  - `fields`, each with a `type` (`text`, `enum`, `gtin`, `url`, or `specs`), and `required`,
    `list`, `identifier`, `scope` (the field an identifier is compared within), `values` (for an
    enum: at most 254, each at most 600 characters), `maxLength` (for text), `llm`, `decide`, and
    `description`.
  - `decide: true` lets the decision cascade fill one required enum field that no rule fills
    (ADR 0003). Its question offers the field's values and "None of these"; that answer makes the
    page irrelevant. A decided field's values are distinct regardless of case, and none is
    “None of these”.
- **`sources`:** each has an `id`, a `recordType`, `fixed` values, declared `extract` rules
  (`{ css, attr? }` or `{ url: canonical }`), and `evidence` (when robots.txt and the terms were
  checked, and what the terms say about automated access; a source whose terms forbid it is
  refused). Two kinds:
  - `kind: pages` lists its pages, up to 1,000.
  - `kind: sitemap` names up to 20 `sitemaps`, and `include` and `exclude` patterns,
    robots.txt-style (`*` for anything, a final `$` for the end): a page is kept when its path and
    query match at least one include pattern and no exclude pattern. An index's child sitemaps are
    read when their path matches one of the `follow` patterns, or all of them when there are none.
    At most `maxPages` (default 1,000) of its pages are kept. `useLastmod` (default false) says
    whether a moved `lastmod` means the page changed: many sitemaps stamp every entry with the
    time of the request. Its pages come and go with its sitemaps (ADR 0005), not with the
    definition.
  - A declared value or rule replaces whatever the pack would read for that field. If a declared
    rule finds nothing, the field is missing: Spatula never falls back to a weaker guess.
- **`policy`:** `purposes` (the Content Signals uses the dataset makes: `ai-input` for anything an
  LLM reads), and `perHostIntervalMs`, at least 1000.
- **`freshness`:** `maxAgeDays` (default 7): a page read more recently waits, unless its sitemap
  says it changed.
- **`gates`:** `maxRemovals` (default `{ count: 25, share: 0.05 }`): a snapshot that drops more of
  the last published records than either allows is held (ADR 0004).
- **`publication`:** `approval` is `auto`, `balanced` (the default), or `manual` (ADR 0004).
- **`decisions`:** the probability at which the cascade accepts an answer: `classify.accept`
  (default 0.9) and `match.accept` (default 0.95).
- **`budget`:** `itemsPerRun` (default 1,000) and `llmTokensPerRun` (default 2,000,000).
- **`consumers`:** the names of the apps that may read the snapshots (ADR 0004).

Names are camelCase, and the few that every object already has, such as `constructor` and
`toString`, are reserved. Pages, sitemaps, and `evidence.terms.url` must all be at public
addresses, because Spatula must never fetch anything inside someone's network. It refuses an
address that carries a user name or password, an IP address, `localhost`, a name with no dot, and
the private-use endings `.local`, `.internal`, `.home.arpa`, and `.lan`. `addressError` in
`@spatula/core` makes that call for any address.

Identity fields can't be filled by the LLM or decided by the cascade. The LLM fills only `specs`
fields.

## Consequences

Feeds, APIs, and Shopify's product JSON are refused until the slices that add them: a clear error,
not a silently ignored key. A run reads at most `budget.itemsPerRun` pages, which keeps it inside
Workflows' 10,000 steps (ADR 0005).

## Update, 2026-10-19 (ADR 0007)

- A definition may state its `scope`: what the dataset holds and what it leaves out. A dataset
  with a taxonomy must.
- A record type with `taxonomy: { decide: true }` gets the decided fields `shelf`, `functions`, and
  `features` from the dataset's taxonomy, in place of a decided enum, never both. It can't declare
  those names, or `category`.
- A source can fix its pages' shelf (`fixed.shelf`, a slug or a name) or read it with a selector
  (`extract.shelf`).
