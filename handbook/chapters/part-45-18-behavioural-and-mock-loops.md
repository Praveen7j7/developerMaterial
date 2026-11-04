## 45.21 Behavioural and leadership

These ten are not memorisation questions. A rehearsed script is obvious within two sentences, and interviewers probe until they find the real story. What follows is the *structure* to fill with your own material, plus what a strong answer contains. Prepare six or seven real stories with numbers, and map them onto these prompts rather than inventing one answer per question.

The default frame is STAR (Situation, Task, Action, Result), with one senior amendment: end with **Reflection** — what you learned and what you would do differently. Keep the situation to two sentences, spend most of the time on your actions and reasoning, and always land a measurable result.

### Q251. Tell me about the hardest production incident you have handled.

- **Expected answer** — Structure: what the system was and its scale (one sentence with numbers), what the symptom was and how it was detected, the impact in user and business terms, what you did to mitigate and in what order, how you found the cause, and what changed afterwards. Good looks like: a clear timeline with times attached; mitigation described *before* diagnosis, showing you restore service first; specific evidence used at each step ("the p99 doubled but the database was idle, so I looked at pool saturation"); honesty about the wrong turns and how long they cost; and a concrete prevention outcome — an alert added, a limit set, a design changed — with evidence it worked. Weak looks like: a vague story with no numbers, a hero narrative where you alone fixed it, blaming another team, or ending at the fix with no follow-through.

- **Why it matters** — It is the closest proxy for on-call competence and for how you behave under pressure.

- **Follow-ups** — What would have caught it earlier? What did you do wrong during the incident? What happened to the action items?

- **Senior signal** — Mitigate-before-diagnose, quantified impact, credit shared with the team, and a prevention step that actually shipped.

### Q252. Tell me about a technical decision you later reversed.

- **Expected answer** — Structure: the original decision and the reasoning that made it sensible *at the time*, what evidence later showed it was wrong, the cost of the reversal, how you made the call, and what you changed about how you decide. Good looks like: taking ownership without self-flagellation; showing the original decision was defensible given what was known, which is far more credible than "I was stupid"; naming the specific signal that triggered the reversal (an operational cost, a latency number, a hiring problem); describing how you migrated back safely rather than just declaring the change; and extracting a transferable lesson, typically about reversibility — "I now ask which decisions are one-way doors and only those get a long design review". Weak looks like: claiming never to have reversed anything, or a trivial example like a library choice with no consequences.

- **Why it matters** — It tests intellectual honesty and whether you learn from evidence rather than defending positions.

- **Follow-ups** — How long did you wait before reversing, and was that too long? Who disagreed with the reversal? What would you have needed to know earlier?

- **Senior signal** — Distinguishes reversible from irreversible decisions and adjusts the process, not just the outcome.

### Q253. Describe a time you disagreed with your manager or tech lead.

- **Expected answer** — Structure: the decision, why you disagreed and what evidence you had, how you raised it, what happened, and how you behaved afterwards. Good looks like: disagreeing on substance with data rather than preference; raising it privately and directly first; genuinely engaging with their reasoning, including constraints you may not have seen (budget, timeline, politics, a commitment already made); proposing an alternative rather than only objecting; and — critically — committing fully once the decision was made, even when it went against you, while agreeing on what evidence would prompt a revisit. That "disagree and commit, with a trigger to re-open" behaviour is exactly what senior means here. Weak looks like: a story where you were right and everyone else was foolish, or one where you quietly complied and then said "I told you so", or one where you escalated immediately without a direct conversation.

- **Why it matters** — Senior engineers must be able to push back without being corrosive.

- **Follow-ups** — What if you had been the one who was wrong? When would you escalate above your manager? How did the relationship look afterwards?

- **Senior signal** — Data-driven disagreement, real engagement with constraints, and committing cleanly with a defined revisit trigger.

### Q254. How do you mentor engineers?

- **Expected answer** — Structure: a specific person, where they were and where they needed to be, what you actually did over what period, and the measurable outcome. Good looks like: concrete mechanisms rather than platitudes — pairing on a real problem, giving a stretch task with a safety net, reviewing code with explanations of *why* instead of prescriptions, letting them own a design document and asking questions rather than rewriting it, deliberately not taking over during their first incident. It should include how you adapted to the individual (someone lacking confidence needs different support from someone lacking depth), how you gave difficult feedback, and an outcome you can point to: they led a project, they were promoted, they now own an area. Good answers also mention what you learned from mentoring and where you failed at it. Weak looks like: "I answer questions in the team channel", or claiming credit for someone else's growth.

