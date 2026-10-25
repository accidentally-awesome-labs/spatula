# 0010. Models and providers

- Status: proposed with models and providers
- Date: 2026-10-24

## Context

The first run under Crowdio's taxonomy version 1 (2026-10-24, 12:00 UTC) reached the spend limit of
Spatula's Anthropic account. From then on, every model call answered "You have reached your
specified API usage limits", and the run lost 12 classify decisions, 6 match decisions, and the
taxonomy review, so it made no proposals.

Spatula asked one model at one provider. Core already went through one port, `LlmPort`, for
extraction, the decider, shelf placement, and the review. But the Worker had one adapter, over the
Anthropic SDK, and one variable, `LLM_MODEL`, for every job, which only a deploy could change. Opus
priced every call at $4 in and $20 out per million tokens, the cheap questions included: the run's
classify alone cost about $11.

The owner's goals (2026-10-24), all four:

1. **Keep running on failure.** When a call fails (a spend limit, an outage, a 429), a backup model
   answers, and a run doesn't lose its decisions.
2. **Lower cost.** Cheaper models for the high-volume jobs, and Opus only where it pays for itself.
3. **Cheap first, strong when unsure.** A cheap model answers first. Only what it's unsure of goes
   to a stronger model, and only what that one is unsure of goes to a person.
4. **Free choice of model.** Any job can switch to any model, and a candidate can be compared, on
   questions the owner has already answered, before the switch. The comparison,
   a comparison command, comes with a later change.

## Decision

**Names.** A model is named `provider/model`, split at the first slash. The provider is a lowercase
slug, and the model is the provider's own name for it, 1 to 200 visible characters that may hold
more slashes: `anthropic/claude-opus-5-5`, or `openrouter/anthropic/claude-opus-5.5`, whose provider
is `openrouter`. A decision records the model that answered as its adapter, `llm:<provider/model>`.

**Providers.** Two adapters, one per API format, and every call goes through the `spatula-llm` AI
Gateway, which logs it and records its cost. Anthropic's format keeps the Anthropic SDK
(`llm-anthropic.ts`); OpenAI's Chat Completions format uses plain `fetch` (`llm-openai.ts`), so
nothing new is installed. The table is `platform/worker/src/llm-providers.ts`:

| Provider     | Format                  | Route under the gateway                    | Key secret           |
| ------------ | ----------------------- | ------------------------------------------ | -------------------- |
| `anthropic`  | Anthropic Messages      | `/anthropic` (the SDK adds `/v1/messages`) | `ANTHROPIC_API_KEY`  |
| `openai`     | OpenAI Chat Completions | `/openai/chat/completions`                 | `OPENAI_API_KEY`     |
| `openrouter` | OpenAI Chat Completions | `/openrouter/v1/chat/completions`          | `OPENROUTER_API_KEY` |
| `cerebras`   | OpenAI Chat Completions | `/cerebras/chat/completions`               | `CEREBRAS_API_KEY`   |
| `groq`       | OpenAI Chat Completions | `/groq/chat/completions`                   | `GROQ_API_KEY`       |

- `AI_GATEWAY_URL` keeps the value it had. A trailing `/anthropic` is dropped to give the gateway's
  base address, and each provider's route is added to it. Without `AI_GATEWAY_URL`, the Worker asks
  no model.
- The OpenAI-format adapter sends the schema as JSON Schema, made by zod, with `strict: true` only
  where strict mode takes it: every object lists all its properties as required. The answer is
  checked against the same zod schema, as Anthropic's is. It has the Anthropic adapter's limits: 150
  seconds an attempt, 8 minutes for the whole call, and 2 more tries after a network error, a
  timeout, a 5xx, or a 429, waiting what `retry-after` asks. A 429 that names a quota, a credit, or
  billing isn't tried again. A `retry-after` longer than the time left before the deadline fails
  the call at once, with the provider's 429: waiting couldn't succeed, and failing now leaves the
  step's backup its time.
- OpenRouter's requests carry `provider: { data_collection: "deny", require_parameters: true }`.
  The first routes only to hosts that don't collect what they're sent. The second routes only to
  hosts that take every parameter, the schema included: without it, a host that doesn't support
  the schema gets the request anyway and ignores it.
- Adding a provider that speaks one of the two formats is an entry in the table and a test.

**The providers' data terms, as read on 2026-10-24.** A provider whose API trains on its inputs by
default stays out of the table, unless a request can opt out. None had to be left out:

- **Anthropic:** inputs and outputs of its commercial products aren't used for training by default.
- **OpenAI:** API data isn't used for training unless the customer opts in. Abuse-monitoring logs
  are kept up to 30 days.
