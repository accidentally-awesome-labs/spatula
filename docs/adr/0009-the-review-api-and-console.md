# 0009. The review API and console

- Status: proposed with the living taxonomy
- Date: 2026-10-19

## Context

Questions were answered one at a time, by the owner, through the CLI. The living taxonomy (ADR 0007)
asks questions in parts, proposes changes to review, and lets consumers' reviewers help. One API
serves the owner's CLI, the owner's console, and consumers' own screens.

## Decision

**Resources.** Questions: list with filters (kind, shelf, source, confidence below a level),
answer one with its parts and a note, answer in bulk (at most 500, each applied on its own), the
owner's suggestions, by page address, which a question shows and a bulk answer can take, and one
question, open or closed, as the owner reads it. A note can't hold U+0000 or a lone surrogate.
Proposals: list, accept, edit and accept, reject. The taxonomy: the current version, its history,
undo. Autonomy: each kind's run of unedited acceptances, and revoking it. Captures: one, as
evidence, the owner's alone.

**Roles.**

- The owner: the CLI's bearer token, or the console behind Cloudflare Access. Access sends its
  signed token with each request it lets through, and the Worker checks that token itself, so a
  request that reached the Worker without passing Access gets nothing. The token must be signed
  (RS256) with one of the team's keys, issued by the team, for this application, and carry an
  expiry that hasn't passed. Its email must be the owner's. The team's origin, the application's
  audience, and the owner's email are the secrets `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and
  `OWNER_EMAIL`. A request with no good token gets 401, another person's email gets 403, and a
  deployment without all three secrets, or whose `ACCESS_TEAM_DOMAIN` isn't an https address,
  answers 503. The Worker reads the team's keys only for a token whose header names RS256 and a key
  ID. It keeps them ten minutes, reads them again for a key ID it hasn't seen at most once every 30
  seconds, and gives a read 5 seconds. When it can't read them, it answers 500. A check that fails
  for a reason other than the token, such as a key Access listed that can't be imported, answers
  401 and is logged by its error's name, never with the token. So is a token for another audience
  or issuer, which every token is while `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is set wrong.
- A consumer's reviewers: the consumer's token, with scopes from `CONSUMER_<NAME>_SCOPES`:
  `review:answer`, and `taxonomy:approve-additive` if the owner grants it, which approves new
  subcategories, features, and values. Each write names its reviewer in `X-Spatula-Reviewer`, an
  opaque ID the consumer vouches for. Crowdio starts with `review:answer` alone (owner,
  2026-10-19): taxonomy approvals stay with the owner until Crowdio's own review screen exists.

Publication answers, editing a proposal, suggestions, the log, reading one question, the
taxonomy's history, undo, autonomy and revoking it, seeding, and captures are the owner's.

**Precedence.** The owner, then a consumer's reviewer, then the decider. A reviewer's answer that
differs from a person's standing one never overwrites it: it flags the question and reopens it for
the owner, whose answer closes it. A reviewer's match answer counts as the standing one when it has
the same verdict, whether to join the page, join it as an edition, or keep it apart; only a
different verdict flags it. A flagged question waits for the owner. Only the owner's answer replaces
a person's, a reviewer's included once it has closed a question: the owner's different answer to
that question reopens it and answers it at once. The log has a flag by the owner, then the owner's
answer. While another question about the page is open, that one is the question to answer (409).
Like any answer, it changes only the parts its question asks (ADR 0007). The console's history
offers it beside each reviewer's answer. An owner's answer to a question the owner answered changes
nothing.

**Limits.** The review API's writes are limited: answers, suggestions, decisions on proposals,
undo, and revoking autonomy, with a bulk request counting once. `REVIEW_LIMITER` takes 120 a minute
from the owner, and from each of a consumer's reviewers. `CONSUMER_REVIEW_LIMITER` takes 240 a
minute from each consumer's reviewers together, and is checked first: a consumer names its
reviewers itself, so inventing new IDs must not get it fresh allowances. Past either, the answer is
a 429.

**The log.** Every answer, flag, suggestion, decision on a proposal, undo, and revocation, and
every change Spatula applies on its own, is recorded with its actor (owner, reviewer, or decider),
the consumer and reviewer where there are ones, and the client (CLI, console, consumer, or run).
Seeding is recorded as version 1, with its actor. Rows are only ever added.

**The console.** Three screens the Worker serves on `spatula.run/console`: questions, proposals,
and history, with a capture view. It calls the API under `/console/api` on its own origin. Every
response is `private, no-store`, and its content security policy allows only its own script and
style. A write needs the console's own origin: an `Origin` that is the Worker's, and
`Sec-Fetch-Site: same-origin` when the browser sends it. Page text is shown as text, never as
markup, and links go only to `https:` addresses. A capture comes as JSON with `nosniff` and a
`default-src 'none'; sandbox` policy, so a scraped page can't run on the console's origin. The
Access application covers `/console` and `/console/*`.

## Consequences

- Older CLIs keep working: the routes they call answer as before.
- Consumers' screens, Crowdio's admin first, come after launch, on the same routes.
