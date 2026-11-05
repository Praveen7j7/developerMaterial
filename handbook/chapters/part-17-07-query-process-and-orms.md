## 17.18 The query-writing process a senior follows

#### Concept

A senior engineer does not write a query and ship it. They write it for correctness, check the plan, add or confirm the index, and verify it against production-sized data. The four steps take ten minutes and prevent most of the database incidents in this book.

#### Why does it exist?

Queries behave differently at 1,000 rows and 100 million rows. Development databases have 1,000 rows. Every query works in development. The planner picks different algorithms based on row counts and statistics, so a query that runs in 2 ms on a laptop can run in 40 seconds in production with the identical plan shape but different inputs, or with a completely different plan. The process exists to make the production behavior visible before production.

#### How it works

**Step 1: Write for correctness.** Name the grain of every table in `FROM`. State in a comment which rows you want and what could duplicate them. Handle `NULL`s explicitly. Use `EXISTS`, not `NOT IN`. Put outer-join filters in `ON`. Add a unique tiebreaker to every `ORDER BY` used for pagination. Return only the columns you need.

**Step 2: Check the plan.** `EXPLAIN (ANALYZE, BUFFERS)` against a database with realistic row counts (a masked production snapshot, or a seeded table with the right cardinality). Look for: `Seq Scan` on a large table in an OLTP query, `Rows Removed by Filter` large, `loops=` large, `Sort Method: external`, `Batches > 1`, and estimated-vs-actual mismatches. For parameterized queries, test with representative parameters, including the worst case (the customer with 50,000 orders, the category with 200,000 products).

**Step 3: Add the index, or reshape the query.** If the plan shows a filter that should have been an index condition, add the index (composite, in the right column order, with the right direction, partial if the predicate is fixed). If the plan shows row explosion, pre-aggregate. If it shows `OFFSET`, switch to keyset. If it shows a correlated `SubPlan` with a big loop count, use a derived table or window. Re-run step 2.

**Step 4: Verify with real volume and real concurrency.** Run the query at production data size, then run it under the expected concurrency (a small load test), and watch `pg_stat_statements` for mean and p99 time, rows, and `shared_blks_read`. Confirm the index is actually used in production plans (`auto_explain` for slow queries). Add the query's expected latency to the endpoint's SLO.

Then, and only then, wrap it in the ORM or repository method, with the raw SQL preserved in a comment or a `.sql` file so the next engineer can run it in `psql`.

#### Practical example

Request: "Show a customer's 20 most recent orders with item count and latest payment status."

Step 1 draft:

```sql
-- Grain: one row per order. Items pre-aggregated; latest payment via LATERAL (top-1). No 1:N join at order grain.
SELECT o.id, o.order_number, o.status, o.total, o.placed_at,
       coalesce(ic.n, 0) AS item_count,
       lp.status         AS latest_payment_status
FROM orders o
LEFT JOIN LATERAL (SELECT count(*) AS n FROM order_items oi WHERE oi.order_id = o.id) ic ON true
LEFT JOIN LATERAL (SELECT status FROM payments p WHERE p.order_id = o.id ORDER BY created_at DESC LIMIT 1) lp ON true
WHERE o.user_id = $1
ORDER BY o.placed_at DESC, o.id DESC
LIMIT 20;
```

Step 2 plan (production snapshot, a customer with 3,000 orders):

```text
Limit (actual rows=20 loops=1)
  -> Nested Loop Left Join (actual rows=20 loops=1)
       -> Nested Loop Left Join (actual rows=20 loops=1)
            -> Index Scan using orders_user_id_placed_at_idx on orders o (actual rows=20 loops=1)
                 Index Cond: (user_id = $1)
            -> Aggregate (actual rows=1 loops=20)
                 -> Index Only Scan using order_items_order_id_product_id_key on order_items oi (actual rows=3 loops=20)
       -> Limit (actual rows=1 loops=20)
            -> Index Scan Backward using payments_order_id_created_at_idx on payments p (actual rows=1 loops=20)
Buffers: shared hit=112
Execution Time: 0.412 ms
```

