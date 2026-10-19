/*
 * Refusals across runs (ADR 0006). Each answer a site gives says whether Spatula got through, was
 * refused, or neither: an outage, no answer at all, or a request the gate held back for a rule the
 * site states. robots.txt is one of the site's answers: when it refuses Spatula, whatever else says
 * nothing reads as a refusal too. A run is blocked for a source when nothing of the source got
 * through and something refused. Three blocked runs in a row refuse the source, and later runs only
 * probe it. Blocked runs also stretch the source's interval, so Spatula only ever gets gentler with
 * a site that refuses it.
 */

/** What one answer says: Spatula got through, or the site refused it. */
export type SiteAnswer = 'through' | 'refused';

/** How a run went for a source, from every answer its sitemaps and pages got. */
export type SourceVerdict = 'through' | 'blocked' | 'untouched';

/** What a refused source's probe met, when it didn't get through: a refusal, or no answer either way. */
export const SOURCE_PROBES = ['blocked', 'no answer'] as const;
export type SourceProbe = (typeof SOURCE_PROBES)[number];

/** Blocked runs in a row that refuse a source. */
export const REFUSE_AFTER_RUNS = 3;

/** The most that blocked runs stretch a source's interval: four times the definition's. */
export const MAX_INTERVAL_FACTOR = 4;

/**
 * What an answer says of the site. The answer speaks first. A refusal is a challenge, a 401, 402,
 * or 403, or a 429, and any other status below 500 got through, a 404 included: the site answered.
 * An answer with nothing of its own to say, a 5xx or no answer (which covers a request the gate held
 * back, for a rule the site states or because robots.txt couldn't be read), reads as a refusal when
 * the host's latest answer to robots.txt was one, and says nothing either way otherwise. So
 * robots.txt can add a refusal, and never turns a page that got through into one.
 */
export function siteAnswer(input: {
  /** The status the host answered with, or null when no answer came or nothing was sent. */
  status: number | null;
  /** Whether the answer was a challenge page. */
  challenge: boolean;
  /**
   * Whether the host's latest answer to robots.txt refused Spatula: a challenge, a 401 to 403, or a
   * 429. The gate says so with each decision.
   */
  robotsRefused?: boolean;
}): SiteAnswer | null {
  const { status } = input;
  if (status !== null) {
    if (input.challenge || [401, 402, 403, 429].includes(status)) return 'refused';
    if (status < 500) return 'through';
  }
  return input.robotsRefused === true ? 'refused' : null;
}

/**
 * A run's verdict for a source: through when anything got through, blocked when nothing did and
 * something refused, and untouched otherwise. That covers a source the run didn't ask, and one
 * that met only outages.
 */
export function sourceVerdict(answers: readonly (SiteAnswer | null | undefined)[]): SourceVerdict {
  if (answers.includes('through')) return 'through';
  if (answers.includes('refused')) return 'blocked';
  return 'untouched';
}

/**
 * A source's interval after `blockedRuns` blocked runs in a row: the definition's, doubled for each,
 * up to MAX_INTERVAL_FACTOR times.
 */
export function sourceIntervalMs(perHostIntervalMs: number, blockedRuns: number): number {
  return perHostIntervalMs * Math.min(2 ** Math.max(0, blockedRuns), MAX_INTERVAL_FACTOR);
}
