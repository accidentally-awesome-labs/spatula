# 0004. Publication and consumers

- Status: proposed with slice 1
- Date: 2026-10-12

## Context

Slice 0 published every changed snapshot at once, and only the owner could read it. Crowdio
applies what Spatula publishes to its catalog, so a bad snapshot reaches people. The spec asks
for gates, held snapshots, consumer tokens, and signed acknowledgments.

## Decision

- **Gates.** A snapshot publishes only when its dataset's approval preset and the removal guard
  allow it:
  - `auto` publishes unless the guard trips;
  - `balanced` (the default) also holds the dataset's first publication, and the first after its
    definition changed, which is when new sources and fields arrive;
  - `manual` holds every snapshot.

  The guard trips when a snapshot drops more of the last published records than
  `gates.maxRemovals` allows: more than `count` (default 25), or more than `share` (default 5%),
  as Crowdio's sync counts.

- **Held snapshots wait in the database, not in a waiting Workflow.**
  - A held snapshot's records wait in R2 under `datasets/<id>/held/`, with no generation, and a
    question for the owner.
  - A newer run supersedes it, whether that run holds a snapshot of its own, publishes one, finds
    the published records again, or finds no record complete. One that builds the same records
    again leaves it held. A superseded snapshot can't be published.
  - Publishing it moves the head generation compared and set, like any publication, so it takes
    the next generation, never one already taken. Publishing or discarding it closes its
    question in the same transaction.
- **One run at a time.** A start while another run of the dataset is going is refused (409), and
  that run is named. A run still going after six hours counts as dead. A run whose Workflow
  stopped, or can't be found five minutes after its start, isn't going either: the next start
  records its failure and starts. A complete run stays complete; a failed one can still complete,
  as a Workflow replayed from its finished steps does. So an older run can't publish over a newer
  one's held snapshot, unless it keeps running past the six hours.
- **Consumers.** A dataset lists its consumers by name. Each has two Worker secrets:
  `CONSUMER_<NAME>_TOKEN_HASH` (the SHA-256 of its bearer token) and `CONSUMER_<NAME>_HMAC_KEY`,
  where the name is the consumer's, in capitals, with underscores for hyphens.
  - A consumer's token opens exactly two routes: the snapshot read,
    `GET /datasets/:id/snapshots/:generation` (`latest`, or a generation number), and the
    acknowledgment. It reads only the snapshots of the datasets that list it.
  - Any other method or path under `/datasets`, including routes added later and `HEAD`, is the
    owner's alone.
  - A consumer with a token hash but no HMAC key can read, and its acknowledgments answer 503.
- **Acknowledgments.** A consumer reports each snapshot it applied or refused with
  `POST /datasets/:id/acknowledgments`:
  - `{ generation, snapshotId, outcome, sentAt, detail?, counts? }`, where `outcome` is `applied`
    or `refused`, signed with HMAC-SHA256 over the exact bytes sent, in
    `x-spatula-signature: sha256=<hex>`;
  - at most 16 KiB (413), with `sentAt` within 10 minutes of Spatula's clock, against replays;
  - kept once per consumer and generation: the same body again is a repeat, and a different one
    is refused (409). "The same" means the same bytes, so a new `sentAt` makes another body: the
    first is kept, and the second answers 409.
- **Status.** `pnpm spatula status <dataset>` shows the head generation, what's held, what waits for
  review, and what each consumer last acknowledged.
- **Measuring.**
  - A dataset's golden set lists products a person checked against sources Spatula doesn't read,
    by the pages Spatula reads for them.
  - `pnpm spatula eval <golden.json>` scores the latest snapshot's matching precision and recall,
    and its identifiers' and key specs' accuracy, against Crowdio's ADR 0021 targets (99%, 90%,
    98%, 98%), and lists what missed.
  - Accuracy counts the values a record states: a value it leaves out is reported as coverage,
    not counted as wrong, and a target with values left out and none stated isn't met.
  - The CLI floors each share to one decimal, so a score just under its target never reads as the
    target.
  - `--save` keeps the score, and `pnpm spatula evals` shows their history. A saved score's
    generation and golden-set version are at most 999,999,999, and the scores at most 512 KiB.
  - Scoring runs in the CLI, so the golden set never lives in the Worker. The CLI reads the
    dataset's pages from `GET /datasets/:id/items`, to find each golden product's record. That
    route and `GET /datasets/:id/evals` answer 404 for a dataset that doesn't exist.

## Consequences

- A snapshot that would remove too much, or (unless the approval is `auto`) that comes from a
  changed definition, never reaches Crowdio without a person's yes.
- Consumers' tokens and keys rotate by setting the secrets again.
- Acknowledgments are evidence of consumption, which the pilot's verdict counts.
- Held drafts, and the file of a publish attempt that lost a race, stay in R2. Nothing reads
  them; a later slice's cleanup deletes them.
