### 63.2.2 ETL, ELT, batch pipelines and orchestration

#### Concept

Data must be moved from sources into the warehouse and transformed into useful shapes. **ETL** (Extract, Transform, Load) transforms data before loading it into the warehouse; **ELT** (Extract, Load, Transform) loads raw data first and transforms it inside the warehouse. These run as **batch pipelines** (scheduled jobs processing data in chunks) coordinated by an **orchestrator** that manages dependencies and schedules as a graph of tasks (a DAG).

#### Why does it exist?

Raw data from many sources is not in a shape ready for analysis — it needs cleaning, joining, aggregating and reshaping. That transformation has to happen somewhere, on a schedule, with dependencies handled (compute daily revenue only after today's orders have loaded), with retries and monitoring. ETL/ELT pipelines and orchestrators exist to do this reliably and repeatedly, so analysts and dashboards work from clean, current, well-shaped data rather than raw source dumps.

#### How it works — ETL vs ELT

```text
ETL (transform before load):
  Extract from source -> Transform (clean, join, aggregate) -> Load into warehouse
  Transformation happens in a separate processing step.

ELT (load raw, then transform):
  Extract from source -> Load raw into warehouse -> Transform inside the warehouse (SQL)
  Modern cloud warehouses are powerful enough to do the transform themselves.
```

ELT has become common because cloud warehouses are powerful and cheap enough to transform data in place, and loading raw data first means you keep the original and can re-transform it differently later. ETL is still used when transformation must happen before the data lands (for privacy masking, Part 63.5, or when the warehouse should only ever hold processed data). The choice depends on where the transformation power is and whether raw data should enter the warehouse.

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

#### How a Senior Backend Engineer thinks about this

A senior understands ETL/ELT and orchestration well enough to collaborate with the data team and to see where their own system fits: the backend emits the events and exposes the source data (via CDC) that the pipelines consume, and a change to the source schema or event shape ripples through those pipelines (the data contract, 63.4). They favor ELT with modern warehouses where it fits, keeping raw data for re-transformation, but reach for ETL when transformation must precede loading (privacy masking especially). They know pipelines are batch jobs with dependencies, retries and monitoring, and that a silently failed pipeline produces a wrong dashboard, so freshness and success monitoring matter (63.4). They do not need to own Airflow, but they need to know that their schema change can break a DAG and coordinate accordingly.

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

## 63.3 Data warehouses, lakes and stream processing

### 63.3.1 Warehouses, lakes and columnar storage

#### Concept

A **data warehouse** is a system built for OLAP: it stores large volumes of structured data in columnar format and answers analytical queries fast (BigQuery, Redshift, Snowflake are examples). A **data lake** stores large volumes of raw data (often as files in object storage, in formats like **Parquet**) cheaply and flexibly, for processing later. Both use **columnar storage** and **partitioning** to make scanning huge datasets efficient. They are where analytics data lives, separate from the OLTP database.

#### Why does it exist?

Analytics needs to store and query far more data than the production database should hold, in a format optimized for scanning and aggregation, cheaply. A warehouse exists to answer analytical queries fast over large structured data. A lake exists to store vast amounts of raw or semi-structured data cheaply (often cheaper than a warehouse) before it is necessarily structured, keeping the option to process it many ways later. Together they hold the organization's analytical data at a scale and cost the OLTP database never could, optimized for the OLAP workload (63.1).

#### How it works — columnar storage and Parquet

The common thread is **columnar storage** (63.1): data stored by column rather than row, so an aggregate reads only the columns it needs and compresses well (a column of similar values compresses far better than mixed rows). **Parquet** is the standard columnar file format for data lakes — a compressed, columnar, self-describing file that warehouses and processing engines read efficiently. **Partitioning** (by date, region, etc.) means a query filtered on the partition key reads only the relevant files, not the whole dataset — the same partition-pruning idea as PostgreSQL partitioning (Part 14) and TimescaleDB (Part 62), applied to warehouse and lake data.

```text
Warehouse / lake efficiency comes from:
  Columnar storage  -> read only the columns the query needs, compress well
  Parquet format     -> compressed, columnar, self-describing files (lakes)
  Partitioning       -> query filtered on partition key reads only relevant files

A "revenue by month, 2 years" query reads just the revenue and date columns,
only the relevant date partitions, compressed -> fast and cheap, unlike the OLTP scan.
```

Warehouse concepts (BigQuery, Redshift, Snowflake) differ in details (serverless vs cluster, pricing models) but share the columnar, scan-optimized, scalable OLAP design. A backend engineer does not need to run one but should understand that it is where analytics data goes and why it answers big aggregates cheaply.

#### How a Senior Backend Engineer thinks about this

A senior knows the warehouse/lake is the right home for analytics data — columnar, partitioned, scan-optimized, scalable, and separate from the OLTP database — and that getting data there (via CDC and pipelines, 63.2) is how analytics stays off production. They understand columnar storage and partitioning as the reasons big aggregates are cheap there and expensive on the row-oriented OLTP database. They treat the data they send into the warehouse (through events and CDC) as feeding this system, with a contract (63.4) and privacy obligations (63.5). They do not over-engineer: for a small product, pre-aggregated tables or materialized views in PostgreSQL (63.6) may suffice, and a full warehouse is adopted when analytics scale and needs justify it.

#### Common mistakes

- Keeping analytics data in the OLTP database instead of a warehouse/lake, degrading production.
- Ignoring partitioning, so warehouse queries scan everything.
- Adopting a full warehouse before the scale justifies it, when materialized views in PostgreSQL would do (63.6).

#### Interview questions

1. **What is a data warehouse and how does it differ from the OLTP database?** A columnar, scan-optimized, scalable system for OLAP analytics queries, separate from the row-oriented OLTP database, so analytics runs fast and off production.
2. **What is a data lake and what is Parquet?** A cheap store for large raw/semi-structured data (often files in object storage); Parquet is the standard compressed columnar file format lakes use.
3. **Why does columnar storage plus partitioning make big aggregates cheap?** Aggregates read only the needed columns (compressed), and partitioning limits the query to relevant partitions, versus scanning whole rows across the entire dataset.

#### Practical exercise

Explain how a "revenue by month over two years" query runs against a columnar, partitioned warehouse versus the row-oriented OLTP database, identifying what columns and partitions it reads and why it is cheap. Then decide, for a small product, whether a full warehouse is warranted or whether PostgreSQL materialized views (63.6) would suffice. Acceptance criteria: you can explain the columnar/partitioning advantage and make a right-sized build decision.

### 63.3.2 Stream processing: windows, watermarks and late events

#### Concept

**Stream processing** computes results continuously over an unbounded stream of events as they arrive, rather than in scheduled batches. Its core concepts are **windows** (grouping events by time — "revenue per 1-minute window"), **watermarks** (a signal of how far event time has progressed, used to decide when a window is complete), and handling **late events** (events that arrive after their window was thought complete). Kafka Streams and Flink are the common tools.

#### Why does it exist?

Some analytics must be real-time or near-real-time: live dashboards, fraud detection, metrics aggregation, alerting. Batch pipelines (63.2) run on a schedule and produce results minutes or hours later, which is too slow for these. Stream processing exists to compute continuously as events flow, so a count or aggregate is up to date within seconds. The challenge is that events arrive out of order and sometimes late (a mobile device was offline and sends its events an hour later), so the processing must decide when a time window is "done" despite stragglers — which is what watermarks and late-event handling address.

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

A live orders-per-minute dashboard consumes the order event stream with 1-minute tumbling windows by event time. A watermark with a 30-second allowed lateness lets most out-of-order and slightly-late events land in the correct window, and the dashboard updates within seconds of events occurring. A handful of very late events (from devices that were offline) exceed the allowed lateness and are routed to a side output for a separate reconciliation step (63.4), so they are not lost, just not in the live window. The result is a near-real-time dashboard that is correct for the overwhelming majority of events and does not silently drop stragglers.

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
