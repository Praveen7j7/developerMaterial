## 39.9 Warehouses and lakes in practice: Parquet, table formats and the big three

#### Concept

Section 39.3.1 explained why columnar, partitioned storage makes aggregates cheap. This section shows what that looks like in real systems: how a Parquet file is laid out, what a **table format** (Apache Iceberg, Delta Lake) adds on top of plain files, the DDL for partitioning and clustering in BigQuery, Redshift and Snowflake, and how each one charges you, because the pricing model decides how you should write queries.

#### How it works — inside a Parquet file

```text
orders-2026-11-04-0001.parquet  (about 256 MB)
  Row group 1 (about 128 MB, roughly 4 million rows)
    Column chunk: order_id     -> pages, dictionary encoded
    Column chunk: status       -> pages, dictionary + run-length encoded (7 distinct values)
    Column chunk: total_cents  -> pages, plain/delta encoded; min=100, max=9,850,000
    Column chunk: paid_at      -> pages; min=2026-11-04T00:00:02, max=2026-11-04T09:12:40
  Row group 2 ...
  Footer: schema + per-row-group, per-column statistics (min, max, null count)
```

A reader opens the footer first. For `WHERE paid_at >= '2026-11-04T10:00'` it can skip row group 1 entirely because its `paid_at` maximum is 09:12. For `SELECT sum(total_cents)` it reads only the `total_cents` chunks. Low-cardinality columns like `status` shrink to almost nothing with dictionary plus run-length encoding. That is why the same orders data is about 24 GB as PostgreSQL heap and around 3–5 GB as Parquet.

Plain Parquet files in S3 have no transactions: a reader can see half-written data, there is no `DELETE`, and "the table" is whatever files happen to be in a prefix. **Table formats** add a metadata layer that tracks which files make up each version (snapshot) of the table. Iceberg and Delta give you atomic commits, schema evolution, row-level `DELETE` and `MERGE` (needed for CDC upserts and GDPR erasure), time travel, and, in Iceberg's case, hidden partitioning (you partition by `day(commit_ts)` and readers filter on `commit_ts` without knowing the layout).

#### PostgreSQL example (warehouse DDL)

The same `fct_orders` table in the three common warehouses and in an Iceberg lake table:

```sql
-- BigQuery: partition by day, cluster by common filters, refuse unpartitioned scans
CREATE TABLE analytics.fct_orders (
  order_id STRING NOT NULL, customer_key STRING, seller_id STRING, status STRING,
  currency STRING, total_cents INT64, paid_at TIMESTAMP, business_date DATE
)
PARTITION BY business_date
CLUSTER BY seller_id, status
OPTIONS (require_partition_filter = TRUE);

-- Amazon Redshift: distribute rows to co-locate joins, sort for range filters
CREATE TABLE analytics.fct_orders (
  order_id VARCHAR(36) NOT NULL, customer_key VARCHAR(64), seller_id VARCHAR(36), status VARCHAR(24),
  currency CHAR(3), total_cents BIGINT, paid_at TIMESTAMP, business_date DATE
)
DISTSTYLE KEY DISTKEY (customer_key)
SORTKEY (business_date);

-- Snowflake: micro-partitions are automatic; a clustering key helps very large tables
CREATE TABLE analytics.fct_orders (
  order_id VARCHAR NOT NULL, customer_key VARCHAR, seller_id VARCHAR, status VARCHAR,
  currency VARCHAR(3), total_cents NUMBER(18,0), paid_at TIMESTAMP_NTZ, business_date DATE
)
CLUSTER BY (business_date, seller_id);

-- Iceberg table in S3, created through Amazon Athena (supports DELETE, MERGE, time travel)
CREATE TABLE lake.orders_cdc (
  order_id string, customer_key string, status string, currency string,
  total_cents bigint, source_lsn bigint, is_deleted boolean, commit_ts timestamp
)
PARTITIONED BY (day(commit_ts))
LOCATION 's3://acme-lake/orders_cdc/'
TBLPROPERTIES ('table_type' = 'ICEBERG');
```

#### Choosing and paying

