## 60.4 SQL

SQL rounds separate people who write queries from people who understand what the planner will do with them. Answer with both the semantics and the execution shape.

### Q45. Explain the join types, and the three join algorithms Postgres can choose.

- **Expected answer** — Logical types: `INNER` (matching rows only), `LEFT`/`RIGHT OUTER` (keep all rows of one side, NULL-fill the other), `FULL OUTER` (both), `CROSS` (cartesian product), plus `LATERAL` which lets the right side reference columns from the left, and semi/anti joins which are what `EXISTS`/`NOT EXISTS` compile into. Physical algorithms: **nested loop** — for each outer row, probe the inner side; excellent when the outer side is tiny and the inner has an index, terrible when the outer row count is large and misestimated. **Hash join** — build a hash table on the smaller side, probe with the larger; the workhorse for big equality joins, needs memory (`work_mem`) and spills to disk in batches if it does not fit. **Merge join** — sort both sides on the join key then walk them together; good when inputs are already sorted, for example both sides arriving from index scans in key order, and for very large joins where hashing would spill. The planner picks by estimated cost; a plan flipping from hash to nested loop after statistics go stale is a classic "the query was fast yesterday" incident.

- **Why it matters** — You cannot read `EXPLAIN` or fix a slow join without this vocabulary.

- **Follow-ups** — When is a nested loop with 500,000 outer rows catastrophic, and what does the plan look like? What does `work_mem` do to a hash join? Give me a case where `LATERAL` is the right tool.

- **Senior signal** — Connects algorithm choice to row estimates and `work_mem`, and tells the stale-statistics plan-flip story.

### Q46. `EXISTS` versus `IN` versus a join — which do you use?

- **Expected answer** — Semantically, `EXISTS` is a semi-join: it stops at the first matching row and never duplicates the outer row. `IN (subquery)` is usually planned identically to `EXISTS` in modern Postgres, but differs in NULL handling and can be worse when the subquery returns a large, non-unique set. A plain `JOIN` will *multiply* outer rows when the inner side has multiple matches, which is a correctness difference, not a performance one, so you need `DISTINCT` and then you have paid for a sort. My rule: use `EXISTS` for "does at least one related row exist", use `JOIN` when you actually need columns from the other table, and use `IN` with a small literal list. For anti-joins, always `NOT EXISTS`, never `NOT IN`, because of NULLs.

  ```sql
  -- customers who have ordered at least once
  SELECT c.id, c.email FROM customers c
  WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
  ```

- **Why it matters** — The join-duplication bug silently inflates reports and revenue numbers.

- **Follow-ups** — Show me the duplication with a concrete example. What plan node does `EXISTS` produce? When is `IN` with a 10,000-element array a problem?

- **Senior signal** — Leads with the correctness difference (row multiplication) rather than a performance folk rule.

### Q47. Explain SQL NULL semantics and the traps.

- **Expected answer** — `NULL` means "unknown", so comparisons yield unknown, not true or false: `NULL = NULL` is NULL, and a `WHERE` clause only keeps rows where the predicate is *true*. Use `IS NULL` / `IS NOT NULL`, or `IS DISTINCT FROM` when you want NULL-safe inequality. Aggregates skip NULLs: `COUNT(col)` counts non-null values while `COUNT(*)` counts rows, and `AVG` divides by the non-null count. `NULL` in a `UNIQUE` index does not conflict with another `NULL` (each is distinct) unless you use `UNIQUE NULLS NOT DISTINCT` in Postgres 15+. String concatenation with `||` yields NULL if any operand is NULL, which is how "Dear " turns into nothing in an email template. And `CHECK` constraints pass when the expression is unknown, so `CHECK (amount > 0)` does not reject a NULL amount — you also need `NOT NULL`.

- **Why it matters** — NULL bugs are quiet: they produce wrong numbers rather than errors.

- **Follow-ups** — Why did my `CHECK` constraint let a NULL through? What does `ORDER BY col` do with NULLs and how do you control it? How would you make an "at most one active row per user" constraint that treats NULL correctly?

- **Senior signal** — Knows `IS DISTINCT FROM`, the `CHECK`-with-NULL gap, and the unique-index NULL rule with the Postgres 15 change.

### Q48. What are window functions and when do you reach for one?