- **Why it matters** — At senior level your impact through others is a large part of the job.

- **Follow-ups** — Tell me about someone you could not help. How do you give feedback that is hard to hear? How do you avoid becoming the bottleneck?

- **Senior signal** — Resists solving the problem for them, adapts the approach per person, and can name a failure as well as a success.

### Q255. Tell me about pushing back on scope or a deadline.

- **Expected answer** — Structure: what was asked, why it was not achievable as stated, how you presented that, what alternative you offered, and the outcome. Good looks like: pushing back with *options* rather than a refusal — "we can ship the full scope by March, or this reduced scope by January with these three things deferred, or the full scope by January with two more engineers; here is what I recommend and why"; making the trade-off visible in the stakeholder's terms (revenue, risk, customer commitments) rather than in engineering terms; being specific about what "done" means for each option, including operational readiness, not just feature completion; and flagging the risk early rather than at the deadline. It should also show you took the business constraint seriously rather than treating the request as unreasonable by default. Weak looks like: "I told them it was impossible", padding estimates silently, or agreeing and then missing the date.

- **Why it matters** — Scope negotiation is a core senior skill and a common failure point.

- **Follow-ups** — What if they said no to all your options? How early did you raise it? What did you cut and how did you decide?

- **Senior signal** — Offers a menu with honest trade-offs in business language, and raises risk early rather than at the deadline.

### Q256. How do you estimate work?

- **Expected answer** — Structure: your method, an example where it worked, an example where it did not, and what you changed. Good looks like: decomposing until the pieces are small enough to reason about, because large estimates are guesses; estimating in ranges or confidence levels rather than single numbers ("two to three weeks, and I will know by Thursday which end after I have spiked the migration"); explicitly listing unknowns and buying information cheaply with a timeboxed spike; including the parts people forget — code review, testing, migration, deployment, monitoring, documentation and the inevitable interruptions, which is why a "three-day" task takes two weeks; using historical data from similar work instead of optimism; and re-forecasting publicly as you learn rather than defending the original number. It should also cover communicating uncertainty to non-engineers without either false precision or uselessly wide ranges. Weak looks like: "I add 50% buffer", or refusing to estimate at all.

- **Why it matters** — Estimation accuracy affects everyone's planning, and how you handle uncertainty is the real signal.

- **Follow-ups** — What is your biggest estimation miss and why? How do you estimate something you have never done? How do you handle pressure to lower an estimate?

- **Senior signal** — Ranges with an explicit information-gathering plan, re-forecasting in public, and counting the non-coding work.

### Q257. How do you deal with technical debt?

- **Expected answer** — Structure: how you identify and categorise it, how you get time for it, a specific example with the before-and-after numbers, and how you prevent it accumulating. Good looks like: distinguishing deliberate, well-understood debt taken for speed (fine, if tracked with a repayment plan) from accidental debt caused by ignorance or drift (a different problem needing learning or standards); prioritising by *pain*, not by aesthetics — debt that slows delivery, causes incidents or blocks a roadmap item is worth fixing, while ugly-but-stable code that nobody touches is not; making the cost visible in business language ("this module causes about one incident a month and doubles the time for any change in this area") so the trade-off is a business decision rather than an engineering plea; and paying it down incrementally alongside feature work — the boy-scout rule, strangler-fig migrations, and a standing allocation — rather than requesting a three-month rewrite, which almost never gets approved and rarely finishes when it does. Weak looks like: "we need a rewrite", or complaining about debt without ever quantifying its cost.

- **Why it matters** — Debt management is where engineering judgement meets stakeholder communication.

- **Follow-ups** — When is a rewrite the right answer? How do you say no to a refactor someone wants? What debt are you deliberately carrying right now?

- **Senior signal** — Quantifies debt in delivery and incident terms and pays it down incrementally rather than demanding a rewrite.

### Q258. Tell me about a conflict with another team.

- **Expected answer** — Structure: the situation and each side's actual interest, what you did to resolve it, the outcome, and how the relationship ended up. Good looks like: genuine curiosity about the other team's constraints and incentives before assuming bad faith — most cross-team conflict is two teams optimising for different, individually-reasonable goals; moving the conversation from positions ("you must build this") to interests ("we need this latency by Q3; what options do you have?"); getting the disagreement into a shared written document with data so it stops being a personality clash; escalating with both parties present and framed as "we need a decision" rather than complaining upward about someone; and accepting an outcome that is not what you wanted while keeping the working relationship, since you will need them next quarter. Weak looks like: a story where the other team was simply unreasonable, or one resolved by going over their heads.

