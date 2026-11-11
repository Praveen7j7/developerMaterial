## 17.6 Constraints: the last line of defense

### 17.6.1 NOT NULL, UNIQUE, CHECK

#### Concept

A constraint is a rule the database enforces on every write, no matter where the write comes from. `NOT NULL` says a value must be present. `UNIQUE` says no two rows may share a value (or combination of values). `CHECK` says an expression over the row's own columns must be true. Together they turn "the application should never write bad data" into "the database cannot store bad data".

#### Why does it exist?

Application validation runs in one process, on one code path, on one version of the code. The database sees every write from every version of every service, every migration, every script, and every concurrent transaction. Two requests that each pass application validation can together violate a rule (two users registering the same email in the same millisecond). Only the database, which serializes conflicting writes on the unique index, can reject the second. That is what "last line of defense" means: constraints catch the bugs you did not know you had and the races you cannot prevent in code.

#### Mental model

Imagine an airport. The airline's app checks your passport when you book (application validation). The gate agent checks it again (DTO validation in the controller). Immigration checks it at the border, and immigration does not care which airline you flew or what their app said (the constraint). If every airline were perfect, immigration would be unnecessary. It is not unnecessary.

#### How it works

1. `NOT NULL` is checked when the tuple is formed, before it is written. It is nearly free.
2. `CHECK` is evaluated as an expression against the new row on every insert and update. It can only reference the row's own columns (no subqueries, no other tables). Cost is the expression's cost, typically microseconds.
3. `UNIQUE` creates a unique B-tree index. On insert, the index is probed; if an equal key exists and its transaction is committed, `23505` is raised. If an equal key exists from an uncommitted transaction, the insert waits for that transaction to finish. This wait is what makes unique constraints race-proof: two concurrent inserts of the same email serialize, the first commits, the second gets an error. Not a duplicate, not a "both succeed", an error.
4. Violations abort the current statement and, unless you are using savepoints, the whole transaction. The client receives an error with SQLSTATE `23502` (not null), `23505` (unique), `23514` (check), `23503` (foreign key).

#### Practical example

The reference schema encodes business rules directly:

- `inventory`: `CHECK (quantity_on_hand >= 0)` and `CHECK (quantity_reserved <= quantity_on_hand)`. No code path, no race, no retry storm can oversell. An `UPDATE` that would breach it fails, and the service returns `409 Conflict` to the client.
- `reviews`: `UNIQUE (product_id, user_id)`. One review per user per product, even if the "Submit" button is clicked twice and both requests reach different pods.
- `payments`: `idempotency_key text NOT NULL UNIQUE`. The payment provider's webhook retry, the client's retry, and the queue's redelivery all collapse into one row.
- `shipments`: `CHECK (delivered_at IS NULL OR shipped_at IS NOT NULL)`. Cannot be delivered before being shipped.

#### NestJS example

The application still validates (fast feedback, good error messages), and the constraint catches what validation cannot. Map the SQLSTATE to an HTTP status in one place.

```ts
// common/filters/database-exception.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { Response } from 'express';

interface PgError { code?: string; constraint?: string; detail?: string }

@Catch(QueryFailedError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const pg = exception.driverError as PgError;

    switch (pg.code) {
      case '23505': // unique_violation: duplicate email, duplicate review, duplicate idempotency key
        return res.status(HttpStatus.CONFLICT).json({ error: 'already_exists', constraint: pg.constraint });
      case '23503': // foreign_key_violation: referenced product/user does not exist
        return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({ error: 'invalid_reference', constraint: pg.constraint });
      case '23514': // check_violation: oversell, negative price, bad status
        return res.status(HttpStatus.CONFLICT).json({ error: 'rule_violated', constraint: pg.constraint });
      case '23502': // not_null_violation
        return res.status(HttpStatus.BAD_REQUEST).json({ error: 'missing_field', detail: pg.detail });
      default:
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'database_error' });
    }
  }
}
```

Naming your constraints (`CONSTRAINT inventory_no_oversell CHECK (...)`) is what makes `pg.constraint` useful in that filter and in logs.

