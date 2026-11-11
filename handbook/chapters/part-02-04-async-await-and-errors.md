## 2.4 Async and await

### 2.4.1 Writing asynchronous code that reads like synchronous code

#### Concept

`async`/`await` is syntax built on top of promises. An `async` function always returns a promise. Inside it, `await` pauses the function until a promise settles, then gives you the value — or throws if it rejected. The result is asynchronous code that reads top to bottom like ordinary synchronous code, with normal `try/catch` for errors.

#### Why does it exist?

Even with promises, `.then` chains get awkward for anything with conditionals, loops or several intermediate values. `async`/`await` lets you write the same logic as plain-looking sequential code. It is not a new mechanism — under the hood it is still promises and the event loop — it is a much more readable way to write them. Today it is the default for all asynchronous backend code; `.then`/`.catch` is reserved for a few specific spots.

#### Mental model

`await` is a bookmark. When your function hits `await someSlowThing()`, it places a bookmark, steps away so the one thread can serve other work, and comes back to exactly that line when the result is ready — picking up with the value in hand. The function appears to "wait", but the thread does not; only this particular function is paused, bookmarked, while everyone else carries on.

#### How it works

```ts
// The same order flow from the promises section, now with async/await.
async function processOrder(orderId: string): Promise<void> {
  const order = await fetchOrder(orderId);          // pause until order arrives
  const customer = await fetchCustomer(order.customerId); // then until customer
  await sendReceipt(customer.email);                // then until receipt sent
  console.log('done');
}
```

Compare this to the `.then` chain in 2.3 and the callback pyramid in 2.2 — same logic, progressively more readable. Three rules:

1. `await` can only be used inside an `async` function (or at the top level of a module in modern Node).
2. An `async` function always returns a promise, even if you `return` a plain value — `return 5` becomes `Promise<number>`.
3. `await` unwraps the promise: `const x = await fetchOrder(id)` gives you the `Order`, not a `Promise<Order>`.

#### Step-by-step trace: what `await` really pauses

The phrase "`await` pauses" confuses beginners, because it sounds like the whole program stops. It does not. Run this:

```ts
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleRequest(name: string, queryMs: number): Promise<string> {
  console.log(`${name}: start, sending query`);
  await wait(queryMs);                       // bookmark: this function pauses here
  console.log(`${name}: query done after ${queryMs} ms`);
  return `${name} response`;
}

const first = handleRequest('req 1', 30);    // runs until its first await, then returns a promise
const second = handleRequest('req 2', 10);
console.log('both handlers started; the thread is free');

console.log(await first, '|', await second);
```

```text
req 1: start, sending query
req 2: start, sending query
both handlers started; the thread is free
req 2: query done after 10 ms
req 1: query done after 30 ms
req 1 response | req 2 response
```

Trace it line by line:

1. `handleRequest('req 1', 30)` starts running **synchronously**. It prints its first line, reaches `await`, and pauses. At that moment the call returns a pending promise, which we store in `first`.
2. `handleRequest('req 2', 10)` does the same: prints, pauses, returns a promise.
3. The top-level code carries on and prints `both handlers started`. Two functions are paused, and the thread is free.
4. At 10 ms request 2's wait finishes. Request 2 resumes from its bookmark, prints `query done`, and returns. Its promise fulfils.
5. At 30 ms request 1 resumes the same way.
6. The final line was waiting on both promises, so it prints last.

This is exactly how a NestJS server handles two requests at once: each handler is an `async` function, each `await` on a query is a bookmark, and the one thread hops between whichever handler has work ready.

#### Error handling with try/catch

The big win: asynchronous errors are caught by ordinary `try/catch`, which callbacks could not do.

```ts
async function processOrder(orderId: string): Promise<void> {
  try {
    const order = await fetchOrder(orderId);
    const customer = await fetchCustomer(order.customerId);
    await sendReceipt(customer.email);
  } catch (err) {
    // Catches a rejection from ANY of the awaited calls above.
    console.error('order processing failed:', (err as Error).message);
    throw err;                      // rethrow if the caller must know
  }
}
```

One `try/catch` covers every `await` inside it, just as one `.catch` covered the whole chain. In TypeScript the caught value is typed `unknown` (since anything can be thrown), so you narrow it with `err instanceof Error` before reading `.message`.

#### Parallelism with async/await

`await` is sequential by default — each one waits for the previous. For independent work, combine `await` with `Promise.all`, exactly as before.

