## 19.8 VACUUM and autovacuum

### 19.8.1 What VACUUM does and why autovacuum falls behind

#### Concept

**VACUUM** is the garbage collector for MVCC. It walks a table, finds row versions that no transaction can see any more (dead tuples), removes their index entries, removes the tuples themselves, records the freed space so new rows can reuse it, marks pages that contain only visible rows in the **visibility map**, and freezes old tuples to prevent wraparound. It does *not* shrink the file (except trailing empty pages at the end) and it does *not* block reads or writes.

**Autovacuum** is the set of background workers that run VACUUM and ANALYZE automatically when a table has accumulated enough changes. It is on by default and must never be turned off; it only needs tuning.

#### Why does it exist?

Without VACUUM, every update and delete makes the table permanently bigger, the visibility map never says "all visible" (so index-only scans never happen), and transaction ids never freeze (so the database eventually shuts down). MVCC defers cleanup so that writes are fast; VACUUM is where the deferred cost is paid.

#### Mental model

Imagine a hotel where guests never check out formally; they just leave and the room stays marked "occupied" with their things inside. Housekeeping (VACUUM) walks the floors, checks which rooms are truly empty (nobody could still come back), removes the belongings, and marks the room free so a new guest can take it. If housekeeping is too slow, or a single guest keeps insisting "I might still need to see the old rooms", the hotel fills with ghost rooms and you must build a new wing (the table grows).

#### How it works

1. **Trigger.** The autovacuum launcher wakes every `autovacuum_naptime` (1 minute) and compares each table's dead-tuple count against `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples` (50 + 0.2 × rows). For analyze: `50 + 0.1 × rows`. PG 13+ also triggers on inserts: `1000 + 0.2 × rows` inserted since the last vacuum, so append-only tables get their visibility map and freezing maintained.
2. **Heap scan, phase 1.** A worker scans the table's pages, skipping pages the visibility map marks all-visible (or all-frozen, for aggressive vacuums). It collects the TIDs of dead tuples into memory (`autovacuum_work_mem`, falling back to `maintenance_work_mem`). It also prunes HOT chains and freezes tuples older than `vacuum_freeze_min_age`.
3. **Index vacuum.** For each index on the table, it scans the *entire index* and deletes entries whose TIDs are in the dead list. This is why many indexes make VACUUM slow: 10 indexes means 10 full index scans per batch. If the dead-TID array fills up (about 1 GB before PG 17), it must do this phase multiple times.
4. **Heap scan, phase 2.** It revisits pages with dead tuples, removes them, compacts the page, updates the **free space map** (FSM) with the free bytes, and sets the visibility-map bits for pages that are now all visible.
5. **Truncate.** If the tail of the file is empty pages, it takes a brief `ACCESS EXCLUSIVE` lock and truncates the file. This is the one moment VACUUM can conflict with queries; `vacuum_truncate = off` per table disables it.
6. **Catalog update.** `pg_class.reltuples`, `relpages`, `relfrozenxid` are updated; statistics for the planner are refreshed if ANALYZE runs too.
7. **Throttling.** Each page touched adds cost (`vacuum_cost_page_hit` 1, `vacuum_cost_page_miss` 2, `vacuum_cost_page_dirty` 20). When the accumulated cost reaches `autovacuum_vacuum_cost_limit` (200 by default, inherited from `vacuum_cost_limit`), the worker sleeps `autovacuum_vacuum_cost_delay` (2 ms). With defaults that is roughly 8 MB/s of reads and 4 MB/s of dirtying, which is far too slow for a modern SSD. RDS and other managed services raise the limit substantially; on self-managed systems set `autovacuum_vacuum_cost_limit = 1000` to `2000`.

Why autovacuum falls behind, with numbers:

| Cause | What you see | Fix |
|---|---|---|
| `scale_factor 0.2` on a 200 M row table | Vacuum starts only after 40 M dead tuples; table already 20 percent bloated | Per-table `autovacuum_vacuum_scale_factor = 0.01`, `threshold = 20000` |
| Throttling at 8 MB/s | A 100 GB table takes 3.5 hours per vacuum; dead tuples accumulate faster | Raise `autovacuum_vacuum_cost_limit`, lower `cost_delay` |
| 3 workers for 400 tables | Hot small tables wait behind one giant table's vacuum for hours | `autovacuum_max_workers = 6` (restart), partition giant tables |
| Long transaction or idle in transaction | Log says `N are dead but not yet removable, oldest xmin: X`; vacuum runs and frees nothing | `idle_in_transaction_session_timeout`, `statement_timeout`, kill the session |
| Replication slot with `hot_standby_feedback` | Same "not yet removable", horizon held by `pg_replication_slots.xmin` | Bound replica lag; accept query cancellation on the replica instead |
| Many indexes | Index vacuum phase dominates; each vacuum scans 10 indexes fully | Drop unused indexes (Part 20); PG 13+ `PARALLEL` index vacuum for manual runs |
| `autovacuum = off` "temporarily" | Bloat and wraparound risk accumulate silently | Never; tune instead |

#### Practical example

`orders` has 200 million rows and receives 900 updates per second, 60 percent of them non-HOT. That is 540 dead tuples per second, about 47 million per day. With default settings, autovacuum starts after 40 million dead tuples, roughly every 20 hours, and then must read the whole table (skipping all-visible pages, which by then are few) and scan 6 indexes. At the default throttle that takes 6 to 8 hours, during which another 15 million dead tuples appear. The table is never clean. With `scale_factor = 0.005` (1 million dead tuples) and `cost_limit = 2000`, vacuum runs every 30 minutes for about 4 minutes and the table stays within 2 percent bloat.

#### NestJS example

Autovacuum is a server-side concern, but the application decides whether it can succeed. Two application rules that matter more than any server knob: never hold a transaction across I/O you do not control, and always release query runners. A NestJS interceptor that refuses to let a request hold a transaction longer than a budget:

```ts
// transaction-budget.interceptor.ts
import {
  CallHandler, ExecutionContext, Injectable, NestInterceptor, RequestTimeoutException,
} from '@nestjs/common';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

@Injectable()
export class TransactionBudgetInterceptor implements NestInterceptor {
  // Requests that own a DB transaction must finish inside this budget,
  // so they can never hold the xmin horizon for minutes.
  constructor(private readonly budgetMs = 5_000) {}

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.budgetMs),
      catchError((err) =>
        err instanceof TimeoutError
          ? throwError(() => new RequestTimeoutException('transaction budget exceeded'))
          : throwError(() => err),
      ),
    );
  }
}
```

Pair it with the server-side belts (`idle_in_transaction_session_timeout`, `statement_timeout`) from 19.2; the interceptor gives up on the request, the server settings guarantee the backend does too.

#### PostgreSQL example

Per-table tuning for the hot tables, which is where most of the value is:

```sql
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor  = 0.005,   -- 1 M dead tuples on 200 M rows
  autovacuum_vacuum_threshold     = 50000,
  autovacuum_analyze_scale_factor = 0.002,
  autovacuum_vacuum_cost_limit    = 2000     -- let it use the SSD
);

ALTER TABLE inventory SET (
  autovacuum_vacuum_scale_factor = 0.0,      -- pure threshold on a small hot table
  autovacuum_vacuum_threshold    = 5000,
  autovacuum_vacuum_cost_delay   = 0         -- no throttling; the table is 60 MB
);
```

Watch it work:

```sql
-- What are the workers doing right now?
SELECT p.pid, a.query_start, c.relname, p.phase,
       p.heap_blks_total, p.heap_blks_scanned, p.heap_blks_vacuumed,
       p.index_vacuum_count, p.num_dead_tuples
FROM pg_stat_progress_vacuum p
JOIN pg_stat_activity a USING (pid)
JOIN pg_class c ON c.oid = p.relid;
```

```text
 pid  | query_start | relname | phase             | heap_blks_total | heap_blks_scanned | heap_blks_vacuumed | index_vacuum_count | num_dead_tuples
------+-------------+---------+-------------------+-----------------+-------------------+--------------------+--------------------+-----------------
 4411 | 10:02:11    | orders  | vacuuming indexes |         3921033 |           3921033 |                  0 |                  1 |         1044201
```

```sql
-- Which tables are behind?
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / greatest(n_live_tup, 1), 1) AS dead_pct,
       last_autovacuum, autovacuum_count
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
```

Set `log_autovacuum_min_duration = 1000` (ms) and read the log lines; they contain the single most useful diagnostic sentence in PostgreSQL:

```text
LOG:  automatic vacuum of table "shop.public.orders": index scans: 1
      pages: 0 removed, 3921033 remain, 402011 scanned (10.25% of total)
      tuples: 1044201 removed, 200912311 remain, 8812001 are dead but not yet removable
      removable cutoff: 48812201, which was 3120041 XIDs old when operation ended
      index scan needed: 380211 pages from table (9.70% of total) had 1044201 dead item identifiers removed
      avg read rate: 41.2 MB/s, avg write rate: 12.3 MB/s
      system usage: CPU: user: 12.11 s, system: 4.02 s, elapsed: 241.31 s
```

`8812001 are dead but not yet removable` with a cutoff 3 million xids old means something has held a snapshot for 3 million transactions; go find it in `pg_stat_activity` (19.7.3 shows the query).

#### TypeORM example

Bulk deletes are a classic way to produce a mountain of dead tuples at once. Batch them and give autovacuum a chance between batches:

```ts
// Purge abandoned carts older than 30 days without creating 50 M dead tuples in one go
async purgeAbandonedCarts(dataSource: DataSource): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await dataSource.query(
      `DELETE FROM carts
        WHERE id IN (SELECT id FROM carts
                      WHERE status = 'ABANDONED' AND updated_at < now() - interval '30 days'
                      LIMIT 5000)`,
    );
    const deleted = Number(result[1] ?? 0);   // pg returns [rows, rowCount] for DELETE via TypeORM query()
    total += deleted;
    if (deleted < 5000) return total;
    await new Promise((r) => setTimeout(r, 200));   // let autovacuum and replicas breathe
  }
}
```

For "delete everything older than X" on very large tables, partition by time and `DROP` the partition: no dead tuples at all.

#### Sequelize example

```ts
let deleted: number;
do {
  [, deleted] = await sequelize.query(
    `DELETE FROM carts WHERE id IN (
       SELECT id FROM carts WHERE status = 'ABANDONED' AND updated_at < now() - interval '30 days' LIMIT 5000)`,
    { type: QueryTypes.DELETE } as any,
  ) as unknown as [unknown, number];
  await new Promise((r) => setTimeout(r, 200));
} while (deleted === 5000);
```

#### Production scenario

A 1 TB database with 300 tables: `autovacuum_max_workers = 6`, `autovacuum_naptime = 30s`, `autovacuum_vacuum_cost_limit = 2000`, `autovacuum_vacuum_cost_delay = 2ms`, `maintenance_work_mem = 1GB`, and per-table overrides on the 8 hottest tables. Vacuum I/O runs at 30 to 60 MB/s continuously and is budgeted as part of the disk IOPS plan. Alerts: `n_dead_tup` above 5 percent of `n_live_tup` on any table over 1 GB, any table not vacuumed in 24 hours that has writes, `backend_xmin` age above 50 million, and vacuum log lines with "not yet removable" above 1 million.

What can go wrong? Starvation, horizon holders, truncation lock conflicts on replicas. How do I monitor it? The four alerts above plus `pg_stat_progress_vacuum`. How do I scale it? More workers, higher cost limit, fewer indexes, partitioning. When should I not touch it? Do not disable it, and do not run manual `VACUUM` in cron on tables autovacuum already handles unless you have measured a gap.

#### Failure scenario

"Idle in transaction from a forgotten `await` blocked vacuum for 3 days." A payments reconciliation worker did this:

```ts
const qr = dataSource.createQueryRunner();
await qr.connect();
await qr.startTransaction();
qr.query('INSERT INTO reconciliation_runs ...');   // missing await: promise abandoned
await qr.commitTransaction();                      // throws on some paths; finally { release } was missing
```

On one code path an exception fired between `startTransaction` and `commitTransaction`, the `QueryRunner` was never released, and the connection sat in the pool `idle in transaction` with an open snapshot. The worker ran once a day and leaked one connection per run. By day three, `orders` had 130 million "dead but not yet removable" tuples, the checkout p99 was 3 times its baseline, and the pool had lost three connections. Detection took ten minutes once someone looked at `pg_stat_activity` sorted by `xact_start`. Prevention: `idle_in_transaction_session_timeout = '60s'` for application roles, a `finally { await qr.release() }` rule enforced in code review, and an alert on any backend `idle in transaction` for more than 2 minutes.