#### PostgreSQL example

```sql
-- Named constraints: you will thank yourself when reading logs
ALTER TABLE inventory DROP CONSTRAINT inventory_check;
ALTER TABLE inventory ADD CONSTRAINT inventory_no_oversell
  CHECK (quantity_reserved <= quantity_on_hand);

-- CHECK across columns for state consistency
ALTER TABLE orders ADD CONSTRAINT orders_cancel_consistency
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
-- cancelled  <=> cancelled_at set. Both directions enforced by one boolean equality.

-- CHECK on totals
ALTER TABLE orders ADD CONSTRAINT orders_total_math
  CHECK (total = subtotal - discount);

-- The race: two sessions, same email
-- Session A: INSERT INTO users (email, ...) VALUES ('a@x.com', ...);   -- not yet committed
-- Session B: INSERT INTO users (email, ...) VALUES ('A@X.COM', ...);   -- blocks on users_email_lower_uidx
-- Session A: COMMIT;
-- Session B: ERROR: duplicate key value violates unique constraint "users_email_lower_uidx"
```

#### Edge cases & failure modes

- `UNIQUE` allows multiple `NULL`s. `UNIQUE (order_id, coupon_code)` with a nullable coupon lets one order have many null-coupon rows. Use `NULLS NOT DISTINCT` (PG15+) or make the column `NOT NULL` with a sentinel.
- `CHECK` cannot see other rows. "Total of items equals order total" is not expressible as a `CHECK`; it needs a trigger or application logic.
- `CHECK` with a volatile function (`now()`) is allowed but is a bug: the constraint is checked at write time only, so `CHECK (expires_at > now())` passes at insert and is meaningless later.
- Adding `NOT NULL` to a large existing column scans the table under `ACCESS EXCLUSIVE`. From PG12, if a validated `CHECK (col IS NOT NULL)` already exists, `SET NOT NULL` skips the scan. Pattern: add `CHECK ... NOT VALID`, `VALIDATE`, then `SET NOT NULL`.
- Unique violation inside a transaction aborts the transaction. If you want to "try insert, fall back to select" you need a savepoint or `ON CONFLICT` (next section).
- Constraint errors are the wrong tool for expected user input errors (validate in the DTO), but the right tool for concurrency and cross-service invariants.

#### How a Senior Backend Engineer thinks about this

They write the constraint first and the validation second. For every column: "Can this be null? Why?" For every table: "Which combination of columns must be unique?" For every state machine: "Which column combinations are impossible?" They see a constraint violation in production logs as a success ("the database caught a bug") and add a test that reproduces the path. They also know when a constraint is too expensive: a unique index on a 500-byte text column on a 1-billion-row write-heavy table costs real I/O, and a hash of the value might be the better unique key.

#### Common mistakes

- Skipping `NOT NULL` "to make inserts easier", then discovering nulls in 30 percent of rows two years later.
- Using unnamed constraints and then parsing `detail` strings in error handlers.
- Validating in code, not in the database, and then discovering duplicates created by a data-import script.

#### Interview questions

1. Why add database constraints when the DTO already validates? Expected: many write paths, races, future bugs; unique indexes serialize conflicting writes.
2. What does a unique index do when two uncommitted transactions insert the same key? Expected: the second waits for the first to commit or roll back, then errors or proceeds.
3. Can a `CHECK` constraint reference another table? Expected: no; use FKs, triggers, or exclusion constraints.
4. How do you add `NOT NULL` to a large table without a long lock? Expected: `CHECK ... NOT VALID`, `VALIDATE`, `SET NOT NULL`.

### 17.6.2 Partial unique indexes and unique constraints vs unique indexes

#### Concept

A partial index has a `WHERE` clause and only contains rows matching it. A partial unique index enforces uniqueness only among those rows. This expresses rules like "one default address per user" (unique on `user_id` where `is_default`), "one captured payment per order", "one active subscription per customer", or "unique email among non-deleted users".