- **Expected answer** — A window function computes a value across a set of rows related to the current row, without collapsing them the way `GROUP BY` does. The frame is defined by `OVER (PARTITION BY ... ORDER BY ... ROWS/RANGE ...)`. The ones I use most: `ROW_NUMBER()` for deduplication and "latest per group", `RANK`/`DENSE_RANK` for leaderboards, `LAG`/`LEAD` for comparing an event to the previous one (time between order status changes), `SUM(...) OVER (ORDER BY ...)` for running totals, and `COUNT(*) OVER ()` to get a total count alongside a page of rows in one scan.

  ```sql
  SELECT * FROM (
    SELECT o.*, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) rn
    FROM orders o
  ) t WHERE rn = 1;   -- latest order per customer
  ```

  Cost note: window functions require a sort per partition unless an index provides the order, so on large tables check whether `DISTINCT ON (customer_id)` with a matching composite index is cheaper.

- **Why it matters** — Window functions replace N+1 application loops with one query.

- **Follow-ups** — `ROWS` versus `RANGE` in a frame — what is the difference and when does it bite? How does `DISTINCT ON` compare here? Where does the sort show up in `EXPLAIN`?

- **Senior signal** — Offers `DISTINCT ON` as the Postgres-specific cheaper alternative and knows the default frame is `RANGE UNBOUNDED PRECEDING`, which surprises people with ties.

### Q49. Are CTEs materialised? How does that affect performance?

- **Expected answer** — Before Postgres 12, every `WITH` clause was an optimisation fence: it was materialised into a temporary result, and predicates from the outer query could not be pushed into it. Since 12, a CTE that is referenced exactly once, is not recursive and has no side effects is *inlined* by default, so it behaves like a subquery and the planner can push filters down. You can force either behaviour with `WITH x AS MATERIALIZED (...)` or `AS NOT MATERIALIZED`. This matters a lot: a CTE that scans 50 million rows and is then filtered by the outer query used to scan all 50 million; inlined, it can use an index. Conversely, materialising on purpose is useful when the CTE is expensive and referenced multiple times, or when you want to stop the planner from re-evaluating a volatile function. Data-modifying CTEs (`WITH del AS (DELETE ... RETURNING ...)`) are always materialised and all run against the same snapshot, which is a subtlety people get wrong.

- **Why it matters** — Version-dependent behaviour that changes query plans by orders of magnitude.

- **Follow-ups** — Why do all branches of a data-modifying CTE see the same snapshot, and what bug does that cause? When would you force `MATERIALIZED`? How do you tell from `EXPLAIN` whether it inlined?

- **Senior signal** — Knows the 12 boundary, both hint keywords, and the same-snapshot rule for writable CTEs.

### Q50. Why is `OFFSET` pagination bad and how does keyset pagination work?

- **Expected answer** — `LIMIT 20 OFFSET 200000` still has to produce and discard 200,000 rows, so page latency grows linearly with page number; page 10,000 of an orders list can take seconds. It is also *unstable*: if a row is inserted while a user pages, rows shift and they see duplicates or skip records. Keyset (cursor) pagination instead remembers the last row's sort key and asks for rows after it, which with a matching index is a single index seek plus 20 rows regardless of depth.

  ```sql
  -- page 1
  SELECT id, created_at FROM orders WHERE tenant_id = $1
  ORDER BY created_at DESC, id DESC LIMIT 20;
  -- next page, cursor = (last_created_at, last_id)
  SELECT id, created_at FROM orders
  WHERE tenant_id = $1 AND (created_at, id) < ($2, $3)
  ORDER BY created_at DESC, id DESC LIMIT 20;
  ```

  The tuple comparison is the trick: it handles ties in `created_at` correctly and matches a composite index on `(tenant_id, created_at DESC, id DESC)`. Trade-offs: no "jump to page 57", and the cursor must be opaque and signed so clients cannot forge it into someone else's tenant.

- **Why it matters** — The single most common list-endpoint scaling bug.

- **Follow-ups** — How do you support sorting by an arbitrary user-chosen column? What do you return as the cursor and how do you keep it stable? How would you give the UI a total count without scanning?

- **Senior signal** — Uses row-value comparison rather than `created_at < $2 OR (created_at = $2 AND id < $3)`, and mentions cursor opacity as a security concern.

### Q51. Explain upsert semantics in Postgres.

- **Expected answer** — `INSERT ... ON CONFLICT (cols) DO UPDATE SET ...` performs an atomic insert-or-update against a specific unique index or constraint (the "conflict target"), which must exist — you cannot upsert on an arbitrary predicate. `EXCLUDED` refers to the row that would have been inserted. `DO NOTHING` skips silently and, importantly, returns no row, so `RETURNING id` gives you nothing on conflict; if you need the id either way, use `DO UPDATE SET col = EXCLUDED.col` on a harmless column or follow with a select.

  ```sql
  INSERT INTO inventory (sku, warehouse_id, qty)
  VALUES ($1, $2, $3)
  ON CONFLICT (sku, warehouse_id)
  DO UPDATE SET qty = inventory.qty + EXCLUDED.qty, updated_at = now()
  RETURNING qty;
  ```

  Gotchas: the update part takes a row lock, so hot keys serialise; `ON CONFLICT DO UPDATE` can deadlock when concurrent statements touch multiple conflicting rows in different orders, so sort your batch by key; partial unique indexes need the same `WHERE` clause in the conflict target; and upsert consumes a sequence value even when it conflicts, so ids get gaps.

