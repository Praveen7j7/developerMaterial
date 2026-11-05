## 60.23 `synchronize: true` in production

### What it looks like

```ts
TypeOrmModule.forRoot({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  autoLoadEntities: true,
  synchronize: true,          // "keeps the schema in sync automatically"
});
```

### Why it is dangerous

TypeORM's `synchronize` compares entities to the live schema and issues whatever DDL it thinks closes the gap — including `DROP COLUMN`. Rename a property in an entity and it drops the old column and creates a new empty one; your data is gone with no migration to reverse and no record of what happened. On a deploy with two replicas starting simultaneously, both run DDL concurrently and can deadlock on `ACCESS EXCLUSIVE` locks, taking the application down at startup. There is no review step, no dry run and no rollback.

### How it happens

It is in the getting-started documentation and it makes local development delightful. The `.env` for staging gets copied to production, or the flag is set from a variable that defaults to true. Nobody notices until the first destructive change.

### The fix

```ts
TypeOrmModule.forRoot({
  synchronize: false,                 // never true outside a disposable local database
  migrationsRun: process.env.RUN_MIGRATIONS === 'true',   // and run them from one place
  migrations: ['dist/migrations/*.js'],
});
```

Generate migrations locally (`typeorm migration:generate`), review the SQL as code, and run them as a separate Kubernetes `Job` before the rolling deploy — not from application startup, so replicas cannot race. Part 23 — Database Migrations covers safe, zero-downtime patterns.

### How to detect it in review or in metrics

