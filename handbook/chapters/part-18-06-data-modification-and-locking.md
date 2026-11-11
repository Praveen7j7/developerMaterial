## 18.15 Data modification: INSERT, UPDATE, DELETE done properly

### 18.15.1 INSERT with RETURNING, multi-row inserts and upserts

#### Concept

`INSERT ... RETURNING` writes rows and returns any columns of what was written, including database-generated values (`id`, `order_number`, `created_at`), in one round trip. A multi-row `INSERT ... VALUES (...), (...), (...)` or `INSERT ... SELECT` writes many rows in one statement. `INSERT ... ON CONFLICT DO UPDATE` is the upsert: insert, or if a unique key already exists, update that row instead. Part 17 introduced `ON CONFLICT` as the race-proof "insert if not exists"; this section covers its full update semantics.

#### Why does it exist?

Without `RETURNING`, creating an order means `INSERT` then `SELECT ... WHERE id = ?` (two round trips, and you need to know the id, which the database generated). Without multi-row inserts, importing 10,000 products is 10,000 round trips at roughly 0.5 ms each, five seconds of mostly network. Without upserts, "set this product's inventory to 40" is a `SELECT`, a branch, and either an `INSERT` or an `UPDATE`, with the race in between.

#### How it works

1. `RETURNING` evaluates the listed expressions against the inserted row after defaults, triggers (`BEFORE`), and generated columns have been applied. It works for `UPDATE` and `DELETE` too (returning the new and the old row respectively).
2. A multi-row `VALUES` list is parsed into one plan; rows are inserted in order; constraints are checked per row; the whole statement is atomic. node-postgres has a parameter limit of 65,535 per statement, so batch inserts in chunks (for example 1,000 rows x 10 columns = 10,000 parameters).
3. `ON CONFLICT (target) DO UPDATE SET col = EXCLUDED.col` locks the conflicting row and updates it. `EXCLUDED` is the row you tried to insert. The `SET` list decides which columns are overwritten; unlisted columns keep their existing values. An optional `WHERE` on the `DO UPDATE` decides whether to update at all.
4. Triggers fire for the path taken: `INSERT` triggers on insert, `UPDATE` triggers on the conflict-update path.
5. With `RETURNING`, the upsert returns the row as it exists after the statement, whichever path it took.

#### PostgreSQL example

```sql
-- Create an order and get everything the API response needs, one round trip
INSERT INTO orders (user_id, shipping_address_id, currency)
VALUES ($1, $2, 'INR')
RETURNING id, order_number, status, placed_at;

-- Multi-row insert of items with per-row price snapshots from the catalog, and RETURNING for the response
INSERT INTO order_items (order_id, product_id, quantity, unit_price, product_name)
SELECT $1, p.id, v.qty, p.price, p.name
FROM (VALUES ($2::uuid, $3::int), ($4::uuid, $5::int), ($6::uuid, $7::int)) AS v(product_id, qty)
JOIN products p ON p.id = v.product_id AND p.is_active
RETURNING id, product_id, quantity, unit_price;
-- If a product is inactive it is silently skipped; compare returned count to requested count in the service and roll back if they differ.

-- Bulk import with unnest: one parameter per column, any number of rows
INSERT INTO products (sku, name, category_id, price)
SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::numeric[]);

-- Upsert: inventory sync from the warehouse system. Set absolute stock; never lower reserved below current.
INSERT INTO inventory (product_id, quantity_on_hand, reorder_level, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (product_id) DO UPDATE
   SET quantity_on_hand = EXCLUDED.quantity_on_hand,
       reorder_level    = EXCLUDED.reorder_level,
       updated_at       = now()
 WHERE inventory.quantity_on_hand IS DISTINCT FROM EXCLUDED.quantity_on_hand   -- skip no-op updates (no dead tuple)
    OR inventory.reorder_level    IS DISTINCT FROM EXCLUDED.reorder_level
RETURNING product_id, quantity_on_hand, (xmax = 0) AS inserted;

-- Upsert that must never regress state: payment webhook that may arrive out of order
INSERT INTO payments (id, order_id, provider, idempotency_key, amount, status, provider_payment_id)
VALUES ($1, $2, 'razorpay', $3, $4, $5, $6)
ON CONFLICT (idempotency_key) DO UPDATE
   SET status = EXCLUDED.status, provider_payment_id = EXCLUDED.provider_payment_id, updated_at = now()
 WHERE payments.status NOT IN ('captured', 'refunded')            -- terminal states win
RETURNING id, status;
-- Zero rows returned means the update was refused by the WHERE (already terminal): treat as success, idempotently.
```

