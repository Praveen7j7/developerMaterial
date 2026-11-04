## 68.7 Interview Q&A for the modern technical Parts (59-66)

Continuing the Part 45-style Q&A, this file covers the modern technical Parts: LLM backends, RAG, GraphQL and gRPC, NoSQL, data engineering, and infrastructure as code.

### 68.7.1 LLM backends and RAG (Parts 59-60)

**Q: How is an LLM API call different from a database query, operationally? (Part 59)** It is slow (seconds, scaling with output length), metered per token, non-deterministic, and fallible (hallucination, refusal, timeout, outage). So you stream interactive responses, cache aggressively, push non-interactive work to a queue, cap output tokens, validate output, and wrap it in timeouts, retries, a circuit breaker and a fallback like any external dependency.

**Q: How do you get trustworthy structured output from an LLM? (Part 59)** Use the provider's structured-output or tool-calling feature to constrain the shape, then independently parse and validate against your own schema, and validate meaning against reality (a model-supplied id is checked for existence/ownership), with a bounded retry or fallback on failure. Never trust unvalidated LLM output downstream.

**Q: What is RAG and why use it over fine-tuning? (Part 60)** Retrieval-Augmented Generation retrieves relevant data into the prompt so the model answers from your current, specific facts instead of its training. It is simpler and more current than fine-tuning: when data changes you update the store, not the model, and it avoids hallucination by grounding answers in retrieved, citable context.

**Q: How do you keep a RAG index in sync and prevent cross-tenant leakage? (Part 60)** Sync via outbox/CDC so a source change re-chunks, re-embeds and updates the index (a stale index gives confidently wrong answers); prevent leakage by scoping every retrieval to the tenant (a mandatory filter, enforced structurally) and verifying retrieved chunks belong to the requesting tenant — a missing tenant filter is a data breach.

**Q: How do you make an agent's tool use safe? (Part 60)** Treat each tool call as an action: validate arguments, authorize against the acting user (the agent can do nothing the user could not), make write tools idempotent, require human approval for consequential actions, bound the loop, and log everything. The model's request is never authorization, and user input and tool results are untrusted (prompt injection).

### 68.7.2 GraphQL and gRPC (Part 61)

**Q: What problem does GraphQL solve and what does it cost? (Part 61)** It lets clients fetch exactly the fields they need, including nested data, in one request (solving over-fetching and multiple round trips for rich clients). It costs the N+1 problem (needs DataLoader batching), harder caching than REST, and an open query surface that needs depth/complexity limits.

**Q: What is the N+1 problem in GraphQL and how do you fix it? (Part 61)** Per-field resolution means a query for N objects each needing related data issues 1 + N queries; fix it with a per-request DataLoader that batches the lookups into one query (turning N+1 into ~2), created per request so its cache does not leak across users.

**Q: When do you choose gRPC over REST? (Part 61)** For high-volume, performance-sensitive, internal service-to-service communication, where binary protobuf, a strict typed contract, HTTP/2 multiplexing, streaming and deadline propagation are advantages. Keep it internal — browsers need gRPC-Web or a gateway, and it has no HTTP caching.

**Q: How do you evolve a protobuf schema compatibly? (Part 61)** Never change or reuse field numbers, add fields with new numbers, reserve retired numbers and names, avoid incompatible type changes, and deprecate rather than remove — so independently deployed services stay compatible (the Part 32 discipline via field numbers).

### 68.7.3 NoSQL data modelling (Part 62)

**Q: When is PostgreSQL not the right store? (Part 62)** Only for a specific, measured requirement it cannot meet: extreme write scale past one primary, a key-only access pattern at massive volume, a naturally non-relational shape (document, time-series, graph), or multi-region active-active writes. You usually give up transactions, joins and query flexibility for scale or shape fit.

**Q: How do you model data for DynamoDB? (Part 62)** Access-pattern-first: list every query the app needs, then design partition and sort keys and GSIs so each is a direct key lookup, using single-table design to co-locate related items. Use high-cardinality partition keys to avoid hot partitions; there are no joins or ad-hoc queries.

**Q: Explain Cassandra's write path. (Part 62)** Writes go to an in-memory memtable and an append-only commit log (fast ack), flush to immutable SSTables, and background compaction merges SSTables and removes superseded data — the append-first design gives very high write throughput; consistency is tunable per operation via quorum.

**Q: What is polyglot persistence's main cost? (Part 62)** Operating each additional store and keeping derived stores consistent with one source of truth (via outbox/CDC), with eventual consistency the application must tolerate. Keep one source of truth, make others derived, and add a store only for a specific requirement.

