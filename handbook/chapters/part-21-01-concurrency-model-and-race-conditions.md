# Part 21 — Concurrency in Node.js and NestJS

"Node is single-threaded, so I don't have to think about race conditions." Every backend engineer has heard this, and most have believed it at some point. It is wrong in a way that costs money: oversold inventory, double payments, duplicated emails, cron jobs that run five times because there are five pods. Node runs your JavaScript on one thread, but it runs *many requests at once* on that thread, switching between them at every `await`. And your NestJS process is one of many identical pods talking to the same database. Concurrency is everywhere in a Node backend; it is just not called threads.

This part teaches concurrency the way it actually shows up: two customers buying the last item, two pods claiming the same job, a cache being rebuilt by 500 requests at once, a transaction waiting for a connection that will never come. For each problem we look at the mechanism, the fix in PostgreSQL, TypeORM and Sequelize, the NestJS wiring, and the incident that made someone learn it. The lens throughout is one rule: **every `await` is a point where the world can change**.

## 21.1 The Node.js concurrency model

#### Concept

A Node.js process executes JavaScript on a single thread. It achieves concurrency, meaning many operations in progress at once, by never waiting: when your code asks for something slow (a database query, an HTTP call, a file read, a timer), it hands the work to the operating system or to libuv's worker pool, registers a callback, and moves on to run other JavaScript. When the slow thing finishes, its continuation is queued and run when the thread is free. `async/await` is syntax over that mechanism: the code *after* an `await` is the callback.

**Concurrency** is many things in progress, interleaved. **Parallelism** is many things executing at the same instant on different cores. A single Node process gives you concurrency for I/O and *no* parallelism for JavaScript. Parallelism comes from running several processes (Kubernetes replicas, the `cluster` module) or from `worker_threads`, each with its own event loop.

#### Why does it exist?

A thread-per-request server (classic Java, Apache prefork) spends most of its threads *waiting*: on the database, on the network, on the disk. Each waiting thread costs a stack (about 1 MB) and context switches. Node's model was designed for I/O-heavy servers, where a single thread can keep 10,000 sockets in flight because it never blocks on any of them. The cost is that the one thread must never be *held*: a 200 ms synchronous computation freezes every one of those 10,000 requests for 200 ms.

#### Mental model

Imagine a single chef in a kitchen with twenty pots on the stove. The chef never stands and watches a pot boil; they stir one, move to the next, plate a third, and come back when a timer rings. Twenty dishes are "in progress" with one pair of hands. That is concurrency without parallelism. Now imagine the chef stops to hand-grind spices for five minutes: every pot burns. That is a blocked event loop. And if you hire a second chef, you have parallelism, but now two people can reach for the same pot at the same time, and *that* is where the rest of this part begins.

#### How it works

1. A request arrives on the socket. libuv notices and the event loop calls the HTTP parser, which calls your NestJS route handler. This runs synchronously until the first `await`.
2. At `await this.repo.findOne(...)`, the query is written to the PostgreSQL socket and the handler returns a pending promise. The thread is free.
3. Another request arrives and its handler runs until *its* first `await`. Now two requests are in flight, both parked.
4. PostgreSQL replies to the first query. libuv queues the callback; when the current synchronous work finishes, the promise resolves and the first handler's continuation runs (as a microtask) until its next `await`.
5. This repeats. At any moment exactly one piece of JavaScript is running; between `await`s, *any* other request may have run and changed the database, the cache, or in-memory state.

```text
Event loop tick (simplified)
  timers        -> setTimeout / setInterval callbacks
  pending I/O   -> completed socket / fs callbacks
  poll          -> wait for new I/O, run callbacks
  check         -> setImmediate callbacks
  close         -> socket close callbacks
  (after every callback: drain ALL microtasks: resolved promises, process.nextTick)

libuv thread pool (default 4 threads, UV_THREADPOOL_SIZE up to 1024):
  fs.*, dns.lookup, crypto.pbkdf2 / randomBytes / scrypt, zlib
  -> these are parallel, but their callbacks still run on the one JS thread
```

#### Practical example

