import { z } from 'zod';
import type { Definition } from './definition';
import type { LlmUsage } from './llm';

/*
 * Models and providers (ADR 0010). A model is named `provider/model`: the provider is one the
 * Worker's provider table knows, and the rest is the provider's own name for it, which may hold
 * more slashes (OpenRouter's do). A definition may name the models of each job that asks one; a
 * job it leaves out uses the deployment's default, LLM_MODEL. Classify and match take up to three
 * steps, each with an optional backup and threshold: doubt moves a question to the next step, and
 * a failed call moves it to the step's backup. Extraction and the taxonomy review take one model
 * and an optional backup, since they give no probabilities to escalate on.
 */

/**
 * A model's name: a provider slug, a slash, and the provider's own name, 1 to 200 visible ASCII
 * characters that don't start with a slash.
 */
export const MODEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}\/[\x21-\x2e\x30-\x7e][\x21-\x7e]{0,199}$/u;

export const JOBS = ['extract', 'classify', 'match', 'taxonomyReview'] as const;
export type Job = (typeof JOBS)[number];
/** The jobs that give probabilities, and so take steps and thresholds. */
export type DecidingJob = 'classify' | 'match';

/** At most this many steps for classify or match. */
export const MAX_STEPS = 3;

export interface ModelStep {
  model: string;
  /** Asked only when the model's call fails, or its provider is down. */
  backup: string | null;
  /** The step's own threshold, at least the job's; null for the job's. Classify and match only. */
  accept: number | null;
}

/** Dollars per million tokens, in and out. */
export interface ModelPrice {
  input: number;
  output: number;
}

/** One call to a model, as a run counts it. A failed call counts no tokens. */
export interface ModelCall {
  model: string;
  inputTokens: number;
  outputTokens: number;
  failed: boolean;
}

/** A provider marked down for the rest of a run: since when, and why. */
export interface Down {
  at: string;
  reason: string;
}
export type DownMarks = Record<string, Down>;

