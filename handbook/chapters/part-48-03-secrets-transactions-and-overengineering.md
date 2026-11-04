## 48.16 Logging sensitive data

### What it looks like

```ts
@Post('login')
async login(@Body() dto: LoginDto) {
  this.logger.log(`login attempt: ${JSON.stringify(dto)}`);      // password in the log
  const user = await this.auth.validate(dto);
  this.logger.debug('user loaded', user);                        // password hash, email, phone
  return this.jwt.sign({ sub: user.id });
}

// and the interceptor that logs every request body "for debugging"
this.logger.log({ method: req.method, url: req.url, body: req.body, headers: req.headers });
```

### Why it is dangerous

Logs go everywhere. They are shipped to a log aggregator, replicated, backed up, retained for a year, and readable by every engineer, every contractor with dashboard access and every system that ingests them. A password written to a log is a password in fifteen systems, none of which were designed to store credentials. The `headers` line above logs the `Authorization` header, so every bearer token in your system is now in plaintext in a searchable index.

The regulatory consequence is concrete: under GDPR this is unlawful processing, and the remediation is not "stop logging it" but "find and purge every copy from every backup", which is often technically impossible. Under PCI DSS, logging a full card number is an immediate compliance failure that can cost you your ability to take payments. I have seen a company spend three weeks of engineering time and a five-figure legal bill because one debug line logged a request body containing national ID numbers.

### How it happens

Debugging. Someone had a production bug they could not reproduce, added `JSON.stringify(dto)` to see the payload, shipped it, fixed the bug and never removed the line. Or a generic logging interceptor was written to log "everything" because at the time the payloads were harmless. Nobody re-reads logging code when a new field is added to a DTO, so the day someone adds `ssn` to a request body, it starts flowing into the logs silently.

### The fix

Redact structurally, not by remembering. Use an allowlist where you can, and a redaction layer that is applied by the logger itself so no individual log call has to be careful.

```ts
import pino from 'pino';

export const logger = pino({
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      '*.password', '*.passwordHash', '*.token', '*.refreshToken',
      '*.card.number', '*.cvv', '*.ssn', '*.taxId',
      'body.password', 'body.token',
    ],
    censor: '[REDACTED]',
  },
});

// And never log whole objects. Log the identifiers you need to correlate.
this.logger.log({ event: 'login_attempt', userId: user.id, ip: hashIp(req.ip) });
```

Add a test that asserts sensitive fields never appear in serialized log output, and make DTOs opt in to logging with a `@Loggable()`-style marker rather than opting out.

### How to detect it in review or in metrics

- Grep the codebase for `JSON.stringify(dto)`, `logger.*(req.body)`, `logger.*(user)` and `...req.headers`.
- Run a scheduled scan over the log index for patterns: card-number regexes, `"password"`, `Bearer ey`, national ID formats. Alert on any hit.
- In review, reject any log line that logs an entire object it did not construct itself.
- Check log volume per endpoint. An endpoint producing kilobytes per request is logging bodies.

## 48.17 Giant transactions, and transactions that call external APIs

### What it looks like

```ts
await this.dataSource.transaction(async (em) => {
  const orders = await em.find(Order, { where: { status: 'PENDING' } });  // 50,000 rows
  for (const order of orders) {
    const charge = await this.stripe.charges.create({ ... });   // network call INSIDE tx
    await this.mailer.send(order.email, 'receipt', { order });  // another one
    order.status = 'PAID';
    await em.save(order);
  }
});
```

### Why it is dangerous

Two separate disasters in one block.

The transaction is enormous: 50,000 rows locked for the duration. Every one of those rows is unavailable to other writers, so any customer trying to modify their own pending order blocks. It also pins the oldest running transaction's snapshot, which stops autovacuum from cleaning dead tuples across the *whole database* — table bloat grows, and on a busy system you can add tens of gigabytes in an hour. In extreme cases it pushes you toward transaction ID wraparound protection, which forces an emergency vacuum.

The external calls are worse. Stripe's p99 is around 900 ms; 50,000 of them is over twelve hours of held transaction. If the process crashes at order 30,000, the database rolls back all 30,000 status updates, but Stripe has already charged 30,000 cards. The database and the outside world are now permanently inconsistent, and there is no automatic way to reconcile because you rolled away the record of what you did.

### How it happens

Transactions feel like a safety blanket: wrapping more in one feels *safer*, and "all or nothing" sounds like the responsible choice. Batch jobs naturally grow from 50 rows to 50,000 without anyone revisiting the transaction boundary. And the external call ends up inside because the code was written top to bottom, in the order the steps happen.