### 68.7.4 Data engineering and IaC (Parts 63-64)

**Q: Why must analytics stay off the production database? (Part 63)** OLTP (row-oriented, many small transactions) and OLAP (large scans/aggregations) need opposite optimizations; running analytics queries on the production database saturates its CPU and I/O and degrades or crashes the application. Analytics belongs in a columnar warehouse fed by the pipeline.

**Q: What is CDC and why prefer it over polling or dual writes? (Part 63)** Change Data Capture streams database changes by reading the write-ahead log (via Debezium/Kafka), capturing every change in order with minimal load. It beats polling (which burdens the database and can miss changes) and dual writes (which diverge if one write fails) because it derives everything from the single committed log.

**Q: What is reconciliation and why does it matter? (Part 63)** Periodically comparing a derived figure (warehouse revenue) against the source of truth (production revenue) and alerting on mismatch; it is the essential backstop that catches silent pipeline failures (dropped events, double-counting) that otherwise produce confidently wrong dashboards.

**Q: Why is infrastructure as code better than clickops? (Part 64)** It brings version control, review, repeatability, consistency across environments and auditability to infrastructure; clickops leaves infrastructure undocumented, unrepeatable, drifting and unreviewable — conditions under which dangerous misconfigurations hide until an incident.

**Q: What guardrails prevent a terraform apply from deleting a production database? (Part 64)** Plan-on-pull-request with review, `prevent_destroy` on stateful resources, policy-as-code blocking production data-store destruction, pipeline-only apply against fixed environments (no laptop apply), and backups as the last line of defense — layered so a casual destructive apply is impossible.

### 68.7.5 Modern system designs (Parts 65-66)

**Q: How do R/W quorums make a distributed KV store's consistency tunable? (Part 65)** A write waits for W replica acks, a read for R responses; R + W > N guarantees a read sees the latest write (strong consistency), while lower values trade consistency for availability and latency — the CAP tradeoff made operational per request.

**Q: Why prefer UUIDv7 over UUIDv4 for IDs? (Part 65)** Both need no coordination, but UUIDv7 is time-ordered (a timestamp prefix), giving far better database index locality (sequential inserts) than random UUIDv4, at the same 128-bit size; it is the pragmatic modern default when a compact 64-bit Snowflake is not required.

**Q: How do you guarantee no double-sell in a booking system? (Part 65)** An atomic conditional update (`UPDATE ... WHERE status = 'available'`): among racing transactions exactly one updates the row and claims the seat, the rest update zero rows and get a correct conflict; a waiting room tames the on-sale thundering herd without trading away this consistency.

**Q: How do you count ad clicks exactly on at-least-once delivery? (Part 66)** Give each event a unique id and count it once (dedup), with atomic aggregate-and-offset updates so crash reprocessing does not double-count, window by event time with late-event handling, and back it with reconciliation from raw events — achieving exactly-once counting without exactly-once delivery.

**Q: Operational transform versus CRDTs for collaborative editing? (Part 66)** Both guarantee all clients converge. OT transforms operations against concurrent ones (needs coordination, small ops, tricky transforms); CRDTs give elements stable identities so operations merge in any order with no central transform (offline/peer-friendly, more metadata). Use a proven library rather than implementing either from scratch.

## 68.8 Offers and negotiation

### 68.8.1 Levels, titles, negotiation and evaluating an offer

#### Concept

The process ends with an offer, and navigating it — understanding levels and titles across companies, negotiating, and evaluating the whole package — is a distinct skill that materially affects the outcome. An offer is not just a number; it is a level, a compensation structure (base, bonus, equity), and a role, and evaluating and negotiating it well is part of the job search.

#### How it works

- **Levels and titles**: titles are inconsistent across companies — one company's "senior" is another's "staff", and compensation bands differ widely. Understand the level you are being offered relative to the company's ladder and relative to your actual scope (Part 44), because the level, more than the title, drives compensation and expectations.
- **Compensation structure**: total compensation is typically base salary plus bonus plus equity (stock, with vesting). The mix varies enormously (a startup may offer more equity and less cash; big tech a large equity component). Evaluate the whole package and understand the equity (what kind, vesting schedule, and realistic value — be skeptical of headline equity numbers), not just the base.
- **Negotiation basics**: negotiation is expected and normal; the offer is usually not the ceiling. Negotiate respectfully and with information — competing offers, market data for the level, and the specific components you value. Negotiate the level if you believe it is mis-set, because level has the largest long-term impact. Be honest and professional; the goal is a fair outcome and a good start to the relationship, not to win.
- **Evaluating an offer**: beyond compensation, weigh the role and scope, the team and manager, growth opportunity, the technical environment, work-life factors, and the company's trajectory. The best offer is not always the highest number; a role that grows you and a team you learn from can be worth more over a career.

