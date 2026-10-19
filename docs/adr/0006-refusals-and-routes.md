# 0006. Refusals and routes

- Status: proposed with phase 1 of refusals and routes
- Date: 2026-10-18

## Context

Slice 1's first full run (2026-10-18) read four of its six makers cleanly. Sennheiser's and Audeze's
storefronts answered Spatula's Worker with Cloudflare challenges: both makers' sitemaps, and the two
Audeze pages the run asked for. The spec said repeated blocks mark a source as refused, but a source
only paused for the rest of a run (ADR 0005), so every run would knock on the same doors at the same
pace.

The run showed a second gap. The definition's new revision replaced Sennheiser's two sources with
one, and applying it excluded the old sources' 11 pages, history and all, so the run's snapshot
dropped their records.

## Decision

- **Three kinds of "no".**

  | Kind          | What it looks like                                                                                       | What Spatula does                                                                                                                                                            |
  | ------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | A stated rule | robots.txt disallows the page; the terms forbid automated access; Content Signals; a 402 (pay per crawl) | Never crossed, by any route, and recorded.                                                                                                                                   |
  | A challenge   | A 401 or a 403, or a challenge page                                                                      | Recorded, and the host backs off. Counts toward refusal. Once Spatula is verified, a challenge counts as a stated rule.                                                      |
  | Strain        | A 429, a 5xx, or no answer                                                                               | The host backs off (ADR 0005). A 429 counts toward refusal. A 5xx or no answer is an outage, and doesn't count by itself (robots.txt's answer, below, is the one exception). |

  A 402 counts toward refusal as a challenge does, but it's a stated rule: a site that asks to be
  paid has said how it may be read, so no route goes around it.

