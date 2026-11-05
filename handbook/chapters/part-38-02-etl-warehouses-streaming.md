### 38.2.2 ETL, ELT, batch pipelines and orchestration

#### Concept

Data must be moved from sources into the warehouse and transformed into useful shapes. **ETL** (Extract, Transform, Load) transforms data before loading it into the warehouse; **ELT** (Extract, Load, Transform) loads raw data first and transforms it inside the warehouse. These run as **batch pipelines** (scheduled jobs processing data in chunks) coordinated by an **orchestrator** that manages dependencies and schedules as a graph of tasks (a DAG).

#### Why does it exist?

Raw data from many sources is not in a shape ready for analysis — it needs cleaning, joining, aggregating and reshaping. That transformation has to happen somewhere, on a schedule, with dependencies handled (compute daily revenue only after today's orders have loaded), with retries and monitoring. ETL/ELT pipelines and orchestrators exist to do this reliably and repeatedly, so analysts and dashboards work from clean, current, well-shaped data rather than raw source dumps.

#### Mental model

Imagine a juice bar. ETL is peeling and pressing the fruit at the farm and shipping only bottled juice: the shop never sees a whole orange, and if a customer wants a smoothie instead, you are out of luck. ELT is shipping whole fruit to the shop's big refrigerated storeroom and pressing whatever each customer orders on the spot: more storage, but you can always make something new from the same fruit. The orchestrator is the shift manager with the morning checklist: do not press anything until the delivery has been checked in, and if the delivery is late, phone the supplier rather than serve yesterday's juice.

#### How it works — ETL vs ELT

```text
ETL (transform before load):
  Extract from source -> Transform (clean, join, aggregate) -> Load into warehouse
  Transformation happens in a separate processing step.

ELT (load raw, then transform):
  Extract from source -> Load raw into warehouse -> Transform inside the warehouse (SQL)
  Modern cloud warehouses are powerful enough to do the transform themselves.
```

ELT has become common because cloud warehouses are powerful and cheap enough to transform data in place, and loading raw data first means you keep the original and can re-transform it differently later. ETL is still used when transformation must happen before the data lands (for privacy masking, Part 123.5, or when the warehouse should only ever hold processed data). The choice depends on where the transformation power is and whether raw data should enter the warehouse.

#### Orchestration

```text
A DAG (directed acyclic graph) of tasks the orchestrator runs on a schedule:

  [extract orders] --+
                     +--> [compute daily revenue] --> [refresh dashboard tables]
  [extract refunds]--+
                     +--> [compute daily refunds] --+

Each box is a task; arrows are dependencies; the orchestrator (Airflow-style) runs
each task when its dependencies succeed, retries failures, and alerts on problems.
```

An orchestrator (Airflow is the canonical example) defines pipelines as DAGs of tasks with dependencies, runs them on a schedule, retries failed tasks, and alerts on failures. It is the scheduler and dependency manager for the whole data pipeline, ensuring "compute daily revenue" runs only after the day's orders have loaded, and that a failure is retried and surfaced rather than silently producing a wrong dashboard.

Three orchestration ideas matter more than any specific tool:

1. **Each run owns a data interval.** The run for 2026-11-04 processes exactly the orders whose business date is 2026-11-04, no matter when it runs. Airflow calls this the run's logical date and data interval. It is what makes reruns and backfills safe.
2. **Tasks are idempotent.** Running a task twice for the same interval produces the same result: delete-then-insert the partition, or `MERGE` by key, never blind `INSERT`. Section 38.8 shows the SQL.
3. **Backfill is a first-class operation.** When the revenue logic changes, you rerun the last 90 intervals. If the pipeline cannot do that without manual surgery, it is not finished.

#### Production scenario

A mid-sized e-commerce company runs about 140 ELT models in the warehouse, scheduled hourly and nightly. Raw CDC data lands continuously; the nightly DAG starts at 01:30 local time (after the business day closes and late payment captures settle), runs staging models in 6 minutes, fact models in 11 minutes and the finance marts in 4 minutes, and the dashboards are fresh by 02:00 with an SLA of 06:00. Each task retries twice with a 5-minute delay. Warehouse compute for the nightly run costs about $9 per night. The one-off backfill of two years after a revenue-definition change took 3 hours and about $140.

#### Failure scenario

At 07:10 the head of finance asked why yesterday's revenue was 38% lower than the day before. The nightly DAG had succeeded, every task green. The cause was upstream: the extract task had run at 01:30 as scheduled, but the CDC sink was 90 minutes behind because of a Kafka Connect rebalance, so only part of the day's orders had landed. The DAG had no check that its inputs were complete; it computed correct sums over incomplete data. The fix was a sensor-style gate before the revenue model: wait until the raw table contains events with commit timestamps past the end of the interval plus a margin, and fail loudly (not succeed quietly) if that is not true by 05:00. The lesson: a green pipeline only proves the code ran, not that the data was complete. Freshness and completeness checks belong in the DAG as gates.

#### Edge cases & failure modes

- **Non-idempotent loads.** A retried `INSERT` doubles a day's revenue. Overwrite the partition or `MERGE` by key.
- **Time zones.** "Yesterday" in UTC is not yesterday in Asia/Kolkata (UTC+5:30) or America/New_York; define the business day explicitly and convert once, in staging.
- **Late data.** Refunds and chargebacks for an order arrive days or weeks later; models must recompute a trailing window (for example, the last 7 days every night), not just yesterday.
- **Catch-up storms.** A scheduler paused for a week that resumes with catch-up enabled launches 7 runs at once and saturates the warehouse; limit concurrent runs.
- **Upstream schema change.** A dropped source column fails the staging model; a renamed one silently produces nulls (38.4). Test column presence and null rates.
- **Partial success.** Facts updated but marts failed: the dashboard shows a mix. Publish marts atomically (swap a view or table) at the end.

#### How a Senior Backend Engineer thinks about this

A senior understands ETL/ELT and orchestration well enough to collaborate with the data team and to see where their own system fits: the backend emits the events and exposes the source data (via CDC) that the pipelines consume, and a change to the source schema or event shape ripples through those pipelines (the data contract, 38.4). They favor ELT with modern warehouses where it fits, keeping raw data for re-transformation, but reach for ETL when transformation must precede loading (privacy masking especially). They know pipelines are batch jobs with dependencies, retries and monitoring, and that a silently failed pipeline produces a wrong dashboard, so freshness and success monitoring matter (38.4). They do not need to own Airflow, but they need to know that their schema change can break a DAG and coordinate accordingly.

#### Common mistakes

- Changing a source schema or event shape without considering the downstream pipelines it feeds.
- No orchestration, so pipeline dependencies, retries and failures are handled ad hoc.
- Silent pipeline failures producing wrong dashboards with no alert.
- Transforming away raw data when keeping it (ELT) would allow re-transformation later.

#### Interview questions

1. **What is the difference between ETL and ELT?** ETL transforms before loading into the warehouse; ELT loads raw data and transforms inside the warehouse. ELT is common with powerful cloud warehouses and keeps raw data for re-transformation; ETL suits cases where transformation must precede loading (e.g. privacy masking).
2. **What does an orchestrator like Airflow do?** Defines pipelines as DAGs of dependent tasks, schedules and runs them, retries failures, and alerts — managing dependencies so tasks run in the right order.
3. **Why does a backend engineer care about data pipelines?** The backend's source data and events feed them; a source schema or event change ripples through the pipelines, so it must be coordinated (the data contract).

#### Practical exercise

Sketch a daily revenue pipeline as a DAG: extract orders and refunds, compute daily revenue and refunds, then refresh dashboard tables, with dependencies and a failure alert. Decide whether to use ETL or ELT and justify it. Acceptance criteria: the DAG expresses the dependencies correctly, has retries and a failure alert, and you can justify the ETL/ELT choice.

## 38.3 Data warehouses, lakes and stream processing

### 38.3.1 Warehouses, lakes and columnar storage

#### Concept

A **data warehouse** is a system built for OLAP: it stores large volumes of structured data in columnar format and answers analytical queries fast (BigQuery, Redshift, Snowflake are examples). A **data lake** stores large volumes of raw data (often as files in object storage, in formats like **Parquet**) cheaply and flexibly, for processing later. Both use **columnar storage** and **partitioning** to make scanning huge datasets efficient. They are where analytics data lives, separate from the OLTP database.

#### Why does it exist?

Analytics needs to store and query far more data than the production database should hold, in a format optimized for scanning and aggregation, cheaply. A warehouse exists to answer analytical queries fast over large structured data. A lake exists to store vast amounts of raw or semi-structured data cheaply (often cheaper than a warehouse) before it is necessarily structured, keeping the option to process it many ways later. Together they hold the organization's analytical data at a scale and cost the OLTP database never could, optimized for the OLAP workload (38.1).

#### Mental model

Imagine a library. The production database is the circulation desk: fast at "give me this one book". The data lake is the basement archive: everything ever printed, in labelled boxes, cheap to keep, slow to browse unless you know which box to open. The warehouse is the reference room: curated, indexed by subject, built for someone who wants to read across many books at once. Partitioning is writing the year on every box so you never open the 2019 boxes when you want 2026.

#### How it works — columnar storage and Parquet

The common thread is **columnar storage** (38.1): data stored by column rather than row, so an aggregate reads only the columns it needs and compresses well (a column of similar values compresses far better than mixed rows). **Parquet** is the standard columnar file format for data lakes — a compressed, columnar, self-describing file that warehouses and processing engines read efficiently. **Partitioning** (by date, region, etc.) means a query filtered on the partition key reads only the relevant files, not the whole dataset — the same partition-pruning idea as PostgreSQL partitioning (see Part 22 — Database Scaling, 22.7) and TimescaleDB (see Part 25 — NoSQL Data Modelling, 25.5), applied to warehouse and lake data.

```text
Warehouse / lake efficiency comes from:
  Columnar storage  -> read only the columns the query needs, compress well
  Parquet format     -> compressed, columnar, self-describing files (lakes)
  Partitioning       -> query filtered on partition key reads only relevant files

A "revenue by month, 2 years" query reads just the revenue and date columns,
only the relevant date partitions, compressed -> fast and cheap, unlike the OLTP scan.
```

Warehouse concepts (BigQuery, Redshift, Snowflake) differ in details (serverless vs cluster, pricing models) but share the columnar, scan-optimized, scalable OLAP design. A backend engineer does not need to run one but should understand that it is where analytics data goes and why it answers big aggregates cheaply. Section 38.9 shows real DDL for each and the pricing that shapes how you write queries.

#### Production scenario

A company with 5 years of orders (about 700 million order rows and 2.1 billion order-item rows) keeps raw CDC data in S3 as Parquet, roughly 1.4 TB compressed, at about $0.023 per GB-month, so around $32 a month for storage. The warehouse holds modelled tables of about 600 GB. A "revenue by month by country, last two years" query on a table partitioned by order date and clustered by country reads about 6 GB and returns in 3 seconds. The same query without the partition filter (someone wrote `WHERE extract(year from created_at) >= 2024`, which hides the partition column inside a function on some engines) read 180 GB. Under a per-byte pricing model, that one habit is a 30x cost difference on every run.

#### Failure scenario

A data engineer added a dashboard tile with an unpartitioned query against a 2 TB events table and set it to refresh every 15 minutes. Under on-demand per-byte pricing, each refresh scanned the whole table, 96 refreshes a day, and the month's bill arrived $36,000 higher than usual. Nothing was broken in the usual sense; the dashboard was correct. The fixes: require a partition filter on the large tables (BigQuery supports `require_partition_filter`), set a per-query bytes-billed cap for dashboard service accounts, and alert on daily spend. The lesson: in a warehouse, a bad query costs money rather than latency, and nobody gets paged for money unless you build the alert.

#### Edge cases & failure modes

- **Small files.** A sink writing one Parquet file per second produces millions of tiny files; every query pays per-file overhead. Compact into files of 128 MB to 1 GB.
- **Partition skew.** Partitioning by `customer_id` puts one enterprise customer in one giant partition; partition by date and cluster by customer instead.
- **Updates and deletes in a lake.** Plain Parquet files are immutable; a GDPR deletion means rewriting files. Table formats such as Apache Iceberg or Delta Lake add row-level deletes and snapshots (38.9).
- **Schema drift in files.** Old files lack a new column; readers must treat it as null, not fail.
- **Copy sprawl.** The same data copied into five marts by five teams, each slightly different; one revenue number becomes five.

#### How a Senior Backend Engineer thinks about this

A senior knows the warehouse/lake is the right home for analytics data — columnar, partitioned, scan-optimized, scalable, and separate from the OLTP database — and that getting data there (via CDC and pipelines, 38.2) is how analytics stays off production. They understand columnar storage and partitioning as the reasons big aggregates are cheap there and expensive on the row-oriented OLTP database. They treat the data they send into the warehouse (through events and CDC) as feeding this system, with a contract (38.4) and privacy obligations (38.5). They do not over-engineer: for a small product, pre-aggregated tables or materialized views in PostgreSQL (38.6) may suffice, and a full warehouse is adopted when analytics scale and needs justify it.

#### Common mistakes

- Keeping analytics data in the OLTP database instead of a warehouse/lake, degrading production.
- Ignoring partitioning, so warehouse queries scan everything.
- Adopting a full warehouse before the scale justifies it, when materialized views in PostgreSQL would do (38.6).

#### Interview questions

1. **What is a data warehouse and how does it differ from the OLTP database?** A columnar, scan-optimized, scalable system for OLAP analytics queries, separate from the row-oriented OLTP database, so analytics runs fast and off production.
2. **What is a data lake and what is Parquet?** A cheap store for large raw/semi-structured data (often files in object storage); Parquet is the standard compressed columnar file format lakes use.
3. **Why does columnar storage plus partitioning make big aggregates cheap?** Aggregates read only the needed columns (compressed), and partitioning limits the query to relevant partitions, versus scanning whole rows across the entire dataset.

#### Practical exercise

Explain how a "revenue by month over two years" query runs against a columnar, partitioned warehouse versus the row-oriented OLTP database, identifying what columns and partitions it reads and why it is cheap. Then decide, for a small product, whether a full warehouse is warranted or whether PostgreSQL materialized views (38.6) would suffice. Acceptance criteria: you can explain the columnar/partitioning advantage and make a right-sized build decision.

### 38.3.2 Stream processing: windows, watermarks and late events

#### Concept

**Stream processing** computes results continuously over an unbounded stream of events as they arrive, rather than in scheduled batches. Its core concepts are **windows** (grouping events by time — "revenue per 1-minute window"), **watermarks** (a signal of how far event time has progressed, used to decide when a window is complete), and handling **late events** (events that arrive after their window was thought complete). Kafka Streams and Flink are the common tools.

#### Why does it exist?

Some analytics must be real-time or near-real-time: live dashboards, fraud detection, metrics aggregation, alerting. Batch pipelines (38.2) run on a schedule and produce results minutes or hours later, which is too slow for these. Stream processing exists to compute continuously as events flow, so a count or aggregate is up to date within seconds. The challenge is that events arrive out of order and sometimes late (a mobile device was offline and sends its events an hour later), so the processing must decide when a time window is "done" despite stragglers — which is what watermarks and late-event handling address.

#### Mental model

Imagine counting people entering a venue in 1-minute buckets using a live feed. Events (entries) arrive roughly in order but not perfectly — someone's badge scan is delayed and arrives late. A **window** is each 1-minute bucket. A **watermark** is your judgment "it is now 10:05, and I believe all 10:00-10:01 entries have arrived, so I can finalize that bucket." A **late event** is a 10:00 scan that shows up at 10:07 after you finalized the bucket — you must decide whether to update the finalized count or drop the straggler. Stream processing is doing this bucketing-and-finalizing continuously and correctly despite disorder and lateness.

#### How it works

```text
Event stream (order events, out of order by a few seconds):
  ... t=10:00:58  t=10:01:02  t=10:00:59 (out of order)  t=10:01:05 ...

Windowing: group events into time windows by EVENT time (when it happened),
           not processing time (when it arrived).
Watermark:  "event time has reached 10:02" -> windows up to ~10:01 can be finalized.
Late event: a 10:00 event arriving after the 10:00-10:01 window closed -> either
            update the result (if allowed lateness covers it) or drop/side-output it.
Stateful:   the processor keeps per-window state (running counts) until finalized.
```

Key distinctions: **event time** (when the event actually happened) versus **processing time** (when it was processed) — correct analytics use event time, because that is the truth. Watermarks let the processor decide a window is complete despite out-of-order arrival. **Allowed lateness** gives a grace period to incorporate stragglers; events later than that are dropped or side-outputted for separate handling. **Stateful processing** means the processor holds window state (running aggregates) in memory/state store until the window is finalized, which must survive failures (checkpointing).

#### Production scenario

A live orders-per-minute dashboard consumes the order event stream with 1-minute tumbling windows by event time. A watermark with a 30-second allowed lateness lets most out-of-order and slightly-late events land in the correct window, and the dashboard updates within seconds of events occurring. A handful of very late events (from devices that were offline) exceed the allowed lateness and are routed to a side output for a separate reconciliation step (38.4), so they are not lost, just not in the live window. The result is a near-real-time dashboard that is correct for the overwhelming majority of events and does not silently drop stragglers.

#### Failure scenario

On Black Friday at 18:02 the live orders-per-minute chart froze at 17:48 while orders were clearly flowing (the checkout dashboard showed 900 orders a minute). The stream job was healthy and consuming. The cause was the watermark: the input topic had 12 partitions, and after a producer change, all orders were keyed by region, and two regions had almost no traffic in the evening. A watermark in Flink advances only as fast as the slowest input partition, so two idle partitions held event time at 17:48 and no window could close. The fix was to declare idleness on the watermark strategy (`withIdleness` on Flink's `WatermarkStrategy`, or the `table.exec.source.idle-timeout` setting in Flink SQL) so idle partitions stop holding back the watermark, plus an alert on "watermark lag" (wall clock minus watermark). The lesson: windows close on event time, not on wall time, and event time is only as fresh as the quietest input.

#### Edge cases & failure modes

- **Idle partitions stall the watermark** (the story above).
- **Clock skew on producers.** A device with its clock an hour ahead creates events "from the future" that push the watermark forward and make everyone else's events late. Clamp or reject event times far from ingestion time.
- **Replays and reprocessing.** Restarting from an old offset replays a day of events in minutes; event-time windows give the same answer, processing-time windows do not.
- **State growth.** Session windows or joins without a time bound keep state forever; set state TTL or bound the join interval.
- **Exactly-once boundaries.** Kafka transactions give exactly-once inside Kafka; writing results to PostgreSQL or Redis still needs idempotent upserts keyed by window.
- **Rebalancing.** When a Kafka Streams instance joins or leaves, its state stores must be restored from changelog topics, which can take minutes for large state; standby replicas shorten that.

#### How a Senior Backend Engineer thinks about this

A senior reaches for stream processing when analytics genuinely need near-real-time results (live dashboards, fraud, alerting) and accepts the added complexity (state, watermarks, late events, exactly-once semantics) that batch does not have. They process by event time, not processing time, because event time is the truth; they tune allowed lateness to the business's tolerance for stragglers versus freshness; and they never silently drop late events without a reconciliation path, because dropped events mean undercounting. They know stream processing is harder to get exactly right than batch (the exactly-once and late-event problems are genuinely subtle), so they use it only when real-time is required and fall back to batch for everything that can tolerate a schedule. The decision, as always, is driven by the requirement (does this need to be real-time?), not by novelty.

#### Common mistakes

- Processing by arrival time instead of event time, producing wrong window results.
- Dropping late events silently, undercounting without a reconciliation path.
- No watermark/allowed-lateness tuning, either finalizing windows too early (miss events) or too late (stale results).
- Using stream processing for analytics that could be batch, taking on needless complexity.
- Ignoring state recovery, so a processor crash loses in-flight window aggregates.

#### Interview questions

1. **What are windows, watermarks and late events in stream processing?** Windows group events by (event) time; watermarks signal how far event time has progressed so a window can be finalized; late events arrive after their window closed and must be incorporated (within allowed lateness) or handled separately.
2. **Why process by event time rather than processing time?** Event time is when things actually happened, which is the correct basis for analytics; processing time depends on arrival order and delays and gives wrong results.
3. **How do you handle late events without losing data?** Allow a grace period (allowed lateness) to include them, and route events later than that to a side output for reconciliation rather than silently dropping them.
4. **When do you choose stream processing over batch?** When near-real-time results are genuinely required (live dashboards, fraud, alerting); otherwise batch is simpler and sufficient.

#### Practical exercise

Design a near-real-time orders-per-minute aggregation using tumbling windows by event time, a watermark with an allowed-lateness grace period, and a side output for events too late to include. Explain what happens to an event that is 10 seconds late versus one that is 10 minutes late. Acceptance criteria: windows use event time, in-grace late events land correctly, and very late events are reconciled rather than silently dropped.
