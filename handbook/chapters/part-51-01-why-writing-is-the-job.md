# Part 51 — Writing as an Architect: RFCs, Design Docs and Decision Records

Somewhere around staff level, the shape of your day changes. You spend less time typing code and more time typing prose. This is not a demotion from engineering into administration. It is the moment your output stops being measured in pull requests and starts being measured in decisions other people make because of what you wrote.

Part 44 told you that writing becomes the primary tool at staff level, and gave you the four documents worth mastering. Part 49.6 showed you the skeleton of an Architecture Decision Record. This Part is the full craft: how to write documents that teams actually read, argue with, agree to, and then act on — months after you wrote them and often without you in the room.

The reader this Part assumes is a strong senior engineer who can already design a system. You know how to choose between PostgreSQL and DynamoDB, how to shape an event schema, how to run a migration. What you may not yet do reliably is get thirty other engineers, two product managers and a finance partner to agree to your design before you write a line of code. That agreement is manufactured on paper. This Part teaches the manufacturing.

## 51.1 Why writing is the architect's primary tool

#### Concept

Writing is how an architect scales past the reach of their own hands and their own voice. A conversation persuades the people in the room, once, and then decays. A document persuades everyone who reads it, including people who join the company a year later, and it does not change its story between the first reader and the hundredth.

An architect's job is to make good decisions happen across many teams without having authority over those teams. The only tool that does that cheaply, repeatedly and at scale is the written word. Code is also writing, but code only talks to the computer and to the people reading that exact file. A design doc talks to the whole organisation about why the code is shaped the way it is.

#### Why does it exist?

Imagine you are the only person who understands why the payment service retries with a two-second backoff and gives up after five attempts. That knowledge lives in your head. Three things now happen, all bad. First, every engineer who touches that code has to interrupt you to understand it, so you become a bottleneck. Second, when you are on holiday, nobody can safely change it, so the system freezes around your absence. Third, when you leave, the knowledge leaves with you, and six months later someone changes the backoff to fix an unrelated bug and causes an outage.

Writing exists to break all three. The decision, the reasoning and the alternatives you rejected go on paper. Now the knowledge is one-to-many, it survives your absence, and it survives you. A senior engineer who does not write is a single point of failure wearing a hoodie.

There is a second, subtler reason. **Writing forces clarity that talking does not.** You can hand-wave through a meeting. You cannot hand-wave through a paragraph. When you try to write "we will make the system more scalable" and then have to say what that means with a number, you discover that you do not actually know. The blank page is the cheapest design review you will ever get, and it happens before anyone else wastes time on your idea.

#### Mental model

Imagine the difference between teaching one apprentice at your workbench and writing a book. The apprentice learns fast because you adapt to them in real time, but you can only have one apprentice, they forget half of it, and when they leave the shop the lesson is gone. The book is slower and more painful to produce, you cannot see the reader's face, so you have to anticipate every misunderstanding in advance — but it teaches ten thousand people, it says the same thing every time, and it outlives you by a century.

A conversation is the apprentice. A document is the book. An architect who refuses to write is choosing to have one apprentice at a time for the rest of their career.

#### How it works

Writing does its work through four distinct mechanisms, and it helps to know which one you are relying on in any given document.

1. **One-to-many broadcast.** You write once; N people read it. Your leverage is multiplied by N. A one-page strategy memo read by 80 engineers is 80 person-readings for one writing effort.
2. **Persistence.** The document does not evaporate when the meeting ends. Six months later, when someone asks "why did we choose RabbitMQ over Kafka", the answer is a link, not a reconstruction from memory that may be wrong.
3. **Asynchrony.** Readers consume it on their own schedule, in their own timezone, at their own reading speed. A reviewer in another country does not need to be awake at the same time as you. This is how a company with offices in three continents aligns at all.
4. **Forced precision.** The act of writing surfaces the gaps in your own thinking before anyone else sees them. This is the mechanism that improves *your* decision, not just its distribution.

