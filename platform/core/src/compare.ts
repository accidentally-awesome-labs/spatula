import { roundProbability } from './decisions';

/** One question a comparison asked, scored. */
export interface ComparedQuestion {
  decisionId: string;
  subject: string;
  /** Scored against a person's answer, or the current model's sure one. */
  column: 'person' | 'model';
  /** The candidate's call failed: its model and backup both. */
  failed: boolean;
  /** The candidate's likeliest answer is right: the same option, the same match outcome, or the same shelf. */
  right: boolean;
  /** Right in every part: the shelf, the functions, and the values (shelf placement); `right` otherwise. */
  allRight: boolean;
  /**
   * The lowest threshold at which the candidate's answer would be accepted: its outcome's
   * probability, or, for a placement, the least sure of its asked parts (a part's sureness is
   * max(p, 1 − p), the shelf's is its own chance).
   */
  sureness: number;
  usd: number;
  /** What the current decision cost, at its model's price; null when that price isn't known. */
  currentUsd: number | null;
  /** A placement that was given its shelf: its shelf counts as right whatever the candidate said. */
  givenShelf?: boolean;
  ms: number;
  /** The candidate's answer and the expected one, in words, for the report's list. */
  answered: string;
  expected: string;
}

export interface ComparisonColumn {
  questions: number;
  failed: number;
  right: number;
  /** Shelf placement only: right in every part. */
  allRight?: number;
  /** Accepted at the threshold, and not all right. */
  acceptedWrongly: number;
  /** Below the threshold: they would go to a person. */
  toPerson: number;
  usd: number;
  currentUsd: number | null;
  /** The questions whose current price isn't known: `currentUsd` leaves them out. */
  currentUnpriced?: number;
  medianMs: number | null;
}

export interface ComparisonReport {
  id: string;
  dataset: string;
  job: 'classify' | 'match';
  model: string;
  backup: string | null;
  accept: number;
  startedAt: string;
  finishedAt: string;
  skipped: number;
  /** It stopped at --max-usd before asking every question. */
  stoppedAtBudget: boolean;
  columns: { person: ComparisonColumn; model: ComparisonColumn };
  /** The lowest threshold at which at most 1% of what it accepts disagrees with a person; null under 30 answers or none. */
  suggestedAccept: number | null;
  /** Each disagreement with a person's answer, at most 200. */
  disagreements: { subject: string; answered: string; sureness: number; expected: string }[];
  /** All the disagreements with a person, of which `disagreements` lists the first 200. */
  disagreementCount?: number;
  notes: string[];
}

export const MAX_DISAGREEMENTS = 200;
/** The fewest person-answered questions a suggested threshold rests on. */
export const MIN_SUGGESTION_QUESTIONS = 30;
/** The share of what a threshold accepts that may disagree with a person. */
const SUGGESTION_TOLERANCE = 0.01;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function accepted(question: ComparedQuestion, threshold: number): boolean {
  return roundProbability(question.sureness) >= threshold;
}

function column(
  questions: readonly ComparedQuestion[],
  accept: number,
  placement: boolean,
): ComparisonColumn {
  const asked = questions.filter((question) => !question.failed);
  const known = questions.flatMap((question) =>
    question.currentUsd === null ? [] : [question.currentUsd],
  );
  const result: ComparisonColumn = {
    questions: questions.length,
    failed: questions.length - asked.length,
    right: asked.filter((question) => question.right).length,
    acceptedWrongly: asked.filter((question) => accepted(question, accept) && !question.allRight)
      .length,
    toPerson: asked.filter((question) => !accepted(question, accept)).length,
    usd: questions.reduce((total, question) => total + question.usd, 0),
    currentUsd: known.length === 0 ? null : known.reduce((total, usd) => total + usd, 0),
    currentUnpriced: questions.length - known.length,
    medianMs: median(asked.map((question) => question.ms)),
  };
  if (placement) result.allRight = asked.filter((question) => question.allRight).length;
  return result;
}

/** The lowest threshold, `floor` (at least 0.50) to 1.00, that accepts something and gets at most 1% of it wrong. */
function suggest(person: readonly ComparedQuestion[], floor: number): number | null {
  if (person.length < MIN_SUGGESTION_QUESTIONS) return null;
  for (let step = 0; step <= 50; step++) {
    const threshold = roundProbability(0.5 + step / 100);
    // No step may be looser than its job.
    if (threshold < floor) continue;
    const taken = person.filter((question) => accepted(question, threshold));
    if (taken.length === 0) continue;
    const wrong = taken.filter((question) => !question.allRight).length;
    if (wrong <= taken.length * SUGGESTION_TOLERANCE) return threshold;
  }
  return null;
}

/**
 * Scores a comparison's questions, pure. `accept` is the threshold the report is read at.
 * `placement` says the questions are shelf placements: only then does a column carry `allRight`
 * (the shelf, functions, and values all right). It is an input, not detected from the questions,
 * so a comparison of placements that happen to agree in every part still shows it.
 */
export function scoreComparison(input: {
  questions: readonly ComparedQuestion[];
  accept: number;
  placement?: boolean;
  /** The job's own threshold: no suggestion is looser. */
  floor?: number;
}): Pick<ComparisonReport, 'columns' | 'suggestedAccept' | 'disagreements' | 'disagreementCount'> {
  const placement = input.placement === true;
  const person = input.questions.filter((question) => question.column === 'person');
  const model = input.questions.filter((question) => question.column === 'model');
  const answered = person.filter((question) => !question.failed);
  const disagreeing = answered.filter((question) => !question.allRight);
  return {
    columns: {
      person: column(person, input.accept, placement),
      model: column(model, input.accept, placement),
    },
    suggestedAccept: suggest(answered, input.floor ?? 0.5),
    disagreementCount: disagreeing.length,
    disagreements: disagreeing.slice(0, MAX_DISAGREEMENTS).map((question) => ({
      subject: question.subject,
      answered: question.answered,
      sureness: question.sureness,
      expected: question.expected,
    })),
  };
}