#### NestJS example

```ts
// inventory/inventory.service.ts
@Injectable()
export class InventoryService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Bulk stock sync in chunks of 500 to stay under the parameter limit and keep lock time short. */
  async syncStock(rows: Array<{ productId: string; onHand: number; reorderLevel: number }>): Promise<number> {
    let changed = 0;
    for (const chunk of chunked(rows, 500)) {
      const res = await this.ds.query<Array<{ product_id: string }>>(
        `INSERT INTO inventory (product_id, quantity_on_hand, reorder_level, updated_at)
         SELECT * FROM unnest($1::uuid[], $2::int[], $3::int[]) WITH ORDINALITY AS t(product_id, on_hand, reorder_level, ord), now()
         ON CONFLICT (product_id) DO UPDATE
            SET quantity_on_hand = EXCLUDED.quantity_on_hand, reorder_level = EXCLUDED.reorder_level, updated_at = now()
          WHERE inventory.quantity_on_hand IS DISTINCT FROM EXCLUDED.quantity_on_hand
             OR inventory.reorder_level IS DISTINCT FROM EXCLUDED.reorder_level
         RETURNING product_id`,
        [chunk.map((r) => r.productId), chunk.map((r) => r.onHand), chunk.map((r) => r.reorderLevel)],
      );
      changed += res.length;
    }
    return changed;
  }
}
```

#### TypeORM example

```ts
// RETURNING via the insert builder
const result = await orderRepo.createQueryBuilder().insert().into(Order)
  .values({ userId, shippingAddressId, currency: 'INR' })
  .returning(['id', 'orderNumber', 'status', 'placedAt'])
  .execute();
const created = result.raw[0];   // { id, order_number, status, placed_at }

// Multi-row insert
await orderItemRepo.createQueryBuilder().insert().into(OrderItem).values(items).execute();

// Upsert with orUpdate: columns to overwrite, conflict target
await inventoryRepo.createQueryBuilder().insert().into(Inventory)
  .values({ productId, quantityOnHand, reorderLevel })
  .orUpdate(['quantity_on_hand', 'reorder_level', 'updated_at'], ['product_id'], { skipUpdateIfNoValuesChanged: true })
  .execute();
// The Repository.upsert(entityOrEntities, ['product_id']) shortcut exists too; neither supports a DO UPDATE ... WHERE guard. Use query() for that.
```

#### Sequelize example

```ts
const order = await Order.create({ userId, shippingAddressId, currency: 'INR' }, { returning: true });
await OrderItem.bulkCreate(items, { returning: ['id', 'productId', 'quantity', 'unitPrice'] });
await Inventory.bulkCreate(rows, { updateOnDuplicate: ['quantityOnHand', 'reorderLevel', 'updatedAt'], conflictAttributes: ['product_id'] });
```

#### Edge cases & failure modes

- `RETURNING` reflects `BEFORE` triggers but not `AFTER` triggers that modify other rows.
- Multi-row insert with one bad row fails the whole statement (good: atomic), but the error message names only the first failure.
- Upsert `SET` lists that overwrite everything downgrade state; always ask "which columns may this source legitimately change".
- `ON CONFLICT DO UPDATE` on a partitioned table requires the conflict target to include the partition key.
- Parameter limit (65,535) in node-postgres; `unnest` with array parameters sidesteps it.
- `INSERT ... SELECT` from a large table without `ORDER BY` and with a unique index: fine; with a `serial` id and expectations of order: no order is guaranteed.

#### Interview questions

1. Why `RETURNING` instead of insert-then-select? Expected: one round trip; database-generated values; consistent snapshot.
2. How do you bulk insert 100,000 rows from Node without hitting the parameter limit? Expected: chunking, `unnest` arrays, or `COPY`.
3. How do you make an upsert never regress a terminal state? Expected: `DO UPDATE ... WHERE existing.status NOT IN (terminal)`.

