import { parsePage, type Source } from '@spatula/core';
import {
  latestCapture,
  latestFetchId,
  latestRead,
  markForFetch,
  type CaptureRow,
  type ItemRef,
} from '@spatula/store';
import { readCapture, readPageBody } from './captures';
import type { Classified, ClassifyFetch } from './classify';
import type { Context, LlmState, RefreshPorts } from './pipeline';
import { decideTaxonomy, factsOf, keepOut, taxonomyTarget, type PageFacts } from './taxonomy';

/*
 * Backfill (ADR 0008). A taxonomy change can change the question a page was asked, which the page's
 * key covers (ADR 0007). Each run of a taxonomy dataset decides those pages again from their
 * captures, with no request: a live page whose key the taxonomy no longer has, and a page out of
 * the dataset whose key it no longer has, or that went out before the taxonomy and has none. A page
 * with no capture to read is marked due, and the next run fetches it. A person's "None of these"
 * keeps a page out until they answer again (ruling 7), so such a page with no capture has its
 * question reopened instead: fetching it would put it back first.
 */

/** Decides a page again, from its capture, as the run's taxonomy has it now. */
export async function backfillPage(
  context: Context,
  item: ItemRef & { status: 'live' | 'irrelevant' },
  llm: LlmState,
  ports: RefreshPorts,
): Promise<{ outcome: 'decided' | 'fetch' | 'skipped' | 'failed'; classified?: Classified }> {
  const target = taxonomyTarget(context.definition, item);
  if (target === null) return { outcome: 'skipped' };
  // A page a person took out stays out, live or not: a page revived since is placed again as the
  // irrelevant page it is (ruling 7), whichever it is loaded as.
  const tookOut = await keepOut(context, item, ports);
  const irrelevant = item.status === 'irrelevant' || tookOut;
  const captured = await fromCapture(ports, target.source, item);
  const decided =
    captured !== null
      ? await decideTaxonomy(context, item, captured.fetched, llm, ports, {
          extractionComplete: false,
          facts: captured.facts,
          irrelevant,
        })
      : tookOut
        ? await reopenNone(context, item, ports)
        : null;
  if (decided === null) {
    await ports.withDb((db) => markForFetch(db, [item.id]));
    return { outcome: 'fetch' };
  }
  return {
    outcome:
      decided.outcome === 'skipped' || decided.outcome === 'failed' ? decided.outcome : 'decided',
    // A page that was out and stays out isn't found out again.
    classified: { ...decided, irrelevant: decided.irrelevant && !irrelevant },
  };
}

/**
 * The page as its capture shows it, as a fetch's result: its latest read's fetch, signals, and
 * time, with what deciding reads of the page. Null when no capture holds the copy the page's
 * statements came from, or the copy's body is gone or can't be read.
 */
async function fromCapture(
  ports: RefreshPorts,
  source: Source,
  item: ItemRef,
): Promise<{ fetched: ClassifyFetch; facts: PageFacts } | null> {
  const { capture, read } = await ports.withDb(async (db) => ({
    capture: await latestCapture(db, item.id),
    read: await latestRead(db, item.id),
  }));
  if (capture === null || read === null || read.signals === null) return null;
  if (capture.contentHash !== item.contentHash) return null;
  const facts = await capturedFacts(ports, source, capture);
  if (facts === null) return null;
  return {
    fetched: {
      fetchId: read.id,
      contentHash: capture.contentHash,
      finalUrl: capture.finalUrl,
      signals: read.signals,
      captureId: capture.id,
      // Its statements count as seen at its last fetch, as a page read again does (ruling 9).
      seenAt: read.startedAt.toISOString(),
    },
    facts,
  };
}

/**
 * What deciding reads of a captured page: the read kept with the capture, or, when the source's
 * shelf rule needs a selector, the body parsed whole.
 */
async function capturedFacts(
  ports: RefreshPorts,
  source: Source,
  capture: CaptureRow,
): Promise<PageFacts | null> {
  if (source.extract.shelf === undefined) {
    const read = await readCapture(ports, capture);
    return read === null ? null : { page: read };
  }
  const body = await readPageBody(ports.blobs, capture.contentHash);
  if (body === null) return null;
  try {
    return factsOf(source, parsePage(new TextDecoder().decode(body), capture.finalUrl));
  } catch {
    // A page that nests too deep can't be read (ADR 0005): a fetch is what's left.
    return null;
  }
}

/**
 * Reopens a person's "None of these" about a page no capture shows. No decider is asked: it can't
 * read the page without a fetch. The question asks the shelf again, showing what they said, and the
 * page stays out until they answer. Null for a page never fetched, which has no answer to reopen.
 */
async function reopenNone(
  context: Context,
  item: ItemRef & { status: 'live' | 'irrelevant' },
  ports: RefreshPorts,
): Promise<Classified | null> {
  const fetchId = await ports.withDb((db) => latestFetchId(db, item.id));
  if (fetchId === null) return null;
  return decideTaxonomy(
    context,
    item,
    {
      fetchId,
      contentHash: item.contentHash,
      finalUrl: item.locator,
      signals: {},
      captureId: null,
    },
    { usdLeft: 0, down: {} },
    { ...ports, taxonomyDecider: null },
    {
      extractionComplete: false,
      // All that's known of the page without it: its address.
      facts: { page: { url: item.locator, title: null, breadcrumbs: [], jsonLd: [] } },
      irrelevant: true,
    },
  );
}