- **Why it matters** — Upsert is the idiomatic idempotency primitive for consumers and imports.

- **Follow-ups** — How do you make a Kafka consumer idempotent with this? Why does the sequence still advance? How do you avoid the deadlock in a 500-row batch?

- **Senior signal** — Sorting batch keys to avoid deadlocks, and the `DO NOTHING` plus `RETURNING` gap, which is a real production surprise.

### Q52. What does `FOR UPDATE SKIP LOCKED` do and what would you build with it?

- **Expected answer** — `SELECT ... FOR UPDATE` takes a row-level exclusive lock, so another transaction attempting the same rows blocks until commit. Adding `SKIP LOCKED` makes it silently ignore rows currently locked by others, and `NOWAIT` makes it error immediately instead of waiting. That turns a table into a concurrent work queue: many workers each grab a different batch without blocking each other.

  ```sql
  WITH claimed AS (
    SELECT id FROM jobs
    WHERE status = 'pending' AND run_at <= now()
    ORDER BY run_at
    FOR UPDATE SKIP LOCKED
    LIMIT 20
  )
  UPDATE jobs j SET status = 'running', locked_by = $1, locked_at = now()
  FROM claimed c WHERE j.id = c.id RETURNING j.*;
  ```

  You get exactly-once *claiming* within the transaction, transactional consistency with your business tables (no dual-write problem), and no extra infrastructure. Limits: it does not scale to hundreds of thousands of jobs per second, dead workers need a lease timeout to reclaim rows, and the table bloats unless you archive completed rows, so add a partial index on `status = 'pending'` and a retention job.

- **Why it matters** — "Do I need Kafka or is Postgres enough?" is a real senior decision and this is the pragmatic middle.

- **Follow-ups** — How do you reclaim jobs from a crashed worker? What index makes this fast at 10 million rows? At what throughput would you move to a real broker?

- **Senior signal** — Mentions lease reclaim, bloat, the partial index, and a specific throughput threshold rather than "Postgres queues are bad".

### Q53. Why does adding a join break my `SUM`, and how do you fix it?

- **Expected answer** — Because a join to a one-to-many table multiplies the parent row, and the aggregate then counts the parent value once per child. Joining `orders` to both `order_items` and `payments` and summing `orders.total` gives items-count times payments-count times the real value — a classic "our revenue dashboard is 3x too high" incident. Fixes, in order of preference: aggregate each child in its own subquery or lateral before joining; use `FILTER` clauses or `COUNT(DISTINCT ...)` when the shape is simple; or aggregate at one grain per query and combine in the application.

  ```sql
  SELECT o.id, o.total, i.item_count, p.paid
  FROM orders o
  LEFT JOIN LATERAL (SELECT count(*) item_count FROM order_items WHERE order_id = o.id) i ON true
  LEFT JOIN LATERAL (SELECT sum(amount) paid FROM payments WHERE order_id = o.id) p ON true;
  ```

  `COUNT(DISTINCT o.id)` masks the symptom but not the `SUM` problem, so never treat it as the fix.

- **Why it matters** — This is the most common source of silently wrong reporting numbers.

- **Follow-ups** — Why is `SUM(DISTINCT ...)` not a fix? How do you spot this in a review? What is the performance profile of lateral subqueries versus pre-aggregated CTEs?

- **Senior signal** — Names "grain" explicitly and can tell the story of a wrong dashboard number reaching a stakeholder.

### Q54. Write a recursive CTE and say where you would use one.

- **Expected answer** — A recursive CTE has an anchor query and a recursive term unioned together, evaluated until the recursive term returns no rows. Real uses: category trees, org charts, bill-of-materials explosion, and following a chain of referrals or reply threads.

  ```sql
  WITH RECURSIVE subtree AS (
    SELECT id, parent_id, name, 1 AS depth, ARRAY[id] AS path
    FROM categories WHERE id = $1
    UNION ALL
    SELECT c.id, c.parent_id, c.name, s.depth + 1, s.path || c.id
    FROM categories c JOIN subtree s ON c.parent_id = s.id
    WHERE NOT c.id = ANY(s.path) AND s.depth < 20
  )
  SELECT * FROM subtree;
  ```

  The two production concerns are cycles and depth. Bad data with a cycle makes the query run forever and eat memory, so carry a path array and exclude visited ids, and add a depth cap. Use `UNION` instead of `UNION ALL` only if you want automatic duplicate elimination, which is slower. For very deep hierarchies read frequently, consider a materialised path or closure table instead, since a recursive CTE on a hot endpoint is expensive.

