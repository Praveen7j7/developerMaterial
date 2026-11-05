### Q75. When does an index make things worse?

- **Expected answer** — Every index is a write tax: an `INSERT` must add an entry to each index, an `UPDATE` to an indexed column must add entries to those indexes and blocks HOT updates, and each index is more WAL, more disk, more memory competing for `shared_buffers`, and more work for vacuum. On a table taking 20,000 inserts per second, ten indexes can halve throughput. Indexes also hurt when they are not selective: an index on `status` where 95% of rows are `'completed'` will not be used for that value, and if the planner is tricked into using it the bitmap scan plus heap fetches can be slower than a sequential scan. Small tables (a few hundred rows, one page) are faster to scan than to index. Redundant indexes are pure cost: `(a)` is subsumed by `(a, b)`. And unused indexes are worse than useless — find them with `pg_stat_user_indexes` where `idx_scan = 0` over a full business cycle, and drop them (after checking they are not backing a constraint, and preferably with `DROP INDEX CONCURRENTLY`). My rule: an index needs a query that justifies it, and I re-audit index usage quarterly.

- **Why it matters** — Junior engineers add indexes; seniors also remove them.

- **Follow-ups** — How do you safely decide an index is unused? What does an index do to a HOT update? How would you measure the write cost before adding one?

- **Senior signal** — Talks about removing indexes, the HOT-update interaction, and a full business cycle before trusting `idx_scan = 0`.

### Q76. How do you add an index to a 300-million-row table in production?

- **Expected answer** — `CREATE INDEX CONCURRENTLY`. A plain `CREATE INDEX` takes a `SHARE` lock that blocks all writes for the whole build, which on that table is many minutes of downtime. `CONCURRENTLY` does two table passes and waits for existing transactions, taking only `SHARE UPDATE EXCLUSIVE`, so reads and writes continue. The costs and rules: it cannot run inside a transaction block (which matters because most migration tools wrap migrations in one — TypeORM and Sequelize both do, so you disable that for this migration); it takes roughly two to three times as long; it can fail and leave an `INVALID` index behind, which you must find (`pg_index.indisvalid = false`), drop concurrently, and retry; and it waits on long-running transactions, so a stuck analytics query blocks the build indefinitely. Operationally I run it outside the deploy pipeline or in a separate migration step, monitor `pg_stat_progress_create_index`, run it during a low-traffic window because it consumes significant I/O and `maintenance_work_mem`, and verify validity plus `EXPLAIN` afterwards before shipping the code that depends on it.

- **Why it matters** — This is the difference between a routine change and an incident.

- **Follow-ups** — What do you do when the concurrent build fails halfway? How does this interact with your migration framework's transaction? What order do you ship the index and the query that uses it?

- **Senior signal** — Knows the invalid-index cleanup, the transaction-block restriction in migration tools, and ships the index before the code.

### Q77. Why are Postgres connections expensive, and what does PgBouncer solve?

- **Expected answer** — Each connection is a forked OS process with its own memory (a few megabytes of private memory plus `work_mem` allocations per sort or hash node, which is per operation, not per connection), and every backend participates in snapshot and lock bookkeeping, so throughput actually *degrades* past a point — a common rule of thumb is a sweet spot around `2 to 4 x cores` active connections, so on 16 cores something like 32 to 64. Node makes this worse: 30 pods times a pool of 20 is 600 connections against a `max_connections` of 200, and you get `FATAL: sorry, too many clients already` at exactly the wrong moment. PgBouncer multiplexes many client connections onto few server connections. In **transaction pooling** mode (the useful one) a server connection is assigned only for the duration of a transaction, so 2,000 clients can share 40 backends. The trade-offs you must state: transaction pooling breaks session state, so no session-level `SET`, no `LISTEN/NOTIFY`, no session advisory locks, and prepared statements need care (`max_prepared_statements` in PgBouncer 1.21+, or disable them in the driver). Sizing: application pool small (say 5–10 per pod), PgBouncer `default_pool_size` around the database's sweet spot.