An orders API handler does: read the cart (5 ms DB), call the pricing service (40 ms HTTP), write the order (5 ms DB), publish an event (2 ms Kafka). Total 52 ms of *waiting* and about 1 ms of JavaScript. One pod handles 500 such requests per second with the event loop busy about 50% of the time; around 26 requests are in flight at any moment, interleaved at their `await`s.

#### NestJS example

The same handler with the interleaving points marked. Each comment is a place where other requests run.

```ts
@Injectable()
export class OrdersService {
  constructor(
    private readonly carts: CartsRepository,
    private readonly pricing: PricingClient,
    private readonly orders: OrdersRepository,
    private readonly events: OrderEventsPublisher,
  ) {}

  async placeOrder(userId: string, dto: PlaceOrderDto): Promise<Order> {
    const cart = await this.carts.findActive(userId);        // yield: other requests run here
    if (!cart) throw new NotFoundException('cart');

    const quote = await this.pricing.quote(cart);             // yield: 40 ms; the cart may change meanwhile
    const order = await this.orders.create({                  // yield
      userId, items: cart.items, totalCents: quote.totalCents,
    });
    await this.events.publish('orders.created', order);       // yield
    return order;
  }
}
```

Nothing here is wrong *yet*. The point is that between reading the cart and creating the order, 40 ms pass during which the same user can add an item, a different request can place the same cart, and inventory can be sold to someone else. Section 21.2 turns that observation into a bug.

A blocked event loop, for contrast:

```ts
@Post('import')
import(@Body() body: { csv: string }) {
  const rows = parseCsvSync(body.csv);       // 30 MB CSV: ~800 ms of pure JavaScript
  return { rows: rows.length };               // every other request on this pod waited 800 ms
}
```

At 500 RPS, that one call delays about 400 other requests by up to 800 ms, and if the liveness probe was among them and its timeout is 2 s, three such imports in a row restart the pod. CPU-bound work belongs in a worker thread or a separate worker process (21.9, 21.10).

#### Production scenario

A NestJS API with 8 pods serves 4,000 RPS with p99 of 45 ms. Event-loop lag p99 is 3 ms. One deploy introduces a synchronous `JSON.stringify` of a 12 MB report response on one route called 2 times per minute. Event-loop lag p99 rises to 180 ms *on every route*, because for 150 ms twice a minute nothing else runs. The route was "fast" in isolation (150 ms) and invisible in its own latency metrics; the damage showed up in everyone else's. `monitorEventLoopDelay` (Part 20 — Reliability Engineering, load shedding) is the metric that catches this.

#### Failure scenario

At 09:12 the auth service began restarting in a loop. Liveness probes were timing out. CPU was at 100% on one core per pod. The cause: password hashing with `bcrypt.hashSync` at cost factor 12 (about 250 ms of CPU) on a login endpoint that had just received a credential-stuffing attack at 40 logins per second per pod. 40 x 250 ms = 10 s of CPU demanded per second of wall clock; the event loop never came up for air; liveness failed; Kubernetes restarted the pod; the attack continued. Fix: `bcrypt.hash` (async; runs in the libuv thread pool), a rate limit on login per IP and per account, and `UV_THREADPOOL_SIZE=8` so four hashes could run in parallel without starving `fs` and `dns`.

#### Edge cases & failure modes

- **Synchronous CPU work** on the request path: `JSON.parse` of large bodies, `bcrypt.hashSync`, regex catastrophes, sorting a million items, image processing.
- **`await` inside a loop over thousands of items** serializes them (slow but safe) versus `Promise.all` (fast but unbounded; Part 20, backpressure).
- **The libuv thread pool is shared**: `dns.lookup`, `fs`, `crypto.pbkdf2` and `zlib` compete for 4 threads; a burst of `fs.readFile` delays DNS resolution for your HTTP clients.
- **Microtask starvation**: a promise chain that never yields to the event loop (`while (true) await Promise.resolve()`) blocks I/O just like a synchronous loop.
- **Unhandled promise rejection** crashes the process on Node 15+ (21.11).
- **`process.nextTick` recursion** starves I/O entirely.
- **Timers are not precise**: `setTimeout(fn, 100)` fires *at least* 100 ms later, and later still under lag.

#### How a Senior Backend Engineer thinks about this

