# 0007. The living taxonomy

- Status: proposed with the living taxonomy
- Date: 2026-10-19

## Context

Run 1 of Crowdio's dataset left 120 questions. The owner's first answers showed that five flat
categories can't hold the catalog: speaker amps belong under amplifiers, a source that works as a
DAC is a DAC, preamps and phono stages need homes of their own, and some products do several
things. The owner wants Spatula to be the data's architect: to propose and evolve the schema it
fills, under governance, and to backfill from what it has already read (ADR 0008).

## Decision

**The model.** A dataset whose record type says `taxonomy: { decide: true }` keeps a taxonomy in
Spatula, beside its scope statement (ADR 0002):

- shelves, a tree of at most two levels, a category and its subcategories. A product sits on
  exactly one: a subcategory when one fits, otherwise the category;
- functions, what a product can do in a signal chain. A shelf can imply functions, and every
  product on it has them;
- features, filters that belong to shelves and pass down to their subcategories, each taking one
  value or several.

Every shelf, function, feature, and value has a stable ID (`tx_` and 20 base32 characters), a
slug, a name, and a description. A rename keeps the ID, and an ID is never reused. A retired item
stays listed, so a reader can resolve old IDs. Slugs are unique within each kind, retired items
included. `none` is never a shelf's slug: it's the answer for "None of these".

**Versions.** `pnpm spatula taxonomy seed` makes version 1 once. Each applied change, or batch of
changes, makes the next version, kept whole with what it applied and who applied it, and committed
by compare-and-set on the version it was based on. Renames, moves, merges, splits, retirements, and
restores record their migration. Undo applies the inverse as a new version; history is never
rewritten. Undoing a merge or a retirement brings the item back with a `restore` migration, whose
`to` repeats its `from`: readers clear its retirement, and records point back through their own
values. Undoing that undo retires the item again, by a `retire` migration: it doesn't merge it
again, so a person's answer about it reopens rather than carrying over to the item it was merged
into. The definition owns the scope. A definition with a new scope makes a new version with that
scope, and seeding refuses a file whose scope differs from the definition's. A proposal can't be
edited into a scope change, and a version that changed the scope can't be undone.

**Deciding a page.** One question with three parts: the shelf, the functions beyond those the shelf
implies, and the values of the features on the shelf. Rules come first: a person's shelf, then a
source's `fixed.shelf` or `extract.shelf`, then a JSON-LD category every product on the page
states, each naming exactly one live shelf by slug or name. The decider gives every option a
probability, by slug, and code maps the slugs to IDs. Each part is accepted on its own at
`decisions.classify.accept`:

- a shelf at the threshold; else a category whose family adds up to it, with the subcategory left
  open, holding nothing up;
- a function or a value at the threshold, rejected at one minus it, and asked in between.

Only an unknown shelf keeps a record out of the snapshot. A page has at most one open question,
covering only its uncertain parts. A decision is found again by the page's state, the rule's shelf,
and the taxonomy key of the shelf it put the page on: the shelf's category and its subcategories,
every function, and the features on any of them, each with its description. A page on no shelf, or
on none, has a key over the scope and the categories. A change asks a page again only when it
changes its key.

**People's answers carry over.** A person answers each part, and their answer is a `human`
statement. A merge moves nothing: a statement naming a merged item counts as the item it merged
into when records are built, so answers keep their author and undoing the merge needs nothing moved
back. A person's shelf retired since is decided again, and the question reopens showing their
answer; a decider's sure shelf publishes meanwhile. A person's "None of these" stands until the
page's top-level key changes; then, if the decider finds a shelf, the question reopens for them and
the page stays out until they answer. Functions and values a person left unticked aren't
statements, and aren't asked again while they still apply. A person's answer is their whole word
about the page: what their earlier answer decided, and a later question doesn't ask again, joins
what they answer then, so answering a later question keeps the first, whoever answers it. An answer
changes only the parts its question asks. When a person has answered about the page since the
question was asked, as with an older question reopened for the owner, every other part is the page
as it stands: that answer, and what a run settled after it, never what the older question had
settled then. What a later run settled becomes the answering person's answer, as a fresh answer's
settled parts do. While the shelf a person gave since is retired, or "None of these", an answer
that doesn't ask the shelf is refused (409).

**Evolving the taxonomy.** Every run of a seeded taxonomy dataset ends with a review, after it
publishes and before it finishes: one call to the Worker's LLM reads the run's evidence, summed up,
and proposes changes. Code checks each one. It must be a change Spatula takes, apply to the current
version, and change something, so names stay unique among siblings, shelves go two levels deep at
most, and every item gets a stable ID. A new shelf needs at least 3 of the dataset's own pages
behind it, and a clause of the scope statement's in-scope part quoted. A seeded shelf isn't proposed
for retirement until it held products and lost them, or six months passed. A change identical to an
open, rejected, or applied one isn't proposed again. What passes stays open for the owner. What
fails is kept as dropped, with the reason, where only the owner sees it. The review leaves out pages
whose site says `ai-input=no`, and is skipped when the run's budget is spent; the run's summary says
why.

If the model call fails, the run goes on: the review proposes nothing and leaves a note in the
run's summary. A step that runs again after it finished asks nothing and counts no tokens. One that
crashed after the model answered, but before its result was saved, may ask once more: an accepted
at-least-once limit, as with the run's other LLM steps.

**Earned autonomy.** A new subcategory under a category that already has subcategories (its first
ones are a split), a new feature, a new value, and a sharper description (not a function's) can
apply on their own once 10 of the kind have been accepted in a row, unedited, by someone allowed to
approve the kind: the owner, or for the first three a consumer's reviewer granted
`taxonomy:approve-additive` (ADR 0009). Spatula's own changes don't count. Only a run's own
proposals apply on their own: one left open by an earlier run waits for a person. An edit or a
rejection resets the count, and so does undoing a change Spatula applied on its own. The owner can
revoke a kind at any time. When Spatula applies one, it checks again, under the dataset's lock, that
the kind is still earnable, its run is long enough, and the change is as proposed; otherwise the
proposal stays open. A new category, a rename, a merge, a split, a move, a retirement, and any
change to the functions list are always the owner's. Every change Spatula applies is in the run's
summary and the console's history, with an undo.

**Snapshots.** A snapshot carries the full current taxonomy, with every migration since version 1,
and each record its `shelf`, `functions` (implied ones included), and `features`, with their
provenance. `category`, the top-level shelf's name, stays for one release. The taxonomy's version is
part of the records' digest, so a taxonomy change publishes. The contract's example is
`platform/core/src/testing/example-taxonomy-snapshot.json`, written by the serializer that
publishes.

## Consequences

- Deciding a page stays one decider call, with a longer answer. The review is one call per run, and
  a failed call never fails the run.
- A taxonomy change re-decides only the pages it touches, from their captures (ADR 0008).
- Datasets whose record type keeps a decided enum work as before.

## Update, 2026-10-22

A description no longer applies on its own: it applies only on the owner's approval, because its
text reaches later prompts as trusted text. A change applied under earned autonomy puts its text
into the taxonomy, and the taxonomy sits in the trusted part of every later decider and review
prompt; a description is the freest of the kinds that were earnable, with no new item and no page count
behind it. Earned autonomy now covers a new subcategory, a new feature, and a new value. A
description stays proposable, and the owner can still approve, edit, or reject it. Migration 0012
narrows the stored kinds to those three; marking text that was applied on its own as untrusted in
the prompts is a later change.
