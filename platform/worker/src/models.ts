import {
  adapterName,
  createLlmDecider,
  createTaxonomyDecider,
  downReason,
  JOBS,
  jobSteps,
  MODEL_NAME,
  namedModels,
  providerModel,
  providerOf,
  stepAccept,
  type CascadeStep,
  type Decider,
  type DecidingJob,
  type Definition,
  type DownMarks,
  type LlmPort,
  type LlmUsage,
  type ModelCall,
  type ModelPrice,
  type ModelStep,
  type TaxonomyDecider,
} from '@spatula/core';
import { secret } from './config';
import { createAnthropicLlm } from './llm-anthropic';
import { createOpenAiLlm } from './llm-openai';
import { gatewayBase, providerNamed, type Provider } from './llm-providers';
import type { LlmState, RefreshPorts } from './pipeline';

/*
 * The deployment's models (ADR 0010), from its variables and secrets: LLM_MODEL, the default;
 * LLM_PRICES, each model's dollars per million tokens; LLM_GATEWAY_KEYS, the providers whose keys
 * the gateway holds; AI_GATEWAY_URL and AI_GATEWAY_TOKEN; and each provider's key. A model can be
 * asked when its provider is in the table, it has a price, and its provider has a key: a secret, or
 * the gateway's while the gateway's token is set. A Worker without the gateway's address asks no
 * model, so its keys aren't checked. A step asks its model, then its backup when that fails; a
 * failure that won't pass in a run marks the provider down, and the run's later calls to it are
 * never sent.
 */

export interface ModelSetup {
  /** LLM_MODEL: the model of a job the definition doesn't name. */
  readonly defaultModel: string;
  /** Why the model can't be asked, or null when it can. */
  problem(model: string): string | null;
  /** Its dollars per million tokens, or null when it has none. */
  price(model: string): ModelPrice | null;
}

export interface ModelPortSet {
  llm: LlmPort;
  decider: Decider;
  taxonomyDecider: TaxonomyDecider;
}

const vars = (env: Env) => env as unknown as Record<string, unknown>;

/** LLM_PRICES, which wrangler may hand over as an object or as its JSON. Bad entries are dropped. */
function pricesOf(value: unknown): Map<string, ModelPrice> {
  let table: unknown = value;
  if (typeof value === 'string') {
    try {
      table = JSON.parse(value);
    } catch {
      return new Map();
    }
  }
  const prices = new Map<string, ModelPrice>();
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return prices;
  for (const [model, pair] of Object.entries(table)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [input, output] = pair;
    if (typeof input !== 'number' || typeof output !== 'number') continue;
    if (!(input >= 0 && output >= 0 && Number.isFinite(input) && Number.isFinite(output))) continue;
    prices.set(model, { input, output });
  }
  return prices;
}

function listOf(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
    : [];
}

