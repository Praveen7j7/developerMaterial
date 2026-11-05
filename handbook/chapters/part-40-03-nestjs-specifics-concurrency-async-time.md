## 40.8 Testing NestJS specifics: guards, pipes, interceptors, filters, modules

#### Concept

NestJS has a request pipeline: middleware, guards, interceptors (before), pipes, handler, interceptors (after), exception filters. Each piece is a class you own, so each is testable in isolation (unit) and together (e2e). `@nestjs/testing` provides `Test.createTestingModule`, which builds a real dependency-injection container for a test and lets you swap providers with `overrideProvider`, `overrideGuard`, `overrideInterceptor`, `overridePipe` and `overrideFilter`.

#### Why does it exist?

The pipeline is where authorization, validation, serialization and error mapping live. A bug in a guard is a security incident; a bug in a pipe is a 500 instead of a 400; a bug in a filter leaks a stack trace to a client. These classes are small and pure enough for unit tests, but their *ordering and wiring* only shows up when the app boots, which is why the same behaviours get an e2e test too.

#### How it works

- **Guards** implement `canActivate(context: ExecutionContext)`. Unit test by building a fake `ExecutionContext` with `createMock`-style objects or a tiny hand-written one.
- **Pipes** implement `transform(value, metadata)`. Unit test by calling `transform` directly. `ValidationPipe` with a DTO is tested by passing a plain object and asserting `BadRequestException`.
- **Interceptors** implement `intercept(context, next)`, returning an Observable. Unit test with `of(value)` as `next.handle()` and `lastValueFrom`.
- **Exception filters** implement `catch(exception, host)`. Unit test with a fake `ArgumentsHost` exposing a fake response object.
- **Request-scoped providers** (`@Injectable({ scope: Scope.REQUEST })`) are not created by `module.get`; use `module.resolve(Provider)` which returns a promise, and optionally `module.registerRequestByContextId` to supply a request.

#### NestJS example — unit tests for each pipeline piece

A guard that requires a role:

```ts
// src/auth/roles.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required || required.length === 0) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('no user on request');
    const ok = required.some((r) => user.roles?.includes(r));
    if (!ok) throw new ForbiddenException(`requires one of ${required.join(', ')}`);
    return true;
  }
}
```

```ts
// src/auth/roles.guard.spec.ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function contextWith(user: unknown): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Ctrl {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it('allows when the handler declares no roles', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(contextWith({ roles: [] }))).toBe(true);
  });

  it('forbids a user without the required role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);
    expect(() => guard.canActivate(contextWith({ roles: ['customer'] }))).toThrow(ForbiddenException);
  });

  it('forbids when there is no authenticated user', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(/no user/);
  });

  afterEach(() => jest.restoreAllMocks());
});
```

A DTO with `ValidationPipe`:

```ts
// src/orders/dto/create-order.dto.spec.ts
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { CreateOrderDto } from './create-order.dto';

describe('CreateOrderDto validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const metadata = { type: 'body' as const, metatype: CreateOrderDto };

  it('rejects an empty lines array', async () => {
    await expect(pipe.transform({ lines: [] }, metadata)).rejects.toThrow(BadRequestException);
  });

  it('rejects unknown properties so clients cannot smuggle fields', async () => {
    await expect(pipe.transform({ lines: [{ sku: 'A', qty: 1 }], isAdmin: true }, metadata))
      .rejects.toThrow(/property isAdmin should not exist/);
  });

  it('transforms a valid payload into a class instance', async () => {
    const dto = await pipe.transform({ lines: [{ sku: 'A', qty: 1 }] }, metadata);
    expect(dto).toBeInstanceOf(CreateOrderDto);
  });
});
```

An interceptor that adds timing, and an exception filter that maps domain errors:

```ts
// src/common/domain-error.filter.spec.ts
import { ArgumentsHost } from '@nestjs/common';
import { DomainErrorFilter } from './domain-error.filter';
import { DomainError } from '../orders/domain/order';

it('maps a DomainError to 422 with a stable error code and no stack', () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ url: '/orders', id: 'req-1' }) }),
  } as unknown as ArgumentsHost;

  new DomainErrorFilter().catch(new DomainError('cannot cancel a shipped order'), host);

  expect(status).toHaveBeenCalledWith(422);
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DOMAIN_RULE_VIOLATION', requestId: 'req-1' }));
  expect(json.mock.calls[0][0]).not.toHaveProperty('stack');
});
```