A unique constraint (`ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`) and a unique index (`CREATE UNIQUE INDEX`) both create a unique B-tree index. The differences: a constraint can be referenced by a foreign key and appears in `information_schema`; an index can be partial, can use expressions (`lower(email)`), and can be built `CONCURRENTLY`. `ON CONFLICT` works with either, as long as the conflict target matches.

#### Why does it exist?

Many real uniqueness rules are conditional. "Only one default address" cannot be a plain `UNIQUE (user_id, is_default)` because that would also allow only one non-default address. Application-side enforcement ("unset the old default, then set the new one") races: two concurrent requests both unset the old default and both set themselves, and the user ends up with two defaults. The partial unique index makes the second commit fail.

#### How it works

1. `CREATE UNIQUE INDEX addresses_one_default_uidx ON addresses (user_id) WHERE is_default;`
2. On insert or update, PostgreSQL evaluates the predicate for the new row. If it is true, the row's `user_id` is inserted into the index, and the uniqueness check applies. If false, the index is untouched.
3. Rows with `is_default = false` never enter the index, so any number of them per user is fine.
4. The index is also much smaller than a full index (only default rows), so it is cheap to maintain.

#### PostgreSQL example

```sql
-- One default address per user (reference schema)
CREATE UNIQUE INDEX addresses_one_default_uidx ON addresses (user_id) WHERE is_default;

-- Switching the default atomically: both statements in one transaction.
BEGIN;
UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default;
UPDATE addresses SET is_default = true  WHERE id = $2 AND user_id = $1;
COMMIT;
-- If two transactions race, one of them fails on the unique index at its second UPDATE.
-- The application retries once; the retry sees the other's committed default and succeeds.

-- One captured payment per order
CREATE UNIQUE INDEX payments_one_captured_per_order_uidx ON payments (order_id) WHERE status = 'captured';

-- Unique email among live users (soft delete friendly), case-insensitive
CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email)) WHERE deleted_at IS NULL;

-- Unique constraint vs unique index: FK can only reference the constraint (or a full unique index)
ALTER TABLE products ADD CONSTRAINT products_sku_key UNIQUE (sku);   -- FK-referenceable
CREATE UNIQUE INDEX products_sku_uidx ON products (sku);            -- also FK-referenceable (full, non-expression)
CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email)); -- NOT FK-referenceable (expression)
```

#### TypeORM example

```ts
import { Entity, Index, Column } from 'typeorm';

@Entity({ name: 'addresses' })
@Index('addresses_one_default_uidx', ['userId'], { unique: true, where: '"is_default"' })
export class Address {
  @Column('uuid', { name: 'user_id' }) userId!: string;
  @Column('boolean', { name: 'is_default', default: false }) isDefault!: boolean;
}
```

TypeORM's `@Index` with `where` supports partial indexes on PostgreSQL. Expression indexes (`lower(email)`) are not expressible via decorators; write them in a migration with `queryRunner.query(...)`.

#### Sequelize example

```ts
Address.init({ /* ... */ }, {
  sequelize, tableName: 'addresses', underscored: true,
  indexes: [
    { name: 'addresses_one_default_uidx', unique: true, fields: ['user_id'], where: { is_default: true } },
  ],
});
```

#### Edge cases & failure modes

- A partial unique index cannot be the target of a foreign key.
- `ON CONFLICT` with a partial unique index must repeat the predicate: `ON CONFLICT (user_id) WHERE is_default DO ...`.
- Changing the predicate means dropping and recreating the index; build the new one `CONCURRENTLY` before dropping the old.
- Soft delete plus a full (non-partial) unique index means a deleted user's email can never be reused. The partial index is the fix; see section 17.9 for the full soft-delete discussion.

#### Interview questions

1. How do you enforce "only one default address per user" without races? Expected: partial unique index on `(user_id) WHERE is_default`; application retries on conflict.
2. What can a unique constraint do that a unique index cannot, and vice versa? Expected: constraint is FK-referenceable and standard; index can be partial, expression-based, and built concurrently.