export function workerModels(
  env: Env,
  fetchImpl?: typeof fetch,
): { setup: ModelSetup; ports: ((model: string) => ModelPortSet) | null } {
  const defaultModel =
    typeof vars(env).LLM_MODEL === 'string' ? (vars(env).LLM_MODEL as string) : '';
  const prices = pricesOf(vars(env).LLM_PRICES);
  const held = new Set(listOf(vars(env).LLM_GATEWAY_KEYS));
  const gatewayUrl = secret(env, 'AI_GATEWAY_URL');
  const gatewayToken = secret(env, 'AI_GATEWAY_TOKEN');
  const keyOf = (provider: Provider) => secret(env, provider.secret);
  const setup: ModelSetup = {
    defaultModel,
    price: (model) => prices.get(model) ?? null,
    problem(model) {
      if (!MODEL_NAME.test(model)) return 'it isn’t named provider/model';
      const name = providerOf(model);
      const provider = providerNamed(name);
      if (provider === null) return `Spatula has no provider called ${name}`;
      if (!prices.has(model)) return 'it has no price: add it to LLM_PRICES';
      if (gatewayUrl === undefined || keyOf(provider) !== undefined) return null;
      if (held.has(name)) {
        return gatewayToken === undefined
          ? 'its key is held by the gateway, which needs AI_GATEWAY_TOKEN'
          : null;
      }
      return `no key: set ${provider.secret}, or name ${name} in LLM_GATEWAY_KEYS`;
    },
  };
  if (gatewayUrl === undefined) return { setup, ports: null };
  const base = gatewayBase(gatewayUrl);
  const llmFor = (model: string): LlmPort => {
    const provider = providerNamed(providerOf(model));
    if (provider === null) return unavailable(model, setup.problem(model) ?? 'it can’t be asked');
    const apiKey = keyOf(provider);
    return provider.format === 'anthropic'
      ? createAnthropicLlm({
          apiKey,
          model: providerModel(model),
          name: model,
          baseURL: `${base}${provider.route}`,
          gatewayToken,
          fetch: fetchImpl,
        })
      : createOpenAiLlm({
          name: model,
          model: providerModel(model),
          url: `${base}${provider.route}`,
          apiKey,
          gatewayToken,
          maxTokensField: provider.maxTokensField,
          extra: provider.extra,
          fetch: fetchImpl,
        });
  };
  const made = new Map<string, ModelPortSet>();
  return {
    setup,
    ports(model) {
      let set = made.get(model);
      if (set === undefined) {
        const llm = llmFor(model);
        set = { llm, decider: createLlmDecider(llm), taxonomyDecider: createTaxonomyDecider(llm) };
        made.set(model, set);
      }
      return set;
    },
  };
}

/** A port for a model that can't be asked: every call fails, saying why. */
function unavailable(model: string, why: string): LlmPort {
  return {
    model,
    async structured() {
      throw new Error(`${model}: ${why}`);
    },
  };
}

/**
 * The ports a model answers through: its own in a deployment. In the tests, which give no
 * modelPorts, every model answers through the three default ports, the fakes.
 */
export function portsFor(
  ports: Pick<RefreshPorts, 'llm' | 'decider' | 'taxonomyDecider' | 'modelPorts'>,
  model: string,
): { llm: LlmPort | null; decider: Decider | null; taxonomyDecider: TaxonomyDecider | null } {
  return (
    ports.modelPorts?.(model) ?? {
      llm: ports.llm,
      decider: ports.decider,
      taxonomyDecider: ports.taxonomyDecider,
    }
  );
}

/** What asking one step came to. */
export interface Tried<T> {
  /** The answer and the model that gave it; null when the step's model and backup both failed. */
  answered: { model: string; value: T } | null;
  calls: ModelCall[];
  /** The providers this step found down. */
  down: DownMarks;
  /** Why each model that failed did, for the run's notes. */
  failures: string[];
}

/** An error's HTTP status, where it has one, and its message. */
export function failureOf(error: unknown): { status: number | null; message: string } {
  const status =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : null;
  return { status, message: error instanceof Error ? error.message : String(error) };
}

/**
 * Asks a step's model, then its backup when that fails (ADR 0010). A model whose provider is down,
 * or that the deployment can't ask, is never sent anything: it counts as a failed call. A failure
 * that won't pass in a run marks its provider down. What `ask` returns, an answer or no answer, is
 * the step's: only a throw is a failure.
 */
export async function tryStep<T>(input: {
  step: ModelStep;
  setup: ModelSetup;
  /** The providers already down this run. */
  down: DownMarks;
  now: Date;
  ask(model: string): Promise<{ value: T; usage: LlmUsage }>;
}): Promise<Tried<T>> {
  const tried: Tried<T> = { answered: null, calls: [], down: {}, failures: [] };
  const failed = (model: string, why: string) => {
    tried.calls.push({ model, inputTokens: 0, outputTokens: 0, failed: true });
    tried.failures.push(`${model}: ${why}`);
  };
  for (const model of [input.step.model, input.step.backup]) {
    if (model === null) continue;
    const provider = providerOf(model);
    const down = input.down[provider] ?? tried.down[provider];
    if (down !== undefined) {
      failed(model, `${provider} is down since ${down.at}: ${down.reason}`);
      continue;
    }
    const problem = input.setup.problem(model);
    if (problem !== null) {
      failed(model, problem);
      continue;
    }
    try {
      const { value, usage } = await input.ask(model);
      tried.calls.push({ model, ...usage, failed: false });
      tried.answered = { model, value };
      return tried;
    } catch (error) {
      const failure = failureOf(error);
      failed(model, failure.message);
      const reason = downReason(failure);
      if (reason !== null) tried.down[provider] = { at: input.now.toISOString(), reason };
    }
  }
  return tried;
}

