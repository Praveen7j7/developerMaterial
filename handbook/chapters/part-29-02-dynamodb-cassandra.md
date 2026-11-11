## 29.3 Key-value and wide-column at scale (DynamoDB)

### 29.3.1 Partition keys, single-table design and access patterns

#### Concept

**DynamoDB** is a managed key-value and wide-column database built for massive scale and predictable low-latency access by key. Its data model is organized around a **partition key** (which decides where data is stored and must be in every query) and an optional **sort key** (which orders items within a partition). You model DynamoDB **access-pattern-first**: you list the exact queries the application needs, then design the keys so each query is a direct key lookup. This is the opposite of relational modeling, where you model entities and then query flexibly.

#### Why does it exist?

Some systems need to serve enormous volumes of "get this item by key" or "get these items for this key" with single-digit-millisecond latency, at any scale, with no capacity planning headaches. DynamoDB exists for that: it scales horizontally and transparently by spreading data across partitions by the partition key, so throughput grows with the data. The price is rigidity — you must know your access patterns up front, and queries that do not fit the keys are slow or impossible — which is exactly the tradeoff that buys the scale.

#### Mental model

Imagine a vast warehouse where every item's shelf is decided by a hash of its key, spread across thousands of aisles (partitions) so no aisle is a bottleneck. To find something, you must know its key — that tells you the exact shelf instantly. Browsing ("find all red items") is not what the warehouse is built for; you would have to walk every aisle. DynamoDB is that warehouse: lightning-fast when you know the key, awkward or impossible for queries that do not use it. You design the keys so every query the business needs is a known-shelf lookup.

#### How it works — keys and single-table design

- **Partition key**: hashes to a partition; determines where the item lives. Every read and write specifies it. Good partition keys spread load evenly (high cardinality); a poor one creates a **hot partition** (one partition taking disproportionate traffic), a classic DynamoDB problem.
- **Sort key**: orders items within a partition, enabling range queries within one partition key ("all orders for this user, newest first", "all events for this device between two times").
- **Single-table design**: a DynamoDB-specific practice of storing multiple entity types in one table, using composite key patterns, so that related items share a partition and can be fetched together in one query. It looks strange to a relational eye but is how you avoid joins (which DynamoDB does not do) by pre-arranging related data to be co-located.

```text
Single-table design for a user's orders (one table, multiple entity types):

PK (partition key)      SK (sort key)            attributes
USER#usr_7              PROFILE                   name, email, plan
USER#usr_7              ORDER#2026-01-15#ord_1    status, totalCents
USER#usr_7              ORDER#2026-01-20#ord_2    status, totalCents

Query "get user usr_7's profile and recent orders" = one query:
  PK = "USER#usr_7" AND SK begins_with "ORDER#" (or "PROFILE")
All items for that user share the partition -> fetched together, no join.
```

- **Global Secondary Indexes (GSIs)**: because you can only query efficiently by the table's keys, a GSI defines an alternative partition/sort key for a different access pattern (for example, query orders by status instead of by user). You add a GSI for each additional access pattern that does not fit the main keys. GSIs cost extra storage and throughput, so you add them deliberately, one per real access pattern.
- **Capacity modes**: on-demand (pay per request, scales automatically, simplest) or provisioned (you set capacity, cheaper at steady predictable load). You choose based on traffic predictability and cost.

#### Hot partitions

If one partition key gets disproportionate traffic — a single viral product, a celebrity user, a monotonically increasing timestamp key that always writes to the newest partition — that partition becomes a bottleneck even though the table as a whole has capacity. The defenses: choose a high-cardinality partition key that spreads load, add a suffix to spread a hot key across several partitions (write sharding), and avoid sequential keys for high-write workloads. The hot partition is DynamoDB's signature failure mode and must be designed against.

#### Production scenario

A ride-booking app stores trip history. The dominant access pattern is "get a user's recent trips", so the partition key is the user id and the sort key is the trip timestamp, making that query a single fast partition read ordered by time. A GSI on driver id serves "get a driver's trips". On-demand capacity handles the spiky weekend traffic without planning. Because the access patterns were known and the keys designed for them, every query the app needs is a direct, scalable key lookup, and the system handles enormous volume with predictable low latency — the case DynamoDB is built for.

#### Failure scenario

