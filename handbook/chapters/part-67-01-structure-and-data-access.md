# Part 67 — Backend Anti-Patterns and Why They Hurt

Nobody sits down and writes an anti-pattern on purpose. Every one of the things in this part started as a reasonable decision by a competent engineer under time pressure, and most of them were *correct* at the size the system was then. The `SELECT *` was fine when the table had six columns. The shared database was fine when there was one team. The retry was fine before there were four layers of them.

That is why every entry here starts by explaining the good intention. If you only learn the list of forbidden things, you will forbid them in code review and then invent them again in a new shape. If you learn the *pressure* that produces them, you will recognise the shape before it becomes a schema migration you cannot undo.

Each anti-pattern below has five sub-sections: what it looks like in code, why it is dangerous with the concrete production consequence, how it happens, the fix, and how to detect it in review or in metrics. That last one matters most. Reviews catch what a human happens to notice on a Tuesday; metrics catch what is actually happening at 03:00, which is a different and more honest list.

A word on tone. Calling something an anti-pattern is not calling the author careless. Almost every example in this part is drawn from code I have written, reviewed and approved, or shipped myself. The value is in noticing them earlier next time.

## 67.1 God service

### What it looks like

```ts
// order.service.ts - 4,200 lines, 61 public methods, 23 injected dependencies
@Injectable()
export class OrderService {
  constructor(
    private readonly orderRepo: Repository<Order>,
    private readonly userRepo: Repository<User>,
    private readonly productRepo: Repository<Product>,
    private readonly inventoryRepo: Repository<Stock>,
    private readonly paymentGateway: StripeClient,
    private readonly mailer: MailerService,
    private readonly sms: TwilioClient,
    private readonly pdf: InvoicePdfGenerator,
    private readonly analytics: SegmentClient,
    private readonly search: ElasticClient,
    private readonly fraud: FraudScoreClient,
    private readonly loyalty: LoyaltyService,
    /* ...11 more... */
  ) {}

  async placeOrder(dto: PlaceOrderDto) { /* 340 lines */ }
  async cancelOrder(id: string) { /* 180 lines */ }
  async refund(id: string) { /* 210 lines */ }
  async recalculateLoyaltyTier(userId: string) { /* ... */ }
  async exportMonthlyRevenueCsv(month: string) { /* ... */ }
  async syncProductToSearchIndex(sku: string) { /* ... */ }
}
```

### Why it is dangerous

Every change to any part of the ordering domain touches this file, so every pull request conflicts with every other pull request. On one team I worked with, `order.service.ts` averaged 4.2 merge conflicts per week and the file's test suite took 6 minutes because instantiating the service required mocking 23 dependencies. Worse, the blast radius is total: a bug in the CSV export code path can throw inside a shared helper used by `placeOrder`, and a memory leak in the PDF generator takes down checkout. When the class is this large, nobody reads the whole thing before changing it, so behaviour is discovered by incident rather than by reading.

The scaling consequence is just as bad. You cannot give the invoice PDF path more memory or fewer replicas than the checkout path, because they are the same object in the same process.

### How it happens

It starts as good cohesion. All order logic in one place is genuinely easier to find than order logic spread over nine files. Then a feature arrives that is "sort of about orders" — loyalty tiers, which are earned by ordering — and adding a method to an existing service takes ten minutes while creating a new module takes an afternoon and a discussion about naming. Each individual addition is defensible. The growth is invisible because nobody ever sees the whole file at once; they see a 40-line diff.

### The fix

Split by *reason to change*, not by noun. Ask who requests changes to each method. Checkout rules come from the payments team, loyalty tiers from growth, CSV exports from finance. Those are three services with three owners.

```ts
// Each service has one reason to change and a handful of dependencies.
@Injectable()
export class PlaceOrderService {          // owns the checkout transaction only
  constructor(
    private readonly orders: OrderRepository,
    private readonly pricing: PricingService,
    private readonly inventory: InventoryPort,
    private readonly outbox: OutboxWriter,   // side effects become events
  ) {}

  async execute(cmd: PlaceOrderCommand): Promise<OrderId> { /* 40 lines */ }
}
```

Move the non-transactional side effects (email, SMS, analytics, search indexing) behind events published to the outbox. That alone typically removes half the dependencies, because most of them were never part of the transaction in the first place.

### How to detect it in review or in metrics

- A constructor with more than about seven injected dependencies. This is the single most reliable smell.
- Any service file over roughly 500 lines, or with more than 15 public methods.
- Git signal: run `git log --format= --name-only | sort | uniq -c | sort -rn | head -20`. Files at the top of that list are change magnets.
- Test setup longer than the test.
- In review, ask: "which team will request the next change to this file?" If there is more than one answer, it is already a god service.

