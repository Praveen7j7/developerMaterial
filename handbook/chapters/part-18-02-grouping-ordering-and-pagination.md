## 18.3 GROUP BY and HAVING

### 18.3.1 Grouping, HAVING, FILTER and grouping sets

#### Concept

`GROUP BY` collapses rows that share the same values in the listed columns into one row per group, and aggregate functions (`count`, `sum`, `avg`, `min`, `max`, and many more) compute a value per group. `HAVING` filters groups after aggregation, the way `WHERE` filters rows before it. `FILTER (WHERE ...)` restricts which rows feed one aggregate without affecting the others. `GROUPING SETS`, `ROLLUP` and `CUBE` compute several groupings in one pass, producing subtotals and grand totals.

#### Why does it exist?

Every dashboard, report and summary is a grouping: orders per day, revenue per category, reviews per rating. Without `GROUP BY` you would pull millions of rows into the application and aggregate in JavaScript, which is slower, uses memory, and moves the work to the least scalable tier. `HAVING` exists because you cannot filter on an aggregate in `WHERE` (the aggregate does not exist yet when `WHERE` runs). `FILTER` exists to avoid the older `sum(CASE WHEN ... THEN ... END)` idiom. Grouping sets exist so that "by category with subtotals per parent and a grand total" is one scan instead of three queries unioned together.

#### Mental model

Imagine sorting a box of receipts into piles by month. Each pile is a group. Writing the total on top of each pile is `sum()`. Throwing away piles under 1,000 rupees is `HAVING`. Counting only the receipts marked "refund" while still keeping the pile total is `FILTER`. Adding a grand total slip on top of all piles is `ROLLUP`.

#### How it works

1. `FROM` and `JOIN` produce the input rows; `WHERE` filters them.
2. Rows are grouped, either by sorting on the group columns (`GroupAggregate`, used when the input is already sorted or the output must be sorted) or by hashing (`HashAggregate`, used when the number of groups fits in `work_mem`).
3. Aggregates accumulate per group. `FILTER` clauses are evaluated per row per aggregate.
4. `HAVING` drops groups.
5. `SELECT` computes the output columns. Every non-aggregated column in `SELECT` must appear in `GROUP BY`, or be functionally dependent on a grouped primary key (PostgreSQL allows `SELECT u.email` when you `GROUP BY u.id` because `id` is the PK).
6. `ORDER BY`, `LIMIT` apply last.

