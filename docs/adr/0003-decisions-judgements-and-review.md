# 0003. Decisions, judgements, and review

- Status: proposed with slice 1
- Date: 2026-10-12

## Context

Slice 0 joined pages by identifiers and keys only, and published every complete record. Two
questions need judgment that rules can't always give: what a page is (classification), and
whether two pages describe one product (matching). The spec's answer is a decision cascade,
whose every answer is recorded and can be corrected by a person.

## Decision

- **Questions are typed:** true or false, a choice among up to 255 options, or an ordered score.
  An answer is one of the question's options. Code applies it; text on a page can't become an
  action.
- **The cascade is rules, then the Claude decider, then a person.** The decider calls the
  Worker's LLM through AI Gateway and answers with probabilities. An answer at or above the
  dataset's threshold (`decisions.classify.accept`, default 0.9; `decisions.match.accept`, 0.95)
  is accepted; below it, the question goes to a person. A Worker with no LLM set up has no
  decider, and a person answers what the rules can't. Jev isn't on the account; when it is, it
  goes first, and Claude becomes System Two.
- **Consent.** A decider reads what pages said, so it is AI input: the dataset must declare
  `ai-input`, and no site whose page it would read may say `ai-input=no`. Otherwise the question
  goes to a person. An earlier decider answer is reused only while that consent holds, and only
  if it is as sure as the dataset now asks.
- **Every decision is recorded:**
  - its type and subject;
  - the state it was asked about, and the state's hash;
  - the question, with its criteria's version;
  - the adapter and model, the probabilities, and the threshold;
  - the outcome (`rule`, `accepted`, or `escalated`), the answer, and a person's final answer.

  A question already answered for the same state and criteria isn't asked again, unless asking
  might now come to something else: a decider's answer that consent or the threshold no longer
  allows, or a question that went to a person because no decider could answer it, once one can.
  A rule's answer and a person's stand. A newer question about the same subject supersedes the
  older one.

- **Classification.** A dataset marks one required enum field `decide: true`. Its question offers
  the field's values and "None of these", with criteria that quote the field's description when
  it has one. A page answers by rule only when every product in its structured data states a
  category, and all of them are the same one of the values, regardless of case. Otherwise the
  cascade asks: a rule's answer is published with no model and no person. "None of these" makes
  the page irrelevant until `pnpm spatula revive` brings it back. An answer becomes a statement
  whose method is `rule`, `llm`, or `human`, and whose path names the decision. A source that
  fixes the field, or declares a rule for it, decides nothing.
- **Matching.** A page that isn't joined yet is compared with:
  - the entities that own its identifiers, then its keys;
  - then up to three entities in the same scope (for products, the same brand) whose names are at
    least 0.6 similar by trigrams (at most 100 questions a run).

  A key joins a page only when no identifiers disagree and no other entity in its scope carries
  the same name, as two versions of a model do once a "variant" answer has split them; otherwise
  the cascade is asked. A page that gives only a name waits, rather than join or start an entity,
  while it isn't settled which entities carry that name. The answers are same, variant, or
  different, and the pack words the criteria: for products, colors and bundles are the same
  product, and versions whose specs differ are variants. "Same" joins the page to that entity,
  but a page judged the same as several entities joins none of them, unless exactly one of those
  verdicts is a person's. "Variant" and "different" both mean "not the same", which keeps the two
  apart for good. "Unsure" waits for a person, and the page stays out of snapshots until then.

- **Judgements.** One per page and entity. A person's verdict outranks every other, and only a
  person replaces it.
- **Review.** Each subject has at most one open question. `pnpm spatula review <dataset>` lists
  them, and `pnpm spatula review <dataset> <id> <answer>` answers one. A person's classification
  and match answers take effect at the next run; a publication answer takes effect at once
  (ADR 0004).
- **Budget.** A run stops asking the LLM once it has spent `budget.llmTokensPerRun` tokens
  (default 2,000,000) on extraction and decisions together; the call that crosses the line still
  finishes. The run's summary counts what's spent. A page the budget didn't reach is read again
  in the next run, and a match question it didn't reach is asked again.

## Consequences

- Every automated value can show why: its statement names the decision, and the decision its
  evidence.
- A person's review time goes to the uncertain middle only.
- Corrections that teach the rules, splitting an entity, and moving a joined page come later.
