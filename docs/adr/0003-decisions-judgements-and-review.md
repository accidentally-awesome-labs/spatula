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
    least 0.6 similar by trigrams.

  A key joins a page only when no identifiers disagree and no other entity in its scope carries
  the same name, as two versions of a model do once a "variant" answer has split them; otherwise
  the cascade is asked. A run asks at most 100 match questions of any kind, and the rest wait for
  the next run. A page that gives only a name waits, rather than join or start an entity, while
  it isn't settled which entities carry that name. The answers are same, variant, or different,
  and the pack words the criteria: for products, colors and bundles are the same product, and
  versions whose specs differ are variants. "Same" joins the page to that entity, and a page
  joins only one: a decider's "same" about a page already judged the same as another entity goes
  to a person, and a person's "same" about a second entity is refused (409). A page judged the
  same as several entities anyway joins none of them, unless exactly one of those verdicts is a
  person's. "Variant" and "different" both mean "not the same", which keeps the two apart for
  good. "Unsure" waits for a person, and the page stays out of snapshots until then.

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
- Corrections that teach the rules, splitting an entity, and moving a joined page come later, and
  so does merging entities, which would make "same" transitive.

## Update, 2026-10-20 (matching by relationship, with editions)

- **The question.** A match question asks how record A is related to record B, with five
  relationships, which replace same, variant, and different: `same` (the same product and edition,
  listed twice), `edition` (the same model with the same specifications, differing only in looks or
  packaging), `spec-version` (the same model name, but a specification differs), `other-model`
  (another number, generation, or tier of the line), and `unrelated`. `same` joins the page to the
  record, `edition` joins it as an edition, and the other three keep it apart. The products pack
  words them at criteria version 3: a successor or a tier is another model, and a color, finish,
  special edition, or bundle is an edition. Pairs not yet settled are asked the new question;
  settled ones stand.
- **The threshold is per outcome.** A question can group its answers into outcomes. A decider's
  likeliest answer is taken when the answers that share its outcome add up to the threshold, so a
  decider 0.6 sure of `other-model` and 0.38 of `spec-version` keeps the page apart, and its
  decision stands in later runs. `same` and `edition` are separate outcomes, so a split between
  them goes to a person. A question that groups nothing is decided as before, so classifying is
  unchanged.
- **The model-number rule** comes before any decider. When the page and the record are in one
  brand, and the page's name differs from every name the record carries, edition pages' included,
  only by model marks (numbers, Roman numerals from II to IX, "Mk", "+", "Plus") once the words
  they share at the start and at the end are set aside, the answer is `other-model`. No model is
  asked, so the rule needs no AI input and no budget, and its judgement's `who` is `rule`. The run
  summary counts these pairs with the rule's answers, and names up to 10. Two names that differ
  only by an impedance are kept apart as `other-model`, where `spec-version` would be truer; the
  outcome is right. No question overrides the rule yet.
- **A known limit of the rule.** It drops punctuation and treats any number as a model mark, so a
  name that adds a year or a version number ("DT 770 PRO 2024" against "DT 770 PRO", "Hugo 2.0"
  against "Hugo 2") is kept apart as another model. A year edition would therefore become a record
  of its own.
- **What the decider sees.** Field values only, still wrapped as untrusted: the names with the
  words that differ called out, each side's identifiers and whether any match, the other values
  side by side (the same in both, different, only in A, only in B), and up to 10 other records in
  the brand, closest by name, marked when a person kept one apart from the record. B is the record
  by its base page, with the pages written as it, and its known editions are the names of its pages
  that differ from the record's name, at most 10. They are part of the question's key, as the
  record's values are. The lineup isn't, so a new record in the brand doesn't ask settled pairs
  again, and the decision keeps it in its evidence text. A lineup shows other records' names, so
  the consent rule covers it: it leaves out any record with a page whose site says `ai-input=no`.
- **Editions.** `edition` is a verdict of its own. It joins the page as `same` does: a page still
  joins one record, a decider's join about a page already joined to another record goes to a
  person, and a person's second join about another record is refused. A record takes its name and
  its other single values from its base page: the page whose name every other page's differing name
  extends, however either is spelled, or else the earliest page that gives a name, one that didn't
  join as an edition first, with the pages written as it. A page without a name is the base only
  where no page gives one, so the base never depends on which spelling Spatula met first. The other
  pages fill only what it leaves unstated, and a person's statement counts wherever it was said.
  List fields, GTINs and part numbers among them, still hold every page's values.
- **Snapshots.** A record may list its `editions`: each page whose name differs from the record's,
  once normalized, with its name, its address as `officialUrl`, and its own GTINs, sorted by name.
  A record without editions has no `editions` key and digests as before; a newly found edition
  publishes.
- **Answers from before.** An open question asked with same, variant, or different takes the five
  relationships too, so a page can be called an edition. "Variant" and "different" still keep a
  page apart.
