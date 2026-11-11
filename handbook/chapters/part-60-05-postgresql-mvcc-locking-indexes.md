## 60.5 PostgreSQL

This is the deepest technical section in the Part, because for a senior backend role Postgres knowledge is the highest-leverage differentiator. Twenty-two questions, from storage internals to operations.

### Q61. Explain MVCC in PostgreSQL.

- **Expected answer** — Multi-Version Concurrency Control means writers never block readers and readers never block writers, because each `UPDATE` creates a *new* row version rather than overwriting in place. Every row (tuple) carries hidden system columns `xmin` (the transaction that created it) and `xmax` (the transaction that deleted or superseded it). A transaction sees a snapshot: the set of transaction ids that had committed when it took the snapshot, so it shows a tuple if `xmin` is visible to it and `xmax` is not. Consequences that matter in production: an `UPDATE` of one column rewrites the whole row and every index entry unless HOT (heap-only tuple) applies — HOT requires the updated columns to be unindexed and free space on the same page, which is what `fillfactor` reserves. Dead tuples accumulate and must be reclaimed by `VACUUM`. And a long-running read transaction pins an old snapshot, which prevents vacuum from cleaning anything newer, so one forgotten analytics query can bloat the whole cluster.

- **Why it matters** — MVCC explains bloat, vacuum, long-transaction incidents and why `COUNT(*)` is slow, all at once.

- **Follow-ups** — What is a HOT update and how do you encourage it? Why does a long `SELECT` on a replica affect the primary (hint: `hot_standby_feedback`)? What do `xmin` and `xmax` look like for an updated row?

- **Senior signal** — Connects MVCC to the long-transaction-blocks-vacuum failure mode without prompting, and knows about HOT and `fillfactor`.

### Q62. What does `VACUUM` do, and how do you deal with table bloat?

- **Expected answer** — `VACUUM` marks space used by dead tuples as reusable and updates the visibility map and free space map; it does *not* return space to the OS. `VACUUM FULL` rewrites the table compactly and does return space, but takes an `ACCESS EXCLUSIVE` lock, so it is offline. `ANALYZE` refreshes planner statistics and usually rides along with autovacuum. Autovacuum triggers when dead tuples exceed `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * reltuples` — the default scale factor of 0.2 means a 100-million-row table waits for 20 million dead rows, which is far too late, so on big hot tables I set per-table values like `autovacuum_vacuum_scale_factor = 0.01` and raise `autovacuum_vacuum_cost_limit` so it actually keeps up. Diagnose bloat with `pg_stat_user_tables` (`n_dead_tup`, `last_autovacuum`) and the `pgstattuple` extension. To remove bloat online, use `pg_repack`, which rebuilds the table with only a brief lock. Root causes of runaway bloat: long-running transactions, abandoned replication slots, `hot_standby_feedback` with slow replica queries, and very high update rates on a narrow table.

- **Why it matters** — Bloat is the slow-motion outage that turns a 2 ms query into a 200 ms one over months.

- **Follow-ups** — Why does `VACUUM` not shrink the file? What does an inactive replication slot do to WAL and vacuum? How would you find the transaction blocking vacuum right now?

- **Senior signal** — Per-table autovacuum tuning with real numbers, `pg_repack` over `VACUUM FULL`, and naming replication slots as a bloat cause.

### Q63. What is transaction id wraparound and why should you care?

- **Expected answer** — Transaction ids are 32-bit, so there are about 4 billion of them and visibility is computed on a circular comparison: roughly 2 billion ids "in the past" and 2 billion "in the future". If a tuple's `xmin` is never frozen and the counter wraps past it, rows that should be visible would appear to be in the future and effectively disappear. To prevent that, Postgres freezes old tuples (marking them as always-visible) during vacuum, driven by `vacuum_freeze_min_age` and `autovacuum_freeze_max_age`. If freezing falls too far behind, Postgres starts emitting "database is not accepting commands to avoid wraparound data loss" warnings, then refuses writes until you run a vacuum in single-user mode — a full outage. Newer versions have made the anti-wraparound vacuum less intrusive and Postgres 17+ improves the machinery further, but the failure mode still exists. Monitor `age(datfrozenxid)` per database and alert well before `autovacuum_freeze_max_age` (default 200 million). Causes of falling behind: autovacuum permanently cancelled by conflicting DDL, very long transactions, huge cold tables never vacuumed, and prepared transactions left hanging.

