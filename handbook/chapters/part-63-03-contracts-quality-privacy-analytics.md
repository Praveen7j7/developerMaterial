## 63.4 Data contracts and data quality

### 63.4.1 Contracts between backend and data teams, and data quality

#### Concept

A **data contract** is an agreement about the shape, meaning and guarantees of the data one team produces for another — specifically, the events and source data the backend team produces that the data team consumes. **Data quality** is ensuring that data is correct, complete, fresh and consistent, through validation, reconciliation and freshness checks. Together they keep the pipeline from silently producing wrong analytics.

#### Why does it exist?

The data team builds dashboards and models on the events and tables the backend team produces. When the backend changes an event's shape, renames a field, changes a field's meaning, or stops emitting an event, the data team's pipelines break or — worse — silently produce wrong numbers. Without a contract, these changes happen unannounced and break analytics. Without data quality checks, bad or missing data flows through and the dashboard is confidently wrong. Data contracts and quality exist because analytics is only as trustworthy as the data feeding it, and that data comes from systems other teams change.

#### Mental model

The backend team is a supplier and the data team is a customer who builds products (dashboards, models) from the supplier's parts (events). A data contract is the specification sheet for those parts: this event has these fields with these types and this meaning, emitted under these conditions, and we will not change it without notice. Without the spec, the supplier changes a part's dimensions one day and the customer's product breaks on the assembly line, or worse, ships subtly defective. Data quality is the incoming inspection: checking the parts are correct, complete and fresh before building on them.

#### How it works — data contracts

A data contract treats events and shared data as products with a published, versioned schema and guarantees:

- **Schema and types**: the exact fields, types and structure of each event (an `order.placed` event has these fields).
- **Meaning (semantics)**: what each field means (`total_cents` is the amount charged including tax, in cents) — ambiguity here causes wrong analytics even with a correct schema.
- **Guarantees**: delivery semantics (at least once), ordering, freshness, and that the producer will not make breaking changes without coordination.
- **Change process**: schema changes are additive and backward-compatible where possible (Part 32), breaking changes are versioned and coordinated, and the data team is notified — the same compatibility discipline as any API, because an event stream is an API between teams.

Treating events as data products with contracts is the practice that prevents "the backend renamed a field and the revenue dashboard silently went to zero". The event schema is as much a contract as a REST or gRPC API (Part 32, Part 61), and changing it carelessly breaks consumers.

#### How it works — data quality

```text
Data quality dimensions and checks:
  Validity      -> does the data match the expected schema and value rules?
  Completeness  -> are all expected records present (no missing days/events)?
  Freshness     -> is the data recent enough? (a freshness SLA: warehouse < 1h behind)
  Consistency   -> does it reconcile with the source? (warehouse revenue == source revenue)

Reconciliation: periodically compare a derived total against the source of truth
  (e.g. daily: does the warehouse's order count match the production database's?)
  -> catches silent data loss or double-counting in the pipeline.
```

**Reconciliation** is the most important data-quality practice: periodically compare a derived figure (the warehouse's daily revenue) against the source of truth (the production database's daily revenue) and alert on a mismatch. This catches the silent failures — a pipeline that dropped some events, a double-count from a non-idempotent consumer, a stuck job — that otherwise produce a wrong dashboard nobody questions. **Freshness SLAs** ("the warehouse is never more than an hour behind") detect a stalled pipeline. **Validation** at ingestion rejects malformed data before it corrupts the warehouse.

#### Failure scenario (connecting to a reconciliation catch)

A backend deploy renamed an order event field from `amount` to `total_cents` without notifying the data team or versioning the event. The warehouse pipeline, expecting `amount`, silently recorded null revenue for new orders, and the revenue dashboard quietly flattened. Because there was a reconciliation job comparing warehouse daily revenue against the production database daily revenue, the mismatch alerted within a day, and the cause (the unannounced field rename) was found quickly. Without reconciliation, the wrong dashboard could have driven business decisions for weeks. The fixes: a data contract requiring compatible, coordinated event changes, and reconciliation as a standing safety net. The lesson: event schemas are contracts between teams, and reconciliation is the backstop that catches the contract violations and pipeline failures that slip through.

#### How a Senior Backend Engineer thinks about this

A senior treats the events and source data their system produces as data products with contracts, knowing the data team builds on them: they version event schemas, make changes compatibly and coordinate breaking ones (Part 32), and document each field's meaning, because an unannounced field rename or a changed meaning silently breaks analytics. They champion reconciliation — comparing derived figures against the source of truth — as the essential backstop that catches silent pipeline failures, because a wrong dashboard that nobody questions is more dangerous than a crashed one. They set freshness SLAs and validate data at ingestion. In short, they extend the API-compatibility and data-integrity discipline they apply to their own system across the team boundary into the data pipeline, because analytics is only as trustworthy as the data and that data is their responsibility too.

