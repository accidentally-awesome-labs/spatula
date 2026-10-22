# 0008. The page archive

- Status: proposed with the page archive
- Date: 2026-10-19

## Context

Spatula is to become a dataset's architect: it proposes and evolves the taxonomy, and every such
change has to be applied to pages it has read already. Until now a change could only be applied by
fetching every page again, which costs a run hours of polite requests and asks sites that refuse
Spatula for pages it read before. A person reviewing a value had nothing to look at but the page as
it is now. So Spatula keeps what it reads.

## Decision

- **A capture is a page as a fetch found it.**
  - The body, gzipped.
  - What Spatula read from it, as `parsePage` reads it: the title, the breadcrumbs, the JSON-LD,
    the meta tags (OpenGraph included), the canonical address, and the text. Spatula reads no
    microdata yet; the kept body lets a later reader find it.
  - How it was fetched: the address, the final address, the status, the ETag and Last-Modified,
    the time, and the Content Signals that applied. A capture exists only for a fetch that
    robots.txt allowed; the fetch it names records that.
- **Storage.**
  - Bodies are filed in the `spatula-store` bucket under their SHA-256 as they arrived,
    `pages/<sha256>.gz`, so an unchanged page is stored once, whichever page or dataset holds it.
    Copies stored before the archive stay at `pages/<sha256>`, and still read.
  - What Spatula read is kept per capture, at `captures/<dataset>/<capture>.json.gz`.
  - The `captures` table indexes captures by page and time.
- **When a capture is made.** A fetch whose body differs from the page's stored copy makes one. A
  page read again unchanged, by its hash or by a 304, adds none. A page stored before the archive
  gets its first capture, of that copy, the first time it's read unchanged, so ordinary runs fill
  the archive for every page.
- **Evidence.** A statement cites the capture it was first found in. A value seen again keeps its
  citation, and a value from before the archive takes the capture that sees it again. When a
  capture goes, the statements that cited it stay, and cite none.
- **Retention.**
  - A page's latest capture is always kept.
  - An earlier capture is kept while it is both less than a year old and among the page's ten
    latest whose body differs from the latest one. An earlier capture of the latest body is a copy,
    and goes.
  - A capture a current statement cites is kept as long as the statement is current.
  - The `captures` step of every run deletes the rest, at most 1,000 a run, files first and rows
    after. A body's file goes only when no capture and no page, in any dataset, holds it. A cleanup
    that fails is a note in the run's summary, never a failed run.
- **Purging.** `pnpm spatula purge <dataset> --source <id>` deletes a source's captures (those of
  the pages it holds, and those taken under it), and forgets its pages' stored copies, for when a
  site asks, a policy changes, or a source is retired. It also deletes the copies its pages' fetches
  stored before the archive, and forgets the hashes those fetches logged, so a purge run again finds
  nothing left. It keeps the source's statements, which are facts, and refuses while a run of the
  dataset is going: run it again once the run has finished. It holds the dataset's lock while it
  works, the lock a run takes to start, so no run starts mid-purge. It leaves the source in the
  definition, whose next run would capture its pages again.
- **Reading history.** A later change reads a page again without fetching it: the store's
  `latestCapture` finds a page's capture, and the Worker's `readCapture` gives what Spatula read
  from it, made from the body when a capture has no read of its own.
- **Private evidence.** Captures never reach a snapshot, a consumer, or a consumer's route.
  Snapshots carry facts only.

## Consequences

- At about 30 KB a compressed page, 100,000 pages with ten captures each come to about 30 GB, under
  $0.50 a month in R2.
- A run's summary counts the captures it stored and cleaned up, and `pnpm spatula run --wait`
  prints them.
- The living taxonomy's backfill decides pages again from their captures, within a run's token
  budget, instead of fetching them.
- Storing page copies for processing is part of the lawyer's review before launch, with ADR 0006's
  intermediary route.
- **A known limit.** Bodies are shared by hash, so a capture recorded in another dataset at the very
  moment a cleanup deletes the same body would lose its file. That page then finds its stored copy
  missing: it's left unread that run, with a note, and fetched afresh the next, which stores its
  body again. The makers Spatula reads stamp every page, so their bodies differ between fetches,
  and this is left as it is.
- A run that stops between storing a page's body and recording its fetch can leave that body's file
  with nothing naming it, so neither cleanup nor a purge finds it.
- A purge finds the copies stored before the archive through the fetches of the pages a source holds
  now. Those of pages that have since moved away from the source can't be attributed to it, and
  stay.
- Sitemaps aren't archived: the pages they list are.

## Update, 2026-10-19 (ADR 0007)

- **Re-reading.** A page due only because its extraction is out of date, whose stored copy has a
  capture, is read again from the capture, with no request. Its statements count as seen at its
  last fetch. So applying a definition fetches nothing; `pnpm spatula run --all` still fetches.
- **Backfill.** Every run of a taxonomy dataset re-decides, from their captures, the pages whose
  taxonomy key a change has made stale: at most what the run's pages left of its page budget,
  within its LLM budget. A page without a capture is marked due, and the next run fetches it.
  `pnpm spatula run <dataset> --backfill` starts a run that only backfills, and publishes as usual.