A team used DynamoDB with a partition key of `status` (a low-cardinality field with only a few values). Almost all active orders had `status = "pending"`, so nearly all traffic hit one partition — a hot partition that throttled while the rest of the table sat idle. Worse, a new report needed "orders over $100 across all users", which no key supported, forcing a full table scan that was slow and expensive. The root cause was modeling without access-pattern-first thinking and choosing a low-cardinality partition key. The fixes: a high-cardinality partition key, a GSI for the new access pattern, and, since the workload actually needed flexible ad-hoc queries and joins, a serious reconsideration of whether DynamoDB was the right store at all. The lesson: DynamoDB rewards access-pattern-first design with high-cardinality keys and punishes relational, query-flexible thinking.

#### Edge cases & failure modes

- **Item size**: an item is capped at 400 KB including attribute names; an "append every event to the user item" design hits the cap and every write gets more expensive as the item grows (writes are billed per KB of the whole item).
- **Query page size**: a single `Query` returns at most 1 MB of data; a client that ignores `LastEvaluatedKey` silently shows a truncated list.
- **GSIs are eventually consistent**: a write is visible on the base table immediately but on a GSI usually within a second; a "create then list by status" flow can miss the new item.
- **GSI back-pressure**: if a GSI is under-provisioned, writes to the **base table** are throttled too, which surprises teams who only watch the table.
- **Scans**: a `Scan` reads (and bills) the whole table; a 200 GB table scan costs real money and minutes of time. Treat any production `Scan` as a design bug unless it is a deliberate batch job.
- **Retries and duplicates**: the SDK retries throttled requests; an unconditional `PutItem` retried after a timeout is harmless, but an `UpdateItem` that increments a counter is not idempotent. Use condition expressions or idempotency tokens (`ClientRequestToken` on transactions).
- **Sequential keys**: a partition key such as the current date sends a whole day's writes to one partition.

29.8 turns this section into running code: the SDK v3 commands, GSIs, transactions and the capacity math.

#### How a Senior Backend Engineer thinks about this

A senior models DynamoDB access-pattern-first: write down every query the application needs, then design partition and sort keys and GSIs so each is a direct key lookup, using single-table design to co-locate related items and avoid joins. They choose high-cardinality partition keys to spread load and design against hot partitions (write sharding for hot keys, no sequential keys for high writes). They add a GSI per genuine additional access pattern, mindful of its cost. They choose DynamoDB only when the access patterns are known, stable and key-based at a scale that justifies the rigidity — and they refuse it for workloads that need flexible ad-hoc queries, joins or frequent cross-entity transactions, because those are exactly what DynamoDB sacrifices for scale. The decision is "do our access patterns fit a key-based model at a scale that needs this?", not "is DynamoDB trendy?".

#### Common mistakes

- Modeling entities first instead of access patterns first.
- Low-cardinality or sequential partition keys causing hot partitions.
- Expecting flexible ad-hoc queries or joins; DynamoDB does neither.
- Not adding a GSI for an access pattern, forcing full table scans.
- Choosing DynamoDB for a workload that needs relational flexibility.

#### Interview questions

1. **How do you model data for DynamoDB?** Access-pattern-first: list every query the app needs, then design partition/sort keys and GSIs so each is a direct key lookup, using single-table design to co-locate related items.
2. **What is a hot partition and how do you avoid it?** A partition taking disproportionate traffic (from a low-cardinality or sequential key); avoid with high-cardinality keys and write-sharding a hot key across partitions.
3. **What is a GSI and when do you add one?** A Global Secondary Index with alternative keys for an access pattern the main keys do not serve; add one per genuine additional access pattern, mindful of its extra cost.
4. **When is DynamoDB the right choice and when is it wrong?** Right for known, stable, key-based access patterns at massive scale needing predictable low latency; wrong for workloads needing flexible ad-hoc queries, joins, or frequent cross-entity transactions.

#### Practical exercise

Design a DynamoDB single-table model for a ride-booking trip history supporting these access patterns: get a user's recent trips, get a specific trip, and get a driver's trips. Specify the partition key, sort key, and any GSI, and explain how each access pattern maps to a key lookup and how you avoid hot partitions. Acceptance criteria: every listed access pattern is a direct key or GSI query (no scans), and the partition key is high-cardinality.

## 29.4 Wide-column (Cassandra)

### 29.4.1 Partition keys, clustering columns and the write path

#### Concept

