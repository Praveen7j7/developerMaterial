### Q122. Read replica or cache — how do you choose?

- **Expected answer** — They solve different problems. A read replica scales *query* capacity while keeping full SQL, joins, and transactional freshness within replication lag (usually milliseconds); it needs no invalidation logic, so it cannot go stale in a way you did not design for. A cache scales *specific hot reads* to sub-millisecond and removes load entirely, but you now own invalidation, stampedes, serialization and a second failure domain. My ordering: first fix the query and the index, because most "we need a cache" situations are a missing index; then add a replica if the workload is broadly read-heavy with varied queries; then add a cache for the narrow set of very hot, expensive, tolerably-stale reads. Concretely: a product detail page hit 5,000 times a second with a 15 ms query is a cache candidate; an admin reporting workload is a replica candidate. Costs to state: a replica doubles database spend and introduces read-your-writes bugs; a cache introduces staleness, stampedes on expiry, and the risk that a cache outage sends 100% of traffic to a database sized for 10%. That last one is the important operational point — always load-test with the cache disabled.

- **Why it matters** — This choice is made badly and often, usually by adding Redis to hide a missing index.

- **Follow-ups** — What happens to your database when Redis restarts empty? How do you invalidate on write? Would you cache in the application or use a replica for a report that runs every 5 minutes?

- **Senior signal** — "Fix the index first", and the cache-cold-start thundering-herd risk with a concrete mitigation.

### Q123. Partitioning versus sharding — what is the difference and when do you shard?

- **Expected answer** — Partitioning splits one table into pieces *within* one database instance: the planner prunes, maintenance is per-partition, and transactions and joins still work normally. Sharding splits data across *separate* database instances: you gain write and storage capacity beyond one machine, and you lose cross-shard transactions, cross-shard joins, global unique constraints, and simple `ORDER BY` across shards. So partition early and freely for data lifecycle; shard late and reluctantly, only when a single primary genuinely cannot hold the write volume or the working set. Before sharding, exhaust: better indexes, read replicas, caching, moving cold data out, upgrading the instance (modern hardware handles a great deal — a single Postgres box can do tens of thousands of writes per second), and splitting by *service* rather than by rows, which is usually easier and more valuable. If you must shard, choose the key carefully: it should be present on almost every query (`tenant_id` for B2B, `user_id` for consumer), it determines your skew exposure, and changing it later is a migration project. Use consistent hashing or a lookup/directory table so you can rebalance; a modulo scheme makes adding shards a full reshuffle.

- **Why it matters** — Premature sharding is one of the most expensive architectural mistakes available.

- **Follow-ups** — How do you do a cross-shard report? What is the migration path from unsharded to sharded with no downtime? Why is a directory table better than modulo?

- **Senior signal** — A concrete ladder of cheaper options before sharding, and awareness that the shard key is a near-permanent decision.

### Q124. When and how would you use a CDN?

- **Expected answer** — For anything static or cacheable at the edge: images, JS/CSS bundles, video segments, and increasingly for cacheable API responses. The mechanics: the CDN caches by URL plus the `Vary` headers, honours `Cache-Control` (`max-age`, `s-maxage`, `stale-while-revalidate`, `stale-if-error`), and you invalidate either by purge API or, far better, by content-hashed immutable URLs (`app.4f3c9a.js` with `max-age=31536000, immutable`) so you never purge at all. Benefits are latency (an edge PoP 20 ms away instead of an origin 200 ms away), origin offload (a 95% hit ratio means 20x less origin traffic), and absorbing traffic spikes and some DDoS. Things people get wrong: caching authenticated responses without `Vary` on the auth dimension, which serves one user's data to another; setting a long TTL on HTML so a bad deploy is stuck at the edge for a day; and forgetting `stale-if-error`, which would have kept the site up when the origin died. For API responses I use short `s-maxage` (seconds to a minute) with `stale-while-revalidate` on genuinely public endpoints only, and `Cache-Control: private, no-store` on anything user-specific.

- **Why it matters** — The CDN is the cheapest performance and resilience win available, and also a way to leak data.

- **Follow-ups** — How do you cache a personalised page safely? What does `stale-while-revalidate` do to your origin load during a deploy? How do you handle a purge that must be immediate?