## 67.2 God or fat controller

### What it looks like

```ts
@Controller('orders')
export class OrderController {
  @Post()
  async create(@Body() body: any, @Req() req: Request) {
    if (!body.items || body.items.length === 0) throw new BadRequestException('no items');
    if (body.items.length > 50) throw new BadRequestException('too many items');

    const user = await this.userRepo.findOne({ where: { id: req.user.id } });
    if (!user || user.status !== 'ACTIVE') throw new ForbiddenException();

    let total = 0;
    for (const item of body.items) {
      const p = await this.productRepo.findOne({ where: { id: item.productId } });
      if (!p) throw new NotFoundException(`product ${item.productId}`);
      if (p.stock < item.qty) throw new ConflictException('out of stock');
      total += p.price * item.qty;                       // float arithmetic on money
      if (user.tier === 'GOLD') total -= p.price * item.qty * 0.1;
    }
    if (total > 100000 && !user.verified) throw new ForbiddenException('verify first');

    const order = await this.orderRepo.save({ userId: user.id, total, status: 'NEW' });
    await this.mailer.send(user.email, 'order-confirmation', { order });
    return order;
  }
}
```

### Why it is dangerous

The business rules — gold tier discount, the 100,000 verification threshold, the stock check — live in an HTTP handler. They cannot be unit tested without an HTTP layer, cannot be reused by the admin API or the CSV importer, and cannot be called by a background job. When the mobile team needs the same order creation flow with a slightly different payload, the rules get copy-pasted into a second controller, and six months later the two copies disagree about the gold discount. That disagreement is a real revenue bug, and it is invisible until a customer notices.

There is also a correctness problem hiding in plain sight: the stock check and the save are not in a transaction, so two concurrent requests both pass the check and both succeed. Under a flash sale at 300 requests per second, this oversells consistently.

### How it happens

The endpoint started with three lines. Adding one `if` to a controller is the shortest path from a ticket to a deployed feature, and every reviewer approves a four-line diff. There is no moment where somebody decides to put business logic in the controller; it accretes one condition at a time. NestJS makes it easy in the good sense, which is also the dangerous sense.

### The fix

Controllers do four things and nothing else: validate input shape, extract the principal, call one application service, map the result to an HTTP response.

```ts
@Controller('orders')
export class OrderController {
  constructor(private readonly placeOrder: PlaceOrderService) {}

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async create(@Body() dto: PlaceOrderDto, @Principal() p: Principal): Promise<OrderResponse> {
    const order = await this.placeOrder.execute({ userId: p.userId, items: dto.items });
    return OrderResponse.from(order);          // no rules, no repositories, no mailer
  }
}

export class PlaceOrderDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}
```

Shape validation moves to the DTO where `class-validator` handles it declaratively. Business rules move to the service where they can be tested in milliseconds and reused by the admin API, the importer and the queue consumer.

### How to detect it in review or in metrics

- Any repository, ORM entity or third-party client injected into a controller.
- The word `if` appearing more than twice in a handler.
- `@Body() body: any` — untyped bodies are almost always accompanied by manual validation.
- A handler longer than about 15 lines.
- Test signal: if the controller's tests need a database, the logic is in the wrong place.

## 67.3 Anemic domain model

### What it looks like

```ts
@Entity()
export class Order {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() status!: string;
  @Column('int') totalMinor!: number;
  @Column({ nullable: true }) cancelledAt!: Date | null;
  // ...and nothing else. No methods. A struct with decorators.
}

// Every rule about orders lives somewhere else, and is repeated.
async cancel(id: string) {
  const o = await this.repo.findOneOrFail({ where: { id } });
  if (o.status === 'SHIPPED') throw new BadRequestException('already shipped');
  if (o.status === 'CANCELLED') throw new BadRequestException('already cancelled');
  o.status = 'CANCELLED';
  o.cancelledAt = new Date();
  await this.repo.save(o);
}

// admin-order.service.ts - the same rule, subtly different
async adminCancel(id: string) {
  const o = await this.repo.findOneOrFail({ where: { id } });
  if (o.status === 'DELIVERED') throw new BadRequestException('delivered');
  o.status = 'CANCELLED';                    // forgot cancelledAt, allows cancelling SHIPPED
  await this.repo.save(o);
}
```

### Why it is dangerous