### The fix

Keep transactions short, local and free of network calls. Chunk the work, and move side effects outside via an outbox.

```ts
// 1. Claim a small batch in its own short transaction.
const batch = await this.ds.transaction(async (em) =>
  em.query(`UPDATE orders SET status = 'PROCESSING', claimed_at = now()
             WHERE id IN (SELECT id FROM orders WHERE status = 'PENDING'
                          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100)
             RETURNING id, email, total_minor`));

// 2. Do the slow, external work OUTSIDE any transaction, with an idempotency key.
for (const order of batch) {
  const charge = await this.stripe.charges.create(
    { amount: order.total_minor, currency: 'eur' },
    { idempotencyKey: `order-charge-${order.id}` },     // safe if we crash and retry
  );
  // 3. Commit the result in a tiny transaction, and queue the email via the outbox.
  await this.ds.transaction(async (em) => {
    await em.update(Order, order.id, { status: 'PAID', chargeId: charge.id });
    await em.insert(OutboxEvent, { aggregateId: order.id, eventType: 'order.paid', payload: { ... } });
  });
}
```

Now the longest transaction is a few milliseconds, a crash loses at most one order's bookkeeping (recoverable via the idempotency key), and email sending happens in a worker.

### How to detect it in review or in metrics

- Grep for HTTP clients, mailers and queue clients used inside a `transaction(` callback. This is a mechanical, high-value lint rule.
- `pg_stat_activity`: alert when `now() - xact_start` exceeds 30 seconds for any session.
  ```sql
  SELECT pid, now() - xact_start AS age, state, left(query, 80)
  FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY age DESC LIMIT 5;
  ```
- Monitor `pg_stat_database.xact_commit` duration and table bloat (`n_dead_tup`) — bloat growth with normal traffic points at long transactions.
- In review, ask how many rows the transaction touches at production scale, not at seed-data scale.

## 48.18 Premature optimisation

### What it looks like

```ts
// A hand-rolled LRU with a custom doubly-linked list, 240 lines,
// written before anyone measured the query it caches.
class OptimizedProductCache {
  private head: Node | null = null;
  private tail: Node | null = null;
  private map = new Map<string, Node>();
  // ...manual pointer manipulation, an off-by-one in eviction, no tests for eviction
}

// Or: a bespoke binary serialization format "because JSON is slow",
// used on an endpoint serving 4 requests per minute.
```

### Why it is dangerous

You pay complexity now for a benefit you have not verified exists. The cost is concrete: 240 lines of pointer manipulation is a permanent tax on every future reader, it has a bug in eviction that leaks memory under a specific access pattern, and it is untested because testing an LRU properly is fiddly. Meanwhile the actual bottleneck — measured later — was a missing index that took one line to fix.

The deeper harm is that premature optimisation usually optimises the wrong thing. In a Node backend, application CPU is rarely the bottleneck; I/O and database work dominate by an order of magnitude. Micro-optimising a loop that accounts for 0.3 percent of request time while a 40 ms query runs next to it is measurably pointless, and the complexity you added makes the real fix harder to see.

### How it happens

Good instincts, wrong timing. Engineers who have been burned by slow systems want to prevent it, and optimisation is a satisfying, tractable kind of work — far more satisfying than measuring. It also masquerades as seniority: writing a clever cache looks more impressive in review than adding an index. And it is often invisible as optimisation at all; it is framed as "doing it properly the first time".

### The fix

Measure first, always. Then optimise the top item, and only that one.

```ts
// Before optimising, get the number. This is the whole discipline.
const start = process.hrtime.bigint();
const result = await this.slowThing();
this.metrics.histogram('operation_duration_ms', Number(process.hrtime.bigint() - start) / 1e6,
  { operation: 'product_lookup' });
```

Use `pg_stat_statements` for database time, an APM flame graph or `node --cpu-prof` for CPU, and a load test to establish the baseline. Then write down the target ("p99 under 200 ms at 500 RPS") before changing anything, so you know when to stop. And prefer the boring fix: an index, a `Promise.all`, a `cache-manager` entry with a TTL, or simply fetching fewer columns. Use `lru-cache` from npm rather than writing one.

### How to detect it in review or in metrics

- A performance-motivated pull request with no before-and-after numbers. Ask for them; if they do not exist, the change is speculative.
- Hand-rolled implementations of things that exist as well-tested libraries: caches, pools, schedulers, serializers.
- Comments containing "for performance" with no benchmark reference.
- Complexity that only makes sense at a scale you do not have. Ask what RPS the code is designed for and compare it to your actual traffic.