- **OpenRouter:** whether a host trains depends on the host. `data_collection: "deny"` keeps
  requests to hosts that, by OpenRouter's tags, don't collect user data, and OpenRouter calls those
  tags its best knowledge, not a definitive source. The opt-out is best-effort, not a contract.
- **Cerebras:** its help pages say it keeps no prompts or answers. No official text read says
  whether it trains on them.
- **Groq:** it keeps no inference data by default, beyond logs for up to 30 days for reliability
  and abuse. Its privacy policy leaves customer data to its Services Agreement, which wasn't read,
  so its training terms are unconfirmed too.

Cerebras and Groq stay in the table, but their terms are checked before a definition names one of
their models.

**Keys.** A provider is usable when its key secret is set, or when the variable `LLM_GATEWAY_KEYS`
(provider names, comma-separated, empty to start) names it. Then the gateway supplies the key,
stored in the gateway or through Cloudflare's Unified Billing, and the adapter sends no provider
key at all: a placeholder would be forwarded, and the provider would refuse it. Gateway-held keys
count only while `AI_GATEWAY_TOKEN` is set. Every request sends that token as
`cf-aig-authorization`, so a request without it can't spend the owner's credits. An adapter's error
names the status and the provider's message, with any key or token it echoes replaced by `[key]`,
and never includes the request's headers. The OpenAI-format adapter also cuts the message to 300
characters, so a gateway's error page can't fill a note.

**Models per job.** A definition's optional `models:` section names the models of the four jobs
that ask one. The thresholds stay in `decisions` (ADR 0003).

| Job              | What it covers                                                 | Shape                      |
| ---------------- | -------------------------------------------------------------- | -------------------------- |
| `extract`        | Filling `llm: true` fields from a page                         | One model, optional backup |
| `classify`       | A decided enum, and placement on a taxonomy's shelf (ADR 0007) | 1 to 3 steps               |
| `match`          | How a page and a record are related                            | 1 to 3 steps               |
| `taxonomyReview` | The run's taxonomy review, which proposes changes              | One model, optional backup |

An illustration of the shape, not a definition to apply: `groq/<cheap>` and `openai/<cheap>` are
placeholders, and `apply` would refuse them.

```yaml
models:
  extract: { model: anthropic/claude-opus-5-5, backup: openai/gpt-6.1-sol }
  classify: # in order: doubt moves to the next step, then to a person
    - { model: groq/<cheap>, backup: openai/<cheap>, accept: 0.96 } # its own threshold
    - { model: anthropic/claude-opus-5-5, backup: openai/gpt-6.1-sol } # decisions.classify.accept
  match: [anthropic/claude-opus-5-5] # a bare name: one step, no backup
  taxonomyReview: anthropic/claude-opus-5-5
```

- A step is a model's name, or `{ model, backup?, accept? }`. `extract` and `taxonomyReview` take
  no `accept`: they give no probabilities, so there's nothing to escalate on.
- A model may not appear twice in one job, as a step's model or as a backup.
- A job left out uses the deployment's `LLM_MODEL`, now `anthropic/claude-opus-5-5`, as one step
  with no backup.

**A threshold per step.** A step's `accept` must be at least the job's `decisions.<job>.accept`: a
step may ask more of its model, never less. A step without one uses the job's. A decision records
the threshold applied. An answer is always held to the threshold of the step whose model or backup
gave it (`acceptFor` in `@spatula/core`): when it's first taken, and in every later run that reuses
it. A rule's decision, a person's, and a model's that the definition no longer names, such as
`llm:claude-opus-5-5` from before this change, are held to the job's.

**The cascade.** For each classify or match question:

