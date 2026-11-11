## 25.4 Repository and EntityManager

#### Concept

`Repository<T>` is the object you inject to work with one entity: `find`, `save`, `insert`, `update`, `delete`, `upsert`, `count`, `increment`, `softDelete`, `restore`, `createQueryBuilder`. `EntityManager` has the same methods but takes the entity class as the first argument, so one manager can touch any table. A repository is literally an entity manager with the target pre-filled; transactions hand you a manager because a transaction spans tables.

#### Why does it exist?

Repositories give each module a narrow, typed surface over its own tables, which is what dependency injection wants. The manager exists for the cases that cut across modules: transactions, generic tooling, and raw SQL.

#### How it works

1. `TypeOrmModule.forFeature([Order])` registers a provider whose token is the repository for `Order`; `@InjectRepository(Order)` resolves it. Underneath it is `dataSource.getRepository(Order)`, bound to `dataSource.manager`, which uses any free pooled connection in autocommit mode.
2. Each method builds a query through the query builder (section 25.5) or, for `save()`, through the persist executor, which decides between `INSERT` and `UPDATE` per entity.
3. Inside `dataSource.transaction(async (manager) => ...)`, `manager.getRepository(Order)` returns a repository bound to *that* connection. The injected repository is not (Part 24, section 24.11.4).

### 25.4.1 The `find` family

```ts
import { In, Not, LessThan, MoreThanOrEqual, Between, ILike, IsNull, Raw } from 'typeorm';

// Full options object
const orders = await this.orders.find({
  select: { id: true, status: true, totalCents: true, createdAt: true },   // SELECT only these columns
  where: [                                                                  // array => OR between elements
    { customerId, status: In(['CREATED', 'PAID']) },
    { customerId, totalCents: MoreThanOrEqual(100_000) },
  ],
  relations: { items: true },
  order: { createdAt: 'DESC' },
  skip: 40,
  take: 20,
  withDeleted: false,
});

// Shorthands
await this.orders.findBy({ customerId });                                   // where only
await this.orders.findOne({ where: { id }, relations: { items: { product: true } } }); // where is required in 0.3
await this.orders.findOneBy({ id });                                        // null if missing
await this.orders.findOneByOrFail({ id });                                  // throws EntityNotFoundError
const [rows, total] = await this.orders.findAndCount({ where: { customerId }, take: 20 });
await this.orders.count({ where: { status: 'CREATED' } });
await this.orders.exists({ where: { id } });                                // SELECT 1 ... LIMIT 1

// Operators that map to SQL
await this.products.findBy({ stock: LessThan(10), deletedAt: IsNull() });
await this.products.findBy({ name: ILike('%headphone%') });
await this.products.findBy({ price: Between('10.00', '50.00') });
await this.orders.findBy({ createdAt: Raw((alias) => `${alias} > now() - interval '7 days'`) });
```

`where: { items: { productId } }` filters through a relation (TypeORM adds the join). `findOne` without `where` throws in 0.3; `findOne(id)` from 0.2 is gone, use `findOneBy({ id })`. `findOne` with `order` and no `where` is a full-table sort; watch for it.

### 25.4.2 `save` versus `insert` versus `update` versus `upsert`

These four look interchangeable and are not. Here is what each sends to PostgreSQL for a `Product` with an existing id, taken from the query log.

**`save(entity)`**

```sql
START TRANSACTION
SELECT "Product"."id", "Product"."sku", "Product"."name", "Product"."price", ... FROM "products" "Product" WHERE "Product"."id" IN ($1)
UPDATE "products" SET "name" = $1, "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($2)
COMMIT
```