- **Why it matters** — It is one of the few Postgres failure modes that stops writes completely, and it is entirely preventable by monitoring.

- **Follow-ups** — What query would you alert on? Why can an idle prepared transaction cause this? What is the difference between freezing and vacuuming?

- **Senior signal** — Has the monitoring query and the alert threshold, and names hanging prepared transactions, which is a scar.

### Q64. Explain WAL and checkpoints.

- **Expected answer** — Write-Ahead Logging means every change is written to the WAL and flushed to disk *before* the corresponding data page is. That gives crash recovery: on restart, Postgres replays WAL from the last checkpoint. Committing therefore costs one sequential `fsync` of the WAL, not random writes of data pages, which is why Postgres commits are fast. A **checkpoint** flushes all dirty shared buffers to the data files and records a new redo point, bounding recovery time; it is triggered by `checkpoint_timeout` (default 5 minutes) or by `max_wal_size` being exceeded. `checkpoint_completion_target` spreads that I/O over the interval to avoid a write storm. Tuning matters: too-frequent checkpoints cause repeated full-page writes (after a checkpoint, the first write to each page writes the whole page to WAL) and I/O spikes; too-infrequent means long recovery. WAL is also the transport for streaming replication and logical replication, and for PITR via archiving. `synchronous_commit = off` trades durability (you can lose the last ~200 ms of commits on a crash) for a large throughput gain, which is sometimes acceptable for non-financial write-heavy tables.

- **Why it matters** — WAL sits behind durability, replication, backups and half of all write-performance tuning.

- **Follow-ups** — What are full-page writes and why do they spike WAL volume after a checkpoint? What does `synchronous_commit = remote_apply` guarantee? How do you size `max_wal_size`?

- **Senior signal** — Explains full-page writes and gives a scenario where `synchronous_commit = off` is a defensible trade.

### Q65. Walk through the isolation levels Postgres supports and what each prevents.

- **Expected answer** — Postgres offers `READ COMMITTED` (default), `REPEATABLE READ` and `SERIALIZABLE`; `READ UNCOMMITTED` is accepted but behaves as `READ COMMITTED` since dirty reads never happen. `READ COMMITTED` takes a fresh snapshot at the start of *each statement*, so two reads in one transaction can differ (non-repeatable read) and a statement can see rows committed mid-transaction. `REPEATABLE READ` takes one snapshot for the whole transaction; in Postgres it also prevents phantom reads because of the snapshot model, but it does not prevent write skew, and conflicting writes fail with a serialization error (`40001`) that the application must retry. `SERIALIZABLE` adds Serializable Snapshot Isolation: Postgres tracks read/write dependencies with predicate locks and aborts transactions that would produce a non-serializable schedule, again with `40001`. So the real cost of the stronger levels is not locking, it is that your application *must* have a retry loop on `40001`, with backoff and a cap. My default is `READ COMMITTED` with explicit locking or constraints where invariants matter, and `SERIALIZABLE` for a small number of genuinely tricky multi-row invariants.

- **Why it matters** — Choosing an isolation level without a retry strategy is a guaranteed production bug.

- **Follow-ups** — Show me the retry loop. Why does `REPEATABLE READ` not stop write skew? What is the throughput cost of `SERIALIZABLE` under contention?

- **Senior signal** — Says "SERIALIZABLE without a retry loop is broken" and can write the loop, including which SQLSTATEs to catch (`40001` and `40P01`).

### Q66. What is a lost update, and how do you prevent it?

- **Expected answer** — Two transactions read the same row, each computes a new value from what they read, and both write; the second overwrites the first, so one update is silently lost. Classic case: two support agents editing the same order, or two requests both doing `balance = balance - 100` after reading 500, leaving 400 instead of 300. Under `READ COMMITTED` this is entirely possible if you read and write in separate statements. Three fixes. (1) Do it in one statement so the database re-reads under the row lock: `UPDATE accounts SET balance = balance - 100 WHERE id = $1 AND balance >= 100`. (2) Pessimistic locking: `SELECT ... FOR UPDATE` before computing, which serialises but blocks. (3) Optimistic concurrency: a `version` column and `UPDATE ... WHERE id = $1 AND version = $2 RETURNING version`, where zero affected rows means someone else changed it and you return a 409 so the client can re-fetch. For user-facing edit forms optimistic wins because it does not hold locks across think-time; for money movement inside a short transaction, the single-statement or `FOR UPDATE` form wins.