Twenty outer rows, each side a small indexed probe, 112 buffers, sub-millisecond. The `LIMIT` stops the outer scan at 20 rows regardless of how many orders the customer has, because the index provides the sort order. Ship it.

Contrast the naive version, `LEFT JOIN order_items` and `LEFT JOIN payments` at order grain with `count(DISTINCT oi.id)` and `max(p.created_at)`, which has to read all 3,000 orders and all their children before it can `LIMIT`, and multiplies rows on the way.

#### How a Senior Backend Engineer thinks about this

They ask the mantra questions of every query: Can it become slow (what is the largest parameter value in production)? Can it return a wrong response (nulls, duplicates, outer-join filters)? Can it partially succeed (multi-statement without a transaction)? Can it lock (does it hold rows across I/O)? They know that "works on my machine" is a statement about row counts, not correctness.

#### Common mistakes

- Testing only against the seed data.
- Reading the plan without `ANALYZE` (estimates only) or without `BUFFERS` (no I/O visibility).
- Adding an index for the wrong column order and never checking whether it was used.
- Shipping the ORM query without ever seeing the SQL it generates.

#### Interview questions

1. Walk me through how you would take a new query from draft to production. Expected: correctness, plan on realistic data, index or reshape, verify under volume and concurrency, monitor.
2. What is the worst-case parameter for a query, and why test it? Expected: the customer or category with the most rows; plans change with cardinality.

## 17.19 SQL through the ORMs, and when to go raw

### 17.19.1 TypeORM: QueryBuilder and raw queries

#### Concept

TypeORM offers three levels: the `Repository` API (`find`, `findOne`, `save`, `update`), the `QueryBuilder` (a fluent SQL builder that still maps to entities or raw rows), and `dataSource.query()` (raw SQL with positional parameters). Each level down gives more control and less mapping.

#### How it works

- `Repository.find({ where, relations, order, take, skip, select })` generates a `SELECT` with `LEFT JOIN`s for relations. With `take` and a joined collection, TypeORM issues two queries (ids first) to keep the limit on the root entity.
- `createQueryBuilder('alias')` builds SQL piece by piece. `getMany()` hydrates entities (and de-duplicates joined collections); `getRawMany()` returns rows as the driver gives them (use for aggregates and computed columns); `getRawAndEntities()` returns both.
- Parameters are named (`:name`) in the builder and positional (`$1`) in `query()`. Never interpolate values into strings; always use parameters.
- `query()` returns plain rows; column names are as PostgreSQL returns them (snake_case), and `numeric`/`bigint` are strings.

```ts
// Repository level: simple, readable, limited
const orders = await orderRepo.find({
  where: { userId, status: In(['paid', 'shipped']) },
  order: { placedAt: 'DESC', id: 'DESC' },
  take: 20,
  select: { id: true, orderNumber: true, status: true, total: true, placedAt: true },
});

// QueryBuilder level: joins with conditions, aggregates, subqueries
const rows = await orderRepo.createQueryBuilder('o')
  .select(['o.id AS id', 'o.total AS total'])
  .addSelect((qb) => qb.select('count(*)').from(OrderItem, 'oi').where('oi.order_id = o.id'), 'item_count')
  .leftJoin('o.payments', 'p', "p.status = 'captured'")
  .addSelect('p.amount', 'captured_amount')
  .where('o.userId = :userId', { userId })
  .orderBy('o.placedAt', 'DESC').addOrderBy('o.id', 'DESC')
  .limit(20)                      // limit() is raw SQL LIMIT; take() is entity-aware pagination
  .getRawMany<{ id: string; total: string; item_count: string; captured_amount: string | null }>();

// Seeing the SQL before it runs
const sql = orderRepo.createQueryBuilder('o').where('o.userId = :userId', { userId }).getSql();
// Or enable logging: ['query'] in the DataSource for development.

// Raw level: anything PostgreSQL can do
const detail = await dataSource.query(
  `SELECT o.id, jsonb_agg(jsonb_build_object('name', oi.product_name, 'qty', oi.quantity) ORDER BY oi.id) AS items
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.id = $1 GROUP BY o.id`,
  [orderId],
);

// Raw inside a transaction, sharing the connection
await dataSource.transaction(async (manager) => {
  await manager.query(`UPDATE inventory SET quantity_reserved = quantity_reserved + $2 WHERE product_id = $1`, [productId, qty]);
  await manager.getRepository(OrderItem).insert({ orderId, productId, quantity: qty, unitPrice, productName });
});
```

