## 65.5 Closing: what these four designs teach

The four systems in this Part each stress a different core skill, and together they round out the distributed-systems toolkit that Part 40 began. The web crawler is about taming an unbounded, adversarial space with politeness, deduplication and a prioritized frontier — the discipline of being a good citizen while covering enormous ground. The distributed key-value store is the heart of distributed systems: partitioning by consistent hashing, replication, and the quorum knob that makes the CAP tradeoff tunable per operation — the design behind every NoSQL store in Part 62. The unique ID generator shows that even a tiny component is a distributed-systems problem, with real tradeoffs between coordination, sortability, size and clock dependence, and a pragmatic modern default in UUIDv7. The ticket booking system is the sharpest concurrency problem in the book: an absolute no-double-sell invariant under a concentrated thundering herd, solved with atomic conditional updates and a waiting room rather than by trading away correctness.

Read across them, the recurring senior lessons are clear. Contention and coordination, not raw throughput, are usually the hard part — the booking system's spike on a few seats and the KV store's quorum coordination are the real challenges, not the gross request count. The CAP tradeoff is a per-system choice: the KV store makes it tunable and often favors availability, while the booking system refuses to trade consistency on a seat because double-selling is unacceptable, and naming which invariant cannot be relaxed is the key design decision. The database's atomic operations and constraints are your best concurrency control, as the conditional seat update shows. And the "when not to build" alternative is always present: use a proven distributed KV store rather than writing your own, default to UUIDv7 rather than a bespoke Snowflake, crawl one site with a single simple process rather than a distributed fleet — build the complex version only when a specific requirement genuinely demands it.

## Senior Checklist — Part 65

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
- [ ] I can design a web crawler with politeness, deduplication (Bloom filter + store) and a prioritized, durable frontier
- [ ] I can explain consistent hashing, replication, and how R/W quorums make consistency tunable (R + W > N)
- [ ] I can reason about conflict resolution (vector clocks vs last-write-wins) and partition behavior in a distributed KV store
- [ ] I can compare Snowflake, UUIDv4, UUIDv7 and database sequences and handle clock skew
- [ ] I can guarantee no double-sell with an atomic conditional update and handle hold expiry and payment coupling
- [ ] I can use a waiting room/queue to tame a thundering herd without trading away correctness
- [ ] For each system I can name the alternative that avoids building it and when to prefer it

## Part 65 — Key Takeaways

- A web crawler is a politeness and deduplication problem as much as a throughput one: obey robots.txt and per-domain rate limits absolutely, dedup with a Bloom filter backed by an exact store, and keep a durable, prioritized, domain-partitioned frontier.
- Consistent hashing places keys on a ring so adding or removing a node moves only about 1/N of the data; virtual nodes keep load even — this is what makes a distributed store elastic.
- Replication plus quorum (R/W) makes consistency tunable per operation: R + W > N guarantees a read sees the latest write (strong), lower values trade consistency for availability and latency — the CAP tradeoff made operational.
- High availability under partitions means accepting conflicting writes and reconciling them (vector clocks, read repair, anti-entropy, hinted handoff); last-write-wins is simple but can silently lose writes under clock skew.
- A correct distributed KV store is extremely hard; use a proven one (DynamoDB, Cassandra) or even just PostgreSQL plus caching unless a specific requirement forces you to build one.
- A unique ID generator is a distributed-systems problem: Snowflake gives compact, sortable, coordination-free ids but depends on the clock and machine-id assignment; UUIDv7 is the pragmatic modern default — sortable, zero coordination, at 128 bits.
- Sortable ids (Snowflake, UUIDv7) give far better database index locality than random UUIDv4; handle clock backward-jumps in any time-based generator, and avoid raw sequences for public ids (they are enumerable).
- The ticket-booking no-double-sell invariant is guaranteed by an atomic conditional update (`WHERE status = 'available'`), where exactly one racing transaction claims the seat and the rest get a correct 409 — the database's atomic row update is the concurrency control.
- A waiting room/virtual queue tames the on-sale thundering herd by admitting users at a controlled rate, protecting both correctness and cost without permanently provisioning for the peak.
- Across all four: contention and coordination are the hard part, not raw throughput; name the invariant that cannot be relaxed (a seat sold once) to decide where strong consistency is mandatory; and always consider the alternative that avoids building the complex system at all.