/** What a step of the run asked of models: its calls, and the providers it found down. */
export interface Asked {
  calls: ModelCall[];
  down: DownMarks;
}

/**
 * The call a saved decision stands for, for a step that runs again and reports it as it was made.
 * A decision keeps no usage per step, so its tokens are charged to the model that answered: the
 * safe direction for a budget. A rule's or a person's decision, and one with no tokens, report none.
 */
export function savedCalls(decision: {
  adapter: string | null;
  inputTokens: number;
  outputTokens: number;
}): ModelCall[] {
  const prefix = adapterName('');
  if (decision.adapter === null || !decision.adapter.startsWith(prefix)) return [];
  if (decision.inputTokens === 0 && decision.outputTokens === 0) return [];
  return [
    {
      model: decision.adapter.slice(prefix.length),
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
      failed: false,
    },
  ];
}

export const noneAsked = (): Asked => ({ calls: [], down: {} });

/** Adds what one step asked; the first mark for a provider stands. */
export function gather(into: Asked, tried: Tried<unknown>): void {
  into.calls.push(...tried.calls);
  for (const [provider, down] of Object.entries(tried.down)) into.down[provider] ??= down;
}

/**
 * A deciding job's steps as the cascade asks them (ADR 0010). Each asks its model through its own
 * ports, or its backup when that fails, and gathers what it asked into `asked`, so that the step of
 * the run can count it. A provider a step finds down is skipped by the steps after it. The answer
 * carries the adapter of the port that gave it.
 */
export function cascadeSteps(input: {
  definition: Definition;
  job: DecidingJob;
  ports: Pick<
    RefreshPorts,
    'llm' | 'decider' | 'taxonomyDecider' | 'modelPorts' | 'models' | 'now'
  >;
  llm: LlmState;
  asked: Asked;
}): CascadeStep[] {
  const { definition, job, ports, llm, asked } = input;
  return jobSteps(definition, job, ports.models.defaultModel).map((step) => ({
    accept: stepAccept(definition, job, step),
    decider: {
      name: adapterName(step.model),
      async decide(request) {
        const tried = await tryStep({
          step,
          setup: ports.models,
          down: { ...llm.down, ...asked.down },
          now: ports.now(),
          async ask(model) {
            const decider = portsFor(ports, model).decider;
            if (decider === null) throw new Error('no decider is configured');
            const answer = await decider.decide(request);
            return { value: { ...answer, adapter: decider.name }, usage: answer.usage };
          },
        });
        gather(asked, tried);
        if (tried.answered === null) throw new Error(tried.failures.join('; '));
        return tried.answered.value;
      },
    },
  }));
}

/** What keeps the deployment from asking the models a definition names: `plan` lists it, `apply` refuses. */
export function modelIssues(definition: Definition, setup: ModelSetup): string[] {
  return namedModels(definition).flatMap(({ at, model }) => {
    const problem = setup.problem(model);
    return problem === null ? [] : [`${at}: ${model}: ${problem}.`];
  });
}

/**
 * What a run notes at its start, checked against the deployment as it is then: `modelIssues`, and
 * the default model's problem when a job the definition leaves out falls back to it. A key removed
 * since `apply` would otherwise go unnoticed.
 */
export function runModelIssues(definition: Definition, setup: ModelSetup): string[] {
  const issues = modelIssues(definition, setup);
  const fallsBack = JOBS.some((job) => definition.models?.[job] === undefined);
  const problem = fallsBack ? setup.problem(setup.defaultModel) : null;
  if (problem === null) return issues;
  const named = setup.defaultModel === '' ? '' : `: ${setup.defaultModel}`;
  return [...issues, `LLM_MODEL${named}: ${problem}.`];
}