#### NestJS example — `Test.createTestingModule` with overrides

Building a module for a service test with a real `DataSource` from Testcontainers and an overridden payment gateway:

```ts
// src/orders/orders.module.int-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrdersModule } from './orders.module';
import { PAYMENT_GATEWAY, PlaceOrderService } from './place-order.service';
import { createTestDataSource, truncateAll } from '../../test/db';
import { OrderEntity } from './order.entity';
import { OrderItemEntity } from './order-item.entity';

describe('OrdersModule wiring (integration)', () => {
  let ds: DataSource;
  let module: TestingModule;
  const gateway = { charge: jest.fn().mockResolvedValue({ paymentId: 'pay_test' }) };

  beforeAll(async () => {
    ds = await createTestDataSource([OrderEntity, OrderItemEntity]);
    module = await Test.createTestingModule({
      imports: [
        // Reuse the already-initialised DataSource instead of letting Nest create one
        TypeOrmModule.forRootAsync({ useFactory: () => ds.options, dataSourceFactory: async () => ds }),
        OrdersModule,
      ],
    })
      .overrideProvider(PAYMENT_GATEWAY).useValue(gateway)
      .compile();
  });

  afterEach(async () => { gateway.charge.mockClear(); await truncateAll(ds); });
  afterAll(async () => { await module.close(); await ds.destroy(); });

  it('resolves PlaceOrderService with the real repository and the stubbed gateway', async () => {
    const service = module.get(PlaceOrderService);
    const order = await service.execute('cust-1', [{ sku: 'SKU-1', unitPriceCents: 500, qty: 2 }], 'idem-1');
    expect(gateway.charge).toHaveBeenCalledWith({ orderId: order.id, amountCents: 1000 });
    const [row] = await ds.query(`SELECT status, total_cents FROM orders WHERE id = $1`, [order.id]);
    expect(row).toEqual({ status: 'PAID', total_cents: 1000 });
  });
});
```

`dataSourceFactory` is a real option of `TypeOrmModule.forRootAsync`; it lets the test hand Nest an existing `DataSource` rather than having Nest open a second one against the container. Note `module.close()` in `afterAll`: it runs `onModuleDestroy` hooks and prevents the "open handles" warning.

`overrideGuard` is the typical convenience in e2e tests when the behaviour under test is not auth:

```ts
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx) => { ctx.switchToHttp().getRequest().user = testUser; return true; } })
  .compile();
```

Use this sparingly. At least one e2e test per protected route must run the *real* guard with a real test JWT; otherwise the day someone forgets `@UseGuards` on a new controller, nothing notices.

Request-scoped providers:

```ts
import { ContextIdFactory } from '@nestjs/core';

const contextId = ContextIdFactory.create();
moduleRef.registerRequestByContextId({ headers: { 'x-tenant-id': 't-42' } }, contextId);
const tenantCtx = await moduleRef.resolve(TenantContext, contextId);
expect(tenantCtx.tenantId).toBe('t-42');
```

#### Sequelize example — module with `SequelizeModule`

```ts
const module = await Test.createTestingModule({
  imports: [
    SequelizeModule.forRoot({
      dialect: 'postgres', uri: process.env.TEST_DATABASE_URL, schema: workerSchema(),
      models: [OrderModel, OrderItemModel], autoLoadModels: false, synchronize: false, logging: false,
    }),
    OrdersModule,
  ],
}).compile();
```

`synchronize: false` again. Sequelize's `SequelizeModule.forRoot` accepts the same options as the `Sequelize` constructor plus `synchronize`, `autoLoadModels` and `retryAttempts`.

#### Edge cases & failure modes

- `module.get(RequestScopedProvider)` throws; use `module.resolve`.
- `overrideProvider(X).useValue(...)` silently does nothing if `X` is not part of the compiled module graph (for example, provided by a dynamic module with a different token). Assert the override took effect in a test.
- A test that overrides `ValidationPipe` globally hides validation bugs. Keep the real global pipe in e2e tests.
- `Reflector` metadata comes from decorators; a guard test with a hand-built context must stub `getAllAndOverride` or apply the real decorator to a real class.
- Interceptors returning an Observable that never completes (a forgotten `finalize`) cause tests to hang; wrap in `lastValueFrom` with a timeout.