`save()` first `SELECT`s the current row (to decide insert versus update and to compute which columns changed), then writes *only the changed columns*, bumps `@VersionColumn` and `@UpdateDateColumn`, runs listeners and subscribers, cascades to relations marked `cascade`, and returns the entity with generated values filled in. If no transaction is active it opens one around all of that. For an array it batches the `SELECT` with `IN (...)` and the inserts in chunks, but issues one `UPDATE` per changed entity. Properties that are `undefined` are skipped; `null` is written. Passing a partial object (`save({ id, name })`) works and updates only `name`, which is convenient for PATCH handlers and dangerous when the partial accidentally contains a stale value for another column.

**`insert(values)`**

```sql
INSERT INTO "products"("id", "sku", "name", "price", "stock", ...) VALUES (DEFAULT, $1, $2, $3, $4, ...) RETURNING "id", "version", "created_at", "updated_at"
```

One statement, no `SELECT`, no cascade, no change detection. Duplicate key fails with `23505`. Entity listener methods (`@BeforeInsert`) run only if you pass an entity instance (`repo.create({...})`), not a plain object. Use it for bulk loads and for "I know this is new".

**`update(criteria, partial)`**

```sql
UPDATE "products" SET "stock" = $1, "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = $2
```

One statement, returns `UpdateResult` with `affected`. No `SELECT`, no cascade, no entity listeners, no `save()`-style change detection; but it *does* bump the version and update-date columns. `set({ stock: () => 'stock - 1' })` gives you SQL expressions, which is how atomic updates are written (Part 24, section 24.10).

**`upsert(values, conflictPaths)`**

```sql
INSERT INTO "products"("sku", "name", "price") VALUES ($1, $2, $3)
ON CONFLICT ("sku") DO UPDATE SET "name" = EXCLUDED."name", "price" = EXCLUDED."price"
```

```ts
await this.products.upsert(
  rows.map((r) => ({ sku: r.sku, name: r.name, price: r.price })),
  { conflictPaths: ['sku'], skipUpdateIfNoValuesChanged: true },
);
// For a partial unique index: { conflictPaths: ['sku'], indexPredicate: 'deleted_at IS NULL' }
```

This is the only one of the four that is race-safe for "insert or update by natural key"; `save()` is `SELECT` then `INSERT`, and two concurrent saves of a new SKU both insert (Part 24, section 24.13).

| Method | Statements | Cascades | Listeners | Race-safe upsert | Use for |
|---|---|---|---|---|---|
| `save` | `SELECT` + `INSERT`/`UPDATE` (+ cascades), in a transaction | yes | yes | no | aggregates with relations, entity-centric code |
| `insert` | 1 `INSERT` | no | instances only | no (fails on duplicate) | bulk loads, known-new rows |
| `update` | 1 `UPDATE` | no | no | n/a | partial updates, atomic expressions, criteria-based |
| `upsert` | 1 `INSERT ... ON CONFLICT` | no | no | yes | idempotent writes by natural key |
| `preload` + `save` | `SELECT` + `SELECT` + `UPDATE` | yes | yes | no | PATCH with DTO merge |

### 25.4.3 Custom repositories in NestJS

TypeORM 0.2's `@EntityRepository()` is gone. The 0.3 pattern is a class that extends `Repository<T>` and is a normal NestJS provider.

```ts
// src/orders/orders.repository.ts
import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrdersRepository extends Repository<Order> {
  constructor(dataSource: DataSource) {
    super(Order, dataSource.createEntityManager());   // NOT transactional; see withRepository below
  }

  findOpenForCustomer(customerId: string, limit = 20): Promise<Order[]> {
    return this.createQueryBuilder('o')
      .where('o.customer_id = :customerId', { customerId })
      .andWhere('o.status IN (:...statuses)', { statuses: ['CREATED', 'PAID'] })
      .orderBy('o.created_at', 'DESC')
      .take(limit)
      .getMany();
  }
}

// orders.module.ts: providers: [OrdersRepository, OrdersService]
// Inside a transaction: const repo = manager.withRepository(this.ordersRepository);
```

`manager.withRepository(repo)` returns a copy of the custom repository bound to the transactional manager, keeping your custom methods. Without it, the custom repository's queries run on a separate connection.