#### How a Senior Backend Engineer thinks about this

A senior treats the offer stage as professionally as the interview: understanding the level relative to their actual scope (Part 44) and the company's ladder, evaluating total compensation including a realistic view of equity (not the headline number), and negotiating respectfully with information because the offer is rarely the ceiling and level has the largest long-term impact. They weigh the whole picture — scope, team, manager, growth, technical environment, trajectory — not just the number, because the best career move is often not the highest offer. They are honest and professional throughout, because they are starting a relationship, and they know their worth from their demonstrated scope and impact rather than anchoring on a single number.

#### Common mistakes

- Accepting the first offer without negotiating (the offer is usually not the ceiling).
- Focusing only on base salary, ignoring equity structure and realistic value.
- Ignoring the level, which drives compensation and expectations more than the title.
- Chasing the highest number over the role, team, growth and trajectory.
- Negotiating adversarially rather than respectfully with information.

#### Interview questions (for your preparation)

1. **Why does the level matter more than the title?** Titles are inconsistent across companies; the level drives compensation band and expectations, and has the largest long-term impact — negotiate it if it is mis-set.
2. **How do you evaluate an offer beyond the number?** Weigh total compensation (base, bonus, equity with a realistic equity view), plus role, scope, team, manager, growth, technical environment and company trajectory.
3. **How should you negotiate?** Respectfully and with information (competing offers, market data for the level, the components you value); it is expected and the offer is rarely the ceiling.

#### Practical exercise

For a hypothetical offer, write out: the level and how it maps to your actual scope (Part 44), the total compensation broken into base/bonus/equity with a realistic equity assessment, two points you would negotiate and the information supporting each, and three non-compensation factors you would weigh. Acceptance criteria: you evaluate the whole package (not just base), reason about the level, and base your negotiation on information.

## Senior Checklist — Part 68

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
- [ ] I can write a resume and project write-ups that lead with quantified impact and scope
- [ ] I can recognize the coding pattern from its cues and solve live with a clear method
- [ ] I can run a 45-minute system design as a timed procedure and handle pushback by reasoning
- [ ] I know what each other round type (take-home, debugging, review, pairing, API design) scores
- [ ] I can prepare for a staff/principal loop (past-project deep dive, architecture, influence, writing)
- [ ] I can answer interview questions on Parts 51-66 concisely with examples
- [ ] I can evaluate and negotiate an offer by level and total package, not just the number

## Part 68 — Key Takeaways

- The hiring process is a funnel; optimize each stage for its signal — a resume leads with quantified impact and scope to earn the screen, and preparation is tailored to the company type's emphasis.
- Most coding problems are instances of a small pattern catalogue (two pointers, sliding window, BFS/DFS, heaps, DP, graphs, intervals, monotonic stack, union-find); recognition from cues plus clean execution plus communication wins.
- In the coding round, state the approach and complexity before coding and get buy-in, then test your own code by tracing it — coding a wrong approach silently is the most common failure.
- Run the system design round as a timed procedure (clarify, estimate, API/data, high-level, deep dive, cross-cutting, tradeoffs), narrate constantly, and handle pushback by reasoning about the tradeoff, not defending rigidly.
- Each other round type is a proxy for part of the job: production-quality right-sized take-homes, systematic debugging, constructive code review, genuine collaboration in pairing, and contract craft in API design.
- Staff/principal loops weight scope, judgment and influence over coding, centered on a past-project deep dive; prepare two or three projects you can discuss in deep detail with tradeoffs, failures, influence and measurable impact.
- Strong staff/principal answers show concrete scope and numbers, explicit tradeoff reasoning, influence through mechanisms (not authority), and honesty about failures with lessons.
- Interviews are a learnable skill separate from the job; strong engineers under-perform from poor method under pressure, so practice the methods (recognition, live-solving, the design procedure), not just the knowledge.
- The offer is a level plus a total package, not just a number; the level drives compensation and expectations, equity needs a realistic (not headline) assessment, and negotiation is expected and informed.
- Evaluate an offer on the whole picture — scope, team, manager, growth, trajectory — because the best career move is often not the highest number, and know your worth from demonstrated scope and impact.