| | BigQuery | Snowflake | Redshift | Athena or Trino on an S3 lake | PostgreSQL plus read replica |
|---|---|---|---|---|---|
| Model | Serverless | Virtual warehouses you size and suspend | Provisioned cluster or Serverless | Serverless query over files | Your existing database |
| Main cost driver | Bytes scanned (on-demand about $6.25 per TiB) or reserved slots | Credits per second while a warehouse runs (XS = 1 credit/hour) | Node-hours, or RPU-hours on Serverless | Bytes scanned (about $5 per TB) | Instance hours |
| Write queries to | Prune partitions, select few columns | Suspend idle warehouses, size per workload | Pick DISTKEY/SORTKEY well | Partition and compact files | Keep aggregates small |
| Sweet spot | Spiky analytics, little ops | Many teams, mixed workloads | AWS shops with steady load | Huge raw history, cheap storage | Under ~100 GB analytics, one team |

A pragmatic path for a growing product: start with materialized views and summary tables in PostgreSQL (39.6); add a read replica for analysts; move to a warehouse fed by CDC when analytics data passes roughly 100–200 GB, when queries need history the primary should not keep, or when more than one team builds on the data. Keep raw CDC in an Iceberg lake when you need cheap long-term history and replay.

#### Edge cases & failure modes

- **Iceberg delete is not physical erasure yet.** `DELETE` writes a new snapshot; old snapshots still reference files that contain the row until snapshots are expired and orphan files removed (Athena: `VACUUM`; Spark: the `expire_snapshots` procedure).
- **Function on the partition column.** `WHERE DATE(paid_at) = ...` when the table is partitioned by `business_date` prunes nothing.
- **Redshift skew.** A DISTKEY on a column where one value is 30% of rows puts 30% of the work on one slice.
- **Suspended warehouse latency.** A Snowflake warehouse auto-resumes in seconds, but a dashboard that wakes it every minute keeps it billing all day.

#### How a Senior Backend Engineer thinks about this

A senior reads the pricing page before the architecture diagram, because in a warehouse the bill is the performance metric. They ask what the dominant query shape is (filters by date, by seller), and they design partitioning and clustering for it, then enforce partition filters for anyone who forgets. They prefer the smallest system that fits: PostgreSQL first, a managed warehouse when the data or the number of teams outgrows it, a lake with a table format when history and replay matter.

#### Interview questions

1. **Why can a query engine skip most of a Parquet file?** Row-group statistics in the footer let it skip row groups whose min/max cannot match the filter, and columnar layout lets it read only the needed columns.
2. **What does a table format like Iceberg add over plain Parquet?** Atomic snapshots, schema evolution, row-level deletes and merges, time travel and hidden partitioning.
3. **How does pricing change how you write warehouse queries?** Per-byte pricing rewards pruning partitions and selecting few columns; per-compute-time pricing rewards suspending idle compute and sizing warehouses per workload.

#### Practical exercise

Load one month of synthetic orders (10 million rows) into Parquet with daily partitions and query it with DuckDB or Athena. Compare bytes scanned for `SELECT *` against one day versus `SELECT sum(total_cents)` against the same day. Acceptance criteria: you report bytes scanned for both and explain the difference using row groups and column chunks.

## 39.10 Stream processing in practice: Kafka Streams and Flink

#### Concept

Section 39.3.2 introduced windows, watermarks and late events. This section maps them onto the two common engines. **Kafka Streams** is a Java library you embed in your own service: it reads from Kafka, keeps state in local RocksDB stores backed by Kafka changelog topics, and writes back to Kafka. **Apache Flink** is a separate cluster that runs jobs written in Java, Python or SQL, with its own checkpointed state and connectors to many systems. Both give exactly-once processing for Kafka-to-Kafka pipelines; neither makes an external side effect exactly-once for you.

#### How it works — window types

| Window | Definition | Example | Kafka Streams | Flink |
|---|---|---|---|---|
| Tumbling | Fixed size, no overlap | Orders per minute | `TimeWindows.ofSizeAndGrace(...)` | `TUMBLE` in SQL |
| Hopping | Fixed size, overlapping, advances by a step | 5-minute revenue every minute | `TimeWindows...advanceBy(...)` | `HOP` in SQL ("sliding" in the DataStream API) |
| Sliding (Kafka Streams) | Defined by maximum time difference between events | Two payment attempts within 30 seconds | `SlidingWindows.ofTimeDifferenceAndGrace(...)` | Interval joins or custom logic |
| Session | Closes after a gap of inactivity | A user's browsing session | `SessionWindows.ofInactivityGapAndGrace(...)` | Session windows |
| Cumulative | Growing window inside a fixed period | Revenue so far today, every minute | Not built in | `CUMULATE` in SQL |