- **Why it matters** — Connection exhaustion is a top-three Postgres outage cause in containerised environments.

- **Follow-ups** — What breaks with transaction pooling in TypeORM or Sequelize? How do you size the app pool versus the bouncer pool? What is RDS Proxy doing differently?

- **Senior signal** — Gives concrete numbers and names exactly what transaction pooling breaks, instead of "PgBouncer makes it faster".

### Q78. Explain streaming replication and replica lag.

- **Expected answer** — The primary streams WAL to standbys, which replay it. Replication is asynchronous by default: the primary commits without waiting, so a standby can be behind by milliseconds normally and by minutes under load or during a big `UPDATE`. `synchronous_commit = on` with `synchronous_standby_names` makes the primary wait for the standby to flush (or apply, with `remote_apply`), which gives zero data loss on failover at the cost of adding the network round trip to every commit and, critically, making the primary unavailable for writes if the standby dies unless you configure quorum. Lag has three flavours you should measure separately: write, flush and replay lag (`pg_stat_replication`), plus `pg_last_xact_replay_timestamp()` on the standby. Reading from replicas is the standard scale-out for read-heavy workloads, but it introduces read-your-writes violations: a user creates an order, is redirected to the detail page, the read hits a lagging replica, and they get a 404. Mitigations: route reads that follow a write to the primary for a short window, pass an LSN and wait for the replica to catch up, or make the UI use the response body it already has. Also note `hot_standby_feedback = on` protects long replica queries from being cancelled but lets replica queries cause bloat on the primary.

- **Why it matters** — Read replicas are the most common scaling move and the most common source of confusing "missing data" bugs.

- **Follow-ups** — How would you implement read-your-writes? What causes replay lag to spike specifically? What is the failure mode of synchronous replication with one standby?

- **Senior signal** — Names read-your-writes as the concrete product bug and knows the `hot_standby_feedback` trade-off in both directions.

### Q79. When and how would you partition a table?

- **Expected answer** — Declarative partitioning (`PARTITION BY RANGE | LIST | HASH`) splits one logical table into physical partitions. The real motivations are operational, not query speed: dropping old data becomes `DROP TABLE` (instant) instead of a `DELETE` of 200 million rows that bloats the table for weeks; vacuum, index builds and backups operate per partition; and index sizes stay in memory. Range partitioning by month on an events or orders table is the canonical case. Query speed improves only when the planner can prune partitions, which requires the partition key to be in the `WHERE` clause — so if your dominant query filters by `tenant_id` and you partitioned by `created_at`, you scan every partition and it is slower than before. Costs and gotchas: the partition key must be part of every unique constraint and primary key, so you cannot have a globally unique `email` unless email is the key; cross-partition foreign keys pointing *at* a partitioned table were long unsupported (allowed from 12+ with caveats); too many partitions (thousands) slow planning; and you need automation to create future partitions, or writes fail at midnight on the first of the month, which is an incident I have seen twice. Use `pg_partman` or a scheduled job, and always pre-create several months ahead.

- **Why it matters** — Partitioning is often proposed as a fix for the wrong problem.

- **Follow-ups** — What happens when a row does not match any partition? How do you migrate an existing 500 GB table to a partitioned one online? What does partition pruning look like in `EXPLAIN`?

- **Senior signal** — Says partitioning is primarily about data lifecycle and maintenance, names the unique-key restriction, and has the missing-future-partition scar.

### Q80. How do you use `pg_stat_statements`?

