# Part 63 — Data Engineering for Backend Engineers

A backend engineer does not need to become a data engineer, but at any company past a certain size the two worlds meet constantly, and the backend engineer who understands the data side is far more effective. The production database you own is the source of the analytics the business runs on; the events you emit are the raw material of the data warehouse; the schema you change can break a dashboard; the GDPR deletion you implement must reach the warehouse too. This Part teaches the data-engineering concepts a backend engineer needs to work well across that boundary: why analytics and transactional workloads must be separated, how data flows from your database into analytics systems, and how to build analytics features into your own product.

The topics: OLTP versus OLAP (why analytics queries hurt your production database), **change data capture** (streaming database changes to other systems), **ETL versus ELT** and batch pipelines, **data warehouses and lakes** (columnar storage, Parquet), **stream processing** (windows, watermarks, late events), **data contracts** between backend and data teams, **data quality**, **privacy in pipelines** (PII masking, deletion propagation), and **building analytics features in the product** (pre-aggregated tables, materialized views, read models). The running example is deriving daily revenue dashboards from the orders database.

This Part builds on the outbox pattern (Part 19), search index sync (Part 34), Kafka (Part 17), partitioning (Part 14) and caching (Part 16), going wider into the data pipeline those feed.

## 63.1 OLTP versus OLAP

### 63.1.1 Why analytics queries hurt the production database

#### Concept

**OLTP** (Online Transaction Processing) is what your production database does: many small, fast reads and writes serving the application — fetch an order, insert a payment, update inventory. **OLAP** (Online Analytical Processing) is analytics: a few large queries that scan huge amounts of data to compute aggregates — total revenue by month, top products by region, cohort retention. These two workloads are so different that running OLAP queries on your OLTP database degrades or crashes the application, which is why analytics belongs in a separate system.

#### Why does it exist?

A transactional database is tuned for OLTP: row-oriented storage, indexes for point lookups, serving thousands of small operations per second with low latency. An analytics query is the opposite: it reads millions of rows, scans whole columns, and runs for seconds or minutes. Run that on the production database and it saturates CPU and I/O, competes with and slows the application's queries, holds locks, blows the cache, and can bring the application down. The separation exists because the two workloads need opposite optimizations and must not fight over the same resources. The distinction drives the entire data pipeline: get analytics off the production database and into a system built for it.

#### Mental model

Your production database is a busy restaurant kitchen during service — a stream of quick orders, each served fast, everyone moving. An OLAP query is someone walking into that kitchen mid-service to do a full monthly inventory count, blocking the stoves and counters for twenty minutes while service grinds to a halt. You do not do inventory in the kitchen during service; you do it in a back room with a copy of the stock records (the warehouse). OLTP is service; OLAP is inventory; they belong in different rooms.

#### How it works — the differences

| | OLTP (production database) | OLAP (analytics system) |
|---|---|---|
| Workload | Many small, fast reads/writes | Few large, scanning queries |
| Query shape | Point lookups, small ranges, by key | Aggregations over millions of rows |
| Storage | Row-oriented (whole rows together) | Column-oriented (whole columns together) |
| Optimized for | Low-latency transactions | High-throughput scans and aggregates |
| Latency | Milliseconds | Seconds to minutes (acceptable) |
| Example | "Get order 1001" | "Total revenue by month for 2 years" |
| Freshness need | Real-time | Minutes to hours old is usually fine |

The heart of it is **row-oriented versus column-oriented storage**. OLTP databases store each row's fields together, so fetching one order reads one place — great for point lookups, bad for "sum one column across ten million rows" (which must read every row to get one field). Analytics systems store each column together, so summing a column reads only that column's contiguous data — great for aggregates, and highly compressible (a column of similar values compresses well). That storage difference is why a dedicated analytics system answers "revenue by month" in a fraction of the time and resources, and why forcing it on the row-oriented OLTP database is so costly.

#### Production scenario