## 48.19 Overengineering

### What it looks like

```ts
// Five layers of abstraction so we can "swap the database later"
export interface IRepositoryFactory { create<T>(t: Type<T>): IRepository<T>; }
export interface IRepository<T> { find(spec: ISpecification<T>): Promise<T[]>; }
export interface ISpecification<T> { toCriteria(): ICriteria; and(o: ISpecification<T>): ISpecification<T>; }
export class ProductNameSpecification implements ISpecification<Product> { /* 60 lines */ }
export class ProductActiveSpecification implements ISpecification<Product> { /* 40 lines */ }
export class SpecificationToTypeOrmTranslator { /* 300 lines of query building */ }

// The one and only usage, five years later:
const products = await this.factory.create(Product)
  .find(new ProductNameSpecification(name).and(new ProductActiveSpecification()));
// which is: SELECT * FROM products WHERE name ILIKE $1 AND active = true
```

### Why it is dangerous

Every abstraction is a cost paid on every read, every debugging session and every onboarding. A new engineer must learn five bespoke concepts before they can add a `WHERE` clause. Stack traces pass through four layers of indirection, so a null-pointer error takes twenty minutes to trace instead of two. And the flexibility is almost always unused: in fifteen years I have seen a team actually swap its relational database exactly once, and the abstraction layer did not help because the real coupling was in transactions, migrations and query semantics, not in the repository interface.

The measurable consequence is velocity. Features take longer, estimates inflate, and the team starts routing around the abstraction with "temporary" raw queries, which leaves you with two ways to do everything.

### How it happens

It comes from real pain and good books. Someone was burned by a system that hardcoded a vendor, read about hexagonal architecture, and applied it thoroughly and sincerely. Abstraction also feels like the professional choice; adding an interface is never questioned in review, while removing one is. And "we might need it later" is unfalsifiable, so it always wins the argument.

### The fix

Apply YAGNI with a rule of three: abstract when you have three real implementations, or one implementation plus a signed contract for the second. Until then, write the direct version.

```ts
@Injectable()
export class ProductRepository {
  constructor(@InjectRepository(Product) private readonly repo: Repository<Product>) {}

  findActiveByName(name: string): Promise<Product[]> {
    return this.repo.find({ where: { name: ILike(`%${name}%`), active: true }, take: 50 });
  }
}
```

This is still testable (stub the class), still swappable (change one file), and readable in ten seconds. Keep interfaces for genuine ports — a payment provider, an email sender, a storage backend — where a second implementation already exists or is a test double you actually need.

### How to detect it in review or in metrics

- Interfaces with exactly one implementation and no test double that needs them.
- Abstraction layers whose only caller is one line of application code.
- A ratio: count files touched per feature. If a simple field addition touches seven files, the layering is too deep.
- Onboarding time. If a competent engineer needs two weeks to make their first meaningful change, complexity is the cause.
- In review, ask for the concrete second implementation. "We might" is not one.

## 48.20 Unbounded in-memory caches

### What it looks like

```ts
@Injectable()
export class GeoService {
  private cache = new Map<string, Location>();     // never evicts, never expires

  async resolve(ip: string): Promise<Location> {
    if (this.cache.has(ip)) return this.cache.get(ip)!;
    const loc = await this.geoApi.lookup(ip);
    this.cache.set(ip, loc);                        // one entry per unique IP, forever
    return loc;
  }
}
```

### Why it is dangerous

The key space is unbounded, so the cache is a memory leak with a helpful name. At 300,000 unique IPs a day and roughly 200 bytes per entry, that is 60 MB per day per pod. On a 512 MB container the pod is `OOMKilled` around day six, and because it happens gradually the graph looks like normal growth until the restart. Restarts then produce a cold cache and a burst of geo API calls, which may hit a rate limit and cause a second, unrelated-looking incident.

### How it happens

`new Map()` is the obvious way to cache, and at the time the key space looked small — the developer was thinking about country codes, not IPs. Nobody asks "how many distinct keys can this have?" because the code works perfectly in every test.

### The fix

Bound every in-process cache by size *and* time, and prefer a shared cache when the data is shared.

```ts
import { LRUCache } from 'lru-cache';

private cache = new LRUCache<string, Location>({
  max: 10_000,                       // hard entry cap
  ttl: 60 * 60 * 1000,               // one hour
  maxSize: 20 * 1024 * 1024,         // and a byte budget
  sizeCalculation: (v) => JSON.stringify(v).length,
});
```