- **Why it matters** — Hierarchies appear in every catalogue and permission system.

- **Follow-ups** — What happens with a cycle and how do you prove your guard works? When would you denormalise to a closure table? How do you paginate a tree?

- **Senior signal** — Volunteers the cycle guard and depth cap, and knows when to stop using recursion and denormalise.

### Q55. `COUNT(*)` on a 200-million-row table takes 40 seconds. What do you do?

- **Expected answer** — First, understand why: because of MVCC, Postgres must check row visibility, so an exact count requires scanning the table or a full index (an index-only scan helps only if the visibility map is mostly all-visible, which needs a recent `VACUUM`). Then ask what the count is *for*. If it is a UI "about N results", use `reltuples` from `pg_class` (updated by analyze/vacuum, accurate to a few percent) or `EXPLAIN`'s estimated row count for a filtered query. If it is a dashboard total, maintain a counters table or materialised view refreshed periodically, or use an approximate structure like HyperLogLog via `postgresql-hll` for distinct counts. If it is pagination, drop total counts entirely and use keyset pagination with "load more". If an exact count is genuinely required for correctness (financial reconciliation), run it off a replica during a quiet window and accept the cost. What I refuse to do is put an exact `COUNT(*)` behind a page-load on a growing table, because the endpoint gets slower every week by design.

- **Why it matters** — Tests MVCC understanding plus product judgement.

- **Follow-ups** — How accurate is `reltuples` and what makes it drift? How does an index-only scan avoid the heap and when does it fail to? How would you count rows matching a filter approximately?

- **Senior signal** — Reframes the question around what the number is for, and names the visibility map as the reason index-only scans sometimes do not help.

### Q56. Why is `NOT IN` with a subquery dangerous?

- **Expected answer** — If the subquery returns even one `NULL`, `NOT IN` evaluates to unknown for every row and the query returns zero rows — silently. `x NOT IN (1, 2, NULL)` asks "is x different from 1 and 2 and NULL?", and "different from NULL" is unknown, so the whole conjunction can never be true. `NOT EXISTS` has no such problem because it is a straightforward anti-join on the correlation predicate. There is a performance dimension too: `NOT IN` often cannot be planned as an anti-join precisely because of the NULL semantics, so Postgres may build a hashed subplan or re-evaluate it.

  ```sql
  -- dangerous: returns nothing if any customer_id is NULL
  SELECT * FROM customers WHERE id NOT IN (SELECT customer_id FROM orders);
  -- correct
  SELECT * FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
  ```

- **Why it matters** — A query that returns zero rows instead of erroring is the worst kind of bug.

- **Follow-ups** — How would you have caught this in review or in tests? Does `NOT IN` with a literal list have the same issue? What plan node does `NOT EXISTS` produce?

- **Senior signal** — Explains the three-valued logic rather than saying "NOT IN is slow", and mentions the planner consequence.

### Q57. What makes a predicate sargable, and give examples of non-sargable ones.

- **Expected answer** — Sargable means the predicate can be used to seek into an index — the indexed column appears bare on one side and is compared to a constant or parameter. Wrapping the column in a function or expression destroys that: `WHERE lower(email) = $1`, `WHERE date(created_at) = '2026-01-01'`, `WHERE amount::text LIKE '1%'`, `WHERE created_at + interval '1 day' > now()`, and leading-wildcard `LIKE '%foo'` all force a sequential scan against a plain B-tree. Fixes: rewrite as a range (`created_at >= '2026-01-01' AND created_at < '2026-01-02'`), move the arithmetic to the constant side, create an *expression index* (`CREATE INDEX ON users (lower(email))`) when the function form is genuinely needed, use `citext` or a case-insensitive collation, and use `pg_trgm` GIN indexes for leading-wildcard search. Implicit casts are the sneaky case: comparing a `bigint` column to a string literal, or `varchar` to `text` across a type mismatch, can silently disable the index — check the plan, not the intent.

- **Why it matters** — Most "the index isn't being used" tickets are this.

- **Follow-ups** — Show the `EXPLAIN` difference for the timestamp case. When is an expression index better than changing the query? How do you catch implicit casts?

