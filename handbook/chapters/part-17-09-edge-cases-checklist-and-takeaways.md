## 17.21 Edge cases & failure modes in SQL

Every item here has caused a real incident. For each: what goes wrong, why, and the fix.

- **NULL comparisons.** `WHERE cancel_reason <> 'fraud'` drops rows where `cancel_reason IS NULL`; `= NULL` never matches. Why: three-valued logic; `UNKNOWN` rows are filtered out. Fix: `IS NULL`, `IS DISTINCT FROM`, `coalesce`, and `NOT NULL` columns wherever "unknown" is not a real state.

- **`NOT IN (subquery)` with a NULL.** `WHERE id NOT IN (SELECT shipping_address_id FROM orders)` returns zero rows the moment one `shipping_address_id` is `NULL`, and starts returning rows (or deleting them) the day the `NULL` disappears. Fix: `NOT EXISTS`.

- **Implicit casts disabling indexes.** `WHERE order_number = '12345'` on a `bigint` column is fine (the literal is coerced), but `WHERE order_number::text = $1` or a parameter explicitly typed as `text` compared to `uuid`/`bigint` forces a cast on the column side and a sequential scan. Also `WHERE created_at::date = $1`. Fix: cast the parameter, never the column; bind parameters with the column's type (`$1::uuid`); check the plan for `Filter` on a cast expression.

- **Join row explosion.** Joining two 1:N children at parent grain (orders x items x payments) multiplies rows; sums and counts inflate; ORMs hide it by de-duplicating entities in memory while still transferring every row. Fix: aggregate each child to parent grain before joining; `LATERAL` for top-1; `separate: true` / second query in ORMs; `count(DISTINCT parent.id)` only as a diagnostic.

- **`LEFT JOIN` turned `INNER` by `WHERE`.** `LEFT JOIN payments p ... WHERE p.status = 'captured'` removes orders without payments. Fix: right-side conditions go in `ON`; only `IS NULL` checks on the right side go in `WHERE`.

- **`SELECT *`.** Reads and transfers every column (including TOASTed `jsonb` and `text`), prevents index-only scans, breaks `INSERT INTO ... SELECT *` and positional code when a column is added or reordered, and leaks new sensitive columns (`password_hash`) into API responses. Fix: name columns; in TypeORM use `select` or `select: false` on sensitive columns.

- **`OFFSET 1000000`.** Reads and discards a million rows per request; export scripts that page with `OFFSET` are quadratic; concurrent inserts and deletes shift the window so rows are skipped or repeated. Fix: keyset pagination on an indexed `(sort_col, id)` with a row-value comparison.

- **`LIMIT` without `ORDER BY`.** Returns whichever rows are cheapest today; a different set after `VACUUM`, a plan change, or a replica switch. "Get any 10 pending jobs" looks fine until the same 10 rows are returned forever because they sit at the start of the heap. Fix: `ORDER BY` with a unique tiebreaker; for random sampling, `TABLESAMPLE`.

- **String concatenation SQL injection.** `` `WHERE email = '${email}'` `` lets `' OR 1=1 --` through; TypeORM `where(\`... ${value}\`)` and Sequelize `literal` with interpolated input are the same hole, as is building `ORDER BY ${column}` from a request without an allowlist. Fix: parameters everywhere (`$1`, `:name`, `bind`), allowlisted identifiers for dynamic column and direction, and `quote_ident` if you must build identifiers in SQL.

- **`UPDATE`/`DELETE` without `WHERE`.** Every row changes, every row is locked until commit, every other writer on that table queues, replication lag spikes, and the fix is a restore. Fix: transactions with an explicit `ROLLBACK` habit in `psql` (`BEGIN; UPDATE ...; SELECT count(*) ...; COMMIT`), `statement_timeout`, a linter rule for ORM `update()` without `where`, and no `DELETE` in production without a row-count check.

- **Long-running reporting queries holding back vacuum.** A 40-minute report on the primary keeps its snapshot open; `VACUUM` cannot remove tuples deleted after the snapshot started; hot tables bloat; `n_dead_tup` climbs; every query on those tables slows. Fix: run reports on a replica (with `hot_standby_feedback` considerations, Part 22), set `statement_timeout` and `idle_in_transaction_session_timeout`, and materialize heavy reports.

- **Lock waits from a wide `UPDATE`.** `UPDATE products SET is_active = false WHERE category_id = 7` on 2 million products locks 2 million rows for the transaction's duration and blocks every checkout touching those products. Fix: batch by primary key range (5,000 rows per transaction), short transactions, `lock_timeout` on interactive sessions.

- **Correlated subquery in a report.** `(SELECT count(*) FROM order_items WHERE order_id = o.id)` over 2 million orders is 2 million index scans (`loops=2000000`). Fix: derived table or window function.

- **`DISTINCT` as a bandage.** Added to hide join multiplication; the plan gains a sort or hash over the inflated set, and the underlying bug remains for the next aggregate. Fix: fix the join grain.

