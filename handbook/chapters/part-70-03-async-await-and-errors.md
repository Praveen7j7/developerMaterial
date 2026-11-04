## 70.4 Async and await

### 70.4.1 Writing asynchronous code that reads like synchronous code

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

Compare this to the `.then` chain in 70.3 and the callback pyramid in 70.2 — same logic, progressively more readable. Three rules:

1. `await` can only be used inside an `async` function (or at the top level of a module in modern Node).
2. An `async` function always returns a promise, even if you `return` a plain value — `return 5` becomes `Promise<number>`.
3. `await` unwraps the promise: `const x = await fetchOrder(id)` gives you the `Order`, not a `Promise<Order>`.

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

#### How a Senior Backend Engineer thinks about this

A senior writes `async`/`await` as the default and uses `Promise.all` the instant two awaited operations are independent. They never use `await` inside `forEach`. They enable the "no floating promises" lint rule so a forgotten `await` is caught at build time rather than becoming a 2 a.m. unhandled rejection. They put `try/catch` where they can actually do something useful with the error (translate it, add context, decide to retry) and let it propagate otherwise, because catching an error only to re-log and rethrow it at every level just produces noise (Part 36).

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

Convert the callback-based config-then-data flow from Part 70.1 into `async`/`await` with a single `try/catch`. Then write a `loadAll(paths: string[])` that reads many files; provide two versions — one serial with `for...of`, one parallel with `Promise.all` — and measure the difference. Acceptance criteria: the parallel version is dramatically faster for many files, and both handle a missing file with a clear error.

## 70.5 Error handling and pitfalls in asynchronous code

### 70.5.1 Errors, timeouts and cancellation

#### Concept

Asynchronous code fails in ways synchronous code does not: the thing you are waiting for can be slow, can hang forever, can fail, or can succeed after you have given up. Robust asynchronous code plans for all of these. The three tools are: proper error propagation (`try/catch` around awaits), timeouts (never wait forever on the network), and cancellation (`AbortController`) to stop work you no longer need.

#### Why does it exist?

Without a timeout, one hung downstream service makes every request to your endpoint hang too, until your own connection pool and thread capacity are exhausted and your whole service goes down — a cascading failure. Without cancellation, when a user navigates away or a request times out, you keep doing expensive work for a result nobody will read. These are not edge cases; they are how real outages spread.

#### How it works

**Timeout on any promise** using `Promise.race` or, in modern Node, `AbortSignal.timeout`:

```ts
// Generic timeout wrapper.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timeout]);
}

const order = await withTimeout(fetchOrder(id), 2000); // fail if it takes > 2s
```

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
} finally {
  clearTimeout(timer);              // always clean up the timer
}
```

The difference between the two: a timeout wrapper makes **your code** stop waiting, but the underlying work may keep running and finish later (wasting resources). `AbortController` actually **cancels** the underlying work (closes the socket, stops the fetch). Prefer real cancellation where the API supports it.

#### The result-type alternative to throwing

For expected failures (a payment declined, a validation error), some teams return a discriminated union (a `Result` type, Part 69) instead of throwing, reserving exceptions for truly exceptional situations. Both approaches are valid; the key is consistency.

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

Putting it together: call a flaky service with a per-attempt timeout and exponential backoff between attempts. This is the shape of nearly every resilient external call (Part 38 goes deeper).

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

A checkout endpoint calls a pricing service. One afternoon the pricing service deployed a bad build and started hanging — accepting connections but never responding. The checkout code had no timeout, so every checkout request hung too. Within four minutes, all of checkout's threads and database connections were tied up waiting, and checkout went fully down even though its own code and database were healthy. The post-incident fix was a 1.5-second timeout on the pricing call with a sensible fallback (use the last cached price and flag the order for review). After the fix, a pricing outage degrades one feature for 1.5 seconds per request instead of taking down checkout entirely.

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

## Senior Checklist — Part 70

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can explain why one thread can serve thousands of concurrent requests
- [ ] I never do heavy CPU work in a request handler (it blocks everyone)
- [ ] I use async/await by default and know it returns a promise
- [ ] I use Promise.all for independent work and allSettled for best-effort work
- [ ] I never use await inside forEach
- [ ] I put a timeout on every call that leaves the process
- [ ] I prefer AbortController for real cancellation of abandoned work
- [ ] I never write an empty catch block

## Part 70 — Key Takeaways

- Node runs your JavaScript on one thread and never blocks it on I/O; a long synchronous computation blocks every request.
- `setTimeout(fn, 0)` runs after the current synchronous code, not immediately — "async" means "later when the thread is free".
- Callbacks still work but nest into pyramids and hide control-flow bugs; promises and async/await replaced them.
- A promise is a handle to a future value with three states (pending, fulfilled, rejected); `.then` chains flatten the pyramid and one `.catch` handles the whole chain.
- `Promise.all` for "all must succeed" (and parallel speedup on independent work); `Promise.allSettled` for independent best-effort work.
- Serial `await`s on independent operations are the most common performance bug; group them with `Promise.all`.
- Never use `await` inside `forEach`; use `for...of` (serial) or `Promise.all(map(...))` (parallel), and bound concurrency for large batches.
- Every external call needs a timeout; a hung dependency with no timeout causes cascading outages.
- Prefer `AbortController` for real cancellation; a timeout wrapper stops you waiting but the work may keep running.
- Never swallow errors in an empty catch; separate expected failures from unexpected ones and handle each on purpose.
