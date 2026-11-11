## 21.12 Aggregation functions beyond SUM and COUNT

#### Concept

PostgreSQL's aggregates go well past the basic five. The ones a backend engineer uses weekly:

- `count(*)` counts rows; `count(col)` counts non-null values; `count(DISTINCT col)` counts distinct non-null values.
- `array_agg(col ORDER BY ...)` collects values into an array; `string_agg(col, ', ' ORDER BY ...)` joins them into text.
- `jsonb_agg(expr)` and `jsonb_object_agg(key, value)` build JSON; combined with `jsonb_build_object` they return nested documents in one query, which is the SQL answer to N+1.
- `bool_or(cond)` / `bool_and(cond)` ("any child is X", "all children are X").
- `min`/`max` on any orderable type, including timestamps and text.
- `percentile_cont(0.5) WITHIN GROUP (ORDER BY col)` for medians and other percentiles (interpolated); `percentile_disc` for the nearest actual value; `mode()` for the most common value.
- `every()` is an alias of `bool_and`.
- `filter (WHERE ...)` applies to all of them.

#### Why does it exist?

An API that returns an order with its items has two choices: one query for the order plus one per item collection (N+1, or 2 queries with `= ANY`), assembling JSON in TypeScript; or one query that returns the JSON already nested. `jsonb_agg` makes the second possible. Percentiles exist because averages lie: the average delivery time is dragged by a few stuck shipments, and p50/p90 tell the truth. `bool_or` exists so "does this order have any failed payment" is a group predicate, not a join and a `DISTINCT`.

#### Mental model

Imagine a clerk summarizing a folder of receipts for one customer. `count(*)` is the number of receipts. `array_agg` is writing the receipt numbers on a list. `string_agg` is writing them as one comma-separated line. `jsonb_agg` is photocopying the receipts into one bound booklet. `bool_or(is_refund)` is ticking "has at least one refund". `percentile_cont(0.5)` is finding the receipt in the middle when they are sorted by amount.

#### How it works

1. Aggregates run inside `HashAggregate` or `GroupAggregate` (sorted input), one accumulator per group per aggregate.
2. `ORDER BY` inside an aggregate (`array_agg(x ORDER BY y)`) forces the group's rows to be sorted first; it makes the output deterministic and costs a sort per group.
3. `count(DISTINCT col)` needs a sort or hash per group to find distinct values; it is markedly more expensive than `count(col)`. Two `count(DISTINCT a)`, `count(DISTINCT b)` in one query each need their own de-duplication.
4. Ordered-set aggregates (`percentile_cont ... WITHIN GROUP`) sort the group's values and pick or interpolate. Cost is a sort per group; for huge groups consider a sampled or approximate approach.
5. `jsonb_agg` builds the JSON in memory per group. A group with 100,000 rows produces a 100,000-element array; it is a tool for bounded child sets (items of an order), not unbounded ones (all events for a user).

#### PostgreSQL example