- **Why it matters** — This is the most common real-world concurrency bug in CRUD applications.

- **Follow-ups** — Which one would you use for an inventory decrement and why? How does TypeORM's `@VersionColumn` implement this? What does the client do on a 409?

- **Senior signal** — Picks per situation rather than declaring one universally correct, and specifies the API-level behaviour (409 plus re-fetch), not just the SQL.

### Q67. What is write skew and what actually fixes it?

- **Expected answer** — Write skew is when two transactions read overlapping data, each checks an invariant that is still true for its own snapshot, and each writes a *different* row, so no direct write conflict occurs but the combined result violates the invariant. The textbook case is on-call scheduling: both doctors check "at least one other doctor is on call", both see it is true, both go off call, and now nobody is. In a backend, it is "allow at most 3 active subscriptions per account" or "the sum of these bookings must not exceed capacity" — checked with a `SELECT count(*)`, then an `INSERT`. Row locks do not help because the rows being written did not exist at read time. Fixes: (1) `SERIALIZABLE` isolation, which is exactly what SSI is designed to catch, with a `40001` retry; (2) lock the *parent* object so the check is serialised (`SELECT ... FROM accounts WHERE id = $1 FOR UPDATE` before counting subscriptions); (3) express the invariant as a constraint the database can enforce — a unique index, an exclusion constraint (`EXCLUDE USING gist` for non-overlapping booking ranges), or a materialised counter column with a `CHECK`.

- **Why it matters** — It is the concurrency bug that survives naive locking and shows up as "how did this even happen?".

- **Follow-ups** — Write an exclusion constraint that prevents double-booking a room. Why does `SELECT FOR UPDATE` on the queried rows not fix it? What is the retry cost under `SERIALIZABLE` at 500 TPS?

- **Senior signal** — Knows exclusion constraints and the "lock the parent" trick; a mid-level answer stops at "use SERIALIZABLE".

### Q68. What causes deadlocks in Postgres and how do you fix them?

- **Expected answer** — A deadlock is a cycle: transaction A holds a lock on row 1 and waits for row 2, while B holds row 2 and waits for row 1. Postgres detects it after `deadlock_timeout` (default 1 second) by building the wait-for graph, then aborts one transaction with SQLSTATE `40P01`. Common real sources: batch updates that touch rows in different orders, `ON CONFLICT DO UPDATE` on multi-row inserts, foreign-key checks taking share locks on parent rows in different order, and application code that updates a parent and child in different orders in different code paths. Fixes, in order: (1) impose a global lock ordering — always sort ids before updating a batch; (2) shorten transactions so windows do not overlap; (3) take the coarser lock first when you know you will need it; (4) reduce lock strength where possible (`FOR NO KEY UPDATE` instead of `FOR UPDATE` when you are not changing the key); (5) add a retry with jitter, because at high concurrency some deadlocks are unavoidable. To debug, set `log_lock_waits = on` and read the deadlock report in the log, which prints both statements — that usually tells you the ordering violation immediately.

- **Why it matters** — Deadlocks appear under load, so they are a production-experience marker.

- **Follow-ups** — Read me a deadlock log entry and tell me the fix. Why does a foreign key cause locks on the parent? Would `SERIALIZABLE` make this better or worse?

- **Senior signal** — Sorting ids as the primary fix, plus reading the deadlock report rather than guessing.

### Q69. Explain Postgres lock modes and which DDL is safe online.