**Cassandra** is a wide-column database built for massive write throughput and high availability across many nodes, with no single point of failure and tunable consistency. Data is organized by a **partition key** (which node stores it) and **clustering columns** (which order rows within a partition). Like DynamoDB, you model around queries, not entities, and denormalize heavily. Its distinctive strengths are enormous write scale and staying available during node or network failures, with consistency you tune per query.

#### Why does it exist?

Some workloads write constantly at a scale and availability requirement no single-primary database can meet — global time-series ingestion, activity feeds, messaging, sensor data — and must keep accepting writes even when some nodes or a whole data center are unreachable. Cassandra exists for that: a masterless, horizontally-scaled design where every node can accept writes, data is replicated across nodes and regions, and you tune how many replicas must acknowledge a read or write (consistency vs availability vs latency) per operation. It trades the relational model and strong-by-default consistency for write scale and partition-tolerant availability.

#### Mental model

Imagine a chain of identical post offices across the world, none of them the "head office" (masterless). You can drop a letter at any one (any node accepts writes), and each letter is copied to several offices (replication) so losing one loses nothing. When you ask for your mail, you can demand confirmation from just one office (fast, maybe slightly stale) or from a majority (slower, more certain) — that is tunable consistency. The design keeps running even if some offices are cut off (availability during partitions), at the cost of not being a single tidy ledger (no joins, eventual consistency unless you pay for more).

#### How it works — keys, write path and consistency

- **Partition key + clustering columns**: the partition key distributes data across nodes; clustering columns order rows within a partition (for example, partition by device id, cluster by timestamp, for "readings for this device ordered by time"). You model each table to serve one query pattern, duplicating data across tables for different patterns.
- **The write path** is what makes writes fast: a write goes to an in-memory structure (the **memtable**) and an append-only commit log, acknowledged quickly; memtables are periodically flushed to immutable disk files (**SSTables**); because SSTables are immutable, updates and deletes are written as new entries, and a background process (**compaction**) merges SSTables and removes superseded data. This append-first design gives Cassandra its very high write throughput.
- **Tunable consistency**: per query, you choose how many replicas must respond (consistency level) — for example, a write acknowledged by one replica (fast, less durable) versus a quorum (slower, stronger). With reads and writes both at quorum you get strong consistency; at lower levels you trade for latency and availability. This per-query tuning is the practical expression of the CAP tradeoff (see Part 32 — Distributed Systems Fundamentals, 32.4 and 32.10 on quorum).

```text
Time-series table in Cassandra, modeled for one query:
  "get readings for a device, newest first"

  PRIMARY KEY ((device_id), reading_time)   -- partition by device, cluster by time DESC
  -> all of one device's readings on one partition, ordered by time
  -> fast writes (append to memtable + commit log) and fast time-range reads per device
```

#### Practical example

Cassandra uses CQL, a SQL-like language. It looks familiar, which is a trap: the `PRIMARY KEY` is not just uniqueness, it is the physical layout, and the `WHERE` clause may only use the partition key and a prefix of the clustering columns.

```sql
-- CQL: sensor readings, partitioned by device AND day so no partition grows forever.
CREATE TABLE telemetry.readings_by_device (
  device_id   uuid,
  day         date,              -- time bucket: bounds the partition to one day of readings
  reading_at  timestamp,
  temperature double,
  humidity    double,
  PRIMARY KEY ((device_id, day), reading_at)
) WITH CLUSTERING ORDER BY (reading_at DESC);

-- Allowed: full partition key, range on the clustering column.
SELECT reading_at, temperature FROM telemetry.readings_by_device
 WHERE device_id = 6f1c2a9e-1d4b-4e0a-9a51-3c7d0b2e8f10 AND day = '2026-11-05'
   AND reading_at > '2026-11-05 08:00:00' LIMIT 500;

-- Rejected without ALLOW FILTERING: no partition key, so every node would be scanned.
-- SELECT * FROM telemetry.readings_by_device WHERE temperature > 40;
```

A device sending one reading every 10 seconds produces 8,640 rows a day, about 400 KB per partition: comfortably small. Without the `day` bucket, the same device would accumulate 3 million rows a year in one partition, which slows reads, compaction and repair. 29.9 covers the write and read path, compaction and consistency in depth.

#### Production scenario