```ts
async function getDashboard(userId: string) {
  // WRONG for independent work: three sequential waits.
  // const user = await fetchUser(userId);
  // const orders = await fetchOrders(userId);
  // const recs = await fetchRecommendations(userId);

  // RIGHT: start all three, then await them together.
  const [user, orders, recs] = await Promise.all([
    fetchUser(userId),
    fetchOrders(userId),
    fetchRecommendations(userId),
  ]);
  return { user, orders, recs };
}
```

Writing `await` three times in a row is the most common beginner performance mistake. `await` does not mean "do these in parallel" — it means "wait here". Independent work needs `Promise.all`.

#### Practical example — NestJS service method

Every NestJS service method you write will look like this: an `async` method that awaits a repository and handles errors.

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrdersService {
  constructor(@InjectRepository(Order) private readonly repo: Repository<Order>) {}

  async findOne(id: string): Promise<Order> {
    const order = await this.repo.findOne({ where: { id } });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  async summary(userId: string) {
    // Independent queries run together.
    const [open, completed] = await Promise.all([
      this.repo.count({ where: { userId, status: 'pending' } }),
      this.repo.count({ where: { userId, status: 'delivered' } }),
    ]);
    return { open, completed };
  }
}
```

#### Edge cases & failure modes

- **Serial `await` for independent work** (the main performance trap).
- **`await` inside `Array.forEach`** does not work — `forEach` ignores the returned promise, so the loop does not wait. Use a `for...of` loop (serial) or `Promise.all(map(...))` (parallel).
- **Forgetting `await`** on a promise-returning call means the function continues before the work finishes, and any error becomes an unhandled rejection. TypeScript with the right lint rule flags "floating promises".
- **Awaiting in a loop** over a large array runs serially and can be very slow; parallelize with a concurrency limit if the work is independent.
- **A missing `return await`** inside `try/catch`: if you write `return somePromise()` instead of `return await somePromise()`, a rejection escapes the `try/catch` because the function has already returned. Use `return await` when you want the `catch` to handle it.

#### Seeing three traps

**Trap 1: `await` inside `forEach`.** An order has three lines to save.

```ts
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveLine(sku: string): Promise<void> {
  await wait(10);
  console.log(`  saved ${sku}`);
}

const skus = ['mirror-01', 'probe-02', 'gloves-10'];

console.log('forEach version:');
skus.forEach(async (sku) => {
  await saveLine(sku);
});
console.log('  "all lines saved" (a lie: nothing is saved yet)');

await wait(50); // let the forEach work finish before the next demo

console.log('for...of version:');
for (const sku of skus) {
  await saveLine(sku);
}
console.log('  all lines saved (true this time)');
```

```text
forEach version:
  "all lines saved" (a lie: nothing is saved yet)
  saved mirror-01
  saved probe-02
  saved gloves-10
for...of version:
  saved mirror-01
  saved probe-02
  saved gloves-10
  all lines saved (true this time)
```

`forEach` calls your `async` callback three times and throws away the three promises it gets back. It cannot wait for something it ignores. So the "all saved" line runs first, and in a real handler the HTTP response would go out before the rows were written. If one save failed, nothing would catch it.

**Trap 2: `return` without `await` inside `try`.**

```ts
async function chargeCard(): Promise<string> {
  throw new Error('card declined');
}

async function withoutAwait(): Promise<string> {
  try {
    return chargeCard();               // returns the promise; the try block is already over
  } catch {
    return 'fallback: ask for another card';
  }
}

async function withAwait(): Promise<string> {
  try {
    return await chargeCard();         // waits here, so a rejection lands in the catch
  } catch {
    return 'fallback: ask for another card';
  }
}

console.log('with await   ->', await withAwait());
try {
  console.log('without await ->', await withoutAwait());
} catch (err) {
  console.log('without await -> escaped the catch:', (err as Error).message);
}
```

```text
with await   -> fallback: ask for another card
without await -> escaped the catch: card declined
```

Without `await`, the function hands back the promise and leaves the `try` block before the promise rejects. The rejection then travels to the caller, skipping your fallback.

**Trap 3: a floating promise.** The order is placed, and an audit log write is "fired and forgotten".

```ts
async function writeAuditLog(orderId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new Error(`audit table is full, could not log ${orderId}`);
}

async function placeOrder(orderId: string): Promise<string> {
  writeAuditLog(orderId);              // BUG: floating promise, nobody awaits it
  return `order ${orderId} placed`;
}

try {
  console.log(await placeOrder('ord_1001'));
} catch (err) {
  console.log('caught:', (err as Error).message); // never runs
}
console.log('request finished');
```

```text
order ord_1001 placed
request finished
file:///.../floating.ts:3
  throw new Error(`audit table is full, could not log ${orderId}`);
        ^

Error: audit table is full, could not log ord_1001
```

The request "succeeded", the `try/catch` caught nothing, and 10 ms later the rejected promise had no handler, so Node treated it as an **unhandled rejection** and stopped the process, killing every other in-flight request too. The fix is `await writeAuditLog(orderId)`, or, for deliberate background work, `writeAuditLog(orderId).catch((err) => logger.error(err))`. The `@typescript-eslint/no-floating-promises` lint rule catches this at build time.

#### How a Senior Backend Engineer thinks about this

A senior writes `async`/`await` as the default and uses `Promise.all` the instant two awaited operations are independent. They never use `await` inside `forEach`. They enable the "no floating promises" lint rule so a forgotten `await` is caught at build time rather than becoming a 2 a.m. unhandled rejection. They put `try/catch` where they can actually do something useful with the error (translate it, add context, decide to retry) and let it propagate otherwise, because catching an error only to re-log and rethrow it at every level just produces noise (Part 47 — Observability covers logging that helps).

#### Common mistakes

- Serial awaits for independent work.
- `await` inside `forEach` (silently does nothing useful).
- Forgetting `await`, creating a floating promise and an unhandled rejection.
- Wrapping everything in `try/catch` and swallowing errors instead of handling or propagating them.

#### Interview questions

1. **What does an `async` function return?** Always a promise, even if the body returns a plain value.
2. **Why does `await` inside `forEach` not work?** `forEach` ignores the promise returned by its callback, so it does not wait; use `for...of` or `Promise.all(map(...))`.
3. **How do you run two independent awaited calls concurrently?** `const [a, b] = await Promise.all([callA(), callB()])`.
4. **What is a floating promise and why is it dangerous?** A promise-returning call with no `await` and no `.catch`; its errors become unhandled rejections and its completion is not awaited, causing race conditions and crashes.

#### Practical exercise

Convert the callback-based config-then-data flow from 2.2 into `async`/`await` with a single `try/catch`. Then write a `loadAll(paths: string[])` that reads many files; provide two versions — one serial with `for...of`, one parallel with `Promise.all` — and measure the difference. Acceptance criteria: the parallel version is dramatically faster for many files, and both handle a missing file with a clear error.

#### Worked answer to the exercise

First, the config-then-data flow from 2.2, now with `node:fs/promises` and one `try/catch`:

```ts
import { readFile } from 'node:fs/promises';

async function loadData(configPath: string): Promise<unknown> {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const data = JSON.parse(await readFile(config.dataPath, 'utf8'));
    return data;
  } catch (err) {
    throw new Error(`could not load data via ${configPath}: ${(err as Error).message}`);
  }
}