#### Common mistakes

- Testing the guard *through* HTTP only, so a failure reads as "expected 200, got 403" with no clue why.
- Using `app.useGlobalGuards` in production but forgetting to set them up in the e2e test app, so the test passes without auth.
- Creating a `TestingModule` per test with a real database connection, then running out of connections.

#### Interview questions

1. *How do you test a request-scoped provider with `@nestjs/testing`?* Expected: `module.resolve` with a `ContextId` registered via `registerRequestByContextId`.
2. *When is `overrideGuard` acceptable in e2e tests?* Expected: as a convenience when the test is not about auth, provided the real guard is exercised elsewhere by at least one test per protected route.
3. *How do you give Nest an existing `DataSource` in tests?* Expected: `TypeOrmModule.forRootAsync` with `dataSourceFactory`.

## 40.9 Testing transactions and concurrency against a real database

#### Concept

A concurrency test runs several operations *at the same time* against the real database and asserts that invariants hold afterwards. The most valuable one in any commerce system is "N customers try to buy the last M units; exactly M succeed and stock never goes negative". You cannot write this test with mocks, and you cannot write it with transaction-rollback isolation, because it needs multiple real connections.

#### Why does it exist?

Oversell, double refund, double job execution and lost updates are all concurrency bugs (see Part 20 — Database Transactions). They pass every single-threaded test and appear only under load. A concurrency test makes them reproducible on a laptop in 200 ms.

#### How it works

1. Seed the contended row (`stock = 3`).
2. Launch N concurrent calls with `Promise.allSettled` (not `Promise.all`, which stops at the first rejection and hides the count).
3. Count fulfilled vs rejected.
4. Assert on the database state, not on which call won.

#### Practical example — proving oversell protection