- **Expected answer** — It is an extension that aggregates normalised query statistics: `calls`, `total_exec_time`, `mean_exec_time`, `stddev_exec_time`, `rows`, and shared buffer hit/read counts per query fingerprint (literals replaced by `$1`). The single most useful query is ordering by `total_exec_time` — not `mean_exec_time` — because a 2 ms query called 40 million times an hour costs far more than a 4-second report run twice. That is how you find the real hot spot, which is very often an N+1 from the ORM: one query with an enormous `calls` count.

  ```sql
  SELECT queryid, calls, round(total_exec_time::numeric,0) AS total_ms,
         round(mean_exec_time::numeric,2) AS mean_ms, rows
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
  ```

  Complement it with `pg_stat_user_tables` (sequential scans, dead tuples), `pg_stat_activity` (what is running now, `wait_event_type`), and `auto_explain` with `log_min_duration` to capture actual plans of slow executions. Reset the view (`pg_stat_statements_reset()`) around an experiment so you measure a window rather than since-boot. Watch `stddev` too: a low mean with huge stddev means a plan that flips or a parameter value that is much worse than the rest.

- **Why it matters** — It is the shortest path from "the database is slow" to a specific query.

- **Follow-ups** — Why order by total rather than mean time? How do you spot an N+1 from this view? What would `auto_explain` add?

- **Senior signal** — Orders by total time, uses stddev to detect plan instability, and knows the N+1 fingerprint.

### Q81. What are planner statistics, and why does a plan suddenly flip?

- **Expected answer** — `ANALYZE` samples rows (default `default_statistics_target = 100`, so 300 x 100 rows) and stores per-column most-common-values lists, histograms, null fraction and distinct-count estimates in `pg_statistic`. The planner multiplies per-column selectivities assuming independence. Plans flip when the estimate crosses a cost boundary: after a bulk load before autovacuum's analyze catches up, after data distribution shifts (a new large tenant), when correlated columns break the independence assumption (`city = 'Mumbai' AND state = 'Maharashtra'` estimates a product, so it underestimates by 30x and the planner picks a nested loop that then runs 400,000 times), or when a parameterised statement switches from a custom plan to a generic plan after five executions and the generic estimate is wrong. Fixes: raise `default_statistics_target` on skewed columns, create **extended statistics** (`CREATE STATISTICS ... (dependencies, ndistinct, mcv) ON city, state FROM addresses`), analyze after bulk loads, and where the planner is stubborn, restructure the query or use `plan_cache_mode = force_custom_plan` for the offending prepared statement. Deliberate index hints do not exist in Postgres, which is a design decision, so the fix is always about better information.

- **Why it matters** — "It was fast yesterday" is one of the most common production questions and this is the answer.

- **Follow-ups** — How do you detect that a plan flipped? What is extended statistics doing exactly? Why does the generic plan appear on the sixth execution?

- **Senior signal** — Knows extended statistics and the custom-versus-generic prepared-plan behaviour, both of which are real causes of overnight regressions.

### Q82. What do `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` do, and how do you set them?

- **Expected answer** — `statement_timeout` cancels any statement running longer than the limit; it protects against runaway queries eating CPU and, crucially, against a query holding a snapshot that blocks vacuum. `lock_timeout` fails a statement that has waited too long *to acquire* a lock, which is what makes migrations safe: without it, an `ALTER TABLE` queues behind a long read and then blocks every subsequent query. `idle_in_transaction_session_timeout` kills sessions that opened a transaction and then went idle, which is the classic ORM bug where a transaction is started, an HTTP call is made, and the connection sits open holding locks and pinning an old snapshot. My defaults: a global `statement_timeout` of 30 s at the role level for the application user, tighter per-endpoint values set on the connection for user-facing paths (2–5 s), a much larger value or none for the reporting role, `lock_timeout = 3s` plus retry for migrations, and `idle_in_transaction_session_timeout = 60s`. Also set a client-side timeout that is *longer* than the server one so you always get a clean cancellation message rather than a mystery socket hang-up, and remember the application must map the resulting error to a 503 or 504, not a 500.

- **Why it matters** — Timeouts are the cheapest availability control in a database and most teams have none.