Note the naming trap: Flink's DataStream "sliding window" is what Kafka Streams calls a hopping window.

#### How it works — state, checkpoints and exactly-once

```text
Kafka Streams                                   Flink
  state: RocksDB on the instance's disk           state: heap or RocksDB state backend
  durability: every update also written to       durability: periodic checkpoints (barriers flow
    a compacted changelog topic in Kafka            through the job; state snapshot to S3)
  failure: another instance restores the store   failure: job restarts from the last checkpoint
    from the changelog (standby replicas speed      and rewinds Kafka offsets to match
    this up: num.standby.replicas)                 upgrade: take a savepoint, deploy, restore
  exactly-once: processing.guarantee=            exactly-once: checkpoints + transactional
    exactly_once_v2 (Kafka transactions)           Kafka sink (two-phase commit on checkpoint)
  late events: grace period; suppress()          late events: watermark; SQL drops rows behind
    emits only final results per window            the watermark; DataStream API has
                                                   allowedLateness() and sideOutputLateData()
```

The exactly-once guarantee covers "read from Kafka, update state, write to Kafka" as one atomic step. If the job writes to PostgreSQL, Redis or an HTTP API, that write is at least once, so make it an idempotent upsert keyed by the window.

#### PostgreSQL example (Flink SQL, with a PostgreSQL sink)

A live revenue-per-minute job in Flink SQL that reads `order.paid` events from the outbox topic and upserts one row per minute and currency into PostgreSQL:

```sql
CREATE TABLE order_paid (
  order_id    STRING,
  seller_id   STRING,
  currency    STRING,
  total_cents BIGINT,
  paid_at     TIMESTAMP(3),
  WATERMARK FOR paid_at AS paid_at - INTERVAL '30' SECOND    -- tolerate 30 s of disorder
) WITH (
  'connector' = 'kafka',
  'topic' = 'orders.events.order-paid',
  'properties.bootstrap.servers' = 'kafka-1:9092,kafka-2:9092,kafka-3:9092',
  'properties.group.id' = 'live-revenue',
  'scan.startup.mode' = 'group-offsets',
  'properties.auto.offset.reset' = 'earliest',
  'format' = 'json',
  'json.timestamp-format.standard' = 'ISO-8601'
);

CREATE TABLE live_revenue_per_minute (
  window_start  TIMESTAMP(3),
  currency      STRING,
  orders        BIGINT,
  revenue_cents BIGINT,
  PRIMARY KEY (window_start, currency) NOT ENFORCED          -- upsert: replays overwrite, never add
) WITH (
  'connector' = 'jdbc',
  'url' = 'jdbc:postgresql://live-analytics-db:5432/live',
  'table-name' = 'live_revenue_per_minute'
);

INSERT INTO live_revenue_per_minute
SELECT window_start, currency, COUNT(*), SUM(total_cents)
  FROM TABLE(TUMBLE(TABLE order_paid, DESCRIPTOR(paid_at), INTERVAL '1' MINUTE))
 GROUP BY window_start, window_end, currency;
```

Set `table.exec.source.idle-timeout` (for example `'30 s'`) so quiet partitions do not hold back the watermark (the Black Friday story in 39.3.2), and enable checkpointing (`execution.checkpointing.interval: 30 s`). Each minute's row appears about 30 seconds after the minute ends, once the watermark passes. Events more than 30 seconds late are dropped by this SQL aggregation; the nightly batch mart (39.8) is the reconciled, final number, and the live chart is labelled as provisional.

The same idea in Kafka Streams, as the Java DSL calls (shown as text because application code in this book is TypeScript):

```text
builder.stream("orders.events.order-paid")
  .groupBy((key, evt) -> evt.currency)                    // repartition topic keyed by currency
  .windowedBy(TimeWindows.ofSizeAndGrace(Duration.ofMinutes(1), Duration.ofSeconds(30)))
  .aggregate(Revenue::zero, (cur, evt, agg) -> agg.add(evt.totalCents), Materialized.as("rev-per-min"))
  .suppress(Suppressed.untilWindowCloses(BufferConfig.unbounded()))   // emit once, when final
  .toStream()
  .to("analytics.revenue-per-minute");
```

#### Choosing an engine

