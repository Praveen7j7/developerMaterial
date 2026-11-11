## 88.8 Reusable templates and building the writing habit

#### Concept

Everything in this Part becomes real only if you can produce it on a normal Tuesday without heroics. Two things make that possible. The first is a small set of **reusable templates** — skeletons you copy and fill, so you are never staring at a blank page and never forgetting a section under deadline pressure. The second is a **writing habit** — the practice, cadence and small techniques that turn writing from a dreaded occasional event into a routine part of how you work. A principal engineer who writes well does not have more talent; they have templates and a habit.

#### Why does it exist?

Imagine every design doc started from nothing. Each author would invent their own structure, forget a different section each time, and spend the first hour deciding what sections to have instead of thinking about the actual problem. Reviewers would face a different shape every time and never know where to find the rollback plan. Templates exist to remove that waste: the structure is a solved problem, so all your energy goes into the content.

The habit exists because writing under pressure, cold, occasionally, produces bad writing. The engineer who writes a document only when forced, twice a year, is always rusty, always slow, and always resents it. The engineer who writes something small every week — a decision note, a short update, an ADR — stays fluent, so when the big RFC is needed, it is just a longer version of a thing they do all the time.

#### Mental model

Imagine a chef's mise en place: before service, everything is chopped, measured and arranged, so that during the rush the chef is assembling, not scrambling. Templates are your mise en place for writing — the structure is prepped in advance, so when the moment comes you are filling in content, not inventing a format under pressure. And the habit is practice: a chef who cooks every day is fast and calm during the rush; one who cooks twice a year is slow and panicked. Writing is the same muscle.

#### How it works

**Templates.** Keep a small, shared library: a one-pager, a design doc, an ADR, an RFC, a PIR. Each is a copyable skeleton with the sections and one line of guidance per section. Store them where people start documents, so copying the template is easier than not. The templates in this section are complete enough to use directly.

**The habit** works through a few concrete practices:

```text
1. Write the doc BEFORE the work, not after. The doc is the design, not a record of it.
2. Write a little every week: a decision note, an ADR, an update. Stay fluent.
3. Draft ugly, then edit. Separate getting it down from getting it right.
4. Summary and ask FIRST, always. Write it last, put it first.
5. Time-box the first draft. Ninety minutes, then stop and share for feedback.
6. Read it aloud once. Your ear catches what your eye skips.
```

The order of writing matters more than people expect. You draft the body first, discover what you actually think, then write the summary and ask last — because you cannot summarise an argument you have not yet made. But you *place* the summary first, because the reader needs it first. Writing order and reading order are opposites, and confusing them is why so many summaries are vague.

#### Practical example

An engineer adopts the "write the doc before the work" rule for a schema-change project. Forced to write the rollback section before writing any migration, she realises her planned change — dropping a column — is not reversible once data is gone. That single realisation, surfaced by the template section before she wrote a line of SQL, reshapes the whole plan into an expand-contract migration (Part 27) that *is* reversible. The template did not document her design; it fixed it, before the cost of the mistake could be incurred.

#### Artifact example

The ADR template, filled in, short enough to write in fifteen minutes and complete enough to be worth keeping. This is the everyday document that keeps you fluent.

```markdown
# ADR-052: Use idempotency keys on all payment-mutating endpoints

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** payments team, [you]
**Supersedes:** none

## Context
Clients retry failed payment requests (timeouts, flaky mobile networks).
Without idempotency, a retry can charge a customer twice. We had 11 such
double-charge incidents in the last quarter, each a manual refund and a
support ticket. We need retries to be safe.

## Decision
Every payment-mutating endpoint (charge, refund, capture) requires an
`Idempotency-Key` header. We store (key, request-hash, response) in a
`idempotency_keys` table with a 24h TTL. A repeat key returns the stored
response without re-executing. A repeat key with a DIFFERENT request body
returns 409 Conflict.

## Consequences
- Retries become safe; double-charges from client retries eliminated.
- Clients MUST generate and send a key; we document this and reject
  mutating requests without one (400) after a 1-month grace period.
- One new table, modest write volume. TTL sweep keeps it bounded.
- This is now a standard; new mutating endpoints inherit it by default.
```

This ADR is complete, specific (names the incident count, the header, the 409 behaviour, the TTL), and immutable. In two years, an engineer wondering why every payment endpoint demands an idempotency key has the full answer in one screen. It took fifteen minutes to write and will save hours of confusion. Writing several of these a quarter is how you stay fluent for the RFC that matters.

