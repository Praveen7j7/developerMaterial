### Q137. How do you design compensating actions?

- **Expected answer** — A compensation semantically undoes a completed step; it is not a rollback, because the effect was already visible. Rules I apply. It must be **idempotent**, since it will be retried. It must be **commutative-safe**: compensations may run in an order you did not expect, so each should be independently correct. It must handle the case where the forward step's outcome is *unknown* — so before compensating, query the downstream for the actual state rather than assuming. Some actions cannot be compensated (an email is sent, an SMS delivered, a physical package dispatched), so the design must order steps to put irreversible actions **last**, after everything reversible has succeeded — that ordering rule is the single most valuable piece of saga design. Where compensation is impossible, use a reservation instead: hold inventory for 15 minutes rather than decrementing, so expiry is the "compensation". Finally, compensations fail too, so you need a terminal state: after N attempts, park the saga in `needs_manual_intervention`, alert, and give operations a tool — because a saga silently stuck halfway is worse than a loud failure.

- **Why it matters** — Compensation design is where saga theory meets messy reality.

- **Follow-ups** — Order these steps for a booking flow and justify the order. What is your retry and give-up policy? How does a human resolve a stuck saga?

- **Senior signal** — Irreversible actions last, reservations instead of compensations where possible, and an explicit manual-intervention terminal state.

### Q138. Explain leader election and fencing tokens.

- **Expected answer** — Leader election picks one node to perform a role (run a scheduler, own a shard, coordinate writes), typically via a consensus system (etcd, ZooKeeper, Consul) or a lease in Redis/Postgres. The critical insight is that **a lease does not guarantee mutual exclusion**: a leader can be alive but stopped — a 45-second GC pause, a hung disk, a network blip — and its lease expires, a new leader is elected, and then the old leader wakes up and writes, believing it is still the leader. Timeouts alone cannot prevent this, because you cannot distinguish a slow node from a dead one. **Fencing tokens** fix it: every time a lease is granted, the coordinator issues a monotonically increasing token, the leader includes that token in every write to the protected resource, and the resource *rejects any write with a token lower than the highest it has seen*. The zombie leader's stale token is refused. In practice that means the storage layer must participate — for example a `lease_epoch` column with `UPDATE ... WHERE lease_epoch <= $token`, or a conditional write in the object store. If the resource cannot check tokens, you do not have safe mutual exclusion, and you should make the work idempotent instead so a double execution is harmless.

- **Why it matters** — The zombie-leader scenario is the classic reason "we have a lock" is not the same as "it is safe".

- **Follow-ups** — Why can you not solve this with a shorter lease? Where would the token be checked in a Postgres-backed system? What if the resource is a third-party API?

- **Senior signal** — Explains that the resource must enforce the token, and falls back to idempotency when it cannot.

### Q139. What is a quorum and why is `R + W > N` the rule?

- **Expected answer** — With `N` replicas, if a write is acknowledged by `W` of them and a read consults `R` of them, then `R + W > N` guarantees the read set and write set overlap by at least one node, so the read sees the latest acknowledged write (given a way to pick the newest version, such as a version number or timestamp). Common configurations: `N=3, W=2, R=2` gives strong-ish reads with tolerance for one node down; `W=1, R=1` is fast and eventually consistent; `W=N` makes writes fail whenever any replica is down. The trade-offs are latency (you wait for the slowest of `W`) and availability (higher `W` means fewer failures tolerated for writes). The honest caveats a senior adds: quorum reads are not linearizable on their own — concurrent writes, read repair timing and sloppy quorums with hinted handoff can still surface stale or conflicting values — and quorum systems need conflict resolution (last-write-wins loses data under clock skew; vector clocks or CRDTs preserve it at the cost of complexity). This is why Dynamo-style systems say "eventually consistent" even at `R + W > N`.

- **Why it matters** — It is the vocabulary of every replicated datastore configuration screen.

- **Follow-ups** — Why is `R + W > N` not the same as linearizable? What is a sloppy quorum? How would you choose R and W for a shopping cart?

- **Senior signal** — Knows the overlap argument *and* its limits, and mentions conflict resolution.

### Q140. Explain Raft in plain language.