1. A rule answers, if one does, and nothing else runs.
2. Step 1's model answers. If its call fails, or its provider is down, its backup answers instead.
3. The answer is accepted if its probability (its outcome's, for match) reaches the step's
   threshold.
4. Otherwise the next step is asked. Its answer stands or falls on its own threshold: earlier
   steps' answers aren't combined with it.
5. After the last step, the question goes to a person, with the last answer's probabilities and
   evidence.

Doubt never goes to a backup; only a failure does. Shelf placement asks the same steps. A step whose
answer leaves a part open passes the whole question to the next, and the parts it settled are
dropped. A person is asked only the parts the last step isn't sure of.

**A person is asked only what every step weighed.** If no step accepted and any step failed, the
question is retried next run, even when an earlier step answered unsure. It doesn't go to a person
just because a model was unreachable: ADR 0003 asks a person nothing a decider could still answer.
So a question whose stronger step is down waits for it, rather than reaching the owner sooner.

**Failure and no answer.** A call fails when it throws: a network error, the per-attempt timeout or
the call's deadline, or an HTTP error still there after the adapter's retries. A failed call goes to
its step's backup, and the run's note names each model that failed. A refusal, an answer cut off by
the token limit, or one that doesn't fit the schema is no answer, which isn't a failure: the
question moves to the next step, or to a person. Extraction's no answer still has the page read
again next run, and never goes to the backup.

**Down for the run.** Some failures won't clear up during a run: a 401 or 403, a 402, and a 400 or
429 whose message names a usage or spending limit, a credit, billing, or a quota. That covers
Anthropic's 400 "usage limits", OpenAI's 429 `insufficient_quota`, and OpenRouter's 402. A plain
rate-limit 429 isn't one. Such a failure marks the provider down for the rest of the run:

- Later calls to any of its models are never sent. They go straight to their step's backup, and
  count as failed calls with no tokens. A model the deployment can't ask counts the same.
- A step whose model is down and which has no backup fails.
- The mark lives in the run's summary, as `llm.down` (each provider, since when, and why). Each
  step's result carries the marks it added, and a run rebuilds its summary from its steps' results,
  so a step that runs again skips the same providers.
- The run's report says "Down: anthropic since 2026-10-24 12:31 UTC: usage limit. Its later calls
  went to their backups, or failed where there was none." `spatula status` says the same of the
  latest run: "In the latest run (`<id>`), anthropic was down since …".

**The dollar budget.** `budget.llmUsdPerRun` (a number from 0 to 500, default 10) replaces
`budget.llmTokensPerRun`. A definition that still names `llmTokensPerRun` is refused, and the
message names `llmUsdPerRun`; a stored one runs again once the owner applies it with the new key.

- **Prices.** `LLM_PRICES` in `wrangler.jsonc` gives each model's list price, in dollars per million
  tokens in and out, with the provider's pricing page and the date in a comment. A malformed table or
  entry gives the model no price. A price is one pair, so a model priced by prompt length gets its
  higher pair: Haiku 5.5's price over 100,000 prompt tokens. A budget then never counts a call as
  cheaper than it was. OpenAI's higher prices for prompts over 272,000 tokens are left out, since
  Spatula's prompts are far shorter.
- **Spend.** A run's spend is each call's tokens at its model's prices. A call that gave no answer
  counts. A failed call returns no usage, so it counts nothing; the gateway's logs show anything it
  was billed for. A reused decision costs nothing. These are list prices, with no caching discount:
  the gateway's logs stay the bill, and the summary's dollars are what the budget is held to.
- **Running out.** Once spend reaches the budget, nothing more is asked, and what's left waits for
  the next run. The budget is checked before each question, and before each page for extraction,
  so a question with several steps can pass it by its later steps' calls, at most two of them.
- **Failing closed.** A spend that isn't a finite number, as a corrupt summary could give, leaves
  nothing to spend: the run stops asking rather than ask without limit.
- **Steps that run again.** A step replayed from its saved decision reports that decision as one
  call by the model that answered it. A decision keeps no usage per step, so all its tokens are
  charged to that model: the safe direction for a budget.
- **The summary** keeps the calls, failures, tokens in and out, and dollars for each job and, within
  it, each model. It keeps the token totals too, so earlier runs still compare. The run's report
  prints a spend line for each job and the run's total.

**Extraction's saved answers.** A page's answer is kept by a hash of the prompt's version, the
fields, and the page's text, and no longer of the model. Switching the extraction model asks no page
again, and neither does a page that a backup answered. Values from any model are kept only if
they're on the page, so an older model's are as grounded as a new one's. Raising
`LLM_PROMPT_VERSION` still asks every page again. A stored hash also matches by the old formula,
with `claude-opus-5-5`, the only model used before. Such a page gets the new hash stored in its
place, so the old formula fades out as pages are seen, and the deploy asks no page again.

**`plan` and `apply`.** The Worker checks every model a definition names, each step's and each
backup, against its own setup. `plan` lists each problem, and `apply` refuses the definition, when a
model has a provider that isn't in the table, has no price in `LLM_PRICES`, or has a provider that
isn't usable: no key secret, and not gateway-held with the token set. Each problem names where the
model is, the model, and what's missing, as in `models.classify[0].model: cerebras/<model>: no key:
set CEREBRAS_API_KEY, or name cerebras in LLM_GATEWAY_KEYS.` A Worker without `AI_GATEWAY_URL`
checks the provider and the price but not the key: it asks no model anyway, and a local `apply`
still works. `plan` shows a change to a job's models like any other change ("Models, classify: the
default → …"). `apply` makes a new revision, and the next snapshot is held for the owner (ADR 0004),
who checks what the new model changed before a consumer sees it.

A run checks the same at its start, against the deployment as it is then: a key may have gone since
`apply`. It doesn't stop. It notes each problem, "Its calls count as failed until that’s fixed.",
and that model's calls go to their backups. When a job the definition leaves out falls back to
`LLM_MODEL`, it notes a problem with that model too, such as a name with no provider.

**Placement after a raised threshold.** A placement a step weighed stands while consent holds: as
ADR 0007 says, a page is asked again only when the taxonomy key its decision covered changes. So
when the owner raises a step's threshold, the parts of earlier placements that now fall below it
open as a person's question, and no model is asked again. Answering them, or putting the old
threshold back, clears them. Asking again instead would re-ask pages, the 207 placements that went
to a person included, whenever a step was added after Opus.

**Not settled yet.**

- **OpenRouter's route.** Cloudflare's page gives `/openrouter/chat/completions` in its address's
  structure and its SDK example, but `/openrouter/v1/chat/completions` in its only full request, and
  its docs can't say which base the route maps to. Spatula uses the `/v1` form. One live call
  through the gateway must confirm it before a definition names an `openrouter` model; a 404 means
  the route becomes `/openrouter/chat/completions`. OpenRouter names Opus 5.5
  `anthropic/claude-opus-5.5`, with a dot, so Spatula's name for it is
  `openrouter/anthropic/claude-opus-5.5`.
- **The backup, `openai/gpt-6.1-sol`,** has never been called live. Not yet verified: that it is
  served on Chat Completions (some recent OpenAI models are Responses-only); that it takes strict
  `json_schema` and `max_completion_tokens`; and, if it is a reasoning model, that its reasoning
  tokens don't exhaust `DECIDER_MAX_TOKENS` (2000) or the taxonomy decider's cap, which would come
  back as `finish_reason: "length"` and no answer. After the deploy, and before relying on it, make
  one live call per job's request shape through the gateway. If answers come back truncated, the
  fix is a `reasoning_effort` extra set per model, since non-reasoning models refuse that
  parameter. It isn't added now.
- **Cerebras and Groq** send `max_completion_tokens`, which their own API pages weren't read to
  confirm, and Cerebras's prices didn't show on its pricing page. Neither has a price in
  `LLM_PRICES` yet, so neither can be named.

**The first use.** For Crowdio's `crowdio-audio-products`, the owner chose (2026-10-24)
`anthropic/claude-opus-5-5` for every job, with `openai/gpt-6.1-sol` as each one's backup, and
`llmUsdPerRun: 25`. Classify gets no cheap first step until a comparison has measured candidates on
the owner's answers.

**Rollout order.** After the deploy, every stored dataset, whose stored definition carries the old
`budget.llmTokensPerRun`, throws `StaleDefinitionError` until it is applied again: runs are
refused, owner routes such as `status` answer 409, and a consumer's token is refused for snapshots,
acknowledgments, and the review API. And `apply` of a definition naming `openai/gpt-6.1-sol` is
refused until `OPENAI_API_KEY` is set (or `openai` is in `LLM_GATEWAY_KEYS` with the gateway token
set). So: set the key first (the old code ignores it), deploy, then apply at once. A run in flight
across the deploy finishes without asking another model: its kept definition has no dollar budget,
which reads as spent, and its pages wait for the next run.

## Set aside

- **AI Gateway's single OpenAI-compatible endpoint** (`/compat/chat/completions`, with models named
  `provider/model`). Cloudflare marks it deprecated for single-model chat, its provider list leaves
  out OpenRouter, and its docs don't say whether it turns a JSON schema into Anthropic's structured
  output, which the decider relies on.
- **The Vercel AI SDK.** It adds about five runtime dependencies to the Worker. For some providers it
  gets structured output through tool calls, so what goes out is harder to see and to test against
  recorded calls.
- **A setting in the database.** A switch of model would bypass the definition: `plan` wouldn't show
  it, no revision would record it, and no snapshot would be held for the owner to check what it
  changed.
- **The Worker's config only.** Every dataset would share one choice, and every switch would need a
  deploy, as `LLM_MODEL` did. A switch wouldn't show in `plan` or hold a snapshot either. The config
  keeps what belongs to the deployment: the providers, their keys, the prices, and the default
  model.

## Consequences

- A new model needs a price in `LLM_PRICES`, and so a deploy, before a definition can name it.
  Prices are checked by hand on the provider's page, with the date written beside them.
- A switch of model is a definition change: `plan` shows it, `apply` makes a revision, and the next
  snapshot is held for the owner.
- Decisions recorded before this change keep the adapter `llm:claude-opus-5-5`. They still read,
  apply, and stand, held to the job's threshold. Reusing a decision doesn't depend on the model
  (ADR 0003), so a switch asks no settled question again.
- A backup answers under its step's threshold. A backup from another family of models may be sure
  in a different way, which a comparison can measure.
- One provider's spend limit or outage no longer stops a run's decisions, wherever a step has a
  backup at another provider. A job left to `LLM_MODEL` has none.