- **Why it matters** — Most senior work crosses team boundaries, and the failure mode is expensive.

- **Follow-ups** — What was their side of the story? When do you escalate, and how? What would you do differently?

- **Senior signal** — Can articulate the other team's position fairly, and escalates transparently rather than politically.

### Q259. Tell me about a time you said no.

- **Expected answer** — Structure: what was asked, why you declined, how you communicated it, what you offered instead, and the outcome. Good looks like: saying no to the *thing*, not the person, with a reason grounded in impact — "adding this would put the checkout path behind an unproven dependency; here is the risk and here are two safer ways to get the same outcome"; being specific about what you would have to stop doing if you said yes, which turns a refusal into a prioritisation conversation; saying it early and directly rather than slow-rolling; and being willing to be overruled gracefully with the risk documented. Strong examples include refusing to ship something unsafe (no rollback path, no authorization on a new endpoint, a migration that would lock a large table during peak), refusing scope that would break a commitment already made, and refusing to add a technology the team cannot operate. Weak looks like: saying no as a reflex, or saying yes to everything and then failing quietly.

- **Why it matters** — The ability to decline well is what stops a senior engineer from becoming a bottleneck or a rubber stamp.

- **Follow-ups** — What happened when you were overruled? How do you say no to your own manager? What do you always say yes to?

- **Senior signal** — Turns "no" into a prioritisation and risk conversation, and documents the risk when overruled.

### Q260. Tell me about a significant failure and what you learned.

- **Expected answer** — Structure: what you were responsible for, what went wrong, your specific contribution to it, the impact, and the durable change you made. Good looks like: choosing a genuinely significant failure rather than a safe one — a project that did not deliver, a design that had to be replaced, an outage you caused, a hire or a delegation that went badly; owning your part precisely without either excusing it or performing guilt; explaining the decision process that led there, since that is what generalises; and describing a specific behaviour change with evidence it stuck, for example "I now write a one-page design with explicit assumptions and get two reviewers before starting anything that will take more than two weeks, and I have done that for the last four projects". The best answers also include what the organisation changed, not only what you changed personally. Weak looks like: a disguised strength ("I care too much"), a failure that was really someone else's, or a lesson with no evidence it changed anything.

- **Why it matters** — It is the clearest test of self-awareness, and self-awareness predicts growth.

- **Follow-ups** — What did you do in the first 24 hours after realising? Who else was affected and how did you handle that? Has the lesson been tested since?

- **Senior signal** — Picks a real failure, owns a precise share of it, and can point to a changed behaviour that has been tested.

## 45.22 Three mock interview loops

Run these against a partner, out loud, on a timer. Reading answers silently builds recognition, not recall — and interviews test recall under mild stress. Record yourself once; you will hear the filler words and the missing numbers immediately.

Score each dimension 1 to 4: **1** = missing or wrong, **2** = mid-level (correct but no trade-offs or failure modes), **3** = senior (trade-offs, failure modes, numbers), **4** = strong senior (production scars, unprompted risks, clean communication). A hire signal at senior level is an average of 3 or above with no 1s on a core dimension.

### 45.22.1 Loop A — 45-minute coding and Node deep dive

**Timing**

| Minutes | Activity |
|---|---|
| 0-3 | Warm-up: what have you built with Node, and at what scale? |
| 3-15 | Coding: implement an in-memory rate limiter (token bucket) with a clean interface and tests in mind |
| 15-25 | Extend it: make it correct across 40 pods; discuss Redis, Lua atomicity, failure modes |
| 25-38 | Node runtime deep dive (questions below) |
| 38-43 | Debugging scenario |
| 43-45 | Candidate questions |

**The exact questions to run**