- **Expected answer** — Raft keeps a replicated log identical across a cluster. Nodes are in one of three states: follower, candidate, leader. Time is divided into **terms**; each term has at most one leader. A follower that hears nothing from a leader before its randomised election timeout becomes a candidate, increments the term, and requests votes; a node votes for at most one candidate per term and only for a candidate whose log is at least as up to date as its own, so a majority vote elects a leader that cannot be missing committed entries. The leader accepts all client writes, appends them to its log, replicates them, and once a **majority** has stored an entry it is *committed* and applied to the state machine; followers learn the commit index from subsequent heartbeats. Consistency comes from the log-matching property: an `AppendEntries` includes the previous index and term, and a follower rejects it if that does not match, forcing the leader to walk back and overwrite divergent entries. Randomised timeouts prevent split votes. Practical implications: you need an odd number of nodes (3 or 5) because it needs a majority; the cluster is unavailable for writes without a majority; and every write costs a round trip to a majority, which is why cross-region Raft is slow.

- **Why it matters** — Raft underlies etcd, Consul and much of Kubernetes, and "explain it simply" tests real understanding.

- **Follow-ups** — Why 3 or 5 nodes and not 4? What happens during a network partition of 2 versus 3? How does this affect etcd latency in a multi-AZ cluster?

- **Senior signal** — Explains the majority and up-to-date-log voting restriction as the safety mechanism, and connects it to operational sizing.

### Q141. Why can you not trust clocks, and what do you use instead?

- **Expected answer** — Wall clocks (`Date.now()`) are synchronised by NTP, so they jump forward, step backward, drift between machines by milliseconds to seconds, and are subject to leap-second handling differences. Two servers' timestamps are not comparable at fine granularity, so "last write wins" by wall clock silently loses data when clocks disagree, and a token that expires "in 60 seconds" may expire immediately on a skewed machine. For measuring *durations* always use a monotonic clock (`process.hrtime.bigint()` or `performance.now()`), which never goes backwards — using `Date.now()` for latency measurement produces negative durations during an NTP step. For *ordering* across machines, use logical clocks: a per-entity sequence number, a Lamport clock (a counter carried on messages, giving a consistent total order but not causality), or vector clocks (which capture causality and detect concurrent updates, at the cost of size). Where physical time is unavoidable, bound the uncertainty explicitly — that is what Spanner's TrueTime does, waiting out the uncertainty interval. Practically: never use client-supplied timestamps for ordering, always store `timestamptz` in UTC, and monitor clock skew across your fleet because it is a real alert.

- **Why it matters** — Clock assumptions cause data loss that is nearly impossible to reproduce.

- **Follow-ups** — Where does your system currently rely on wall-clock comparison? How would you detect skew? What replaces LWW for a shopping cart merge?

- **Senior signal** — The monotonic-versus-wall-clock distinction for durations, plus treating skew as something to monitor.

### Q142. Eventual versus strong consistency — how do you decide per feature?

- **Expected answer** — Ask what a user or the business loses if a read is stale. Strong consistency is required where a stale read causes an incorrect *decision*: account balance before a transfer, inventory before committing an order, permission checks, anything a regulator will read. Eventual is fine where staleness is cosmetic or self-correcting: view counts, feeds, search indexes, recommendation lists, analytics dashboards, "3 people are typing". The costs are asymmetric: strong consistency means coordination — a leader, a quorum round trip, or a lock — which costs latency and availability during partitions; eventual consistency means your UI and your business logic must be written to tolerate staleness, which is real design work, not free. The senior move is to make the choice *per operation* within one product, and to make staleness explicit — a stated staleness budget ("search reflects a price change within 30 seconds") is a requirement you can test and alert on, whereas "it is eventually consistent" is a shrug. Also watch for the trap where an eventually-consistent read feeds a strongly-consistent write: reading stock from a cache and then decrementing is exactly how you oversell.

- **Why it matters** — Consistency choices are product decisions with engineering costs; treating them as a purely technical toggle is a mid-level tell.

- **Follow-ups** — Pick three features in a product you know and classify them. What is your staleness budget for search, and how would you alert on it? Where does a stale read become a wrong write?

- **Senior signal** — Staleness budgets as testable requirements, and spotting the stale-read-then-write hazard.

### Q143. How do you provide read-your-writes consistency?