- **Senior signal** — Content-hashed immutable assets instead of purging, and the authenticated-response leak risk stated as a security concern.

### Q125. A product manager asks for full-text search over 50 million products. What do you build?

- **Expected answer** — Start with requirements: what quality of relevance, typo tolerance, faceting, latency target, update freshness, and who maintains it. Options. **Postgres full-text** (`tsvector` plus GIN, `pg_trgm` for fuzzy) is free, transactional, and genuinely good for a few million documents with simple relevance — no extra system, no sync problem. **OpenSearch/Elasticsearch** gives real relevance tuning, analyzers per language, faceting, aggregations, and horizontal scale, at the price of a cluster to operate, a sync pipeline, and eventual consistency between the source of truth and the index. **A managed search product** (Algolia, Typesense, Meilisearch) gives excellent relevance and typo tolerance with almost no operations, at a per-record cost that gets expensive at 50 million documents. At 50 million products with faceting, I would go with OpenSearch, keep Postgres as the source of truth, and sync via the outbox and a stream consumer with a full reindex job as the backstop. The parts people underestimate: reindexing strategy with aliases for zero-downtime schema changes, handling the lag between a price change and search reflecting it, and relevance evaluation — you need a labelled query set and a metric, or "improving relevance" is guesswork.

- **Why it matters** — It is a build-versus-buy question with real operational consequences.

- **Follow-ups** — How do you reindex 50 million documents without downtime? What is the sync lag and does the business accept it? When is Postgres full-text enough?

- **Senior signal** — Names the sync pipeline and reindexing as the hard parts rather than the query DSL, and insists on relevance measurement.

### Q126. What changes when you go multi-region?