```text
Conversation:  you --speak--> few people --forget--> nothing persists
Document:      you --write--> many people --store--> persists --> new joiners
                        \--forces you to be precise before anyone reads it
```

#### Practical example

Your e-commerce company has a recurring problem: order notifications (order placed, order shipped, out for delivery) are sent by direct synchronous HTTP calls from the order service to an in-house notification service. When the notification service is slow, placing an order becomes slow. When it is down, orders fail. You have decided the right fix is an event-driven pipeline with an outbox table and a Kafka topic.

You could call a meeting and explain this. Eight people would nod. Two of them would misremember the retry semantics. The mobile team, who were not invited, would be surprised a month later when notification ordering changed. And when a new engineer joins the notifications team next quarter, they would have no idea why any of it is shaped the way it is.

Instead you write an RFC. The RFC is read by the order team, the notifications team, the mobile team, the platform team who own the Kafka cluster, and your director. Each reads it when convenient. Each comments inline. By the time you hold a thirty-minute decision meeting, every serious objection has already been raised and answered in the margins, and the meeting is a formality that ratifies a decision the document already made. That is the leverage. The full worked RFC is in section 51.9.

#### Artifact example

Here is the difference writing makes, shown as two versions of the same decision. First, the decision as it lives in someone's head and gets spoken in a hallway:

```text
"Yeah, we should probably move notifications to events. The sync calls
are a problem. I'll look into Kafka."
```

Nobody can act on that. Nobody can disagree with it precisely. It commits to nothing and teaches nobody. Now the same decision, written:

```markdown
## Decision: order notifications move to an event-driven pipeline

**Status:** Proposed (RFC-114), decision meeting 2026-03-12
**Problem:** The order service makes a synchronous HTTP call to the
notification service on every order event. p99 of POST /orders is
820 ms, of which 340 ms is the notification call. When the
notification service degrades, order placement degrades with it.
In the last 90 days this caused 2 partial order outages (INC-3391,
INC-3407).
**Proposal:** Write notification intents to an outbox table inside
the order-placement transaction, relay them to a Kafka topic
`order.events.v1`, and have the notification service consume
asynchronously. Target: remove the notification call from the order
hot path entirely; POST /orders p99 budget 480 ms.
**Alternatives considered:** (1) keep sync with a circuit breaker,
(2) fire-and-forget async HTTP, (3) RabbitMQ instead of Kafka. See §4.
**Rollback:** feature flag `notifications.transport`; flip back to
sync in under 5 minutes. Outbox rows are retained either way.
```

The second version can be reviewed, disagreed with on specific points, approved, and read by a new joiner in two years. It names the incidents. It names the numbers. It names the rollback. That is what writing buys you.

#### Real-world scenario

A payments platform grows from 15 to 90 engineers in two years. In the early days nothing is written down; the four founding engineers hold the whole architecture in their heads and in Slack. This works beautifully at 15 people and catastrophically at 90. New engineers cannot find out why the double-entry ledger forbids updates, so they write an update and corrupt a balance. Two teams independently build two different idempotency-key schemes because neither knew the other existed. An auditor asks for the data-retention policy and three people give three different answers.

The turning point is not a new tool. It is a principal engineer who starts writing: a decision record for the ledger invariant, an RFC for a single idempotency standard, a one-page data-retention policy. Within two quarters, the number of "why is it like this" interruptions to the founding engineers drops by more than half, and the two idempotency schemes converge on one. Nothing about the code got better first. The writing came first, and the code followed.

#### Failure scenario

A talented architect joins a 200-engineer company and designs, in her head and in whiteboard sessions, a genuinely excellent plan to consolidate three overlapping inventory systems. She explains it brilliantly in meetings. Everyone agrees in the room. Nothing happens.

Six months later nothing has changed, and she is baffled, because everyone agreed. The failure is that she never wrote it down. Each team remembered a slightly different version of the plan. There was no single artifact to point at when priorities were set, so inventory consolidation lost every prioritisation argument to things that *were* written as crisp proposals. The best idea in the building died because it existed only as spoken words, and spoken words cannot compete with a written one-pager for a quarter's funding.