| Option | Use when | Avoid when |
|---|---|---|
| NestJS consumer with PostgreSQL upserts into minute buckets | Under a few thousand events per second, simple counts and sums | Joins between streams, large state |
| Kafka Streams | JVM team, logic lives with one service, Kafka in and out | Non-JVM team; sources other than Kafka |
| Flink (SQL or DataStream) | Many jobs, joins, large state, SQL for analysts, many connectors | One simple counter |
| Micro-batch every 1–5 minutes in the warehouse | "Near real time" means 5 minutes | Seconds matter (fraud, live ops) |

The first row deserves respect. A consumer that does `INSERT ... ON CONFLICT (minute, currency) DO UPDATE` with a dedupe table (the pattern from 39.6.1) gives you event-time buckets with unlimited lateness for free, because a late event simply updates an older row. Many teams never need more.

#### Edge cases & failure modes

- **Repartition topics.** `groupBy` on a new key writes through an internal topic; it doubles Kafka traffic for that stream and must be sized.
- **Checkpoint timeouts.** Large RocksDB state plus slow S3 makes checkpoints exceed their timeout; the job then fails repeatedly. Use incremental checkpoints and monitor checkpoint duration.
- **Changing a job's state schema.** Restoring a savepoint into a job whose state layout changed can fail; plan state migrations like database migrations.
- **Co-partitioning for joins.** Kafka Streams joins require both topics to have the same partition count and key.
- **Restore time.** A Kafka Streams instance with 40 GB of state can take many minutes to restore after a crash; standby replicas avoid that wait.

#### How a Senior Backend Engineer thinks about this

A senior asks "how fresh, and how correct?" before choosing an engine. If a five-minute delay is fine, micro-batch wins. If seconds matter and the logic is a counter, a plain consumer with idempotent upserts wins. Flink or Kafka Streams earn their operational cost when there are joins, large state or many jobs. Whatever runs, the live number is labelled provisional, and the reconciled batch number is the one finance uses.

#### Interview questions

1. **What does exactly-once mean in Kafka Streams or Flink, and where does it stop?** Reading, updating state and writing to Kafka commit atomically; writes to external systems are at least once and need idempotency.
2. **How does Flink recover a stateful job after a crash?** It restarts from the last completed checkpoint, restoring state and rewinding source offsets to the positions recorded in that checkpoint.
3. **What is `suppress(untilWindowCloses)` for?** To emit one final result per window after the grace period instead of an update for every event, so downstream systems do not see intermediate counts.
4. **Why might a Flink SQL window never emit?** The watermark is not advancing, often because an input partition is idle; set a source idle timeout.

#### Practical exercise

Implement live orders-per-minute twice: once as a NestJS consumer upserting minute buckets in PostgreSQL with a dedupe table, once as the Flink SQL job above. Feed both the same stream with 2% of events delayed 10–90 seconds. Acceptance criteria: you can explain why the NestJS version eventually counts every event and the Flink version drops those beyond 30 seconds, and both agree with a batch recount within the expected margin.

## 39.11 Contracts, quality and erasure in practice

#### Concept

Section 39.4 argued that event schemas are contracts and reconciliation is the backstop; 39.5 argued that erasure must reach every copy. This section is the enforcement kit: schema-registry compatibility modes, a contract test in the producer's CI, a reconciliation query, and the erasure mechanics for a warehouse, a lake table and data you cannot edit.

#### How it works — enforcing the contract at two points

1. **At registration.** The schema registry checks each new schema version against the subject's compatibility mode. `BACKWARD` (the usual default) means consumers using the new schema can read data written with the previous one, so consumers can upgrade first; `FORWARD` means old consumers can read new data; `FULL` is both; the `_TRANSITIVE` variants check against all previous versions, not only the last. Set it per subject:

```bash
curl -s -X PUT -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
  --data '{"compatibility": "FULL_TRANSITIVE"}' \
  http://schema-registry.internal:8081/config/orders.events.order-paid-value
```

2. **In the producer's pull request.** A test fails the build before anything reaches the registry (see Part 85 — Architecture Governance, 85.8, and Part 25 — Backward Compatibility, 25.4):