The entity cannot protect its own invariants, so every caller must remember the rules. There were two call sites here and they already disagree: the admin path lets you cancel a shipped order and forgets to set `cancelledAt`. In a real system there are eight call sites — the API, the admin panel, a Kafka consumer, a cron job, a data-fix script — and the rules drift across all of them. The failure mode is silent data corruption: orders in states the business believes are impossible, discovered months later when a report does not balance.

### How it happens

ORMs encourage it. TypeORM and Sequelize entities look like database rows, so people treat them as rows. Layered-architecture tutorials say "entities hold data, services hold logic", which sounds like separation of concerns and is actually procedural programming with extra classes. It also *works* at small scale, which is the most persuasive argument of all.

### The fix

Put the rules where the data is. The entity decides whether a transition is legal.

```ts
@Entity()
export class Order {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'text' }) private status!: OrderStatus;
  @Column({ type: 'timestamptz', nullable: true }) private cancelledAt!: Date | null;

  cancel(reason: CancellationReason, now = new Date()): void {
    if (this.status === 'SHIPPED' || this.status === 'DELIVERED') {
      throw new OrderCannotBeCancelled(this.id, this.status);   // one rule, one place
    }
    if (this.status === 'CANCELLED') return;                    // idempotent by design
    this.status = 'CANCELLED';
    this.cancelledAt = now;
    this.record(new OrderCancelled(this.id, reason));
  }

  get isCancellable(): boolean { return this.status === 'NEW' || this.status === 'PAID'; }
}
```

Now both call sites become `order.cancel(reason)` and it is impossible to get it wrong. Note this is not "put everything in the entity" — cross-aggregate logic and orchestration still belong in services. It is "invariants live with the data they protect". Part 17 — Domain-Driven Design covers where the line sits.

### How to detect it in review or in metrics

- Entities with only getters, setters and decorators.
- The same `if (status === ...)` condition appearing in more than one file. Grep for a status literal and count files.
- Services that mutate an entity's fields directly (`o.status = ...`) rather than calling a method.
- A state machine that exists only in a diagram on a wiki, never in code.

## 67.4 N+1 queries

### What it looks like

```ts
const orders = await this.orderRepo.find({ where: { userId }, take: 50 });   // 1 query
for (const order of orders) {
  order.items = await this.itemRepo.find({ where: { orderId: order.id } });  // 50 queries
  for (const item of order.items) {
    item.product = await this.productRepo.findOne({ where: { id: item.productId } }); // 200 more
  }
}
```

Lazy relations make it invisible: with TypeORM lazy loading or a Sequelize getter, the loop above can look like `order.items.map(i => i.product.name)` and still issue 250 queries.

### Why it is dangerous

Each query is cheap; the round trips are not. At 1.5 ms per query in the same AZ, 251 queries is 376 ms of pure latency for one request. Add a 3 ms cross-AZ hop and it is 750 ms. Now serve 200 requests per second: that is 50,200 queries per second against a database sized for 2,000, and every one of them holds a pool connection. The endpoint that tested fine with three orders in development times out in production with fifty.

The characteristic incident: an endpoint's latency is fine for months, then a single power user with 400 orders opens their history and the connection pool is exhausted for everyone. The dashboard shows database CPU at 90 percent with no slow queries, because every individual query is 1.5 ms. This is why N+1 hides so well.

### How it happens

The loop reads beautifully. `for (const order of orders) { order.items = ... }` expresses exactly what you mean, and the ORM makes the query invisible. The developer tested with a seeded database containing three orders, where 4 queries and 16 queries feel identical. Lazy loading, marketed as a convenience, is specifically the feature that hides the cost.

### The fix

Fetch related data in one round trip, either with a join or with a batched second query.

```ts
// Option 1: one query with joins. Best for small fan-out.
const orders = await this.orderRepo.find({
  where: { userId },
  relations: { items: { product: true } },   // TypeORM emits a single LEFT JOIN query
  take: 50,
});

// Option 2: two queries, batched. Better when the join multiplies rows badly.
const orders = await this.orderRepo.find({ where: { userId }, take: 50 });
const items = await this.itemRepo.find({ where: { orderId: In(orders.map(o => o.id)) } });
const products = await this.productRepo.find({ where: { id: In(items.map(i => i.productId)) } });
const byId = new Map(products.map(p => [p.id, p]));
// stitch in memory: 3 queries total regardless of order count
```

For GraphQL or any per-item resolver, use DataLoader, which batches per request tick. Part 46 — Performance Engineering covers the batching patterns in detail.

### How to detect it in review or in metrics

