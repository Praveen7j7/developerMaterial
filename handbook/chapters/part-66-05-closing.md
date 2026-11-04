## 66.5 Closing: what these four designs teach

The four systems in this Part each solve a distinct hard problem and reinforce patterns from across the book. The leaderboard shows that the right data structure — a Redis sorted set — turns an apparently expensive problem (ranking millions of users in real time) into fast, simple operations, and that when exact is too costly (top-K over a billion-event stream) a probabilistic structure (count-min sketch) trades a little accuracy for enormous savings. Collaborative editing is a correctness problem above all: concurrent edits must converge on every client, which operational transform and CRDTs achieve by two different rules, and which is hard enough that you use a proven library rather than building the merge engine yourself. Proximity search is about picking the right spatial index for the update/query profile — Redis geo for fast-moving drivers, PostGIS for query-rich static restaurants — and partitioning naturally by region because every query is local. Ad-click aggregation is about counting accurately at enormous scale: exactly-once counting on at-least-once delivery via unique event ids and idempotent aggregation, windowed by event time with late-event handling, and backed by reconciliation because the counts are billed.

Read across all three system-design Parts (40, 65, 66), the senior lessons compound. The right data structure or index often turns a hard problem easy — a sorted set for ranking, a geohash for proximity, a conditional update for no-double-sell. Accuracy versus cost is a recurring, deliberate trade: approximate top-K and sampled dashboards where approximation is fine, exact counting and reconciliation where the numbers are money. At-least-once delivery plus idempotent, deduplicating consumers is the standard reliable contract, appearing in the crawler, the metrics aggregator and the click stream. Reconciliation — comparing a derived result against the source of truth — is the backstop that catches silent errors wherever correctness matters. And every design carries a "when not to build" alternative: a PostgreSQL-only leaderboard for small scale, section-locking instead of CRDTs for most documents, PostGIS-only for modest location rates, database aggregation instead of a streaming pipeline for modest volumes. The simplest design that meets the requirement wins, and the method — clarify, estimate, model, design, deep-dive the hot spot, cover the cross-cutting concerns, state tradeoffs, offer alternatives — is what lets you produce the right design for any problem, not just recall these.

## Senior Checklist — Part 66

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
- [ ] I can build a real-time leaderboard with Redis sorted sets and know when to shard or approximate (count-min sketch)
- [ ] I can explain operational transform vs CRDTs and why collaborative edits must converge on all clients
- [ ] I can choose a geospatial index (geohash/Redis geo, PostGIS, quadtree) by update and query profile and partition by region
- [ ] I can achieve exactly-once counting on at-least-once delivery via unique event ids and idempotent aggregation
- [ ] I can window aggregates by event time with late-event handling and back them with reconciliation
- [ ] For each system I can name the simpler alternative and when to prefer it
- [ ] I can apply the full system-design method to a new problem, not just recall these designs

## Part 66 — Key Takeaways

- A Redis sorted set makes real-time ranking (update, rank, top-N, neighbors) fast and simple for millions of users; keep a durable copy in PostgreSQL for rebuild, and shard only at extreme scale.
- When exact top-K over a huge stream is too costly, a count-min sketch counts approximately in fixed memory — trade slight over-estimation for enormous savings where exactness is not required.
- Collaborative editing is a convergence problem: operational transform (transform ops against concurrent ops, needs coordination) and CRDTs (stable element identities, merge in any order, offline-friendly) both guarantee all clients converge; use a proven library rather than building the merge engine.
- Choose a geospatial index by profile: Redis geo (geohash) for frequently-moving entities (cheap updates), PostGIS for query-rich static entities joined to attributes, quadtree for adaptive nearest-neighbor; partition by region because proximity queries are always local.
- Exactly-once counting on at-least-once delivery is achieved by giving each event a unique id and counting it once (dedup) plus atomic aggregate-and-offset updates, not by chasing exactly-once delivery.
- Aggregate by event time with watermarks and allowed lateness so late events (offline devices) are counted, not silently dropped, and side-output the very late for reconciliation.
- Reconciliation — recomputing aggregates from raw events and comparing to the served counts — is the non-negotiable accuracy backstop whenever the numbers are billed or otherwise must be trusted.
- The right data structure or index often turns a hard problem easy (sorted set, geohash, conditional update); choosing it is the core of the design.
- Accuracy versus cost is a deliberate, recurring trade: approximate where it is acceptable (dashboards, non-billed top-K), exact with reconciliation where it is money (clicks, seats).
- Every design has a simpler alternative that avoids building the complex system — PostgreSQL-only leaderboards, section-locking over CRDTs, PostGIS-only proximity, database aggregation over streaming — and the method of clarify-estimate-model-design-deep-dive-tradeoffs-alternatives is what lets you choose correctly for any new problem.