```sql
-- COUNT variants on one table: the difference is nulls and distinctness
SELECT count(*)                       AS orders,
       count(cancelled_at)            AS cancelled,           -- non-null cancelled_at only
       count(DISTINCT user_id)        AS distinct_customers,
       count(*) FILTER (WHERE shipping_address_id IS NULL) AS no_address
FROM orders WHERE placed_at >= '2026-03-01';

-- Order with items as nested JSON, one query, no N+1
SELECT o.id, o.order_number, o.status, o.total, o.placed_at,
       jsonb_build_object('id', u.id, 'email', u.email, 'name', u.full_name) AS customer,
       coalesce(items.items, '[]'::jsonb) AS items
FROM orders o
JOIN users u ON u.id = o.user_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
           jsonb_build_object('productId', oi.product_id, 'name', oi.product_name,
                              'quantity', oi.quantity, 'unitPrice', oi.unit_price,
                              'lineTotal', oi.quantity * oi.unit_price)
           ORDER BY oi.id
         ) AS items
  FROM order_items oi WHERE oi.order_id = o.id
) items ON true
WHERE o.id = $1;
-- Result: one row with a `customer` object and an `items` array; node-postgres parses jsonb into JS objects.

-- List page: 20 orders each with their items nested, still one query
SELECT o.id, o.status, o.total,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('name', oi.product_name, 'qty', oi.quantity) ORDER BY oi.id), '[]')
          FROM order_items oi WHERE oi.order_id = o.id) AS items
FROM orders o
WHERE o.user_id = $1
ORDER BY o.placed_at DESC, o.id DESC
LIMIT 20;
-- 20 correlated subqueries, each an index probe: fine. Do not do this over 2 million rows (section 10.11).

-- array_agg and string_agg: tags of products in a category, and a CSV of skus per order
SELECT o.id, string_agg(oi.product_name, ', ' ORDER BY oi.id) AS summary,
       array_agg(oi.product_id) AS product_ids
FROM orders o JOIN order_items oi ON oi.order_id = o.id
WHERE o.user_id = $1
GROUP BY o.id;

-- bool_or / bool_and: order-level flags derived from children
SELECT o.id,
       bool_or(p.status = 'failed')     AS had_failed_attempt,
       bool_or(p.status = 'captured')   AS is_paid,
       bool_and(s.status = 'delivered') AS fully_delivered,
       max(p.created_at)                AS last_payment_activity
FROM orders o
LEFT JOIN payments p  ON p.order_id = o.id
LEFT JOIN shipments s ON s.order_id = o.id
WHERE o.placed_at >= now() - interval '7 days'
GROUP BY o.id;
-- Note: joining two 1:N children multiplies rows, but bool_or/bool_and/max are immune to duplication. sum/count are not.

-- Percentiles: delivery time distribution per carrier (avg would mislead)
SELECT s.carrier,
       count(*)                                                                         AS shipments,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.delivered_at - s.shipped_at)      AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY s.delivered_at - s.shipped_at)      AS p90,
       percentile_cont(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP (ORDER BY s.delivered_at - s.shipped_at) AS p50_90_99,
       avg(s.delivered_at - s.shipped_at)                                               AS mean,
       mode() WITHIN GROUP (ORDER BY date_part('dow', s.delivered_at))                  AS most_common_delivery_dow
FROM shipments s
WHERE s.delivered_at IS NOT NULL AND s.shipped_at >= now() - interval '90 days'
GROUP BY s.carrier ORDER BY p90;
--  carrier   | shipments |   p50    |   p90    |  mean
--  delhivery |    48211  | 2 days   | 4 days   | 2 days 9 hours
--  bluedart  |    22104  | 1 day    | 3 days   | 1 day 14 hours

-- jsonb_object_agg: settings as a map
SELECT jsonb_object_agg(channel, cnt) FROM (SELECT channel, count(*) AS cnt FROM notifications GROUP BY channel) t;
-- {"email": 120400, "push": 88210, "sms": 3011}
```

#### NestJS example

Returning nested JSON straight from the query removes the mapping layer:

```ts
// orders/orders.repository.ts
export interface OrderDetail {
  id: string; order_number: string; status: string; total: string; placed_at: Date;
  customer: { id: string; email: string; name: string };
  items: Array<{ productId: string; name: string; quantity: number; unitPrice: string; lineTotal: string }>;
}

@Injectable()
export class OrdersRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async findDetail(orderId: string): Promise<OrderDetail | null> {
    const rows = await this.ds.query<OrderDetail[]>(
      `SELECT o.id, o.order_number, o.status, o.total, o.placed_at,
              jsonb_build_object('id', u.id, 'email', u.email, 'name', u.full_name) AS customer,
              coalesce((SELECT jsonb_agg(jsonb_build_object(
                          'productId', oi.product_id, 'name', oi.product_name, 'quantity', oi.quantity,
                          'unitPrice', oi.unit_price, 'lineTotal', oi.quantity * oi.unit_price) ORDER BY oi.id)
                        FROM order_items oi WHERE oi.order_id = o.id), '[]'::jsonb) AS items
       FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.id = $1`,
      [orderId],
    );
    return rows[0] ?? null;
  }
}
```

One round trip, roughly 0.4 ms, versus TypeORM `relations: ['user', 'items']` which is either one join with row duplication deduplicated in memory, or two queries. Both are acceptable at low volume; the SQL version is the one that stays fast.