- Any `await` inside a `for` or `map` over database results. This is the review rule; it catches almost every case.
- Enable query logging in tests and assert a query count: `expect(queryCount).toBeLessThan(5)`.
- Metrics: `db_queries_per_request` as a histogram. An endpoint whose p99 query count is 250 is an N+1, no investigation needed.
- APM traces: a flat wall of identical short spans is the visual signature.
- `pg_stat_statements`: a query with an enormous `calls` count and a tiny `mean_exec_time` is the N+1's inner query.

## 67.5 `SELECT *`

### What it looks like

```ts
// TypeORM's default: selects every column of every entity in the relation graph
const users = await this.userRepo.find({ relations: { profile: true, addresses: true } });
```

```sql
SELECT * FROM users u
JOIN profiles p ON p.user_id = u.id
WHERE u.created_at > now() - interval '7 days';
```

### Why it is dangerous

The `users` table has 34 columns including `bio` (average 2 KB), `preferences` jsonb (4 KB) and `avatar_base64` (a legacy column averaging 60 KB that nobody removed). Selecting 10,000 users transfers 660 MB instead of the 400 KB you needed for id, email and name. That is network time, Node heap, JSON serialization CPU and garbage collection pressure — and on a `t3.large`-sized service, a single such request can push heap past the limit and cause an `OOMKilled`.

It also defeats index-only scans. A covering index on `(created_at, id, email)` can answer a targeted query entirely from the index at 0.3 ms; `SELECT *` forces a heap fetch per row and turns it into 40 ms. And it makes schema changes dangerous in a different way: adding a large column to a table silently degrades every existing query.

### How it happens

It is the default. `repo.find()` selects everything and requires zero thought; listing columns requires knowing which ones you need and updating the list when requirements change. In SQL, `SELECT *` is what you type while exploring, and exploration code becomes production code. It is also genuinely convenient when the table is narrow, which most tables are at the start.

### The fix

Select what you use.

```ts
const users = await this.userRepo.find({
  select: { id: true, email: true, name: true },     // 3 columns, not 34
  where: { createdAt: MoreThan(sevenDaysAgo) },
  take: 1000,
});

// Or a query builder for list endpoints, returning plain objects rather than entities
const rows = await this.userRepo.createQueryBuilder('u')
  .select(['u.id AS id', 'u.email AS email', 'u.name AS name'])
  .where('u.created_at > :d', { d: sevenDaysAgo })
  .limit(1000)
  .getRawMany();
```

```sql
-- and the index that makes it index-only
CREATE INDEX users_recent_covering ON users (created_at DESC) INCLUDE (id, email, name);
```

### How to detect it in review or in metrics

- Grep for `SELECT *` in raw SQL and for `.find(` without a `select` option in list endpoints.
- `EXPLAIN (ANALYZE, BUFFERS)` showing `Heap Fetches` on a query you expected to be index-only.
- Response payload size metrics. A list endpoint returning 4 MB is returning columns nobody renders.
- Watch `shared read` buffer counts in `EXPLAIN BUFFERS`: wide rows mean more pages, and more pages means more I/O.
- In review, ask which fields the caller actually renders. If the answer is "three", the query should select three.

## 67.6 No indexes

### What it looks like

```ts
@Entity()
export class Order {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() userId!: string;             // no @Index, queried on every dashboard load
  @Column() status!: string;             // filtered on constantly
  @Column() createdAt!: Date;            // sorted on constantly
}
```

```sql
SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20;
```

### Why it is dangerous

With 200 rows in development this is instant. With 8 million rows in production, PostgreSQL sequentially scans the whole table, sorts the matches and takes 20: a plan that reads roughly 900 MB and takes 2.4 seconds.

```text
Limit  (cost=402318.42..402318.47 rows=20 width=312) (actual time=2412.9..2412.9 rows=20 loops=1)
  ->  Sort  (cost=402318.42..402412.10 rows=37472 width=312) (actual time=2412.9..2412.9 rows=20)
        Sort Method: top-N heapsort  Memory: 34kB
        ->  Seq Scan on orders  (actual time=0.31..2380.4 rows=41 loops=1)
              Filter: (user_id = '...'::uuid)
              Rows Removed by Filter: 8017442
              Buffers: shared read=114203
```

Note `Rows Removed by Filter: 8017442`. Every one of those rows was read from disk to find 41. Now run this at 50 requests per second: the database saturates its I/O, every other query queues behind it, and the whole product goes down because of one missing line of DDL. This is, by a wide margin, the most common cause of "the database is slow" incidents.

### How it happens