- **Expected answer** — Table-level modes form a conflict matrix; the ones that matter are `ACCESS SHARE` (taken by `SELECT`), `ROW SHARE` (`SELECT FOR UPDATE`), `ROW EXCLUSIVE` (`INSERT`/`UPDATE`/`DELETE`), `SHARE UPDATE EXCLUSIVE` (`VACUUM`, `CREATE INDEX CONCURRENTLY`, `ANALYZE`), `SHARE` (`CREATE INDEX`), and `ACCESS EXCLUSIVE` (most `ALTER TABLE`, `DROP`, `TRUNCATE`, `VACUUM FULL`), which conflicts with everything including plain `SELECT`. The production danger is not the DDL duration but the *queue*: an `ALTER TABLE` waiting behind a long-running `SELECT` holds a pending `ACCESS EXCLUSIVE` request, and every subsequent query queues behind it, so a 5-millisecond migration causes a full outage. Always run migrations with `SET lock_timeout = '3s'` and retry. Safe-in-modern-Postgres operations: adding a nullable column, adding a column with a non-volatile default (11+, no rewrite), `CREATE INDEX CONCURRENTLY`, adding a `CHECK` constraint as `NOT VALID` then `VALIDATE CONSTRAINT` separately, and `SET NOT NULL` backed by a validated check constraint (12+). Unsafe without care: changing a column type, adding a `UNIQUE` constraint directly (build the index concurrently first, then attach), and `DROP COLUMN` on a heavily-referenced table.

- **Why it matters** — Migration-caused outages are extremely common and entirely avoidable.

- **Follow-ups** — Walk me through adding a `NOT NULL` column with a default to a 500-million-row table with zero downtime. Why does `lock_timeout` help more than `statement_timeout` here? What is the lock queue and how do you inspect it?

- **Senior signal** — The lock-queue explanation and the `lock_timeout`-plus-retry migration discipline.

### Q70. How do you read `EXPLAIN (ANALYZE, BUFFERS)` output?

- **Expected answer** — Read the tree from the innermost node outward; each node reports `cost=startup..total rows=estimated width=bytes` and, with `ANALYZE`, `actual time=first..last rows=N loops=L`. The key habits: (1) compare estimated versus actual rows — an order-of-magnitude gap is a statistics problem and the true root cause of most bad plans; (2) remember `actual time` is *per loop*, so multiply by `loops` for the real cost of an inner node; (3) `BUFFERS` shows `shared hit` (cache) versus `read` (from the OS/disk) — a node doing 900,000 buffer reads is your I/O; (4) look for the specific smells: `Seq Scan` on a big table with a selective filter, `Rows Removed by Filter` in the millions, a `Nested Loop` with a large outer row count, `Sort Method: external merge Disk: 512MB` meaning `work_mem` is too small, and a `Bitmap Heap Scan` with high `lossy` block counts. Use `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT TEXT)` and, on Postgres 16+, `GENERIC_PLAN` for parameterised statements. Also confirm the plan came from the same parameters and the same `work_mem` as production, or you are debugging a different query.

- **Why it matters** — It is the core diagnostic skill for anyone who owns a database.

- **Follow-ups** — Here is a plan with `rows=1` estimated and `rows=480000` actual — what do you do? Why does `loops` matter? What does "lossy" mean in a bitmap scan?

- **Senior signal** — Starts with the estimate-versus-actual gap rather than the top-line time, and mentions the per-loop multiplication that trips everyone up.

### Q71. B-tree, GIN, BRIN, GiST, hash — when do you use which?

- **Expected answer** — **B-tree** is the default and covers equality, ranges, sorting, and prefix `LIKE 'abc%'` with the right collation; it is what you want 90% of the time. **GIN** indexes composite values by their elements: full-text search `tsvector`, `jsonb` containment, and array membership; it is fast to search and expensive to write (mitigated by the pending list, `fastupdate`), and it is large. **BRIN** stores min/max summaries per block range, so it is tiny (kilobytes for a 100 GB table) and only useful when physical order correlates with the value — append-only time-series data on `created_at` is the perfect case; it is useless after random updates destroy correlation. **GiST** supports geometric, range and nearest-neighbour queries and backs exclusion constraints, for example non-overlapping booking `tstzrange`. **Hash** supports only equality, is WAL-logged and crash-safe since Postgres 10, and is occasionally smaller than B-tree for very large keys, but B-tree is almost always the safer choice. Decision shortcut: equality/range/sort -> B-tree; contains/search inside a document -> GIN; huge append-only table where you can accept coarse filtering -> BRIN; ranges and overlap -> GiST.

- **Why it matters** — Index-type choice has 100x effects on size and write throughput.

- **Follow-ups** — What is the write amplification of GIN on a high-ingest events table? How would you prove BRIN correlation is good? Why did your BRIN index stop helping after a backfill?

- **Senior signal** — Explains BRIN's correlation dependency and GIN's write cost, and gives a real table where each was the right call.

### Q72. How do you choose the column order in a composite index?