#### TypeORM example

```ts
// relations: two round trips (TypeORM issues a second query for the collection when take() is used)
const order = await orderRepo.findOne({ where: { id }, relations: { user: true, items: true } });

// Or a QueryBuilder with joins and in-memory entity assembly:
const order2 = await orderRepo.createQueryBuilder('o')
  .leftJoinAndSelect('o.user', 'u')
  .leftJoinAndSelect('o.items', 'i')
  .where('o.id = :id', { id })
  .getOne();
// Rows returned = number of items; TypeORM hydrates one Order with items[]. Fine for one order; multiply by a page of 20 with 2 collections and you have 20 x items x payments rows.
```

#### Sequelize example

```ts
const order = await Order.findByPk(id, {
  include: [
    { model: User, as: 'user', attributes: ['id', 'email', 'fullName'] },
    { model: OrderItem, as: 'items', separate: true, order: [['id', 'ASC']] },  // separate: second query, no row multiplication
  ],
});
```

#### Edge cases & failure modes

- `jsonb_agg` over zero rows returns `NULL`, not `[]`; wrap with `coalesce(..., '[]'::jsonb)`.
- `array_agg` of a nullable column includes `NULL` elements; add `FILTER (WHERE col IS NOT NULL)`.
- `string_agg` without `ORDER BY` returns elements in arbitrary order; two runs differ.
- `count(DISTINCT a, b)` is not valid; use `count(DISTINCT (a, b))` with a row constructor.
- Huge JSON documents (thousands of items) built per row blow up memory and response size; paginate the children instead.
- `percentile_cont` on `interval` works; on `text` it does not (no interpolation); use `percentile_disc`.
- Numeric aggregates over `numeric` columns return `numeric` with many digits; round for the API.

#### How a Senior Backend Engineer thinks about this

They return nested documents from SQL when the child set is bounded (items of an order, addresses of a user) and use two queries with `= ANY($ids)` when it is not. They report percentiles, never just averages, for anything time-like. They use `bool_or` to derive flags rather than joining and de-duplicating.

#### Common mistakes

- `count(col)` when `count(*)` was meant, or the reverse.
- `jsonb_agg` without `coalesce`, producing `null` items arrays in the API.
- Averages of delivery times.
- `count(DISTINCT ...)` on every column "to be safe" on a report that runs every minute.

#### Interview questions

1. How do you return an order with its items as nested JSON in one query? Expected: `jsonb_agg(jsonb_build_object(...))` in a `LATERAL` or scalar subquery with `coalesce`.
2. Why is `count(DISTINCT x)` expensive? Expected: per-group sort or hash to de-duplicate.
3. Why report p50 and p90 instead of the mean for delivery time? Expected: skewed distributions; a few outliers move the mean.
4. What does `bool_or` give you that a join does not? Expected: a group-level flag without row multiplication or `DISTINCT`.

#### Practical exercise

Implement `GET /orders/:id` with the single-query JSON approach and with TypeORM relations. Benchmark both at 200 requests per second for an order with 8 items. Then implement `GET /users/:id/orders` with items nested for 20 orders per page. Acceptance criteria: identical JSON output, latency comparison recorded, and the page endpoint shows exactly one query in the log.

## 21.13 Querying jsonb

#### Concept

`jsonb` columns are queried with operators and functions: `->` (get JSON value by key or index), `->>` (get as text), `#>` / `#>>` (by path), `@>` (contains), `<@` (is contained by), `?` (key exists), `?|` / `?&` (any/all keys exist), `jsonb_path_query` / `@?` / `@@` (SQL/JSON path language), `jsonb_array_elements` (unnest an array into rows), `jsonb_each` (unnest an object). A GIN index on the column accelerates `@>`, `?`, `?|`, `?&`, `@?` and `@@`. A B-tree expression index on `(col->>'key')` accelerates equality and range on that one key.

#### Why does it exist?

`products.attributes` holds per-product properties that differ by category. The catalog must still filter by them ("8 GB RAM phones under 20,000"), facet them ("count by brand"), and index them. The operators and index types are how PostgreSQL makes a document column behave like columns when you need it to.

#### How it works