### 25.4.4 When to use `EntityManager` directly

Transactions (`dataSource.transaction`, `queryRunner.manager`), generic code that works over many entities (audit, tenant scoping), `manager.query(sql, params)` for raw SQL, and one-off scripts. Inject with `@InjectEntityManager()` or take `DataSource` and use `dataSource.manager`. Business services should mostly see repositories; if every service injects the manager, module boundaries have dissolved.

#### Edge cases & failure modes

- `save()` on an entity whose primary key is set but whose row was deleted inserts a new row with that id.
- `save()` with `@Column({ select: false })` columns cannot see their current value, so change detection treats them as unchanged; to update a password hash use `update()`.
- `findOne` with `relations` and `where` on a relation column, combined with `order` on the parent, can generate a query whose `ORDER BY` refers to a joined alias not in `SELECT DISTINCT`; TypeORM usually handles it, but check the SQL.
- `count()` with `relations` joins them; `countBy` does not.
- `exists()` is `exist()` in TypeORM versions before 0.3.17; both work in later versions with a deprecation warning on the old one.
- `remove(entity)` needs the primary key on the instance; `delete(criteria)` is one statement and skips listeners and cascades.

#### How a Senior Backend Engineer thinks about this

They choose the method by the SQL it produces: `save` for aggregates, `update` for targeted changes, `insert` for bulk, `upsert` for idempotent writes. They know `save()` costs a `SELECT` and a transaction. They keep repositories per module and pass managers only for transactions.

#### Common mistakes

- `save()` in a loop of 10,000 items (30,000 statements).
- `save()` as upsert.
- Reading a column with `select: false` through `find` and being surprised by `undefined`.
- Using the injected repository inside a transaction.
- `findOne({ where: {} })` when the id is `undefined` (matches everything, returns the first row). Validate ids before querying.

#### Interview questions

1. *What SQL does `repository.save()` execute for an existing entity, and why?* Expected: `SELECT` by PK then `UPDATE` of changed columns, in a transaction; change detection and cascades need the current state.
2. *When is `update()` better than `save()`?* Expected: targeted partial updates, atomic expressions, no need for the entity, one statement.
3. *Why is `save()` not an upsert?* Expected: two statements with a race window; `upsert()` uses `ON CONFLICT`.
4. *How do you write a custom repository in TypeORM 0.3 with NestJS?* Expected: extend `Repository<T>`, `super(Entity, dataSource.createEntityManager())`, register as provider; use `withRepository` in transactions.

#### Practical exercise

Implement `PATCH /products/:id` three ways: `preload` + `save`, `update()` with a partial, and `upsert()` keyed on `sku`. Capture the SQL log for each and count statements. Then run 50 concurrent `PATCH`es on one product with each approach and record which produce lost updates. Acceptance criteria: a table of statement counts; an explanation of why `update()` with `stock: () => 'stock - 1'` is the only one that does not lose updates without extra locking.

## 25.5 QueryBuilder

#### Concept

The query builder is a fluent API that assembles a SQL statement piece by piece (`select`, `from`, `join`, `where`, `orderBy`, `limit`) with a parameters map, then either returns raw rows (`getRawMany`) or hydrates entities (`getMany`). It exists for the queries the options object cannot express: joins with conditions, aggregates, subqueries, locks, bulk writes with expressions.

#### Why does it exist?

`find` options cover filters, relations and ordering. They cannot express `SUM(item.qty)`, `HAVING`, a join on a condition other than the foreign key, a subquery in `WHERE`, `FOR UPDATE SKIP LOCKED`, or an `UPDATE ... SET x = x - 1`. The query builder can, while still binding parameters safely and hydrating entities when you want it to.

#### How it works