- **Senior signal** — Names implicit casts and expression indexes, and insists on reading the plan to confirm.

### Q58. How do you query and index JSONB properly?

- **Expected answer** — `->` returns JSON, `->>` returns text, `#>` and `#>>` take a path, and the containment operator `@>` asks "does this document contain this fragment". For indexing, a default GIN index on the whole column (`USING gin (payload)`) supports `@>`, `?`, `?|`, `?&`; the `jsonb_path_ops` operator class is smaller and faster but supports only `@>`. For equality on one hot key, a B-tree expression index is much cheaper: `CREATE INDEX ON events ((payload->>'user_id'))`. Note that `->>` yields text, so numeric comparisons need a cast and a matching index expression.

  ```sql
  CREATE INDEX events_payload_gin ON events USING gin (payload jsonb_path_ops);
  SELECT * FROM events WHERE payload @> '{"type":"order.paid","currency":"INR"}';
  ```

  The senior position: JSONB is excellent for genuinely variable data (webhook payloads, event envelopes, per-tenant custom fields) and terrible as a substitute for columns. Once a field is queried, filtered or constrained, promote it to a real column with a constraint. Also watch TOAST: large documents are compressed and stored out of line, so selecting a whole 200 KB payload for every row of a list endpoint is a hidden I/O cost.

- **Why it matters** — JSONB abuse is a common cause of unindexable, unconstrainable data.

- **Follow-ups** — When would you choose `jsonb_path_ops`? How do you enforce that `payload->>'amount'` is numeric? What is the write amplification of a GIN index?

- **Senior signal** — The "promote queried fields to columns" rule, GIN write cost, and TOAST awareness.

### Q59. How do you control transactions in SQL, and what do savepoints buy you?

- **Expected answer** — `BEGIN`, then `COMMIT` or `ROLLBACK`. Inside, `SAVEPOINT s1` marks a point you can `ROLLBACK TO SAVEPOINT s1` without losing the whole transaction, and `RELEASE SAVEPOINT` discards it. In Postgres, any error aborts the current transaction entirely — subsequent statements fail with "current transaction is aborted" — so a savepoint is the only way to attempt a statement that might fail and continue. That is how ORMs implement nested transactions: TypeORM's nested `transaction()` and Sequelize's nested `transaction` both emit savepoints, not real nested transactions. Costs: each savepoint consumes a subtransaction id, and more than 64 subtransactions in one transaction overflows the per-backend cache and can cause severe cluster-wide slowdowns under concurrency (the well-known "subtransaction overflow" pathology). So do not put a savepoint inside a loop over 10,000 rows. Keep transactions short, never hold one open across an HTTP call to a third party, and set `statement_timeout` and `idle_in_transaction_session_timeout`.

- **Why it matters** — Transaction scope discipline is the difference between a healthy and a lock-choked database.

- **Follow-ups** — Why is a transaction held open across a payment-gateway call dangerous? What does `idle_in_transaction_session_timeout` protect? What does the ORM do when you nest transactions?

- **Senior signal** — Knows savepoints are subtransactions with a real cluster-level cost, and refuses long transactions with a concrete reason (bloat, lock hold, connection exhaustion).

### Q60. What is `RETURNING` good for?

- **Expected answer** — `RETURNING` makes `INSERT`, `UPDATE` and `DELETE` return the affected rows, so you get generated ids, defaults, computed columns and post-update values in a single round trip instead of a follow-up `SELECT`. That is both faster (one network round trip, ~0.5–2 ms saved per call, which matters in a loop) and safer: the returned values are the ones this statement actually wrote, with no race against a concurrent update. Combined with conditional updates it becomes a concurrency primitive: an `UPDATE ... WHERE status = 'pending' RETURNING id` tells you whether *you* were the one who transitioned the row, which is how you make a state machine safe against duplicate requests.

  ```sql
  UPDATE orders SET status = 'paid', paid_at = now()
  WHERE id = $1 AND status = 'pending'
  RETURNING id, status, paid_at;   -- zero rows means someone else already paid it
  ```

  It also composes with data-modifying CTEs for move-and-audit patterns: delete from one table and insert the returned rows into another in one statement.

- **Why it matters** — It replaces read-then-write races with single-statement atomicity.

- **Follow-ups** — How does this give you idempotency for a webhook? What does zero returned rows mean and how should the API respond? How do you do this in TypeORM and Sequelize?

- **Senior signal** — Uses `RETURNING` with a guarded `WHERE` as a lock-free compare-and-set, and interprets zero rows as information rather than an error.