### 18.15.2 UPDATE ... FROM and DELETE ... USING

#### Concept

`UPDATE target SET ... FROM other WHERE join_condition` updates rows in `target` using values from `other` (a table, a `VALUES` list, or a subquery), joined in the same statement. `DELETE FROM target USING other WHERE ...` deletes rows in `target` that match rows in `other`. Both replace the correlated-subquery form (`SET x = (SELECT ... WHERE ...)`) with a join, which is faster and clearer.

#### How it works

1. The planner joins `target` with the `FROM`/`USING` sources like a normal query.
2. Each `target` row that appears in the join output is updated or deleted once. If a target row matches multiple source rows, PostgreSQL updates it with one of them, arbitrarily; this is a silent bug when the join is not 1:1. Ensure the source is unique per target row (pre-aggregate or `DISTINCT ON`).
3. Row locks are taken on target rows as they are found; a large `UPDATE ... FROM` holds many locks until commit. Batch by key range for large tables.

#### PostgreSQL example

```sql
-- Re-price order items in pending orders from the current catalog (a business decision; shown for the syntax)
UPDATE order_items oi
   SET unit_price = p.price
  FROM products p, orders o
 WHERE p.id = oi.product_id AND o.id = oi.order_id AND o.status = 'pending' AND oi.unit_price <> p.price;

-- Apply a VALUES list of corrections in one statement
UPDATE products p
   SET price = v.new_price, updated_at = now()
  FROM (VALUES ('PHN-001', 47999.00), ('CBL-77', 449.00)) AS v(sku, new_price)
 WHERE p.sku = v.sku;

-- Mark orders as shipped from a shipments batch, with RETURNING for the notification job
UPDATE orders o
   SET status = 'shipped', updated_at = now()
  FROM shipments s
 WHERE s.order_id = o.id AND s.shipped_at >= now() - interval '1 hour' AND o.status = 'paid'
RETURNING o.id, o.user_id, s.tracking_number;

-- The multi-match trap: an order with two shipments matches twice; the update still happens once, with an arbitrary s.tracking_number in RETURNING.
-- Fix with DISTINCT ON in a subquery:
UPDATE orders o SET status = 'shipped'
  FROM (SELECT DISTINCT ON (order_id) order_id, tracking_number FROM shipments ORDER BY order_id, shipped_at DESC) s
 WHERE s.order_id = o.id AND o.status = 'paid';

-- DELETE ... USING: purge notifications of deleted users
DELETE FROM notifications n
 USING users u
 WHERE u.id = n.user_id AND u.deleted_at < now() - interval '30 days';

-- Batched delete for large purges: bounded lock time, vacuum can keep up
DELETE FROM notifications
 WHERE id IN (SELECT id FROM notifications WHERE status = 'sent' AND sent_at < now() - interval '180 days' LIMIT 5000);
-- Loop in the application until 0 rows affected, sleeping 50 ms between batches.
```

#### TypeORM example

```ts
// UPDATE ... FROM is not expressible in QueryBuilder's update(); use query():
await ds.query(
  `UPDATE products p SET price = v.new_price, updated_at = now()
     FROM unnest($1::text[], $2::numeric[]) AS v(sku, new_price)
    WHERE p.sku = v.sku`,
  [skus, prices],
);
// Simple updates are fine in the builder:
await productRepo.createQueryBuilder().update(Product).set({ isActive: false }).where('categoryId = :c', { c }).execute();
```

#### Edge cases & failure modes

- Multiple source matches per target row: arbitrary pick, silent.
- `UPDATE` without `WHERE` updates every row (section 18.21) and locks the whole table's rows until commit.
- `UPDATE` on the same row twice in one statement is not possible; PostgreSQL updates once and ignores the second match.
- Large updates create a dead tuple per row; a 50-million-row update doubles the table until vacuum; batch it.

#### Interview questions

1. What happens when `UPDATE ... FROM` joins one target row to two source rows? Expected: updated once with an arbitrary source; de-duplicate the source.
2. Why batch large deletes? Expected: bounded locks, WAL, and bloat; vacuum can keep up; replication lag stays small.