/** What one model cost a run in one job. */
export interface ModelSpend {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export function providerOf(model: string): string {
  const at = model.indexOf('/');
  return at < 0 ? '' : model.slice(0, at);
}

/** The provider's own name for the model: everything after the first slash. */
export function providerModel(model: string): string {
  return model.slice(model.indexOf('/') + 1);
}

/** The adapter name a decision records for a model's answer. */
export const adapterName = (model: string): string => `llm:${model}`;

const modelName = z
  .string()
  .regex(MODEL_NAME, 'Name a model as provider/model, as in anthropic/claude-opus-5-5.');
const threshold = z.number().min(0.5).max(1);
const stepSchema = z.union([
  modelName,
  z.strictObject({ model: modelName, backup: modelName.optional(), accept: threshold.optional() }),
]);
const singleSchema = z.union([
  modelName,
  z.strictObject({ model: modelName, backup: modelName.optional() }),
]);

/** The definition's `models:` section. */
export const modelsSchema = z.strictObject({
  extract: singleSchema.optional(),
  classify: z.array(stepSchema).min(1).max(MAX_STEPS).optional(),
  match: z.array(stepSchema).min(1).max(MAX_STEPS).optional(),
  taxonomyReview: singleSchema.optional(),
});
type Models = z.output<typeof modelsSchema>;
type Named = string | { model: string; backup?: string | undefined; accept?: number | undefined };

function stepOf(named: Named): ModelStep {
  return typeof named === 'string'
    ? { model: named, backup: null, accept: null }
    : { model: named.model, backup: named.backup ?? null, accept: named.accept ?? null };
}

function stepsIn(models: Models | undefined, job: Job): ModelStep[] | null {
  const named = models?.[job];
  if (named === undefined) return null;
  return (Array.isArray(named) ? named : [named]).map(stepOf);
}

/** A job's steps in order: the definition's, or the deployment's default as one step. */
export function jobSteps(definition: Definition, job: Job, defaultModel: string): ModelStep[] {
  return stepsIn(definition.models, job) ?? [{ model: defaultModel, backup: null, accept: null }];
}

/** A step's threshold: its own, which is never below the job's, or the job's. */
export function stepAccept(definition: Definition, job: DecidingJob, step: ModelStep): number {
  return Math.max(definition.decisions[job].accept, step.accept ?? 0);
}

/**
 * The threshold an answer by this adapter is held to now: the step's whose model or backup gave
 * it, or the job's. A rule's or a person's decision, and one from a model the definition no longer
 * names (`llm:claude-opus-5-5`, from before ADR 0010), are held to the job's.
 */
export function acceptFor(
  definition: Definition,
  job: DecidingJob,
  adapter: string | null,
): number {
  const jobAccept = definition.decisions[job].accept;
  if (adapter === null || !adapter.startsWith('llm:')) return jobAccept;
  const model = adapter.slice('llm:'.length);
  const step = (stepsIn(definition.models, job) ?? []).find(
    (candidate) => candidate.model === model || candidate.backup === model,
  );
  return step === undefined ? jobAccept : stepAccept(definition, job, step);
}

/** Every model the definition names, with where: what `apply` checks against the deployment. */
export function namedModels(definition: Definition): { at: string; model: string }[] {
  const named: { at: string; model: string }[] = [];
  for (const job of JOBS) {
    const steps = stepsIn(definition.models, job);
    if (steps === null) continue;
    const list = Array.isArray(definition.models?.[job]);
    steps.forEach((step, index) => {
      const at = list ? `models.${job}[${index}]` : `models.${job}`;
      named.push({ at: `${at}.model`, model: step.model });
      if (step.backup !== null) named.push({ at: `${at}.backup`, model: step.backup });
    });
  }
  return named;
}

/** What a call cost, in dollars, at a price per million tokens. */
export function usdOf(usage: LlmUsage, price: ModelPrice): number {
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** How providers word a limit on spending: Anthropic's usage limits, OpenAI's quota, credits. */
const LIMIT = /usage limit|spend(?:ing)? limit|credit|billing|quota/iu;

/**
 * Why a failed call means its provider is down for the rest of the run, or null when the failure
 * may pass. A refused key and a payment needed won't pass in a run, nor will a limit on spending,
 * which Anthropic answers with 400, OpenAI with 429 (insufficient_quota), and OpenRouter with 402.
 * A 429 that is only a rate limit passes.
 */
export function downReason(failure: { status: number | null; message: string }): string | null {
  const { status, message } = failure;
  if (status === 401 || status === 403) return 'the key was refused';
  if (status === 402) return 'payment required';
  if ((status === 400 || status === 429) && LIMIT.test(message)) return 'usage limit';
  return null;
}

/** A job's models in words, as `plan` shows a change. */
export function describeSteps(steps: readonly ModelStep[]): string {
  return steps
    .map((step) => {
      const more = [
        ...(step.backup === null ? [] : [`backup ${step.backup}`]),
        ...(step.accept === null ? [] : [`at ${step.accept}`]),
      ];
      return more.length === 0 ? step.model : `${step.model} (${more.join(', ')})`;
    })
    .join(', then ');
}

/**
 * The jobs whose models a new definition changes, in words. The stored one is read leniently: a
 * definition stored before ADR 0010, or one whose `models` no longer parses, names none, so each
 * job it shows uses "the default".
 */
export function modelChanges(
  before: unknown,
  after: Definition,
): { job: Job; before: string; after: string }[] {
  const raw =
    before !== null && typeof before === 'object'
      ? (before as { models?: unknown }).models
      : undefined;
  const parsed = modelsSchema.safeParse(raw);
  const stored = parsed.success ? parsed.data : undefined;
  const words = (models: Models | undefined, job: Job) => {
    const steps = stepsIn(models, job);
    return steps === null ? 'the default' : describeSteps(steps);
  };
  return JOBS.flatMap((job) => {
    const was = words(stored, job);
    const now = words(after.models, job);
    return was === now ? [] : [{ job, before: was, after: now }];
  });
}
