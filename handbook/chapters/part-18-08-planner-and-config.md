## 18.12 The query planner and optimizer

### 18.12.1 Cost model, cardinality estimation and join order

#### Concept

The **planner** takes a query tree and produces the cheapest plan it can find. "Cheapest" means the lowest **estimated cost**, a unit-less number computed from a handful of cost constants (how expensive a sequential page read is, a random page read, processing one row, evaluating one operator) and from **cardinality estimates** (how many rows each step will produce), which come from the statistics of 18.9. The planner never measures anything; it predicts.

#### Why does it exist?

There are dozens of ways to run even a simple two-table join and millions for a ten-table one. Trying them all for real would take longer than running the query. A cost model lets the planner compare alternatives in microseconds. It is remarkably good when its inputs are accurate, and confidently wrong when they are not: the inputs (statistics, cost constants, memory settings) are what a backend engineer controls.

#### Mental model

Imagine a delivery dispatcher who has never driven the routes but has a map with estimated speeds per road type and estimated numbers of parcels per neighbourhood. The dispatcher picks the route with the lowest estimated time. If the map says "highway, 100 km/h" but the highway has been a parking lot for a year (a stale `random_page_cost` on SSD, or stale row counts), every route decision is wrong in the same direction.

#### How it works

The cost constants, with defaults and what they mean:

| Setting | Default | Meaning | Typical change |
|---|---|---|---|
| `seq_page_cost` | 1.0 | One page read during a sequential scan | leave |
| `random_page_cost` | 4.0 | One page read in random order (index scans) | 1.1 on SSD or NVMe; RDS gp3 too |
| `cpu_tuple_cost` | 0.01 | Processing one row | leave |
| `cpu_index_tuple_cost` | 0.005 | Processing one index entry | leave |
| `cpu_operator_cost` | 0.0025 | Evaluating one operator or function | leave |
| `effective_cache_size` | 4 GB | How much of the data the planner may assume is cached (OS plus shared buffers) | 50 to 75 percent of RAM |
| `parallel_setup_cost`, `parallel_tuple_cost` | 1000, 0.1 | Cost of starting workers and passing rows | leave |