1. `repository.createQueryBuilder('o')` creates a `SelectQueryBuilder` with `o` as the alias for the entity's table.
2. Each method appends to an expression map; nothing is sent until a `get*` or `execute()` call.
3. `:name` placeholders in strings are collected into a parameters object and emitted as `$1`, `$2` in order. `:...ids` expands an array into `$1, $2, $3`.
4. `getQuery()` and `getParameters()` show the SQL and values; `getQueryAndParameters()` gives both. Use them in tests.
5. `getMany`/`getOne` run the query and hydrate entities (de-duplicating joined rows); `getRawMany`/`getRawOne` return rows with aliased column names (`o_id`, `item_qty`); `getRawAndEntities` returns both.

### 25.5.1 Selecting, joining and filtering

```ts
const orders = await this.orders
  .createQueryBuilder('o')
  .leftJoinAndSelect('o.items', 'item')                    // join and hydrate items
  .leftJoinAndSelect('item.product', 'product')
  .leftJoin('o.customer', 'customer')                      // join for filtering only; not selected
  .where('customer.email ILIKE :email', { email: `%${domain}` })
  .andWhere('o.created_at >= :since', { since })
  .andWhere('o.status IN (:...statuses)', { statuses: ['PAID', 'SHIPPED'] })
  .andWhere(new Brackets((qb) => qb.where('o.total_cents > :big', { big: 50_000 }).orWhere('product.sku = :sku', { sku })))
  .orderBy('o.created_at', 'DESC')
  .addOrderBy('item.id', 'ASC')
  .getMany();
```

**Never interpolate values into the string.** `.where(\`o.status = '${status}'\`)` is SQL injection waiting for a status of `' OR '1'='1`. The only things that may be interpolated are identifiers you control (column names chosen from an allow-list for dynamic sorting). Everything else goes through `:param`.

Joins can take a condition: `.leftJoin('o.items', 'item', 'item.qty > :minQty', { minQty: 2 })`. Joining an unrelated table: `.leftJoin(Refund, 'r', 'r.order_id = o.id')`.

### 25.5.2 `getMany` versus `getRawMany`

`getMany` hydrates entities and only includes columns that map to entity properties. `addSelect('SUM(item.qty)', 'itemCount')` is *not* visible on the entity after `getMany`; it is in the raw row only. For aggregates, use `getRawMany` and type the result yourself, or `getRawAndEntities` to zip them.

```ts
// Revenue per product, last 30 days: a report query. Raw rows, no hydration.
interface ProductRevenueRow { productId: string; name: string; revenueCents: string; units: string }

const rows = await this.dataSource
  .createQueryBuilder()
  .select('p.id', 'productId')
  .addSelect('p.name', 'name')
  .addSelect('SUM(i.qty * i.unit_price_cents)', 'revenueCents')   // bigint sum => string
  .addSelect('SUM(i.qty)', 'units')
  .from(OrderItem, 'i')
  .innerJoin('i.product', 'p')
  .innerJoin('i.order', 'o', 'o.status IN (:...paid)', { paid: ['PAID', 'SHIPPED'] })
  .where('o.created_at >= now() - interval \'30 days\'')
  .groupBy('p.id')
  .addGroupBy('p.name')
  .orderBy('"revenueCents"', 'DESC')
  .limit(50)
  .getRawMany<ProductRevenueRow>();
```

Note the quoting in `orderBy('"revenueCents"')`: aliases with capitals must be double-quoted to survive PostgreSQL's case folding.

### 25.5.3 Pagination: `skip`/`take` versus `offset`/`limit` and the join-multiplication bug

`limit`/`offset` are raw SQL `LIMIT`/`OFFSET`. With a `leftJoinAndSelect` on a one-to-many relation, the database returns one row *per child*, so `LIMIT 20` returns 20 order-item rows, which hydrate into perhaps 6 orders. The page is wrong and the count varies with the data.

`take`/`skip` know about joins. When joins are present TypeORM runs two queries: first the distinct parent ids for the page, then the full joined rows for those ids.

