## 55.3 Database questions

The database is where seniority becomes visible fastest, because the database is where mistakes become permanent. You can rewrite a bad service in a sprint. You cannot rewrite three years of badly modelled data in a sprint, and you cannot take back a query that has been locking a hot table for six months.

These six questions run on every schema change and every new query.

### 55.3.1 Does this query scale?

#### Why the question matters

Almost every "the API got slow" incident I have handled traces back to a query whose cost grows with the size of the table rather than the size of the result. It works perfectly in development with 2,000 rows and dies at 20 million. Nothing in the code changed. The data grew.

#### How to actually answer it

Ask: **as the table grows by 100x, does this query do 100x more work, or the same work?** Then prove it with `EXPLAIN (ANALYZE, BUFFERS)` on production-shaped data.

The signals that a query does not scale:

- `Seq Scan` on a large table inside a request path.
- `Rows Removed by Filter` far larger than the returned row count: you are reading and discarding.
- A `Sort` with `external merge Disk` in the plan: it did not fit in `work_mem`.
- `OFFSET` with a large number: the database walks and discards every skipped row.
- Any plan whose cost is a function of total rows rather than matched rows.

#### Worked example

Order history, page 500, 20 per page:

```sql
-- Does not scale: at offset 10000 PostgreSQL reads 10,020 rows to return 20.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, total_cents, status
FROM orders
WHERE customer_id = '7c1f...'
ORDER BY created_at DESC, id DESC
OFFSET 10000 LIMIT 20;
```

```text
Limit  (cost=18240.11..18276.59 rows=20 width=44) (actual time=126.884..126.901 rows=20 loops=1)
  Buffers: shared hit=8123 read=2314
  ->  Index Scan Backward using idx_orders_customer_created on orders
        (cost=0.56..1824533.20 rows=1000210 width=44)
        (actual time=0.061..118.402 rows=10020 loops=1)
        Index Cond: (customer_id = '7c1f...'::uuid)
Planning Time: 0.183 ms
Execution Time: 126.939 ms
```

Ten thousand rows read to return twenty, and it gets worse on every page. The keyset version reads twenty:

```sql
-- Scales: the index seeks straight to the cursor position, page cost is constant.
SELECT id, created_at, total_cents, status
FROM orders
WHERE customer_id = '7c1f...'
  AND (created_at, id) < ('2026-02-11 09:14:22+00', 'a41d...')
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

```text
Limit  (cost=0.56..37.02 rows=20 width=44) (actual time=0.038..0.061 rows=20 loops=1)
  Buffers: shared hit=7
Execution Time: 0.081 ms
```

126 ms to 0.08 ms, and the second one stays at 0.08 ms on page 5,000. Same index, same data, different question asked of it.

#### The mistake people make

Testing performance on a development database. A seeded 5,000-row `orders` table makes every plan look fine because everything fits in memory and a sequential scan of 5,000 rows costs nothing. Load a production-shaped copy, or at minimum generate the right order of magnitude with `generate_series`, before you claim a query is fast.

### 55.3.2 What happens when this table has a billion rows?

#### Why the question matters

Table size changes which operations are possible, not just how fast they are. At a billion rows, `ALTER TABLE ... ADD COLUMN ... DEFAULT` behaviour, index creation time, `VACUUM` duration, backup and restore time, and even `count(*)` all move from "a moment" to "a maintenance window".

#### How to actually answer it

Estimate the growth rate first: rows per day times 365. If the answer is under a few million, most of this does not apply and you should not over-engineer. If the answer is hundreds of millions, decide these things **now**, while the table is small:

- **Is there a retention policy?** If rows can be deleted or archived after N months, partition by range on the time column from day one. `DROP TABLE orders_2024_01` is instant; `DELETE FROM orders WHERE created_at < ...` on 200 million rows is an outage, a replication lag spike and a bloat problem.
- **What is the natural access pattern?** Almost always "recent rows for one tenant". That is the composite index, and it is also the partition key candidate.
- **Which columns are actually needed at read time?** Wide rows with large JSONB blobs push data out to TOAST and make index-only scans impossible. Consider splitting cold columns into a side table.
- **Can index creation be done concurrently?** `CREATE INDEX CONCURRENTLY` takes longer but does not block writes. On a billion rows it might take four hours. Plan for it.

#### Worked example

An `events` table for user activity, 40 million rows per month, kept for 13 months: 520 million rows steady state, growing.

Unpartitioned, the monthly cleanup `DELETE` touched 40 million rows, generated ~12 GB of WAL, pushed the replica 90 seconds behind, and left the table 30 percent bloated until autovacuum caught up two days later. Partitioned by month with `PARTITION BY RANGE (occurred_at)`, the cleanup is:

```sql
-- Instant, no WAL for row deletions, no bloat, no replica lag.
ALTER TABLE events DETACH PARTITION events_2025_08 CONCURRENTLY;
DROP TABLE events_2025_08;
```

The cost of partitioning at design time was about two hours of work. The cost of adding it later, on a live 500-million-row table, was a two-week project with dual writes and a backfill.

#### The mistake people make

Assuming you will "deal with it when we get there". You will get there on a Thursday during a product launch, and the fix will need a maintenance window you cannot get. Part 23 — Database Migrations and Zero-Downtime Schema Changes exists because of this mistake.

### 55.3.3 Which indexes does it need, and what do they cost on writes?

#### Why the question matters

Indexes are the highest-leverage tool for read performance and one of the most common causes of write amplification. Every index must be updated on every insert and on every update that touches its columns. Eight indexes on a hot table can triple your write cost and your WAL volume.

#### How to actually answer it

For reads: for each query in the request path, write the index that serves it. Column order is **equality first, then range, then sort**. Check whether the query can be index-only by including the few extra columns with `INCLUDE`.

For writes: count the indexes on the table and multiply. Ask what the insert rate is, what fraction of updates touch indexed columns, and whether any index is on a randomly distributed value like a UUIDv4 (random inserts scatter across the B-tree and destroy cache locality).

Then hunt for indexes nobody uses:

```sql
-- Unused indexes: pure write cost, zero read benefit. Check on a primary
-- that has been up long enough for the stats to be meaningful.
SELECT relname AS table_name,
       indexrelname AS index_name,
       idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan < 50
  AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE contype IN ('p','u'))