An analyst needed a monthly revenue breakdown and ran a large aggregating query directly against the production orders database during business hours. The query scanned two years of orders, saturated the database's I/O for several minutes, and the application's normal queries slowed from 3 ms to 800 ms — checkout latency spiked and customers noticed. The fix was to stop running analytics on the production database and instead replicate the data to an analytics system where such queries run without touching production. The lesson, learned the hard way at many companies, is that OLAP on the OLTP database is a production incident waiting to happen.

#### Failure scenario

A reporting dashboard was wired directly to the production database, running dozens of aggregating queries every few minutes to refresh its tiles. Under normal load it was tolerable; during a traffic peak, the combination of application load and the dashboard's heavy queries pushed the database past its limits and it fell over, taking the application down with it. The root cause was OLAP and OLTP sharing one database. The fix: move the dashboard's queries to a read replica at minimum (Part 14), and properly to an analytics warehouse fed by the pipeline in the rest of this Part. The lesson: never let analytics queries run against the production transactional database.

#### How a Senior Backend Engineer thinks about this

A senior treats the production transactional database as sacred for OLTP and keeps analytics off it entirely. They recognize an OLAP query — a large scan or aggregation — as something that belongs in a separate analytics system, never on the production primary, and at minimum on a read replica for lighter needs. They understand the row-versus-column storage reason, which is why they do not just "add an index" to make an analytics query fast on the OLTP database (an index helps point lookups, not full-column aggregates). They design the data pipeline (the rest of this Part) to move data from the OLTP source into an OLAP system, so analysts and dashboards get their answers without ever threatening the application. When someone proposes running a report against production, the senior's answer is "not against production — here is the analytics system".

#### Common mistakes

- Running analytics queries against the production transactional database, degrading or crashing the application.
- Wiring a dashboard directly to the production database.
- Trying to make an analytics query fast with indexes on the OLTP database (wrong tool for full-column aggregates).
- Not separating OLTP and OLAP until an incident forces it.

#### Interview questions

1. **What is the difference between OLTP and OLAP?** OLTP is many small fast transactional reads/writes on the production database; OLAP is few large scanning/aggregating analytics queries; they need opposite optimizations and must not share resources.
2. **Why do analytics queries hurt the production database?** They scan millions of rows, saturating CPU and I/O, competing with and slowing the application's transactional queries, and can crash the database.
3. **Why does column-oriented storage help analytics?** Analytics aggregates read whole columns; storing columns contiguously (and compressing them) makes those scans far faster and cheaper than the row-oriented OLTP layout.
4. **Why not just add an index to make an analytics query fast on the OLTP database?** Indexes speed point lookups and small ranges, not full-column aggregates over millions of rows; the fix is a separate analytics system, not an index.

#### Practical exercise

Take an analytics query (monthly revenue over two years) and run `EXPLAIN (ANALYZE, BUFFERS)` against an orders table to see it scan the whole table, noting the cost. Then describe how the same query would run against a column-oriented analytics system and why it would be dramatically cheaper. Acceptance criteria: you can quantify why the OLTP database struggles with the aggregate and explain the column-store advantage.

## 63.2 Change data capture and pipelines

### 63.2.1 Change data capture

#### Concept

**Change Data Capture (CDC)** is streaming every change (insert, update, delete) from your production database to other systems in near real time, by reading the database's internal change log rather than querying tables. It is how data flows reliably from your OLTP database into analytics systems, search indexes, caches and other services, keeping them in sync without burdening the production database with repeated queries.

#### Why does it exist?

Other systems need to know about changes in your database: the analytics warehouse needs new orders, the search index needs updated products (Part 34), a downstream service needs new events. Polling the database ("give me everything changed since last time") is inefficient and can miss changes or burden the database. CDC reads the database's **write-ahead log** (the log the database already keeps for durability and replication, Part 13) and turns each committed change into an event stream, so downstream systems get every change in order, reliably, with minimal load on the source. It exists to propagate changes out of the database the right way.

#### Mental model

Imagine the production database keeps a perfect running journal of everything that happens — every insert, update and delete, in order (it does; this is the write-ahead log). CDC is a reader who tails that journal and broadcasts each entry to everyone who needs to know. The warehouse, the search index and the downstream services all subscribe to the broadcast and apply the changes, staying in step with the database without ever having to interrogate it. The journal is the WAL; the reader-broadcaster is CDC (a tool like Debezium feeding Kafka).