#### Common mistakes

- Changing event shape or field meaning without a contract or coordination, silently breaking analytics.
- No reconciliation, so silent data loss or double-counting produces a wrong dashboard unnoticed.
- No freshness SLA, so a stalled pipeline serves stale data as if current.
- Ambiguous field semantics, so the same field is interpreted differently by producer and consumer.
- Treating event streams casually rather than as contracts (they are APIs between teams).

#### Interview questions

1. **What is a data contract and why does it matter?** An agreement on the shape, meaning and guarantees of data one team produces for another; it prevents unannounced changes (renames, meaning changes, dropped events) from silently breaking the consumer's analytics — an event stream is an API between teams.
2. **What is reconciliation and why is it the key data-quality practice?** Periodically comparing a derived figure (warehouse revenue) against the source of truth (production revenue) and alerting on mismatch; it catches silent pipeline failures (data loss, double-counting) that produce confidently wrong dashboards.
3. **What are the dimensions of data quality?** Validity (matches schema/rules), completeness (no missing records), freshness (recent enough, per an SLA), and consistency (reconciles with the source).
4. **Why treat an event schema like an API contract?** Downstream pipelines depend on it; changing it carelessly breaks them, so it needs versioning, compatible changes and coordination (Part 32).

#### Practical exercise

Write a data contract for an `order.placed` event (fields, types, meanings, delivery and freshness guarantees, and the change process). Then design a reconciliation job that compares the warehouse's daily revenue against the production database's and alerts on a mismatch beyond a small tolerance. Acceptance criteria: the contract documents field meanings and a compatible-change process, and the reconciliation job would catch a silent field-rename-induced revenue drop.

## 63.5 Privacy in data pipelines

### 63.5.1 PII masking and deletion propagation

#### Concept

Personal data (PII) flows from the production database into the warehouse, lake and analytics systems, so privacy obligations follow it. **PII masking** removes or obscures personal data in the pipeline so analytics does not hold more than it needs. **Deletion propagation** ensures that when a user exercises their right to erasure (GDPR, Part 22, Part 58), the deletion reaches every copy of their data — including the warehouse and lake — not just the production database.

#### Why does it exist?

A user's personal data does not live only in the production database; the pipeline copies it into the warehouse, the lake, backups and analytics tables. Privacy regulations (GDPR, and others) require that you hold personal data only as needed and delete it on request everywhere. If deletion only clears the production database and leaves the data in the warehouse, you are non-compliant and the data persists where you may not even realize. Masking reduces how much PII enters analytics in the first place; deletion propagation ensures erasure is complete. These exist because privacy obligations apply to every copy of the data, and the pipeline makes many copies.

#### How it works

```text
PII masking in the pipeline (ETL-style transform before loading analytics):
  Source: { user_id, email, name, order_total }
  Masked: { user_id_hash, order_total }   -- drop email/name, hash the id for analytics
  -> analytics gets what it needs (per-user aggregation via the hash) without raw PII.

Deletion propagation on a GDPR erasure request:
  User requests deletion
    -> delete from production database (the source)
    -> emit a deletion event (outbox/CDC) -> pipeline deletes/anonymizes in the warehouse,
       the lake, derived tables, and triggers backup handling per policy
  -> the user's data is gone from EVERY store, not just production.
```

**Masking** happens in the pipeline (an ETL transform, 63.2, or at ingestion): drop fields analytics does not need (email, name), and where per-user analysis is needed, use a hashed or pseudonymous id rather than raw identifiers. This minimizes PII in the warehouse, reducing both risk and compliance scope. **Deletion propagation** means a deletion request must fan out to every store: the deletion event (via outbox/CDC, 63.2) reaches the warehouse, lake and derived tables so the user's data is erased or anonymized everywhere, with a documented process for backups (which cannot always be edited, so policy covers their retention and re-deletion on restore). The key realization is that deleting from production is necessary but not sufficient — the pipeline's copies must be handled too.

#### How a Senior Backend Engineer thinks about this

A senior treats PII as flowing through the whole pipeline, not sitting only in production, so privacy obligations follow it everywhere. They mask or drop PII as early in the pipeline as possible (data minimization), sending analytics only the pseudonymous ids and fields it actually needs, which shrinks both risk and the compliance scope of the warehouse. They design deletion propagation so a GDPR erasure fans out via the pipeline to every store (warehouse, lake, derived tables, with a backup policy), because deleting only from production leaves personal data lingering where regulators and users expect it gone. They coordinate this with the data team as part of the data contract (63.4), since privacy is a shared responsibility across the pipeline. This is the Part 22 and Part 58 privacy discipline extended into the data-engineering world.

#### Common mistakes

