## 18.20 SQL cookbook: production queries on the e-commerce schema

Each recipe is a query you will actually need, written the way a senior would write it, with two or three lines on why. All run against the reference schema (Part 17, section 17.3). Two recipes (wallet balance, cohort retention) add a small table or use `users.created_at`; the DDL is included where needed.

### 18.20.1 Top 10 customers per month by realized revenue

```sql
WITH monthly AS (
  SELECT date_trunc('month', o.placed_at AT TIME ZONE 'Asia/Kolkata')::date AS month,
         o.user_id,
         sum(o.total) AS revenue,
         count(*)     AS orders
  FROM orders o
  WHERE o.status IN ('paid','shipped','delivered')
    AND o.placed_at >= '2026-01-01 00:00+05:30' AND o.placed_at < '2026-07-01 00:00+05:30'
  GROUP BY 1, 2
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY month ORDER BY revenue DESC, user_id) AS rn
  FROM monthly
)
SELECT r.month, r.rn, u.email, r.revenue, r.orders
FROM ranked r JOIN users u ON u.id = r.user_id
WHERE r.rn <= 10
ORDER BY r.month, r.rn;
```

Aggregate first at (month, user) grain, then rank inside each month with `row_number` and a deterministic tiebreaker, then join `users` only for the 60 rows that survive. Joining users before aggregating would hash 1.2 million users for nothing.

### 18.20.2 Revenue by category with parent subtotals and a grand total

```sql
SELECT CASE WHEN GROUPING(parent.name) = 1 THEN 'ALL' ELSE coalesce(parent.name, child.name) END AS parent_category,
       CASE WHEN GROUPING(child.name)  = 1 THEN 'ALL' ELSE child.name END                          AS category,
       sum(oi.quantity * oi.unit_price) AS revenue,
       count(DISTINCT o.id)             AS orders
FROM order_items oi
JOIN orders o          ON o.id = oi.order_id AND o.status IN ('paid','shipped','delivered')
JOIN products p        ON p.id = oi.product_id
JOIN categories child  ON child.id = p.category_id
LEFT JOIN categories parent ON parent.id = child.parent_id
WHERE o.placed_at >= '2026-03-01' AND o.placed_at < '2026-04-01'
GROUP BY ROLLUP (parent.name, child.name)
ORDER BY GROUPING(parent.name), parent.name, GROUPING(child.name), child.name;
```

`ROLLUP` produces leaf rows, per-parent subtotals and the grand total in one scan. `GROUPING()` distinguishes a subtotal row from a real `NULL` parent (a top-level category). Revenue is computed from `order_items` (the invoice grain), not `orders.total`, so discounts and multi-category orders are attributed correctly.

### 18.20.3 An order with its items, customer and latest payment as one JSON document

```sql
SELECT o.id, o.order_number, o.status, o.total, o.currency, o.placed_at,
       jsonb_build_object('id', u.id, 'email', u.email, 'name', u.full_name)                 AS customer,
       (SELECT jsonb_build_object('line1', a.line1, 'city', a.city, 'postalCode', a.postal_code, 'country', a.country_code)
          FROM addresses a WHERE a.id = o.shipping_address_id)                                  AS shipping_address,
       coalesce((SELECT jsonb_agg(jsonb_build_object('productId', oi.product_id, 'name', oi.product_name,
                                                     'quantity', oi.quantity, 'unitPrice', oi.unit_price,
                                                     'lineTotal', oi.quantity * oi.unit_price) ORDER BY oi.id)
                   FROM order_items oi WHERE oi.order_id = o.id), '[]'::jsonb)               AS items,
       (SELECT jsonb_build_object('status', p.status, 'amount', p.amount, 'provider', p.provider, 'at', p.created_at)
          FROM payments p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1)          AS latest_payment
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.id = $1;
```