They never say "single-threaded" without adding "with many requests interleaved". They watch event-loop lag as a first-class metric. They keep CPU-bound work off the request path, either in worker threads for latency-sensitive cases or in worker deployments for everything else. They size the process count to cores (one Node process per core via replicas, not one giant pod) and they know the libuv pool size and what runs on it. And they treat every `await` as a place where state must be re-validated, which is the subject of the rest of this part.

#### Common mistakes

- Believing single-threaded means race-free.
- Doing CPU work in the API process because "it's only 100 ms".
- Using `*Sync` APIs in request handlers.
- Assuming `setTimeout` or `setInterval` runs on time under load.

#### Interview questions

1. *Explain the difference between concurrency and parallelism in Node.js. How do you get each?* Expected: concurrency via the event loop for I/O; parallelism via replicas, `cluster`, or `worker_threads`.
2. *What happens to other requests when one handler runs 500 ms of synchronous code?* Expected: they all wait; latency and health probes suffer; move the work to a worker.
3. *What runs on the libuv thread pool, and why does its size matter?* Expected: `fs`, `dns.lookup`, some `crypto`, `zlib`; default 4; contention between them.
4. *If Node is single-threaded, where can a race condition come from?* Expected: interleaving at `await`s across in-flight requests; multiple pods; the database as shared state.

#### Practical exercise

Write a NestJS route that computes a SHA-256 over a 50 MB buffer synchronously, and a `/ping` route. Drive `/ping` at 200 RPS with `autocannon` and call the hashing route once every 2 s. Record `/ping` p99 and event-loop lag. Then move the hash to `crypto.subtle.digest` (async) or a worker thread and repeat. Acceptance criteria: with the synchronous version, `/ping` p99 exceeds 100 ms; with the async version it stays under 10 ms and event-loop lag p99 under 5 ms.

## 21.2 How race conditions happen in single-threaded Node.js

#### Concept

A race condition is a bug whose outcome depends on the relative timing of two or more operations. In Node, the operations are *requests* (or jobs, or timers), and the timing is decided by which promise resolves first. Two requests each read a value, each compute a new value from what they read, and each write it back; the second write silently overwrites the first, and the state is wrong even though every line of code "worked".

#### Why does it exist?

Because the sequence `read, think, write` is not atomic when there is an `await` inside it. The `await` releases the thread; another request performs its own `read` before the first request's `write` lands; both requests now hold the same stale value. The database sees two separate, individually valid transactions. Nothing errors. The inventory says 1, two customers each buy it, the inventory says 0, and two shipments are promised.

#### Mental model

Imagine two bank tellers with one shared ledger page. Teller A reads "balance: 100", walks to the back office to get a form (that is the `await`), and comes back to write "balance: 90" after a 10 withdrawal. While A was away, Teller B read "balance: 100", walked away, and came back to write "balance: 70" after a 30 withdrawal. The final page says 70; the customer withdrew 40. The tellers never worked at the same instant. They interleaved.

#### How it works

The canonical oversell, in NestJS with TypeORM:

```ts
// THIS IS THE BUG. Do not copy it.
@Injectable()
export class InventoryService {
  constructor(@InjectRepository(Inventory) private readonly repo: Repository<Inventory>) {}

  async reserve(productId: string, qty: number): Promise<void> {
    const inv = await this.repo.findOneByOrFail({ productId });   // (1) read
    if (inv.stock < qty) throw new ConflictException('out of stock'); // (2) think
    inv.stock -= qty;
    await this.repo.save(inv);                                      // (3) write: UPDATE ... SET stock = <computed>
  }
}
```

Two requests for the last unit arrive within a few milliseconds:

```mermaid
sequenceDiagram
    participant A as Request A
    participant L as Event loop
    participant B as Request B
    participant DB as PostgreSQL
    A->>DB: SELECT stock WHERE product = p1
    Note over L: A awaits, thread free
    B->>DB: SELECT stock WHERE product = p1
    Note over L: B awaits, thread free
    DB-->>A: stock = 1
    A->>A: 1 >= 1, ok; stock = 0
    A->>DB: UPDATE SET stock = 0
    DB-->>B: stock = 1
    B->>B: 1 >= 1, ok; stock = 0
    B->>DB: UPDATE SET stock = 0
    Note over DB: stock = 0, two reservations succeeded
```