console.log(await loadData('config.json'));
try {
  await loadData('missing-config.json');
} catch (err) {
  console.log((err as Error).message);
}
```

```text
{ orders: 3 }
could not load data via missing-config.json: ENOENT: no such file or directory, open 'missing-config.json'
```

(To run it, create `config.json` containing `{"dataPath":"data.json"}` and `data.json` containing `{"orders":3}`.) Compare it with the callback version: no nesting, one place for errors, and the error message now says which step failed. That is the "add context" kind of catch a senior writes.

Second, `loadAll`, run against 500 small invoice files:

```ts
import { readFile } from 'node:fs/promises';

async function loadAllSerial(paths: string[]): Promise<string[]> {
  const contents: string[] = [];
  for (const path of paths) {
    contents.push(await readFile(path, 'utf8'));     // one file at a time
  }
  return contents;
}

async function loadAllParallel(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map((path) => readFile(path, 'utf8'))); // all at once
}

const paths = Array.from({ length: 500 }, (_, i) => `invoices/inv_${i + 1}.json`);

let start = performance.now();
await loadAllSerial(paths);
console.log(`serial:   ${(performance.now() - start).toFixed(1)} ms for ${paths.length} files`);

start = performance.now();
await loadAllParallel(paths);
console.log(`parallel: ${(performance.now() - start).toFixed(1)} ms for ${paths.length} files`);