- **Expected answer** — The problem: a user updates their profile, is redirected, the read hits a replica or a cache that has not caught up, and they see the old value and think it failed. Options, cheapest first. (1) Return the updated resource in the write response and have the client use it — free, and solves the common case. (2) Sticky routing for a window: after a write, pin that user's reads to the primary (or the same replica) for N seconds, typically via a short-lived cookie or a per-user flag in Redis. (3) LSN/token-based waiting: capture the write position (`pg_current_wal_lsn()`) and pass it with the read; the read path either routes to the primary or waits until the replica's replay position is past it — precise but requires plumbing through the whole read path. (4) Write-through the cache so the cache is updated in the same operation, rather than invalidating and hoping. In practice I use (1) plus (2): return the resource, and pin session reads to the primary for 5 seconds after a write on that user's data. State the failure mode of sticky routing: it concentrates load on the primary during write-heavy periods, and it does not help a *different* device belonging to the same user.

- **Why it matters** — It is the most common user-visible symptom of read replicas and caching.

- **Follow-ups** — What is the cost of routing all post-write reads to the primary? How would you implement the LSN approach in NestJS? Does this help a second user reading the same data?

- **Senior signal** — Knows the LSN technique exists but chooses the cheap options and states their limits.

### Q144. Design a retry policy.

- **Expected answer** — Retries need five decisions. **What is retryable**: timeouts, connection errors, 429, 502/503/504 — never 400/401/403/404/409/422, because retrying a client error just wastes capacity. **Is it safe**: only retry non-idempotent operations if you have an idempotency key; otherwise a timeout retry duplicates. **How long to wait**: exponential backoff with full jitter (`sleep = random(0, base * 2^attempt)`), because synchronised backoff produces a retry storm where every client retries at exactly the same moment and hammers a recovering service. **How many times**: a small cap (3–5) plus an overall deadline — a total budget of, say, 10 seconds matters more than the attempt count, and the deadline must be propagated so nested retries do not multiply (3 retries at three layers is 27 requests). **What to do when you give up**: fail fast to the caller, or move the work to a queue for asynchronous retry with a much longer horizon. Two more things a senior adds: a **retry budget** (cap retries at, say, 10% of total requests, and stop retrying when the budget is exhausted, which prevents retries from turning a partial outage into a total one), and never retry inside a request the user is waiting on when the deadline is already blown.

- **Why it matters** — Naive retries are how a slow dependency becomes a full outage.

- **Follow-ups** — Why full jitter rather than plain exponential? How do you propagate a deadline through three services? What is a retry storm and how would you see it in metrics?

- **Senior signal** — Full jitter, deadline propagation, and a retry budget — the three things that separate designed retries from a `for` loop.

### Q145. How does a circuit breaker work, and what do you set it to?

- **Expected answer** — A circuit breaker wraps calls to a dependency and tracks failures. **Closed**: calls pass through, failures are counted. When the failure rate crosses a threshold within a window, it trips to **open**: calls fail immediately without touching the dependency, which stops you from piling threads, connections and latency onto something already broken and gives it room to recover. After a cool-down it moves to **half-open**, allowing a limited number of trial calls; success closes it, failure reopens it with a longer cool-down. Configuration that actually works: use a failure *rate* over a rolling window with a minimum request volume (never trip on 2 of 2 requests), something like 50% failures over 20+ requests in 10 seconds, an open period of 5–30 seconds, and count timeouts as failures — a slow dependency is more dangerous than a failing one. Pair it with a bulkhead (a bounded concurrency limit per dependency) so one slow dependency cannot consume the whole event loop or connection pool. And define the fallback: what does the caller do when the circuit is open — serve stale cache, degrade the feature, queue the work, or return 503? A breaker with no fallback plan just converts one error into another.

- **Why it matters** — Cascading failure is the dominant outage pattern in service architectures.

- **Follow-ups** — Why is a minimum request volume necessary? What is the interaction between breakers and retries? What does your endpoint return when the circuit is open?

- **Senior signal** — Rate-based thresholds with a volume floor, bulkheads alongside breakers, and an explicit degraded-mode answer.

### Q146. Is exactly-once delivery possible?

- **Expected answer** — Exactly-once *delivery* over a network is impossible in general, and the proof is simple: the sender cannot distinguish "the message was lost" from "the acknowledgement was lost", so it must either resend (risking duplicates) or not (risking loss). What is achievable is exactly-once *processing semantics* — at-least-once delivery combined with deduplication or idempotent effects at the consumer, so the observable outcome happens once. Kafka's "exactly-once" is precisely this: an idempotent producer (sequence numbers per partition dedupe broker-side retries) plus transactions that atomically commit both the produced messages and the consumer offsets, which gives exactly-once within the Kafka boundary. The moment your consumer writes to Postgres or calls Stripe, that guarantee stops at the edge, and you are back to needing an inbox table or a provider idempotency key. So the senior answer is: "no, and anyone selling it is describing a scope. Tell me where the boundary is, and I will tell you where you still need dedupe." Then name the concrete mechanisms: dedupe keys with unique constraints, guarded state transitions, and reconciliation for the unknown cases.