Both requests read 1. Both pass the check. Both write 0. One unit, two sales. The interleaving that produced this needs no threads: it needs only two `await`s and a few milliseconds.

**The rule: every `await` is a point where the world can change.** Whatever you read before an `await` may be stale after it. If your write depends on what you read, and something else could have written in between, you have a race. The fix is always one of:

- **Make the read-think-write atomic in the database** (`UPDATE ... WHERE stock >= qty`; 21.6).
- **Lock the row for the duration** (`SELECT ... FOR UPDATE`; 21.8).
- **Detect the change and retry** (version column; 21.7).
- **Serialize through a single owner** (a queue with one consumer per key; 21.10).

**In-memory state is shared mutable state.** A module-level `Map`, a property on a singleton NestJS provider, a closure captured by a route: all of these are shared across every in-flight request in the process. The classic version:

```ts
@Injectable()
export class CouponService {
  private redeemed = new Set<string>();          // shared by every request in this pod

  async redeem(code: string, userId: string) {
    if (this.redeemed.has(code)) throw new ConflictException('already used');
    const coupon = await this.coupons.findOne({ where: { code } });   // await: another request can pass the check
    await this.orders.applyDiscount(userId, coupon);
    this.redeemed.add(code);                                          // too late
  }
}
```

Between the `has` check and the `add`, there are two `await`s. Two requests with the same code both pass. And even if you moved `add` before the first `await` (which *would* make the in-process check correct, because there is no `await` between `has` and `add`), it would still be wrong, because:

**Multiple pods make it worse.** Your process's memory is invisible to the other 11 pods. An in-process check, mutex, or `Set` protects against interleaving *within one pod* and nothing else. Two requests for the same coupon land on two different pods and both pass. Any correctness guarantee for a multi-pod deployment must live in a shared system: PostgreSQL (constraints, locks, atomic updates), Redis (`SET NX`, Lua), or a queue with partitioning by key. In-process locks are for protecting in-process resources (a cache entry being rebuilt, a file handle), never for business invariants.

#### Practical example

A flash sale: 5,000 units of a product, 60,000 shoppers hitting "buy" in the first 10 seconds across 20 pods. The naive `findOne / check / save` sells 5,600 units. Each oversold order costs a cancellation email, a refund, and a customer who tweets about it.

#### PostgreSQL example

The same race, shown as two sessions so you can reproduce it in `psql`. Open two terminals.

```sql
-- Session A                                   -- Session B
BEGIN;
SELECT stock FROM inventory
 WHERE product_id = 'p1';   -- 1
                                                BEGIN;
                                                SELECT stock FROM inventory
                                                 WHERE product_id = 'p1';   -- 1 (READ COMMITTED sees the same)
UPDATE inventory SET stock = 0
 WHERE product_id = 'p1';
COMMIT;
                                                UPDATE inventory SET stock = 0
                                                 WHERE product_id = 'p1';   -- waits for A, then proceeds
                                                COMMIT;                     -- stock = 0, both "sold"
```

Under the default `READ COMMITTED`, B's `UPDATE` waits for A's lock, re-reads the row (sees 0), and applies `SET stock = 0` anyway, because the value was computed in the application, not in SQL. The database did everything right; the *application* wrote a stale computation. Under `SERIALIZABLE`, B's commit would fail with `40001` and could be retried, which is one valid fix (21.7 discusses the tradeoffs).

#### TypeORM example

The same bug and its smallest fix side by side:

```ts
// Bug: read, compute in JS, write.
const inv = await repo.findOneByOrFail({ productId });
if (inv.stock < qty) throw new ConflictException();
inv.stock -= qty;
await repo.save(inv);

// Fix: let PostgreSQL do read-check-write in one statement (details in 21.6).
const result = await repo.createQueryBuilder()
  .update(Inventory)
  .set({ stock: () => 'stock - :qty' })
  .where('product_id = :productId AND stock >= :qty', { productId, qty })
  .execute();
if (result.affected === 0) throw new ConflictException('out of stock');
```

#### Sequelize example