Development databases are tiny. A seq scan over 200 rows is faster than an index scan, so nothing is slow, and nobody adds an index for a problem that does not exist yet. ORM entity definitions do not force you to think about access paths — `@Column()` is complete and valid without one. And indexes are invisible in code review because they live in a migration file that reviewers skim.

### The fix

Index the way you query. Composite, in the order that matches your filter and sort.

```sql
-- equality column first, then the sort column
CREATE INDEX CONCURRENTLY orders_user_recent ON orders (user_id, created_at DESC);
```

```text
Limit  (actual time=0.048..0.061 rows=20 loops=1)
  ->  Index Scan using orders_user_recent on orders  (actual time=0.046..0.057 rows=20)
        Index Cond: (user_id = '...'::uuid)
        Buffers: shared hit=8
```

2,412 ms becomes 0.06 ms, and buffer reads go from 114,203 to 8. Always `CONCURRENTLY` in production so the build does not lock writes. Part 23 — Database Indexing covers column ordering, partial indexes and covering indexes properly.

### How to detect it in review or in metrics

- `pg_stat_user_tables`: high `seq_scan` with high `n_live_tup` is the definition of a missing index.
  ```sql
  SELECT relname, seq_scan, idx_scan, n_live_tup
  FROM pg_stat_user_tables WHERE n_live_tup > 100000 ORDER BY seq_scan DESC LIMIT 10;
  ```
- `pg_stat_statements` ordered by `total_exec_time`: the top query is usually missing an index.
- `auto_explain` with `log_min_duration = 200ms` in staging, so slow plans are logged before production sees them.
- In review: for every new query, ask which index serves it. If nobody can name one, the migration is incomplete.

## 67.7 Indexing everything

### What it looks like

```sql
-- the reaction to the previous incident
CREATE INDEX ON orders (user_id);
CREATE INDEX ON orders (status);
CREATE INDEX ON orders (created_at);
CREATE INDEX ON orders (updated_at);
CREATE INDEX ON orders (total_minor);
CREATE INDEX ON orders (currency);
CREATE INDEX ON orders (channel);
CREATE INDEX ON orders (user_id, status);
CREATE INDEX ON orders (status, created_at);
CREATE INDEX ON orders (user_id, created_at);
-- 18 indexes on a table with 12 columns
```

### Why it is dangerous

Indexes are not free; they are a write tax. Every `INSERT` updates every index, and every `UPDATE` updates every index whose columns changed (and can break HOT updates entirely). On a table with 18 indexes, an insert that took 0.4 ms takes 3.1 ms, and a bulk load of a million rows goes from 7 minutes to 50. Write throughput drops by a factor of five for indexes that are never used.

Storage compounds it: 18 indexes on an 80 GB table can add 140 GB, which no longer fits in RAM, so the buffer cache thrashes and *read* performance degrades too. And `currency` — a column with three distinct values across 8 million rows — will never be used by the planner anyway, because a seq scan is cheaper than reading a third of the table through an index.

The subtler harm is planner confusion: with a dozen overlapping candidate indexes, PostgreSQL sometimes picks a worse one, and plans become unstable across statistics refreshes.

### How it happens

It is the overcorrection after a missing-index outage. "We were down for an hour because of a missing index" naturally becomes "index everything so it cannot happen again". It also happens through ORM decorators: `@Index()` on a field is one word, and adding it feels like diligence. Nobody ever removes an index, because removing one feels risky and adding one felt safe.

### The fix

Index based on measured query patterns, and delete the rest.

```sql
-- find indexes that have never been used since the last stats reset
SELECT s.relname AS table, s.indexrelname AS index,
       s.idx_scan, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;

DROP INDEX CONCURRENTLY orders_currency_idx;   -- after confirming across a full business cycle
```

Also collapse redundancy: an index on `(user_id, created_at)` already serves queries filtering on `user_id` alone, so the single-column `(user_id)` index is dead weight. And prefer partial indexes for skewed data: `CREATE INDEX ON orders (created_at) WHERE status = 'PENDING'` is a fraction of the size and serves the queue query perfectly.

### How to detect it in review or in metrics

- `idx_scan = 0` in `pg_stat_user_indexes` after a full business cycle, including month-end reporting.
- Total index size approaching or exceeding table size: `pg_indexes_size('orders')` versus `pg_table_size('orders')`.
- Left-prefix duplicates: an index whose columns are a prefix of another index's columns.
- Insert latency creeping up on a table nobody has changed. Graph write latency per table.
- In review: a migration adding an index should name the query it serves. No named query, no index.