One round trip returns the whole document; each scalar subquery is a single index probe, so this is about 0.3 ms. `coalesce` turns a missing items array into `[]` rather than `null`.

### 18.20.4 Latest payment per order for a batch of orders

```sql
-- Small batch (a page of orders): LATERAL, one probe per order
SELECT o.id, lp.*
FROM orders o
LEFT JOIN LATERAL (
  SELECT p.id AS payment_id, p.status, p.amount, p.created_at
  FROM payments p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1
) lp ON true
WHERE o.id = ANY($1::uuid[]);

-- Whole table (a report): DISTINCT ON, one pass
SELECT DISTINCT ON (p.order_id) p.order_id, p.id AS payment_id, p.status, p.amount, p.created_at
FROM payments p
ORDER BY p.order_id, p.created_at DESC;
```

`LATERAL` wins when the outer set is small because it probes `payments_order_id_created_at_idx` per order. `DISTINCT ON` wins over millions of rows because it is a single sorted pass (and that index provides the sort). Both are top-1-per-group; pick by outer cardinality.

### 18.20.5 Inventory at or below reorder level, with pending demand

```sql
SELECT p.sku, p.name, i.quantity_on_hand, i.quantity_reserved,
       i.quantity_on_hand - i.quantity_reserved AS available,
       i.reorder_level,
       coalesce(pd.pending_qty, 0)              AS pending_demand
FROM inventory i
JOIN products p ON p.id = i.product_id AND p.is_active
LEFT JOIN LATERAL (
  SELECT sum(oi.quantity) AS pending_qty
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.product_id = i.product_id AND o.status = 'pending'
) pd ON true
WHERE i.quantity_on_hand - i.quantity_reserved <= i.reorder_level
ORDER BY available, p.sku;
```

The filter runs on `inventory` first (small table, one row per product), and the pending-demand lookup only runs for products that are already low. An expression index on `(quantity_on_hand - quantity_reserved)` would help if the inventory table were large; at catalog sizes it is a fast sequential scan.

### 18.20.6 Abandoned checkouts: pending orders with no payment attempt in 24 hours

```sql
SELECT o.id, o.user_id, u.email, o.total, o.placed_at,
       now() - o.placed_at AS age
FROM orders o
JOIN users u ON u.id = o.user_id AND u.deleted_at IS NULL
WHERE o.status = 'pending'
  AND o.placed_at < now() - interval '24 hours'
  AND o.placed_at > now() - interval '7 days'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.created_at > now() - interval '24 hours')
  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = o.user_id AND n.template = 'abandoned_checkout'
                    AND n.created_at > now() - interval '7 days')
ORDER BY o.placed_at
LIMIT 500;
```

`orders_open_status_idx` (partial on `status IN ('pending','paid')`) makes the driving scan tiny. Both anti-joins are `NOT EXISTS` (null-safe). The second one prevents nagging a customer more than once a week, and the `LIMIT` bounds the batch for the reminder job.

### 18.20.7 Cohort retention: percent of each signup month's users who ordered in months 0, 1, 2, 3

```sql
WITH cohorts AS (
  SELECT id AS user_id, date_trunc('month', created_at)::date AS cohort_month
  FROM users WHERE created_at >= '2025-09-01'
),
activity AS (
  SELECT DISTINCT o.user_id, date_trunc('month', o.placed_at)::date AS active_month
  FROM orders o WHERE o.status IN ('paid','shipped','delivered')
),
joined AS (
  SELECT c.cohort_month, c.user_id,
         (extract(year FROM a.active_month) - extract(year FROM c.cohort_month)) * 12
         + (extract(month FROM a.active_month) - extract(month FROM c.cohort_month)) AS month_offset
  FROM cohorts c JOIN activity a ON a.user_id = c.user_id AND a.active_month >= c.cohort_month
),
sizes AS (SELECT cohort_month, count(*) AS cohort_size FROM cohorts GROUP BY 1)
SELECT s.cohort_month, s.cohort_size,
       round(100.0 * count(DISTINCT j.user_id) FILTER (WHERE j.month_offset = 0) / s.cohort_size, 1) AS m0,
       round(100.0 * count(DISTINCT j.user_id) FILTER (WHERE j.month_offset = 1) / s.cohort_size, 1) AS m1,
       round(100.0 * count(DISTINCT j.user_id) FILTER (WHERE j.month_offset = 2) / s.cohort_size, 1) AS m2,
       round(100.0 * count(DISTINCT j.user_id) FILTER (WHERE j.month_offset = 3) / s.cohort_size, 1) AS m3
FROM sizes s LEFT JOIN joined j ON j.cohort_month = s.cohort_month
GROUP BY s.cohort_month, s.cohort_size
ORDER BY s.cohort_month;
```