```ts
// order-paid.contract.spec.ts -- the event we emit must still satisfy the published contract
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import contract from '../contracts/order-paid.v1.schema.json';
import { buildOrderPaidEvent } from '../src/orders/events/order-paid.event';

describe('order.paid contract v1', () => {
  const ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
  const validate = ajv.compile(contract);

  it('emits an event that satisfies the published schema', () => {
    const evt = buildOrderPaidEvent({
      orderId: '7f3c9a20-1d1e-4c55-9a8e-0b6f2f1a9c11', sellerId: 's-42', currency: 'INR',
      totalCents: 45900, paidAt: new Date('2026-11-04T10:15:00Z'),
    });
    expect(validate(evt)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
```

The contract file (`additionalProperties: true`, required fields listed, enum values listed, a description for every field's meaning) lives in the producer's repository with the data team as code owners of that directory.

#### PostgreSQL example — reconciliation

Run against a read replica of the source and against the warehouse for the same closed business day, and compare:

```sql
-- Source side (read replica): paid orders and revenue for one closed business day
SELECT count(*) AS orders, sum(total_cents) AS gross_cents
  FROM orders
 WHERE paid_at >= TIMESTAMPTZ '2026-11-04 00:00:00+05:30'
   AND paid_at <  TIMESTAMPTZ '2026-11-05 00:00:00+05:30'
   AND status IN ('paid', 'shipped', 'delivered', 'refunded', 'partially_refunded');
```

The reconciliation job stores both results in a `recon_results` table and alerts when `abs(source - warehouse) / source > 0.001`. It runs for day minus 1 and again for day minus 7, so late changes are checked too.

#### How it works — erasure across stores

| Store | Mechanism | Gotcha |
|---|---|---|
| Production PostgreSQL | Delete or anonymize rows; emit `customer.erased` via the outbox | Foreign keys from orders you must keep for tax law: anonymize, do not delete |
| Kafka topics | Compacted topics keyed by customer: write a tombstone. Others: retention expiry | A 7-day retention topic still holds PII for 7 days; document it |
| Warehouse | `DELETE` or `UPDATE ... SET email = NULL` by `customer_key`, driven by the erasure event | Snapshots and time travel (Snowflake Time Travel, BigQuery time travel) keep old data for days |
| Iceberg lake | `DELETE FROM lake.orders_cdc WHERE customer_key = ...`, then expire snapshots | Old snapshots and orphan files still contain the row until expired |
| Backups | Cannot be edited; keep an erasure log and re-apply after any restore | Retention period must be documented in the privacy policy |

For data you cannot rewrite cheaply, **crypto-shredding** helps: encrypt each customer's PII fields with a per-customer key held in a key service (see Part 40 — Security, 40.16), store only ciphertext everywhere downstream, and erase by deleting the key. Every copy, including backups and old lake snapshots, becomes unreadable at once. The cost is a key lookup on every read of PII, which is a good incentive to keep PII out of analytics in the first place.

#### Edge cases & failure modes

- **Compatibility mode set too late.** A subject created with `NONE` already contains incompatible versions; `_TRANSITIVE` checks then fail on the next change. Set modes when topics are created.
- **Contract tests on a fixture, not the real builder.** A test that validates a hand-written JSON sample proves nothing; validate the output of the code that builds the event.
- **Reconciliation on different definitions.** Source counts `paid_at` in UTC, warehouse in local time: a permanent false mismatch that trains people to ignore the alert.
- **Erasure event lost.** Treat erasure as a tracked workflow with per-store completion status, not a fire-and-forget event.

#### Interview questions

1. **What do `BACKWARD` and `FORWARD` compatibility mean, and which order of deployment does each allow?** Backward: new readers can read old data, so upgrade consumers first. Forward: old readers can read new data, so producers can upgrade first. Full allows either.
2. **How would you prove an erasure reached the warehouse and lake?** A per-request workflow record with completion per store, verification queries that return zero rows for the customer key, and snapshot expiry after the lake delete.
3. **What is crypto-shredding?** Encrypting a person's data with a per-person key and erasing by deleting the key, which makes every copy, including backups, unreadable.

#### Practical exercise

Add a JSON Schema contract and the Jest contract test to an order service; set `FULL_TRANSITIVE` on the subject; then try to rename `total_cents` and confirm both the test and the registry reject it. Implement an erasure workflow table with one row per store and a job that marks each store done only after its verification query returns zero rows. Acceptance criteria: the rename is blocked in CI; an erasure request shows four stores completed, with the Iceberg snapshot expiry recorded.