- Deleting PII only from the production database, leaving it in the warehouse, lake and derived tables (non-compliant).
- Sending raw PII into analytics that only needs aggregates, inflating risk and compliance scope.
- No deletion-propagation mechanism, so erasure requests cannot be fully honored.
- Ignoring backups in the deletion policy.
- Treating privacy as production-only rather than pipeline-wide.

#### Interview questions

1. **Why must a GDPR deletion reach the data warehouse, not just the production database?** The pipeline copies personal data into the warehouse, lake and derived tables; erasure must remove it everywhere, or you are non-compliant and the data persists.
2. **What is PII masking in a pipeline and why do it?** Dropping or obscuring personal fields (use a hashed/pseudonymous id, drop email/name) as early as possible, so analytics gets what it needs without raw PII — data minimization that reduces risk and compliance scope.
3. **How do you propagate a deletion across the pipeline?** Emit a deletion event (outbox/CDC) that fans out to the warehouse, lake and derived tables to delete or anonymize the data, with a documented policy for backups.

#### Practical exercise

Design the PII handling for an analytics pipeline: specify which fields of an order/user are masked or dropped before loading into the warehouse (using a pseudonymous id for per-user analysis), and design a deletion-propagation flow so a user's erasure request removes their data from production, the warehouse and derived tables. Acceptance criteria: analytics receives no raw PII it does not need, and a deletion request provably reaches every store, with a stated backup policy.

## 63.6 Building analytics features in the product

### 63.6.1 Pre-aggregated tables, materialized views and read models

#### Concept

Not all analytics needs a warehouse; often the product itself must show aggregated data — a seller's dashboard, a user's spending summary, counts and trends in the app. For these, you build analytics features inside your own system using **pre-aggregated tables** (summary tables updated incrementally), **materialized views** (stored query results PostgreSQL maintains), and **read models** (purpose-built denormalized tables optimized for a specific read). These give fast in-product analytics without hammering the OLTP tables or needing a full warehouse.

#### Why does it exist?

