## 83.3 The anatomy of a strong design doc

#### Concept

A design doc has a skeleton, and the skeleton is not decoration. Each section exists to answer a question a serious reviewer will ask, in the order they ask it. Context, then goals and non-goals, then requirements with numbers, then the proposed design, then the alternatives you rejected, then the tradeoffs, risks, rollout, rollback, observability, cost, and open questions. Skip a section and you leave a question unanswered, which means a reviewer has to ask it, which means a round trip, which means delay. The skeleton is how you answer the questions before they are asked.

#### Why does it exist?

Imagine reviewing a design with no structure — just three pages of prose. You have to hunt for the goals. You cannot tell what is explicitly out of scope, so you raise concerns about things the author never intended to build. You cannot find the rollback plan, so you do not know if this is safe to ship. You and the author go back and forth for days extracting information that a template would have surfaced in one pass.

The skeleton exists to make review fast and complete. Every reviewer knows where to find the rollback plan because it is always in the same place. Every author is reminded to think about observability because there is a heading demanding it. The structure is a checklist disguised as a document format, and the checklist is drawn from the senior mantra: *can it time out, can it fail, can it become slow, can it duplicate, can it return a wrong response, can it partially succeed.*

#### Mental model

Imagine the pre-flight checklist a pilot runs before takeoff. It is not there because pilots are forgetful idiots; it is there because even experts miss things under pressure, and the cost of missing one is catastrophic. The checklist is boring and it saves lives precisely because it is boring and complete. A design doc template is the pre-flight checklist for shipping a system: it makes you check the landing gear (rollback) and the fuel (cost) every single time, so you never discover at 30,000 feet that you forgot.

#### How it works

Walk the sections in order. Each has a specific job.

```text
1. Context         -> why are we even talking about this
2. Goals           -> what does success look like, measurably
3. Non-goals       -> what are we deliberately NOT doing
4. Requirements    -> the numbers: load, latency, consistency, scale
5. Proposed design -> the actual plan, with diagrams
6. Alternatives    -> what else we considered and why we rejected it
7. Tradeoffs       -> what we are giving up with the chosen design
8. Risks           -> what could go wrong and our mitigation
9. Rollout         -> how we ship it safely, in stages
10. Rollback       -> how we undo it if it goes wrong
11. Observability  -> how we will know it is working in production
12. Cost           -> money and operational cost
13. Open questions -> what we have not resolved yet
```

- **Context.** The situation and why it needs changing, with evidence. Incidents, growth numbers, cost curves. A reviewer should finish this section agreeing there is a problem worth solving, before you have proposed anything.
- **Goals.** What success looks like, measurably. "Reduce POST /orders p99 from 820 ms to under 480 ms" is a goal. "Make orders faster" is a wish.
- **Non-goals.** What you are deliberately not doing. This is the most skipped and most valuable section; it stops reviewers from raising objections about scope you never intended, and it protects you from scope creep later.
- **Requirements.** The constraints the design must meet, in numbers. Peak load, acceptable latency, consistency needs, data volume, compliance boundaries.
- **Proposed design.** The plan. Diagrams first (context, then components, then the critical sequence), then prose. This is the heart, but it is only credible because the sections before it established the problem and the constraints.
- **Alternatives considered.** The other designs you genuinely weighed, each with why you rejected it. Covered in depth in 83.4 because people do this badly.
- **Tradeoffs.** What the chosen design costs you. Honest designs name their downsides. "This removes the hot-path call but adds eventual consistency; a notification may arrive up to 2 seconds after the order."
- **Risks.** What could go wrong, each with a mitigation or a reason it is acceptable.
- **Rollout.** The staged plan: feature flag, percentage ramp, which environments first.
- **Rollback.** How you undo it, how fast, and what state is left behind.
- **Observability.** The metrics, logs, traces and alerts that will tell you it is healthy. If you cannot say how you will know it works, you are not ready to build it.
- **Cost.** Infrastructure money and operational cost (new on-call surface, new failure modes).
- **Open questions.** What you have not resolved. Naming these honestly makes the doc more credible, not less.

#### Practical example

For the notification pipeline from 83.1, the requirements section — the numbers — looks like this:

```markdown
## Requirements

- **Throughput:** 1,200 order events/sec at peak (Black Friday 2025
  measured peak was 1,050; 15% headroom).
- **Latency:** removing the notification call must bring POST /orders
  p99 from 820 ms to under 480 ms. End-to-end notification delivery
  p95 under 10 seconds is acceptable (it was synchronous before, so
  this is a relaxation customers will not notice).
- **Delivery:** at-least-once. A duplicate notification is acceptable
  if rare; a lost "order shipped" notification is not.
- **Ordering:** per order, events must be delivered in order (placed
  before shipped before delivered). Across orders, no ordering needed.
- **Durability:** no notification intent may be lost if the order
  transaction committed. This is why we need the outbox.
- **Consistency:** the outbox write must be in the same transaction as
  the order write, so an order cannot commit without its notification
  intent.
```

Every line is a constraint the design must satisfy, and every line has a number or a hard rule. The ordering requirement, for instance, immediately tells the reader we need a partition key of order ID on the Kafka topic. The requirements section does design work before the design section starts.

#### Artifact example

The non-goals section, filled in for the same project. This is the section juniors skip and principals treasure.

