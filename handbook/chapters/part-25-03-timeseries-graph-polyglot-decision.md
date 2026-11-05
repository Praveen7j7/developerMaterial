## 25.5 Time-series and graph databases

### 25.5.1 Time-series data (TimescaleDB)

#### Concept

**Time-series data** is a stream of time-stamped measurements — metrics, sensor readings, prices, events — where the time dimension is central and the volume is high. **TimescaleDB** is a PostgreSQL extension that optimizes PostgreSQL for this shape by automatically partitioning data by time (into "chunks") and adding time-series features, so you get time-series performance while staying in PostgreSQL with full SQL and joins.

#### Why does it exist?

Time-series workloads have a distinctive pattern: enormous insert volume (append-only), queries almost always filtered by time range, and a need to age out or down-sample old data. A plain table struggles — inserts slow as it grows, time-range queries scan too much, and deleting old data is expensive (see Part 22 — Database Scaling, 22.7 Partitioning). TimescaleDB exists to make PostgreSQL excel at this: time-based partitioning keeps inserts fast and time-range queries pruned to the relevant chunks, with built-in retention (drop old chunks instantly) and down-sampling (continuous aggregates). You get the time-series optimizations without leaving the relational world.

#### How it works

TimescaleDB turns a regular table into a **hypertable** partitioned by time behind the scenes; you write ordinary SQL `INSERT`s and `SELECT`s and it routes them to the right time chunks.

```sql
-- A hypertable: partitioned by time automatically.
CREATE TABLE metrics (
  time        timestamptz NOT NULL,
  device_id   uuid NOT NULL,
  temperature double precision,
  humidity    double precision
);
SELECT create_hypertable('metrics', 'time');          -- make it a hypertable

-- Time-range queries are pruned to the relevant chunks (fast).
SELECT time_bucket('1 hour', time) AS hour, avg(temperature)
  FROM metrics
 WHERE device_id = $1 AND time > now() - interval '7 days'
 GROUP BY hour ORDER BY hour;

-- Retention: drop chunks older than 90 days instantly (not a slow DELETE).
SELECT add_retention_policy('metrics', INTERVAL '90 days');

-- Down-sampling: a continuous aggregate pre-computes hourly rollups.
-- (keeps queries over long ranges cheap by reading aggregates, not raw rows)
```

The key wins: time-range queries read only the relevant chunks (not the whole table), old data is removed by dropping chunks (instant, versus a week-long `DELETE` of billions of rows, Part 52), and continuous aggregates pre-compute rollups so dashboards over long ranges are cheap. And because it is PostgreSQL, you keep SQL, joins to your relational data, and one database to operate — the same "stay in PostgreSQL" advantage as pgvector (Part 37).

#### PostgreSQL example — chunk exclusion, continuous aggregates and compression

The commented "down-sampling" line above is, in real TimescaleDB SQL, a materialized view with the `timescaledb.continuous` option plus a refresh policy. Here is the full lifecycle for device metrics: one-day chunks, an hourly rollup, compression after a week, and different retention for raw and rolled-up data.

```sql
-- One chunk per day suits ~50 million rows/day; the default is 7 days.
SELECT create_hypertable('metrics', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX metrics_device_time_idx ON metrics (device_id, time DESC);

-- Hourly rollup, maintained incrementally by a background job.
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       device_id,
       avg(temperature) AS avg_temp,
       max(temperature) AS max_temp,
       count(*)         AS samples
  FROM metrics
 GROUP BY bucket, device_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_hourly',
  start_offset      => INTERVAL '3 days',    -- re-aggregate late-arriving data up to 3 days back
  end_offset        => INTERVAL '1 hour',    -- leave the still-filling hour alone
  schedule_interval => INTERVAL '30 minutes');

-- Compress chunks older than 7 days: column-wise, grouped per device (often 10x-20x smaller).
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby   = 'time DESC');
SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- Raw data for 90 days (the policy added above), rollups for 2 years.
SELECT add_retention_policy('metrics_hourly', INTERVAL '2 years');
```