ORDER BY pg_relation_size(indexrelid) DESC;
```

#### Worked example

A `payments` table taking 300 inserts per second at peak had nine indexes, added one at a time by five engineers over two years for one-off support queries. Three had `idx_scan` in the low hundreds after 60 days of uptime. Dropping those three cut WAL generation by 22 percent, cut the p99 insert latency from 11 ms to 7 ms, and shaved 40 GB off the backup. Nobody noticed a slow query afterwards, because the support tooling ran on the read replica where those queries could afford a sequential scan.

The senior move here was not "add an index". It was "audit the indexes and delete", which is invisible work that made everything faster.

#### The mistake people make

Adding an index in response to every slow query, without checking whether an existing index could be extended. Two indexes `(customer_id)` and `(customer_id, created_at)` are one index too many: the second serves both queries. Also: adding indexes on a table without knowing its write rate.

### 55.3.4 What happens under concurrency?

#### Why the question matters

Code that is correct when one request runs it is frequently wrong when fifty run it at once. Read-then-write patterns, uniqueness checks in application code and counter updates are the classic three, and they fail rarely enough in testing to reach production and often enough at scale to cost money.

#### How to actually answer it

For every write path, ask: **if two requests execute this at exactly the same moment, what happens?** Walk the interleaving explicitly. Then check which of the four tools you need:

| Problem | Tool | Cost |
|---|---|---|
| Two writers overwriting each other's read | `SELECT ... FOR UPDATE` or optimistic version column | Row lock held for the transaction; contention on hot rows |
| Duplicate creation of a logical entity | Unique constraint plus `ON CONFLICT` | None at read time; must handle the conflict path |
| Lost counter increments | `UPDATE ... SET n = n + 1` in the database, not in application code | Serialises on the row; consider sharded counters if hot |
| Two workers grabbing the same job | `FOR UPDATE SKIP LOCKED` | Small; the correct pattern for queue tables |

#### Worked example

Inventory reservation, the code that every e-commerce system gets wrong once:

```ts
// WRONG: read-check-write across two statements. Two concurrent requests both
// read stock = 1, both pass the check, both decrement. Stock becomes -1.
const item = await this.repo.findOne({ where: { id: sku } });
if (item.stock < qty) throw new ConflictException('out_of_stock');
await this.repo.update({ id: sku }, { stock: item.stock - qty });
```

```ts
// RIGHT: the check and the write are one atomic statement, and the constraint
// is the final authority. affected === 0 means somebody else won the race.
const result = await this.dataSource
  .createQueryBuilder()
  .update(InventoryItem)
  .set({ stock: () => 'stock - :qty' })
  .where('id = :sku AND stock >= :qty', { sku, qty })
  .setParameter('qty', qty)
  .execute();