```markdown
## Non-goals

- **We are NOT changing the content or templates of notifications.**
  Same emails, same push copy. This is a transport change only.
- **We are NOT building a general-purpose event bus for the whole
  company.** This topic is for order events consumed by notifications.
  A company-wide event platform is a separate, larger decision (see
  the platform team's roadmap).
- **We are NOT guaranteeing exactly-once delivery.** At-least-once
  plus idempotent consumers is our target. Chasing exactly-once would
  double the complexity for a problem (rare duplicate emails) we can
  tolerate.
- **We are NOT migrating SMS notifications in this phase.** SMS has a
  different provider and rate limits; it stays synchronous for now and
  moves in a later phase.
```

Look at what this buys you. A reviewer who was about to write "but what about SMS?" sees it is explicitly deferred and moves on. A reviewer who was about to argue for exactly-once semantics sees you considered and rejected it, with a reason. The non-goals section pre-empts entire branches of review discussion. Without it, you would spend the review defending scope you never wanted.

#### Real-world scenario

A ride-booking company adopts a design doc template with exactly these sections and makes one section mandatory that teams used to skip: observability. The rule is simple — no design review is scheduled until the observability section is filled in with the specific metrics and alerts.

The effect is quiet but large. Teams start designing their monitoring *before* they build, which means the dashboards and alerts ship with the feature instead of being bolted on after the first incident. Mean time to detection for new features drops because the detection was designed in. One template section, made mandatory, changed when monitoring got designed from "after the outage" to "before the launch".

#### Failure scenario

An engineer writes a beautiful design doc with a detailed proposed design and no rollback section. The design is approved, built, and shipped. In production it causes a subtle data-consistency bug under load. The on-call engineer tries to roll it back and discovers there is no clean rollback — the new code wrote data in a new format that the old code cannot read, and nobody thought about the reverse migration.

The incident lasts four hours longer than it needed to, because the rollback was designed live, under pressure, at 2 a.m. Had the rollback section been filled in during review, a reviewer would have caught that the data format change was not backward-compatible, and the design would have included a reverse path from the start. The missing section was not paperwork; it was the difference between a five-minute rollback and a four-hour incident.

#### Edge cases & failure modes

- **Goals that are not measurable.** "Improve performance" cannot be checked, so you never know if the project succeeded. Every goal needs a number.
- **No non-goals.** Reviewers raise scope you never intended; scope creeps during build. Always write non-goals.
- **Proposed design before context.** The reader does not yet believe there is a problem, so the design feels like a solution looking for one.
- **Rollback that is not actually possible.** A data format change with no reverse path. The rollback section must be tested in thinking, not just written.
- **Observability as an afterthought.** "We'll add dashboards later" means you ship blind and design your monitoring during the first incident.
- **Open questions hidden to look decisive.** Pretending you have resolved everything erodes trust when the gaps surface later. Name them.

#### How a Principal Engineer thinks about this

They treat the template as a thinking tool, not a form to fill. When they get to the rollback section and cannot write a clean one, they take that as a signal that the design is wrong, not that the section is annoying — a design you cannot undo is a design you should fear. When they get to the cost section and the number is uncomfortable, they let that reshape the design.

They put diagrams at the top of the proposed design, because a reader absorbs a system faster from a picture than from paragraphs, and they put the summary and the ask at the very top of the whole document, above context, because they assume busy readers stop early. They write non-goals carefully, because they have learned that most painful review cycles come from arguing about scope nobody agreed on, and non-goals end that argument before it starts.

#### Common mistakes

- **Skipping non-goals.** The single most common and most costly omission.
- **Vague goals.** "Make it faster" instead of "p99 under 480 ms".
- **Rollback written but never pressure-tested.** It reads fine and does not actually work.
- **Design section with no diagram.** Reviewers reconstruct the system in their heads, each slightly differently, and review the wrong thing.
- **Treating the template as bureaucracy.** Filling sections to tick boxes rather than to think. The template is a checklist for your own reasoning.

#### Interview questions

1. **What sections must a design doc have, and which one is most often skipped to everyone's regret?**
   *Expected answer:* context, goals, non-goals, requirements, design, alternatives, tradeoffs, risks, rollout, rollback, observability, cost, open questions — and non-goals is the most skipped and most valuable, because it bounds scope and pre-empts review arguments. *Follow-up:* give an example of a non-goal that saved a review.

2. **A design doc has a great proposed design but no rollback plan. Why is that dangerous, and what would you do as a reviewer?**
   *Expected answer:* without a rollback plan you may ship something you cannot safely undo, turning a quick revert into a long incident; as a reviewer, block approval until the rollback is concrete and, specifically, until backward compatibility of any data changes is addressed. *Why it matters:* tests whether they think about operability, not just the happy path.

3. **Why insist that every goal in a design doc has a number?**
   *Expected answer:* because without a number you cannot tell whether the project succeeded, you cannot size the design against the requirement, and "better" is unfalsifiable. Numbers turn opinions into engineering. *Follow-up:* turn "improve reliability" into a measurable goal.

#### Practical exercise

Take the most recent design doc your team wrote (or one you can find). Check it against the thirteen-section skeleton. For each missing or weak section, write one sentence saying what question a reviewer could not answer because of the gap.

**Acceptance criteria:** you produce a list of the doc's structural gaps, and for at least the rollback, non-goals and observability sections you can state the concrete risk each gap created. Rewrite the goals section so every goal has a number.