- Grep every config for `synchronize` and `alter: true` (Sequelize's equivalent). Fail CI if either is truthy when `NODE_ENV=production`.
- Schema drift: compare production DDL against the migration history in CI.
- Unexpected `ALTER TABLE` statements in the PostgreSQL log at application startup.

## 60.24 Swallowed errors

### What it looks like

```ts
try {
  await this.inventory.reserve(orderId, items);
} catch (e) {
  // TODO: handle
}

try { await this.cache.set(key, value); } catch {}      // silent
```

### Why it is dangerous

The system continues as though the operation succeeded. Orders are confirmed with no stock reserved, so you oversell and only discover it at fulfilment. There is no log, no metric and no trace, so debugging starts from the symptom (angry customers) rather than the cause, and typically takes days. Empty catch blocks are how a 20-minute bug becomes a 3-day investigation.

### How it happens

An exception was crashing something in development, and catching it made the crash stop. The `// TODO` is sincere. It also happens defensively: "the cache is optional, so a failure should not break the request" — which is correct reasoning with a missing second half, namely recording that it happened.

### The fix

Every catch does at least one of three things: handle it meaningfully, rethrow (possibly wrapped), or log and count it. Never nothing.

```ts
try {
  await this.cache.set(key, value);
} catch (err) {
  this.metrics.inc('cache_write_failed', { key_prefix: prefix });    // optional but visible
  this.logger.warn({ err, key }, 'cache write failed, continuing');
}

try {
  await this.inventory.reserve(orderId, items);
} catch (err) {
  throw new OrderCannotBeFulfilled(orderId, { cause: err });          // not optional: fail
}
```

### How to detect it in review or in metrics

- ESLint `no-empty` with `allowEmptyCatch: false`; grep for `catch {}` and `catch (e) {}`.
- Search for `catch` blocks with no `logger`, `throw` or `metrics` call in the body.
- Symptom in metrics: an operation whose success count is far below its attempt count while the error rate is zero.

## 60.25 Fire-and-forget promises

### What it looks like

```ts
@Post()
async create(@Body() dto: CreateDto) {
  const order = await this.orders.create(dto);
  this.mailer.sendConfirmation(order);      // no await, no catch
  this.analytics.track('order_created');    // same
  return order;
}
```

### Why it is dangerous

An unhandled promise rejection in Node 15 and later terminates the process by default. So a transient SMTP failure does not just skip an email; it crashes the pod, killing every other in-flight request. Even when it does not crash, the work is unobserved: nobody knows how many confirmation emails were never sent, because there is no error path and no metric. And during a rolling deploy the pod exits while the promise is still pending, so the work silently disappears.

### How it happens

Not awaiting is the easy way to keep an endpoint fast, and it usually works. The failure needs a rejection, which needs the dependency to fail, which does not happen in development.

### The fix

Either await it, or hand it to something durable. For genuinely optional work, mark the intent explicitly and attach a handler.

```ts
// Durable: survives a pod restart, retries, dead-letters.
await this.mailQueue.add('confirmation', { orderId: order.id }, { attempts: 5 });

// Truly fire-and-forget: never unhandled, always counted.
void this.analytics.track('order_created').catch((err) =>
  this.logger.warn({ err }, 'analytics track failed'));
```

### How to detect it in review or in metrics

- ESLint `@typescript-eslint/no-floating-promises`. This one rule catches nearly every instance; turn it on today.
- `process.on('unhandledRejection')` counter exported as a metric.
- Pods restarting with exit code 1 and no obvious cause in application logs.

## 60.26 Hard deletes with no audit trail

### What it looks like

```ts
@Delete(':id')
async remove(@Param('id') id: string) {
  await this.orderRepo.delete(id);        // row is gone, along with any way to explain it
}
```

### Why it is dangerous

The data is unrecoverable outside a backup restore, which for a large database is hours of downtime to recover one row. Foreign keys either block the delete (a runtime error users see) or cascade (silently removing order items, payments and shipments). Financial and legal records frequently must be retained for seven years, so a hard delete on an invoice is a compliance breach. And when a customer asks "who cancelled my order and when?", the honest answer is that nobody can know.

### How it happens

`DELETE` is what the ORM offers and what the word "delete" means. Soft deletes require a flag, a filter on every query and a cleanup policy, which is more work for what looks like the same outcome.

### The fix

Soft-delete business records, and record who did it.

```ts
@Entity()
export class Order {
  @DeleteDateColumn({ type: 'timestamptz' }) deletedAt?: Date;   // TypeORM filters these out
  @Column({ nullable: true }) deletedBy?: string;
  @Column({ nullable: true }) deletionReason?: string;
}

await this.orderRepo.softDelete(id);          // sets deletedAt; queries exclude it by default
```

Add a partial index so the common query stays fast (`CREATE INDEX ... WHERE deleted_at IS NULL`), and a scheduled job that hard-deletes rows past their retention period so GDPR erasure remains possible. For genuine erasure requests, delete or crypto-shred the personal fields and keep the financial record.

### How to detect it in review or in metrics

- Grep for `.delete(`, `.remove(`, `DELETE FROM` on business tables.
- `ON DELETE CASCADE` on any table containing financial or user-facing history.
- In review, ask: who is allowed to delete this, and what does the audit log say afterwards?

## 60.27 Magic strings for states

### What it looks like

```ts
if (order.status === 'PENDING') { /* ... */ }
if (order.status === 'pending') { /* never true, silently */ }
await this.repo.update(id, { status: 'PAYED' });     // typo, accepted by the database
```

### Why it is dangerous

The compiler cannot help you. A typo becomes a row in a state nothing handles, so the order stops moving and no error is raised anywhere. It surfaces days later as "these 300 orders are stuck", and fixing it needs a data migration plus a code fix. Case mismatches produce conditions that are simply never true, which is the hardest kind of bug to see in review because the code looks correct.

### How it happens

String literals are frictionless. The first status was added in one place, then a second, and by the time there are eight nobody wants to do the refactor to an enum.

### The fix

Make illegal states unrepresentable at both layers.

```ts
export const ORDER_STATUS = ['NEW', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
export type OrderStatus = typeof ORDER_STATUS[number];

@Column({ type: 'enum', enum: ORDER_STATUS })
status!: OrderStatus;         // TypeScript rejects 'PAYED' at compile time
```

```sql
-- and the database rejects it too, for anything that bypasses the application
ALTER TABLE orders ADD CONSTRAINT orders_status_chk
  CHECK (status IN ('NEW','PAID','SHIPPED','DELIVERED','CANCELLED'));
```

### How to detect it in review or in metrics

- Grep for quoted status values across the codebase and count distinct spellings.
- A data check: `SELECT DISTINCT status FROM orders` should return exactly the values in your enum. Run it as a scheduled data-quality assertion.
- Columns typed `text` or `varchar` that hold a fixed vocabulary and have no `CHECK` constraint.

## 60.28 Environment-specific code branches

### What it looks like

```ts
async charge(amount: number) {
  if (process.env.NODE_ENV === 'production') {
    return this.stripe.charges.create({ amount });
  }
  return { id: 'fake_charge', status: 'succeeded' };     // staging never exercises the real path
}

if (process.env.NODE_ENV !== 'production') {
  app.use(cors({ origin: '*' }));                        // and this ships if the env var is missing
}
```

### Why it is dangerous

The code that runs in production is code that has never been tested, because every environment below production ran the other branch. Staging becomes worthless as a signal: it proves the fake path works. The failure is discovered by customers, on the day of release.

There is a security edge too. If `NODE_ENV` is unset — a surprisingly common misconfiguration in containers, since the default is `development` in many frameworks — you ship the permissive branch to production. Wide-open CORS, disabled auth guards and verbose error responses have all reached production this way.

### How it happens

It is the quickest way to avoid charging real cards in development, and the alternative (a proper stub implementation behind an interface, or a provider sandbox) takes an afternoon to set up.

### The fix

Same code everywhere; different *configuration* and different *implementations*, chosen at wiring time.

```ts
@Module({
  providers: [{
    provide: PAYMENT_GATEWAY,
    useClass: process.env.PAYMENT_DRIVER === 'stub' ? StubPaymentGateway : StripePaymentGateway,
  }],
})
export class PaymentModule {}
```

The code path is identical in every environment; only the injected adapter differs, and the adapter is a first-class, tested class. Better still, use the provider's sandbox mode so even staging exercises the real client code with test credentials.

### How to detect it in review or in metrics

- Grep for `NODE_ENV` outside configuration and bootstrap files. In application logic it is almost always this anti-pattern.
- Any branch whose production side has no test coverage. Coverage reports make these obvious.
- In review: "which environment tested this line?"

## 60.29 Configuration in code

### What it looks like

```ts
const DB_HOST = 'prod-db-01.internal';
const RATE_LIMIT = 100;
const FEATURE_NEW_CHECKOUT = false;
const STRIPE_KEY = 'sk_live_51H...';       // committed to git, forever
```

### Why it is dangerous

Changing any operational value requires a code change, a review, a build, and a deploy: fifteen minutes at best, during an incident when you need fifteen seconds. Raising a rate limit to absorb a partner's migration becomes a release. The same artifact can no longer be promoted across environments, because the environment is baked into it, which breaks the fundamental build-once-deploy-many principle. And secrets in code are secrets in git history, on every laptop and in every fork, permanently — rotating them is the only remedy.

### How it happens

A constant is the fastest way to make something work, and it starts as one value that "will never change". Configuration infrastructure feels like overhead on day one.

### The fix

Configuration comes from the environment, validated at startup so a bad value fails immediately rather than at 03:00.

```ts
@Module({
  imports: [ConfigModule.forRoot({
    validationSchema: Joi.object({
      DATABASE_URL: Joi.string().uri().required(),
      RATE_LIMIT_PER_MIN: Joi.number().integer().min(1).default(100),
      STRIPE_SECRET_KEY: Joi.string().pattern(/^sk_/).required(),
    }),
    validationOptions: { abortEarly: false },     // report every problem at once
  })],
})
export class AppModule {}
```

Secrets come from a secret manager (AWS Secrets Manager, Vault, sealed Kubernetes secrets), never from the repository. Values that must change without a deploy — feature flags, limits, kill switches — belong in a runtime configuration store or a flag service.

### How to detect it in review or in metrics

- Secret scanning in CI (`gitleaks`, `trufflehog`, GitHub secret scanning) on every push and on history.
- Grep for hostnames, URLs containing `.internal`, and anything matching `sk_live`, `AKIA`, `-----BEGIN`.
- A hardcoded number used in a decision (limits, timeouts, thresholds) is configuration in disguise.
- Operational test: can you change the rate limit without a deploy? If not, it is in the wrong place.

## 60.30 List endpoints with no pagination

### What it looks like

```ts
@Get('orders')
async findAll() {
  return this.orderRepo.find();      // every order, ever
}
```

### Why it is dangerous

The endpoint is fine for eighteen months and then becomes an outage. At 8 million orders with 300-byte rows, one request materialises roughly 2.4 GB of JavaScript objects, serialises them to JSON and holds the whole thing in heap before the first byte reaches the client. The pod is `OOMKilled` in seconds. It is also a free denial-of-service primitive: any authenticated user can take the service down by refreshing a page, and no rate limiter will save you because one request is enough.

### How it happens

The table had 40 rows during development and the frontend "just needs all of them" for a dropdown. Pagination is extra work on both sides for no visible benefit at that size, and nobody revisits the endpoint later because it never errors — it just gets slower until it stops.

### The fix

```ts
@Get('orders')
async findAll(@Query() q: ListOrdersDto) {
  return this.orderRepo.find({
    where: { userId: q.userId },
    take: Math.min(q.limit ?? 25, 100),     // hard server-side ceiling, always
    order: { createdAt: 'DESC' },
  });
}
```

The ceiling must be enforced by the server, not requested by the client. Make the default page size small and return a cursor. For genuine bulk export, use a streaming endpoint or an asynchronous job that writes to object storage.

### How to detect it in review or in metrics

- Grep for `.find()` and `.findAll()` with no `take` or `limit`.
- Response size histogram per endpoint; alert on any response above a few megabytes.
- Query row-count metrics: `pg_stat_statements.rows / calls` above a few thousand for an interactive endpoint.

## 60.31 Deep `OFFSET` pagination

### What it looks like

```sql
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 200000;
```

### Why it is dangerous

`OFFSET` does not skip rows cheaply. PostgreSQL fetches and discards all 200,000 rows before returning 20, so page 1 takes 2 ms and page 10,000 takes 1.8 seconds. Crawlers and export scripts walk deep pages methodically, so the slow case is not rare — it is a background process hitting it thousands of times a day. There is also a correctness bug: if a row is inserted between page requests, rows shift and the client sees an item twice or misses one entirely.

### How it happens

`OFFSET` is what pagination looks like in every tutorial, and the UI needs page numbers. The performance cliff is invisible until someone actually browses deep.

### The fix

Keyset (cursor) pagination: filter on the last seen sort key instead of counting rows.

```sql
-- page 1
SELECT id, created_at FROM orders ORDER BY created_at DESC, id DESC LIMIT 20;
-- next page: pass the last row's (created_at, id) back as a cursor
SELECT id, created_at FROM orders
 WHERE (created_at, id) < ($1, $2)          -- row-value comparison, uses the index
 ORDER BY created_at DESC, id DESC LIMIT 20;
```

With an index on `(created_at DESC, id DESC)` every page costs the same 2 ms, whether it is page 1 or page 10,000. Include a tiebreaker column so the ordering is total and stable. Part 61 gives the decision tree for when `OFFSET` is still acceptable (small, bounded, admin-only tables).

### How to detect it in review or in metrics

- Grep for `OFFSET` and for TypeORM's `skip:` with a value that can grow.
- Latency by page number. If p99 rises with the page parameter, this is why.
- Duplicated or missing items reported by clients during active writes.