#### How it works

```text
PostgreSQL ---(logical replication / WAL)---> Debezium ---> Kafka topic (order changes)
                                                               |
                          +------------------+-----------------+-----------------+
                          v                  v                 v                 v
                   Analytics warehouse   Search index      Cache invalidation   Other service
                   (Part 63)             (Part 34)          (Part 16)            (Part 5)
```

The common stack: PostgreSQL's **logical replication** exposes committed changes from the WAL; **Debezium** (often via **Kafka Connect**) reads them and publishes a stream of change events to **Kafka** (Part 17); downstream consumers apply the changes to their systems. Each change event describes what changed (the table, the operation, the before/after values), in commit order. Because it reads the log the database already maintains, CDC adds little load to the source and does not miss changes.

**Handling schema changes** is a key CDC concern: when you change the source table's schema (add a column, Part 31), the change stream's shape changes, and downstream consumers must cope. This is a data-contract problem (63.4): schema changes in the source ripple through the pipeline, so they must be made compatibly (additive where possible, Part 32) and coordinated with the data team.

#### CDC versus the outbox pattern

Part 19 taught the **outbox pattern**: write an event to an outbox table in the same transaction as the data change, and a worker publishes it. CDC and the outbox solve related problems and are often combined:

- **Outbox**: you explicitly write a business event ("order placed") in the same transaction; a relay (often CDC reading the outbox table) publishes it. Precise, semantic events you control.
- **CDC on the tables directly**: captures every row change automatically, no code to emit events, but the events are row changes, not business events.

A common robust pattern is CDC reading the outbox table: you get the exactly-once-ish, transaction-safe semantic events of the outbox, delivered by the reliable log-reading mechanism of CDC. The two are complementary, not competing.

#### How a Senior Backend Engineer thinks about this

A senior uses CDC (often with the outbox pattern, Part 19) as the reliable way to get changes out of the database into the rest of the system — warehouse, search, cache, other services — because it reads the WAL the database already keeps, adding minimal load and missing nothing, unlike polling. They treat the change stream as a product with a contract (63.4): downstream systems depend on its shape, so schema changes in the source are made compatibly and coordinated, not sprung on consumers. They design for the stream's realities: it is ordered per source but delivered at least once (so consumers are idempotent, Part 18), and it lags slightly (eventual consistency downstream). They reach for CDC rather than ad-hoc polling or dual writes, because dual writes (write to the database and also to Kafka separately) can diverge if one fails, whereas CDC derives everything from the one committed log.

#### Common mistakes

- Polling tables for changes instead of CDC, burdening the database and risking missed changes.
- Dual writes (to the database and a stream separately) that diverge when one fails; CDC from the single committed log avoids this.
- Making a source schema change that breaks downstream consumers, with no coordination (63.4).
- Non-idempotent consumers of the at-least-once change stream, double-applying changes.

#### Interview questions

1. **What is CDC and why use it over polling?** Streaming database changes by reading the write-ahead log (via Debezium/Kafka); it captures every change in order with minimal load on the source, unlike polling which burdens the database and can miss changes.
2. **How do CDC and the outbox pattern relate?** The outbox writes semantic events in the same transaction as the change; CDC reliably delivers them (often by reading the outbox table via the WAL); combined, you get transaction-safe semantic events delivered reliably.
3. **Why is CDC better than dual writes?** Dual writes (database plus a separate stream) can diverge if one write fails; CDC derives the stream from the single committed log, so it cannot diverge from what was committed.
4. **What must downstream CDC consumers handle?** At-least-once delivery (be idempotent, Part 18), eventual consistency (slight lag), and source schema changes (coordinated, compatible — the data contract).

#### Practical exercise

Describe (or set up) a CDC pipeline from a PostgreSQL orders table through Debezium and Kafka to a downstream consumer, and make the consumer idempotent so re-delivered change events do not double-apply. Then reason about what happens to the consumer when a new column is added to the orders table and how you would make that change compatibly. Acceptance criteria: the consumer handles at-least-once delivery without double-applying, and you can describe a compatible schema-change process for the source.