- **Where a fact may come from, in order.**
  1. The maker: its own site, and its sanctioned channels (sitemaps, product JSON, APIs, feeds).
  2. Other honest sources that allow Spatula: authorized retailers, affiliate feeds, GS1, and
     Wikidata, each with its own robots.txt and terms evidence, and its own pacing. None is built
     yet: phase 2 adds retailers first.
  3. An intermediary, Firecrawl's `basic` proxy or Cloudflare's Browser Run, under all of these:
     - only for facts still missing;
     - only after a challenge;
     - only while Spatula is unverified (Cloudflare doesn't list it as a verified bot);
     - only for a source whose definition opts in by name.

     It isn't built. It comes only if a refused maker stays uncovered by the first two.

- **Never, by any route:**
  - crossing a stated rule;
  - solving CAPTCHAs;
  - residential or rotating proxies;
  - Firecrawl's `enhanced`, `stealth`, or `auto` proxies;
  - imitating a browser's identity;
  - archives and search caches of a refusing site.

- **A source's standing across runs.**
  - **Blocked.** A run is blocked for a source when both hold:
    - it read nothing of the source, neither a page nor a sitemap;
    - at least one of the source's answers (robots.txt included) was a challenge, a 401 to 403,
      or a 429.
  - **robots.txt's answer.** robots.txt answers for its whole host, so it counts among the answers
    of each source on that host:
    - While a host's latest robots.txt answer is a challenge, a 401 to 403, or a 429, an answer on
      that host that says nothing itself (an outage, a stated rule, or a request held back) counts
      as a refusal. An answer that got through still counts as getting through.
    - Which requests go doesn't change. A 429 on robots.txt holds the host back until it answers,
      as before; a 401 to 403 leaves the host without rules (RFC 9309).
  - **The count.** Anything that got through resets the count, a 404 included: the site answered.
    An outage leaves the count where it was, and so does a source the run didn't ask.
  - **Pacing.** Each blocked run in a row doubles the interval on the source's hosts for the next
    run, up to four times the definition's. The first clean run restores it.
    On a host that a live source shares, each request keeps its own source's interval.
  - **Refused.** Three blocked runs in a row refuse the source:
    - The run plans none of its pages, under `--all` too. They stay live with their last values,
      so blocks never remove a record.
    - Each run sends one probe: the source's first sitemap, or its least recently read page.
    - A probe that gets through makes the source live again before the run plans its pages, so the
      same run reads its due pages.
    - A probe that doesn't leaves the source refused, and the run says what it met.
  - **A page's own refusal.** A page is still refused after three blocks of its own (ADR 0005), but
    only blocks in runs where its source got through count. When a run that was blocked for a
    source, or only probed it, is counted, each page it blocked starts its count of blocks again,
    and a page those blocks refused is live again. So the source's pages stay live with their last
    values while the source is blocked or refused, and a refused pages source keeps its pages to
    probe. A run that fails before it's counted keeps the refusals its blocks made, until
    `spatula revive --refused`.
  - **Partial blocks.** A run in which anything of a source gets through, a sitemap included,
    counts as getting through for that source. So a page the site challenges in three such runs
    in a row is refused on its own, and leaves the snapshot until it's revived (ADR 0005). A site
    that serves its sitemaps but challenges every page is the plainest case.
  - **Counted once.** A run's `sources` step counts its verdicts once, however often the step
    runs (`sources.counted_at`). A repeat reports what the first count reported and changes
    nothing, and a run older than the last one counted counts nothing.
  - **A refused source stays at three.** A probe that doesn't get through counts no further run,
    so the status reads "after 3 blocked runs" however long the source stays refused. Only a
    blocked run refuses a source, and a probe's date and what it met are kept only while the
    source is still refused.
  - **The owner's view.** `spatula status` shows each blocked or refused source.
    `spatula revive <dataset> --source <id>` puts one back.

- **Identity.**
  - **The address.** Spatula's Worker serves `spatula.run`: the public page, the key directory,
    and the API.
  - **The user agent** is `Spatula/<version> (+https://spatula.run)`.
  - **Signatures.** Requests sign with `Signature-Agent: "https://spatula.run"`.
  - **The contact.** The page names `bot@spatula.run`.
  - **Verification.** The owner applies to Cloudflare as a verified bot:
    - verification by Request Signature;
    - category Data Collection.

    The `VERIFIED_BOT` variable records the verdict.

- **Replacing a source.**
  - **Moved.** Applying a definition moves a removed source's pages to the one remaining source
    that covers their address. Each keeps its history, where before it was excluded.
  - **Kept as it was.** A moved page keeps its status, its statements and their history, and its
    links to records. It takes its new source's record type, and loses only its listing fields,
    which reset. A page that is gone, refused, or out of the dataset ("None of these") stays so,
    and a page that `apply` had excluded comes back live. Excluding a page forgets the status it
    had, so a page of a source removed earlier comes back live even if it was gone, refused, or
    out of the dataset then; its next read decides again.
  - **Spelling.** A pages source takes a page only under the spelling it lists. A page moved into a
    sitemap source keeps its own spelling: if discovery spells the address differently, it adds
    its own page, and the moved one turns gone after three complete reads, its history kept.
  - **Earlier removals.** Pages that an earlier apply excluded move the same way, at any later
    apply. `spatula plan` mentions them only when they move.
  - **Left excluded.** These pages stay excluded, and `spatula plan` counts them by reason:
    - a page two sources cover;
    - a page no source covers;
    - a page whose new source already has a page at that exact address, or is a pages source
      that lists it only under another spelling.

## Consequences

- **Gentler only.** Spatula only ever gets gentler with a site that refuses it, and a refusing
  source costs a run one request, besides robots.txt when it's due.
- **"Never escalate," narrowed.** The spec's "Never escalate" now means the rules above: one day,
  an intermediary may meet a challenge, within the limits of the third route. Nothing else changes.
  - That route changes the legal footing, so the lawyer's review before launch covers it.
  - Building it means updating the public page, which today says Spatula never tries to get
    around a block.
- **Verification closes it.** Once Cloudflare verifies Spatula, every challenge is a stated rule,
  and the intermediary route closes for good.
- **Phase 2**, with slice 2, adds retailers as sources that cover refusing makers.