```ts
// Bug
const inv = await Inventory.findOne({ where: { productId }, rejectOnEmpty: true });
if (inv.stock < qty) throw new ConflictException();
await inv.update({ stock: inv.stock - qty });

// Fix
const [affected] = await Inventory.update(
  { stock: sequelize.literal(`stock - ${Number(qty)}`) },        // qty validated as a positive integer by the DTO
  { where: { productId, stock: { [Op.gte]: qty } } },
);
if (affected === 0) throw new ConflictException('out of stock');
```

#### Production scenario

An e-commerce API at 300 RPS, with 2% of requests touching a "hot" product during promotions. With the naive code, oversells occurred about 15 times a day, always on hot products, always during the first minute of a promotion. After the atomic `UPDATE`, zero oversells in six months, and no measurable latency change (the conditional `UPDATE` is one round trip instead of two).

#### Failure scenario

At 20:00 a sneaker drop began. 1,000 pairs. Inventory service on 16 pods. The code was `findOne`, check, `save`. By 20:00:14 the site showed "sold out". By 20:01 the orders table had 1,312 paid orders for that SKU. The team discovered it at 20:30 from the warehouse. 312 refunds, 312 apology emails, a social-media storm, and a post-mortem whose root cause was written as: "`await` between read and write; no atomic guard; in-process checks on 16 pods." The fix (one conditional `UPDATE`) took 30 minutes. The refund processing took a week.

#### Edge cases & failure modes

- **Read-modify-write via ORM `save()`**: every ORM `save` of a loaded entity is a stale write unless guarded.
- **Two `await`s far apart** (an HTTP call between read and write) widen the window from milliseconds to seconds.
- **Retries widen the window further**: a retried request re-reads and re-races.
- **Multi-pod** defeats every in-process guard.
- **Replica reads** make the initial read stale by replication lag before the race even begins.
- **Caches** are another read of stale state; check-then-act against a cached value is the same bug with extra steps.
- **Event handlers** (`@OnEvent`, Kafka consumers) race with HTTP handlers on the same rows.

#### How a Senior Backend Engineer thinks about this

Their reflex on seeing `findOne` followed by `save` is to ask "what happens if two of these run at once?" and then "on two pods?". They push invariants into the database, where atomicity and constraints are free, and they keep in-memory state out of request handling entirely unless it is explicitly a per-process cache. They know that `SERIALIZABLE` is correct but pays a retry tax, that atomic updates are cheapest when the invariant is a simple predicate, and that row locks are the tool when the critical section has several steps. And they reproduce the race in a test with two concurrent requests before they believe the fix (21.16).

To a product manager: "Two customers can click 'buy' on the last item within the same millisecond. Unless the database itself refuses the second one, we sell it twice."

#### Common mistakes

- `findOne` then `save` for anything that is a counter, a balance, a stock level or a status transition.
- "I added an `if` check" as a fix.
- An in-process `Map` or `Set` as a lock or a deduplication table.
- Testing with one request at a time and calling it verified.

#### Interview questions

1. *Show me how a race condition can happen in single-threaded Node.js.* Expected: read-await-write interleaving; two requests both see the old value; multi-pod.
2. *Why does an in-memory lock not fix an oversell in Kubernetes?* Expected: each pod has its own memory; the shared state is the database.
3. *What are the four families of fixes for a read-modify-write race?* Expected: atomic statement, row lock, optimistic version, serialize by key through a queue.
4. *Under `READ COMMITTED`, why does the second `UPDATE` not "see" the first one's change?* Expected: it does see it (re-reads the row), but applies a value computed in the application from stale data.

#### Practical exercise

Reproduce the oversell: seed `inventory(product_id='p1', stock=1)`, start a NestJS app with the buggy `reserve`, and fire 50 concurrent `POST /reserve` requests with `Promise.all` from a script. Acceptance criteria: with the buggy code, more than one request returns `200`; after replacing the body with the conditional `UPDATE`, exactly one returns `200` and 49 return `409`, over 20 repeated runs.

## 21.3 A catalogue of race conditions

#### Concept

The oversell is one instance of a small family of shapes. Once you can recognise the shape, you can see the race in code review before it ships. Each shape has a standard fix.