Cohort by signup month, activity as distinct (user, month) pairs, offset in months, then conditional `count(DISTINCT)` per offset pivoted into columns. Cohort size comes from a separate CTE so cohorts with zero activity still appear with 0 percent.

### 18.20.8 Deduplicate users by email, keeping the newest, and repoint children

```sql
BEGIN;
WITH ranked AS (
  SELECT id, lower(email) AS email_key,
         row_number()  OVER (PARTITION BY lower(email) ORDER BY created_at DESC, id DESC) AS rn,
         first_value(id) OVER (PARTITION BY lower(email) ORDER BY created_at DESC, id DESC) AS keeper_id
  FROM users WHERE deleted_at IS NULL
),
dupes AS (SELECT id AS dupe_id, keeper_id FROM ranked WHERE rn > 1)
UPDATE orders o SET user_id = d.keeper_id FROM dupes d WHERE o.user_id = d.dupe_id;
-- repeat for addresses, reviews, notifications (reviews may hit UNIQUE (product_id, user_id); handle with ON CONFLICT or delete the dupe's review)
UPDATE users u SET deleted_at = now(), status = 'deleted', email = 'merged+' || u.id || '@example.invalid'
FROM (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY lower(email) ORDER BY created_at DESC, id DESC) AS rn
                      FROM users WHERE deleted_at IS NULL) r WHERE rn > 1) d
WHERE u.id = d.id;
COMMIT;
```

`row_number` picks the keeper; `first_value` carries the keeper's id onto every duplicate row so children can be repointed. The merge is one transaction: either every child moves and the duplicates are retired, or nothing changes. Soft-deleting with a rewritten email keeps the partial unique index happy.

### 18.20.9 Claim pending jobs with SKIP LOCKED

```sql
WITH claimed AS (
  SELECT id FROM notifications
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
```

Workers never wait on each other; the partial index `notifications_pending_idx` keeps the scan to due rows; the claim and its visibility (`processing`) happen in one statement so a crash between "lock" and "mark" is impossible. Pair it with a reaper: `UPDATE notifications SET status = 'pending' WHERE status = 'processing' AND updated_at < now() - interval '10 minutes'`.

### 18.20.10 Running balance per wallet from a ledger

```sql
CREATE TABLE wallet_entries (
  id         bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid          NOT NULL REFERENCES users(id),
  amount     numeric(12,2) NOT NULL CHECK (amount <> 0),        -- positive credit, negative debit
  reason     text          NOT NULL,
  ref_id     uuid,                                               -- order or payment id
  created_at timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX wallet_entries_user_id_created_at_idx ON wallet_entries (user_id, created_at, id);

-- Statement with running balance
SELECT id, created_at, reason, amount,
       sum(amount) OVER (PARTITION BY user_id ORDER BY created_at, id
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance_after
FROM wallet_entries
WHERE user_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 50;

-- Current balance for everyone (report) and a guard against negative balances
SELECT user_id, sum(amount) AS balance FROM wallet_entries GROUP BY user_id HAVING sum(amount) < 0;
```

