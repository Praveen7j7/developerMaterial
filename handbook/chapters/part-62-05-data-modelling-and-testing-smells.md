## 62.32 Floating point for money

### What it looks like

```ts
@Column('float') price!: number;                  // or 'double precision', or plain number

const total = items.reduce((s, i) => s + i.price * i.qty, 0);
// 0.1 + 0.2 === 0.30000000000000004
```

### Why it is dangerous

Binary floating point cannot represent most decimal fractions exactly. Errors accumulate across additions and multiplications, so an invoice of 1,000 line items can be off by several cents. That is not a rounding curiosity; it is a reconciliation failure. Payment providers reject mismatched amounts, accounting will not balance, and in regulated markets an unbalanced ledger is a reportable defect. I have seen a month-end close delayed by two days over a 4-cent discrepancy that took an engineer a day to trace to a `float` column.

### How it happens

`number` is the only numeric type in JavaScript, and `float` is the obvious column type for something with a decimal point. It works perfectly in every test, because test values are small and few.

### The fix

Store money as integer minor units, or as `NUMERIC`, and always with a currency.

```sql
ALTER TABLE order_items ADD COLUMN unit_price_minor BIGINT NOT NULL;   -- cents
ALTER TABLE order_items ADD COLUMN currency CHAR(3) NOT NULL;
-- NUMERIC(19,4) is the alternative when fractional minor units are needed
```

```ts
export class Money {
  private constructor(readonly minor: bigint, readonly currency: string) {}
  static fromMinor(minor: number | bigint, currency: string) { return new Money(BigInt(minor), currency); }
  plus(o: Money) {
    if (o.currency !== this.currency) throw new CurrencyMismatch(this.currency, o.currency);
    return new Money(this.minor + o.minor, this.currency);
  }
}
```

Note that TypeORM and Sequelize return `NUMERIC` as a string in Node to avoid precision loss. Do not "fix" that by parsing it to a float.

### How to detect it in review or in metrics

- Query the catalogue: `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE data_type IN ('real','double precision') AND column_name ~ '(price|amount|total|cost|fee|balance)'`.
- Grep for `parseFloat` near money field names.
- Reconciliation check: sum line items and compare to the stored order total. Any drift proves it.

## 62.33 JSON blobs instead of a schema

### What it looks like

```ts
@Column('jsonb') data!: Record<string, unknown>;   // everything about the order lives here
```

```sql
SELECT * FROM orders WHERE data->>'status' = 'PAID' AND (data->>'total')::numeric > 100;
```

### Why it is dangerous

The database can no longer help you. There are no `NOT NULL` constraints, no foreign keys, no type checking, and no default index, so the query above is a sequential scan with a cast on every row. Because nothing enforces shape, the column accumulates variants: some rows have `total`, older ones have `totalAmount`, a few have both with different values. Every consumer needs defensive code, and no migration can fix rows whose shape you cannot enumerate.

### How it happens

Schema changes feel slow, and `jsonb` means shipping without a migration. It is genuinely the right tool for sparse, variable, non-queried attributes — the mistake is using it for the core, queried fields because it is convenient today.

### The fix

Columns for anything you filter, sort, join or constrain on. `jsonb` for genuinely variable extras.

```sql
CREATE TABLE orders (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL CHECK (status IN ('NEW','PAID','SHIPPED','CANCELLED')),
  total_minor  BIGINT NOT NULL CHECK (total_minor >= 0),
  metadata     JSONB NOT NULL DEFAULT '{}'    -- vendor extras, campaign tags, A/B data
);
CREATE INDEX orders_metadata_gin ON orders USING gin (metadata jsonb_path_ops);
```

Part 63 covers the flip side: PostgreSQL with `jsonb` is very often the document database you actually needed — the point is to choose deliberately, per column.

### How to detect it in review or in metrics

- Grep for `->>` in `WHERE` clauses. Filtering on an extracted JSON field is the signal.
- `EXPLAIN` showing a seq scan with a `jsonb` filter.
- Data check: `SELECT DISTINCT jsonb_object_keys(data) FROM orders` — a long, inconsistent list means the shape has drifted.

## 62.34 Polling a queue table without `SKIP LOCKED`

### What it looks like

```ts
const jobs = await this.ds.query(
  `SELECT * FROM jobs WHERE status = 'PENDING' ORDER BY id LIMIT 10 FOR UPDATE`);
```

### Why it is dangerous

`FOR UPDATE` without `SKIP LOCKED` makes every worker queue behind the first one. With ten worker pods you get the throughput of one, plus nine idle processes holding open transactions. Under load, lock waits grow until `lock_timeout` or the connection pool is exhausted, and the queue backs up while CPU sits idle. Without `FOR UPDATE` at all it is worse in a different way: every worker selects the same rows and processes each job ten times.

### How it happens