#### Edge cases & failure modes

- Vacuum's tail truncation takes `ACCESS EXCLUSIVE` briefly; on replicas with `hot_standby_feedback` off this can cancel long queries.
- `maintenance_work_mem` too small forces multiple index-vacuum passes on huge tables.
- Toast tables have their own autovacuum settings and are easy to forget.
- Per-table `autovacuum_enabled = false` left over from a migration.
- A table that receives only inserts never triggered vacuum before PG 13, so its visibility map was empty and index-only scans did nothing.
- Manual `VACUUM` in a cron job that overlaps with autovacuum on the same table: they serialise, no harm, but wasted time.
- Autovacuum workers are killed by DDL that needs a conflicting lock (regular autovacuum yields; anti-wraparound does not).

#### How a Senior Backend Engineer thinks about this

They treat autovacuum as a first-class workload with an I/O budget, not as background noise. They tune per table rather than globally. They know the "dead but not yet removable" line by heart. They design write paths that generate fewer dead tuples in the first place. And they ask, for every long-running thing that touches the database: "what snapshot does it hold, and for how long?"

#### Common mistakes

- Disabling autovacuum because "it was using I/O during the incident".
- Leaving defaults on tables with hundreds of millions of rows.
- Running `VACUUM FULL` in production as a routine.
- Blaming "the database is slow" when the cause is a client holding a transaction open.

#### Interview questions

1. *Walk through what VACUUM does, phase by phase.* Expected: heap scan collecting dead TIDs, index vacuum per index, heap cleanup and FSM/VM updates, truncation, catalog update.
2. *Why does autovacuum fall behind on very large tables with default settings?* Expected: `scale_factor 0.2` and throttling; per-table tuning.
3. *What does "dead but not yet removable" mean and what do you do?* Expected: horizon held by a snapshot; find and end it.
4. *Does VACUUM shrink the table file?* Expected: only trailing empty pages; `pg_repack` or `VACUUM FULL` for a rewrite.
5. *Why do many indexes make VACUUM expensive?*

#### Practical exercise

Create `orders` with 20 million rows and 5 indexes. Run 2 million random updates on an indexed column. Watch `pg_stat_progress_vacuum` during the autovacuum, and capture the `log_autovacuum_min_duration` line. Then tune the table with per-table settings and repeat. Acceptance criteria: you report the vacuum duration, the index scan count and the read/write rates for both runs, and you explain the difference.

### 19.8.2 Bloat measurement, VACUUM FULL and pg_repack

#### Concept

**Bloat** is the gap between the space a table (or index) uses on disk and the space its live data needs. VACUUM keeps bloat from growing but does not remove it once it exists. Removing it requires a rewrite: `VACUUM FULL` (locks the table for the whole duration) or `pg_repack` (online, with a short lock at the end).

#### Why does it exist?

Because free space inside a heap is reusable but not returnable to the OS without rewriting the file, and because rewriting a 200 GB table cannot be done for free. The tools exist for the cases where bloat has already happened: after a bulk delete, after a period of vacuum starvation, or after a schema change that rewrote every row.

#### Mental model

Imagine a bookshelf where removed books leave gaps. New books go into the gaps (VACUUM makes this possible), but the shelf never gets shorter. To reclaim the length you have to take all the books off and put them back tightly (`VACUUM FULL`, shop closed) or build a second shelf next to it, move books across while the shop stays open, and swap the shelves at closing time (`pg_repack`).

#### How it works

1. **Measuring.** `pgstattuple` gives exact numbers by scanning the whole table (`pgstattuple('orders')` returns `dead_tuple_percent`, `free_percent`); `pgstattuple_approx` samples the visibility map and is fast enough for cron. Estimation queries based on `pg_stats.avg_width` (widely shared as the "bloat query") are roughly right without scanning. `pg_relation_size` vs `n_live_tup × average row width` is the quick sanity check.
2. **`VACUUM FULL`** takes an `ACCESS EXCLUSIVE` lock, copies live tuples into a new file, rebuilds every index, swaps files, and drops the old ones. It needs up to twice the table's size in free disk. Nobody can read or write the table until it finishes: on a 100 GB table, 20 to 60 minutes of total outage for that table.
3. **`pg_repack`** (an extension plus a CLI) creates a log table with a trigger to capture changes, copies the table into a new one, builds indexes, replays the log, then takes a brief `ACCESS EXCLUSIVE` lock to swap. Needs twice the space, runs for as long as `VACUUM FULL` would, but the table stays online. It also repacks indexes individually (`pg_repack -i`).
4. **`REINDEX CONCURRENTLY`** (PG 12+) handles index-only bloat online; Part 20 covers it.
5. **`CLUSTER`** is `VACUUM FULL` that also orders rows by an index; same lock.