## 18.16 Locking reads: FOR UPDATE, SKIP LOCKED, FOR NO KEY UPDATE

#### Concept

`SELECT ... FOR UPDATE` reads rows and locks them as if you were about to update them, so no other transaction can update, delete, or lock them `FOR UPDATE` until you commit. `FOR NO KEY UPDATE` is a slightly weaker lock that still blocks concurrent updates but does not block other transactions inserting child rows that reference the row (foreign key `KEY SHARE` locks). `FOR SHARE` and `FOR KEY SHARE` are read locks that block writers but not other readers. `SKIP LOCKED` makes the select skip rows that are already locked instead of waiting; `NOWAIT` makes it error immediately. Together, `FOR UPDATE SKIP LOCKED` is the PostgreSQL job-queue pattern: many workers, each claims different rows, none waits.

#### Why does it exist?

"Read the stock, check it, decrement it" is a race: two transactions read 5, both see enough for 3, both decrement, stock is negative (or the CHECK fails for one after it has done other work). `FOR UPDATE` serializes the read-check-write on that row. Job queues in the database exist because a table with `status = 'pending'` plus `SKIP LOCKED` gives you a transactional queue with no extra infrastructure, exactly-once processing within a transaction, and visibility via SQL, up to a few thousand jobs per second.

#### Mental model

Imagine a library with one copy of a popular book. `FOR UPDATE` is taking the book to your desk: anyone else who wants it waits. `FOR NO KEY UPDATE` is the same, except people are still allowed to add the book to their reading list (insert a child row) while you have it. `SKIP LOCKED` is walking along a shelf of pending returns and picking up the first book that nobody else is holding.

#### How it works

1. The `SELECT` finds rows normally, then for each row takes a row-level lock by writing the transaction id into the tuple header (`xmax`) with a lock-mode flag. Row locks live in the heap, not in a lock table, so locking a million rows does not exhaust memory (but does dirty a million pages).
2. A conflicting locker waits (default), errors (`NOWAIT`), or skips (`SKIP LOCKED`).
3. Locks are released at transaction end. Holding them across an HTTP call or a sleep is how you create lock queues.
4. `FOR UPDATE` conflicts with `FOR KEY SHARE`, which foreign key checks take on the parent row. So locking an `orders` row `FOR UPDATE` blocks inserting `order_items` for that order in another transaction. `FOR NO KEY UPDATE` does not, and is what `UPDATE` of non-key columns takes by default. Prefer `FOR NO KEY UPDATE` unless you intend to change the key or delete.
5. `SKIP LOCKED` with `LIMIT` and an index on the queue predicate gives each worker a disjoint batch. The lock is the claim; the `UPDATE ... SET status = 'processing'` makes the claim visible to non-locking readers and survives the worker's transaction commit.
6. Deadlocks: two transactions locking rows in opposite order. PostgreSQL detects after `deadlock_timeout` (1 s) and aborts one. Always lock in a consistent order (by primary key) when locking several rows. Part 21 (Transactions) covers this in depth.

#### PostgreSQL example

```sql
-- Reserve stock safely: read-check-write under a row lock
BEGIN;
SELECT quantity_on_hand - quantity_reserved AS available
  FROM inventory WHERE product_id = $1 FOR NO KEY UPDATE;
-- application checks available >= requested; if not, ROLLBACK and return 409
UPDATE inventory SET quantity_reserved = quantity_reserved + $2, updated_at = now() WHERE product_id = $1;
COMMIT;
-- Or skip the select entirely and let the CHECK constraint decide (Part 17): a single UPDATE with RETURNING is both atomic and race-free.

-- Lock several rows in a deterministic order to avoid deadlocks
SELECT product_id FROM inventory WHERE product_id = ANY($1::uuid[]) ORDER BY product_id FOR NO KEY UPDATE;

-- The job queue: claim up to 10 due notifications, skipping ones other workers hold
WITH claimed AS (
  SELECT id
    FROM notifications
   WHERE status = 'pending' AND scheduled_at <= now()
   ORDER BY scheduled_at
   LIMIT 10
   FOR UPDATE SKIP LOCKED
)
UPDATE notifications n
   SET status = 'processing', attempts = attempts + 1
  FROM claimed
 WHERE n.id = claimed.id
RETURNING n.id, n.user_id, n.channel, n.template, n.payload;
-- Uses notifications_pending_idx (partial, on scheduled_at WHERE status = 'pending').
-- Workers commit this claim, do the send, then UPDATE ... SET status = 'sent' | 'failed' in a second transaction.
-- If a worker dies after claiming, the row stays 'processing'; a reaper resets rows in 'processing' older than N minutes.

-- NOWAIT for "try to lock, fail fast" (admin actions)
SELECT id FROM orders WHERE id = $1 FOR UPDATE NOWAIT;   -- ERROR 55P03 lock_not_available if someone holds it

-- Seeing who holds what
SELECT pid, state, wait_event_type, wait_event, left(query, 80)
FROM pg_stat_activity WHERE wait_event_type = 'Lock';
SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid, left(blocking.query, 60)
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid));
```