A logistics company ingests GPS pings from 120,000 vehicles every 5 seconds: 24,000 writes per second on average, 60,000 at peak. A 9-node Cassandra cluster across 3 availability zones, replication factor 3, writes at `LOCAL_QUORUM` with a p99 write latency of about 4 ms. Reads ("where was vehicle X between 10:00 and 10:30") hit one partition and return in under 10 ms. When one node was replaced for a disk failure, writes continued uninterrupted because two of three replicas still acknowledged every write. That is the workload Cassandra exists for: append-heavy, always written by key and time, read by key and time, and required to stay writable through node failures.

#### Failure scenario

At 02:14 the on-call was paged: read latency on the "recent alerts" table had jumped from 8 ms to 4 seconds, and some reads were failing with `TombstoneOverwhelmingException`. The team had modeled alerts as a queue: insert when raised, delete when acknowledged, read "the open alerts for this site". A delete in Cassandra writes a **tombstone** (a marker), which is only purged after `gc_grace_seconds` (10 days by default) and a compaction. A busy site had 180,000 tombstones in its partition, and every read scanned them all before finding the 40 live rows. The fix was a remodel: bucket alerts by site and hour, read only the last few buckets, and let old buckets expire by TTL instead of being deleted one by one. The lesson: Cassandra is excellent for append-mostly data and poor as a queue with heavy deletes.

#### Edge cases & failure modes

- **Unbounded partitions**: a partition key without a time bucket grows forever; keep partitions under roughly 100 MB and 100,000 rows.
- **Tombstones**: deletes, TTL expiry and writing `null` all create tombstones; delete-heavy patterns degrade reads.
- **`ALLOW FILTERING`**: makes a query run by scanning; acceptable in a one-off investigation, never in a request path.
- **Lightweight transactions** (`IF NOT EXISTS`): use Paxos, cost about four round trips, and should be rare.
- **Clock skew**: Cassandra resolves conflicting writes by timestamp (last write wins); a client with a fast clock silently wins every conflict.
- **Node down during writes**: hinted handoff stores the missed writes briefly; a node down longer than the hint window needs a repair.
- **Secondary indexes**: local to each node, so a query by a secondary index fans out to every node; model a second table instead.

#### How a Senior Backend Engineer thinks about this

A senior reaches for Cassandra when the requirement is sustained massive write throughput and high availability across regions with tolerance for node and partition failures — write-heavy, append-mostly workloads like time series, feeds and messaging at scale. They model query-first, one table per access pattern, denormalizing freely, because joins do not exist and ad-hoc queries are not the point. They choose partition keys that spread writes and avoid unbounded partitions (a partition that grows forever becomes a problem). They tune consistency per operation to the business need, understanding they are trading on the CAP tradeoff explicitly. They know Cassandra's operational weight (running a multi-node cluster, compaction tuning) is real, so they adopt it only when the write-scale and availability requirements genuinely justify it over PostgreSQL plus partitioning, or over DynamoDB (which offers similar tradeoffs as a managed service).

#### Common mistakes

- Using Cassandra for a workload that does not need its write scale or availability, taking on heavy operations for nothing.
- Modeling by entity instead of query, then finding queries impossible without a remodel.
- Partition keys that create hot or unbounded partitions.
- Expecting strong consistency by default or ad-hoc queries/joins.
- Ignoring compaction and operational tuning.

#### Interview questions

1. **What is Cassandra built for?** Massive write throughput and high availability across many nodes/regions with tunable consistency and no single point of failure; write-heavy, append-mostly workloads like time series, feeds and messaging at scale.
2. **Explain Cassandra's write path.** Writes go to an in-memory memtable and an append-only commit log (fast ack), are flushed to immutable SSTables, and background compaction merges SSTables and removes superseded data; the append-first design gives high write throughput.
3. **What is tunable consistency?** Per query you choose how many replicas must respond, trading consistency against latency and availability (quorum reads+writes give strong consistency; lower levels favor availability/latency) — the CAP tradeoff made explicit.
4. **How do you model for Cassandra?** Query-first, one table per access pattern, denormalized, with partition keys that spread writes and bounded partition sizes; no joins or ad-hoc queries.

#### Practical exercise

Design a Cassandra table for storing IoT sensor readings that must support "get a device's readings in a time range, newest first" at high write volume, specifying the partition key and clustering columns, explaining how the write path makes ingestion fast, and choosing a consistency level for writes with justification. Acceptance criteria: the query is a single-partition range read, writes spread across partitions, and partitions do not grow unbounded.