try {
  await loadAllParallel([...paths.slice(0, 3), 'invoices/inv_9999.json']);
} catch (err) {
  console.log('missing file:', (err as Error).message);
}
```

```text
serial:   10.9 ms for 500 files
parallel: 3.3 ms for 500 files
missing file: ENOENT: no such file or directory, open 'invoices/inv_9999.json'
```

On a laptop SSD the parallel version was about 3 to 4 times faster, not 500 times: local reads are quick, and Node reads files with a small pool of 4 helper threads (Part 13.18), so only a few truly overlap. With network calls of 30 to 100 ms each, the gap is far bigger. And remember 2.3: `Promise.all` over a huge list against a shared service needs a concurrency limit.

## 2.5 Error handling and pitfalls in asynchronous code

### 2.5.1 Errors, timeouts and cancellation

#### Concept

Asynchronous code fails in ways synchronous code does not: the thing you are waiting for can be slow, can hang forever, can fail, or can succeed after you have given up. Robust asynchronous code plans for all of these. The three tools are: proper error propagation (`try/catch` around awaits), timeouts (never wait forever on the network), and cancellation (`AbortController`) to stop work you no longer need.

#### Why does it exist?

Without a timeout, one hung downstream service makes every request to your endpoint hang too, until your own connection pool and thread capacity are exhausted and your whole service goes down — a cascading failure. Without cancellation, when a user navigates away or a request times out, you keep doing expensive work for a result nobody will read. These are not edge cases; they are how real outages spread.

#### How it works

**Timeout on any promise** using `Promise.race` or, in modern Node, `AbortSignal.timeout`:

```ts
// Generic timeout wrapper.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  // Whichever settles first wins; either way, clear the timer so it does not linger.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const order = await withTimeout(fetchOrder(id), 2000); // fail if it takes > 2s
```

Here it is running, with `wait(ms)` standing in for slow work:

```ts
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const start = Date.now();
console.log(await withTimeout(wait(50).then(() => 'price: 1299'), 2000));
try {
  await withTimeout(wait(5000).then(() => 'too late'), 100);
} catch (err) {
  console.log((err as Error).message);
}
console.log(`script done after ${Date.now() - start} ms`);
```

```text
price: 1299
timed out after 100ms
script done after 153 ms
```

The first call finished in 50 ms; the second gave up after 100 ms, as asked. But the script does not exit until about 5 seconds have passed: the 5-second "work" is still running, because `withTimeout` only stopped **us** from waiting. Keep that in mind for the next paragraph.

**Cancellation with `AbortController`**, the standard way to cancel `fetch` and many Node APIs:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 2000); // cancel after 2s

try {
  const res = await fetch('https://pricing.internal/quote', {
    signal: controller.signal,      // fetch stops if aborted
  });
  const data = await res.json();
} catch (err) {
  if ((err as Error).name === 'AbortError') console.error('request cancelled');
  else throw err;                   // never silently swallow other failures
} finally {
  clearTimeout(timer);              // always clean up the timer
}
```

The difference between the two: a timeout wrapper makes **your code** stop waiting, but the underlying work may keep running and finish later (wasting resources). `AbortController` actually **cancels** the underlying work (closes the socket, stops the fetch). Prefer real cancellation where the API supports it.

#### A real timeout against a hung server

You can watch real cancellation work on your own machine. The script below starts a tiny HTTP server that accepts requests and never answers, which is exactly what the hung pricing service in the production scenario did. Then it calls it with `AbortSignal.timeout(500)`, the one-line shortcut for "an `AbortController` that aborts itself after 500 ms".

```ts
import { createServer } from 'node:http';

// A pretend pricing service that accepts the request and never answers (a "hung" dependency).
const hungServer = createServer(() => {
  /* never call res.end() */
});
await new Promise<void>((resolve) => hungServer.listen(4010, resolve));

const start = Date.now();
try {
  const res = await fetch('http://localhost:4010/quote?productId=42', {
    signal: AbortSignal.timeout(500),   // give up AND cancel the request after 500 ms
  });
  console.log('price:', await res.json());
} catch (err) {
  const e = err as Error;
  console.log(`gave up after ${Date.now() - start} ms: ${e.name}: ${e.message}`);
} finally {
  hungServer.closeAllConnections();
  hungServer.close();
}
```

```text
gave up after 507 ms: TimeoutError: The operation was aborted due to timeout
```

Notice the error's `name`. When you call `controller.abort()` yourself, `fetch` rejects with an error named `AbortError`. When `AbortSignal.timeout` fires, the name is `TimeoutError`. If your code checks `err.name === 'AbortError'` only, it will miss timeouts, which is a common beginner bug. Check for both, or check `signal.aborted`.

#### Why the timer in `withTimeout` must be cleared

Many tutorials show a shorter `withTimeout` without the `.finally(() => clearTimeout(timer))`. It still returns the right answer, but the timer stays alive after the race is won: a script that got its answer in 1 ms cannot exit until the 2-second timer fires, and a server handling 1,000 requests per second with a 2-second timeout carries about 2,000 useless timers at any moment. Always clean up the timer, whichever side wins.

#### The result-type alternative to throwing