#### NestJS example

A worker using the claim pattern with `@nestjs/schedule`:

```ts
// notifications/notification-worker.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

interface Job { id: string; user_id: string; channel: 'email' | 'sms' | 'push'; template: string; payload: Record<string, unknown> }

@Injectable()
export class NotificationWorker {
  private readonly log = new Logger(NotificationWorker.name);
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly sender: NotificationSender) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async tick(): Promise<void> {
    // 1. Claim in a short transaction; locks are released at commit so other workers proceed immediately.
    const jobs = await this.ds.transaction(async (m) =>
      m.query<Job[]>(
        `WITH claimed AS (
           SELECT id FROM notifications
            WHERE status = 'pending' AND scheduled_at <= now()
            ORDER BY scheduled_at LIMIT 10 FOR UPDATE SKIP LOCKED)
         UPDATE notifications n SET status = 'processing', attempts = attempts + 1
           FROM claimed WHERE n.id = claimed.id
         RETURNING n.id, n.user_id, n.channel, n.template, n.payload`,
      ),
    );

    // 2. Do the slow work outside any transaction; no locks held while calling the provider.
    for (const job of jobs) {
      try {
        await this.sender.send(job);   // has its own timeout (Part 31 - Resilience)
        await this.ds.query(`UPDATE notifications SET status = 'sent', sent_at = now() WHERE id = $1`, [job.id]);
      } catch (err) {
        this.log.warn(`notification ${job.id} failed: ${(err as Error).message}`);
        // 3. Retry with backoff up to 5 attempts, then park as failed.
        await this.ds.query(
          `UPDATE notifications
              SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
                  scheduled_at = now() + make_interval(secs => least(600, 10 * power(2, attempts)))
            WHERE id = $1`,
          [job.id],
        );
      }
    }
  }
}
```

#### TypeORM example

```ts
// Pessimistic locks in QueryBuilder
const inv = await manager.getRepository(Inventory).createQueryBuilder('i')
  .setLock('pessimistic_write')            // FOR UPDATE ; 'pessimistic_partial_write' -> FOR NO KEY UPDATE
  .where('i.productId = :id', { id })
  .getOne();

// SKIP LOCKED
const jobs = await manager.getRepository(Notification).createQueryBuilder('n')
  .setLock('pessimistic_write')
  .setOnLocked('skip_locked')              // or 'nowait'
  .where("n.status = 'pending' AND n.scheduledAt <= now()")
  .orderBy('n.scheduledAt').limit(10)
  .getMany();
// These must run inside a transaction (manager from dataSource.transaction), or the lock is released immediately.
```

#### Sequelize example

```ts
await sequelize.transaction(async (t) => {
  const inv = await Inventory.findOne({ where: { productId }, lock: t.LOCK.UPDATE, transaction: t });   // FOR UPDATE
  const jobs = await Notification.findAll({
    where: { status: 'pending', scheduledAt: { [Op.lte]: new Date() } },
    order: [['scheduledAt', 'ASC']], limit: 10,
    lock: t.LOCK.UPDATE, skipLocked: true, transaction: t,
  });
});
// Sequelize has LOCK.UPDATE, LOCK.SHARE, LOCK.KEY_SHARE, LOCK.NO_KEY_UPDATE.
```

#### Production scenario