- **Why it matters** — It is a myth that leads teams to skip idempotency because the broker "handles it".

- **Follow-ups** — What exactly does Kafka's transactional producer guarantee, and where does it end? Where in your system does at-least-once become effectively-once? What is the cost of Kafka transactions?

- **Senior signal** — Distinguishes delivery from processing semantics, and can point at the exact boundary where a vendor's guarantee stops.
## 59.11 Messaging

### Q147. Kafka or RabbitMQ — how do you choose?

- **Expected answer** — They are different tools. Kafka is a distributed, partitioned, replicated **log**: messages are appended, retained for a configured time or size, and consumers track their own offset, so you can replay history and add a new consumer group that reads from the beginning. It excels at high-throughput event streams, event sourcing, and fan-out to many independent consumers. RabbitMQ is a **broker with queues and routing**: messages are pushed to consumers, acknowledged individually, removed when acked, and routed by exchange type with priorities, TTLs, per-message dead-lettering and delayed delivery. It excels at task queues with complex routing and per-message retry semantics. Practical selectors: do you need replay and multiple independent consumer groups (Kafka), or per-message ack, priorities and delayed retries (Rabbit)? Is ordering per key important (Kafka partitions give it; Rabbit does not across consumers)? What throughput — Kafka comfortably does hundreds of thousands of messages per second per cluster, Rabbit is typically tens of thousands per queue. And the honest option: for many teams, Postgres with `FOR UPDATE SKIP LOCKED` or SQS is the right answer, because a Kafka cluster is a system you must operate.

- **Why it matters** — Broker choice is often made by fashion, and running Kafka badly is expensive.

- **Follow-ups** — How do you do a delayed retry in Kafka? How do you replay in Rabbit? At what volume would you stop using Postgres as a queue?

- **Senior signal** — Frames it as log versus queue, and offers "you may not need either" as a real option.

### Q148. How do Kafka partitions relate to ordering and parallelism?

- **Expected answer** — A topic is split into partitions; each partition is an ordered, append-only log. Kafka guarantees ordering **within a partition only**, never across the topic. The partition is chosen by the key's hash (or round-robin when the key is null), so all messages with the same key land in the same partition and are therefore ordered relative to each other. That gives you the standard design rule: key by the entity whose ordering matters — `order_id`, `user_id`, `conversation_id`. Parallelism is bounded by partition count: within a consumer group, each partition is consumed by exactly one consumer, so 12 partitions means at most 12 useful consumers; extra consumers idle. So partition count is a capacity decision made early, since increasing it later re-hashes keys and breaks the ordering guarantee for existing keys in flight. Two more traps: ordering is only preserved on producer retries if `enable.idempotence=true` (otherwise a retried batch can land after a later one), and a hot key concentrates load on one partition regardless of how many you have.

- **Why it matters** — Ordering assumptions that are not backed by keying are a classic silent data bug.

- **Follow-ups** — What happens to ordering when you increase partitions from 6 to 12? How do you parallelise beyond partition count? Why does `max.in.flight.requests` matter for ordering?

- **Senior signal** — Connects keying to ordering, partition count to maximum parallelism, and knows the idempotent-producer requirement.

### Q149. Explain consumer groups and rebalancing.

- **Expected answer** — Consumers with the same `group.id` share the partitions of a topic; the group coordinator assigns partitions and each is owned by one member. A **rebalance** happens when a member joins, leaves, or is considered dead (no heartbeat within `session.timeout.ms`, or it failed to call poll within `max.poll.interval.ms`). During a classic eager rebalance, *all* consumers stop consuming while assignments are recomputed — a stop-the-world pause, which on a big group can be seconds and shows up as a latency and lag spike on every deploy. Fixes: use cooperative-sticky assignment so only the moving partitions pause; keep `max.poll.records` small enough that processing a batch fits comfortably inside `max.poll.interval.ms`, because slow processing causing a rebalance is the most common cause of an endless rebalance loop; and use static group membership (`group.instance.id`) so a rolling restart does not trigger a full reassignment. Also remember that after a rebalance you may be handed a partition whose in-flight work you already started, which is another reason handlers must be idempotent.