### 17.6.3 EXCLUDE constraints

#### Concept

An `EXCLUDE` constraint generalizes `UNIQUE`: instead of "no two rows have equal values", it says "no two rows have values that satisfy operator X". With the `&&` (overlaps) operator on a range, that becomes "no two rows have overlapping ranges", which is the correct way to prevent double bookings: delivery slots, warehouse dock reservations, coupon validity windows, or flash-sale price schedules for a product.

#### Why does it exist?

"Check for overlap, then insert" in application code races exactly like "check for duplicate, then insert". Two requests both see no overlap, both insert, and a delivery slot is double-booked. A `UNIQUE` cannot express overlap. `EXCLUDE USING gist` can, and it is enforced with the same serialize-then-reject mechanism as unique indexes.

#### How it works

1. The constraint is backed by a GiST index (B-trees cannot index "overlaps").
2. Each row contributes its range (`tstzrange(starts_at, ends_at)`) and, optionally, an equality column (`resource_id WITH =`), which needs the `btree_gist` extension so GiST can handle scalar equality.
3. On insert or update, the index is searched for existing rows where all operators are satisfied (same resource AND overlapping range). If one exists, `23P01 exclusion_violation` is raised.

#### PostgreSQL example

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Delivery slots: a courier cannot be booked for overlapping windows
CREATE TABLE delivery_slots (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  courier_id uuid        NOT NULL,
  order_id   uuid        NOT NULL REFERENCES orders(id),
  window     tstzrange   NOT NULL,
  CONSTRAINT delivery_slots_no_overlap
    EXCLUDE USING gist (courier_id WITH =, window WITH &&)
);

INSERT INTO delivery_slots (courier_id, order_id, window)
VALUES ('c1', 'o1', tstzrange('2026-03-01 10:00+05:30', '2026-03-01 11:00+05:30', '[)'));
INSERT INTO delivery_slots (courier_id, order_id, window)
VALUES ('c1', 'o2', tstzrange('2026-03-01 10:30+05:30', '2026-03-01 11:30+05:30', '[)'));
-- ERROR: conflicting key value violates exclusion constraint "delivery_slots_no_overlap"