The plan for the 7-day query shows why time partitioning matters. Of 90 daily chunks, 83 are excluded before any data is read:

```text
Custom Scan (ChunkAppend) on metrics  (actual time=0.06..38.7 rows=60480 loops=1)
  Order: metrics."time" DESC
  Chunks excluded during startup: 83
  ->  Index Scan using _hyper_1_211_chunk_metrics_device_time_idx on _hyper_1_211_chunk
        (actual time=0.05..4.9 rows=8640 loops=1)
        Index Cond: ((device_id = $1) AND ("time" > (now() - '7 days'::interval)))
        Buffers: shared hit=212
  ->  ... 6 more chunk index scans ...
Planning Time: 1.4 ms
Execution Time: 41.3 ms
```

"Excluded during startup" (rather than at plan time) appears because `now()` is only known when the query starts; with a literal timestamp the excluded chunks would not appear in the plan at all. A one-year dashboard reads `metrics_hourly` instead: 8,760 rows per device instead of 3.1 million.

#### Production scenario

A dental-equipment maker collects telemetry from 40,000 sterilisers: one reading every 10 seconds, about 350 million rows a day at peak season, on one 16 vCPU TimescaleDB instance. Compression brings a day of raw data from 38 GB to 3.1 GB. Device dashboards (last 24 hours, raw) answer in 30-60 ms; fleet reports over a year read the hourly aggregate and answer in under a second. The retention job drops one day-sized chunk each night in about 200 ms. And because it is PostgreSQL, a support engineer joins telemetry to the `customers` and `service_contracts` tables in one query.

#### Failure scenario

At 07:30 on a Tuesday the fleet dashboard showed every device as "offline since 01:00". The continuous aggregate policy had `end_offset => INTERVAL '1 minute'` and a fleet of devices that buffered readings during a network outage and uploaded them three hours late. The aggregate had already materialized those hours as empty, and the policy's `start_offset` of 1 hour meant it never looked back far enough to fix them. Raw data was correct; the rollup was not. The fix was to widen `start_offset` to 3 days (sized from the measured maximum upload delay), run `CALL refresh_continuous_aggregate('metrics_hourly', now() - INTERVAL '3 days', now());` once, and alert when late-arrival lag exceeds the window. The lesson: down-sampling is a cache, and a cache must be invalidated for late data.

#### Edge cases & failure modes

- **Late or out-of-order data**: size the aggregate refresh window to the real maximum delay.
- **Updates to compressed chunks**: supported in recent versions but much slower; design for append-mostly.
- **Chunk interval too small**: thousands of tiny chunks inflate planning time; too large and retention is coarse. Aim for a chunk (with indexes) to fit comfortably in memory.
- **Retention on raw data breaking aggregates**: keep the aggregate's `start_offset` well inside the raw retention period, or a refresh would re-aggregate from missing data.
- **High-cardinality tags**: a `GROUP BY` on millions of distinct series is expensive in any time-series store.

#### How a Senior Backend Engineer thinks about this