- **Follow-ups** — Why should the client timeout be longer than the server one? Where do you set these per role versus per session? What does the app do when a statement is cancelled mid-transaction?

- **Senior signal** — Distinguishes the three precisely, gives concrete values with reasons, and covers the client-side and API-mapping consequences.

## 57.6 TypeORM

### Q83. Explain `DataSource`, `EntityManager` and `Repository`, and when you use the query builder instead.

- **Expected answer** — `DataSource` owns the connection pool and metadata and is created once at startup. `EntityManager` is the API for all entity operations against a connection; `Repository<T>` is just an `EntityManager` scoped to one entity, which is why `repo.manager` exists. Inside a transaction you must use the transactional manager (`dataSource.transaction(async (manager) => ...)` or a `QueryRunner`'s manager); using the injected repository inside a transaction callback silently runs on a *different* connection outside the transaction, which is the single most common TypeORM bug and produces writes that do not roll back. I use `find`/`findOne` with `relations` for simple reads, and drop to `createQueryBuilder` as soon as I need joins with conditions, aggregates, window functions, `ON CONFLICT`, `SKIP LOCKED`, or explicit control of the generated SQL. For genuinely complex analytics I use `manager.query()` with raw parameterised SQL — an ORM is not a query language, and pretending otherwise produces unreadable builder chains.

- **Why it matters** — The transactional-manager mistake causes real data-integrity incidents.

- **Follow-ups** — Show the wrong and right way to write a transactional service method. What does `@Transactional`-style AsyncLocalStorage propagation buy you? When do you drop to raw SQL?

- **Senior signal** — Leads with the transaction/connection trap and is comfortable abandoning the ORM for the right query.

### Q84. How do relations load in TypeORM, and how do you avoid N+1?

- **Expected answer** — Relations are lazy by default in the sense that they are simply not loaded; you opt in with `relations: ['items']`, `eager: true` on the relation, `leftJoinAndSelect` in the query builder, or by declaring the property as `Promise<T[]>` (true lazy relations, which fire a query on access — dangerous in a loop). N+1 happens when you load 100 orders and then touch `order.customer` for each, producing 101 queries; with a 2 ms query that is 200 ms of pure latency. Detect it by logging queries in development with a per-request count assertion, and in production by `pg_stat_statements` showing one fingerprint with an enormous `calls` value. Fixes: join and select in one query; or, when joining explodes rows (one order with 50 items times 3 payments), do two queries and stitch in memory, which is often faster than a wide join. Never set `eager: true` on a relation used by a list endpoint — it silently joins on every single `find`, including ones that did not want it.

- **Why it matters** — N+1 is the most common ORM performance defect and it scales with data, so it passes tests and fails in production.

- **Follow-ups** — Why can `take`/`skip` with `leftJoinAndSelect` return the wrong number of parents, and what does TypeORM do about it? How do you assert query counts in tests? When is two queries better than one join?

- **Senior signal** — Knows the pagination-with-join problem (TypeORM uses a distinct id subquery, which changes the plan) and treats query count as a testable budget.

### Q85. How do you run transactions correctly in TypeORM?

- **Expected answer** — Either `dataSource.transaction(async (manager) => { ... })`, which commits or rolls back automatically, or an explicit `QueryRunner` when you need control:

  ```ts
  const qr = this.dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction('READ COMMITTED');
  try {
    const order = await qr.manager.findOne(Order, { where: { id }, lock: { mode: 'pessimistic_write' } });
    await qr.manager.decrement(Inventory, { sku: order.sku }, 'qty', order.qty);
    await qr.commitTransaction();
  } catch (e) { await qr.rollbackTransaction(); throw e; }
  finally { await qr.release(); }   // release is mandatory or the pool leaks
  ```

  Rules I enforce: every path releases the query runner (a missing `release` leaks a pooled connection until the pool is exhausted); no HTTP or queue calls inside the transaction; keep it short; use `lock: { mode: 'pessimistic_write' }` for row locks and `@VersionColumn` for optimistic; and catch `40001`/`40P01` and retry with jitter when using higher isolation. Nested `transaction()` calls become savepoints, so a rollback of the inner one does not undo the outer, which people misread.

- **Why it matters** — Connection leaks and silently non-transactional writes both come from this API.

- **Follow-ups** — What happens if you forget `release`, and how would you detect it? How do you propagate the manager through several services cleanly? What isolation level do you pick for an inventory decrement?

- **Senior signal** — The mandatory `finally { release() }`, no external calls inside the transaction, and an explicit retry policy.

### Q86. `synchronize: true` versus migrations.

- **Expected answer** — `synchronize: true` diffs your entities against the database and applies DDL at startup. It is convenient for a local prototype and catastrophic anywhere else: it can drop columns and tables when an entity changes, it runs unreviewed DDL on boot, it takes `ACCESS EXCLUSIVE` locks with no `lock_timeout`, and with multiple pods starting at once, several instances race to alter the same table. Production uses generated, reviewed, versioned migrations (`typeorm migration:generate`, then hand-edited), run as a separate step in the deploy pipeline — ideally a Kubernetes Job or init step with a single replica and an advisory lock, not on every pod's startup. Generated migrations still need review: TypeORM will happily emit a column type change that rewrites a 200-million-row table. My rules: migrations are forward-only in production with a tested rollback plan (usually roll forward), expand-then-contract for breaking changes (add column, deploy code writing both, backfill, deploy code reading new, drop old), and every migration is tested against a production-sized copy for lock duration.

- **Why it matters** — This is the difference between a safe deploy pipeline and data loss.

- **Follow-ups** — How do you prevent two pods running migrations simultaneously? Walk me through renaming a column with zero downtime. When is a down-migration a lie?

- **Senior signal** — Expand-and-contract, advisory-locked single-runner migrations, and reviewing generated SQL rather than trusting it.

### Q87. What is the difference between `save`, `insert`, `update` and `upsert`?

- **Expected answer** — `save()` is the "smart" one: it checks whether the entity has a primary key and whether it exists, so it may issue a `SELECT` then an `INSERT` or `UPDATE`, and it cascades to relations. That convenience costs an extra round trip and makes the SQL unpredictable, and with a client-supplied UUID primary key it will do a select-then-insert on every create. `insert()` and `update()` map directly to single statements, do not cascade, and do not return the full entity by default — much more predictable for hot paths and bulk work. `upsert(entities, ['sku','warehouseId'])` generates `INSERT ... ON CONFLICT DO UPDATE`, which is what you want for idempotent consumers. Also know that `save()` on an array executes per-entity queries in a transaction unless chunked, so saving 10,000 rows one by one is a common performance disaster; use `insert` with chunks or the query builder's `.insert().values(rows).orUpdate(...)`. And `remove` versus `delete`: `remove` loads entities and runs subscribers/cascades, `delete` issues a single `DELETE`.

- **Why it matters** — Silent extra queries and unpredictable SQL are how ORM-heavy services get slow.

- **Follow-ups** — Why is `save` slow with UUID primary keys, and what do you do instead? How do you bulk insert 100,000 rows? Which of these trigger entity subscribers?

- **Senior signal** — Prefers explicit statements on hot paths and knows exactly which calls emit an extra `SELECT`.

### Q88. How do you do optimistic and pessimistic locking in TypeORM?

- **Expected answer** — Optimistic: add `@VersionColumn()` to the entity; TypeORM increments it on every `save` and adds `WHERE version = :v` to the update, throwing `OptimisticLockVersionMismatchError` if zero rows matched. You catch that and return HTTP 409 with the current representation so the client can merge and retry. It costs nothing when there is no contention, which is why it suits user-edited resources. Pessimistic: `findOne({ where, lock: { mode: 'pessimistic_write' } })` emits `SELECT ... FOR UPDATE` and must be inside a transaction (TypeORM throws otherwise); `pessimistic_read` gives `FOR SHARE`, and `pessimistic_partial_write` maps to `FOR UPDATE SKIP LOCKED`, which is how you build a job claimer. Choose pessimistic when contention is high and the critical section is short (decrementing stock for a flash sale), optimistic when conflicts are rare and holding a lock across user think-time would be unacceptable. The failure modes to name: pessimistic locks queue and can deadlock, so lock rows in a deterministic order and set `lock_timeout`; optimistic retries can livelock on a hot row, so cap retries and shed load.

- **Why it matters** — This maps directly to Q66 and shows whether database theory reaches their actual code.

- **Follow-ups** — What does the client do with the 409? How would you claim jobs with `pessimistic_partial_write`? What is your retry cap and why?

- **Senior signal** — Chooses per contention profile and specifies API behaviour and retry caps rather than just naming the API.

### Q89. What are the traps in TypeORM's query builder?

- **Expected answer** — Several I hit regularly. (1) `take`/`skip` with `leftJoinAndSelect` cannot just apply `LIMIT`, because a joined parent spans many rows; TypeORM runs a distinct-ids subquery first, which changes the plan and can be slow, whereas `limit`/`offset` apply raw SQL limits and will silently truncate children — know which one you are calling. (2) Parameters must be named and reused carefully; passing the same name twice with different values silently uses the last. (3) `where()` overwrites, `andWhere()` appends, so a conditional filter chain that uses `where` in a loop drops earlier conditions — a data-leak-shaped bug when the dropped condition was `tenant_id`. (4) Raw string interpolation into `where` is a SQL injection hole; always use `:param`. (5) `getMany` versus `getRawMany`: the former hydrates entities and de-duplicates, the latter gives flat rows with prefixed aliases, and mixing them up produces surprising row counts. (6) Soft deletes only apply if you use `softDelete`/`withDeleted` consistently; a raw query builder join to the same table will happily return deleted rows.

- **Why it matters** — These produce wrong data, not just slow data.

- **Follow-ups** — Show me the `where`-in-a-loop bug. When do you want `getRawMany`? How do you enforce tenant scoping so it cannot be forgotten?

- **Senior signal** — Frames the `where` overwrite and soft-delete gaps as security/tenancy risks and proposes systemic enforcement (a base repository or a global scope) rather than discipline.

### Q90. How do you configure and monitor the TypeORM connection pool?

- **Expected answer** — With the `pg` driver, pool options go in `extra`: `max` (pool size, default 10), `min`, `idleTimeoutMillis`, `connectionTimeoutMillis`, plus `statement_timeout` and `query_timeout`. Sizing is the important part: total connections equals pods times `max`, and it must fit under `max_connections` (minus superuser reserved slots) or, better, under your PgBouncer pool. With 20 pods, `max: 10` is 200 connections — already at a stock RDS limit. A small pool with a queue is usually better than a large pool: the database gets less contended, and requests wait in your app where you can see and time-box them. Instrument it: export pool `total`, `idle` and `waiting` counts as gauges, and alert on `waiting > 0` sustained, because pool saturation looks exactly like "the database is slow" while the database is idle. Always set `connectionTimeoutMillis` (say 2 s) so a saturated pool fails fast into a 503 instead of piling up. And be aware that with PgBouncer in transaction mode you may need `prepare: false` or a compatible version, and that `idleTimeoutMillis` should be lower than any network middlebox idle timeout to avoid stale-socket errors.

- **Why it matters** — Pool misconfiguration is one of the top causes of cascading latency in Node services.

- **Follow-ups** — Why is a smaller pool often faster? What metric would page you? How does this change behind PgBouncer or RDS Proxy?

- **Senior signal** — The "queue in the app, not in the database" argument with a fail-fast timeout, plus pool metrics as an SLI.