1. `->` returns `jsonb`, so you can chain: `attributes->'dimensions'->>'height'`. `->>` returns `text`, the end of a chain. Cast text results to compare numerically: `(attributes->>'ram_gb')::int`.
2. `@>` asks "does the left document contain the right document as a subset" and is the workhorse for equality filters on one or more keys, because it is GIN-indexable with the default `jsonb_ops` opclass.
3. `jsonb_path_ops` is a smaller, faster GIN opclass that supports only `@>`, `@?` and `@@`, not `?` key-existence. Choose it when you only need containment.
4. Range queries (`ram_gb >= 8`) cannot use GIN containment. Use an expression B-tree index on the cast, or `jsonb_path_ops` with a path predicate `@? '$.ram_gb ? (@ >= 8)'` (which GIN supports in a limited way, often falling back to recheck).
5. Statistics on jsonb are poor: the planner does not know how selective `@> '{"brand":"Acme"}'` is. Expect mediocre row estimates and check plans.

#### PostgreSQL example

```sql
-- Extraction
SELECT id, name,
       attributes->>'brand'                    AS brand,
       (attributes->>'ram_gb')::int            AS ram_gb,
       attributes->'colors'                    AS colors_json,      -- jsonb array
       attributes#>>'{dimensions,height_mm}'   AS height_mm
FROM products WHERE id = $1;

-- Containment (GIN index products_attributes_gin from the reference schema)
SELECT id, name, price FROM products
WHERE attributes @> '{"brand": "Acme", "5g": true}' AND is_active
ORDER BY price LIMIT 40;
-- Bitmap Heap Scan on products
--   Recheck Cond: (attributes @> '{"5g": true, "brand": "Acme"}'::jsonb)
--   ->  Bitmap Index Scan on products_attributes_gin

-- Array containment inside the document: products available in blue
SELECT id FROM products WHERE attributes @> '{"colors": ["blue"]}';   -- array containment is subset semantics

-- Key existence
SELECT count(*) FROM products WHERE attributes ? 'warranty_months';

-- Range on a key: expression index
CREATE INDEX products_attr_ram_idx ON products (((attributes->>'ram_gb')::int)) WHERE attributes ? 'ram_gb';
SELECT id FROM products WHERE (attributes->>'ram_gb')::int >= 8 AND attributes ? 'ram_gb';

-- SQL/JSON path
SELECT id FROM products WHERE attributes @? '$.colors[*] ? (@ == "blue")';
SELECT jsonb_path_query(attributes, '$.dimensions.*') FROM products WHERE id = $1;   -- all dimension values as rows
SELECT id FROM products WHERE jsonb_path_exists(attributes, '$.ram_gb ? (@ >= 8 && @ <= 16)');

-- Faceting: count products per brand within a category (unnest not needed; ->> on a scalar key)
SELECT attributes->>'brand' AS brand, count(*) FROM products
WHERE category_id = $1 AND is_active
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- Unnesting arrays to rows: how many products offer each color
SELECT color, count(*)
FROM products, jsonb_array_elements_text(attributes->'colors') AS color
WHERE category_id = $1 GROUP BY color ORDER BY 2 DESC;

-- Updating a document: set one key, delete one key, append to an array
UPDATE products SET attributes = attributes || '{"warranty_months": 24}' WHERE id = $1;
UPDATE products SET attributes = attributes - 'discontinued_reason' WHERE id = $1;
UPDATE products SET attributes = jsonb_set(attributes, '{colors}', (attributes->'colors') || '"red"') WHERE id = $1;
-- Every one of these rewrites the whole row version (MVCC). Fine at catalog write rates; not for counters.

-- Aggregating notification payloads: the "template variables" report
SELECT template, jsonb_object_keys(payload) AS key, count(*)
FROM notifications WHERE created_at >= now() - interval '1 day'
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

#### TypeORM example

```ts
// Containment with a parameter (send the filter as a JSON string; pg casts it to jsonb)
const acme5g = await productRepo.createQueryBuilder('p')
  .where('p.attributes @> :f::jsonb', { f: JSON.stringify({ brand: 'Acme', '5g': true }) })
  .andWhere('p.isActive = true')
  .orderBy('p.price').limit(40)
  .getMany();

