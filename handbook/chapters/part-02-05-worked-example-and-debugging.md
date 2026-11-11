## 2.6 Worked example: a resilient price lookup, step by step

### 2.6.1 Building `fetchPrice` from the 2.5 exercise

#### Concept

This section is the full answer to the 2.5 practical exercise. It pulls together almost everything in this Part: `async`/`await`, `try/catch`, retries with backoff, a timeout per attempt, a cached fallback, and `AbortController` to cancel an older call when a newer one arrives. If you can explain every line, you understand asynchronous JavaScript well enough to write real backend code.

#### Practical example

The requirements, restated:

1. Each attempt to call the pricing service may take at most 1 second.
2. Make up to 3 attempts, waiting a little longer between each (backoff).
3. If every attempt fails, use the last known price from a cache.
4. If `fetchPrice` is called again for the same product while an older call is still running, cancel the older one. Only the newest answer counts.

A mock pricing service lets the script run anywhere. It can be `healthy` (80 ms), `slow` (500 ms) or `hung` (a full minute, which to a user is never). Like `fetch`, it gives up the moment its signal aborts.

```ts
type Quote = { productId: string; priceCents: number; source: 'live' | 'cache' };

const lastKnownPrice = new Map<string, number>([['42', 1299]]); // a tiny cache
const inFlight = new Map<string, AbortController>();            // one live call per product
let pricingMode: 'healthy' | 'slow' | 'hung' = 'hung';

// A mock pricing service. Like fetch, it stops when its signal aborts.
function callPricingService(productId: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    // healthy: 80 ms, slow: 500 ms, hung: a full minute (as good as never)
    const delay = pricingMode === 'healthy' ? 80 : pricingMode === 'slow' ? 500 : 60_000;
    const timer = setTimeout(() => resolve(1349), delay);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Now the function itself. Read the three numbered comments first; they match the requirements.

```ts
async function fetchPrice(productId: string): Promise<Quote> {
  // Step 1: cancel any older call for the same product; only the newest one matters.
  inFlight.get(productId)?.abort(new Error('superseded by a newer call'));
  const controller = new AbortController();
  inFlight.set(productId, controller);

  try {
    // Step 2: up to 3 attempts, each limited to 1 second.
    for (let attempt = 1; attempt <= 3; attempt++) {
      controller.signal.throwIfAborted();          // superseded while we slept? stop now
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]);
        const priceCents = await callPricingService(productId, signal);
        lastKnownPrice.set(productId, priceCents);
        return { productId, priceCents, source: 'live' };
      } catch (err) {
        if (controller.signal.aborted) throw err;  // superseded: do not retry
        console.log(`  attempt ${attempt} failed: ${(err as Error).name}`);
        if (attempt < 3) await sleep(100 * 2 ** (attempt - 1)); // backoff: 100 ms, then 200 ms
      }
    }
    // Step 3: every attempt failed; fall back to the last known price.
    const cached = lastKnownPrice.get(productId);
    if (cached === undefined) throw new Error(`no price available for product ${productId}`);
    return { productId, priceCents: cached, source: 'cache' };
  } finally {
    if (inFlight.get(productId) === controller) inFlight.delete(productId);
  }
}
```

Finally, three scenarios that exercise every path (paste them at the bottom of the same file):

```ts
// Scenario 1: the pricing service hangs.
let start = Date.now();
console.log('scenario 1: pricing service hung');
console.log(await fetchPrice('42'), `after ${Date.now() - start} ms`);

// Scenario 2: the pricing service is healthy.
pricingMode = 'healthy';
start = Date.now();
console.log('scenario 2: pricing service healthy');
console.log(await fetchPrice('42'), `after ${Date.now() - start} ms`);

// Scenario 3: a slow call is superseded by a newer call for the same product.
pricingMode = 'slow';
start = Date.now();
console.log('scenario 3: a newer call supersedes an older one');
const older = fetchPrice('42');
await sleep(100);
const newer = fetchPrice('42');
const [olderResult, newerResult] = await Promise.allSettled([older, newer]);
console.log('  older:', olderResult.status === 'rejected' ? olderResult.reason.message : olderResult.value);
console.log('  newer:', newerResult.status === 'fulfilled' ? newerResult.value : newerResult.reason);
console.log(`  after ${Date.now() - start} ms`);
```

```text
scenario 1: pricing service hung
  attempt 1 failed: TimeoutError
  attempt 2 failed: TimeoutError
  attempt 3 failed: TimeoutError
{ productId: '42', priceCents: 1299, source: 'cache' } after 3307 ms
scenario 2: pricing service healthy
{ productId: '42', priceCents: 1349, source: 'live' } after 82 ms
scenario 3: a newer call supersedes an older one
  older: superseded by a newer call
  newer: { productId: '42', priceCents: 1349, source: 'live' }
  after 602 ms