A notification queue in PostgreSQL with 8 workers, each claiming 10 rows every 5 seconds, sustains about 1,500 sends per minute with average claim latency of 1 ms and zero duplicate sends. The partial index keeps the claim query fast even with 50 million historical rows, because only pending rows are in it. At around 5,000 jobs per second the pattern starts to strain (index contention on the hot left edge, vacuum of the churned rows), and a dedicated broker (Part 28 — Messaging) becomes the better tool.

#### Failure scenario

At 02:14 the on-call got paged: checkout p99 at 12 seconds. `pg_stat_activity` showed 60 sessions waiting on a row lock in `inventory`. The blocking session was a "reserve stock" transaction that did `SELECT ... FOR UPDATE`, then called the fraud-check API (p99 8 s, and it was having a bad night), then updated. Every other checkout for that popular product queued behind the API call. The fix was to move the external call before the transaction and shrink the locked region to the read-check-write only, roughly 2 ms. The rule: never hold a row lock across a network call.

#### Edge cases & failure modes

- Lock held across an external call or a sleep: lock queue; everything for that row waits.
- `FOR UPDATE` on a parent row blocks child inserts (FK `KEY SHARE` conflict); use `FOR NO KEY UPDATE`.
- `SKIP LOCKED` without `ORDER BY` and an index: workers scan the table; with a partial index they read only pending rows.
- A crashed worker leaves rows in `processing`; a reaper with a timeout is mandatory.
- `FOR UPDATE` with `LIMIT` and a join can lock more rows than returned in some plans; keep the locking query simple (single table, indexed predicate).
- `FOR UPDATE` cannot be used with `GROUP BY`, `DISTINCT`, window functions, or in a view with aggregates.
- Under `REPEATABLE READ`, a `FOR UPDATE` on a row updated by a concurrent committed transaction fails with a serialization error; retry the transaction.
- Deadlocks from inconsistent lock order; always `ORDER BY` primary key when locking multiple rows.

#### How a Senior Backend Engineer thinks about this

They lock the minimum rows, for the minimum time, in a consistent order, and never across I/O. They prefer a single atomic `UPDATE` with a `CHECK` constraint to a `SELECT FOR UPDATE` followed by a decision in code, when the rule can be expressed in SQL. They use `SKIP LOCKED` queues for moderate volumes and value their simplicity: one system, transactional, observable with `SELECT`.

#### Common mistakes

- `FOR UPDATE` outside a transaction (locks released immediately; TypeORM `setLock` without `transaction` is a no-op protection).
- Forgetting the reaper for stuck `processing` rows.
- Locking the parent order `FOR UPDATE` while inserting items in another transaction.
- Polling the queue with `SELECT count(*)` on a table with 50 million rows.

#### Interview questions

1. Explain the `FOR UPDATE SKIP LOCKED` job queue. Expected: claim in a short transaction with `LIMIT`, mark as processing, release locks, do the work, mark done; reaper for stuck rows; partial index on pending.
2. `FOR UPDATE` vs `FOR NO KEY UPDATE`? Expected: the latter does not block FK child inserts; use it unless deleting or changing the key.
3. Why is holding a row lock across an HTTP call dangerous?
4. How does PostgreSQL store row locks? Expected: in the tuple header (`xmax` and flags), not a central lock table.
5. When should the PostgreSQL queue give way to a broker? Expected: thousands of jobs per second, fan-out to many consumers, or replay requirements.

#### Practical exercise

Implement the notification worker with `SKIP LOCKED`, run four instances against a table with 100,000 pending rows, and verify with a `sent_count` per id that no notification is sent twice. Kill one worker mid-batch and verify the reaper recovers its rows. Acceptance criteria: zero duplicates, all rows reach `sent` or `failed`, claim latency under 5 ms measured from the worker.

## 18.17 COPY, TRUNCATE and a first look at EXPLAIN

### 18.17.1 COPY for bulk load and export

`COPY` streams rows between a table and a file or the client connection in text, CSV or binary form. It bypasses per-row statement overhead and is the fastest way to load data: 100,000 to 500,000 rows per second on ordinary hardware, versus 5,000 to 20,000 with batched inserts.