1. Implement `class TokenBucket { constructor(capacity, refillPerSec); tryConsume(n = 1): boolean }` using a monotonic clock, and say why you chose lazy refill over a timer. (Q114, Q141)
2. Now make it correct across 40 pods. Write the Redis Lua sketch and explain the atomicity requirement. (Q114, Q164)
3. What happens if Redis is down — fail open or closed, and does the answer differ by endpoint? (Q105)
4. Predict the output of the ordering snippet in Q14 and explain each line.
5. Where does `fs.readFile` complete versus an HTTP response, and what is the libuv thread pool? (Q13, Q15)
6. This endpoint's p99 is 900 ms while the query takes 4 ms. Name five possible causes. (Q16, Q229, Q232)
7. Node is single-threaded — why did we still get duplicate orders? (Q27)
8. Walk me through a graceful shutdown in Kubernetes, in order. (Q22, Q199)
9. Debugging: memory grows 40 MB per hour and the pod is OOMKilled every 14 hours. What do you do, in order? (Q19, Q20)

**Rubric**

| Dimension | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Code quality | Does not compile mentally; no types | Works; unclear naming; no edge cases | Typed, small, testable; handles clock and boundary cases | Also discusses testability and a concurrency test |
| Event loop model | Guesses ordering | Recites phases | Explains microtask draining and poll blocking | Predicts output correctly and explains the non-determinism |
| Failure thinking | None offered | Only when prompted | Volunteers timeout, duplicate, partial failure | Names the specific metric that would detect each |
| Debugging method | "Add logs" | Names a tool | Ordered hypothesis-driven method with evidence | Adds the regression guard afterwards |
| Communication | Silent or rambling | Answers only what is asked | Narrates reasoning, checks assumptions | Compresses well and adapts to the interviewer's level |

### 45.22.2 Loop B — 45-minute system design

**Prompt:** "Design a notification service for a food-delivery product: push, SMS and email, 20 million daily active users, driven by order lifecycle events."

**Timing**

| Minutes | Activity | What the interviewer is scoring |
|---|---|---|
| 0-5 | Requirements and scope; what is explicitly out | Does the candidate ask before designing? |
| 5-10 | Capacity math: volume, peak, storage, provider limits | Are there numbers, and is peak treated separately? |
| 10-16 | API and data model; the events consumed | Is the data model concrete with keys and indexes? |
| 16-28 | High-level design: ingestion, dedup, preferences, scheduling, per-channel senders | Are queue boundaries and datastores justified? |
| 28-38 | Deep dive: deduplication, coalescing, per-user rate limits, provider throttling | Depth on one hard problem |
| 38-43 | Failure modes, monitoring, what changes at 10x | Operational thinking |
| 43-45 | Trade-offs the candidate would revisit | Self-critique |

**The exact questions to run**

1. What are the functional requirements, and what are you deliberately not building in v1? (Q111)
2. Do the capacity math including a broadcast campaign of 5 million in 10 minutes. (Q112)
3. Show me the tables. What is the primary key of the notification record and why? (Q97, Q118)
4. A user must never receive the same notification twice. How? (Q115, Q132)
5. Five "order updated" events arrive in 60 seconds. What does the user see? (Q115)
6. The SMS provider rate-limits you to 100 per second. What happens to the other 8,200? (Q112, Q238)
7. Your consumer is 40 minutes behind and retention is 24 hours. What do you do? (Q150, Q155)
8. Where is the transactional boundary between "order paid" and "notification queued"? (Q134)
9. What are your SLIs, and what would page you at 3 a.m.? (Q245, Q246)
10. What breaks first at 10x, and what would you change? (Q128)

**Rubric**

| Dimension | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Scoping | Starts drawing immediately | Asks a few questions | Confirms assumptions and states non-goals | Negotiates requirements and challenges one |
| Capacity math | None | Average only | Peak, storage, growth, per-year cost | Identifies the binding constraint (provider limits) |
| Data model | Vague boxes | Tables listed | Keys, indexes, access patterns, retention | Partitioning and archival designed in |
| Failure design | None | Mentions retries | Idempotency, DLQ, backpressure, degraded modes | Names detection for each failure |
| Trade-offs | Absolutes | One option per decision | Two or three options with a justified choice | Explains what would change the choice |
| Time management | Runs out at 20 min | Uneven | Reaches deep dive and failure modes | Drives the clock deliberately |

### 45.22.3 Loop C — 45-minute PostgreSQL deep dive

**Timing**

| Minutes | Activity |
|---|---|
| 0-5 | Scale context: largest table, RPS, instance size you have operated |
| 5-15 | Query and index design against a given schema |
| 15-25 | Read and fix an `EXPLAIN ANALYZE` plan |
| 25-35 | Concurrency and transactions |
| 35-43 | Operations: vacuum, migrations, connections, replication |
| 43-45 | Candidate questions |