For anything shared across pods, use Redis with a TTL and an eviction policy (`maxmemory-policy allkeys-lru`), as in Part 16 — Caching and Redis.

### How to detect it in review or in metrics

- Grep for `new Map(`, `new Set(` and object literals used as caches at class or module scope. Every one needs a bound.
- `nodejs_heap_size_used_bytes` trending upward monotonically between restarts, with a sawtooth at deploys.
- Pods restarting on a regular cadence with `OOMKilled` in their termination reason.
- In review: ask for the maximum number of distinct keys. No answer means no bound.

## 48.21 Request-scoped everything

### What it looks like

```ts
@Injectable({ scope: Scope.REQUEST })          // and so is every service it depends on
export class OrderService {
  constructor(@Inject(REQUEST) private readonly req: Request,
              private readonly pricing: PricingService) {}   // now also request-scoped
}
```

### Why it is dangerous

In NestJS, request scope is contagious: any provider that injects a request-scoped provider becomes request-scoped itself, all the way up the graph. That means the entire dependency tree is instantiated per request. At 2,000 requests per second with 40 providers each, you are constructing 80,000 objects per second, which is pure garbage-collector pressure. Measured overhead is typically 15 to 30 percent added latency, and GC pauses lengthen visibly at p99. It also breaks anything that assumed singleton state: connection pools, in-memory caches, breakers and rate-limit counters are all recreated per request and therefore useless.

### How it happens

Someone needs the current user or a correlation id inside a deep service, and request scope is the documented way to inject `REQUEST`. It works immediately, and the performance cost is invisible until load testing — which usually happens after the pattern has spread.

### The fix

Use `AsyncLocalStorage` for ambient request context and keep providers singleton.

```ts
export const requestContext = new AsyncLocalStorage<{ userId?: string; correlationId: string }>();

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    requestContext.run({ userId: req.user?.id, correlationId: req.headers['x-request-id'] as string ?? randomUUID() }, next);
  }
}

@Injectable()                                    // singleton, fast
export class OrderService {
  get correlationId() { return requestContext.getStore()?.correlationId; }
}
```

Better still, pass what you need explicitly as a parameter. Explicit arguments are cheaper and easier to test than any ambient mechanism.

### How to detect it in review or in metrics

- Grep for `Scope.REQUEST` and `Scope.TRANSIENT`. Each occurrence needs a justification.
- Latency regression after a refactor with no algorithmic change.
- GC metrics: rising `nodejs_gc_duration_seconds` and scavenge frequency with flat traffic.
- Singletons that stop working — a rate limiter whose counters always read zero is the classic symptom.

## 48.22 Business logic in ORM hooks

### What it looks like

```ts
@Entity()
export class Order {
  @AfterInsert()
  async notifyAndCharge() {
    await mailer.send(this.email, 'order-created');   // side effect inside a lifecycle hook
    await stripe.charges.create({ amount: this.totalMinor });
    await analytics.track('order_created', { id: this.id });
  }
}
```

Sequelize's `hooks: { afterCreate }` and TypeORM subscribers produce the same shape.

### Why it is dangerous

The side effects fire inside the ORM's save path, which is usually inside a transaction. A slow email provider now holds a database transaction open (see 48.17). A failure in the hook rolls back the order, so a transient mail error loses a paid order. And the behaviour is invisible: `await repo.save(order)` gives no hint that it charges a card, so a test fixture that creates an order charges a real card in staging. I have watched a data-backfill script send 40,000 emails because it inserted rows through the ORM.

### How it happens

Hooks look like the perfect place for "things that always happen when an order is created", and they genuinely enforce that consistency. The intention — never forget the notification — is right; the mechanism couples persistence to business process.

### The fix

Hooks may compute derived persistence data (a slug, a checksum, `updated_at`). Anything with an external effect goes through an explicit application service and an outbox event.

```ts
async placeOrder(cmd: PlaceOrderCommand) {
  return this.ds.transaction(async (em) => {
    const order = await em.save(Order.place(cmd));
    await em.insert(OutboxEvent, { aggregateId: order.id, eventType: 'order.placed', payload: order.toEvent() });
    return order;                       // email and charge happen in workers, later
  });
}
```

### How to detect it in review or in metrics

- Grep for `@AfterInsert`, `@AfterUpdate`, `@BeforeInsert`, `addHook`, and TypeORM `EntitySubscriber` classes; check each for I/O.
- Any import of an HTTP client, mailer or queue inside an entity file.
- Symptom: a migration or backfill script triggering user-visible side effects.