For expected failures (a payment declined, a validation error), some teams return a discriminated union (a `Result` type, Part 1.7.2) instead of throwing, reserving exceptions for truly exceptional situations. Both approaches are valid; the key is consistency.

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function charge(amountCents: number): Promise<Result<string>> {
  try {
    const chargeId = await provider.charge(amountCents);
    return { ok: true, value: chargeId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
```

#### Practical example — retry with backoff and timeout

Putting it together: call a flaky service with a per-attempt timeout and exponential backoff between attempts. This is the shape of nearly every resilient external call (Part 34 — Reliability Engineering goes deeper, especially 34.2 to 34.4).

```ts
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callWithRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  perAttemptMs = 2000,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn(), perAttemptMs);
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        // exponential backoff with jitter: 200ms, 400ms, 800ms (plus randomness)
        await sleep(200 * 2 ** i + Math.random() * 100);
      }
    }
  }
  throw lastError;
}
```

#### Production scenario

A checkout endpoint calls a pricing service. One afternoon the pricing service deployed a bad build and started hanging — accepting connections but never responding. The checkout code had no timeout, so every checkout request hung too. Within four minutes, thousands of checkout requests were stuck waiting, holding their sockets, memory and database connections, and checkout went fully down even though its own code and database were healthy. The post-incident fix was a 1.5-second timeout on the pricing call with a sensible fallback (use the last cached price and flag the order for review). After the fix, a pricing outage degrades one feature for 1.5 seconds per request instead of taking down checkout entirely.

#### Failure scenario

A search endpoint fired a database query on every keystroke. Users typing fast generated bursts of requests; the late ones returned after the early ones, so results flickered and sometimes showed stale matches for a query the user had already changed. The fix was an `AbortController` per request: when a new keystroke arrived, the previous in-flight query was aborted, so only the latest query's results ever rendered. Cancellation is not only about saving resources; it is sometimes about correctness.

#### Edge cases & failure modes

- **No timeout** on an external call; one hung dependency cascades into your whole service going down.
- **Timeout without cancellation**, so the underlying work keeps running and you waste resources even after giving up.
- **Swallowing errors** (an empty `catch`), hiding failures until they cause a bigger, more confusing problem later.
- **Catching and rethrowing the same error at every level**, producing noise with no added context.
- **Not cleaning up** timers or listeners in a `finally`, leaking them.
- **Race conditions from out-of-order responses** (the search flicker) when a later-but-stale response overwrites a newer one.

#### How a Senior Backend Engineer thinks about this

A senior puts a timeout on every call that leaves the process, full stop — the network is never trusted to respond. They prefer real cancellation (`AbortController`) over bare timeouts so abandoned work actually stops. They distinguish **expected** failures (declined payment, not found) from **unexpected** ones (database down) and handle each appropriately — expected failures become clean responses, unexpected ones are logged with context and surfaced as 5xx. They never write an empty `catch`; an error that is truly safe to ignore gets a comment saying why. And they think about out-of-order responses whenever a client can issue overlapping requests.

#### Common mistakes

- No timeout on network calls; the classic cause of cascading outages.
- Empty `catch` blocks that swallow errors silently.
- Treating all errors the same instead of separating expected from unexpected.
- Not cancelling superseded requests, causing flicker or wasted work.
- Forgetting `clearTimeout`/cleanup in `finally`.

#### Interview questions

1. **Why must every external call have a timeout?** A hung dependency with no timeout makes your requests hang too, exhausting threads and connections until your service goes down — a cascading failure.
2. **What is the difference between a timeout wrapper and `AbortController`?** A timeout wrapper stops your code from waiting but the underlying work may keep running; `AbortController` actually cancels the underlying operation.
3. **When would you return a `Result` type instead of throwing?** For expected, routine failures (declined payment, validation error) where throwing is heavy-handed; reserve exceptions for exceptional situations. Consistency across the codebase matters most.
4. **What is wrong with an empty `catch` block?** It swallows the error silently, hiding the failure until it causes a larger, harder-to-diagnose problem later.
5. **How do out-of-order async responses cause bugs, and how do you fix them?** A slower earlier request can resolve after a newer one and overwrite fresh data; cancel superseded requests with `AbortController` or ignore stale responses by sequence number.

#### Practical exercise

Build a resilient `fetchPrice(productId)` that calls a mock pricing function with a 1-second per-attempt timeout, up to 3 attempts with exponential backoff, and falls back to a cached price if all attempts fail. Then add an `AbortController` so that calling `fetchPrice` again for the same product cancels the previous in-flight call. Acceptance criteria: a hung pricing function never blocks the caller longer than ~3 seconds total, and only the latest call's result is used.

A complete, runnable answer is worked through step by step in 2.6.
