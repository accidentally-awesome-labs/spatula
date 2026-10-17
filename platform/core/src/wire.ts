import type { Question } from './decisions';
import type { Outcome } from './gate';
import type { Excluded } from './snapshot';

/*
 * What the API and the CLI exchange. The store and the Worker produce these shapes; the CLI only
 * reads them.
 */

/** What applying a definition changes, or would change on a dry run. */
export interface ApplySummary {
  dataset: string;
  /** The definition's revision after applying; it moves only when the definition changes. */
  revision: number;
  created: boolean;
  changed: boolean;
  sources: { added: string[]; removed: string[]; changed: string[] };
  pages: { added: number; removed: number };
}

/** What a run's snapshot step did. */
export type PublishResult =
  | {
      published: true;
      generation: number;
      snapshotId: string;
      records: number;
      excluded: Excluded[];
    }
  | {
      published: false;
      reason: string;
      excluded: Excluded[];
      /** The snapshot held for the owner's review, when the gates held one. */
      held?: { snapshotId: string; records: number; reasons: string[] };
    };

/** What reading the sitemap sources found. */
export interface DiscoverySummary {
  sources: number;
  sitemaps: number;
  listed: number;
  added: number;
  revived: number;
  missing: number;
  gone: number;
  /** Sources whose read wasn't complete, with why. Nothing of theirs was marked missing. */
  incomplete: string[];
}

/** What a run's decisions of one kind came to (ADR 0003). */
export interface DecisionSummary {
  /** Answered by a rule. */
  rule: number;
  /** Answered by a decider sure enough to accept. */
  accepted: number;
  /** With a person: sent this run, or sent before and still open. */
  escalated: number;
  /** Answered before on the same evidence, or by a person, and applied again. */
  reused: number;
  /** Left for the next run, because the run's LLM budget was spent. */
  skipped: number;
  /** Left for the next run, because the decider failed. */
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

/** What a refresh did. */
export interface RunSummary {
  /** The pages read this run. */
  items: number;
  /** The live pages when the run planned, and how many of them were due. Absent in runs from before slice 1. */
  live?: number;
  due?: number;
  /** What the sitemap sources listed. Absent in runs from before slice 1. */
  discovery?: DiscoverySummary;
  /**
   * Pages left unread because their source kept blocking, by source. They stay due, so an ordinary
   * run's next one reads them; a run that counted every page as due (--all) promises nothing.
   */
  paused?: Record<string, number>;
  fetches: Record<Outcome, number>;
  statements: { added: number; reseen: number; withdrawn: number };
  llm: {
    ran: number;
    reused: number;
    skipped: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
  };
  /** The run's classifications. Absent in runs before slice 1. */
  classify?: DecisionSummary;
  /** The run's match questions. Absent in runs before slice 1. */
  match?: DecisionSummary;
  /** Pages this run found aren't the dataset's ("None of these"). */
  irrelevant?: number;
  entities: {
    created: number;
    linked: number;
    conflicts: number;
    unresolved: number;
    /** Pages waiting for a match question to be asked or answered. Absent before slice 1. */
    waiting?: number;
  };
  snapshot: PublishResult;
  /** What deserves a look, such as an LLM failure or an identity conflict: at most 50. */
  notes: string[];
}

export type RunStatus = 'running' | 'complete' | 'failed';

/** A run as the API returns it. */
export interface RunView {
  id: string;
  datasetId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: RunSummary | null;
  error: string | null;
}

/** A question waiting for a person, as the API lists it. */
export interface ReviewView {
  id: string;
  kind: 'classify' | 'match' | 'publication';
  /** What it's about: a page, a page and an entity, or a held snapshot. */
  subject: string;
  question: Question;
  /** What the person needs to answer: addresses, the proposal and its probabilities, counts. */
  context: Record<string, unknown>;
  createdAt: string;
}