- **Why it matters** — Rebalance storms are a top Kafka operational problem and are usually caused by application-side slowness.

- **Follow-ups** — Your consumer takes 8 minutes to process a batch; what happens and how do you fix it? What does cooperative-sticky change? How do you deploy consumers without a rebalance?

- **Senior signal** — Diagnoses rebalance loops as a `max.poll.interval.ms` problem and knows static membership.

### Q150. How do you monitor and respond to consumer lag?

- **Expected answer** — Lag is the difference between the partition's latest offset and the consumer group's committed offset — how many messages behind you are. Measure it **per partition**, not just as a topic total, because one lagging partition (a hot key, a stuck consumer, a poison message) is invisible in the sum. Also track lag in *time* (age of the oldest unprocessed message), which is what the business cares about; "500,000 messages behind" means nothing without throughput, while "we are 14 minutes behind" is actionable. Alert on sustained growth rather than an absolute number, because a spike that drains is normal. When lag grows, the diagnosis tree is: is the producer rate up (check input rate), is the consumer slower (check per-message processing time and downstream latency), is one partition stuck (per-partition view), is the group rebalancing repeatedly (rebalance rate metric), or has the consumer crashed. Remedies: scale consumers up to the partition count, increase partitions (accepting the ordering caveat), make processing cheaper by batching database writes, or shed load by routing to a lower-priority topic. And have a documented answer for "we are 6 hours behind and retention is 24 hours", because that is a data-loss deadline.

- **Why it matters** — Lag is the primary SLI for any event-driven system.

- **Follow-ups** — Why is time-lag better than count-lag? What do you do when lag exceeds retention? How do you tell producer surge from consumer slowdown?

- **Senior signal** — Per-partition and time-based lag, plus the retention deadline as an incident trigger.

### Q151. How do you handle poison messages and dead letters?

- **Expected answer** — A poison message fails every time — malformed payload, a referenced entity that no longer exists, a bug. Without a plan, it either blocks the partition (Kafka, if you refuse to advance the offset) or loops forever (Rabbit redelivery), and in both cases it stops all progress behind it. The pattern: attempt processing with bounded retries and backoff; classify failures into *transient* (downstream timeout — retry) and *permanent* (validation failure, unknown event type — do not retry); on exhaustion, publish the message plus the error, stack, attempt count and original headers to a dead-letter topic or queue, then commit the offset/ack so the stream moves on. Then treat the DLQ as a first-class operational surface: alert on any non-zero depth, keep the original message intact so it can be replayed, build a replay tool that can filter and re-publish, and review the DLQ regularly — an unwatched DLQ is a silent data-loss bucket. For delayed retries in Kafka (which has no per-message delay), use tiered retry topics with increasing delays, consumed by a consumer that sleeps or checks timestamps.

- **Why it matters** — This is the difference between a pipeline that degrades gracefully and one that stops.

- **Follow-ups** — How do you implement a 5-minute delayed retry in Kafka? What information must the DLQ record carry? Who is on the hook for reviewing it?

- **Senior signal** — Classifies transient versus permanent failures, and treats the DLQ as monitored and replayable rather than a graveyard.

### Q152. When do you commit offsets, and what are the consequences?

- **Expected answer** — Committing **before** processing gives at-most-once: a crash loses the message. Committing **after** processing gives at-least-once: a crash between the effect and the commit redelivers, so handlers must be idempotent. Auto-commit (`enable.auto.commit=true`) commits on a timer regardless of whether processing finished, which quietly gives you *both* failure modes — messages can be lost if the timer fires before processing completes, and reprocessed if it does not. So for anything that matters, disable auto-commit and commit explicitly after the work is durable, in batches for throughput (commit once per poll batch rather than per message, because commits are network round trips). The stronger pattern when writing to your own database: store the offset in the same transaction as the effect, or use an inbox table keyed by `(topic, partition, offset)` — then the commit is just an optimisation and correctness does not depend on it. State the consequence clearly: at-least-once plus idempotent handlers is the standard, achievable design; anything else is a special case.

- **Why it matters** — Offset strategy is where "we lose messages sometimes" bugs live.

- **Follow-ups** — What exactly can go wrong with auto-commit? How do you commit per batch safely? What does the inbox table buy you here?

- **Senior signal** — Calls out auto-commit as giving the worst of both, and moves correctness into the database rather than the offset.