A ledger is append-only, so the balance is a running sum; `ROWS` with an `id` tiebreaker makes it exact even when two entries share a timestamp. For the "current balance" hot path, keep a `wallets.balance` column maintained by a trigger on `wallet_entries` (Part 17, section 17.8) and reconcile against this sum nightly.

### 18.20.11 Products never ordered, per category

```sql
SELECT c.name AS category, p.sku, p.name, p.created_at
FROM products p
JOIN categories c ON c.id = p.category_id
WHERE p.is_active
  AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.id)
ORDER BY c.name, p.created_at;
```

Anti-join with `NOT EXISTS`; `order_items_product_id_idx` makes each probe cheap, and the planner may turn it into a `Hash Anti Join` over the whole catalog. `NOT IN (SELECT product_id FROM order_items)` would be equivalent here only because `product_id` is `NOT NULL`; `NOT EXISTS` does not depend on that.

### 18.20.12 Daily revenue, zero-filled, with 7-day moving average

```sql
WITH days AS (
  SELECT d::date AS day FROM generate_series(current_date - 59, current_date, interval '1 day') d
),
daily AS (
  SELECT (placed_at AT TIME ZONE 'Asia/Kolkata')::date AS day, sum(total) AS revenue
  FROM orders
  WHERE status IN ('paid','shipped','delivered')
    AND placed_at >= (current_date - 59)::timestamp AT TIME ZONE 'Asia/Kolkata'
  GROUP BY 1
)
SELECT days.day,
       coalesce(daily.revenue, 0) AS revenue,
       round(avg(coalesce(daily.revenue, 0)) OVER (ORDER BY days.day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2) AS avg_7d
FROM days LEFT JOIN daily ON daily.day = days.day
ORDER BY days.day;
```

`generate_series` supplies the axis so quiet days show as zero, and the moving average is a `ROWS` frame over the zero-filled series, which is the only way it is correct on days with no orders.

### 18.20.13 Delivery time percentiles per carrier and per week

```sql
SELECT date_trunc('week', s.shipped_at)::date AS week, s.carrier,
       count(*) AS shipments,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.delivered_at - s.shipped_at) AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY s.delivered_at - s.shipped_at) AS p90,
       count(*) FILTER (WHERE s.delivered_at - s.shipped_at > interval '5 days') AS late
FROM shipments s
WHERE s.delivered_at IS NOT NULL AND s.shipped_at >= now() - interval '12 weeks'
GROUP BY 1, 2
ORDER BY 1, 2;
```

Medians and p90 on `interval` values with `percentile_cont`; a `late` count via `FILTER` in the same pass. The mean is deliberately absent.

### 18.20.14 Churn risk: customers whose last order was 90 to 180 days ago

```sql
SELECT u.id, u.email, last.last_order_at, last.lifetime_orders, last.lifetime_value
FROM users u
JOIN LATERAL (
  SELECT max(o.placed_at) AS last_order_at, count(*) AS lifetime_orders, sum(o.total) AS lifetime_value
  FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid','shipped','delivered')
) last ON true
WHERE u.deleted_at IS NULL
  AND last.last_order_at BETWEEN now() - interval '180 days' AND now() - interval '90 days'
  AND last.lifetime_orders >= 2
ORDER BY last.lifetime_value DESC
LIMIT 1000;
```

Correct but, over 1.2 million users, it is one aggregate per user (`loops=1200000`). For a nightly job that is acceptable (a few minutes on a replica). For anything more frequent, maintain `customer_summary` (Part 17, section 17.8) and query that: `WHERE last_order_at BETWEEN ...` on an indexed column.

### 18.20.15 Rating histogram and average per product, pivoted