Order of evaluation, which explains every "column must appear in GROUP BY" and "aggregates not allowed in WHERE" error: `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `SELECT`, `DISTINCT`, `ORDER BY`, `LIMIT`.

#### PostgreSQL example

```sql
-- Orders and revenue per day for March, only days with at least 100 orders
SELECT date_trunc('day', placed_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
       count(*)                                      AS orders,
       sum(total)                                    AS revenue,
       count(*) FILTER (WHERE status = 'cancelled')  AS cancelled,
       sum(total) FILTER (WHERE status IN ('paid','shipped','delivered')) AS realized_revenue,
       avg(total)                                    AS avg_order_value
FROM orders
WHERE placed_at >= '2026-03-01 00:00+05:30' AND placed_at < '2026-04-01 00:00+05:30'
GROUP BY 1
HAVING count(*) >= 100
ORDER BY 1;
--     day     | orders |  revenue   | cancelled | realized_revenue | avg_order_value
-- 2026-03-01  |  41932 | 61240187.50|      1204 |    58119904.00   | 1460.46
-- ...

-- Review distribution per product with the PK-dependency rule
SELECT p.id, p.name,                        -- p.name allowed because p.id is the PK and grouped
       count(r.id)                          AS reviews,
       round(avg(r.rating), 2)              AS avg_rating,
       count(*) FILTER (WHERE r.rating = 5) AS five_star
FROM products p
LEFT JOIN reviews r ON r.product_id = p.id
GROUP BY p.id
HAVING count(r.id) >= 10
ORDER BY avg_rating DESC, reviews DESC
LIMIT 50;
-- Note count(r.id), not count(*): with LEFT JOIN, a product with no reviews yields one row with r.id NULL; count(*) would say 1.

-- ROLLUP: revenue by parent category and child category, with subtotals and a grand total
SELECT coalesce(parent.name, 'ALL')  AS parent_category,
       coalesce(child.name, 'ALL')   AS category,
       sum(oi.quantity * oi.unit_price) AS revenue
FROM order_items oi
JOIN orders o     ON o.id = oi.order_id AND o.status IN ('paid','shipped','delivered')
JOIN products p   ON p.id = oi.product_id
JOIN categories child  ON child.id = p.category_id
LEFT JOIN categories parent ON parent.id = child.parent_id
WHERE o.placed_at >= '2026-03-01' AND o.placed_at < '2026-04-01'
GROUP BY ROLLUP (parent.name, child.name)
ORDER BY parent.name NULLS LAST, child.name NULLS LAST;
-- parent_category | category    | revenue
-- Electronics     | Cables      |  2410500.00
-- Electronics     | Phones      | 48120000.00
-- Electronics     | ALL         | 50530500.00     <- subtotal
-- Home            | Kitchen     |  9100200.00
-- Home            | ALL         |  9100200.00
-- ALL             | ALL         | 59630700.00     <- grand total

-- GROUPING SETS: two independent breakdowns in one scan (by day, and by status)
SELECT date_trunc('day', placed_at)::date AS day, status, count(*)
FROM orders
WHERE placed_at >= '2026-03-01' AND placed_at < '2026-03-08'
GROUP BY GROUPING SETS ((day), (status))
ORDER BY day NULLS LAST, status NULLS LAST;
-- CUBE (a, b) is shorthand for all combinations: (a,b), (a), (b), ().
-- Use GROUPING(col) to tell a real NULL from a subtotal row: GROUPING(parent.name) = 1 means "subtotal over parents".
```

`GROUPING()` is worth remembering: `coalesce(name, 'ALL')` breaks if a real name is `NULL`. `CASE WHEN GROUPING(parent.name) = 1 THEN 'ALL' ELSE parent.name END` does not.

#### The row-multiplication trap: aggregating after a join

This is the most common wrong number in production reports. Joining `orders` to `order_items` produces one row per item. `sum(o.total)` then counts each order's total once per item. An order with three items is tripled.

```sql
-- WRONG: revenue tripled for three-item orders
SELECT u.id, sum(o.total) AS lifetime_value
FROM users u
JOIN orders o      ON o.user_id = u.id
JOIN order_items oi ON oi.order_id = o.id     -- multiplies o rows
GROUP BY u.id;

-- RIGHT (a): aggregate the child first, then join
SELECT u.id, sum(o.total) AS lifetime_value, sum(oi.items) AS items
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN (SELECT order_id, count(*) AS items FROM order_items GROUP BY order_id) oi ON oi.order_id = o.id
GROUP BY u.id;

-- RIGHT (b): do not join what you do not need
SELECT u.id, sum(o.total) FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id;

-- RIGHT (c): count distinct parents when the join is unavoidable (slower; forces dedup)
SELECT u.id, count(DISTINCT o.id) AS orders FROM users u JOIN orders o ON ... JOIN order_items oi ON ... GROUP BY u.id;
```

The rule: aggregate each 1:N child to the parent's grain before joining it to anything else. Two `hasMany` includes in Sequelize or two `leftJoinAndSelect` collections in TypeORM produce exactly this multiplication (orders x items x payments), and the ORM deduplicates entities in memory, which hides the problem until you add `count()` or `sum()`.

#### TypeORM example

```ts
const rows = await dataSource
  .getRepository(Order)
  .createQueryBuilder('o')
  .select("date_trunc('day', o.placed_at AT TIME ZONE 'Asia/Kolkata')::date", 'day')
  .addSelect('count(*)', 'orders')
  .addSelect('sum(o.total)', 'revenue')
  .addSelect("count(*) FILTER (WHERE o.status = 'cancelled')", 'cancelled')
  .where('o.placedAt >= :from AND o.placedAt < :to', { from, to })
  .groupBy('day')
  .having('count(*) >= :min', { min: 100 })
  .orderBy('day')
  .getRawMany<{ day: string; orders: string; revenue: string; cancelled: string }>();
// getRawMany, not getMany: aggregates do not map to entities. All numbers arrive as strings.
```

#### Sequelize example

```ts
import { fn, col, literal } from 'sequelize';
const rows = await Order.findAll({
  attributes: [
    [literal(`date_trunc('day', "placed_at" AT TIME ZONE 'Asia/Kolkata')::date`), 'day'],
    [fn('count', col('id')), 'orders'],
    [fn('sum', col('total')), 'revenue'],
    [literal(`count(*) FILTER (WHERE status = 'cancelled')`), 'cancelled'],
  ],
  where: { placedAt: { [Op.gte]: from, [Op.lt]: to } },
  group: ['day'],
  having: literal('count(*) >= 100'),
  order: [[literal('day'), 'ASC']],
  raw: true,
});
```

#### Production scenario

A "daily sales" dashboard query over 10 million orders with the `placed_at` range index: index scan of 1.3 million rows for the month, `HashAggregate` into 31 groups, about 400 ms. Acceptable once a minute, unacceptable per page view. Materialize it (Part 17, section 17.8) or aggregate incrementally into a `daily_sales` table from a trigger or job. The senior instinct: any `GROUP BY` over more than a few hundred thousand rows on a request path is a materialization candidate.

#### Failure scenario

Finance reported that the "lifetime value" column in the admin panel was 2.7 times the sum of actual invoices. The query joined `orders` to `order_items` and `payments` "to show item count and payment status" and summed `o.total`. Each order was counted `items x payments` times. The numbers had been wrong for four months; nobody noticed because they were consistently wrong. The fix was pre-aggregating items and taking the latest payment via `LATERAL`. The senior lesson: any aggregate after a join must be defended with a comment saying why the join does not multiply, or restructured so it cannot.

#### Edge cases & failure modes

- `count(*)` vs `count(col)` after `LEFT JOIN`: a parent with no children counts as 1 with `count(*)` and 0 with `count(child.id)`.
- `avg()` of an integer column returns `numeric`; `avg()` on `numeric` returns `numeric` with many digits; round for display.
- `sum()` of an empty group is `NULL`; wrap with `coalesce(sum(x), 0)` when the report needs zeros.
- `HashAggregate` with millions of groups spills to disk when `work_mem` is exceeded (PG13+ spills gracefully; earlier versions could OOM). Watch `Disk Usage` in the plan.
- `GROUP BY` on an expression must repeat the expression exactly or use its alias (PostgreSQL allows the output alias and positional `GROUP BY 1`).
- Grouping by `jsonb` or `text` keys is slower than by integers; group by ids and join names in afterwards.
- `DISTINCT` inside aggregates (`count(DISTINCT user_id)`) forces a sort per group and can be 5 to 10 times slower than a plain count; for approximate counts at scale, `hyperloglog` extensions or pre-aggregation.

#### How a Senior Backend Engineer thinks about this

They check the grain of every table in the `FROM` clause and make sure the aggregate runs at the grain of the thing being summed. They write `FILTER` instead of `CASE` for readability. They reach for `ROLLUP` when the UI needs subtotals, instead of three round trips. They know that a `GROUP BY` on a request path over a large range is a signal to materialize. And they keep `count(*) FILTER (WHERE ...)` in their toolkit as the cheapest way to produce five metrics in one scan.

#### Common mistakes

- Filtering aggregates in `WHERE` (does not parse) or filtering rows in `HAVING` (parses, but scans everything before filtering; put row conditions in `WHERE`).
- `SELECT o.status, count(*) ... GROUP BY o.user_id`: error, or silently wrong if the column is functionally dependent in a way you did not intend.
- Summing after joining 1:N children.
- `count(DISTINCT ...)` everywhere, because it "feels safer". It hides join multiplication and costs a sort.

#### Interview questions

1. Why does `WHERE count(*) > 5` fail, and what is the fix? Expected: aggregates do not exist when `WHERE` runs; use `HAVING`.
2. A report sums `orders.total` joined to `order_items` and is too high. Why? Expected: row multiplication; pre-aggregate the child or drop the join.
3. What does `FILTER (WHERE ...)` do and what did people write before it? Expected: per-aggregate row filter; `sum(CASE WHEN ... THEN ... ELSE 0 END)`.
4. What is the difference between `count(*)` and `count(r.id)` after a `LEFT JOIN`?
5. What does `ROLLUP (a, b)` produce? Expected: groups by `(a,b)`, `(a)`, and `()`; subtotals and grand total.

#### Practical exercise

Build the "revenue by parent category with subtotals" query with `ROLLUP`, then produce the same output with three `UNION ALL` queries, compare plans and timings on 5 million order items. Then introduce a deliberate join to `payments` and show the multiplied numbers, then fix it with `LATERAL`. Acceptance criteria: identical output between `ROLLUP` and `UNION ALL`, and a written explanation of the multiplication factor you observed.

## 18.4 ORDER BY, LIMIT, OFFSET and pagination

### 18.4.1 Sorting and the cost of deep offsets

#### Concept

`ORDER BY` sorts the result. `LIMIT n` returns the first n rows. `OFFSET m` skips the first m rows. Together they are the naive pagination pattern: page 500 of 20 rows is `LIMIT 20 OFFSET 9980`. The problem is that `OFFSET` does not skip; it reads and discards. Page 500 reads 10,000 rows to return 20. Page 50,000 reads a million.

Keyset pagination (also called cursor or seek pagination) replaces `OFFSET` with a `WHERE` that starts after the last row of the previous page: `WHERE (placed_at, id) < (:last_placed_at, :last_id) ORDER BY placed_at DESC, id DESC LIMIT 20`. It reads exactly 20 rows regardless of page depth, provided an index exists on the sort columns.

#### Why does it exist?

Sorting is expensive: `O(n log n)` in memory when the input fits `work_mem`, and an external merge sort on disk when it does not. An index on the sort columns is already sorted, so an index scan can produce ordered rows without a `Sort` node at all, and `LIMIT` stops the scan after n rows. That combination (index-provided order plus early termination) is the difference between 0.2 ms and 2 seconds. `OFFSET` breaks early termination: the scan must produce `OFFSET + LIMIT` rows before stopping. Keyset pagination restores it.

#### Mental model

Imagine a bookshelf sorted by date. "Give me the 20 newest" is taking books off one end. "Give me books 9,981 to 10,000" means counting 9,980 books first, every time. "Give me the next 20 after the one dated March 3rd, id 1234" is opening the shelf at that point (index seek) and taking 20.

#### How it works

1. The planner checks whether an index matches the `ORDER BY` columns and direction (an index on `(user_id, placed_at DESC)` matches `WHERE user_id = ? ORDER BY placed_at DESC`, and also `ORDER BY placed_at ASC` by scanning backward).
2. If yes, an `Index Scan` (or `Index Scan Backward`) produces rows in order, and `Limit` stops it after `OFFSET + LIMIT` rows.
3. If no, all matching rows are collected and a `Sort` node sorts them. For `LIMIT`, PostgreSQL uses a top-N heapsort that keeps only `OFFSET + LIMIT` rows in memory, which is faster than a full sort but still reads every input row.
4. If the sort exceeds `work_mem` (default 4 MB), it becomes an external sort using temp files; `EXPLAIN ANALYZE` shows `Sort Method: external merge  Disk: 84512kB`.
5. `OFFSET` is applied by the `Limit` node discarding rows.

#### PostgreSQL example

```sql
-- Order history page 1: index-ordered, early termination
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, order_number, status, total, placed_at
FROM orders WHERE user_id = 'a1b2...'
ORDER BY placed_at DESC, id DESC LIMIT 20;
-- Limit  (actual time=0.031..0.058 rows=20 loops=1)
--   ->  Index Scan using orders_user_id_placed_at_idx on orders  (actual time=0.029..0.052 rows=20 loops=1)
--         Index Cond: (user_id = 'a1b2...')
--   Buffers: shared hit=6
-- Execution Time: 0.081 ms

-- Admin "all orders" page 5,000 with OFFSET: reads 100,020 rows
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, total, placed_at FROM orders
ORDER BY placed_at DESC, id DESC LIMIT 20 OFFSET 100000;
-- Limit  (actual time=212.884..212.905 rows=20 loops=1)
--   ->  Index Scan Backward using orders_placed_at_idx on orders  (actual time=0.026..201.114 rows=100020 loops=1)
--   Buffers: shared hit=98211
-- Execution Time: 212.930 ms
-- 100,020 rows visited, 98,211 buffers, to return 20 rows. Page 50,000 would be 10x worse.

-- Keyset: constant cost at any depth. Client sends the last row's (placed_at, id).
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, total, placed_at FROM orders
WHERE (placed_at, id) < ('2026-02-11 09:14:02.118+05:30', '9f1c...')
ORDER BY placed_at DESC, id DESC LIMIT 20;
-- Limit  (actual time=0.040..0.071 rows=20 loops=1)
--   ->  Index Scan Backward using orders_placed_at_id_idx on orders  (actual time=0.038..0.066 rows=20 loops=1)
--         Index Cond: (ROW(placed_at, id) < ROW('2026-02-11 09:14:02.118+05:30', '9f1c...'))
--   Buffers: shared hit=7
-- Execution Time: 0.094 ms
-- Requires: CREATE INDEX orders_placed_at_id_idx ON orders (placed_at, id);
-- The row-value comparison (a, b) < (x, y) is the correct "strictly after this row" predicate and is index-usable.

-- A sort that does not fit work_mem
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total FROM orders WHERE placed_at >= '2026-01-01' ORDER BY total DESC LIMIT 100;
-- Limit
--   ->  Sort  (actual time=1890.221..1890.240 rows=100 loops=1)
--         Sort Key: total DESC
--         Sort Method: top-N heapsort  Memory: 33kB      <- LIMIT keeps only 100 rows in memory
--         ->  Index Scan using orders_placed_at_idx  (rows=2104411)
-- Without LIMIT: Sort Method: external merge  Disk: 61440kB  (spilled; consider SET work_mem = '256MB' for this session)
```

The tie-breaker column (`id`) in `ORDER BY` is not optional. Two orders in the same microsecond have the same `placed_at`; without a unique tiebreaker, the order between them is undefined, and keyset pagination can skip or repeat rows. Every `ORDER BY` used for pagination ends in a unique column.

#### NestJS example

```ts
// orders/dto/list-orders.dto.ts
import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class ListOrdersDto {
  @IsOptional() @IsString() cursor?: string;         // opaque base64 of {placedAt, id}
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

// orders/orders.service.ts (excerpt)
interface OrderRow { id: string; status: string; total: string; placed_at: Date }

async listForUser(userId: string, dto: ListOrdersDto): Promise<{ items: OrderRow[]; nextCursor: string | null }> {
  const cursor = dto.cursor ? decodeCursor(dto.cursor) : null;   // { placedAt: string; id: string }
  const rows = await this.ds.query<OrderRow[]>(
    `SELECT id, status, total, placed_at
       FROM orders
      WHERE user_id = $1
        AND ($2::timestamptz IS NULL OR (placed_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY placed_at DESC, id DESC
      LIMIT $4`,
    [userId, cursor?.placedAt ?? null, cursor?.id ?? null, dto.limit + 1],   // fetch one extra to know if there is a next page
  );
  const hasMore = rows.length > dto.limit;
  const items = hasMore ? rows.slice(0, dto.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor({ placedAt: last.placed_at.toISOString(), id: last.id }) : null };
}
```

Fetching `limit + 1` rows is the standard trick to know whether a next page exists without a separate `count(*)`. The cursor is opaque to the client so you can change its contents later.

#### TypeORM example

```ts
const qb = orderRepo.createQueryBuilder('o')
  .where('o.userId = :userId', { userId })
  .orderBy('o.placedAt', 'DESC').addOrderBy('o.id', 'DESC')
  .take(limit + 1);
if (cursor) qb.andWhere('(o.placedAt, o.id) < (:placedAt, :id)', { placedAt: cursor.placedAt, id: cursor.id });
const rows = await qb.getMany();
```

`take()`/`skip()` are TypeORM's `LIMIT`/`OFFSET`; when relations are joined, TypeORM turns them into a two-query pattern (ids first). For keyset pagination with joined collections, fetch the page of parent ids first, then load children `WHERE order_id = ANY($1)`.

#### Sequelize example

```ts
const rows = await Order.findAll({
  where: {
    userId,
    ...(cursor ? { [Op.and]: [literal(`("placed_at", "id") < (:placedAt, :id)`)] } : {}),
  },
  order: [['placedAt', 'DESC'], ['id', 'DESC']],
  limit: limit + 1,
  replacements: cursor ? { placedAt: cursor.placedAt, id: cursor.id } : undefined,
});
```

#### Production scenario

A marketplace admin panel offered "jump to page N" over 40 million orders. Page 1 took 2 ms; page 200,000 (which a CSV-exporting script actually requested, iterating page by page) took 6 seconds and read 4 million rows per request. The script's total cost was quadratic: it read 40 million x 20,000 / 2 rows over its run and saturated the replica's I/O for two hours. Switching the script to keyset pagination made the whole export read each row once: 40 million rows in eleven minutes. The admin UI kept `OFFSET` for the first 100 pages (where it is fine) and switched to "next/previous" cursors beyond that.

#### Edge cases & failure modes

- `LIMIT` without `ORDER BY` returns arbitrary rows, different between runs, and different after a `VACUUM` or plan change. Never paginate without a total order.
- `ORDER BY` without a unique tiebreaker makes pagination skip or duplicate rows at page boundaries.
- Keyset with a nullable sort column: `NULL` comparisons break the predicate. Use `coalesce` in both the index expression and the query, or exclude nulls.
- Keyset cannot jump to page N; it only moves forward and backward. Offer "jump" only for shallow pages.
- Deleted or inserted rows between pages: keyset handles them gracefully (no skips, no duplicates); `OFFSET` shifts the window and repeats or skips.
- `ORDER BY random()` sorts the whole table. For "a random product", use `TABLESAMPLE SYSTEM (1)` or a random id range probe.
- `ORDER BY` on a computed column or a joined column may prevent index use; sort on the driving table's indexed column.
- `work_mem` is per sort operation per session; raising it globally with 200 connections and several sorts per query can exhaust RAM. Raise it per session for known heavy reports.
- Index direction: `(placed_at DESC, id DESC)` and `(placed_at ASC, id ASC)` are the same index scanned in opposite directions; `(placed_at DESC, id ASC)` is a different index.

#### How a Senior Backend Engineer thinks about this

Every list endpoint gets a total order ending in a unique column, an index that provides that order under the endpoint's filter, and keyset pagination by default. `OFFSET` is allowed for small bounded pages (an admin table capped at 100 pages) and never for exports or infinite scroll. They check the plan for a `Sort` node on a hot path and treat it as a missing index. They explain to the product manager that "page 4,000 of 20" is not a feature anyone uses and "next page" is.

#### Common mistakes

- `LIMIT 20 OFFSET :page * 20` for infinite scroll.
- `ORDER BY placed_at` without `id`.
- Sorting on a column from a joined table when the driving table's index could have provided the order.
- Running `count(*)` for total pages on every request over a million-row filter.

#### Interview questions

1. Why is `OFFSET 1000000` slow, and what replaces it? Expected: reads and discards a million rows; keyset pagination with a composite index and row-value comparison.
2. Why must a pagination `ORDER BY` end in a unique column?
3. How does `LIMIT` change the sort algorithm? Expected: top-N heapsort keeping only `OFFSET + LIMIT` rows.
4. What is `work_mem` and why is raising it globally risky?
5. What does `LIMIT` without `ORDER BY` return?

#### Practical exercise

Implement `GET /orders?cursor=&limit=` with keyset pagination on `(placed_at, id)`, and a comparison endpoint using `OFFSET`. Seed 5 million orders. Measure both at page 1, page 1,000 and page 100,000. Then delete 50 rows in the middle of the range while paging through both and record which one skips or repeats. Acceptance criteria: plans captured for both, keyset shows constant buffers at any depth, and the deletion test documents the `OFFSET` anomaly.