#### Edge cases & failure modes

- **The document nobody reads.** Forty pages, no summary, no clear ask. It is written but it is not read, so it has the cost of writing and the leverage of a conversation. Length is a bug, not a virtue.
- **The decision already made.** A document written to create the appearance of consultation, where the author has no intention of changing anything. Reviewers smell this instantly and stop engaging, which poisons the well for your honest documents later.
- **Writing instead of deciding.** Some people hide in documents to avoid the discomfort of deciding. A design doc that has been "in review" for three months is a decision being avoided, not analysed.
- **Stale documents treated as current.** A design doc that described the system two years ago, never updated, now actively misleads. An out-of-date document is worse than no document because people trust it.
- **Writing for the wrong audience.** A strategy memo for executives written in the language of Kafka partitions. The audience cannot act on it, so it has no effect.
- **The solution looking for a problem.** A document that starts from "we should use technology X" and reverse-engineers a justification. The giveaway is a thin problem section and a lavish solution section.

#### How a Principal Engineer thinks about this

The principal engineer treats writing as the highest-leverage activity available to them, and schedules it like the important work it is rather than squeezing it into the gaps. They ask, before writing anything: *who is the audience, what do I want them to do differently after reading, and what is the shortest document that achieves that.* They write the ask and the summary first, at the top, because they assume most readers stop after the first screen.

They also know that writing is thinking. They do not write to communicate a decision they have already made; they write to make the decision, and they let the act of writing change their mind. A principal who finishes a design doc believing exactly what they believed when they started it did not use the document, they just transcribed a prejudice.

And they are ruthless about length, because they respect their readers' time as a scarce, expensive resource. A one-page memo that 80 people read and act on beats a twenty-page document that three people skim. If a document must be long, it leads with a summary that stands alone, and everything after the summary is for the small number of people who need the detail.

#### Common mistakes

- **Treating writing as documentation you do after the fact.** By then the decision is made, the context is lost, and the document is an archaeology project nobody wants to do.
- **Optimising for brevity over clarity, or clarity over brevity.** You want both. The skill is saying the necessary thing in the fewest words, not saying fewer things.
- **Writing to impress rather than to inform.** Big words and long sentences signal insecurity, not seniority. The most senior writing is the plainest.
- **Never writing at all, and relying on being in every meeting.** This caps your influence at the number of meetings you can attend, and makes you a bottleneck.
- **Burying the ask.** If a reader cannot tell in the first paragraph what you want them to do, they will not do it.

#### Interview questions

1. **Why is writing considered a core skill for staff-plus engineers, when the job is technical?**
   *Expected answer:* because influence at that level is cross-team and without authority, and the only tool that scales across teams, persists, and works asynchronously is writing. It also forces clarity in the author's own thinking. *Why it matters:* it tests whether the candidate understands that the job changes shape, not just grows. *Follow-up:* name a decision you made better because you had to write it down.

2. **A great idea of yours never got adopted despite everyone agreeing in the meeting. What probably went wrong, and what would you do differently?**
   *Expected answer:* it was never written as a single durable artifact, so it could not compete for prioritisation and each team remembered a different version. Next time, write a one-pager with a clear ask, pre-wire the key people, and make it the thing people point at. *Follow-up:* who specifically would you pre-wire and why.

3. **When is writing a document the wrong move?**
   *Expected answer:* when the decision is cheap and reversible (just decide and move), when a conversation genuinely suffices, or when a document would be used to fake consultation. *Why it matters:* tests judgement about proportionality, not dogma.

#### Practical exercise

Take a decision you made in the last month that currently lives only in your head or in Slack — a retry policy, a schema choice, a library you picked. Write it up in the short decision format shown in the Artifact example above: status, problem with at least one real number, proposal, alternatives, rollback. Keep it under 250 words.

**Acceptance criteria:** a reader who was not involved can state what was decided, why, what was rejected, and how to undo it, without asking you a single question. If they need to ask you anything, the document failed; fix it until it does not.
