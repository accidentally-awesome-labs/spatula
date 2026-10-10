# 0002. Dataset definitions

- Status: accepted (slice 0 subset)
- Date: 2026-10-09

## Context

Owners declare each dataset in their own repository, preview the change, then apply it (ADR
0001). The spec left the format open until the first slice.

## Decision

A definition is YAML, sent as JSON, and checked by `@spatula/core`'s `definitionSchema` in the
CLI and again in the API. It has four parts.

- **`dataset`:** a slug, up to 63 characters. It also names the snapshots' `project`.
- **`recordTypes`:** exactly one, for now. Each has:
  - an optional `pack`, such as `products/product`, that reads its fields from structured data;
  - `identity`: `identifiers` (fields marked `identifier: true`, strongest first) and `keys`
    (groups of single text or enum fields, such as `[brand, name]`);
  - `fields`, each with a `type` (`text`, `enum`, `gtin`, `url`, or `specs`), and `required`,
    `list`, `identifier`, `scope` (the field an identifier is compared within), `values` (for
    an enum), `maxLength` (for text), `llm`, and `description`.
- **`sources`:** each a list of `pages` on https, with:
  - `fixed` values that every record from the source carries, such as the brand of a maker's
    own store;
  - `extract` rules a person declares: `{ css, attr? }` for an element's text or attribute, or
    `{ url: canonical }` for the page's own address.
  - A declared value or rule replaces whatever the pack would read for that field. If a declared
    rule finds nothing, the field is missing: Spatula never falls back to a weaker guess.
  - `evidence`: when robots.txt and the terms were checked, and what the terms say about
    automated access. A source whose terms forbid it is refused.
- **`policy`:** `purposes` (the Content Signals uses the dataset makes, such as `ai-input` for
  LLM extraction), and `perHostIntervalMs`, at least 1000.

Unknown keys are errors, so a misspelling never passes silently. Identity fields can't be filled
by the LLM. The LLM fills only `specs` fields in this version.

## Consequences

Budgets, freshness, gates, consumers, and other source kinds (sitemaps, feeds, APIs) are refused
until the slices that add them. That's a clear error, not a silently ignored key.