- **`ORDER BY` without a unique tiebreaker.** Ties are ordered arbitrarily; pagination skips and repeats; `row_number()` differs between runs. Fix: always end with the primary key.

- **`rank()` for pagination.** Gaps after ties cause missing rows. Fix: `row_number()` to paginate, `rank()`/`dense_rank()` to display.

- **`last_value()` with the default frame.** Returns the current row. Fix: `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.

- **`date_trunc` or `::date` on the column in `WHERE`.** Sequential scan. Fix: half-open range on the raw column; truncation in `SELECT`/`GROUP BY`.

- **Session time zone drift.** The same `WHERE placed_at >= '2026-03-01'` means different instants on a developer laptop (`Asia/Kolkata`) and a server (`UTC`). Fix: UTC session zone from the pool; explicit offsets in literals; `AT TIME ZONE` in reports.

- **`now()` in a long transaction.** All rows get the transaction start time; SLA calculations off by minutes. Fix: `clock_timestamp()` when the actual time matters.

- **Upsert that regresses state.** `ON CONFLICT DO UPDATE SET status = EXCLUDED.status` lets a late `initiated` webhook overwrite `captured`. Fix: `WHERE existing.status NOT IN (terminal states)`.

- **`ON CONFLICT` target mismatch.** Index on `lower(email) WHERE deleted_at IS NULL`, `ON CONFLICT (email)`: error at runtime, only when a conflict first happens. Fix: match the expression and predicate exactly; test the conflict path.

- **Multi-row insert conflicting with itself.** Two identical keys in one `VALUES` list with `DO UPDATE`: "cannot affect row a second time". Fix: dedupe input.

- **Row lock held across I/O.** `SELECT ... FOR UPDATE`, then an HTTP call, then `UPDATE`: every request for that row waits for the slowest external dependency. Fix: I/O before or after the transaction; lock for milliseconds.

- **`FOR UPDATE` on a parent while children insert.** Blocks FK `KEY SHARE`; `order_items` inserts wait on an `orders FOR UPDATE`. Fix: `FOR NO KEY UPDATE`.

- **Queue rows stuck in `processing`.** A worker crash after claim; the row never returns. Fix: reaper by timestamp; `attempts` cap.

- **Recursive CTE without a depth guard.** One self-referencing row and the query runs until temp disk is full. Fix: depth limit, `CYCLE` clause, `CHECK (parent_id IS DISTINCT FROM id)`.

- **CTE fence surprise across a major upgrade.** A query that depended on PG11 materialization to avoid a bad plan changes plan on PG12. Fix: `MATERIALIZED` explicitly where the fence was load-bearing; re-check plans after upgrades.

- **Parameter limit and huge `IN` lists.** 70,000 ids in `IN (...)` exceeds node-postgres's 65,535 parameters, or produces a plan the parser chokes on. Fix: `= ANY($1::uuid[])` with one array parameter, or a temp table.

- **`jsonb` text comparisons.** `attributes->>'price' > '100'` compares strings. Fix: cast, and index the cast expression.

- **Hash join spilling.** `Batches: 16` in the plan; the join runs from disk. Fix: session-level `work_mem` for the report, or reduce the input with a tighter predicate.

- **Stale statistics after a bulk load.** A 20-million-row import, no `ANALYZE`, and the planner still believes the table has 1,000 rows; every plan is wrong until autovacuum catches up. Fix: `ANALYZE table` after bulk loads (Part 19).

- **Replica reads after writes.** Insert on the primary, immediately read on a replica: not found. Fix: read-your-writes routing (Part 22).

- **Unbounded results.** `SELECT ... FROM notifications WHERE user_id = $1` with no `LIMIT` for a user with 3 million rows: the pod is OOMKilled assembling the array. Fix: every list query has a `LIMIT`; stream with a cursor for exports.

- **Returning `numeric`/`bigint` as JavaScript numbers.** Precision loss above 2^53 and float drift on money. Fix: strings from the driver, a decimal library, integer minor units.

- **`TRUNCATE ... CASCADE`.** Truncates every table that references the target, transitively. Fix: never `CASCADE` a `TRUNCATE` on a table with production children; list the dependents first.

- **`EXPLAIN ANALYZE` on a data-modifying statement.** It runs the statement. Fix: `BEGIN; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;`.

## Senior Checklist — Part 17

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
- [ ] I write sargable predicates: no functions or casts on the column side, ranges instead of `date_trunc`, expression indexes when a function is unavoidable
- [ ] I know which `LIKE` patterns use a B-tree, which need `text_pattern_ops`, and which need `pg_trgm`
- [ ] I put right-side filters of a `LEFT JOIN` in `ON`, and I can explain why `WHERE` turns it into an inner join
- [ ] I can identify nested loop, hash join and merge join in a plan, say why the planner chose each, and spot `loops=` and `Batches` problems
- [ ] I aggregate 1:N children to parent grain before joining, and I can explain the row-multiplication trap to a junior in one sentence
- [ ] I use `FILTER`, `ROLLUP`/`GROUPING SETS` and `GROUPING()` for multi-metric and subtotal reports in one pass
- [ ] I paginate with keyset on `(sort_col, id)` and a row-value comparison, and I never ship `OFFSET` for deep pages or exports
- [ ] I use `EXISTS`/`NOT EXISTS` for existence checks and I flag `NOT IN (subquery)` in every review
- [ ] I default to `UNION ALL` and use `UNION` only for real set semantics
- [ ] I know PG12+ CTE inlining, when to write `MATERIALIZED`, and how data-modifying CTEs share a snapshot
- [ ] I can write a recursive CTE for a tree or graph with a depth guard and `CYCLE` protection
- [ ] I use window functions for top-N per group, dedup, running totals, `LAG` deltas and gaps-and-islands, always with a unique tiebreaker, and I know the `last_value` frame trap
- [ ] I can pivot with conditional aggregation and know when `CASE` in `WHERE` disables indexes
- [ ] I can spot a correlated `SubPlan` with a large loop count and rewrite it as a derived table, window or `LATERAL`
- [ ] I return nested documents with `jsonb_agg`/`jsonb_build_object` for bounded child sets, and I report percentiles instead of means for time-like data
- [ ] I query `jsonb` with `@>` on a GIN index and expression B-trees for ranges, and I know the text-comparison and null-vs-missing traps
- [ ] I write zero-filled time reports with `generate_series`, sargable ranges and explicit `AT TIME ZONE`
- [ ] I use `RETURNING`, multi-row inserts with `unnest`, and guarded `ON CONFLICT DO UPDATE ... WHERE` that never regresses terminal state
- [ ] I can write `UPDATE ... FROM` and `DELETE ... USING`, batch large modifications, and I know what happens on multi-match
- [ ] I can implement a `FOR UPDATE SKIP LOCKED` job queue with a partial index, a reaper and backoff, and I never hold a row lock across I/O
- [ ] I know `FOR NO KEY UPDATE` and why `FOR UPDATE` on a parent blocks child inserts
- [ ] I use `COPY` for bulk loads via a staging table, and I know `TRUNCATE`'s lock and `CASCADE` behavior
- [ ] I read the six essential lines of `EXPLAIN (ANALYZE, BUFFERS)` before shipping any query that runs more than once per second
- [ ] I follow the process: write for correctness, check the plan on realistic data, add the index or reshape, verify under volume and concurrency
- [ ] I know what TypeORM `take()` with joins and Sequelize `limit` with `hasMany` includes generate, and when to drop to raw SQL in a typed repository method
- [ ] I never build SQL from user strings; parameters always, allowlists for dynamic identifiers

## Part 17 — Key Takeaways

- The column stays bare. Every function, cast or arithmetic on the column side of a predicate turns an index seek into a table scan.
- `LEFT JOIN` filters go in `ON`. A right-side condition in `WHERE` silently makes the join inner.
- Read the join node: nested loop with small loops and index probes is a healthy OLTP plan; hash join with one batch is a healthy report plan; anything with `loops` in the millions or `Batches` above one is a bug.
- Aggregate children to the parent's grain before joining anything else. Row multiplication is the most common wrong number in production reports.
- `OFFSET` reads and discards. Keyset pagination on `(sort_col, id)` with a row-value comparison is constant-cost at any depth.
- `NOT IN` with a nullable subquery returns nothing and looks like success. `NOT EXISTS` is the anti-join.
- `UNION ALL` unless you need set semantics; `UNION` hashes every row.
- CTEs are inlined in PG12+; write `MATERIALIZED` only when the fence is the point. Recursive CTEs need a depth guard and `CYCLE`.
- Window functions solve top-N per group, dedup, running totals and deltas in one sorted pass; always add a unique tiebreaker, and give `last_value` a frame.
- A correlated subquery is a loop. Fine for 20 outer rows; a report over millions needs a derived table, a window, or `LATERAL` with a small outer set.
- Return nested JSON from one query with `jsonb_agg` for bounded children; report p50/p90, not averages.
- `RETURNING` saves a round trip; `unnest` beats parameter limits; upserts need a `WHERE` guard so a late event cannot overwrite a terminal state.
- `FOR UPDATE SKIP LOCKED` plus a partial index is a transactional job queue with no extra infrastructure, up to a few thousand jobs per second. Never hold a row lock across a network call; prefer `FOR NO KEY UPDATE`.
- The ORM is for the boring 80 percent. Window functions, recursive CTEs, `LATERAL`, guarded upserts and queue claims live as raw SQL in typed repository methods, tuned with `EXPLAIN` before they ship.
- Write for correctness, check the plan on real volume, add the index, verify under concurrency. Ten minutes per query, and most of the incidents in this book never happen.