- **Expected answer** — A B-tree on `(a, b, c)` is sorted by `a`, then `b`, then `c`, so it can be used for predicates on a leading prefix: `a`, `a, b`, `a, b, c`. It cannot seek on `b` alone. So the rules are: equality columns first, then the range or sort column last. For the query `WHERE tenant_id = $1 AND status = $2 AND created_at > $3 ORDER BY created_at DESC`, the right index is `(tenant_id, status, created_at DESC)` — two equalities then the range, which also satisfies the `ORDER BY` and avoids a sort node. Putting `created_at` before `status` means the index can only range-scan on time and then filter, reading far more entries. Selectivity matters less than people think once equality/range ordering is right, but among equality columns put the more selective one first if queries vary, and consider whether one index can serve several queries by prefix — three indexes `(a)`, `(a,b)`, `(a,b,c)` are wasteful because `(a,b,c)` covers all three prefixes. Verify with `EXPLAIN`: look for "Index Cond" (used for seeking) versus "Filter" (checked after fetching), which is the direct evidence of whether a column is actually helping.

- **Why it matters** — Index design is the highest-value database skill and this is its core rule.

- **Follow-ups** — Why is `Filter` versus `Index Cond` the tell? When does `DESC` in the index definition actually matter? How many indexes is too many on a write-heavy table?

- **Senior signal** — The equality-then-range rule stated crisply, the prefix-redundancy insight, and using `Index Cond` versus `Filter` as evidence.

### Q73. What is a partial index and when is it the right answer?

- **Expected answer** — A partial index has a `WHERE` clause and indexes only the matching rows, so it is smaller, faster to scan and cheaper to maintain. It is the right answer whenever a small, hot subset of a large table is queried constantly. Two patterns I use repeatedly: a job/outbox queue where only pending rows matter, and a "one active row per key" constraint.

  ```sql
  CREATE INDEX jobs_pending ON jobs (run_at) WHERE status = 'pending';
  CREATE UNIQUE INDEX one_default_address ON addresses (user_id) WHERE is_default;
  ```

  The first turns a 200-million-row table into a 40,000-entry index that fits in cache; the second enforces a business rule the database can guarantee, which is far better than application checks that race. Requirements: the planner will only use it if it can prove the query predicate implies the index predicate, so the query must contain a matching condition — `status = 'pending'` written as a bound parameter sometimes fails that proof, which surprises people, so use a literal or check the plan. Also, if the definition uses a mutable expression like `now()`, it is not allowed, because index predicates must be immutable.

- **Why it matters** — Partial unique indexes are the cleanest way to express real business constraints.

- **Follow-ups** — Why might a parameterised query miss a partial index? How do you express "only one in-flight payment per order"? What happens to the index when a row's status changes?

- **Senior signal** — Uses partial *unique* indexes as constraints and knows the predicate-proof limitation.

### Q74. What is a covering index and what does `INCLUDE` do?

- **Expected answer** — A covering index contains every column a query needs, so Postgres can answer it with an **index-only scan** and never touch the heap. Since version 11 you can add non-key payload columns with `INCLUDE`, which keeps them out of the B-tree's ordering and comparison logic but stores them in the leaf pages.

  ```sql
  CREATE INDEX orders_lookup ON orders (tenant_id, created_at DESC) INCLUDE (status, total_minor);
  ```

  The important caveat: index-only scans still consult the **visibility map** to check whether each page is all-visible; if the table has recently changed and has not been vacuumed, Postgres falls back to heap fetches and the benefit disappears. `EXPLAIN` shows this as `Heap Fetches: 480312`. So a covering index on a heavily-updated table needs aggressive autovacuum to pay off. Costs: a wider index means fewer entries per page, more memory, and slower writes, so covering makes sense for a specific high-frequency query, not as a default. `INCLUDE` is also how you keep a unique index unique on `(a)` while still covering `b`.

- **Why it matters** — It is the difference between 1 ms and 40 ms on a hot list endpoint, but only if you understand the visibility-map dependency.

- **Follow-ups** — What does `Heap Fetches` in the plan tell you and how do you drive it to zero? When would you put a column in the key rather than `INCLUDE`? What is the write cost?

- **Senior signal** — Knows index-only scans depend on the visibility map and therefore on vacuum, which is the detail that separates reading a blog post from operating a database.