`FOR UPDATE` is the documented way to lock rows, and `SKIP LOCKED` is a less well-known modifier. With one worker in development, neither problem appears.

### The fix

```sql
UPDATE jobs SET status = 'RUNNING', locked_at = now(), locked_by = $1
WHERE id IN (
  SELECT id FROM jobs
   WHERE status = 'PENDING' AND run_after <= now()
   ORDER BY priority DESC, id
   FOR UPDATE SKIP LOCKED           -- each worker takes a different batch
   LIMIT 10
)
RETURNING *;
```

`SKIP LOCKED` lets each worker claim rows nobody else holds, so throughput scales with worker count. Add a `locked_at` reaper for workers that die mid-job, and an index on `(status, run_after)` filtered to pending rows.

### How to detect it in review or in metrics

- Grep for `FOR UPDATE` without `SKIP LOCKED` in any polling loop.
- `pg_stat_activity` showing several sessions in `wait_event_type = 'Lock'` on the same table.
- Queue throughput that does not improve when you add workers. That is the definitive test.

## 62.35 Cron on every replica

### What it looks like

```ts
@Injectable()
export class ReportJob {
  @Cron('0 6 * * *')          // runs on all 6 replicas at 06:00
  async sendDailyReport() { await this.mailer.sendToFinance(await this.buildReport()); }
}
```

### Why it is dangerous

Six replicas means six emails, six full report queries hitting the database simultaneously, and six sets of any side effects. When the job writes data, you get six copies or six racing writers. When it calls a paid API, you pay six times. The consequence scales with your availability: the more replicas you add for reliability, the worse the duplication gets, which is a genuinely perverse incentive.

### How it happens

`@nestjs/schedule` works per process and there is no warning that the process is one of many. It is correct in development, where there is exactly one instance.

### The fix

Guard singleton work with a lock. In a PostgreSQL shop the cheapest correct option is a session advisory lock, which releases automatically if the pod dies.

```ts
@Cron('0 6 * * *')
async sendDailyReport(): Promise<void> {
  const runner = this.ds.createQueryRunner();
  await runner.connect();
  try {
    const [{ pg_try_advisory_lock: got }] =
      await runner.query('SELECT pg_try_advisory_lock($1)', [4711]);
    if (!got) return;                       // another replica is doing it
    await this.mailer.sendToFinance(await this.buildReport());
  } finally {
    await runner.query('SELECT pg_advisory_unlock($1)', [4711]);
    await runner.release();
  }
}
```

Alternatives: a Kubernetes `CronJob` that runs a dedicated pod, or enqueueing a job with a deterministic id so the queue deduplicates it. Part 61 covers leader election properly, including why you still want the work to be idempotent.

### How to detect it in review or in metrics

- Grep for `@Cron` and check each against replica count.
- Duplicate rows or duplicate notifications with timestamps within the same second.
- A job-run counter labelled by pod name. More than one pod per scheduled tick is the proof.

## 62.36 One giant `utils` module

### What it looks like

```ts
// utils.ts - 2,800 lines, imported by 140 files
export function formatDate() {}
export function calculateVat() {}          // business logic, hiding in "utils"
export function slugify() {}
export function getStripeClient() {}       // creates a client at import time
export function isEligibleForFreeShipping() {}
```

### Why it is dangerous

Importing one helper pulls in the whole module and everything it imports, so a unit test for a date formatter instantiates a Stripe client and needs an API key. Circular imports appear as soon as a domain module imports `utils` and `utils` imports a domain type, and in TypeScript those surface as `undefined` at runtime in a way that is genuinely hard to diagnose. The module also becomes a merge-conflict magnet and a dumping ground: `calculateVat` is a domain rule that nobody will ever find in a file called `utils`.

### How it happens

The first two helpers genuinely had no home. Once the file exists, it is the path of least resistance for the third, and there is never a moment where adding one more feels wrong.

### The fix

Group by domain, not by "miscellaneous". `formatDate` goes to `shared/date.ts` with no dependencies. `calculateVat` goes to the pricing module, because it is a business rule. `getStripeClient` becomes a NestJS provider, not a function with import-time side effects. Keep leaf helpers dependency-free so importing them is cheap and testable.

### How to detect it in review or in metrics

- Any file named `utils`, `helpers`, `common` or `misc` over about 200 lines.
- Import fan-in: a module imported by more than 50 files deserves splitting.
- `madge --circular src/` to find the cycles it causes.

## 62.37 Ignoring replication lag

### What it looks like

```ts
await this.writeDb.save(order);                       // primary
const saved = await this.readDb.findOne(order.id);    // replica, 200 ms behind
return saved;                                          // undefined
```

### Why it is dangerous