```sql
-- Server-side file (requires superuser or pg_read_server_files; the file is on the DB server)
COPY products (sku, name, category_id, price) FROM '/imports/products.csv' WITH (FORMAT csv, HEADER true);

-- Client-side via psql (\copy reads the local file and streams it)
\copy products (sku, name, category_id, price) FROM 'products.csv' WITH (FORMAT csv, HEADER true)

-- Export a report to CSV
\copy (SELECT id, order_number, total, placed_at FROM orders WHERE placed_at >= '2026-03-01') TO 'march_orders.csv' WITH (FORMAT csv, HEADER true)
```

From Node, the `pg-copy-streams` package pipes a readable stream into `COPY ... FROM STDIN`:

```ts
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const ingest = client.query(copyFrom(`COPY products_staging (sku, name, category_id, price) FROM STDIN WITH (FORMAT csv, HEADER true)`));
  await pipeline(createReadStream('products.csv'), ingest);
  // Validate and merge from staging with ON CONFLICT; constraints on the real table stay on.
  await client.query(`INSERT INTO products (sku, name, category_id, price)
                      SELECT sku, name, category_id, price FROM products_staging
                      ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price`);
  await client.query('COMMIT');
} catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
```

Load into a staging table first: `COPY` fails the whole statement on the first bad row, and merging from staging lets you validate, de-duplicate and upsert with normal SQL. For very large loads, drop non-unique indexes on the staging table, load, then create them.

### 18.17.2 TRUNCATE

`TRUNCATE table` removes all rows instantly by replacing the table's data files, instead of deleting row by row. It is transactional in PostgreSQL (can be rolled back), takes an `ACCESS EXCLUSIVE` lock (blocks everything on that table, briefly), resets nothing unless you say `RESTART IDENTITY`, and refuses to run if another table references this one by foreign key unless you add `CASCADE` (which truncates the referencing tables too; read that twice). It does not fire `DELETE` triggers. Use it for staging and test tables; never on a table with foreign-key children in production without checking what `CASCADE` would reach.

```sql
TRUNCATE products_staging;
TRUNCATE order_items, orders RESTART IDENTITY;    -- both at once, sequence reset
-- TRUNCATE orders;  -> ERROR: cannot truncate a table referenced in a foreign key constraint
```

### 18.17.3 Reading EXPLAIN, the minimum

Part 20 is the deep dive. For now, the five things to read in every plan:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, o.total FROM orders o WHERE o.user_id = $1 ORDER BY o.placed_at DESC LIMIT 20;
-- Limit  (cost=0.56..45.21 rows=20 width=24) (actual time=0.031..0.062 rows=20 loops=1)
--   ->  Index Scan using orders_user_id_placed_at_idx on orders o  (cost=0.56..312.40 rows=140 width=24) (actual time=0.029..0.055 rows=20 loops=1)
--         Index Cond: (user_id = 'a1b2...'::uuid)
--   Buffers: shared hit=6
-- Planning Time: 0.140 ms
-- Execution Time: 0.085 ms
```

1. The scan type on each table. `Index Scan` / `Index Only Scan` / `Bitmap Heap Scan` are index-driven; `Seq Scan` reads the whole table, which is right for small tables or big reports and wrong for a point lookup.
2. `Index Cond` versus `Filter`. `Index Cond` is what the index answered; `Filter` is what was checked row by row afterwards. `Rows Removed by Filter` in the thousands means the index did not cover the predicate.
3. `rows=` estimated versus `actual rows=`. A 10x mismatch means stale statistics or a predicate the planner cannot estimate (jsonb, correlated columns), and every decision downstream (join algorithm, sort strategy) was made on wrong information.
4. `loops=`. A node with `loops=100000` ran 100,000 times; multiply its time by loops.
5. `Buffers: shared hit / read`. Hit is from memory, read is from disk. `read` in the tens of thousands on an OLTP query means the working set does not fit or the query touches far more than it needs.
6. Then the join nodes (section 18.2) and `Sort Method` (section 18.4): `external merge` means a disk sort.

`EXPLAIN` alone shows the plan without running it (safe for `UPDATE`/`DELETE`). `EXPLAIN ANALYZE` runs the statement; wrap data-modifying statements in `BEGIN ... ROLLBACK`.