```sql
SELECT p.id, p.name,
       count(r.id)                                    AS reviews,
       round(avg(r.rating), 2)                        AS avg_rating,
       count(*) FILTER (WHERE r.rating = 5)           AS star5,
       count(*) FILTER (WHERE r.rating = 4)           AS star4,
       count(*) FILTER (WHERE r.rating = 3)           AS star3,
       count(*) FILTER (WHERE r.rating = 2)           AS star2,
       count(*) FILTER (WHERE r.rating = 1)           AS star1
FROM products p
LEFT JOIN reviews r ON r.product_id = p.id
WHERE p.id = ANY($1::uuid[])
GROUP BY p.id;
```

`FILTER` pivots the rating distribution into columns in one pass; `count(r.id)` (not `count(*)`) returns 0 for products with no reviews after the `LEFT JOIN`. The `FILTER` counts are zero for those products because `NULL = 5` is unknown.

### 18.20.16 Top 3 products per category by units sold in the last 30 days

```sql
WITH sold AS (
  SELECT p.category_id, p.id AS product_id, p.name, sum(oi.quantity) AS units
  FROM order_items oi
  JOIN orders o   ON o.id = oi.order_id AND o.status IN ('paid','shipped','delivered') AND o.placed_at >= now() - interval '30 days'
  JOIN products p ON p.id = oi.product_id
  GROUP BY p.category_id, p.id, p.name
)
SELECT category_id, product_id, name, units
FROM (SELECT *, row_number() OVER (PARTITION BY category_id ORDER BY units DESC, product_id) AS rn FROM sold) t
WHERE rn <= 3
ORDER BY category_id, rn;
```

Aggregate to (category, product) grain first, then `row_number` per category. `dense_rank` would return more than three rows on ties; `row_number` with a tiebreaker returns exactly three.

### 18.20.17 Order status funnel for a period

```sql
SELECT count(*)                                                     AS placed,
       count(*) FILTER (WHERE status <> 'cancelled')                AS not_cancelled,
       count(*) FILTER (WHERE status IN ('paid','shipped','delivered')) AS paid,
       count(*) FILTER (WHERE status IN ('shipped','delivered'))    AS shipped,
       count(*) FILTER (WHERE status = 'delivered')                 AS delivered,
       round(100.0 * count(*) FILTER (WHERE status = 'delivered') / nullif(count(*), 0), 1) AS delivered_pct
FROM orders
WHERE placed_at >= $1 AND placed_at < $2;
```

Five funnel stages in one index range scan; `nullif` guards the division when the period has no orders.

### 18.20.18 Catalog search by attributes, tags and price, with facets

```sql
-- Results page
SELECT p.id, p.name, p.price, p.attributes->>'brand' AS brand
FROM products p
WHERE p.is_active
  AND p.category_id = ANY($1::bigint[])                       -- subtree ids from the recursive CTE, cached
  AND p.attributes @> $2::jsonb                                -- e.g. {"brand":"Acme","5g":true}
  AND p.tags && $3::text[]                                     -- any of the requested tags
  AND p.price BETWEEN $4 AND $5
ORDER BY p.price, p.id
LIMIT 40;

-- Brand facet counts for the same filter (without the brand condition)
SELECT p.attributes->>'brand' AS brand, count(*)
FROM products p
WHERE p.is_active AND p.category_id = ANY($1::bigint[]) AND p.tags && $3::text[] AND p.price BETWEEN $4 AND $5
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

The GIN indexes on `attributes` and `tags` combine with the B-tree on `category_id` through a `BitmapAnd`. Facets are the same predicate minus the facet's own dimension. Beyond a few hundred thousand products with many facets, this moves to a search engine; below that, PostgreSQL is enough.

### 18.20.19 Reconcile payments against a provider settlement file

```sql
-- settlement_lines loaded with COPY: (provider_payment_id text, amount numeric, settled_at timestamptz)
SELECT coalesce(p.provider_payment_id, s.provider_payment_id) AS provider_payment_id,
       p.id AS our_payment_id, p.amount AS our_amount, s.amount AS their_amount,
       CASE WHEN p.id IS NULL THEN 'missing_in_db'
            WHEN s.provider_payment_id IS NULL THEN 'missing_in_settlement'
            WHEN p.amount <> s.amount THEN 'amount_mismatch' END AS issue