Pitfalls specific to TypeORM SQL generation:

- `take()`/`skip()` with joins produce the two-query pattern and a `DISTINCT` subquery that can be slow; for large pages, fetch ids with a raw keyset query and then load entities `WHERE id IN (...)`.
- `leftJoinAndSelect` of two collections multiplies rows before hydration. Load the second collection with a separate query or `relationLoadStrategy: 'query'`.
- `find({ where: { relation: { field } } })` generates a join; check the SQL, it is not always the join you expect.
- `save()` on an entity with relations issues a `SELECT` first (to diff) and then the writes; for hot paths, use `insert()`/`update()` which do not.
- Entity hydration for 10,000 rows is slow (milliseconds per thousand); use `getRawMany` for reports and exports.

### 17.19.2 Sequelize: findAll with include, literal, and raw query

#### Concept

Sequelize's `findAll` with `include` generates joins; `attributes` with `fn`/`col`/`literal` inserts expressions; `sequelize.query` runs raw SQL with named replacements or bind parameters and can map results to a model.

```ts
// Include with conditions, attributes, and pagination
const orders = await Order.findAll({
  where: { userId, status: { [Op.in]: ['paid', 'shipped'] } },
  attributes: ['id', 'orderNumber', 'status', 'total', 'placedAt'],
  include: [
    { model: Payment, as: 'payments', required: false, where: { status: 'captured' }, attributes: ['amount'] },
    { model: OrderItem, as: 'items', separate: true, attributes: ['productName', 'quantity'] },   // second query; no multiplication
  ],
  order: [['placedAt', 'DESC'], ['id', 'DESC']],
  limit: 20,
  subQuery: false,   // avoid the wrapped subquery Sequelize generates for limit + hasMany include; verify the SQL
});

// Aggregates with fn/col/literal
const perDay = await Order.findAll({
  attributes: [
    [fn('date_trunc', 'day', col('placed_at')), 'day'],
    [fn('count', col('id')), 'orders'],
    [fn('sum', col('total')), 'revenue'],
    [literal(`count(*) FILTER (WHERE status = 'cancelled')`), 'cancelled'],
  ],
  where: { placedAt: { [Op.gte]: from, [Op.lt]: to } },
  group: [fn('date_trunc', 'day', col('placed_at'))],
  order: [[literal('day'), 'ASC']],
  raw: true,
});

// Raw with replacements (escaped and interpolated) or bind (true parameters; preferred)
const [rows] = await sequelize.query(
  `SELECT o.id, lp.status AS latest_payment_status
     FROM orders o
     LEFT JOIN LATERAL (SELECT status FROM payments p WHERE p.order_id = o.id ORDER BY created_at DESC LIMIT 1) lp ON true
    WHERE o.user_id = $userId ORDER BY o.placed_at DESC, o.id DESC LIMIT $limit`,
  { bind: { userId, limit: 20 }, type: QueryTypes.SELECT },
);

// Raw mapped to a model
const mapped = await sequelize.query(`SELECT * FROM orders WHERE user_id = $1 LIMIT 20`, { bind: [userId], model: Order, mapToModel: true });

// Seeing the SQL
const sql = await Order.findAll({ where: { userId }, logging: console.log });
```

Pitfalls specific to Sequelize:

- `limit` with a `hasMany` include and the default `subQuery: true` wraps the parent query in a subquery with the limit, which is correct but often slow; `separate: true` on the include is usually the better fix.
- Two `hasMany` includes without `separate` produce a Cartesian product; `count()` with includes needs `distinct: true`.
- `replacements` escape and interpolate into the SQL string; `bind` sends real parameters. Prefer `bind`.
- `raw: true` returns flat objects with dotted keys for included models (`'items.productName'`) unless `nest: true`.
- `paranoid` filtering does not apply to raw queries.

### 17.19.3 When raw SQL is simply better

Decision table:

| Need | ORM API | Raw SQL |
|---|---|---|
| CRUD by primary key, simple filters, entity hydration | yes | no need |
| Simple joins for a detail page | yes (`relations` / `include`) | fine either way |
| Aggregates and reports | builder with `getRawMany` / `fn` + `literal` | usually clearer |
| Window functions | awkward (`literal` in a subquery) | yes |
| Recursive CTEs | not supported | yes |
| `LATERAL` joins | not supported | yes |
| `INSERT ... ON CONFLICT DO UPDATE ... WHERE` guards | partial (`orUpdate`, `updateOnDuplicate`) | yes for guards |
| `UPDATE ... FROM`, `DELETE ... USING` | no | yes |
| `FOR UPDATE SKIP LOCKED` with `LIMIT` and `RETURNING` in one statement | partial (`setLock` + `setOnLocked`) | yes |
| `jsonb_agg` nested documents | via `addSelect` with raw expression | yes |
| `COPY` | no | yes (`pg-copy-streams`) |
| Keyset pagination with row-value comparison | via `where` with raw expression | yes |

The rule that keeps teams sane: the ORM is for the 80 percent of queries that are boring, and raw SQL lives in repository classes with typed result interfaces, unit-tested against a real database, for the 20 percent that are not. Nobody scatters `query()` calls across controllers; nobody forces a recursive CTE through a query builder.

#### Production scenario

A NestJS service with 140 endpoints: 110 use `Repository`/`Model` APIs, 20 use the builder for filtered lists with aggregates, 10 use raw SQL in repository classes (order detail JSON, category subtree, job claim, keyset lists, upserts with guards, a cohort report). The raw queries are the ones that appear in `pg_stat_statements` as the most executed; they are the ones worth the extra care, and the ones that were tuned with `EXPLAIN` before shipping.

#### Failure scenario

A team standardized on "never write SQL; the ORM will handle it". The order-list page used `find({ relations: ['items', 'payments', 'shipments'], take: 20 })`. In development it was fine. In production, a customer with 800 orders, 3 items each, 2 payments each, 1 shipment each made TypeORM generate a join returning 800 x 3 x 2 x 1 = 4,800 rows, then a `DISTINCT` subquery for the two-query pagination, then hydration of thousands of entities to return 20. Two seconds per page load and 40 MB of heap per request. The fix was one raw query with `LATERAL` and `jsonb_agg`, 3 ms, written by an engineer who read the generated SQL first.

#### Interview questions

1. When do you drop from the ORM to raw SQL? Expected: window functions, recursive CTEs, `LATERAL`, guarded upserts, `UPDATE ... FROM`, `SKIP LOCKED` claims, nested JSON; anywhere the builder obscures the plan.
2. What does TypeORM do with `take()` plus a joined collection? Expected: two queries, ids first with a `DISTINCT` subquery.
3. What is the difference between Sequelize `replacements` and `bind`? Expected: string interpolation with escaping vs true bind parameters.
4. How do you keep raw SQL maintainable in a NestJS codebase? Expected: repository classes, typed result interfaces, integration tests against a real database, SQL visible in `psql`.

#### Practical exercise

Take the order-list endpoint with items and latest payment. Implement it three ways: `Repository.find` with relations, `QueryBuilder` with `getRawMany`, and raw SQL with `LATERAL` and `jsonb_agg`. Log the generated SQL for each, capture plans, and load-test at 100 requests per second for a customer with 1,000 orders. Acceptance criteria: identical JSON from all three; a table of p50/p99 latency and rows transferred; a written recommendation.