| Tool | Lock | Extra disk | Table online? | Use |
|---|---|---|---|---|
| `VACUUM` | none that matters | none | yes | continuously |
| `VACUUM FULL` | `ACCESS EXCLUSIVE` for the whole run | 2× | no | small tables, maintenance windows |
| `pg_repack` | brief `ACCESS EXCLUSIVE` at swap | 2× | yes | large hot tables |
| `REINDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | 2× index | yes | index bloat |

#### PostgreSQL example

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT * FROM pgstattuple_approx('orders');
```

```text
 table_len    | scanned_percent | approx_tuple_count | approx_tuple_len | approx_tuple_percent | dead_tuple_count | dead_tuple_len | dead_tuple_percent | approx_free_space | approx_free_percent
--------------+-----------------+--------------------+------------------+----------------------+------------------+----------------+--------------------+-------------------+---------------------
 42011230208  |           12.4  |          200912311 |      22100354210 |                52.6  |          1044201 |      114862110 |               0.27 |       18240011000 |               43.4
```

43 percent free space with almost no dead tuples means VACUUM did its job, but the file is twice the size of the data. Rewrite it online:

```bash
pg_repack --dbname shop --table public.orders --jobs 4 --no-superuser-check
```

For a small table in a maintenance window, `VACUUM FULL orders;` is fine; for a 40 GB table serving checkout, it is an outage.

#### Production scenario

Quarterly, a job runs `pgstattuple_approx` on every table over 1 GB and files a ticket for anything above 30 percent free space. `pg_repack` runs at 03:00 on the worst two, with disk headroom verified first (`pg_repack` on a 40 GB table needs 40 GB free plus index space). The job is skipped automatically if replication lag is above 30 s, because the copy produces a burst of WAL.

#### Failure scenario

`VACUUM FULL products` was run on a Friday afternoon to "fix a slow query". It took an `ACCESS EXCLUSIVE` lock, and because the products table is joined by nearly every endpoint, every API request queued behind it for 35 minutes (the lock queue mechanism in 19.11). The slow query was later fixed by an index; the bloat was irrelevant to it.

#### Edge cases & failure modes

- `pg_repack` needs the extension installed on the server and free disk; it aborts (safely) if it cannot get the final lock within its timeout, and must be rerun.
- `pg_repack` on a table with a long-running transaction waits for it, or with `--no-kill-backend` off, kills it.
- `VACUUM FULL` on a table with foreign keys referencing it still requires the exclusive lock, and queries on referencing tables that check the FK wait too.
- Rewrites invalidate cached plans and change ctids; nothing in the application should depend on ctids.

#### How a Senior Backend Engineer thinks about this

They ask whether bloat is actually causing a symptom before rewriting anything: 40 percent free space on a table read only by primary key costs disk, not latency. They schedule rewrites like deploys, with disk checks, replica lag checks, and a rollback story.

#### Common mistakes

- `VACUUM FULL` on a hot table during business hours.
- Rewriting without enough free disk and running the server out of space.
- Confusing "bloat" with "dead tuples"; a fully vacuumed table can still be bloated.

#### Interview questions

1. *What is the difference between VACUUM and VACUUM FULL?* Expected: in-place cleanup vs full rewrite under an exclusive lock.
2. *How does pg_repack avoid the long lock?* Expected: copy plus change log replay, brief swap.
3. *How would you decide whether a bloated table needs a rewrite?*

#### Practical exercise

Bloat a 5 million row table by deleting 70 percent of rows. Measure with `pgstattuple`. Reclaim with `VACUUM FULL` while a second session tries to `SELECT`; observe the wait. Restore the bloat and reclaim with `pg_repack`; observe that the second session continues. Acceptance criteria: sizes before and after, lock wait evidence from `pg_stat_activity`, and a written rule for when you would use each.

## 19.9 ANALYZE and planner statistics