```sql
-- Query 1: which parents are on this page
SELECT DISTINCT "distinctAlias"."o_id" AS "ids_o_id", "distinctAlias"."o_created_at"
FROM (SELECT "o"."id" AS "o_id", "o"."created_at" AS "o_created_at", ...
      FROM "orders" "o" LEFT JOIN "order_items" "item" ON "item"."order_id" = "o"."id"
      WHERE "o"."customer_id" = $1) "distinctAlias"
ORDER BY "distinctAlias"."o_created_at" DESC, "o_id" ASC
LIMIT 20 OFFSET 40;

-- Query 2: everything for those parents
SELECT "o".*, "item".* FROM "orders" "o" LEFT JOIN "order_items" "item" ON ...
WHERE "o"."id" IN ($1, $2, ..., $20)
ORDER BY "o"."created_at" DESC;
```

Cost: two round trips, and the first query sorts *joined* rows before de-duplicating, which on a customer with 50,000 items is slow. The cleaner alternative for wide relations is to paginate the parents alone (`take` without joins, or a plain `LIMIT` on the parent table) and load children with a second `IN (...)` query, which is what `relationLoadStrategy: 'query'` does.

Rule: `take`/`skip` whenever there is a `*AndSelect` join; `limit`/`offset` only when there is no join or you are using `getRawMany`.

### 25.5.4 `getManyAndCount` cost

`getManyAndCount()` runs the page query plus `SELECT COUNT(DISTINCT("o"."id")) FROM "orders" "o" LEFT JOIN ...` with all your joins and filters. On a million-row table with a join that is a full scan per request: 200–800 ms every page load. Options: a separate `count()` without joins when the joins do not affect the count; a cached or approximate count (`reltuples` from `pg_class`, or a counter table) for large tables; or keyset pagination, which needs no count at all and is the right answer for infinite-scroll APIs (see Part 23 on indexes and `EXPLAIN ANALYZE` for why `OFFSET` degrades).

### 25.5.5 Locks