-- Product price schedules: one active price per product at any instant
CREATE TABLE product_prices (
  product_id uuid          NOT NULL REFERENCES products(id),
  price      numeric(12,2) NOT NULL CHECK (price >= 0),
  valid      tstzrange     NOT NULL,
  EXCLUDE USING gist (product_id WITH =, valid WITH &&)
);
-- Query the price at a point in time; the GiST index serves this too:
SELECT price FROM product_prices WHERE product_id = $1 AND valid @> now();
```

Bound notation: `'[)'` means inclusive start, exclusive end. Two slots `[10:00, 11:00)` and `[11:00, 12:00)` do not overlap. Always use half-open ranges for time.

#### TypeORM example

TypeORM has no decorator for exclusion constraints. Write it in a migration:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeliverySlots1709000000000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await qr.query(`
      CREATE TABLE delivery_slots (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        courier_id uuid NOT NULL,
        order_id uuid NOT NULL REFERENCES orders(id),
        "window" tstzrange NOT NULL,
        CONSTRAINT delivery_slots_no_overlap EXCLUDE USING gist (courier_id WITH =, "window" WITH &&)
      )`);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE delivery_slots`);
  }
}
```

In the entity, map the range column as `@Column({ type: 'tstzrange' }) window!: string;` and parse the `[...,...)` string in a value transformer, or query it with raw SQL. Sequelize has `DataTypes.RANGE(DataTypes.DATE)` with native range parsing for PostgreSQL.

#### Edge cases & failure modes

- GiST index maintenance is slower than B-tree; fine for bookings (hundreds per second), not for millions of inserts per hour.
- Unbounded ranges (`[now, )`) overlap everything after them; "current price" rows must be closed when a new one starts, ideally in one transaction.
- Empty ranges never overlap anything and slip through; add `CHECK (NOT isempty(valid))`.
- Exclusion constraints cannot be deferred to accommodate "move slot A to B while B moves to A" unless declared `DEFERRABLE`, which they can be.

#### Interview questions

1. How do you prevent overlapping bookings for the same resource without races? Expected: `EXCLUDE USING gist (resource WITH =, range WITH &&)` with `btree_gist`.
2. Why `[)` bounds for time ranges?

### 17.6.4 Race-proof "insert if not exists" with ON CONFLICT

#### Concept

`INSERT ... ON CONFLICT (target) DO NOTHING` inserts a row unless a unique constraint or index on `target` already holds an equal key, in which case it does nothing and no error is raised. `DO UPDATE SET ...` turns it into an upsert. The conflict target must match a unique index or constraint exactly (same columns, same expression, same partial predicate).

#### Why does it exist?

The naive pattern is `SELECT ... WHERE email = $1; if not found, INSERT`. Between the select and the insert, another request can insert. Both selects saw nothing; one insert succeeds, one fails with a unique violation, and the whole transaction is aborted. `ON CONFLICT` resolves this inside the insert itself: PostgreSQL attempts the index insert, detects the conflict (waiting for a concurrent uncommitted insert if needed), and follows the `DO` clause. No error, no aborted transaction, one round trip.

#### How it works

1. The row is formed and the unique index is probed ("speculative insertion").
2. If no conflict: normal insert.
3. If a conflict with a committed row: `DO NOTHING` skips, `DO UPDATE` locks the existing row and updates it using `EXCLUDED.column` for the proposed values.
4. If a conflict with an uncommitted row from another transaction: wait. When that transaction commits, treat as conflict; if it rolls back, retry the insert.
5. `RETURNING` returns the inserted or updated row. With `DO NOTHING`, nothing is returned on conflict; to always get the id, use the `DO UPDATE SET col = EXCLUDED.col` trick on a harmless column, or a follow-up select.

#### PostgreSQL example

```sql
-- Idempotent payment attempt creation: the client retries with the same idempotency key.
INSERT INTO payments (order_id, provider, idempotency_key, amount, status)
VALUES ($1, 'razorpay', $2, $3, 'initiated')
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id;
-- First call: returns the new id. Retry: returns zero rows. The service then SELECTs by key.

-- Always return the row (insert or existing), one round trip:
INSERT INTO payments (order_id, provider, idempotency_key, amount, status)
VALUES ($1, 'razorpay', $2, $3, 'initiated')
ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()   -- harmless touch
RETURNING id, status, (xmax = 0) AS inserted;
-- xmax = 0 is true for a freshly inserted row, false for an updated one.

-- Partial unique index as conflict target: predicate must be repeated
INSERT INTO addresses (user_id, line1, city, postal_code, country_code, is_default)
VALUES ($1, $2, $3, $4, 'IN', true)
ON CONFLICT (user_id) WHERE is_default DO NOTHING;

-- Expression index as conflict target
INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3)
ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO NOTHING
RETURNING id;
```

#### NestJS example

```ts
// payments/payments.repository.ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

interface AttemptRow { id: string; status: string; inserted: boolean }

@Injectable()
export class PaymentsRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Creates a payment attempt or returns the existing one for this idempotency key. */
  async createOrGetAttempt(orderId: string, key: string, amount: string): Promise<AttemptRow> {
    const rows = await this.ds.query<AttemptRow[]>(
      `INSERT INTO payments (order_id, provider, idempotency_key, amount, status)
       VALUES ($1, 'razorpay', $2, $3, 'initiated')
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
       RETURNING id, status, (xmax = 0) AS inserted`,
      [orderId, key, amount],
    );
    return rows[0];
  }
}
```

#### TypeORM example

```ts
// Repository API: orIgnore / orUpdate
await paymentRepo
  .createQueryBuilder()
  .insert()
  .into(Payment)
  .values({ orderId, provider: 'razorpay', idempotencyKey: key, amount, status: 'initiated' })
  .orIgnore()                                  // ON CONFLICT DO NOTHING (no target; any unique index)
  .execute();