### 19.9.1 Statistics, `pg_stats`, and stale stats after bulk loads

#### Concept

**ANALYZE** samples a table and stores summary statistics about each column: how many distinct values, which values are most common and how often, a histogram of the value distribution, how many nulls, the average width, and how well the physical row order matches the column's order. The **planner** uses these to estimate how many rows each step of a query will return, which decides whether it uses an index, which join method it picks, and in which order it joins tables. Autovacuum runs ANALYZE automatically after roughly 10 percent of a table changes.

#### Why does it exist?

The planner cannot look at the data while planning; that would be as slow as running the query. It needs a cheap, approximate picture. When the picture is wrong (stale after a bulk load, too coarse for a skewed column, blind to correlations between columns), the planner makes confident, wrong decisions: a nested loop over 10 million rows because it expected 10.

#### Mental model

Imagine planning a road trip using a map that shows the *usual* traffic. If the map is from before a new stadium was built, you will route past it on game day. ANALYZE redraws the map; `default_statistics_target` decides how detailed it is.

#### How it works

1. ANALYZE reads a random sample of `300 × default_statistics_target` rows (30,000 rows by default), chosen by random block sampling, so it costs seconds even on a terabyte table.
2. From the sample it computes, per column, and stores in `pg_statistic` (viewable through `pg_stats`):
   - `null_frac`: fraction of nulls.
   - `avg_width`: average bytes per value.
   - `n_distinct`: number of distinct values; positive is an absolute count, negative is a fraction of rows (`-1` means unique).
   - `most_common_vals` and `most_common_freqs` (MCV): the top values and their frequencies, up to `statistics_target` entries.
   - `histogram_bounds`: equal-frequency buckets over the remaining values, used for range estimates.
   - `correlation`: from -1 to 1, how well the physical order follows the column order; near 1 means an index scan reads the heap almost sequentially, which makes the planner prefer index scans over bitmap scans.
3. Expression indexes get their own statistics rows (under the index name in `pg_stats`), collected only when ANALYZE runs after the index exists.
4. Selectivity estimation: `status = 'PENDING'` looks up the MCV list; `created_at > now() - interval '1 day'` interpolates in the histogram; `user_id = $1` with an unknown value uses `1 / n_distinct`; two conditions are multiplied as if independent (the correlation problem, solved by extended statistics in 19.12).
5. Autoanalyze triggers at `50 + 0.1 × rows` changed rows. For a table that goes from 0 to 50 million rows in one bulk load, autoanalyze fires *after* the load, some time in the next minute, and until then the planner believes the table is empty.

#### Practical example

A new `order_items` table is created by a migration and back-filled with 80 million rows in a 20-minute `INSERT ... SELECT`. Traffic switches to the new table immediately. For the next 90 seconds, `pg_class.reltuples` is 0, the planner estimates every filter returns 1 row, chooses nested-loop joins everywhere, and a query that should take 5 ms takes 40 s. Then autoanalyze finishes and everything is fine, which makes the incident look like a mystery. The rule: `ANALYZE order_items` is the last statement of every bulk load, before traffic.

#### PostgreSQL example

```sql
-- Look at what the planner believes about orders.status
SELECT attname, null_frac, n_distinct, most_common_vals, most_common_freqs, correlation
FROM pg_stats
WHERE tablename = 'orders' AND attname IN ('status', 'user_id', 'created_at');
```

```text
 attname    | null_frac | n_distinct | most_common_vals                   | most_common_freqs                    | correlation
------------+-----------+------------+------------------------------------+--------------------------------------+-------------
 status     |         0 |          4 | {PAID,SHIPPED,CANCELLED,PENDING}   | {0.612,0.371,0.0129,0.0041}          |     0.11
 user_id    |         0 |    2803991 |                                    |                                      |     0.03
 created_at |         0 |         -1 |                                    |                                      |     0.99
```

`status = 'PENDING'` is estimated at 0.41 percent: the planner will happily use a partial index. `created_at` has correlation 0.99: range scans on it are cheap index scans. `user_id` shows 2.8 million distinct values in the sample; the real number is 5 million (sampling underestimates distinct counts for high-cardinality columns), which makes the planner overestimate rows per user by nearly two times. Fix it explicitly:

```sql
ALTER TABLE orders ALTER COLUMN user_id SET (n_distinct = 5000000);
ALTER TABLE orders ALTER COLUMN status  SET STATISTICS 500;   -- more MCV detail for the skewed column
ANALYZE orders;
```

Watch for stale statistics:

```sql
SELECT relname, n_mod_since_analyze, last_analyze, last_autoanalyze, n_live_tup
FROM pg_stat_user_tables
WHERE n_mod_since_analyze > 0.05 * greatest(n_live_tup, 1)
ORDER BY n_mod_since_analyze DESC;
```

#### TypeORM example

Make ANALYZE part of the migration that back-fills, so nobody has to remember:

```ts
export class BackfillOrderItems1725600001000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`INSERT INTO order_items (order_id, product_id, quantity, price_cents)
                    SELECT order_id, product_id, quantity, price_cents FROM legacy_order_lines`);
    await qr.query(`ANALYZE order_items`);   // refresh planner stats before traffic arrives
  }
  async down(): Promise<void> {}
}
```

#### Sequelize example

```ts
await queryInterface.bulkInsert('order_items', rows);      // or a COPY-based loader
await queryInterface.sequelize.query('ANALYZE order_items');
```

#### Production scenario

Nightly ETL replaces a 30 million row `product_prices` table with `TRUNCATE` and reload. The job ends with `ANALYZE product_prices`, and the on-call runbook lists "stats stale?" as the first check for any sudden plan change. `default_statistics_target` is 200 globally (cost: ANALYZE samples 60,000 rows, negligible) and 1,000 on three skewed columns. `auto_explain` (19.14) logs any query over 500 ms with its plan so that a plan flip after ANALYZE is visible within minutes.

#### Failure scenario

"Plan flips after ANALYZE." A query on `orders WHERE status = 'PENDING' AND created_at > $1` ran in 3 ms for months. One autoanalyze sampled a period where a payment provider outage had left 8 percent of recent orders `PENDING`; the MCV frequency for `PENDING` jumped from 0.4 percent to 2 percent, the estimated row count crossed the threshold where a bitmap heap scan looked cheaper than the partial index scan, and the query went to 400 ms across 200 requests per second. It flipped back at the next analyze. The fix was a composite partial index that is cheap under both estimates, and `SET STATISTICS 1000` on `status`; the deeper lesson was that plan stability matters as much as plan speed.

#### Edge cases & failure modes

- Stats after bulk load, `TRUNCATE`, or partition attach are empty or stale until ANALYZE runs.
- `n_distinct` underestimation on high-cardinality columns in huge tables.
- Expression indexes without a following ANALYZE have no statistics.
- Statistics on parent partitioned tables are not collected by autovacuum (through PG 15); run `ANALYZE parent` manually for queries that scan many partitions.
- Very wide MCV lists on `text` columns bloat `pg_statistic` and slow planning slightly.
- Temporary tables have no stats until you ANALYZE them, which matters for large ETL temp tables.

#### How a Senior Backend Engineer thinks about this

They treat "ANALYZE after bulk change" as a rule with no exceptions. They raise statistics targets per column with evidence (skewed MCV, bad estimates in `EXPLAIN ANALYZE`). They know that an estimate off by 100 times is the smoking gun in most slow-plan investigations, and they look at `rows=` estimated vs actual before anything else.

#### Common mistakes

- Backfilling and switching traffic without ANALYZE.
- Raising `default_statistics_target` to 10,000 globally "to be safe" and making ANALYZE and planning slower everywhere.
- Ignoring `n_mod_since_analyze`.

#### Interview questions

1. *What does ANALYZE collect and how does the planner use it?* Expected: null fraction, n_distinct, MCV, histogram, correlation; selectivity estimation and cost.
2. *A query is 1,000 times slower right after a big data load. First suspect?* Expected: stale statistics; run ANALYZE.
3. *Why can the same query plan differently on two days?* Expected: sampled statistics changed.
4. *When would you set `n_distinct` manually?*

#### Practical exercise

Create an empty `orders` table, insert 10 million rows in one statement, and immediately run `EXPLAIN (ANALYZE)` on a join with `order_items` before autoanalyze fires. Capture the estimated vs actual rows and the plan. Run `ANALYZE` and repeat. Acceptance criteria: you present both plans, identify the misestimate, and add the `ANALYZE` to a migration.