| Shape | Looks like | Standard fix |
|---|---|---|
| Check-then-act | `if (!exists) create()` | Unique constraint + `ON CONFLICT`; let the database refuse |
| Read-modify-write | `x = read(); write(x - 1)` | Atomic `UPDATE ... SET x = x - 1 WHERE x >= 1` |
| TOCTOU on files | `if (!fs.exists(p)) fs.write(p)` | Open with exclusive flags (`wx`); atomic rename; use the OS as the arbiter |
| Double submit | Same request twice (double click, retry) | Idempotency key with unique constraint; disable the button too, but never rely on it |
| Duplicate job across pods | Two workers pick the same job | `SKIP LOCKED` claim, or unique constraint on `(job_id)` in a results table, or lease with heartbeat |
| Cache stampede | Key expires; 500 requests rebuild at once | Single-flight per key (in-process mutex) plus a distributed lock or early refresh |

#### How it works

**Check-then-act.** "Create the user if the email is not taken."

```ts
// Bug: two signups for the same email both pass the check.
const existing = await this.users.findOneBy({ email });
if (existing) throw new ConflictException('email taken');
await this.users.insert({ email, passwordHash });

// Fix: the unique index is the check. Catch the violation and map it.
try {
  await this.users.insert({ email, passwordHash });
} catch (err) {
  if ((err as { code?: string }).code === '23505') throw new ConflictException('email taken');
  throw err;
}
```

```sql
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
-- Or make it idempotent: INSERT ... ON CONFLICT (lower(email)) DO NOTHING RETURNING id;
-- zero rows returned means "already existed".
```

**Read-modify-write.** Counters, balances, stock, "likes". The fix is the conditional atomic update (21.6). For balances that must never go negative, add a `CHECK (balance >= 0)` constraint as a backstop so that even a buggy code path cannot violate it.

**TOCTOU on files.** Time-of-check to time-of-use. `existsSync` then `writeFileSync` lets another process create the file in between; on shared volumes across pods it is worse.

```ts
import { open, rename, writeFile } from 'node:fs/promises';

// Exclusive create: fails with EEXIST if the file appeared between your check and your write.
const fh = await open(path, 'wx');
try { await fh.writeFile(data); } finally { await fh.close(); }

// Atomic replace: write to a temp file, then rename (rename is atomic on POSIX within a filesystem).
await writeFile(`${path}.tmp-${process.pid}`, data);
await rename(`${path}.tmp-${process.pid}`, path);
```

**Double submit.** The user double-clicks "Place order", or the mobile app retries a timed-out `POST`. Two orders. The fix is the idempotency key (Part 19 — Idempotency and Exactly-Once Semantics): the client generates a key per *intent*, the server stores it with a unique constraint, and the second request replays the first response. UI tricks (disabling the button) reduce the frequency; only the constraint removes the bug.

**Duplicate job execution across pods.** A "send reminder emails" job runs on every worker pod at 09:00, or two BullMQ workers process the same job after a lock expiry, or a Kafka rebalance redelivers a batch. Fixes, in order of strength: make the job handler idempotent (a `sent_reminders(user_id, date)` unique constraint; sending twice fails the second insert *before* the email goes out), claim work with `FOR UPDATE SKIP LOCKED` (21.8), and use a lease with heartbeat for long jobs (21.14).

**Cache stampede.** A popular key (`homepage:deals`) expires. In the next 50 ms, 500 requests miss, and all 500 run the 300 ms database query. The database sees 500 identical heavy queries; the cache is written 500 times. Fixes:

```ts
import { Mutex } from 'async-mutex';

@Injectable()
export class DealsCache {
  private readonly inflight = new Map<string, Promise<Deal[]>>();   // single-flight within this pod

  async get(key: string): Promise<Deal[]> {
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);

    // Coalesce concurrent misses for the same key in this process.
    let p = this.inflight.get(key);
    if (!p) {
      p = this.rebuild(key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async rebuild(key: string): Promise<Deal[]> {
    // Cross-pod: only one pod rebuilds; others serve stale or wait briefly.
    const token = await this.redis.set(`lock:${key}`, process.pid, 'PX', 5_000, 'NX');
    if (token !== 'OK') {
      const stale = await this.redis.get(`${key}:stale`);           // keep a longer-lived stale copy
      if (stale) return JSON.parse(stale);
      await new Promise((r) => setTimeout(r, 100));                  // brief wait then re-check
      return this.get(key);
    }
    const deals = await this.dealsRepo.findActive();
    await this.redis.multi().set(key, JSON.stringify(deals), 'EX', 60)
                            .set(`${key}:stale`, JSON.stringify(deals), 'EX', 600).exec();
    return deals;
  }
}
```