if (result.affected === 0) {
  throw new ConflictException('out_of_stock');
}
```

Plus the guard rail in the schema, so no future code path can break the invariant:

```sql
ALTER TABLE inventory_items ADD CONSTRAINT stock_non_negative CHECK (stock >= 0);
```

Two layers: the atomic statement makes the common path correct, the constraint makes the whole system incapable of being wrong. Part 20 — Database Transactions and Concurrency Control and Part 31 — Concurrency in Node.js and NestJS go deeper.

#### The mistake people make

Testing concurrency serially. A Jest test that calls the endpoint twice in sequence proves nothing. Run 50 in parallel with `Promise.all` against a real PostgreSQL in Docker and assert the invariant afterwards. That test finds real bugs.

### 55.3.5 Who owns this data, and who else reads it?

#### Why the question matters

A table with one writer and one reader can be changed on a Tuesday. A table with one writer and six readers, two of which are other teams' services and one of which is a BI dashboard, is a public API with no version number. Most "we cannot change our schema" paralysis comes from not knowing who reads it.

#### How to actually answer it

Write down, per table: the owning service, who writes, who reads, and how. "How" matters: an application reading through your API is coupled to your API. An analytics job reading your table directly is coupled to your column names.

Then set the rule: **one service writes; everyone else reads through an interface you control** — an API, an event, or a replicated view. If another team needs direct SQL, give them a versioned database view, not the base table. A view is a contract you can keep stable while the table underneath changes.

#### Worked example

We wanted to rename `orders.total` (in dollars, a `numeric`) to `orders.total_cents` (an `integer`), because the floating conversions were producing rounding complaints. The change looked like a ten-minute migration. Then we asked who reads it: the order service (ours), the invoicing service (another team), a Metabase dashboard used by finance, a nightly export to the data warehouse, and a customer-facing CSV export.

The actual plan was expand-contract over six weeks: add `total_cents`, dual-write, backfill in batches, create a view `orders_v1` exposing the old `total` computed from `total_cents` for the external readers, migrate readers one at a time with the owning teams, then drop the column. Not glamorous, zero downtime, zero incidents.

The senior behaviour was not the migration technique. It was asking the ownership question *before* estimating the work.

#### The mistake people make

Letting other services connect directly to your database "just for reads, just this once". It happens in an afternoon and takes two years to undo. If you must, do it through an explicitly named, versioned view and a read-only role with `GRANT SELECT` limited to that view.

### 55.3.6 How will we migrate it later?

#### Why the question matters

Every schema you write will be wrong eventually. The question is whether the fix is a migration you can run online, or a project. Design choices made in five minutes determine which.

#### How to actually answer it

Before merging a schema, ask: to change this later, would we need to rewrite the whole table, take a long lock, or reconstruct information we did not keep?

Cheap-to-evolve choices: nullable new columns, additive enums stored as text with a check constraint rather than a PostgreSQL `enum` type, storing the raw event alongside the derived state, timestamps with time zone, surrogate keys.

Expensive-to-evolve choices: changing a column type on a large table, adding `NOT NULL` without a default on an old PostgreSQL version, natural primary keys made of business data that turns out to be mutable, a native `enum` type that requires `ALTER TYPE` coordination, and anything that discards information.

#### Worked example

We modelled a subscription's state as a single `status` column: `active`, `paused`, `cancelled`. Eighteen months later, finance asked "how many subscriptions were paused in March, and for how long?" The information did not exist. We had stored the current state and thrown away the transitions.

The cheap version of this choice, made at design time, would have been an append-only `subscription_events` table alongside the `status` column: two extra columns of work, and the ability to answer any historical question forever. That is what "designing for migration" actually means most of the time: **keep the facts, derive the state**.

#### Interview questions

1. **"You need to add a `NOT NULL` column with a default to a 400-million-row table with no downtime. Walk me through it."** Expected: awareness that modern PostgreSQL handles the default without a rewrite for most types, but that the safe general recipe is add nullable, backfill in batches with a sleep between them, add a `NOT VALID` check constraint, then `VALIDATE CONSTRAINT`. Follow-up: what is your `lock_timeout` and why?
2. **"An endpoint got 20x slower after a release with no query changes. Where do you look?"** Expected: plan change from statistics drift, a new index missing after a restore, data growth crossing a threshold, parameter sniffing on a prepared statement, autovacuum falling behind, or a lock wait. Ask for `EXPLAIN (ANALYZE, BUFFERS)` and `pg_stat_activity`.
3. **"How do you decide between optimistic and pessimistic locking?"** Expected: contention rate and the cost of a retry versus the cost of holding a lock.
4. **"Who is allowed to read your service's tables directly?"** Expected: ideally nobody, and a clear story about views, APIs or events if someone does.

#### Practical exercise

Pick the busiest write table in your system. Produce: the row count and daily growth rate, every index with its `idx_scan` count and size, the top three queries against it from `pg_stat_statements` with their plans, and a one-page answer to all six questions in 55.3. Acceptance criteria: you can name at least one index to drop or one query to rewrite, with the measured before and after.