- **Expected answer** — Almost everything, so the first question is *why*: latency for users, regulatory data residency, or disaster recovery? Each implies a different design. For **DR only**, the cheapest answer is one active region plus asynchronous replication to a warm standby, a documented RTO/RPO (say 15 minutes and 1 minute), and a tested failover runbook — untested failover is not a DR plan. For **latency**, put read replicas and caches near users but keep writes in one region; most applications are read-heavy and this gets 80% of the benefit with 10% of the complexity. For **active-active writes**, you have signed up for conflict resolution: either partition ownership by key (each user's data has a home region, writes route there), or accept CRDT/last-write-wins semantics and design the data so conflicts are meaningless. Cross-region latency of 80–150 ms makes synchronous replication painful and any chatty request path unusable, so batch and denormalise. Also budget for the boring things: cross-region data transfer costs real money, schema migrations must now be coordinated, and regional dependency graphs must be verified (a service in eu-west calling an auth service that only exists in us-east has not achieved anything).

- **Why it matters** — Multi-region is frequently requested and rarely justified; the analysis matters more than the architecture.

- **Follow-ups** — What is your RPO and how do you prove it? How do you route a write for a European user whose home region is down? What breaks first in a multi-region deploy?

- **Senior signal** — Starts by challenging the requirement, offers a cheap read-local/write-central option, and mentions testing failover and hidden cross-region dependencies.

### Q127. Estimate: how much storage and bandwidth for a video service with 100,000 daily uploads averaging 5 minutes?

- **Expected answer** — Do it out loud with round numbers. Ingest: 100,000 x 5 minutes = 500,000 minutes/day. Raw uploads at, say, 20 Mbps for phone 1080p is 150 MB per minute, so 75 TB/day of source — but you would store source cheaply (S3 Glacier-class after processing) or discard it. Transcoded output is what matters: five renditions (240p, 360p, 480p, 720p, 1080p) totalling roughly 6 Mbps combined ≈ 45 MB per minute, so 500,000 x 45 MB ≈ 22 TB/day ≈ 8 PB/year. That number alone tells you the retention and tiering policy is the biggest cost lever in the design. Bandwidth: if each video averages 500 views at 720p (~3 Mbps ≈ 22 MB/minute, say 2 minutes watched) ≈ 45 MB per view, 100,000 x 500 x 45 MB ≈ 2.2 PB/day of egress — which at typical CDN pricing is the dominant cost of the entire business, so the design conversation becomes CDN contracts, caching ratio and adaptive bitrate, not databases. Transcoding compute: 500,000 minutes/day at roughly 0.5x realtime per rendition on a GPU fleet gives an estimate of the worker fleet size.

- **Why it matters** — The point is not the exact figure; it is whether you can reason to the dominant cost in two minutes.

- **Follow-ups** — Which number would you verify first? How does adaptive bitrate change egress? What would you do to cut cost by half?

- **Senior signal** — Rounds aggressively, states assumptions, and finds the number that dominates the design instead of computing everything equally.

### Q128. Your system works at today's load. What would you change for 100x?

- **Expected answer** — First, refuse to design for 100x speculatively; say what would break in order, and what the *next* bottleneck would be, because that is how you actually plan. Typical ordering for a Node/Postgres system: (1) the single primary's write capacity and connection count — fix with PgBouncer, batching, and moving high-volume append-only data (events, logs, audit) out of the transactional database; (2) read capacity — replicas and caching; (3) table sizes making vacuum, index builds and backups unmanageable — partition and archive; (4) synchronous cross-service calls creating latency and coupling — move to events with an outbox; (5) hot keys and skew — shard counters, salt partitions; (6) only then shard the database or split services. In parallel, the operational things that must scale with you: observability cardinality and cost, deploy time, migration safety at 100x row counts, and on-call load. Also state what you would deliberately *not* do now: build for 100x today and you will have paid for complexity you cannot operate, with a design based on guesses about traffic shape. The senior move is to make the *next* order of magnitude cheap — clean boundaries, an outbox, metrics — not to build the final architecture up front.

- **Why it matters** — It tests both scaling knowledge and judgement about when to apply it.

- **Follow-ups** — What single metric tells you the first bottleneck is approaching? What is the cost of preparing for 100x too early? What would you do in the next sprint versus the next year?

- **Senior signal** — Gives an ordered bottleneck list with the reason each falls over, and explicitly refuses premature complexity while keeping the door open.
## 59.10 Distributed systems

### Q129. State CAP correctly.

- **Expected answer** — CAP says that when a network **partition** occurs, a distributed system must choose between **consistency** (every read sees the latest committed write — technically linearizability) and **availability** (every non-failing node answers every request). It is not "pick two of three": partition tolerance is not optional, because networks partition whether you like it or not, so the theorem is really a statement about behaviour *during* a partition. It also applies to a specific operation, not to a whole product: the same system can be CP for payment writes and AP for a "who is online" indicator. And the C in CAP is much stronger than the C in ACID; a system can be ACID-compliant on a single node and still be AP as a cluster. Real examples: a Postgres primary with synchronous replication refuses writes when it cannot reach a quorum (CP); a Redis cluster or a Cassandra ring with a low consistency level keeps serving possibly-stale data (AP). The senior framing is that the interesting question is never "CP or AP" in the abstract, it is "for this operation, what does the user experience if the two halves cannot talk, and which failure is cheaper?"

- **Why it matters** — Misquoting CAP is a reliable marker of second-hand knowledge.

- **Follow-ups** — Which is your login flow, and which is your analytics ingestion? Is a single-node database CP or AP? What does "available" formally mean here?

- **Senior signal** — Says partition tolerance is not a choice, applies CAP per operation, and separates it from ACID.

### Q130. What does PACELC add?

- **Expected answer** — PACELC extends CAP with the case everyone actually lives in: **if** there is a **P**artition, choose **A**vailability or **C**onsistency; **E**lse (normal operation), choose **L**atency or **C**onsistency. That "else" branch is the important half, because partitions are rare while the latency-versus-consistency trade-off is paid on every single request. Synchronous replication to another availability zone adds 1–2 ms; to another region, 80–150 ms — on every commit. Reading from a replica is fast but stale. So a system is described as, for example, PC/EC (a strongly consistent database like Spanner-style systems, consistent even at latency cost), PA/EL (Cassandra or DynamoDB with eventual consistency, favouring latency), or PC/EL (Postgres with async replicas: consistent on the primary, but reads from replicas trade consistency for latency). Framing a design discussion in PACELC terms immediately makes it concrete: "we are choosing EL here because a 120 ms cross-region write on every add-to-cart would cost more conversions than a rare stale read".

- **Why it matters** — It moves the conversation from a rare failure case to the everyday design decision.

- **Follow-ups** — Where in your system do you pay latency for consistency? Classify your primary datastore. What would you change to move from EC to EL and what would break?

- **Senior signal** — Emphasises the "else" branch and attaches millisecond numbers to the trade-off.

### Q131. What is partial failure and why does it change how you write code?

- **Expected answer** — In a single process, a call either returns or throws. Across a network, there is a third outcome: you do not know. A timeout does not mean the other side did not do the work; it means you did not hear back. The request may have been lost on the way, processed and the reply lost, or still be executing. That single fact drives most distributed design: you cannot treat a timeout as a failure and retry blindly, or you double-charge. So every remote call needs four things: a timeout (never infinite), a decision about whether it is safe to retry, an idempotency mechanism if it is, and a way to reconcile later if you still do not know. Partial failure also means a multi-step operation can stop halfway — the order is created, the payment is captured, and then the inventory service is down. You cannot roll back a captured payment with a database rollback, so you need compensation, an outbox, or a saga. The practical habit: for every remote call in a design review, ask the mantra — can it timeout, can it duplicate, can it partially succeed — and make sure the code has an answer.

- **Why it matters** — It is the root cause of the majority of distributed-system bugs.

- **Follow-ups** — Your payment call times out. What exactly do you do next? How do you reconcile "unknown" states? Why is a retry without an idempotency key dangerous?

- **Senior signal** — Names the unknown-outcome case explicitly and has a reconciliation plan, not just a retry.

### Q132. Define idempotency and give three ways to achieve it.

- **Expected answer** — An operation is idempotent if performing it more than once has the same effect as performing it once. Note it is about *effect*, not about the response being byte-identical. Three mechanisms. (1) **Natural idempotency**: design the operation as an absolute assignment rather than a delta — `SET status = 'shipped'` is idempotent, `increment shipped_count` is not. (2) **A uniqueness constraint on a deduplication key**: derive a deterministic key from the request or event (`payment_intent_id`, `event_id`) and let a unique index reject the second attempt; combined with `ON CONFLICT DO NOTHING` this is a single atomic statement. (3) **A guarded state transition**: `UPDATE orders SET status='paid' WHERE id=$1 AND status='pending' RETURNING id` — zero rows means someone already did it, and you return the same success response rather than an error, because from the client's perspective the intent was fulfilled. The subtleties seniors mention: the dedupe record must commit in the same transaction as the effect; idempotency keys need a scope and an expiry; and idempotency is not the same as *ordering* — two different operations arriving out of order are still a problem your design must handle separately.

- **Why it matters** — It is the single most reusable technique in distributed backends.

- **Follow-ups** — What is the response to a duplicate, and does it matter? How long do you keep keys? How do you make an email send idempotent when the provider has no key support?

- **Senior signal** — Separates idempotency from ordering, and insists on same-transaction commit of the dedupe record.

### Q133. What does "at-least-once delivery" actually require of you?

- **Expected answer** — It means the broker guarantees a message is delivered one or more times: if a consumer crashes after processing but before acknowledging, the message is redelivered. So the burden shifts to the consumer, which must be idempotent — otherwise a redelivery duplicates a charge, an email or a stock decrement. Practically, an at-least-once consumer must: derive a stable dedupe key from the message (a producer-supplied `event_id`, never a hash of the arrival time), record it transactionally with the side effect, ack only after the effect is durable, and tolerate out-of-order delivery because a redelivery of message 5 can arrive after message 7. The related modes: at-most-once (ack first, then process — you lose messages on crash, acceptable only for metrics-like data), and "exactly once" which, across a network, is always at-least-once plus deduplication somewhere. Also design for the poison message: after N delivery attempts, route to a dead-letter queue with the error and the original payload, alert on DLQ depth, and provide a replay tool — a consumer that retries a permanently-failing message forever will block a partition or spin forever.

- **Why it matters** — It is the delivery mode you will actually be given, and the consumer's obligations are frequently ignored.

- **Follow-ups** — Where do you store the dedupe key and for how long? What do you do with a message you cannot process? How do you handle a redelivery that arrives 3 days later?

- **Senior signal** — Ack-after-durable-effect, dead-letter with alerting and replay, and awareness that dedupe keys need retention limits.

### Q134. Explain the transactional outbox pattern.

- **Expected answer** — The problem is the dual write: you need to update your database *and* publish an event, and there is no transaction spanning both. If you publish first and the commit fails, you emitted an event for something that did not happen; if you commit first and the publish fails, the rest of the system never learns. The outbox fixes it by making the publish part of the same database transaction: insert the event row into an `outbox` table alongside the business write, commit once. A separate relay then reads unpublished rows and pushes them to the broker, marking them sent — either by polling with `FOR UPDATE SKIP LOCKED`, or by change-data-capture reading the WAL (Debezium), which avoids polling load entirely.

  ```sql
  CREATE TABLE outbox (
    id bigserial PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL,
    payload jsonb NOT NULL, created_at timestamptz DEFAULT now(), published_at timestamptz);
  CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
  ```

  Consequences to state: delivery becomes at-least-once (the relay can publish then crash before marking), so consumers must dedupe; there is publish latency of the polling interval; the table needs an archival job or it grows forever; and ordering is only guaranteed if you publish in id order per aggregate.

- **Why it matters** — The dual-write problem is everywhere and the outbox is the standard answer.

- **Follow-ups** — Why is the partial index important? Polling or CDC, and what does each cost? How do you guarantee per-aggregate ordering?

- **Senior signal** — Volunteers that the outbox produces at-least-once (not exactly-once) and that the table needs retention.

### Q135. What is the inbox pattern?

- **Expected answer** — The mirror image on the consumer side. When a consumer receives a message, it first inserts the message id into an `inbox` (processed-messages) table with a unique constraint, in the *same transaction* as the business effect. If the insert conflicts, the message was already processed and the consumer acks and moves on. This converts at-least-once delivery into effectively-once processing, with the database providing the atomicity that the broker cannot. It matters most when the side effect is a database write, because then everything is in one transaction and there is no window where the effect is durable but the dedupe record is not. When the side effect is external (charging a card, sending an email), you cannot get that atomicity, so you split it: record intent transactionally, perform the external call with its own idempotency key, then record completion — and accept that a crash in the middle leaves an "unknown" record that a reconciliation job resolves. Operationally the inbox table needs a retention policy tied to the broker's maximum redelivery window (keep ids for, say, 7 days), and an index on the id plus a cleanup job.

- **Why it matters** — It is the concrete implementation of "make your consumers idempotent", which everyone recommends and few specify.

- **Follow-ups** — What is the retention window and how do you choose it? What if the side effect is not a database write? How does this interact with Kafka offset commits?

- **Senior signal** — Handles the external-side-effect case honestly rather than pretending the inbox solves it.

### Q136. Saga versus two-phase commit.

- **Expected answer** — **2PC** gives atomicity across resources via a coordinator: prepare, then commit or abort. It gives strong guarantees but holds locks across the whole protocol, blocks if the coordinator dies after prepare (participants sit locked, unable to decide), and requires every participant to support it — which most modern services and brokers do not. It is essentially unusable for cross-service HTTP APIs and is why almost nobody runs it outside a single database or a legacy XA environment. A **saga** replaces atomicity with a sequence of local transactions, each with a compensating action: reserve inventory, charge payment, create shipment — and if step three fails, run refund and release-inventory. Two flavours: **orchestration**, where a central coordinator (a state machine you own) drives each step and knows the whole flow — easier to reason about, monitor and debug, and my usual choice; and **choreography**, where each service reacts to events with no central brain — less coupling, but the flow exists only in the heads of the people who wrote it, and debugging is painful past three steps. What you give up with sagas: intermediate states are *visible*, so the system is not isolated; a user can see an order that is paid but not yet shipped, and your UI and business rules must accept that.

- **Why it matters** — This is the core "distributed transaction" question and the honest answer is about trade-offs, not technology.

- **Follow-ups** — What if the compensation itself fails? How do you make a saga observable? Where do you store saga state?

- **Senior signal** — Names the coordinator-blocking failure of 2PC, prefers orchestration for debuggability, and states the loss of isolation as a product-visible consequence.