```ts
// src/inventory/reserve-stock.int-spec.ts
import { DataSource } from 'typeorm';
import { createTestDataSource, truncateAll } from '../../test/db';
import { Product } from '../products/product.entity';
import { ReserveStockService, OutOfStockError } from './reserve-stock.service';
import { aProduct, seedProducts } from '../../test/builders/product.builder';

describe('ReserveStockService under concurrency', () => {
  let ds: DataSource;
  let service: ReserveStockService;

  beforeAll(async () => {
    // A pool of 20 so the 20 concurrent transactions really run in parallel
    ds = await createTestDataSource([Product]);
    service = new ReserveStockService(ds);
  });
  afterEach(() => truncateAll(ds));
  afterAll(() => ds.destroy());

  it('sells exactly 3 units when 20 customers race for stock=3', async () => {
    const [p] = await seedProducts(ds, [aProduct({ stock: 3 })]);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => service.reserve(p.id, 1, `order-${i}`)),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const outOfStock = results.filter((r) => r.status === 'rejected' && r.reason instanceof OutOfStockError).length;
    expect(ok).toBe(3);
    expect(outOfStock).toBe(17);

    const [row] = await ds.query(`SELECT stock FROM products WHERE id = $1`, [p.id]);
    expect(row.stock).toBe(0);
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM reservations WHERE product_id = $1`, [p.id]);
    expect(n).toBe(3);
  });
});
```

For this test to be meaningful, the pool must be at least as large as the concurrency; with `extra: { max: 5 }` the 20 calls would queue and the test would pass even without locking. In the test file, create the DataSource with `extra: { max: 20 }` and note why in a comment.

The service under test uses `SELECT ... FOR UPDATE` (pessimistic) or an atomic conditional `UPDATE`:

```ts
// src/inventory/reserve-stock.service.ts (core)
async reserve(productId: string, qty: number, orderId: string): Promise<void> {
  await this.ds.transaction(async (m) => {
    const res = await m.query(
      `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock`,
      [qty, productId],
    );
    if (res[1] === 0) throw new OutOfStockError(productId); // rowCount 0: condition failed
    await m.query(`INSERT INTO reservations (product_id, order_id, qty) VALUES ($1, $2, $3)`, [productId, orderId, qty]);
  });
}
```

Remove the `AND stock >= $1` and the test fails with `stock = -17`. Add a `CHECK (stock >= 0)` constraint and the test still passes, but now the failure is a `23514` error instead of `OutOfStockError`, which is a different contract; the test documents which one you chose.

#### PostgreSQL example — a deadlock retry test

Two transactions that lock the same two rows in opposite orders deadlock. PostgreSQL detects it after `deadlock_timeout` (default 1 s) and aborts one with SQLSTATE `40P01`. Code that retries on `40P01` (and on `40001` serialization failure) must be tested for real:

```ts
it('retries and completes both transfers when they deadlock', async () => {
  const [a, b] = await seedProducts(ds, [aProduct({ stock: 10 }), aProduct({ stock: 10 })]);

  // Move stock a->b and b->a concurrently; without retry, one of them dies with 40P01
  const results = await Promise.allSettled([
    service.transferStock(a.id, b.id, 2), // locks a then b
    service.transferStock(b.id, a.id, 3), // locks b then a
  ]);

  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  const rows = await ds.query(`SELECT id, stock FROM products ORDER BY id`);
  expect(rows.map((r: any) => r.stock).reduce((x: number, y: number) => x + y, 0)).toBe(20); // conserved
});
```

To make the deadlock reproducible rather than occasional, the service can accept an optional `delayBetweenLocksMs` in tests, or the test sets `deadlock_timeout = '50ms'` on the test connection so detection is fast. A deterministic alternative is to lock rows in a fixed order (`ORDER BY id`) in the service, which makes the deadlock impossible; the test then verifies that both complete without any retry and `pg_stat_database.deadlocks` did not increase.

#### Edge cases & failure modes

- The test passes because the pool serialised the requests, not because the locking works. Pool size must exceed concurrency.
- `Promise.all` hides the count of failures. Use `allSettled`.
- Fake timers and concurrency tests do not mix; the database does not care about Jest's clock.
- On a slow CI runner, 20 concurrent transactions plus a 1 s `deadlock_timeout` can exceed the default 5 s Jest timeout; set `testTimeout` explicitly.
- Transaction-rollback isolation cannot host this test (single connection). Use truncate.

#### Interview questions

1. *How do you prove oversell protection in an automated test?* Expected: real database, N concurrent calls with `Promise.allSettled`, pool larger than N, assert exact success count and final stock.
2. *Why might a concurrency test pass while production oversells?* Expected: the pool serialised the calls, or the test hit a different code path (for example a cached stock value).

## 40.10 Testing async flows: jobs, sagas, outbox relay, consumers

#### Concept

Many backend behaviours complete *after* the request returns: an outbox relay publishes an event, a worker processes a job, a saga advances after a reply. Tests for these must wait for **eventual state** instead of asserting immediately.

#### Why does it exist?

`await service.execute()` returning does not mean the email was sent or the event was published. Asserting immediately gives a flaky test that passes on a fast laptop and fails in CI. A polling helper with a timeout turns "eventually" into a deterministic assertion.

#### How it works — the polling helper

```ts
// test/wait-for.ts
export async function waitFor<T>(
  probe: () => Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; until?: (v: T) => boolean } = {},
): Promise<T> {
  const { timeoutMs = 5_000, intervalMs = 50, until = (v) => Boolean(v) } = opts;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (until(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}
```

Use it to test the outbox relay end to end with real PostgreSQL and a captured publisher:

```ts
it('relays an unpublished outbox row and marks it published', async () => {
  await ds.query(
    `INSERT INTO outbox (id, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4)`,
    ['e1', 'order-1', 'order.placed', JSON.stringify({ orderId: 'order-1' })],
  );
  const published: unknown[] = [];
  const relay = new OutboxRelay(ds, { publish: async (e) => { published.push(e); } }, { batchSize: 50 });

  await relay.runOnce(); // one tick, no timers involved

  const row = await waitFor(() => ds.query(`SELECT published_at FROM outbox WHERE id = 'e1'`).then((r) => r[0]),
    { until: (r) => r?.published_at != null });
  expect(row.published_at).toBeTruthy();
  expect(published).toHaveLength(1);
});
```

Design tip visible in that test: the relay exposes `runOnce()` separately from its `setInterval` loop. Tests call `runOnce()` directly and never need fake timers.

#### The fake timers pitfall with async database calls

`jest.useFakeTimers()` replaces `setTimeout`, `setInterval`, `Date` and friends. It does **not** speed up I/O. This code hangs forever:

```ts
jest.useFakeTimers();
const p = relay.start();          // internally: setInterval(() => this.runOnce(), 1000)
jest.advanceTimersByTime(1000);   // fires the callback, which awaits a real DB query
await p;                          // the DB response arrives on a real timer that is now frozen
```

The pg driver's own timeouts, the pool's idle checks and the container's readiness checks all use timers. Freezing them freezes the database client. Rules:

- Never enable fake timers in a test that touches a real database, Redis, Kafka or HTTP.
- If you must advance a timer *and* await I/O, use `jest.advanceTimersByTimeAsync` (Jest 29.5+) and enable fake timers with `doNotFake: ['nextTick', 'setImmediate']`; even then, prefer redesigning the code so the tick can be triggered directly.
- Inject the clock and the scheduler into anything that loops, so tests call the tick function.

#### Testing a BullMQ job processor

```ts
it('generates the invoice PDF and stores its key on the order', async () => {
  const processor = module.get(InvoiceProcessor);
  const job = { id: '1', data: { orderId: order.id }, attemptsMade: 0 } as Job<InvoiceJobData>;

  await processor.process(job); // call the processor method directly; no real queue needed

  const [row] = await ds.query(`SELECT invoice_key FROM orders WHERE id = $1`, [order.id]);
  expect(row.invoice_key).toMatch(/^invoices\/.+\.pdf$/);
  expect(storage.objects.has(row.invoice_key)).toBe(true); // in-memory storage fake
});
```

The queue itself (retries, backoff, dead-letter) is BullMQ's responsibility and is tested by BullMQ. Your test covers your processor. An integration test with a real Redis container that enqueues and waits for completion is still worth having for the *wiring* (queue name, processor registration), but one per queue is enough.

#### Edge cases & failure modes

- A polling helper with no timeout hangs CI silently; always include one, and include the last observed value in the error.
- Polling every 1 ms hammers the database; 25–100 ms is enough.
- Waiting for "count increased" is flaky if a previous test left rows; truncate first.
- Consumer tests must wait for the consumer to *join the group* before producing (kafkajs `consumer.run` resolves before assignment); wait for a first heartbeat or use `fromBeginning: true`.

#### Interview questions

1. *How do you test an outbox relay?* Expected: real DB, insert a row, call the relay's single-tick method, assert the row is marked published and the publisher received the event; no timers.
2. *Why do fake timers hang tests that use a real database?* Expected: the driver relies on timers for I/O; freezing them freezes the client.

## 40.11 Testing time: frozen clocks, cron logic and TTL expiry

#### Concept

Anything that depends on "now" (expiry, scheduling, grace periods, `createdAt` ordering, daily reports) must be tested at fixed, chosen instants: just before the boundary, exactly at it, just after it.

#### How it works — three techniques

**1. Inject a `Clock`** (best). The service never calls `Date.now()`; it calls `this.clock.now()`. Tests supply `{ now: () => new Date('2026-09-06T23:59:59.999Z') }`.

**2. `jest.useFakeTimers` + `jest.setSystemTime`** for code you do not control that reads `Date`:

```ts
beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); jest.setSystemTime(new Date('2026-09-06T10:00:00Z')); });
afterEach(() => jest.useRealTimers());