#### Real-world scenario

A team introduces a shared template library and a norm: no design work starts without a design doc, and the design doc is the first deliverable, reviewed before code. Skeptics predict it will slow everything down. The opposite happens. Because the templates make starting cheap and the habit makes writing fast, docs stop being a bottleneck. And because flaws surface in the rollback and non-goals sections during design rather than in production, the team's incident rate on new features drops noticeably over two quarters. The writing did not slow delivery; it moved the discovery of problems earlier, where they are cheap, which sped up the parts that used to be slow — the firefighting.

#### Failure scenario

An engineer who never built a writing habit is suddenly asked to produce a company-critical RFC for a database migration, with executives waiting. Cold and rusty, he stares at the blank page for a day, then produces a sprawling, structureless draft with no summary, no non-goals, and a rollback section that says "we'll figure it out". The review is a disaster: reviewers cannot find the decision, argue about scope he never meant to include, and lose confidence in the migration itself. The migration slips a quarter, not because the plan was bad but because the engineer could not communicate it under pressure. Had he written a small document every week for the past year, the big one would have been routine.

#### Edge cases & failure modes

- **Template worship.** Filling every section because it exists, even when a section genuinely does not apply, producing padded documents. Templates are a prompt, not a mandate; skip what truly does not apply, but say why.
- **Writing the doc after the work.** It becomes documentation, not design, and loses the chance to fix the design cheaply.
- **Perfectionism on the first draft.** Editing while drafting kills momentum. Draft ugly, then edit.
- **Summary written first and left vague.** You cannot summarise an argument you have not made. Write the summary last, place it first.
- **No habit, only heroics.** Writing only when forced keeps you perpetually rusty, so every document is slow and painful.
- **Templates that are too heavy.** A thirteen-section template applied to a two-day task. Keep a light one-pager template for small things.

#### How a Principal Engineer thinks about this

They invest in templates as a leverage multiplier for the whole org, not just themselves — a good shared template makes every engineer's documents better and more consistent, which is a larger return than improving their own writing alone. They treat writing as a routine muscle, not a special event, and they write small things constantly, so the large things are never a cold start.

They are disciplined about writing the document before the work, because they have learned that the design doc is where the design actually happens — the typing is just transcription once the thinking is done well. And they draft fast and ugly, then edit, because they know the fear of the blank page is really the fear of writing something imperfect, and the cure is to write something imperfect on purpose and fix it.

#### Common mistakes

- **Reinventing structure every time** instead of keeping copyable templates.
- **Writing documentation after the fact** instead of writing the design as a document first.
- **Trying to write a polished first draft,** which produces paralysis.
- **Only writing when forced,** which keeps you permanently rusty.
- **Making every template heavy,** so people avoid them for small tasks.

#### Interview questions

1. **Why write the design doc before doing the work rather than after?**
   *Expected answer:* because the document is where the design actually gets worked out; sections like rollback and non-goals surface flaws while they are cheap to fix, and writing afterward reduces the doc to lossy documentation that misses the chance to improve the design. *Why it matters:* tests whether they see writing as thinking or as paperwork.

2. **You freeze up in front of a blank page before a big document. What techniques get you unstuck?**
   *Expected answer:* start from a template so the structure is solved; draft ugly and edit later; time-box the first draft; write the summary last and place it first; keep a weekly writing habit so you are never cold. *Follow-up:* why write the summary last.

3. **What goes in your team's template library, and why keep it small?**
   *Expected answer:* one-pager, design doc, ADR, RFC, PIR — a small set because people can only remember when to use a few, and a small set with clear purposes beats a precise taxonomy nobody follows. *Why it matters:* tests judgement about process weight.

#### Practical exercise

Create (or adapt) a template library of five documents for your team: one-pager, design doc, ADR, RFC, PIR. Each should be a copyable skeleton with one line of guidance per section. Then commit to the habit for four weeks: write one small document each week — an ADR for a decision you make, a one-pager for an idea, or a short PIR for a near-miss.

**Acceptance criteria:** the templates live where people start documents (so copying is easier than not), the one-pager and ADR templates each fit on one screen, and after four weeks you have four real documents written and can honestly say the fourth was faster and easier to write than the first.
