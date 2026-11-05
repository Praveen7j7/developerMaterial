## 19.19 Finding missing indexes

### 19.19.1 pg_stat_statements, seq_scan, auto_explain and hypopg

#### Concept

PostgreSQL has no "missing index" view. SQL Server invents one and it is famously wrong. What PostgreSQL gives you is better: four sources of evidence that, combined, tell you exactly which query is costing you the most and what an index would do about it before you build it.

1. **`pg_stat_statements`** ranks queries by total time. This is where you start, always.
2. **`pg_stat_user_tables`** shows which tables are being sequentially scanned and how many rows those scans read.
3. **`auto_explain`** captures the actual plan of slow statements as they happen.
4. **`hypopg`** lets you create a *hypothetical* index and ask the planner what it would do, without building anything.

#### Why does it exist?

Because the query you *think* is slow is usually not the query that is costing you. A query that takes 900 ms and runs twice a day costs 1.8 seconds a day. A query that takes 14 ms and runs 3,000 times a second costs 42 seconds *per second*. Total time, not mean time, is what you optimise.

#### Mental model

A restaurant losing money. You do not start with the dish the chef finds most annoying to cook. You start with the ledger: which line item, multiplied by how often it is sold, accounts for the biggest share of cost? That is `total_exec_time`. Only then do you look at how the dish is made.

#### How it works

**Step 1: rank by total time.**

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;   -- needs shared_preload_libraries