it('expires a reservation after 15 minutes', () => {
  const r = Reservation.create('order-1', new Date());
  jest.advanceTimersByTime(15 * 60 * 1000 - 1);
  expect(r.isExpired(new Date())).toBe(false);
  jest.advanceTimersByTime(1);
  expect(r.isExpired(new Date())).toBe(true);
});
```

**3. Let the database decide, and test in the database.** For TTLs enforced by SQL (`WHERE expires_at < now()`), do not fight `now()`; insert rows with explicit `expires_at` in the past and future and assert which are selected:

```ts
it('cleanup deletes only expired reservations', async () => {
  await ds.query(`INSERT INTO reservations (id, expires_at) VALUES
    ('past', now() - interval '1 minute'), ('future', now() + interval '1 minute')`);
  await cleanup.runOnce();
  const rows = await ds.query(`SELECT id FROM reservations ORDER BY id`);
  expect(rows.map((r: any) => r.id)).toEqual(['future']);
});
```

**Cron logic.** Do not test that `@Cron('0 2 * * *')` fires at 02:00; that is the library's job. Test *your* function with an injected "as of" date: `dailyReport.run(new Date('2026-09-06T02:00:00Z'))` and assert it covers `2026-09-05` in the configured time zone. Test the time zone explicitly: the same instant is `2026-09-06 07:30` in IST.

**Redis TTL.** With a real Redis container, set a key with `EX 1`, assert `ttl > 0`, then `await sleep(1100)` and assert `null`. One such test per TTL-dependent feature is enough; longer TTLs are tested by asserting the TTL value, not by waiting.

#### Edge cases & failure modes

- `jest.setSystemTime` does not affect PostgreSQL's `now()`; a test mixing both compares two different clocks.
- Time zone of the CI runner (`TZ` unset means UTC on Linux) differs from a developer laptop; set `TZ=UTC` in `jest.config` via `process.env.TZ = 'UTC'` at the top of the config file.
- Month-end and leap-day arithmetic: `2026-01-31 + 1 month` is ambiguous; pin tests at those dates.
- Tests that `sleep` to wait for expiry are slow and flaky; prefer injecting time and using the database for the rest.

## 40.12 Testing migrations

#### Concept

A migration is production code that runs once, under load, and often cannot be undone. It deserves a test: does `up` apply cleanly on the current schema? Does `down` reverse it? Does it take locks that block traffic?

#### How it works

1. In an integration test, start from the schema at the previous migration (run all migrations except the last, or restore a snapshot).
2. Run `up`; assert the resulting schema (`information_schema.columns`, `pg_indexes`).
3. Run `down`; assert the previous schema is restored.
4. Measure the wall-clock time of `up` on a table seeded with a realistic number of rows and assert it stays within a budget; long durations usually mean a full-table rewrite or a lock held while backfilling.

```ts
// src/migrations/1757152800000-add-orders-currency.int-spec.ts
it('adds currency with a default without rewriting the table, and reverses', async () => {
  await ds.query(`INSERT INTO orders (id, customer_id, total_cents, status) SELECT gen_random_uuid(), 'c', 100, 'PAID' FROM generate_series(1, 200000)`);

  const start = Date.now();
  await ds.runMigrations(); // applies only the pending one
  const ms = Date.now() - start;
  expect(ms).toBeLessThan(2_000); // ADD COLUMN ... DEFAULT is metadata-only on PG 11+

  const [col] = await ds.query(`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'currency'`);
  expect(col).toEqual({ column_default: "'INR'::text", is_nullable: 'NO' });

  await ds.undoLastMigration();
  const gone = await ds.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'currency'`);
  expect(gone).toHaveLength(0);
});
```

To assert on lock behaviour, run the migration in one connection while a second connection holds a short transaction on the table and assert the migration either waits less than `lock_timeout` or fails fast (`SET lock_timeout = '2s'` inside the migration is a production best practice; see Part 23 — Database Migrations and Zero-Downtime Schema Changes).

#### Edge cases & failure modes

- `CREATE INDEX` without `CONCURRENTLY` inside a transaction blocks writes for the whole build; a migration test on 200k rows will show hundreds of milliseconds where you expected metadata-only.
- `down` migrations that drop data cannot be reversed; the test should at least assert they *run*.
- Migrations tested only on an empty table hide rewrites; seed rows.
- TypeORM's `migrationsRun: true` at app boot in tests races with parallel workers; run migrations in global setup only.

#### Practical exercise

Write an integration test for your next migration that (1) seeds 100k rows, (2) asserts `up` completes under a budget, (3) asserts the exact schema change via `information_schema`, and (4) asserts `down` restores the previous state. Acceptance: the test fails if `CONCURRENTLY` is removed from an index creation, because the duration budget is exceeded.