Read replicas lag: normally 5 to 50 ms, but during a bulk update, a long vacuum or a network hiccup, seconds to minutes. Code that writes then immediately reads from a replica returns stale data or nothing at all. The user creates a resource and the next screen says it does not exist, so they create it again — now you have duplicates. Worse, an authorization check reading a revoked permission from a lagging replica grants access that was withdrawn a minute ago.

### How it happens

Routing reads to replicas is a standard, correct scaling move, usually applied globally with a `slaves`/`replication` configuration. The read-after-write case is a small subset of traffic that nobody separates out.

### The fix

Route by consistency requirement, not by verb. Anything the current user just wrote, and anything security-relevant, reads from the primary.

```ts
// TypeORM lets you force the primary per query
const saved = await this.ds
  .createQueryBuilder(Order, 'o')
  .setQueryRunner(this.ds.createQueryRunner('master'))   // read from primary
  .where('o.id = :id', { id: order.id })
  .getOne();
```

Monitor the lag and stop routing to a replica that exceeds a threshold:

```sql
SELECT client_addr, state,
       (pg_current_wal_lsn() - replay_lsn) AS lag_bytes
FROM pg_stat_replication;
```

### How to detect it in review or in metrics

- Export `pg_replication_lag_seconds` and alert above a few seconds.
- Grep for a read immediately following a write in the same handler.
- Intermittent 404s right after a successful create, especially under load. That symptom is almost always this.

## 62.38 Mocking the database in "integration" tests

### What it looks like

```ts
const mockRepo = { find: jest.fn().mockResolvedValue([{ id: '1', total: 100 }]) };
const module = await Test.createTestingModule({
  providers: [OrderService, { provide: getRepositoryToken(Order), useValue: mockRepo }],
}).compile();
// "integration test" that never touches PostgreSQL
```

### Why it is dangerous

The test asserts that your mock returns what you told it to return. It cannot catch the things that actually break in production: a missing index, a constraint violation, a wrong column type, a transaction that does not roll back, a `NULL` where the code expects a value, a migration that was never applied, or an ORM query that generates invalid SQL. Teams with 90 percent coverage built this way still ship schema bugs weekly, and the coverage number actively hides the gap.

### How it happens

Mocks are fast and require no infrastructure, and setting up a real database in CI used to be genuinely painful. The test file gets labelled "integration" because it wires several classes together, which feels like integration.

### The fix

Run the real database with Testcontainers, or a disposable PostgreSQL service in CI. Keep unit tests mocked and fast; make integration tests real.

```ts
let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  dataSource = new DataSource({ type: 'postgres', url: container.getConnectionUri(),
    entities: [Order], migrations: ['src/migrations/*.ts'] });
  await dataSource.initialize();
  await dataSource.runMigrations();          // migrations are tested too, for free
}, 60_000);

it('rejects a duplicate order for the same cart', async () => {
  await repo.save({ cartId: 'c1', userId: 'u1' });
  await expect(repo.save({ cartId: 'c1', userId: 'u1' }))
    .rejects.toMatchObject({ code: '23505' });   // the real unique constraint fires
});
```

### How to detect it in review or in metrics

- Grep for `getRepositoryToken` combined with `useValue` in files named `*.integration.spec.ts` or `*.e2e-spec.ts`.
- CI runtime: an integration suite that finishes in under a second is not touching a database.
- Track escaped defects by category. Constraint and migration bugs reaching production means this layer is missing.

## 62.39 Deploying with no rollback plan

### What it looks like

A release checklist that ends at "deploy to production", plus a migration in the same release that does `ALTER TABLE orders DROP COLUMN legacy_total;`.

### Why it is dangerous

At 14:20 the new version starts throwing 500s on checkout. The obvious move is to roll back the application — but the previous version reads `legacy_total`, which no longer exists, so rolling back makes things worse. You are now debugging forward under maximum pressure, which typically turns a five-minute incident into a two-hour one. The most expensive minutes in engineering are the ones spent discovering that rollback is impossible.

### How it happens

Deploys usually work. Rollback plans cost time to write and rehearse for an event that has not happened yet, and destructive migrations are bundled with the code change because that is the natural unit of work.

### The fix

Make every release reversible by construction, using expand and contract.

```text
Release N     add new nullable column, dual-write, deploy code that reads either
Release N+1   backfill, switch reads to the new column, verify
Release N+2   stop writing the old column
Release N+3   drop the old column   <- only now, and only after N+2 is proven stable
```

Never combine a destructive migration with a code change. Keep the previous container image warm, know the rollback command, and put a kill switch (a feature flag) in front of risky behaviour so you can disable it in seconds without any deploy. Rehearse a rollback in staging so the runbook is real rather than aspirational. Part 24 and Part 25 cover this in detail.

### How to detect it in review or in metrics

- Any migration containing `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... TYPE` or a `NOT NULL` addition in the same release as code changes.
- Measure mean time to rollback. If nobody knows it, there is no plan.
- In review, ask: what is the exact command to undo this, and has anyone run it?