**The exact questions to run**

1. Given `orders(id, tenant_id, status, created_at, total_minor)` at 400 million rows, design the index for `WHERE tenant_id = $1 AND status = 'pending' AND created_at > $2 ORDER BY created_at DESC LIMIT 20`. Justify the column order. (Q72)
2. The same endpoint uses `OFFSET 200000`. Rewrite it and say what you lose. (Q50)
3. Here is a plan with `rows=1` estimated and `rows=480000` actual on a nested loop. What happened and what do you do? (Q70, Q81)
4. Two requests both decrement stock to 0 and we oversold. Give me three fixes and pick one. (Q66, Q119)
5. Explain write skew and give me a constraint-based fix. (Q67)
6. We need to add a `NOT NULL` column with a default to that 400-million-row table with zero downtime. Walk me through it. (Q69, Q76)
7. Autovacuum has not run on this table for six days and queries are getting slower. Why, and what do you check? (Q61, Q62)
8. We have 30 pods with a pool of 20 each and `max_connections = 200`. What happens, and what do you change? (Q77, Q90)
9. Reads moved to a replica and users report their new order is missing. Explain and fix. (Q78, Q143)
10. What timeouts do you set on the application database user, and why three different ones? (Q82)

**Rubric**

| Dimension | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Index design | Guesses columns | Right columns, wrong order | Equality-then-range with a reason; verifies with `EXPLAIN` | Considers covering, partial, and write cost |
| Plan reading | Cannot read it | Reads total time only | Compares estimated versus actual, uses BUFFERS and loops | Diagnoses statistics and proposes extended stats |
| Concurrency | Application-level locks | Knows `FOR UPDATE` | Chooses per contention profile; names isolation and retries | Uses constraints and guarded updates; discusses hot-row throughput |
| Operations | No exposure | Knows the terms | Vacuum, `CONCURRENTLY`, `lock_timeout`, pooling with numbers | Has run these under load and has scars |
| Trade-offs | Absolutes | One answer | States costs of each choice | Says when Postgres is the wrong tool |

## Senior Checklist — Part 45

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can structure any answer as context, options, decision, consequences
- [ ] I can say "I don't know" and describe exactly how I would find out
- [ ] I have three prepared stories with real numbers: a performance win, an incident, and a decision I reversed
- [ ] I can run a 45-minute system design to a deep dive without running out of time
- [ ] I can predict Node event-loop output and explain the non-determinism
- [ ] I can read `EXPLAIN (ANALYZE, BUFFERS)` and name the fix
- [ ] I can design idempotency for a payment endpoint from memory
- [ ] I can state CAP and PACELC correctly and apply them per operation
- [ ] I can define SLI, SLO and error budget and say what happens when the budget is gone
- [ ] I attach a number to every claim I make in an interview

## Part 45 — Key Takeaways

- Senior interviews assess trade-off reasoning, failure thinking, ownership and communication — not recall. Depth without judgement reads as mid-level.
- Structure every substantial answer as context, options, decision, consequences. Four sentences in that shape beat four minutes of unstructured detail.
- Attach a number to every claim: rows, RPS, milliseconds, gigabytes, rupees. Numbers are the difference between "we scaled it" and "we took p99 from 900 ms to 80 ms at 4,000 RPS".
- Volunteer failure modes before you are asked. Run the mantra under every answer: can it timeout, fail, become slow, duplicate, return a wrong response, partially succeed?
- "I don't know" plus a concrete plan to find out scores higher than a confident guess. Bluffing is detected instantly because bluffs have no numbers and no failure modes.
- Absolutes are the most reliable red flag. Name the context where the opposite choice is correct, then choose.
- The database section is where senior candidates separate: MVCC, vacuum, `EXPLAIN`, locking, index design and connection limits are the highest-leverage knowledge you can carry.
- Exactly-once delivery does not exist. At-least-once plus idempotent effects is the achievable design, and idempotency is the single most reusable technique in distributed backends.
- In system design, scope down before you scale up. Saying what you will *not* build in v1 is a stronger signal than another box on the diagram.
- Behavioural rounds are not a formality at senior level. Prepare real stories with impact, your specific contribution, and evidence that the lesson stuck.
- Practise out loud, on a timer, with a partner. Recognition is not recall, and interviews test recall under mild stress.
- The best preparation is operating a system and paying attention while you do it. Every scar in this Part came from an incident someone had to explain the next morning.