SELECT
  round(total_exec_time::numeric, 0)              AS total_ms,
  calls,
  round(mean_exec_time::numeric, 2)               AS mean_ms,
  round(max_exec_time::numeric, 2)                AS max_ms,
  round(stddev_exec_time::numeric, 2)             AS stddev_ms,
  rows,
  round(100.0 * shared_blks_hit /
        nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
  left(regexp_replace(query, '\s+', ' ', 'g'), 90) AS query
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT 10;
```

```text
 total_ms   | calls    | mean_ms | max_ms  | stddev_ms | rows      | hit_pct | query
------------+----------+---------+---------+-----------+-----------+---------+--------------------------------
 41882014   | 18204112 |    2.30 | 9104.22 |    118.44 | 364082240 |    91.2 | SELECT id, status, total_cents FROM orders WHERE user_id = $1 AND status
  9814402   |    41882 |  234.34 | 1204.88 |     88.12 |   4188200 |    62.1 | SELECT count(*), kind FROM notifications WHERE created_at >= $1 GROUP BY
  4211884   |  8214402 |    0.51 |   84.22 |      1.94 |   8214402 |    99.8 | SELECT * FROM users WHERE id = $1
  2884102   |    18204 |  158.43 | 2104.11 |    204.88 |    918204 |    41.2 | SELECT p.id, p.name FROM products p WHERE p.attributes @> $1
  1204882   |   918204 |    1.31 |  412.88 |     18.22 |  18364080 |    97.4 | SELECT * FROM order_items WHERE order_id = $1
```

Read the columns together, not one at a time:

- **Row 1** is 41,882 seconds of total database time, 42 percent of everything. Its mean is a comfortable 2.3 ms but `max_ms` is 9,104 and `stddev` is 118. **A stddev 50 times the mean means parameter-dependent plans**: some users are cheap and some are catastrophic. This is the query to fix, and 19.23 fixes it.
- **Row 2** has a 62 percent buffer hit rate: it is reading from disk. A candidate for BRIN or a rollup.
- **Row 3** is 8.2 million calls at 0.51 ms with 99.8 percent hits. This is healthy. Do not touch it. If you want it faster, the answer is caching (Part 26 — Caching), not indexing.
- **Row 4** has a 41 percent hit rate and 158 ms mean: the GIN index probably does not exist yet.

Reset the counters when you start an optimisation cycle so the numbers describe the current system:

```sql
SELECT pg_stat_statements_reset();
```

**Step 2: find the tables being scanned.**

```sql
SELECT
  relname,
  seq_scan, seq_tup_read,
  CASE WHEN seq_scan > 0 THEN seq_tup_read / seq_scan ELSE 0 END AS avg_rows_per_seq_scan,
  idx_scan,
  n_live_tup,
  pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_tup_read DESC
LIMIT 10;
```

```text
   relname     | seq_scan | seq_tup_read  | avg_rows_per_seq_scan | idx_scan  | n_live_tup  | size
---------------+----------+---------------+-----------------------+-----------+-------------+--------
 orders        |    41882 | 8376400000000 |             200000000 | 641882014 | 200000000   | 30 GB
 products      |  1820441 |  728176400000 |                400000 |   8214402 |    400000   | 420 MB
 categories    | 18204112 |   22573101880 |                  1240 |         0 |      1240   | 128 KB
 notifications |      882 |  1058400000000 |            1200000000 | 918204112 | 1200000000  | 210 GB
```

Interpretation, row by row:

- `orders`: 41,882 full scans of a 200 million row table. Each one reads 30 GB. That is 1.25 petabytes of reads. Something is scanning this table and it should not be.
- `products`: 1.8 million full scans of 400,000 rows each. The table is small enough that each scan is only 420 MB and takes 210 ms, so nobody complained, but 1.8 million x 210 ms is 106 hours of database time. **This is the classic hidden cost: a table small enough to scan and big enough to matter.**
- `categories`: 18 million sequential scans and `idx_scan = 0`. This is **correct**. At 1,240 rows in 16 pages, a sequential scan is faster than any index and the whole table is permanently in cache. Do not add an index here.
- `notifications`: only 882 scans, but each reads 1.2 billion rows. Those are the analytics queries from row 2 of `pg_stat_statements`.

The key ratio is `seq_tup_read / seq_scan`. Small means small tables (fine). Large means a big table is being fully scanned (investigate).

**Step 3: capture the actual plans.**

```text
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = '500ms'
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_verbose = off
auto_explain.log_nested_statements = on   # catches statements inside functions and triggers
auto_explain.log_timing = off             # cheaper on high-row plans
auto_explain.sample_rate = 0.2            # 20 percent, to bound the logging cost
```

`log_nested_statements` matters more than people expect: ORM-generated queries inside a stored procedure, or a slow query inside a trigger, are invisible without it.

**Step 4: ask the planner what an index would do, without building it.**

```sql
CREATE EXTENSION IF NOT EXISTS hypopg;

-- Create a hypothetical index. Nothing is written to disk; it exists only in this session.
SELECT * FROM hypopg_create_index(
  'CREATE INDEX ON orders (user_id, status, created_at DESC)'
);
```

```text
 indexrelid |                 indexname
------------+--------------------------------------------
      13452 | <13452>btree_orders_user_id_status_created_at
```

```sql
EXPLAIN SELECT id, status, total_cents FROM orders
WHERE user_id = 918273 AND status = 'PAID' ORDER BY created_at DESC LIMIT 20;
```

```text
Limit  (cost=0.57..41.22 rows=20 width=20)
  ->  Index Scan using "<13452>btree_orders_user_id_status_created_at" on orders
        (cost=0.57..214.44 rows=104 width=20)
        Index Cond: ((user_id = 918273) AND (status = 'PAID'::text))
```

The planner *chose* the hypothetical index and the estimated cost dropped from 412,188 to 41. That is a strong signal, obtained in one second, with zero disk written and zero locks taken.

```sql
SELECT hypopg_get_indexdef(13452);          -- what it would be
SELECT pg_size_pretty(hypopg_relation_size(13452));   -- estimated size: 7412 MB
SELECT hypopg_reset();                      -- clean up (also happens at session end)
```

`hypopg` cannot give you `EXPLAIN ANALYZE`, because the index does not exist and cannot be executed against. It gives you the planner's *choice* and its *estimated* cost and size, which is exactly enough to decide whether the real build is worth 26 minutes.

#### Practical example

An afternoon of index work, in order:

1. `pg_stat_statements` ordered by `total_exec_time` gives 5 candidates covering 71 percent of database time.
2. For each, `EXPLAIN (ANALYZE, BUFFERS)` with both a typical and a worst-case parameter.
3. For the two with estimate errors above 10x, `ANALYZE` and `CREATE STATISTICS` first, then re-explain. Two of the five are now fixed with no index at all.
4. For the remaining three, `hypopg` the candidate index and confirm the planner picks it and the estimated cost collapses.
5. Check whether an existing index can be extended instead (19.20's redundancy query).
6. Measure the size estimate and the write cost on a staging restore.
7. Build with `CREATE INDEX CONCURRENTLY`, one per migration.

#### NestJS example

A scheduled job that ships the top queries to your metrics system, so index work is driven by data instead of by whoever complains loudest:

```ts
// db-insights.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

@Injectable()
export class DbInsightsService {
  private readonly log = new Logger(DbInsightsService.name);
  constructor(private readonly ds: DataSource) {}

  @Cron(CronExpression.EVERY_HOUR)
  async reportTopQueries() {
    const rows = await this.ds.query(`
      SELECT queryid, calls,
             round(total_exec_time::numeric, 0) AS total_ms,
             round(mean_exec_time::numeric, 2)  AS mean_ms,
             round(stddev_exec_time::numeric, 2) AS stddev_ms,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 200) AS query
      FROM pg_stat_statements
      WHERE calls > 100
      ORDER BY total_exec_time DESC
      LIMIT 20`);

    for (const r of rows) {
      // Emit as metrics; a stddev far above the mean means parameter-dependent plans.
      this.log.log({
        msg: 'pg_top_query',
        queryid: r.queryid,
        totalMs: Number(r.total_ms),
        meanMs: Number(r.mean_ms),
        skew: Number(r.stddev_ms) / Math.max(Number(r.mean_ms), 0.01),
        query: r.query,
      });
    }
  }
}
```

Alert on `skew > 20` for any query in the top 10. That single alert catches the "fast for most users, 40 seconds for one" class of bug before the customer does.

#### Edge cases & failure modes

- `pg_stat_statements.max` defaults to 5,000 distinct queries; on a system with unnormalised SQL (string-concatenated values) it overflows and the numbers become meaningless. Always use parameterised queries.
- `pg_stat_statements` normalises constants but not `IN` list lengths before PG 14, so `IN (1,2)` and `IN (1,2,3)` are separate entries.
- Statistics are cumulative since the last reset or restart; a number without a `stats_reset` timestamp is uninterpretable.
- `seq_scan` counts scans, not their cost; a 16-page table with 18 million scans is fine, a 3.9 million page table with 40,000 is not.
- `auto_explain` with `log_analyze = on` and `log_timing = on` adds real overhead on high-row plans; use sampling and turn timing off.
- `hypopg` only supports B-tree, BRIN and hash hypothetical indexes; it cannot simulate GIN or GiST.
- On replicas, statistics are per-node; an index unused on the primary may be the busiest one on a replica.

#### How a Senior Backend Engineer thinks about this

They optimise total time, not the loudest complaint. They look at `stddev/mean` to find parameter-dependent plans, which are the bugs that page you at 3 a.m. They use `hypopg` to make index decisions cheap and reversible. And they always ask whether the answer is an index, a query rewrite, a rollup table, or a cache, in that order of increasing architectural commitment.

#### Interview questions

1. *How do you find which query to optimise first?* Expected: `pg_stat_statements` by `total_exec_time`, not `mean_exec_time`.
2. *What does a high `stddev_exec_time` relative to the mean tell you?* Expected: parameter-dependent plans or data skew; find the bad parameter.
3. *A table has 18 million sequential scans. Is that a problem?* Expected: depends on size; 1,240 rows in 16 pages is correct behaviour.
4. *How do you evaluate an index before building it on a 200 million row table?* Expected: `hypopg` plus the planner's choice and estimated cost and size, then a staging build for the real timing.
5. *What does `auto_explain.log_nested_statements` catch?* Expected: slow statements inside functions and triggers.

## 19.20 Finding unused and duplicate indexes

### 19.20.1 idx_scan = 0, redundant prefixes, and dropping safely

#### Concept

Every database that has been alive for three years has indexes nobody uses. Finding them is a ten-line query. Dropping them safely is the part that requires discipline, because `idx_scan = 0` on the primary does not mean unused, and dropping a unique index changes semantics, not just performance.

#### The unused-index query

```sql
SELECT
  s.schemaname, s.relname AS table_name, s.indexrelname AS index_name,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
  s.idx_scan,
  i.indisunique, i.indisprimary,
  pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisprimary
  AND pg_relation_size(s.indexrelid) > 8 * 1024 * 1024   -- ignore anything under 8 MB
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

```text
 table_name    |        index_name         |  size   | idx_scan | indisunique | indisprimary
---------------+---------------------------+---------+----------+-------------+--------------
 notifications | idx_notifications_payload | 84 GB   |        0 | f           | f
 orders        | idx_orders_updated_at     | 4218 MB |        0 | f           | f
 orders        | idx_orders_tenant_id      |  921 MB |        0 | f           | f
 order_items   | idx_order_items_price     | 3104 MB |        0 | f           | f
 reviews       | uq_reviews_legacy_key     |  412 MB |        0 | t           | f
```

92 GB of indexes that have never been scanned. But look at the last row: `indisunique = true`. That index is enforcing a constraint. `idx_scan = 0` for a unique index means nobody *queries* it, not that nobody *needs* it, because it is doing its job on every insert. Never drop a unique index on the basis of `idx_scan`.

#### The duplicate and redundant-prefix query

An index `(a)` is **redundant** if `(a, b)` exists, because any query the first can serve, the second can serve too, using its leading prefix. It is not always exactly as fast (the wider index has fewer entries per page, so scans read more pages), but the difference is usually 10 to 20 percent, and dropping a whole index is worth 10 percent on one query.

```sql
-- Exact duplicates: same columns, same order, same predicate, same opclass
SELECT
  indrelid::regclass AS table_name,
  array_agg(indexrelid::regclass) AS duplicates,
  pg_size_pretty(sum(pg_relation_size(indexrelid))) AS total_size
FROM pg_index
GROUP BY indrelid, indkey, indclass, indexprs, indpred
HAVING count(*) > 1;
```

```text
 table_name |                     duplicates                     | total_size
------------+----------------------------------------------------+------------
 orders     | {idx_orders_user_id, orders_user_id_idx}           | 8420 MB
```

Two identically defined indexes, 8.4 GB, created by a developer and by a TypeORM `synchronize` run. Drop one and reclaim 4.2 GB immediately.

```sql
-- Redundant prefixes: index A's columns are a leading prefix of index B's
SELECT
  a.indrelid::regclass          AS table_name,
  ai.relname                    AS redundant_index,
  pg_size_pretty(pg_relation_size(a.indexrelid)) AS redundant_size,
  bi.relname                    AS covered_by,
  pg_get_indexdef(a.indexrelid) AS redundant_def,
  pg_get_indexdef(b.indexrelid) AS covering_def
FROM pg_index a
JOIN pg_index b
  ON a.indrelid = b.indrelid
 AND a.indexrelid <> b.indexrelid
 AND a.indnatts < b.indnatts
 AND a.indkey::int2[] = (b.indkey::int2[])[1:a.indnatts]     -- A's columns are B's leading prefix
 AND a.indpred IS NOT DISTINCT FROM b.indpred                -- same partial predicate (or both none)
 AND NOT a.indisunique                                        -- never propose dropping a unique index
 AND NOT a.indisprimary
JOIN pg_class ai ON ai.oid = a.indexrelid
JOIN pg_class bi ON bi.oid = b.indexrelid
ORDER BY pg_relation_size(a.indexrelid) DESC;
```

```text
 table_name |     redundant_index     | redundant_size |         covered_by         
------------+-------------------------+----------------+----------------------------
 orders     | idx_orders_user_id      | 4210 MB        | idx_orders_user_created    
 orders     | idx_orders_status       | 3821 MB        | idx_orders_status_created  
 order_items| idx_order_items_order   | 12 GB          | idx_order_items_order_prod 
```

**20 GB recoverable** from three indexes that are each a leading prefix of a larger one. This is by far the most common form of index waste, and it accumulates because each composite was added later without anyone checking what it superseded.

Two cautions on redundancy:

1. A narrow index is smaller and denser. If it serves a very hot equality lookup millions of times a second, keeping it can be worth it. Measure before dropping.
2. `indisunique` matters. `UNIQUE (a)` is not covered by `(a, b)`, because the constraint is different.

#### Dropping safely: the monitoring window

Never drop an index the same day you find it. The procedure:

1. **Reset statistics and wait a full business cycle.** `SELECT pg_stat_reset();` then wait at least 7 days, and 35 days if you have monthly jobs (month-end reconciliation is exactly the kind of thing that uses one index once a month).
2. **Check every replica.** Statistics are per node. A reporting replica may be the only user.

   ```sql
   -- run on each node
   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'idx_orders_tenant_id';
   ```

3. **Check it is not backing a constraint.**

   ```sql
   SELECT conname, contype FROM pg_constraint WHERE conindid = 'idx_orders_tenant_id'::regclass;
   ```

4. **Make it invisible before making it gone.** PostgreSQL has no `ALTER INDEX ... INVISIBLE` like MySQL, but you can get the same effect reversibly in a transaction:

   ```sql
   BEGIN;
   UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_orders_tenant_id'::regclass;
   -- planner now ignores it; writes still maintain it
   COMMIT;
   ```

   This is a catalogue hack. It works, it is reversible, and it is not supported. Use it only on a system where you can roll back quickly, and always in a change window. The safer equivalent is to run the candidate queries with `SET enable_indexscan` tricks or `hypopg`'s `hypopg_hide_index()` (PG 13+ versions of the extension), which does the same thing per session with no catalogue writes:

   ```sql
   SELECT hypopg_hide_index('idx_orders_tenant_id'::regclass);
   EXPLAIN SELECT ... ;    -- plan without that index, session-local, safe
   SELECT hypopg_unhide_all_indexes();
   ```

5. **Drop it concurrently** and record the exact DDL for the rollback:

   ```sql
   DROP INDEX CONCURRENTLY idx_orders_tenant_id;
   -- rollback: CREATE INDEX CONCURRENTLY idx_orders_tenant_id ON orders (tenant_id);
   ```

6. **Watch for 48 hours.** `pg_stat_statements` mean times on the affected table, and `seq_scan` on the table.

#### Production scenario

A quarterly "index review" ritual: reset statistics on the first of the quarter, run the three queries above at the end, and produce a single migration that drops everything with zero scans across all nodes, excluding unique indexes and anything created in the last 90 days. In one such review a team removed 41 indexes totalling 190 GB, cut insert p99 on their busiest table by 44 percent, and shortened their base backup by 26 minutes. Nothing got slower.

#### Failure scenario

An engineer dropped `idx_payments_provider_ref` because `idx_scan` was 0 after a 3-day window. It was a **unique** index, and it was the entire idempotency guarantee for the payment provider's webhooks (19.7). It had zero scans because `ON CONFLICT` inserts do not increment `idx_scan` in a way that showed up in their query, and because the duplicate path was rare. Two weeks later a provider retry storm during an outage inserted 14,000 duplicate payment records, and the reconciliation took nine days. **Check `indisunique` and `pg_constraint` before every drop, without exception.**

#### Edge cases & failure modes

- Statistics reset by a server restart, crash, or a major-version upgrade; `pg_stat_database.stats_reset` tells you when.
- Replica-only usage.
- Indexes used only by monthly, quarterly or year-end jobs.
- Unique and exclusion indexes that enforce correctness with zero scans.
- Indexes backing foreign keys: a child index on `order_items(order_id)` may have low `idx_scan` but is required to keep `DELETE FROM orders` from scanning the child table (and to avoid lock escalation on cascade deletes).
- `idx_scan` does not count index maintenance or constraint checks, only planner-chosen scans.
- Dropping an index a query planner was relying on for a *good estimate*: rare, but expression indexes also provide statistics (19.8).

#### Interview questions

1. *How do you find unused indexes and what must you check before dropping one?* Expected: `pg_stat_user_indexes.idx_scan` with a long window; unique/constraint check, FK support, replicas, periodic jobs.
2. *What is a redundant index and how do you detect it?* Expected: leading-prefix containment with the same predicate; the `indkey` prefix query.
3. *Why can an index with `idx_scan = 0` still be essential?* Expected: uniqueness and exclusion constraints, foreign key support.
4. *How do you test the impact of dropping an index without dropping it?* Expected: `hypopg_hide_index`, or the `indisvalid` catalogue trick in a controlled window.

## 19.21 An indexing catalogue for common access patterns

### 19.21.1 The lookup table you will actually use

#### Concept

Most indexing decisions in a backend system are one of about fifteen shapes. Here they are, each with the query, the index, and the reason. Sizes are for the volumes at the top of this part.

| # | Access pattern | Query | Index | Why |
|---|---|---|---|---|
| 1 | **Lookup by primary key** | `WHERE id = $1` | `PRIMARY KEY (id)` (automatic) | 4 index pages plus 1 heap page for any table size |
| 2 | **Lookup by foreign key** | `WHERE order_id = $1` on `order_items` | `CREATE INDEX ON order_items (order_id)` | PostgreSQL does **not** auto-index FKs. Without it, every `DELETE FROM orders` scans 900M rows to check the child, and `ON DELETE CASCADE` is catastrophic |
| 3 | **List by owner, newest first** | `WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20` | `(user_id, created_at DESC)` | Equality then sort; no `Sort` node, `LIMIT` stops early. The single most common shape in any product |
| 4 | **List by owner filtered by state** | `WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 20` | `(user_id, status, created_at DESC)` | Two equalities then the sort column. Supersedes #3 as a prefix, so drop #3 |
| 5 | **Queue claim** | `WHERE status = 'PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100` | `(created_at) WHERE status = 'PENDING'` | 3 MB instead of 41 GB; no index entry written for the 99.99 percent of rows that are not pending |
| 6 | **Uniqueness with soft delete** | insert a review | `UNIQUE (user_id, product_id) WHERE deleted_at IS NULL` | Soft-deleted rows leave the index so the user can re-review |
| 7 | **One active child per parent** | insert a cart | `UNIQUE (user_id) WHERE status = 'OPEN'` | Race-proof at the database level; no application locking |
| 8 | **Idempotency guard** | webhook insert | `UNIQUE (provider_ref)` plus `ON CONFLICT DO NOTHING` | Duplicate delivery becomes a no-op instead of a duplicate payment |
| 9 | **Case-insensitive login** | `WHERE lower(email) = $1` | `UNIQUE INDEX ON users (lower(email))` | Expression must match the query exactly; also prevents duplicate-case signups |
| 10 | **Prefix search** | `WHERE sku LIKE 'DK-9928%'` | `(sku text_pattern_ops)` | Needed on non-`C` collations; a plain B-tree will not serve `LIKE` there |
| 11 | **Substring / fuzzy search** | `WHERE name ILIKE '%toothbrush%'` | `USING gin (name gin_trgm_ops)` | Trigrams make leading wildcards indexable; results are rechecked |
| 12 | **Full-text search** | `WHERE search_tsv @@ plainto_tsquery($1)` | `USING gin (search_tsv)` on a generated `tsvector` column | Generated column cannot drift from the source text |
| 13 | **jsonb attribute, fixed key** | `WHERE attributes->>'sku' = $1` | `((attributes->>'sku'))` B-tree | Smaller and faster than GIN when the key is always the same; supports ordering and uniqueness |
| 14 | **jsonb containment, varying keys** | `WHERE attributes @> $1::jsonb` | `USING gin (attributes jsonb_path_ops)` | 30 to 50 percent smaller than `jsonb_ops` and faster for `@>` |
| 15 | **Time-range analytics on append-only data** | `WHERE created_at >= $1 AND created_at < $2` on 1.2B rows | `USING brin (created_at) WITH (autosummarize = on)` | 3.5 MB versus 27 GB; requires `correlation` above ~0.9 |
| 16 | **Non-overlapping bookings** | insert a delivery slot | `EXCLUDE USING gist (courier_id WITH =, during WITH &&)` | Structural impossibility of double-booking; needs `btree_gist` |
| 17 | **Nearest stores** | `ORDER BY location <-> $1 LIMIT 10` | `USING gist (ll_to_earth(lat, lon))` | KNN ordering inside the index scan, no `Sort` node |
| 18 | **Multi-tenant everything** | every query has `WHERE tenant_id = $1` | `tenant_id` **first** in every composite: `(tenant_id, user_id, created_at DESC)` | Restricts every scan to one tenant's slice; also the natural partition key later |
| 19 | **Covering a hot read** | `SELECT id, status, total FROM orders WHERE user_id = $1 ORDER BY created_at DESC` | `(user_id, created_at DESC) INCLUDE (status, total_cents)` | Index-only scan removes the heap fetch; requires healthy vacuum |
| 20 | **Keyset pagination** | `WHERE user_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 20` | same as #3 | Page 500 costs the same as page 1; `OFFSET 10000` does not |

#### The multi-tenant rule, expanded

Row 18 deserves emphasis because getting it wrong is expensive and getting it right is free. In a multi-tenant system every query is scoped to a tenant. Therefore:

- **Every** composite index starts with `tenant_id`.
- **Every** unique constraint includes `tenant_id`: `UNIQUE (tenant_id, order_ref)`, not `UNIQUE (order_ref)`. Two tenants can legitimately use the same reference.
- Any index that does not start with `tenant_id` is either a mistake or a deliberate cross-tenant admin query, and it should be justified in the migration comment.
- When you eventually partition by `tenant_id` or by hash of it (Part 22 — Database Scaling), the indexes are already in the right shape.

The counter-case: a table where one tenant holds 80 percent of the rows. Then `tenant_id` first is still correct for correctness and pruning, but the selectivity for that tenant is poor, and the second column has to do the real work. Check `most_common_vals` on `tenant_id` before assuming.

#### The foreign-key rule, expanded

Row 2 is the one most teams get wrong, and it is worth a plan. `order_items` has 900 million rows and a foreign key to `orders`. Without an index on `order_items(order_id)`:

```sql
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM orders WHERE id = 148392017;
```

```text
Delete on orders  (cost=0.57..8.59 rows=0 width=0) (actual time=31882.114..31882.115 rows=0 loops=1)
  ->  Index Scan using orders_pkey on orders  (cost=0.57..8.59 rows=1 width=6)
                                              (actual time=0.041..0.043 rows=1 loops=1)
        Index Cond: (id = 148392017)
Trigger for constraint order_items_order_id_fkey: time=31881.884 calls=1
Execution Time: 31882.204 ms
```

The `DELETE` itself took 0.04 ms. The **foreign key trigger** took 31.9 seconds, because it had to scan all 900 million `order_items` rows to check that none referenced the deleted order. `Trigger for constraint ...` in the plan output is the line to look for, and it is invisible if you only read the plan tree.

With `CREATE INDEX ON order_items (order_id)`:

```text
Delete on orders  (actual time=0.088..0.089 rows=0 loops=1)
Trigger for constraint order_items_order_id_fkey: time=0.211 calls=1
Execution Time: 0.318 ms
```

**Every foreign key column should have an index unless you can prove the parent is never deleted or updated.** This is one of the few "always" rules in this part.

#### Practical exercise

Take your own schema. For each table, list its access patterns from the code (grep for the repository methods), map each one to a row in the catalogue above, and write down the index each requires. Then compare with the indexes that actually exist: list the ones that serve no pattern and the patterns that have no index. Acceptance criteria: a two-column gap analysis and a prioritised migration plan with one index per migration.