```

#### How it works

Trace scenario 1, the hung service, through the code:

1. No older call exists, so `inFlight.get('42')?.abort(...)` does nothing. (`?.` means "only call this if the left side is not `undefined`".) We create a controller and remember it.
2. Attempt 1. `AbortSignal.any([...])` builds one signal that aborts when **either** our controller aborts **or** 1 second passes. After 1 second the timeout fires and the mock rejects with a `TimeoutError`.
3. The `catch` checks whether we were superseded. We were not, so it logs the failure and sleeps 100 ms.
4. Attempt 2 fails the same way after 1 second; we sleep 200 ms. Attempt 3 fails; there is no sleep after the last attempt.
5. The loop ends. The cache has `1299` for product 42, so we return it, marked `source: 'cache'`.
6. `finally` removes our controller from `inFlight`. Total: 1000 + 100 + 1000 + 200 + 1000 = 3,300 ms, and we measured 3,307 ms. That meets "never longer than about 3 seconds".

Scenario 3, the superseded call:

1. The older call starts and waits on a 500 ms answer.
2. 100 ms later the newer call starts, and its first line aborts the older call's controller with the reason "superseded by a newer call".
3. The older call's mock rejects with that reason. The `catch` sees `controller.signal.aborted` and rethrows instead of retrying; retrying a deliberate cancellation would defeat the point.
4. The older call's `finally` sees that `inFlight` now holds the **newer** controller and leaves it alone. Without that `===` check, the old call would delete the new call's entry.
5. The newer call answers 500 ms after it started, about 600 ms into the scenario.

#### Production scenario

This exact shape protects a real checkout page. When the pricing service (normally about 40 ms) is down, checkout still works with the last known price and the order is flagged for review. When a shopper changes the quantity three times in a second, only the last price request survives. Part 31 — Reliability Engineering takes the same ideas further: deadlines across several calls, retry budgets, and circuit breakers.

#### Edge cases & failure modes

- **Retrying non-retryable errors.** A `404 product not found` will not get better on attempt 2. A real version only retries timeouts, network errors and `5xx` responses.
- **Retrying writes.** Retrying a price read is safe. Retrying "charge the card" is not, unless the call carries an idempotency key (Part 30 — Distributed Transactions).
- **Stale cache.** A week-old fallback price may be wrong. Real systems store the time the price was cached and refuse very old ones.
- **Unref'd timers.** `AbortSignal.timeout` does not keep the process alive by itself. A server keeps itself alive, but a script whose only pending work is such a timeout exits early with a "Detected unsettled top-level await" warning, which is why the mock's "hung" mode uses a real one-minute timer.

#### Practical exercise

Change `fetchPrice` so it only retries on `TimeoutError` and gives up at once on any other error. Then add a `maxAgeMs` option to the cache: a cached price older than 10 minutes must not be used. Acceptance criteria: a mock that rejects with `new Error('product not found')` causes exactly one attempt, and a cached price stored 11 minutes ago is rejected with a clear error.

## 2.7 Async debugging guide: symptom, cause, fix

### 2.7.1 Reading the clues

#### Concept

Asynchronous bugs rarely announce themselves. You see a symptom, such as "the response came back before the data was saved", and work back to the cause. A handful of causes explain almost every beginner async bug; learn their symptoms and you will fix in minutes what used to take an afternoon.

#### How it works

| Symptom you see | Most likely cause | Fix | Where in this Part |
|---|---|---|---|
| A value is `Promise { <pending> }` where you expected data | Missing `await` | `await` the call | 2.3, 2.4 |
| "All done" is logged before the work finishes | `await` inside `forEach`, or a `.then` that does not return | `for...of` or `Promise.all(map(...))`; `return` the inner promise | 2.3, 2.4 |
| A `.then` step receives `undefined` | Arrow function with braces and no `return` | Add `return`, or drop the braces | 2.3 |
| The process exits with an error thrown from your code, but your `try/catch` "should" have caught it | Thrown inside a callback, or a floating promise rejected | Pass errors to the callback; `await` or `.catch` every promise | 2.2, 2.4 |
| The `catch` with a fallback does not run | `return promise` instead of `return await promise` inside `try` | `return await` | 2.4 |
| Every request slows down whenever one heavy request runs | Synchronous CPU work blocking the event loop | Move it to a worker thread or background job; stream big files | 2.1 |
| One slow dependency makes the whole service hang | No timeout on an external call | `AbortSignal.timeout(ms)` or `withTimeout` | 2.5 |
| Duplicate emails or charges after a partial failure | `Promise.all` used for best-effort work, then retried | `Promise.allSettled`; retry only the failures | 2.3 |
| "Too many connections" during a batch job | Unbounded `Promise.all` over a huge list | A concurrency limit (`mapWithLimit`, `p-limit`) | 2.3 |
| Screen shows results for an old search | Out-of-order responses | Cancel superseded calls with `AbortController` | 2.5, 2.6 |
| The callback's success path runs after an error | Missing `return` after `callback(err)` | `return callback(err)` | 2.2 |

#### Practical example

A teammate's endpoint returns `{"order": {}}` instead of the order. Here is the code:

```ts
async findOne(id: string) {
  const order = this.repo.findOne({ where: { id } });
  return { order };
}
```

Use the table. `order` is really a pending promise, and `JSON.stringify` turns a `Promise` into `{}` because it has no plain data properties. The cause is the missing `await` before `this.repo.findOne(...)`; the fix is one word. The lint rule `@typescript-eslint/require-await` flags this `async` function with no `await` in it, and a senior turns such rules on from day one.

#### Try it yourself

Name the cause and the fix for each, using the table.

1. A test prints `saved: 0 rows` and then, a moment later, three `INSERT` log lines.
2. A script logs `TypeError: Cannot read properties of undefined (reading 'email')` inside a callback right after it logged `user lookup failed`.
3. During a flash sale, product pages, login and checkout all slow to 900 ms, and the slowdown matches the times a merchant uploads a 40 MB spreadsheet.

**Answers.**

1. The rows are saved inside a `forEach(async ...)` (or a `.then` that does not return), so the count is read before the inserts finish. Use `for...of` with `await`, or `await Promise.all(rows.map(save))`.
2. The callback logged the error but did not `return`, so it carried on and used the missing `user`. Write `if (err) return console.error(...)`.
3. The spreadsheet is parsed synchronously on the main thread, blocking the event loop for everyone. Parse it in a worker thread (Part 10.20) or a background job (Part 36), and stream it instead of loading 40 MB at once.

## Senior Checklist — Part 2

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
- [ ] I can trace a small async script line by line and predict its output before running it
- [ ] I never do heavy CPU work in a request handler (it blocks everyone)
- [ ] I can spot a missing `return` and a double callback in callback code, and I promisify callback APIs at the edge
- [ ] I know the three rules of `.then` (return a value, return a promise, throw)
- [ ] I know that promise callbacks run before timer callbacks
- [ ] I use async/await by default and know it returns a promise
- [ ] I use Promise.all for independent work and allSettled for best-effort work
- [ ] I put a concurrency limit on large batches against shared resources
- [ ] I never use await inside forEach, and I use `return await` inside try/catch
- [ ] I put a timeout on every call that leaves the process, and I clear my timers
- [ ] I prefer AbortController for real cancellation of abandoned work
- [ ] I never write an empty catch block

## Part 2 — Key Takeaways

- Node runs your JavaScript on one thread and never blocks it on I/O; a long synchronous computation blocks every request.
- `setTimeout(fn, 0)` runs after the current synchronous code, not immediately — "async" means "later when the thread is free", and a timer's delay is a minimum, not a guarantee.
- Predict the output before you run it: tracing what the one thread does, moment by moment, is the fastest way to learn async code.
- Callbacks still work but nest into pyramids and hide control-flow bugs (missing `return`, double calls, uncatchable throws); promises and async/await replaced them.
- A promise is a handle to a future value with three states (pending, fulfilled, rejected); `.then` chains flatten the pyramid and one `.catch` handles the whole chain.
- Inside `.then`, return a value, return a promise, or throw; forgetting to return is the most common chaining bug.
- `Promise.all` for "all must succeed" (and parallel speedup on independent work); `Promise.allSettled` for independent best-effort work; a concurrency limit for big batches.
- Serial `await`s on independent operations are the most common performance bug; group them with `Promise.all`.
- Never use `await` inside `forEach`; use `for...of` (serial) or `Promise.all(map(...))` (parallel), and never leave a promise floating.
- Every external call needs a timeout; a hung dependency with no timeout causes cascading outages.
- Prefer `AbortController` and `AbortSignal.timeout` for real cancellation; a timeout wrapper stops you waiting but the work may keep running.
- Never swallow errors in an empty catch; separate expected failures from unexpected ones and handle each on purpose.