Computing a dashboard figure on the fly from raw OLTP tables (sum all of a seller's orders every time they open their dashboard) is slow and loads the production database (63.1). But the data team's warehouse is for internal analytics, not low-latency in-product features, and may be hours stale. So for product-facing analytics you precompute and store the aggregates close to the application, updating them incrementally, so the dashboard reads a small summary table instantly. This bridges the gap between "recompute from raw data every time" (too slow) and "use the warehouse" (not for in-product, low-latency reads).

#### How it works

```sql
-- Pre-aggregated summary table, updated incrementally (e.g. by the order-placed handler
-- or a CDC consumer), so the dashboard reads one small row instead of aggregating.
CREATE TABLE seller_daily_stats (
  seller_id   uuid NOT NULL,
  day         date NOT NULL,
  order_count bigint NOT NULL DEFAULT 0,
  revenue_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (seller_id, day)
);

-- On each order, upsert the aggregate (incremental maintenance):
INSERT INTO seller_daily_stats (seller_id, day, order_count, revenue_cents)
VALUES ($1, current_date, 1, $2)
ON CONFLICT (seller_id, day)
DO UPDATE SET order_count = seller_daily_stats.order_count + 1,
              revenue_cents = seller_daily_stats.revenue_cents + EXCLUDED.revenue_cents;

-- The dashboard query reads the small summary table by key -> instant, no scan.
SELECT day, order_count, revenue_cents FROM seller_daily_stats
 WHERE seller_id = $1 AND day > current_date - 30 ORDER BY day;
```

```sql
-- Materialized view: PostgreSQL stores the result of a query and you refresh it.
CREATE MATERIALIZED VIEW product_sales_30d AS
SELECT product_id, count(*) AS sales, sum(total_cents) AS revenue
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
 WHERE o.created_at > now() - interval '30 days'
 GROUP BY product_id;
-- Refresh periodically (CONCURRENTLY to avoid blocking reads):
REFRESH MATERIALIZED VIEW CONCURRENTLY product_sales_30d;
```

The techniques:

- **Pre-aggregated tables** maintained incrementally (on each relevant write, or by a CDC consumer, 63.2): the dashboard reads a tiny summary instead of aggregating raw rows. This is the pattern used in the URL shortener's daily stats (Part 40) and anywhere a count/sum is shown frequently.
- **Materialized views**: PostgreSQL stores a query's result and you `REFRESH` it on a schedule; good for aggregates that can be a bit stale and are expensive to compute. `REFRESH ... CONCURRENTLY` avoids blocking reads during refresh.
- **Read models** (CQRS idea, Part 5): a denormalized table shaped exactly for a specific read, kept in sync from the write side, so the read is a simple fast lookup.

The common thread is precomputing and storing the answer so the read is cheap, trading some staleness and some write-time or refresh work for fast reads — the same read-optimization and caching philosophy as Part 16, applied with database structures.

#### How a Senior Backend Engineer thinks about this

A senior builds in-product analytics with precomputed structures — incrementally maintained summary tables, materialized views, read models — so dashboards read small, fast aggregates instead of scanning OLTP tables on every view, keeping product analytics fast without touching production's transactional performance or needing the warehouse. They choose the technique by freshness need and cost: incremental summary tables for real-time counts that must be current, materialized views for expensive aggregates that tolerate periodic refresh, read models for a specific hot read. They right-size: for in-product features these structures beat both naive on-the-fly aggregation (too slow, loads production) and a full warehouse (not for low-latency in-product reads, and operationally heavy). They keep the aggregates correct via idempotent incremental updates or scheduled refreshes, and reconcile them against the source (63.4) so a summary table cannot silently drift from reality.

#### Common mistakes

- Computing dashboard aggregates on the fly from raw OLTP tables every view, loading production and being slow.
- Using the warehouse for low-latency in-product analytics (wrong tool, too stale, heavy).
- Non-idempotent incremental aggregation that double-counts.
- Never refreshing or reconciling precomputed structures, letting them drift from the source.
- Adding a full warehouse when materialized views in PostgreSQL would serve the product feature.

#### Interview questions

1. **How do you build a fast in-product analytics feature without hammering the OLTP tables?** Precompute aggregates into summary tables (maintained incrementally), materialized views, or read models, so the dashboard reads a small precomputed result instead of scanning raw rows.
2. **When do you use a materialized view versus an incrementally maintained summary table?** A materialized view for expensive aggregates that tolerate periodic refresh staleness; an incremental summary table for figures that must be current and are updated on each relevant write.
3. **Why not use the data warehouse for in-product analytics?** It is built for internal analytics, not low-latency product reads, and is often hours stale; in-product features need fast, fresh reads from structures close to the application.
4. **How do you keep precomputed aggregates correct?** Use idempotent incremental updates (or scheduled refreshes) and reconcile against the source so the summary cannot silently drift.

#### Practical exercise

Build a seller dashboard analytics feature: an incrementally maintained `seller_daily_stats` table updated on each order (idempotently), a materialized view for a 30-day top-products aggregate refreshed on a schedule, and a dashboard query that reads these instead of scanning the orders tables. Add a reconciliation check comparing the summary table's revenue against the raw orders for a day. Acceptance criteria: the dashboard reads precomputed structures (no raw-table scans), the incremental update does not double-count on retries, and reconciliation would catch drift.

## Senior Checklist — Part 63

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
- [ ] I can explain OLTP vs OLAP and why analytics must stay off the production database
- [ ] I understand CDC and how it (with the outbox) moves changes reliably downstream
- [ ] I understand ETL/ELT, batch orchestration, warehouses, lakes and columnar storage
- [ ] I understand stream processing: windows, watermarks, event time and late events
- [ ] I treat event schemas as data contracts and champion reconciliation for data quality
- [ ] I propagate PII masking and deletion across the whole pipeline, not just production
- [ ] I build in-product analytics with pre-aggregated tables, materialized views and read models

## Part 63 — Key Takeaways

- OLTP (production, row-oriented, many small transactions) and OLAP (analytics, column-oriented, large scans) need opposite optimizations; running analytics on the production database degrades or crashes it.
- CDC streams database changes reliably by reading the write-ahead log (via Debezium/Kafka), adding little load and missing nothing; combined with the outbox pattern it delivers transaction-safe semantic events.
- Pipelines move and transform data via ETL (transform then load) or ELT (load raw then transform), orchestrated as scheduled DAGs with dependencies, retries and alerting.
- Warehouses and lakes store analytics data in columnar, partitioned, compressed form (Parquet) so big aggregates are fast and cheap, separate from the OLTP database.
- Stream processing computes near-real-time results over event streams using windows, watermarks and event time, with allowed-lateness handling so stragglers are reconciled, not silently dropped.
- Event schemas are data contracts between the backend and data teams; change them compatibly and coordinate, or you silently break analytics (an event stream is an API).
- Reconciliation — comparing a derived figure against the source of truth and alerting on mismatch — is the essential backstop that catches silent pipeline failures and contract violations.
- PII flows through the whole pipeline; mask or drop it early (data minimization) and propagate GDPR deletions to every store (warehouse, lake, derived tables, backups), not just production.
- Build fast in-product analytics with precomputed structures — incrementally maintained summary tables, materialized views, read models — rather than scanning OLTP tables or misusing the warehouse.
- The backend engineer's data and events feed the whole analytics pipeline, so a schema change, an unannounced field rename, or an incomplete deletion is their responsibility, coordinated with the data team.