FROM (SELECT * FROM payments WHERE status = 'captured' AND created_at >= $1 AND created_at < $2) p
FULL JOIN settlement_lines s ON s.provider_payment_id = p.provider_payment_id
WHERE p.id IS NULL OR s.provider_payment_id IS NULL OR p.amount <> s.amount
ORDER BY 1;
```

`FULL JOIN` surfaces rows missing on either side; the `payments` side is pre-filtered in a derived table so the outer join keeps unmatched settlement lines. An index on `payments (provider_payment_id)` makes the join a merge or hash on two sorted inputs.

### 18.20.20 Category breadcrumb and subtree ids

```sql
-- Breadcrumb (walk up)
WITH RECURSIVE up AS (
  SELECT id, parent_id, name, 0 AS depth FROM categories WHERE id = $1
  UNION ALL
  SELECT c.id, c.parent_id, c.name, up.depth + 1 FROM categories c JOIN up ON c.id = up.parent_id WHERE up.depth < 10
)
SELECT string_agg(name, ' > ' ORDER BY depth DESC) AS breadcrumb, array_agg(id ORDER BY depth DESC) AS id_path FROM up;

-- Subtree ids (walk down), cached in Redis for 10 minutes by the service
WITH RECURSIVE down AS (
  SELECT id FROM categories WHERE id = $1
  UNION ALL
  SELECT c.id FROM categories c JOIN down ON c.parent_id = down.id
) CYCLE id SET is_cycle USING path
SELECT array_agg(id) AS ids FROM down WHERE NOT is_cycle;
```

Two recursive CTEs, one up, one down; the depth guard and `CYCLE` clause protect against corrupt trees; the subtree array feeds recipe 18 as `$1::bigint[]`.

### 18.20.21 Customers with a failed payment and no successful retry (support follow-up)

```sql
SELECT o.id AS order_id, u.email, o.total, f.last_failure_at, f.failures
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN LATERAL (
  SELECT max(created_at) AS last_failure_at, count(*) AS failures
  FROM payments p WHERE p.order_id = o.id AND p.status = 'failed'
) f ON f.failures > 0
WHERE o.status = 'pending'
  AND o.placed_at > now() - interval '3 days'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status IN ('authorized','captured'))
ORDER BY f.last_failure_at DESC
LIMIT 200;
```

The `LATERAL` with a condition in `ON` (`f.failures > 0`) acts as an inner join that also computes the aggregate; the `NOT EXISTS` excludes orders that later succeeded. Driven by the partial index on open orders.

### 18.20.22 Monthly active customers and new vs returning split

```sql
WITH first_order AS (
  SELECT user_id, min(placed_at) AS first_at FROM orders WHERE status IN ('paid','shipped','delivered') GROUP BY user_id
),
monthly AS (
  SELECT date_trunc('month', o.placed_at)::date AS month, o.user_id,
         bool_or(date_trunc('month', o.placed_at) = date_trunc('month', f.first_at)) AS is_new
  FROM orders o JOIN first_order f ON f.user_id = o.user_id
  WHERE o.status IN ('paid','shipped','delivered') AND o.placed_at >= now() - interval '12 months'
  GROUP BY 1, 2
)
SELECT month,
       count(*)                          AS active_customers,
       count(*) FILTER (WHERE is_new)    AS new_customers,
       count(*) FILTER (WHERE NOT is_new) AS returning_customers
FROM monthly GROUP BY month ORDER BY month;
```

First-order month per customer once, then per (month, customer) a `bool_or` flag, then the split with `FILTER`. `count(*)` at (month, customer) grain is the MAU because that CTE already collapsed multiple orders per customer per month.