await inventoryRepo
  .createQueryBuilder()
  .insert()
  .into(Inventory)
  .values({ productId, quantityOnHand: 100 })
  .orUpdate(['quantity_on_hand'], ['product_id'])   // ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand
  .execute();
```

TypeORM's `orUpdate` cannot express partial-index predicates or `WHERE` clauses on the update; drop to `query()` for those.

#### Sequelize example

```ts
// upsert() uses ON CONFLICT on the primary key or a unique constraint it can detect
const [payment, created] = await Payment.upsert(
  { orderId, provider: 'razorpay', idempotencyKey: key, amount, status: 'initiated' },
  { conflictFields: ['idempotency_key'], returning: true },
);
// bulkCreate with updateOnDuplicate for multi-row upserts:
await Inventory.bulkCreate(rows, { updateOnDuplicate: ['quantityOnHand', 'updatedAt'] });
```

#### Failure scenario

A "get or create user by email" endpoint used `findOne` then `save`. Under a marketing campaign, the same email arrived from the mobile app and the web app within 50 ms. `findOne` returned null in both pods; both called `save`; one hit the unique index and threw; TypeORM's transaction was aborted; the controller returned 500; the mobile app retried; now it found the row and succeeded. Users saw a flash of "something went wrong" and support got 200 tickets. The fix was one statement with `ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET updated_at = now() RETURNING id`, which turned a race into a no-op.

#### Edge cases & failure modes

- Conflict target mismatch: `ON CONFLICT (email)` when the index is on `lower(email)` raises "there is no unique or exclusion constraint matching the ON CONFLICT specification".
- `ON CONFLICT DO UPDATE` bumps the row version and generates a dead tuple even when nothing changes. Under extreme write rates, `DO NOTHING` plus a select is cheaper.
- `ON CONFLICT` does not work on a table with multiple candidate unique indexes unless you name the target (or use `ON CONSTRAINT name`).
- Inside `DO UPDATE`, `WHERE` can restrict the update: `DO UPDATE SET status = EXCLUDED.status WHERE payments.status <> 'captured'` (never downgrade a captured payment).
- `ON CONFLICT` is per-row for multi-row inserts, but a multi-row insert that conflicts with itself twice (same key twice in `VALUES`) raises an error: "ON CONFLICT DO UPDATE command cannot affect row a second time". Dedupe the input first.
- Identity sequences are consumed even when the insert is skipped. Gaps are expected.

#### How a Senior Backend Engineer thinks about this

"Every idempotent create is an `INSERT ... ON CONFLICT`." They model the idempotency key as a unique column, not a Redis check. They decide explicitly what "conflict" means for each endpoint (return the existing, update it, or reject with 409) and encode that in the `DO` clause. They avoid `orIgnore()` without a target on tables with several unique indexes, because it hides which rule fired.

#### Common mistakes

- `SELECT` then `INSERT`. It is a race every time.
- Catching the unique violation and retrying in a loop inside the same transaction. The transaction is already aborted; every subsequent statement fails with "current transaction is aborted".
- Using `ON CONFLICT DO UPDATE SET everything` and silently overwriting a `captured` payment with `initiated`.

#### Interview questions

1. Why is `SELECT then INSERT` unsafe, and what is the fix? Expected: race between the two; `ON CONFLICT` handles it inside the insert with speculative insertion.
2. How does `ON CONFLICT` behave when the conflicting row is from an uncommitted transaction? Expected: waits for it, then either conflicts or retries.
3. How do you tell whether the `RETURNING` row was inserted or updated? Expected: `(xmax = 0) AS inserted`.
4. Why must the conflict target repeat a partial index's predicate?

#### Practical exercise

Implement `POST /reviews` so that submitting the same review twice (same user, same product) returns `200` with the existing review id on the second call, using a single `INSERT ... ON CONFLICT`. Load-test it with 50 concurrent identical requests. Acceptance criteria: exactly one row in `reviews`, zero 500 responses, and a Jest test that asserts both.