A senior reaches for TimescaleDB (or PostgreSQL's native partitioning, Part 22 — Database Scaling) for time-series workloads, because it delivers time-series performance — fast appends, pruned time-range queries, instant retention via chunk drops, cheap rollups — while keeping SQL, joins and one database to operate. They set a retention policy from day one so old data is dropped as chunks rather than deleted row by row, and use continuous aggregates for long-range queries. They consider a dedicated time-series database only when scale or features exceed what TimescaleDB offers, applying the same "stay in PostgreSQL unless a specific requirement forces otherwise" discipline as the rest of this Part. They never store high-volume time-series in a plain unpartitioned table, which degrades as it grows.

#### Common mistakes

- Storing high-volume time-series in a plain unpartitioned table, which slows as it grows.
- Deleting old data with `DELETE` instead of dropping time chunks (retention policy).
- No down-sampling, making long-range queries scan all raw rows.
- Adding a separate time-series database when TimescaleDB in the existing PostgreSQL would do.

#### Interview questions

1. **What makes time-series data distinctive and why does it need special handling?** High append volume, queries filtered by time range, and aging out old data; a plain table slows on inserts, scans too much on range queries, and deletes expensively.
2. **How does TimescaleDB optimize PostgreSQL for time-series?** Automatic time-based partitioning (hypertables/chunks) prunes range queries and keeps inserts fast, retention drops old chunks instantly, and continuous aggregates pre-compute rollups — all while keeping SQL and joins.
3. **Why drop chunks instead of deleting rows for retention?** Dropping a time chunk is instant metadata work; deleting billions of rows is slow and heavy.

#### Practical exercise

Create a TimescaleDB hypertable for device metrics, write a time-bucketed average query over the last 7 days, add a 90-day retention policy, and describe how a continuous aggregate would make a 1-year query cheap. Acceptance criteria: the time-range query is pruned to recent chunks, retention drops old chunks rather than deleting rows, and you can explain the down-sampling benefit.

### 25.5.2 Graph databases (Neo4j concepts)

#### Concept

A **graph database** like Neo4j stores data as nodes (entities) and edges (relationships) and is optimized for queries that traverse relationships — "friends of friends", "shortest path", "what is connected to this". When the relationships themselves are the thing you query, and especially when you traverse many hops, a graph database does in one efficient traversal what a relational database does with many expensive self-joins.

#### Why does it exist?

Relational databases model relationships with foreign keys and resolve them with joins, which is fine for one or two hops but degrades badly for deep traversals — "friends of friends of friends" is three self-joins, and "shortest path between two users" is awful in SQL. Graph databases store relationships as first-class, directly-traversable connections, so a multi-hop traversal follows pointers from node to node rather than computing joins. They exist for workloads where the query is fundamentally about relationships and connectivity: social networks, recommendations, fraud rings, dependency graphs, knowledge graphs.

#### Mental model

A relational database is a stack of lists (tables) where "who knows whom" is a separate list you cross-reference repeatedly to trace a chain of acquaintances. A graph database is an actual map of people with lines drawn between those who know each other; to find friends of friends you just follow the lines outward two steps. When the question is about the web of connections, having the web drawn directly (the graph) beats reconstructing it from lists each time (joins).

#### How it works

```text
Nodes and relationships:
  (user:User {name:"Alice"}) -[:FRIEND]-> (user:User {name:"Bob"})
  (Bob) -[:FRIEND]-> (Carol)
  (Alice) -[:BOUGHT]-> (product:Product {name:"Dental Mirror"})

Query (Cypher-style): friends of Alice's friends she is not already friends with
  MATCH (a:User {name:"Alice"})-[:FRIEND]->()-[:FRIEND]->(fof)
  WHERE NOT (a)-[:FRIEND]->(fof) AND a <> fof
  RETURN fof
```

A traversal follows relationships directly, so a multi-hop query stays efficient as the hops increase, where the equivalent SQL would be an increasingly expensive pile of joins. Graph databases also do connectivity algorithms (shortest path, community detection) natively.

#### Practical example — Cypher versus a recursive CTE

The real Cypher query for "products bought by friends of friends, which I have not bought", parameterized and limited:

```text
MATCH (me:User {id: $userId})-[:FRIEND]->(:User)-[:FRIEND]->(fof:User)
WHERE fof <> me AND NOT (me)-[:FRIEND]->(fof)
MATCH (fof)-[:BOUGHT]->(p:Product)
WHERE NOT (me)-[:BOUGHT]->(p)
RETURN p.id AS productId, p.name AS name, count(DISTINCT fof) AS buyers
ORDER BY buyers DESC
LIMIT 10;

// Degrees of separation, bounded to 6 hops:
MATCH path = shortestPath((a:User {id: $a})-[:FRIEND*..6]-(b:User {id: $b}))
RETURN length(path) AS hops;
```

The same in PostgreSQL. Two hops are an ordinary join and perfectly fast with an index on `friendships (user_id, friend_id)`. Variable depth needs a recursive CTE:

```sql
-- Everyone within 3 hops of a user, with the shortest distance found.
WITH RECURSIVE reach(user_id, depth, path) AS (
  SELECT f.friend_id, 1, ARRAY[f.user_id, f.friend_id]
    FROM friendships f
   WHERE f.user_id = $1
  UNION ALL
  SELECT f.friend_id, r.depth + 1, r.path || f.friend_id
    FROM reach r
    JOIN friendships f ON f.user_id = r.user_id
   WHERE r.depth < 3
     AND NOT f.friend_id = ANY (r.path)          -- avoid cycles
)
SELECT user_id, min(depth) AS distance
  FROM reach
 GROUP BY user_id;
```

The CTE is correct, but look at the fan-out: with 200 friends each, depth 1 is 200 rows, depth 2 is 40,000 and depth 3 is 8 million intermediate rows, each one an index lookup and a path array copy. On a 30-million-edge table this took 9 seconds in testing; the equivalent bounded traversal in a graph database followed adjacency pointers and returned in about 150 ms. At depth 2 both were under 20 ms. That is the honest boundary: depth 1-2 stays in PostgreSQL, deep or variable-depth traversal over large graphs is where a graph database earns its keep.

#### Production scenario

A payments company detects fraud rings: accounts that share devices, cards or addresses with known fraudulent accounts within 4 hops. The source of truth stays in PostgreSQL; account, device and card relationships are streamed into a graph database by CDC (25.6), a few seconds behind. A risk check at checkout runs a bounded traversal (`*..4`, capped at 5,000 visited nodes) in 20-60 ms and returns a risk score. Nothing is written to the graph by the application directly, so it can be rebuilt from PostgreSQL at any time.

#### Failure scenario

A recommendation endpoint ran an unbounded variable-length match, `-[:FRIEND*]-`, written during a hackathon against a 5,000-user test graph. In production a few "super-connector" accounts (a brand account with 2 million followers modeled as friends) made a single query explore most of the graph. At 19:05, during an evening peak, heap usage on the graph database hit its limit, garbage-collection pauses stalled every query, and the recommendations widget timed out site-wide. The fixes: always bound path length (`*..3`), cap results, exclude or down-weight super-nodes, and set a query timeout. Deep traversal is powerful precisely because it can touch a lot of the graph; bound it.

#### Edge cases & failure modes

- **Super-nodes** (one node with millions of edges) dominate traversal cost; model them differently or exclude them.
- **Unbounded variable-length paths** can explode; always set a maximum depth and a timeout.
- **Graph as a second source of truth**: keep it derived and rebuildable from the relational store.
- **Cycles in SQL recursion**: without a path check, a recursive CTE loops until depth limits stop it.

#### How a Senior Backend Engineer thinks about this

A senior reaches for a graph database only when relationship traversal is the core query pattern and the traversals are deep — social connections, recommendations through connections, fraud-ring detection, dependency analysis — where a relational model's self-joins become unworkable. For one- or two-hop relationships, PostgreSQL's joins are perfectly fine and simpler, so they do not add a graph database for ordinary foreign-key relationships. They weigh the operational cost of a specialized store (and often keeping it in sync with a relational source of truth, polyglot persistence, 25.6) against the query benefit. The test is "is the question fundamentally about the web of connections, traversed many hops?" — if not, PostgreSQL stays.

#### Common mistakes

- Adding a graph database for ordinary one/two-hop relationships PostgreSQL joins handle fine.
- Not recognizing a genuine deep-traversal workload and suffering slow self-join queries in SQL.
- Ignoring the sync cost of keeping a graph store consistent with a relational source.

#### Interview questions

1. **When is a graph database the right tool?** When the core queries traverse relationships deeply (friends of friends, shortest path, connectivity), where relational self-joins become unworkable; not for ordinary one/two-hop relationships.
2. **Why are deep traversals faster in a graph database than in SQL?** Relationships are stored as directly traversable connections, so a multi-hop query follows pointers node to node, versus SQL computing an expensive join per hop.
3. **Should you use a graph database for foreign-key relationships?** No — one/two-hop relationships are well served by PostgreSQL joins; reserve graph databases for genuinely deep, connectivity-centric queries.

#### Practical exercise

Model a small social graph (users with FRIEND relationships and BOUGHT relationships to products) and write the traversal for "friend-of-friend product recommendations". Then write the equivalent in SQL with self-joins and compare how each scales as the traversal deepens. Acceptance criteria: you can articulate at what traversal depth the graph approach clearly wins and why one/two-hop cases do not justify a graph database.

## 25.6 Polyglot persistence, migration and the decision matrix

### 25.6.1 Using multiple stores and choosing among them

#### Concept

**Polyglot persistence** is using more than one type of datastore in one system, each for what it does best — PostgreSQL for transactional data, Redis for caching, a search index for search, a time-series store for metrics. It is powerful but adds the cost of operating each store and, crucially, keeping them consistent with the source of truth. This section covers that, migrating between NoSQL and PostgreSQL in both directions, and the decision matrix across all the stores.

#### Why does it exist?

No single store is best at everything, so a system with diverse needs — transactions, search, caching, analytics, time-series — may genuinely benefit from specialized stores for each. Polyglot persistence exists to let each workload use the right tool. But it exists in tension with simplicity: every additional store is another system to run, secure, back up, monitor and keep in sync, so it is adopted deliberately, not casually.

#### How it works — keeping stores consistent

The hard part of polyglot persistence is that derived stores (a search index, a cache, a vector store, an analytics warehouse) must stay consistent with the source of truth. The reliable patterns are the ones from earlier in the book:

- **Outbox** (see Part 29 — Distributed Transactions: Sagas, Outbox, Inbox and Idempotency, 29.10 The transactional outbox): a change to the source database writes an event in the same transaction, and a worker propagates it to the other store, so the propagation cannot be lost.
- **CDC** (Change Data Capture, see Part 38 — Data Engineering for Backend Engineers, 38.2): the database's change log streams to the other stores.
- Both make the derived stores **eventually consistent** with the source, which you must design the application to tolerate (the search index is a second behind, the cache may be briefly stale, Part 26).

The source of truth is one store (usually PostgreSQL for transactional data); the others are derived and kept in sync. Treating two stores as both authoritative for the same data is a recipe for divergence and is avoided.

```text
PostgreSQL (source of truth)
    |  outbox / CDC (Part 29, Part 38)
    +--> search index   (Part 33)
    +--> vector store    (Part 37)  [pgvector avoids this by living in PG]
    +--> cache (Redis)   (Part 26)
    +--> analytics warehouse (Part 38)
Each derived store is eventually consistent; the app tolerates the lag.
```

#### How it works — migrating between NoSQL and PostgreSQL

Migrations go both ways, for real reasons:

- **NoSQL to PostgreSQL** happens when a team discovers they need transactions, joins or query flexibility they gave up — the common "we modeled relational data in a document store by default" realization (25.2). The migration re-normalizes documents into relational tables, often via a dual-write or backfill-and-cutover (Part 81 on large migrations).
- **PostgreSQL to NoSQL** happens when a specific workload genuinely outgrows the relational model — write scale past a single primary, or an access pattern that fits a key-value model at massive scale. The migration denormalizes into the target's access-pattern-first model.

Both are large migrations with the usual pitfalls (Part 81): they fail when underestimated, so they use incremental strategies, dual writes or CDC-based sync, backfills, and reconciliation to verify nothing was lost. The reasons must be specific; migrating stores is expensive and risky, so it is justified by a concrete requirement, not a preference.

#### The decision matrix

| Store | Best for | Key strength | Key tradeoff |
|---|---|---|---|
| PostgreSQL | Transactional, relational data (the default) | Transactions, joins, constraints, flexible queries | Single primary for writes; scale past it needs work |
| MongoDB | Document-shaped, document-at-a-time data | Flexible schema, natural document fit | Weaker cross-entity transactions; not for relational data |
| DynamoDB | Known key-based access at massive scale | Predictable low latency, transparent scale | Rigid (access-pattern-first); no joins/ad-hoc queries |
| Cassandra | Huge write volume, high availability across regions | Write scale, availability, tunable consistency | Query-first modeling, eventual consistency, ops weight |
| Redis | Caching, ephemeral/low-latency state | Sub-millisecond reads | In-memory, not the source of truth (Part 26) |
| TimescaleDB | High-volume time-series | Time partitioning, retention, rollups, stays in PG | Still one PostgreSQL (very large scale needs more) |
| Neo4j | Deep relationship traversal | Fast multi-hop traversal, graph algorithms | Specialized; overkill for one/two-hop relationships |

```text
Default: PostgreSQL. Move or add a store only for a specific, measured requirement:
  need a document-at-a-time flexible-schema fit      -> MongoDB
  need key-based access at massive scale              -> DynamoDB
  need huge write volume + multi-region availability  -> Cassandra
  need sub-ms cache                                   -> Redis
  need high-volume time-series                        -> TimescaleDB (stays in PG)
  need deep relationship traversal                    -> Neo4j
```

#### How a Senior Backend Engineer thinks about this

A senior defaults to PostgreSQL and adds a second store only for a specific, measured requirement it cannot meet, treating each additional store as a permanent operational tax — another system to run, secure, back up, monitor and, hardest of all, keep in sync with the source of truth via outbox or CDC, with eventual consistency the application must tolerate. They keep one source of truth and make other stores derived, never dual-authoritative. They treat migrating between stores as a serious migration (Part 81) justified by a concrete need, done incrementally with sync and reconciliation. When choosing among stores they match the store to the specific access pattern and scale requirement using the matrix, and they resist polyglot sprawl, because every store added is complexity and cost forever, and the simplest architecture that meets the requirement wins.

#### Common mistakes

- Polyglot sprawl: adding stores without a specific requirement, multiplying operational cost.
- Treating two stores as both authoritative for the same data, causing divergence.
- Not keeping derived stores in sync via outbox/CDC, so they drift from the source.
- Not designing the application to tolerate the eventual consistency of derived stores.
- Migrating stores without a concrete reason, or without incremental sync and reconciliation (Part 81).

#### Interview questions

1. **What is polyglot persistence and what is its main cost?** Using multiple specialized datastores, each for what it does best; the main cost is operating each store and keeping derived stores consistent with the source of truth (outbox/CDC), with eventual consistency to tolerate.
2. **How do you keep a derived store (search index, cache, vector store) consistent with PostgreSQL?** Propagate changes via the outbox pattern or CDC so the derived store is eventually consistent; keep one source of truth and the others derived.
3. **Why do teams migrate from NoSQL to PostgreSQL?** They discover they need transactions, joins or query flexibility they gave up — commonly after modeling relational data in a document store by default.
4. **How do you choose among PostgreSQL, MongoDB, DynamoDB, Cassandra, TimescaleDB and Neo4j?** Default to PostgreSQL; move or add a store only for a specific requirement — document fit (MongoDB), key-based massive scale (DynamoDB), huge write volume and availability (Cassandra), time-series (TimescaleDB), deep traversal (Neo4j) — accepting each one's tradeoffs and operational cost.

#### Practical exercise

For a system with transactional orders, product search, a request cache, high-volume device metrics, and a recommendation feature based on connections, assign each need to a store from the matrix, identify which stores are derived and how you would keep them in sync with the source of truth, and write a short justification resisting any store you do not actually need. Acceptance criteria: PostgreSQL remains the transactional source of truth, derived stores have a stated sync mechanism (outbox/CDC) and eventual-consistency tolerance, and each specialized store is justified by a specific requirement.