Single-flight in-process (the `Map` of in-flight promises) removes the 500-to-1 amplification within a pod; the Redis `NX` lock removes the 20-pods-to-1 amplification across pods; the stale copy means nobody waits. Note this is one of the legitimate uses of in-memory state in a request path: it protects a *process-local* resource (the right to issue a rebuild query from this process), not a business invariant.

#### Production scenario

A media site's homepage cache expired every 60 s. At 2,000 RPS, each expiry produced a 60–120 ms spike of 100–200 identical queries; the database's p99 doubled every minute like clockwork. With single-flight plus a distributed rebuild lock plus a 10-minute stale copy, the spike disappeared: one query per pod per minute at worst, usually one per cluster.

#### Failure scenario

At 09:00 sharp, 5 worker pods each ran the "daily digest" cron. Each pod queried "users who have not received today's digest", got the same 40,000 users, and started sending. The `sent` flag was written *after* each email. 200,000 emails for 40,000 users. The unsubscribe rate that day was 4%. Fixes: `INSERT INTO digest_sends (user_id, day) ... ON CONFLICT DO NOTHING RETURNING user_id` *before* sending, so only the pod that wins the insert sends; and a leader-elected cron (21.15) so only one pod runs the job at all. Two layers, because belt and braces are cheap compared with 160,000 unwanted emails.

#### Edge cases & failure modes

- **Unique constraint on the wrong columns** (`email` case-sensitive) lets `A@x.com` and `a@x.com` both in.
- **`ON CONFLICT DO NOTHING` hides real errors** if you do not check the returned row count.
- **Single-flight without a timeout** parks every request behind one hung rebuild; wrap the rebuild in a deadline.
- **Stale cache copy served forever** when the rebuild keeps failing; add a max age and an alert (Part 20 — degradation).
- **Idempotency keys scoped too broadly** (the same key reused for a different amount) replay the wrong response; include the operation and a hash of the payload.
- **File TOCTOU on NFS or object storage**: `rename` is not atomic across every filesystem; on S3 use conditional writes (`If-None-Match: *`).

#### How a Senior Backend Engineer thinks about this

They name the shape out loud in review ("this is check-then-act") because naming it makes the fix obvious. They prefer constraints to code: a unique index cannot be bypassed by a future refactor, an `if` can. They reserve in-process coordination for in-process resources. And they layer fixes for the expensive cases (idempotent handler *and* single execution) because the cost of one duplicate can exceed the cost of both layers for a year.

#### Common mistakes

- Checking existence in code instead of enforcing it with a constraint.
- Catching `23505` and retrying the same insert.
- Setting the "done" flag after the side effect instead of claiming before it.
- Fixing a stampede with a longer TTL (it just makes the stampede rarer and the data staler).

#### Interview questions

1. *Name five common race-condition shapes and the standard fix for each.* Expected: the table above.
2. *How do you prevent a cache stampede across 20 pods?* Expected: single-flight per process, distributed rebuild lock, stale-while-revalidate copy, or probabilistic early refresh.
3. *Why is "check in code, then insert" wrong even with a unique index present?* Expected: it is not wrong for correctness once the index exists, but the check is redundant and gives a false sense of safety; the index is the real guard, and the code must handle `23505`.
4. *Your daily job ran on every pod. What are the two layers of fix?* Expected: claim-before-act with a unique constraint, and single-execution via leader election or a scheduler.

#### Practical exercise

Implement `DealsCache` with single-flight and a Redis rebuild lock. Write a test that fires 200 concurrent `get('deals')` calls against an empty cache with a `rebuild` that sleeps 200 ms and counts invocations. Acceptance criteria: `rebuild` runs exactly once per process; with two app instances against one Redis, it runs at most twice; after the first rebuild completes, all 200 calls resolve with identical data within 250 ms.
