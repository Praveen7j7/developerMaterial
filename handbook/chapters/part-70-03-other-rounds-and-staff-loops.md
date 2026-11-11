## 70.4 Other round types

### 70.4.1 Take-homes, debugging, code-review, pair programming, API design

#### Concept

Beyond coding and system design, loops include other round types, each testing a different facet: **take-home assignments** (build something on your own time), **debugging rounds** (find and fix a bug in given code), **code-review rounds** (review a PR), **pair programming** (collaborate on a problem live), and **API design rounds** (design an API's contract). Knowing what each is scoring lets you prepare for the specific signal.

#### How it works — what each round scores and how to approach it

| Round | What it scores | How to approach it |
|---|---|---|
| Take-home | Real-world code quality, structure, tests, docs, judgment on an open problem | Treat it like production code: clean structure, tests, a README explaining decisions and tradeoffs; respect the time box; do not gold-plate |
| Debugging | Systematic debugging, reading unfamiliar code, hypothesis-driven fixing (Part 57) | Reproduce first, form a hypothesis, isolate, verify the fix; narrate your reasoning; do not guess randomly |
| Code review | Judgment on correctness, security, performance, maintainability; communication (Part 58 — How seniors review code) | Check for real issues (bugs, N+1, injection, missing error handling, Part 40); prioritize; give constructive, specific feedback |
| Pair programming | Collaboration, communication, handling feedback, working with someone | Think aloud, involve the interviewer, accept suggestions, be the collaborator they would want as a teammate |
| API design | Contract design: resources, methods, status codes, versioning, errors (Parts 15, 16 and 25) | Design clear resource-oriented endpoints, correct status codes, idempotency, pagination, versioning; justify choices |

The common thread: each round is a proxy for a slice of the real job, so the best preparation is to do that slice well. A take-home is judged like a code review of your production work — clean, tested, documented, right-sized (do not over-build, do not under-deliver). A debugging round rewards the systematic method from Part 57 (reproduce, hypothesize, isolate, verify), not random guessing. A code-review round rewards the judgment and communication from Part 58 — finding the issues that matter and giving constructive feedback. A pair-programming round rewards being a good collaborator. An API-design round rewards the contract craft from Parts 15 and 25.

#### Practical example — the take-home README

Reviewers often read the README before the code, and many decide in its first screen. A README that earns the next round answers five questions in under a page:

```text
# Order Export Service (take-home)
Run:        docker compose up && npm test   (Node 20, PostgreSQL 16)
Scope:      Implemented: CSV export with filters, idempotent job creation, 23 tests.
            Not implemented (time box): S3 upload (writes to ./exports), auth.
Decisions:  1. Export runs as a job (POST returns 202 + job id) because exports of 1M rows
               take ~40 s; a synchronous request would time out at the gateway.
            2. Keyset pagination over created_at,id when streaming rows, not OFFSET.
Tradeoffs:  Jobs table with SKIP LOCKED instead of a broker: fine to ~1k jobs/min.
With more time: retries with backoff, per-tenant concurrency limits, S3 multipart upload.
```

Four hours of code with this README beats eight hours of code without it, because the reviewer can see your judgment, not just your typing.

#### Practical example — a debugging round

The interviewer shares a NestJS service and a symptom: "In production, a few orders a day exist with no stock decremented, and occasionally we see `QueryRunnerAlreadyReleasedError` in the logs." The code:

```ts
@Injectable()
export class OrdersService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  async placeOrder(dto: PlaceOrderDto): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.orders.save(this.orders.create({ userId: dto.userId, status: 'placed' }));
      dto.items.forEach(async (item) => {
        await manager.decrement(StockItem, { sku: item.sku }, 'qty', item.qty);
      });
      return order;
    });
  }
}
```

The strong candidate narrates the method rather than staring at the code: "Reproduce: I would place an order with two items and a forced failure on the second decrement. Hypothesis from the symptom: work is escaping the transaction." Then the bugs, in the order the method finds them:

1. `this.orders.save` uses the injected repository, which runs on its own connection, outside the transaction. The order commits even when the stock update later fails: that is the "orders with no stock decremented".
2. `forEach(async ...)` does not wait for its callbacks. The transaction callback returns, TypeORM commits and releases the query runner, and the decrements then run against a released runner: that is the `QueryRunnerAlreadyReleasedError`, and the reason some decrements never happen.
3. `decrement` has no floor, so stock can go negative under concurrency (69.1.3).

```ts
async placeOrder(dto: PlaceOrderDto): Promise<Order> {
  return this.dataSource.transaction(async (manager) => {
    const order = await manager.save(manager.create(Order, { userId: dto.userId, status: 'placed' }));  // fix 1: the transaction's manager
    for (const item of dto.items) {                                   // fix 2: awaited, one at a time
      const result = await manager
        .createQueryBuilder()
        .update(StockItem)
        .set({ qty: () => 'qty - :qty' })
        .where('sku = :sku AND qty >= :qty', { sku: item.sku, qty: item.qty })
        .execute();
      if (result.affected === 0) throw new OutOfStockError(item.sku);  // fix 3: rolls back everything
    }
    return order;
  });
}
```

"Verify: the same forced-failure test now leaves no order row, and a test with two parallel orders for the last unit produces exactly one success." Naming the verification step is what turns "found the bug" into "fixed the bug".

#### Practical example — a code-review round

The PR adds product search. Read it as you would a teammate's PR, then rank what you find:

```ts
@Get('search')
async search(@Query('q') q: string) {
  try {
    const products = await this.dataSource.query(`SELECT * FROM products WHERE name ILIKE '%${q}%'`);
    for (const p of products) {
      p.reviews = await this.reviews.find({ where: { productId: p.id } });
    }
    return products;
  } catch (e) {
    return [];
  }
}
```

| Priority | Comment |
|---|---|
| Blocking | SQL injection: `q` is interpolated into SQL. `q = "'; DROP TABLE products; --"` is a real risk. Bind it as a parameter (Part 40). |
| Blocking | Unbounded result: a two-letter query can return 200,000 rows. Add `limit` with a maximum and validate `q` with a DTO. |
| Should fix | N+1: one reviews query per product; 50 products is 51 queries. Fetch reviews with one `In(ids)` query. |
| Should fix | `catch` returns `[]`, so a database outage looks like "no results" and nobody gets paged. Let it throw to the exception filter. |
| Should fix | `SELECT *` returns internal columns (cost price, supplier id). Select explicit fields. |
| Question | Leading-wildcard `ILIKE` cannot use a B-tree index. Do we need a `pg_trgm` GIN index (Part 34)? |

The fixed version, offered as a suggestion rather than a rewrite of their PR:

```ts
export class SearchProductsQuery {
  @IsString() @Length(2, 100) q!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}

@Get('search')
async search(@Query() query: SearchProductsQuery) {
  const products = await this.products
    .createQueryBuilder('p')
    .select(['p.id', 'p.name', 'p.priceCents'])                 // explicit columns, nothing internal
    .where('p.name ILIKE :pattern', { pattern: `%${query.q}%` })  // bound parameter, no injection
    .orderBy('p.name')
    .take(query.limit)
    .getMany();
  const reviews = products.length
    ? await this.reviews.find({ where: { productId: In(products.map((p) => p.id)) } })  // one query, not N
    : [];
  return products.map((p) => ({ ...p, reviews: reviews.filter((r) => r.productId === p.id) }));
}
```

The interviewer is scoring three things: did you find the injection (non-negotiable), did you rank issues instead of listing twenty style nits, and was your tone the one they would want on their team ("could we bind this as a parameter?" rather than "this is wrong").

#### Practical example — an API design round

"Design the API for order returns and refunds." A strong answer is a table plus the reasoning for the three hard parts:

| Method and path | Purpose | Success | Notable errors |
|---|---|---|---|
| `POST /orders/{orderId}/returns` | Request a return (items, reason); `Idempotency-Key` header | 201 + return id | 409 window closed, 422 item not returnable |
| `GET /orders/{orderId}/returns` | List returns for an order | 200 | 404 order not found or not yours |
| `GET /returns/{returnId}` | Return status and refund state | 200 | 404 |
| `POST /returns/{returnId}/cancel` | Customer cancels before pickup | 200 | 409 already picked up |
| `GET /returns?status=pending&cursor=` | Ops queue, cursor-paginated | 200 | 403 not ops |

The three hard parts to talk through: idempotency (a retried `POST` must not create two returns, so the key is stored with the response, Part 30 — Distributed Transactions: Sagas, Outbox, Inbox and Idempotency); state transitions modelled as actions (`/cancel`) rather than a free-form `PATCH status`, so illegal transitions are impossible by construction; and refunds as an asynchronous consequence with their own status, because the payment provider can take days.

#### How a Senior Backend Engineer thinks about this

A senior recognizes each round as a proxy for part of the job and brings the relevant discipline from the technical Parts: production-quality code with tests and a decision-explaining README for take-homes (right-sized to the time box), the systematic debugging method for debugging rounds, the code-review craft (real issues, prioritized, constructive) for review rounds, genuine collaboration for pair programming, and contract design for API rounds. They know take-homes are often where over-engineering sinks candidates (building far beyond the prompt) or under-delivering sinks them (no tests, no README), so they right-size and explain their tradeoffs. They narrate their reasoning in every round, because communication is scored across all of them, and they treat each as a chance to show how they actually work, which is exactly what these rounds are designed to reveal.

#### Common mistakes

- Take-home: over-engineering beyond the prompt, or under-delivering (no tests, no README, no explanation of decisions).
- Debugging: guessing randomly instead of reproducing and forming hypotheses (Part 57).
- Code review: nitpicking style while missing real bugs/security issues, or harsh non-constructive feedback (Part 58).
- Pair programming: coding silently, not collaborating or accepting input.
- API design: verbs in paths, wrong status codes, no idempotency/pagination/versioning (Parts 15 and 25).

#### Interview questions (for your preparation)

1. **How should you treat a take-home assignment?** Like production code: clean structure, tests, a README explaining decisions and tradeoffs, right-sized to the time box — not over-engineered, not under-delivered.
2. **What method should a debugging round show?** Systematic debugging (Part 57): reproduce, hypothesize, isolate, verify the fix, narrating — not random guessing.
3. **What makes a strong code-review round performance?** Finding the issues that matter (correctness, security, performance, maintainability), prioritizing them, and giving specific constructive feedback (Part 58).
4. **What does a pair-programming round really test?** Collaboration and communication — thinking aloud, involving the interviewer, accepting feedback — being the teammate they would want.
5. **A take-home says "about 4 hours". You have spent 4 and are not done. What do you do?** Stop, finish the tests for what exists, and write the unfinished parts into the README under "with more time". Reviewers respect the time box; a 12-hour submission raises questions about judgement, and sometimes about honesty.

#### Practical exercise

Pick two of the other round types and practice each: for a debugging round, take a piece of code with a planted bug and apply the reproduce-hypothesize-isolate-verify method aloud; for an API-design round, design the endpoints for a small service (resources, methods, status codes, idempotency, pagination, versioning) and justify each choice. Acceptance criteria: the debugging practice shows a systematic method (not guessing), and the API design follows the conventions of Parts 15 and 25 with justified choices.

## 70.5 Staff and principal loops

### 70.5.1 Past-project deep dive, architecture round, leadership signals, written exercises

#### Concept

Staff and principal loops (Part 59 defines the levels) differ from senior loops: they weight scope, judgment, influence and architectural depth far more than raw coding, and they add round types designed to surface those — a past-project deep dive, an architecture round, leadership and influence assessment, and sometimes a written exercise. The bar is about demonstrated impact at scale and the ability to drive technical direction across teams, not just to build well.

#### Why does it exist?

A staff or principal engineer's value is leverage — multiplying the effectiveness of many engineers through architecture, technical strategy, influence and mentorship (Parts 83–89) — so the loop must assess those, which a coding round cannot. These rounds exist to probe whether a candidate has operated at that scope: led a major migration (Part 86), set technical direction (Part 84), influenced without authority (Part 88), designed systems that held up (Parts 16, 26, 37–39, 52, 55–67 and 83–90), and grown other engineers (Part 89). The signals are judgment, scope, communication and influence, assessed through deep conversations about real past work and realistic scenarios.

#### How it works — the round types

- **Past-project deep dive**: a long conversation about a significant project you led, probing your decisions, tradeoffs, what went wrong, how you influenced others, and what you would do differently. This is the central staff/principal round. The interviewer digs for depth: why this choice, what alternatives, what was the hardest part, how did you handle disagreement, what was the measurable impact. Prepare two or three projects you can discuss in depth with the clarity of the write-ups from 70.1.
- **Architecture round**: like the system design round but broader and deeper — often an open-ended, organization-scale problem (design the architecture for this product area, or evaluate this existing architecture), probing judgment, tradeoffs, migration thinking (Part 86), and governance (Part 85). It assesses whether you can architect at scope, not just design one service.
- **Leadership and influence**: behavioural and scenario rounds probing how you influence without authority (Part 88), handle disagreement and conflict, mentor and grow engineers (Part 89), make decisions under ambiguity, and communicate with executives and stakeholders. The signal is leverage and judgment, demonstrated through concrete past examples (structured as situation, your action, the outcome).
- **Written exercise**: some loops ask for a written document (a design doc, a strategy memo, an architecture evaluation) because writing is the staff/principal engineer's primary tool (Part 83). It assesses whether you can structure a complex argument clearly in writing — the exact skill Part 83 teaches.

```text
Senior loop weight:   coding ███ | system design ███ | behavioural ██
Staff/principal shift: coding █   | architecture ████ | past-project deep dive ████
                       | leadership & influence ████ | written exercise ██
(coding still appears but weighs far less; scope, judgment and influence dominate)
```

#### How it works — strong vs weak answers

| Signal | Weak answer | Strong answer |
|---|---|---|
| Scope | "I built a feature" | "I led a cross-team migration affecting 40 services over 18 months" |
| Decisions | "We used Kafka" | "We chose Kafka over the outbox because volume hit 10k/s; here's the tradeoff we accepted" |
| Influence | "I told them to do it" | "I pre-wired the key reviewers, wrote an RFC, and built consensus before the decision meeting" (Part 88) |
| Failure | "It went fine" | "We lost 0.3% of refunds in a migration; reconciliation caught it; here's what I changed" (Part 86) |
| Impact | "It was faster" | "p99 dropped from 400ms to 90ms; the reliability program cut incidents by 60%" |

The pattern of strong staff/principal answers: concrete scope and measurable impact, tradeoffs reasoned explicitly (what you gave up and why), influence shown through the mechanisms of Part 88 (pre-wiring, writing, coalitions) rather than authority, and honesty about failures with what you learned and changed. Weak answers are vague, take sole credit or no responsibility, show no tradeoff reasoning, and lack numbers.

#### Practical example — the deep dive, five "why"s down

An interviewer probing a migration story. Each level is where weak stories run out:

```text
Q: Tell me about a project you led.
A: Moving payments from the monolith to its own service, 18 months, 4 teams.
Q: Why that approach rather than refactoring inside the monolith?
A: Deploy coupling: payment fixes waited on a weekly release train. We measured
   11 days median lead time for payment changes; the target was under 1 day.
Q: Why CDC instead of dual writes?
A: Dual writes diverge on partial failure. We had seen a 0.2% divergence in an
   earlier project. CDC plus nightly reconciliation on amounts, not row counts.
Q: What went wrong?
A: The backfill read the primary and pushed replica lag to 40 s at 2am, which broke
   the fraud service's reads. I moved backfills to a replica with a rate limiter and
   added replica lag to the migration dashboard as a stop condition.
Q: Who disagreed, and how did you resolve it?
A: The fraud team lead wanted a freeze until Q3. I met him one-on-one, learned his
   real constraint was an audit in May, and we sequenced his cutover after it.
   The RFC recorded that as a dated decision.
Q: What would you do differently?
A: Start reconciliation on day one. We added it in month four and found two old
   bugs in the monolith that the migration had been blamed for.
```

Every answer carries a number, a named tradeoff, or a person and a mechanism. That is what "survives deep probing" means.

#### Practical example — the architecture round and the written exercise

An architecture-round prompt at staff level is deliberately larger than one system: "Our checkout spans 9 services owned by 5 teams, p99 is 2.1 s, and every incident needs three teams on a call. What would you do over the next year?" A strong answer does not jump to a target diagram. It diagnoses first (where the latency goes, which team boundaries cut through the hot path, Part 87 — Org Design, Conway's Law and Platform Engineering), proposes a target with a migration path rather than a rewrite (Part 86), names what it refuses to do this year (Part 84 — guiding policy), and says how progress will be measured.

A written exercise usually gives 60 to 90 minutes or a take-home day for a two-page memo. The structure that works is the one Part 83 teaches: the recommendation in the first paragraph, context in five sentences, two or three options with honest tradeoffs, the recommendation's risks and how they are mitigated, and the decision needed with a date. Reviewers score clarity and judgement, not length; a crisp two pages beats a sprawling eight.

#### How a Senior Backend Engineer thinks about this

A senior preparing for a staff/principal loop prepares two or three significant projects they can discuss in deep detail — the decisions, the tradeoffs, the failures, the influence, the measurable impact — because the past-project deep dive is the heart of the loop and depth is what distinguishes real scope from narration. They practice articulating tradeoffs explicitly (the Part 64 and Part 83 discipline), demonstrating influence through the mechanisms of Part 88 rather than claiming authority, and being honest about failures with concrete lessons. They prepare for an organization-scale architecture round using the migration (Part 86), governance (Part 85) and strategy (Part 84) thinking, and they sharpen their writing (Part 83) for a possible written exercise. They know the loop assesses leverage and judgment, so they frame everything in terms of impact at scope, not individual output.

#### Common mistakes

- Thin past-project stories that cannot survive deep probing (no real depth of decisions, tradeoffs, failures).
- Claiming sole credit or taking no responsibility; staff/principal is about influence and collaboration.
- No tradeoff reasoning — "we used X" without why or what was given up.
- No numbers — unquantified impact reads as unsubstantiated.
- Demonstrating influence as authority ("I told them") rather than the mechanisms of Part 88.
- Treating it like a senior loop (over-indexing on coding) instead of scope, judgment and influence.
- Saying "we" for everything. Interviewers need to know what *you* did; say "we" for the team's outcome and "I" for your decisions and actions.

#### Interview questions (for your preparation)

1. **What is the staff/principal loop assessing versus the senior loop?** Scope, judgment, influence and architectural depth (leverage), through a past-project deep dive, architecture round, leadership/influence rounds and sometimes a written exercise — coding weighs far less.
2. **How do you prepare for the past-project deep dive?** Prepare two or three significant projects you can discuss in deep detail: decisions, tradeoffs, failures, how you influenced others, and measurable impact.
3. **What makes an influence answer strong?** Showing the mechanisms of influence without authority (pre-wiring reviewers, writing an RFC, building consensus — Part 88) and measurable outcomes, not "I told them to do it".
4. **Why might there be a written exercise?** Writing is the staff/principal engineer's primary tool (Part 83); the exercise assesses whether you can structure a complex technical argument clearly in writing.
5. **What if your best project failed?** Use it. A project that was cancelled for good reasons, with your part in recognizing that early, shows more staff-level judgement than a success you rode along on. Be precise about what you learned and what you now do differently.

#### Practical exercise

Prepare one significant past project for a deep-dive round: write out the problem and scope (with numbers), two key decisions with the tradeoffs you reasoned through and the alternatives you rejected, one thing that went wrong and what you changed, how you influenced others toward the decision (using Part 88 mechanisms), and the measurable impact. Then have someone probe it with "why?" five levels deep. Acceptance criteria: the story survives deep probing with real detail at every level, shows tradeoff reasoning and influence (not authority), and quantifies both scope and impact.