`.setLock('pessimistic_write')`, `.setLock('for_no_key_update')`, `.setOnLocked('skip_locked' | 'nowait')`; requires an active transaction (`.setQueryRunner(queryRunner)` or a transactional manager's `createQueryBuilder`). Part 24, sections 24.6 and 24.10, covers the patterns.

### 25.5.6 Subqueries

```ts
// Products that sold more than 100 units in the last week
const hot = this.dataSource
  .createQueryBuilder()
  .subQuery()
  .select('i.product_id')
  .from(OrderItem, 'i')
  .innerJoin('i.order', 'o')
  .where("o.created_at >= now() - interval '7 days'")
  .groupBy('i.product_id')
  .having('SUM(i.qty) > :units')
  .getQuery();                                              // returns "(SELECT ...)" string

const products = await this.products
  .createQueryBuilder('p')
  .where(`p.id IN ${hot}`)
  .setParameter('units', 100)                                // parameters of the subquery are set on the outer builder
  .getMany();
```

Also possible: `.from((qb) => qb.select(...).from(...), 'sub')` for a derived table, and `.addSelect((qb) => qb.select('COUNT(*)').from(OrderItem, 'i').where('i.order_id = o.id'), 'itemCount')` for a correlated scalar subquery.

### 25.5.7 Insert, update and delete builders

```ts
// Bulk insert with conflict handling (one statement, up to ~1,000 rows per call to stay under the parameter limit)
await this.dataSource.createQueryBuilder().insert().into(Product)
  .values(rows)
  .orUpdate(['name', 'price'], ['sku'], { skipUpdateIfNoValuesChanged: true })   // ON CONFLICT ("sku") DO UPDATE
  .execute();
await this.dataSource.createQueryBuilder().insert().into(Tag).values(tags).orIgnore().execute(); // DO NOTHING

// Atomic update with expression and RETURNING
const r = await this.products.createQueryBuilder().update(Product)
  .set({ stock: () => 'stock - :qty' })
  .where('id = :id AND stock >= :qty', { id, qty })
  .returning(['id', 'stock'])
  .execute();
// r.affected, r.raw[0].stock

// Delete and soft delete by criteria
await this.orders.createQueryBuilder().delete().from(OrderItem).where('order_id = :id', { id }).execute();
await this.products.createQueryBuilder().softDelete().where('status = :s', { s: 'ARCHIVED' }).execute();
```

#### Edge cases & failure modes

- Column names in strings are *database* names when prefixed by a table alias (`o.created_at`) and *property* names when prefixed by an entity alias in `where` on `find`; mixing `o.createdAt` and `o.created_at` works only because TypeORM maps property paths on known aliases. Be consistent.
- `getOne()` with joins and no `take` can hydrate one parent from thousands of rows; `getOne()` uses `LIMIT` only when there are no joins.
- `orderBy` on a computed alias needs quotes; `orderBy` on a joined column with `take` must be included in the distinct subquery (TypeORM does this, but `orderBy(RANDOM())` breaks it).
- `:...ids` with an empty array generates `IN ()`, a syntax error; guard with an early return.
- Parameter names are global to the builder; two `:id` with different values overwrite each other silently.
- `.stream()` requires `pg-query-stream` installed and returns raw rows only.

#### How a Senior Backend Engineer thinks about this

They write the SQL they want first, then express it in the builder, then check `getQuery()` matches. They use `getRawMany` for reports and reserve hydration for aggregates the code will mutate. They use `take`/`skip` with joins and know why. They have a query-count and query-time log per request and look at it after every builder change.

#### Common mistakes

- String interpolation of user input.
- `limit()` with `leftJoinAndSelect`.
- `getManyAndCount()` on a large joined table for every page.
- Expecting `addSelect` aggregates to appear on entities after `getMany`.
- Building dynamic filters by concatenating `where` strings instead of `andWhere` with parameters.

#### Interview questions

1. *Explain the difference between `take` and `limit` in TypeORM.* Expected: `take` paginates parents by distinct ids with two queries when joins exist; `limit` cuts joined rows.
2. *How would you write a "top 50 products by revenue" query with TypeORM?* Expected: query builder with aggregates and `getRawMany`, or raw SQL; not hydration.
3. *How do you prevent SQL injection in a dynamic filter?* Expected: parameters for values, allow-list for identifiers.
4. *Why is `getManyAndCount` expensive and what are the alternatives?* Expected: count query repeats joins; separate cheap count, estimate, keyset.

#### Practical exercise

Build `GET /orders?customerId=&status=&sort=&page=` with dynamic filters and sorting via an allow-list, loading items with `take`/`skip`. Log the SQL. Then implement keyset pagination (`createdAt, id` cursor) for the same endpoint and compare p99 at page 1 and page 500 on a table with 2 million orders. Acceptance criteria: no string interpolation of user values (grep the code); page results are stable; keyset p99 is flat across pages.

## 25.6 Transactions (recap)

`dataSource.transaction(async (manager) => ...)` for the callback form; `createQueryRunner()` with `connect`/`startTransaction`/`commitTransaction`/`rollbackTransaction`/`release` in `finally` for manual control; isolation level as the first argument; every query inside through the transactional manager (`manager.getRepository`, `manager.withRepository`, or a CLS context); nested `manager.transaction` becomes a savepoint; locks through `find({ lock })` or `setLock()`. The full treatment, including propagation across services and the injected-repository bug, is Part 24 — Database Transactions and Concurrency Control, sections 24.11 and 24.13.

## 25.7 Migrations

#### Concept

A migration is a versioned, ordered script that changes the database schema (and sometimes data). TypeORM keeps a `migrations` table recording which scripts have run, generates candidate scripts by diffing your entities against the live schema, and runs pending ones in order.

#### Why does it exist?

Schema changes must be reviewable, repeatable across environments, reversible, and coordinated with code deploys. `synchronize: true` gives you none of that; it applies whatever diff it computes, at boot, with no review and no rollback. Migrations turn schema change into code you can read in a pull request.

#### Mental model

Imagine renovation plans for a building that people live in. You do not "make the building match the drawing" overnight; you file dated work orders, each one small, each one checked, each one with a way to undo it, and you keep a logbook of which have been done. The migrations table is the logbook.

#### How it works

1. A `DataSource` configuration for the CLI (`src/data-source.ts`) points at entities and the migrations directory.
2. `migration:generate` connects, loads entity metadata, reads the live schema, computes the diff, and writes a class with `up()` and `down()` containing raw SQL.
3. You review and edit that SQL. Generated migrations are drafts; they are correct about *what* differs and often wrong about *how* to get there safely (they drop and re-add a renamed column, they add `NOT NULL` without a default to a populated table, they create indexes without `CONCURRENTLY`).
4. `migration:run` reads the `migrations` table, finds classes whose timestamp is not recorded, runs their `up()` in timestamp order and inserts a row per migration. `migration:revert` runs the last one's `down()` and deletes its row.
5. Transaction mode controls whether all pending migrations run in one transaction (`all`, the default), one per migration (`each`), or none. `CREATE INDEX CONCURRENTLY` and `ALTER TYPE ... ADD VALUE` (on older PostgreSQL) cannot run inside a transaction block; those migrations need `none` or a per-migration opt-out.

```ts
// src/data-source.ts (used by the CLI; the NestJS module has its own config that shares the same values)
import 'reflect-metadata';
import { DataSource } from 'typeorm';

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'migrations',
  migrationsTransactionMode: 'each',
  synchronize: false,
});
```

```bash
# Generate from the entity diff (review the output!)
npx typeorm-ts-node-commonjs migration:generate ./src/migrations/AddChannelToOrders -d ./src/data-source.ts
# Create an empty migration for hand-written SQL or data backfills
npx typeorm-ts-node-commonjs migration:create ./src/migrations/BackfillOrderChannel
# Apply, inspect, undo
npx typeorm-ts-node-commonjs migration:run -d ./src/data-source.ts
npx typeorm-ts-node-commonjs migration:show -d ./src/data-source.ts
npx typeorm-ts-node-commonjs migration:revert -d ./src/data-source.ts
# Override the transaction mode for one run
npx typeorm-ts-node-commonjs migration:run -d ./src/data-source.ts --transaction none
```

A generated migration for renaming `Order.channel` to `Order.salesChannel`, exactly as TypeORM writes it, and the version you should commit:

```ts
// GENERATED: loses every value in the column
export class RenameChannel1757200000000 implements MigrationInterface {
  name = 'RenameChannel1757200000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "channel"`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "sales_channel" text`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "sales_channel"`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "channel" text`);
  }
}

// EDITED: a rename is metadata-only in PostgreSQL and keeps the data
export class RenameChannel1757200000000 implements MigrationInterface {
  name = 'RenameChannel1757200000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '3s'`);
    await queryRunner.query(`ALTER TABLE "orders" RENAME COLUMN "channel" TO "sales_channel"`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" RENAME COLUMN "sales_channel" TO "channel"`);
  }
}
```

And an index migration that must run outside a transaction:

```ts
export class IndexOrdersStatus1757200100000 implements MigrationInterface {
  name = 'IndexOrdersStatus1757200100000';
  transaction = false;   // supported in recent 0.3 releases; otherwise run with --transaction none
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_status_created_idx" ON "orders" ("status", "created_at" DESC)`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "orders_status_created_idx"`);
  }
}
```

**Where to run migrations.**

| Approach | How | Pros | Cons |
|---|---|---|---|
| CI/CD step before rollout | pipeline job runs `migration:run` against production, then deploys pods | one runner, clear logs, fails the deploy on error, no race between pods | needs DB credentials in the pipeline; migrations must be backward compatible with the *old* code still running |
| At application startup (`migrationsRun: true`) | each pod runs pending migrations on boot | zero extra infrastructure | N pods race (TypeORM takes no lock; you get `duplicate key` on the migrations table or worse), slow boots fail readiness probes, a bad migration crash-loops the whole deployment |
| Kubernetes Job or init container | a one-off Job runs migrations; deployment waits on it | isolates DB access, one runner | more YAML; must handle "job already ran" idempotently |

Startup migrations are acceptable for a single-instance internal tool. For anything with more than one replica, run migrations from the pipeline or a Job, before the new code rolls out, and write them so the old code keeps working while both versions overlap (expand/contract). Part 27 — Database Migrations and Zero-Downtime Schema Changes covers the full playbook: adding columns with defaults, backfilling in batches, `NOT NULL` via `CHECK ... NOT VALID` then `VALIDATE`, and dropping columns two deploys later.

#### Edge cases & failure modes

- Two branches generate migrations with interleaved timestamps; the merged order runs them in timestamp order, which may not be the order they were tested in. Rebase and regenerate.
- A migration that half-succeeded under `--transaction none` leaves the schema in between; the next run fails at the first statement. Make each statement idempotent (`IF NOT EXISTS`, `IF EXISTS`).
- `migration:generate` sees differences it cannot express (a `CHECK` constraint added by hand) and generates a `DROP CONSTRAINT`. Add hand-written constraints to the entity via `@Check()` so the diff stays empty.
- Enum changes generate type-recreation SQL that rewrites the column and locks the table.
- The `migrations` table is per database, not per schema; multi-schema setups need `migrationsTableName` per data source.
- `migration:revert` runs `down()` of the *last* migration only; reverting three needs three runs, and `down()` of a data-loss migration cannot restore data.

#### How a Senior Backend Engineer thinks about this

They treat generated migrations as a starting point and review every line for locks (`lock_timeout`), data loss, table rewrites and index creation without `CONCURRENTLY`. They run migrations from the pipeline, never from pods. They keep `synchronize: false` in every environment, including local, so that local matches production and the migration is exercised before review. They write backward-compatible migrations and ship the code that needs the new schema in a later deploy.

#### Common mistakes

- `synchronize: true` in a shared environment.
- Committing generated migrations unread.
- `migrationsRun: true` on a multi-replica deployment.
- Adding a `NOT NULL` column without a default to a large table (full rewrite, `ACCESS EXCLUSIVE` lock for minutes).
- Creating an index without `CONCURRENTLY` on a hot table.
- Renaming via drop-and-add.

#### Interview questions

1. *Why is `synchronize: true` dangerous, and what replaces it?* Expected: unreviewed, potentially destructive diffs at boot; migrations.
2. *Where should migrations run in a Kubernetes deployment and why?* Expected: pipeline step or Job before rollout; pods racing and readiness failures otherwise.
3. *Why can `CREATE INDEX CONCURRENTLY` not run in a TypeORM migration by default, and how do you handle it?* Expected: cannot run in a transaction block; `migrationsTransactionMode: 'each'` plus per-migration opt-out or `--transaction none`.
4. *A generated migration drops and re-adds a column. What happened and what do you do?* Expected: property rename; edit to `RENAME COLUMN`.

#### Practical exercise

Rename `Product.attributes` to `Product.metadata`, add a `NOT NULL` `currency char(3)` column with a default to a table with 1 million rows, and add a concurrent index on `orders (status, created_at)`, as three migrations. Acceptance criteria: none of them take an `ACCESS EXCLUSIVE` lock longer than 100 ms (measure with `log_lock_waits` and `lock_timeout = '100ms'`); `migration:generate` afterwards produces an empty diff; `migration:revert` three times restores the schema.