// Range on a key
const highRam = await productRepo.createQueryBuilder('p')
  .where(`(p.attributes->>'ram_gb')::int >= :min`, { min: 8 })
  .andWhere(`p.attributes ? 'ram_gb'`)
  .getMany();
```

#### Sequelize example

```ts
const acme = await Product.findAll({ where: { attributes: { [Op.contains]: { brand: 'Acme', '5g': true } } } });
const highRam = await Product.findAll({ where: literal(`(attributes->>'ram_gb')::int >= 8 AND attributes ? 'ram_gb'`) });
```

#### Edge cases & failure modes

- `->>` returns `NULL` for a missing key and for JSON `null`; `?` distinguishes presence.
- Comparing `attributes->>'price' > '100'` compares text: `'20' > '100'` is true. Cast.
- `@>` with a number: `'{"ram_gb": 8}'` matches `8` but not `"8"` (string). JSON types matter.
- GIN index bloat under heavy updates; `fastupdate` pending list and `gin_pending_list_limit`.
- Large documents are TOASTed; extracting one key decompresses the whole document; keep documents small (under a few KB) for hot paths.
- A parameter typed as `text` compared with `@>` fails: cast `$1::jsonb` explicitly.

#### Interview questions

1. Which index for `attributes @> '{"brand":"Acme"}'` and which for `(attributes->>'ram_gb')::int >= 8`? Expected: GIN on the column; B-tree expression index on the cast.
2. `jsonb_ops` vs `jsonb_path_ops`? Expected: path_ops is smaller and faster for containment only; no key-existence support.
3. Why is `attributes->>'price' > '100'` wrong?

## 21.14 Dates, times and generating series

#### Concept

`timestamptz` arithmetic uses `interval`: `now() - interval '30 days'`, `placed_at + interval '2 hours'`. `date_trunc('day' | 'week' | 'month' | 'hour', ts)` snaps to a boundary. `AT TIME ZONE` converts between `timestamptz` and wall-clock `timestamp` for a zone. `generate_series(start, end, step)` produces rows for every day (or hour, or minute), which is how reports get zero-filled rows for days with no orders. `age()`, `extract()`, `date_part()`, `make_interval()`, `to_char()` round out the toolkit.

#### Why does it exist?

Every report has a time axis. "Orders per day for March" must show zero for March 15 if there were none, and `GROUP BY` alone does not produce rows that do not exist. Time zones exist because the customer in Kolkata and the warehouse in Frankfurt disagree about which day it is, and finance wants the report in one of them, consistently.

#### How it works

1. `date_trunc` on `timestamptz` truncates in the session time zone. To truncate in a specific zone regardless of the session: `date_trunc('day', placed_at AT TIME ZONE 'Asia/Kolkata')` returns a wall-clock `timestamp` in that zone; convert back with `AT TIME ZONE 'Asia/Kolkata'` if you need an instant. PG12+ also accepts `date_trunc('day', placed_at, 'Asia/Kolkata')` directly.
2. `interval` arithmetic with months and days is calendar-aware: `'2026-01-31'::date + interval '1 month'` is `2026-02-28`. Hours are exact.
3. `generate_series` with `timestamptz` and `interval '1 day'` respects DST in the session zone (a day can be 23 or 25 hours); with `date` it steps calendar days.
4. Range predicates on the raw column stay sargable (section 21.1); `date_trunc` on the column in `WHERE` does not.

#### PostgreSQL example

```sql
-- Daily orders and revenue for a month, zero-filled, in IST
WITH days AS (
  SELECT d::date AS day
  FROM generate_series('2026-03-01'::date, '2026-03-31'::date, interval '1 day') d
),
daily AS (
  SELECT (placed_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS orders, sum(total) AS revenue
  FROM orders
  WHERE placed_at >= '2026-03-01 00:00+05:30' AND placed_at < '2026-04-01 00:00+05:30'   -- sargable
    AND status IN ('paid','shipped','delivered')
  GROUP BY 1
)
SELECT days.day, coalesce(daily.orders, 0) AS orders, coalesce(daily.revenue, 0) AS revenue
FROM days LEFT JOIN daily ON daily.day = days.day
ORDER BY days.day;

-- Hourly heatmap of order placement for capacity planning
SELECT extract(dow FROM placed_at AT TIME ZONE 'Asia/Kolkata')::int  AS dow,
       extract(hour FROM placed_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
       count(*)
FROM orders WHERE placed_at >= now() - interval '8 weeks'
GROUP BY 1, 2 ORDER BY 1, 2;

-- Week-over-week: current week vs previous week, aligned by weekday
SELECT date_trunc('week', placed_at)::date AS week_start, count(*) AS orders,
       count(*) - lag(count(*)) OVER (ORDER BY date_trunc('week', placed_at)) AS delta
FROM orders WHERE placed_at >= now() - interval '12 weeks'
GROUP BY 1 ORDER BY 1;

-- Age and SLA checks
SELECT id, now() - placed_at AS age
FROM orders WHERE status = 'paid' AND placed_at < now() - interval '48 hours';   -- paid but not shipped in 2 days

-- Month buckets that respect calendar months
SELECT to_char(date_trunc('month', placed_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, sum(total)
FROM orders GROUP BY 1 ORDER BY 1;

-- Business days between two dates (skip weekends)
SELECT count(*) FROM generate_series('2026-03-02'::date, '2026-03-13'::date, '1 day') d
WHERE extract(isodow FROM d) < 6;   -- 10

-- Epoch conversions for clients that send unix seconds
SELECT to_timestamp(1772323200);                       -- timestamptz
SELECT extract(epoch FROM placed_at)::bigint FROM orders LIMIT 1;
```

#### NestJS example

```ts
// Reports controller: accept a zone and a month, compute sargable bounds in the app
import { DateTime } from 'luxon';

@Get('daily-revenue')
async dailyRevenue(@Query() q: DailyRevenueDto) {
  const start = DateTime.fromISO(q.month + '-01', { zone: q.zone ?? 'Asia/Kolkata' }).startOf('month');
  const end = start.plus({ months: 1 });
  return this.reports.dailyRevenue(start.toJSDate(), end.toJSDate(), q.zone ?? 'Asia/Kolkata');
}
// The SQL then uses $1/$2 as timestamptz bounds and $3 for AT TIME ZONE, keeping the predicate index-friendly.
```

#### Edge cases & failure modes

- `date_trunc('day', ts)` in `WHERE` kills the index; put the truncation in `SELECT`/`GROUP BY` and use a range in `WHERE`.
- `generate_series` with `timestamptz` across DST: days are 23 or 25 hours in zones with DST; India has no DST, but Europe and the US do.
- `now()` is fixed for the transaction; a long batch that stamps `now()` on rows produces identical timestamps.
- `interval '1 month'` from January 31 lands on February 28; monthly billing must decide on "same day or last day" explicitly.
- `extract(dow)` is 0 (Sunday) to 6; `isodow` is 1 (Monday) to 7. Mixing them off-by-ones weekly reports.
- Comparing `timestamptz` to a `date` literal uses the session zone's midnight; set the session zone to UTC in the pool and pass explicit offsets in literals.
- `to_char` output is locale-influenced for month names; use numeric formats for machine consumption.

#### Interview questions

1. How do you get a zero-filled daily report? Expected: `generate_series` for the axis, `LEFT JOIN` the aggregate, `coalesce`.
2. Why put `date_trunc` in `SELECT` but a range in `WHERE`? Expected: sargability.
3. What is the difference between `AT TIME ZONE` on a `timestamptz` and on a `timestamp`? Expected: `timestamptz AT TIME ZONE` gives wall-clock `timestamp` in that zone; `timestamp AT TIME ZONE` interprets the wall-clock as that zone and gives a `timestamptz`.
4. What is `now()` inside a transaction?

#### Practical exercise

Build `GET /reports/daily-revenue?month=2026-03&zone=Asia/Kolkata` with zero-filled days and a week-over-week delta column, using one query. Verify the day boundaries by inserting orders at 23:59 and 00:01 IST and confirming they land on the right days. Acceptance criteria: 31 rows always returned, boundaries correct, `EXPLAIN` shows the `placed_at` index range scan.