1. **Access paths.** For each table in the query the planner lists ways to get rows: sequential scan, index scan per usable index, index-only scan, bitmap scan, TID scan. It costs each. A sequential scan of `orders` (3.9 million pages, 200 million rows) with one filter costs about `3,921,033 × 1.0 + 200,000,000 × 0.01 + 200,000,000 × 0.0025 = 6,421,033`. An index scan costs the index pages read plus heap pages read (random cost, scaled down toward sequential cost when the column's `correlation` is high) plus per-row CPU. `random_page_cost = 4` says heap fetches via an index are four times more expensive than a sequential page, which was true for spinning disks and is false for SSDs; on SSD the planner will wrongly prefer sequential scans and bitmap scans until you set it to about 1.1.
2. **Selectivity.** Each `WHERE` condition is turned into a fraction of rows using `pg_stats`: MCV lookups for equality on common values, `1/n_distinct` for equality on unknown values, histogram interpolation for ranges, and defaults when it has nothing (0.5 for an unknown boolean expression, 0.005 for equality with a function it cannot analyse). Conditions combined with `AND` are multiplied as if independent; `OR` uses inclusion-exclusion. Multiplying is the **independence assumption**, and it is the single most common cause of bad plans on real data: `country = 'DE' AND currency = 'EUR'` is estimated as 0.2 × 0.2 = 0.04 of rows when the truth is about 0.2.
3. **Join methods.** For every pair of inputs it considers:

   | Method | Cost shape | Wins when |
   |---|---|---|
   | Nested Loop | outer rows × cost of inner lookup | outer side is small and inner side has an index (`user_id = ?` then items by `order_id`) |
   | Hash Join | build hash of smaller side (needs `work_mem`) plus one pass over the larger | both sides large, no useful ordering; the default for analytics joins |
   | Merge Join | sort both (or use indexes) then one pass | both sides already sorted on the join key, or very large inputs |

   A misestimate that says "10 rows" when the truth is 10 million turns a nested loop into 10 million index probes, and that is the 40-second query.
4. **Join order.** Up to `join_collapse_limit` and `from_collapse_limit` (8) tables, the planner uses dynamic programming to consider every join order. Above `geqo_threshold` (12) it switches to a genetic algorithm that is fast but non-deterministic. Writing joins in explicit `JOIN` syntax and setting `join_collapse_limit = 1` forces your written order, which is a blunt but sometimes necessary tool.
5. **Parallelism.** For large scans and joins the planner may add `Gather` nodes and up to `max_parallel_workers_per_gather` (2) workers; tables smaller than `min_parallel_table_scan_size` (8 MB) are never parallelised.
6. **JIT.** On PG 12+, `jit = on` compiles expressions for queries with estimated cost above `jit_above_cost` (100,000). For OLTP it can add 5 to 50 ms of compile time to an occasional query and is often disabled (`jit = off`) on transactional systems.

The `enable_*` settings (`enable_seqscan`, `enable_nestloop`, `enable_hashjoin`, `enable_mergejoin`, `enable_indexscan`, `enable_bitmapscan`, `enable_sort`) do not disable anything; they add a huge penalty (10 billion) to that node type. They are for *diagnosis in a session*: "would the index plan be faster if the planner chose it?" Never set them in `postgresql.conf` or for a role.

Extended statistics teach the planner about correlated columns:

```sql
CREATE STATISTICS orders_country_currency (dependencies, ndistinct, mcv)
  ON shipping_country, currency FROM orders;
ANALYZE orders;
```

`dependencies` captures functional dependencies (currency depends on country), `ndistinct` captures distinct counts of the combination (for `GROUP BY country, currency`), and `mcv` (PG 12+) stores the most common combinations. They cost one more ANALYZE pass and a few KB.

#### Practical example

`SELECT ... FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.shipping_country = 'DE' AND o.currency = 'EUR' AND o.created_at > now() - interval '7 days'`. Truth: 1.2 million orders in DE, all in EUR, 180,000 in the last week. Independence assumption: 200 million × 0.2 × 0.2 × 0.005 = 40,000 orders estimated. The planner picks a nested loop into `order_items` expecting 40,000 index probes; it does 180,000, each reading 3 or 4 random pages: 12 s. With extended statistics the estimate becomes 200,000, the planner picks a hash join with a bitmap scan, and the query takes 1.1 s.

#### PostgreSQL example

Before and after extended statistics, on the filter alone:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM orders
WHERE shipping_country = 'DE' AND currency = 'EUR' AND created_at > now() - interval '7 days';
```

Before:

```text
Aggregate  (cost=48211.10..48211.11 rows=1 width=8) (actual time=2210.442..2210.443 rows=1 loops=1)
  ->  Index Scan using idx_orders_created_at on orders
        (cost=0.57..48111.02 rows=40032 width=0) (actual time=0.034..2181.201 rows=180114 loops=1)
        Index Cond: (created_at > (now() - '7 days'::interval))
        Filter: ((shipping_country = 'DE') AND (currency = 'EUR'))
        Rows Removed by Filter: 719886
        Buffers: shared hit=812203 read=98211
```

After `CREATE STATISTICS` and `ANALYZE`:

```text
Aggregate  (cost=61233.10..61233.11 rows=1 width=8) (actual time=310.114..310.115 rows=1 loops=1)
  ->  Bitmap Heap Scan on orders  (cost=9021.11..60731.20 rows=200811 width=0) (actual time=42.010..291.120 rows=180114 loops=1)
        Recheck Cond: ((shipping_country = 'DE') AND (created_at > (now() - '7 days'::interval)))
        Filter: (currency = 'EUR')
        Heap Blocks: exact=41022
        Buffers: shared hit=44120 read=2201
        ->  Bitmap Index Scan on idx_orders_country_created  (cost=0.00..8971.02 rows=200811 width=0) ...
```

`rows=40032` versus actual `180114` was the tell: an estimate off by more than three or four times is worth investigating; off by 100 times is the bug. Diagnose "would an index be better?" without changing anything permanent:

```sql
SET enable_seqscan = off;      -- session only, for diagnosis
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
RESET enable_seqscan;
```

And check what the planner thinks about your storage:

```sql
SELECT name, setting FROM pg_settings
WHERE name IN ('random_page_cost', 'seq_page_cost', 'effective_cache_size', 'work_mem', 'jit');
```

#### TypeORM example

A plan regression test that runs in CI against a seeded database, so an index removal or a query rewrite that changes the plan fails a test instead of a production night:

```ts
// orders.repository.plan.spec.ts
import { DataSource } from 'typeorm';

describe('recentForUser plan', () => {
  let ds: DataSource;
  beforeAll(async () => { ds = await createTestDataSource(); });   // seeded with skewed data

  it('uses the composite index and no sort', async () => {
    const [{ 'QUERY PLAN': plan }] = await ds.query(
      `EXPLAIN (FORMAT JSON)
       SELECT id, status, total_cents FROM orders
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [42],
    );
    const root = plan[0].Plan;
    const nodes: any[] = [];
    (function walk(n: any) { nodes.push(n); (n.Plans ?? []).forEach(walk); })(root);

    expect(nodes.some((n) => n['Index Name'] === 'idx_orders_user_created')).toBe(true);
    expect(nodes.some((n) => n['Node Type'] === 'Sort')).toBe(false);   // ordered by the index
  });
});
```

#### Sequelize example

Same idea with `sequelize.query(..., { type: QueryTypes.SELECT })` and the JSON plan; Sequelize adds nothing planner-specific. What matters is that the SQL the ORM generates is the SQL you test.

#### Production scenario

A well-tuned OLTP instance: `random_page_cost = 1.1`, `effective_cache_size = 24GB` (on 32 GB), `work_mem = 32MB`, `jit = off`, `default_statistics_target = 200`, extended statistics on the four column pairs that appear together in the top 20 queries, and `auto_explain` logging any plan over 500 ms. Plan flips are caught within minutes because `auto_explain` output is parsed into a dashboard of "plans seen per query id".

What can go wrong? Misestimates from stale or missing statistics, correlation, generic plans, or wrong cost constants. How do I monitor it? `auto_explain` plus `pg_stat_statements` mean time per query id. How do I fix it? In order: `ANALYZE`, statistics target, extended statistics, the right index, query rewrite, cost constants, and only then hints (`pg_hint_plan`) or `enable_*` in a single transaction as a last resort.

#### Failure scenario

`ORDER BY created_at DESC LIMIT 20` with a rare filter. `SELECT * FROM orders WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20` with an index on `created_at` but not on `user_id`: the planner assumes user 7's rows are spread evenly through the table, so it expects to find 20 matches after scanning a few thousand index entries backward. User 7 placed 3 orders in 2019. The scan walks 200 million index entries and heap pages: 90 s. The estimate was fine on average; the assumption of uniform distribution was the problem, and only the right composite index `(user_id, created_at DESC)` fixes it for every user (Part 19 has the full case study).

#### Edge cases & failure modes

- Independence assumption on correlated columns; fix with extended statistics.
- `LIMIT` with the uniform-distribution assumption; fix with a composite index that satisfies both filter and order.
- Functions and expressions without statistics (`lower(email)`, `data->>'sku'`, `date_trunc`); fix with an expression index plus `ANALYZE`, which creates statistics for the expression.
- `work_mem` too small: hash joins spill into batches, sorts go to disk, and the planner may avoid a hash join it should have used; too large: memory blow-up under concurrency.
- Join order search cut off by `geqo_threshold`: non-deterministic plans on 12-plus table queries.
- Generic plans in prepared statements (18.3.2).
- Partition pruning failing because the partition key is compared with a function or a parameter of the wrong type.
- Row-level security or views with `security_barrier` preventing predicate pushdown.

#### How a Senior Backend Engineer thinks about this

They read the estimated-versus-actual rows before anything else in a plan. They fix inputs (statistics, cost constants) before forcing outcomes (hints). They know which queries in their system are sensitive to a plan flip and test those plans in CI. They are suspicious of any query that "usually" runs fast.

#### Common mistakes

- Leaving `random_page_cost = 4` on SSD and wondering why indexes are ignored.
- Setting `enable_seqscan = off` globally.
- Adding an index for every slow query instead of asking why the estimate was wrong.
- Trusting `EXPLAIN` without `ANALYZE`.

#### Interview questions

1. *How does the planner estimate the cost of an index scan versus a sequential scan, and what inputs can you change?* Expected: page costs, CPU costs, correlation, `effective_cache_size`, statistics; `random_page_cost` on SSD.
2. *What is the independence assumption and how do you fix a bad estimate caused by it?* Expected: multiplied selectivities; `CREATE STATISTICS`.
3. *When does a nested loop beat a hash join?* Expected: small outer input with an indexed inner side.
4. *What are `enable_*` settings for, and what must you never do with them?*
5. *Why can `ORDER BY ... LIMIT` queries be catastrophically slow for rare filter values?*

#### Practical exercise

Build `orders` with correlated `shipping_country` and `currency` (each country has one currency). Run the DE/EUR query, capture the misestimate, add extended statistics, and capture the new plan. Then set `random_page_cost = 4` and `1.1` in turn and record which plan the planner chooses for a 0.5 percent selective range query. Acceptance criteria: four plans with row estimates, actuals, buffers and timing, and a paragraph on which input fixed which problem.

## 18.13 Configuration knobs a backend engineer must know

### 18.13.1 The settings that decide behaviour under load

#### Concept

PostgreSQL has about 350 settings. A backend engineer needs to understand roughly twenty, because those twenty decide whether the database survives your traffic pattern: memory per sort, memory for maintenance, what the planner believes about the hardware, and the safety belts that limit how much damage one bad query, one bad transaction, or one bad deploy can do.

#### Why does it exist?

Defaults are chosen so that PostgreSQL starts on a laptop with 1 GB of RAM. Production hardware is 30 to 500 times bigger, workloads vary from 50 connections doing 1 ms lookups to 5 connections doing hour-long reports, and the same knob (`work_mem`) that makes reports fast makes an OLTP server run out of memory. There is no safe universal value, so the knobs exist and you must set them.

#### Mental model

Imagine a kitchen where each cook (backend) may use a certain number of pans at once (`work_mem` per operation). Give each cook 20 pans and 200 cooks will burn the kitchen down. Give them 2 and the head chef preparing a banquet (a report) cannot work. The senior answer is "2 by default, and the banquet chef gets 20 for that dish only" (`SET LOCAL work_mem`).

#### How it works

Where a setting can be set, in increasing precedence: `postgresql.conf` or the RDS parameter group; `ALTER SYSTEM SET` (writes `postgresql.auto.conf`); `ALTER DATABASE shop SET`; `ALTER ROLE orders_api SET`; `SET` in a session; `SET LOCAL` in a transaction. `pg_settings.context` tells you whether a change needs a restart (`postmaster`), a reload (`sighup`), or nothing (`user`, `superuser`).

| Setting | Default | What it controls | Sensible production value | Why |
|---|---|---|---|---|
| `shared_buffers` | 128 MB | PostgreSQL page cache (18.4) | 25 percent of RAM, rarely above 16 GB | Working set in memory; restart required |
| `effective_cache_size` | 4 GB | Planner's belief about total cache | 50 to 75 percent of RAM | Makes index scans look as cheap as they are |
| `work_mem` | 4 MB | Memory per sort or hash *operation* (a query can have several; every connection can run one) | 16 to 64 MB globally; raise per transaction for reports | Sorts and hashes spill to disk when exceeded; too high risks OOM |
| `hash_mem_multiplier` | 2.0 (PG 15+) | Hash operations may use `work_mem × multiplier` | leave | Hash joins are memory-hungry |
| `maintenance_work_mem` | 64 MB | `CREATE INDEX`, `VACUUM`, `ALTER TABLE ADD FOREIGN KEY` | 1 to 2 GB | Index builds are several times faster with enough memory |
| `autovacuum_work_mem` | -1 (uses maintenance) | Per autovacuum worker | 256 MB to 1 GB | Fewer index passes on big tables |
| `random_page_cost` | 4.0 | Planner cost of random reads | 1.1 on SSD | Otherwise the planner avoids indexes |
| `effective_io_concurrency` | 1 | Prefetching during bitmap heap scans | 200 on SSD | Bitmap scans get much faster |
| `max_connections` | 100 | Backend slots (18.2) | 100 to 300 with a pooler | Each is a process; restart required |
| `statement_timeout` | 0 (off) | Max statement duration | 10 to 30 s for app roles; 0 for migrations | One runaway query cannot hold a connection for an hour |
| `lock_timeout` | 0 (off) | Max wait for any lock | 3 to 5 s for migrations; per role for apps | Prevents lock-queue pile-ups (18.11) |
| `idle_in_transaction_session_timeout` | 0 (off) | Kill sessions idle in a transaction | 30 to 60 s for app roles | Stops horizon holders and lock holders (18.10) |
| `log_min_duration_statement` | -1 (off) | Log statements slower than this | 500 ms (200 ms on tight systems) | The slow query log |
| `log_lock_waits` | off | Log waits longer than `deadlock_timeout` | on | Evidence for lock incidents |
| `log_temp_files` | -1 | Log temp files above this size | 0 (all) | Shows which queries spill `work_mem` |
| `log_checkpoints` | on (PG 15+) | Checkpoint details (18.6) | on | Comb-shaped latency diagnosis |
| `log_autovacuum_min_duration` | 10 min (PG 15+) | Log autovacuum runs longer than this | 1 s | The "not yet removable" line (18.8) |
| `track_io_timing` | off | Measure read/write time in stats and `EXPLAIN` | on (cheap on modern clocks) | Separates cache misses from disk time |
| `shared_preload_libraries` | empty | Extensions loaded at start | `pg_stat_statements,auto_explain` | Observability (18.14); restart required |
| `max_wal_size`, `checkpoint_timeout` | 1 GB, 5 min | Checkpoint frequency (18.6) | 8 GB plus, 15 min | Fewer full-page writes, smoother I/O |
| `jit` | on | JIT compilation of expressions | off for OLTP | Avoids compile latency on short queries |
| `max_parallel_workers_per_gather` | 2 | Parallel workers per query | 2 to 4 on OLTP; more on analytics | Parallel scans use CPU that OLTP needs |
| `temp_file_limit` | -1 | Max temp disk per session | 10 to 50 GB | A bad report cannot fill the disk |

A starter configuration for an 8 vCPU, 32 GB OLTP instance on SSD:

```text
shared_buffers = 8GB
effective_cache_size = 24GB
work_mem = 32MB
maintenance_work_mem = 1GB
random_page_cost = 1.1
effective_io_concurrency = 200
max_connections = 200
max_wal_size = 8GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_compression = lz4
jit = off
shared_preload_libraries = 'pg_stat_statements,auto_explain'
log_min_duration_statement = 500
log_lock_waits = on
log_temp_files = 0
log_autovacuum_min_duration = 1000
track_io_timing = on
autovacuum_vacuum_cost_limit = 2000
autovacuum_max_workers = 5
idle_in_transaction_session_timeout = 60000
```

Per-role belts go on top, because migrations, analysts and the API need different limits.

`work_mem` deserves its own arithmetic. It is per *operation*, not per connection or per query: a query with two sorts and a hash join can use three times `work_mem`. With 200 connections and `work_mem = 256MB`, the theoretical peak is 200 × 3 × 256 MB = 150 GB. Real usage is far lower because most queries never sort, but a traffic spike that makes 100 connections run the same report at once has taken down real servers. The pattern is `work_mem = 32MB` globally and `SET LOCAL work_mem = '512MB'` inside the specific transaction that runs the monthly report.

#### Practical example

The `GET /orders/export` endpoint sorts up to 2 million rows for large B2B customers. With `work_mem = 4MB` the sort spills to disk (`Sort Method: external merge  Disk: 312400kB`) and takes 9 s. With `SET LOCAL work_mem = '512MB'` in the export transaction it sorts in memory in 1.4 s. Raising the global `work_mem` to 512 MB instead would have exposed the whole server to memory exhaustion the first time 50 customers exported at the same time.

#### NestJS example

Belts and per-transaction memory from configuration, not from code literals:

```ts
// reports.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

@Injectable()
export class ReportsService {
  constructor(private readonly dataSource: DataSource, private readonly cfg: ConfigService) {}

  async exportOrders(userId: number) {
    const workMem = this.cfg.get<string>('REPORT_WORK_MEM', '256MB');
    const timeoutMs = this.cfg.get<number>('REPORT_STATEMENT_TIMEOUT_MS', 60_000);

    return this.dataSource.transaction(async (em) => {
      // Scoped to this transaction only; safe behind PgBouncer transaction mode
      await em.query(`SET LOCAL work_mem = '${workMem}'`);
      await em.query(`SET LOCAL statement_timeout = ${timeoutMs}`);   // longer than the API default
      return em.query(
        `SELECT o.id, o.status, o.total_cents, o.created_at
           FROM orders o
          WHERE o.user_id = $1
          ORDER BY o.created_at DESC`,
        [userId],
      );
    });
  }
}
```

Validate `REPORT_WORK_MEM` against a whitelist pattern at startup; it is interpolated into SQL.

#### PostgreSQL example

Find out what applies where, and which settings need a restart:

```sql
SELECT name, setting, unit, source, context, pending_restart
FROM pg_settings
WHERE name IN ('shared_buffers', 'work_mem', 'random_page_cost', 'statement_timeout',
               'idle_in_transaction_session_timeout', 'max_connections')
ORDER BY name;
```

```text
 name                                | setting | unit | source             | context    | pending_restart
-------------------------------------+---------+------+--------------------+------------+-----------------
 idle_in_transaction_session_timeout | 60000   | ms   | configuration file | user       | f
 max_connections                     | 200     |      | configuration file | postmaster | f
 random_page_cost                    | 1.1     |      | configuration file | user       | f
 shared_buffers                      | 1048576 | 8kB  | configuration file | postmaster | f
 statement_timeout                   | 10000   | ms   | database           | user       | f
 work_mem                            | 32768   | kB   | configuration file | user       | f
```

Role-level overrides and reload without restart:

```sql
ALTER ROLE analyst SET work_mem = '256MB';
ALTER ROLE analyst SET statement_timeout = '10min';
ALTER ROLE analyst SET idle_in_transaction_session_timeout = '2min';
ALTER SYSTEM SET log_min_duration_statement = '250ms';
SELECT pg_reload_conf();
```

Spot spilling sorts in the log with `log_temp_files = 0`:

```text
LOG:  temporary file: path "base/pgsql_tmp/pgsql_tmp8812.3", size 327155712
STATEMENT:  SELECT o.id, ... FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC
```

#### TypeORM example

Startup parameters through `extra` apply to every pooled connection of that service; use them for the belts the service should always have, and keep the per-transaction ones in code:

```ts
extra: {
  max: 8,
  statement_timeout: 10_000,                   // ms; sent as a startup parameter
  idle_in_transaction_session_timeout: 30_000,
  lock_timeout: 5_000,
  application_name: 'orders-api',
}
```

#### Sequelize example

```ts
dialectOptions: {
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 30_000,
  lock_timeout: 5_000,
  application_name: 'orders-api',
}
```

#### Production scenario

A managed RDS instance: `shared_buffers` and `max_connections` come from the parameter group with RDS defaults derived from instance memory; the team overrides `random_page_cost`, `work_mem`, `maintenance_work_mem`, `log_min_duration_statement`, `log_lock_waits`, `track_io_timing`, `autovacuum_vacuum_cost_limit`, `max_wal_size`, `checkpoint_timeout`, `jit`, and `shared_preload_libraries` (which RDS calls out as needing a reboot). Application roles carry their timeouts. The parameter group is version-controlled and reviewed like code.

#### Failure scenario

"OOM at 09:05 every Monday." A weekly job ran 40 concurrent report queries each with two large hash joins. `work_mem` had been raised to 1 GB globally to make a single report fast. 40 × 2 × up to 2 GB (hash multiplier) of demand on a 64 GB server: the OOM killer took a backend, the postmaster restarted all connections, and the API fleet reconnected in a storm (18.2). `work_mem` went back to 32 MB globally, the report role got 512 MB, and the job's concurrency was capped at 5.

#### Edge cases & failure modes

- `work_mem` multiplied by operations, connections and `hash_mem_multiplier`.
- `statement_timeout` set globally kills long migrations and `pg_dump`; set it per role.
- `lock_timeout` on application roles also cancels legitimate row-lock waits in hot-row scenarios; choose the value with that in mind.
- `shared_preload_libraries` changes need a restart; plan them with a failover.
- `ALTER SYSTEM` on a replica is overwritten if you rebuild it from the primary; keep configuration in the parameter group or infrastructure code.
- `jit = on` with `jit_above_cost` at default causing occasional 50 ms stalls on queries that normally take 2 ms.
- `temp_file_limit` unset: one report fills the disk and takes the primary down.

#### How a Senior Backend Engineer thinks about this

They know the twenty settings and why each has its value. They never change a knob globally to fix one query. They keep belts (timeouts) per role and verify them with `pg_settings` after every deploy. They version the parameter group. They ask, for every setting change: "what is the worst case if 200 connections exercise this at once?"

#### Common mistakes

- Global `work_mem` in the hundreds of MB.
- Never enabling `track_io_timing`, `log_lock_waits`, `log_temp_files`.
- Changing `random_page_cost` on a replica only.
- Setting timeouts in application code strings instead of role or pool configuration, so that psql sessions and scripts have none.

#### Interview questions

1. *Why is `work_mem` dangerous to raise globally, and what is the alternative?* Expected: per operation × connections; `SET LOCAL` per transaction or per role.
2. *Which three timeouts do you set for an application role and why?* Expected: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`.
3. *What does `effective_cache_size` allocate?* Expected: nothing; it is a planner hint.
4. *Which settings require a restart and how do you find out?* Expected: `pg_settings.context = 'postmaster'`.

#### Practical exercise

Take a 5 million row sort query. Run it with `work_mem` at 4 MB, 64 MB and 512 MB (via `SET LOCAL`), capturing `Sort Method` and timing from `EXPLAIN (ANALYZE, BUFFERS)`. Then compute the worst-case memory for your service's pool size at each value. Acceptance criteria: a table of the three runs and a written recommendation for global versus per-transaction values with the arithmetic.
