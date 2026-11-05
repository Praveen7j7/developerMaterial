## 2.2 Callbacks

### 2.2.1 The callback pattern

#### Concept

A callback is a function you give to another function to be called **later**, when some work finishes. "Here is my phone number; call me back when the result is ready." Callbacks were the original way JavaScript handled asynchronous results, and they still appear in older Node APIs and some libraries.

#### Why does it exist?

Because the result is not ready yet. A function that reads a file cannot `return` the file contents immediately — the file takes time to read. So instead it says "give me a function, and I will call it with the contents once I have them." The callback is how the slow function delivers its result after the wait.

#### Mental model

You order a coffee and the barista takes your name. You do not stand frozen at the counter staring at the machine (that would be blocking). You sit down and do other things. When the coffee is ready, the barista calls your name (the callback) and you come get it. Your name is the callback; the barista calling it is the asynchronous completion.

#### How it works

Node's traditional callbacks follow the **error-first** convention: the callback's first argument is an error (or `null` if all went well), and the second is the result. This convention is everywhere in older Node code.

```ts
import { readFile } from 'node:fs';

// readFile is asynchronous: it returns immediately and calls the callback later.
readFile('order.json', 'utf8', (err, data) => {
  if (err) {
    console.error('failed to read file:', err.message);
    return;                          // must return so we do not use data
  }
  console.log('file contents:', data);
});

console.log('this prints BEFORE the file contents');
```

The `console.log` at the bottom runs first, because `readFile` returns immediately and the callback runs later when the file has been read. Checking `err` first, and returning on error, is mandatory — forgetting it leads to using an `undefined` result.

#### A callback example you can run without any files

The `readFile` example needs a real file on disk. This one fakes a database lookup with a timer, so you can run it anywhere. It follows the same error-first convention that Node's own APIs use.

```ts
type User = { id: string; email: string };
type Callback<T> = (err: Error | null, result?: T) => void;

const users: Record<string, User> = { usr_7: { id: 'usr_7', email: 'alice@example.com' } };

// A pretend database call: answers after 50 ms, error-first.
function findUser(id: string, callback: Callback<User>): void {
  setTimeout(() => {
    const user = users[id];
    if (!user) {
      callback(new Error(`user ${id} not found`));
      return;
    }
    callback(null, user);
  }, 50);
}

findUser('usr_7', (err, user) => {
  if (err) return console.error('lookup 1 failed:', err.message);
  console.log('lookup 1 found:', user!.email);
});

findUser('usr_404', (err, user) => {
  if (err) return console.error('lookup 2 failed:', err.message);
  console.log('lookup 2 found:', user!.email);
});

console.log('both lookups started');
```

```text
both lookups started
lookup 1 found: alice@example.com
lookup 2 failed: user usr_404 not found
```

Read it as a story. Both lookups start straight away and return immediately. The last line prints first. About 50 ms later both timers are due; each callback runs once, checks `err` first, and either uses the result or reports the error. Notice the `!` in `user!.email`: TypeScript cannot know that `user` is set when `err` is `null`, so we tell it. That small awkwardness is one more reason the promise style, where success and failure take different paths, is nicer.

#### Practical example

Chaining two dependent asynchronous steps with callbacks: read a config file, then read the file it points to.

```ts
import { readFile } from 'node:fs';

readFile('config.json', 'utf8', (err, configRaw) => {
  if (err) return console.error('config read failed:', err.message);

  const config = JSON.parse(configRaw);
  readFile(config.dataPath, 'utf8', (err2, data) => {
    if (err2) return console.error('data read failed:', err2.message);
    console.log('data:', data);
  });
});
```

Notice the nesting. Each dependent step goes one level deeper. With two steps it is fine. With six, it becomes the problem described next.

#### Failure scenario (callback hell)

A real order-processing flow had seven dependent asynchronous steps: validate, check inventory, reserve stock, charge card, create shipment, send email, write audit log. Written with callbacks, it became a pyramid eight levels deep, with error handling duplicated at every level and a growing rightward drift that engineers nicknamed "the christmas tree". A bug in the refund path went unnoticed for weeks because the error handling at level six silently swallowed it — a `return` was missing, so after logging the error the code fell through and continued as if nothing was wrong, charging the card after inventory had failed. The deep nesting hid the control-flow bug. Promises and `async`/`await` were invented largely to make this class of bug visible and rare.

```text
doA(function (err, a) {
  if (err) ...
  doB(a, function (err, b) {
    if (err) ...
    doC(b, function (err, c) {
      if (err) ...
        doD(c, function (err, d) {    // the pyramid keeps growing right
          ...
        });
    });
  });
});
```

#### Edge cases & failure modes

- **Forgetting `return` after handling an error**, so the code continues with a bad or `undefined` result (the refund bug above).
- **Calling the callback twice** (for example in both a success and an error path), causing downstream logic to run twice — a real source of double-charges.
- **Errors thrown inside a callback** are not caught by a `try/catch` around the function that scheduled it, because the callback runs later, on a different turn of the event loop. This is a major reason promises are better.
- **Unhandled errors** in a callback with no error handling crash the process.

#### Seeing the two classic bugs

Reading about a bug is not the same as seeing it. Run these two scripts.

**Bug 1: `try/catch` cannot catch an error thrown inside a callback.**

```ts
function chargeCard(amountCents: number, callback: (err: Error | null, chargeId?: string) => void) {
  setTimeout(() => {
    if (amountCents <= 0) throw new Error('invalid amount'); // thrown LATER, inside the timer
    callback(null, 'ch_1001');
  }, 10);
}

try {
  chargeCard(-500, () => {});
} catch (err) {
  console.log('caught:', (err as Error).message); // never runs
}
console.log('try/catch block finished');
```

```text
try/catch block finished
file:///.../trycatch.ts:3
    if (amountCents <= 0) throw new Error('invalid amount'); // thrown LATER, inside the timer
                          ^

Error: invalid amount
    at Timeout._onTimeout (file:///.../trycatch.ts:3:33)
    at listOnTimeout (node:internal/timers:685:17)
    at process.processTimers (node:internal/timers:618:7)
```

Step by step: `chargeCard` registers a timer and returns at once. Nothing has gone wrong yet, so the `catch` has nothing to catch, and the `try/catch` block finishes. Ten milliseconds later the timer callback runs and throws. By then the `try` is long gone; there is no handler anywhere on the stack, so Node prints the error and **the whole process exits**. In a server that means every user's request dies, not just this one. The fix is to never `throw` inside a callback; pass the error to the callback instead (`callback(new Error('invalid amount'))`).

**Bug 2: a missing `return` calls the callback twice.**

```ts
function reserveStock(
  sku: string,
  qty: number,
  callback: (err: Error | null, reservation?: { sku: string; qty: number }) => void,
) {
  setTimeout(() => {
    if (qty > 5) callback(new Error(`only 5 of ${sku} left`)); // BUG: no return
    callback(null, { sku, qty });
  }, 10);
}

reserveStock('mirror-01', 8, (err, reservation) => {
  if (err) return console.log('reservation failed:', err.message);
  console.log('reservation ok, charging card for', reservation!.qty, 'items');
});
```

```text
reservation failed: only 5 of mirror-01 left
reservation ok, charging card for 8 items
```

The caller was told "failed" and then, a moment later, "ok". If the success path charges a card, the customer is charged for stock that does not exist. This is the refund bug from the failure story above, in eleven lines. The fix is one word: `return callback(new Error(...))`.

#### How a Senior Backend Engineer thinks about this

A senior reads callback-based code carefully for the two classic bugs — missing `return` after an error, and double invocation — because both are invisible in deeply nested code and both cause money bugs (double charges, continuing after a failed step). In new code they never write raw callbacks for multi-step flows; they promisify the callback API (`util.promisify`, or use the `fs/promises` version) and use `async`/`await`. Callbacks remain fine for genuine event streams (an event emitter firing many times), which promises do not model well.

#### Common mistakes

- Deeply nested callbacks ("callback hell") that hide control-flow bugs.
- Missing `return` after an error check.
- Mixing `try/catch` with callbacks and wondering why errors are not caught.
- Calling a callback more than once.

#### Interview questions

1. **What is the error-first callback convention?** The callback's first argument is an error (or `null`), the second is the result; you must check the error before using the result.
2. **Why does `try/catch` not catch errors thrown inside an asynchronous callback?** The callback runs on a later turn of the event loop, after the `try/catch` has already finished; the error has no surrounding `try` at that point.
3. **What is callback hell and what replaced it?** Deeply nested callbacks for dependent async steps; promises and `async`/`await` replaced it with flat, readable, properly-catchable code.

#### Practical exercise

Take a three-level nested callback flow (read file, parse, write a derived file) and identify where a missing `return` after an error check would cause the next step to run with bad data. Then note which line a double callback invocation would break. Acceptance criteria: you can point to the exact failure for each bug without running the code.

#### Worked answer to the exercise

Here is the three-level flow, with the two dangerous spots marked.

```ts
import { readFile, writeFile } from 'node:fs';

readFile('orders.json', 'utf8', (err, raw) => {
  if (err) console.error('read failed:', err.message);  // (1) BUG: no return

  const orders = JSON.parse(raw);                         // runs even after a failed read
  const totalCents = orders.reduce((sum: number, o: { totalCents: number }) => sum + o.totalCents, 0);

  writeFile('daily-total.json', JSON.stringify({ totalCents }), (err2) => {
    if (err2) return console.error('write failed:', err2.message);
    console.log('daily total written');                  // (2) a double call would print this twice
  });
});
```

1. **Missing `return`.** If `orders.json` does not exist, the error is logged, but the code carries on. `raw` is `undefined`, so `JSON.parse(raw)` throws a `SyntaxError` inside the callback, and, as you just saw, an error thrown in a callback crashes the process. Worse versions of this bug do not crash: they quietly write a wrong file. The fix is `if (err) return console.error(...)`.
2. **Double invocation.** If `writeFile` (or any function you wrote in its place) called its callback twice, the "daily total written" step would run twice. Here that is a duplicate log line. If that step sent the finance team an email or charged a card, it would be a duplicate email or a double charge.

#### From callbacks to promises: `util.promisify`

You will meet callback APIs in older libraries. You do not have to keep writing callbacks to use them. Node ships `util.promisify`, which wraps any error-first callback function and gives you back a version that returns a promise (2.3). Most of Node's own APIs also have a promise version already, such as `node:fs/promises`.

```ts
import { promisify } from 'node:util';

type User = { id: string; email: string };

function findUser(id: string, callback: (err: Error | null, user?: User) => void): void {
  setTimeout(() => {
    if (id !== 'usr_7') return callback(new Error(`user ${id} not found`));
    callback(null, { id, email: 'alice@example.com' });
  }, 50);
}

// promisify turns an error-first callback function into one that returns a promise.
const findUserAsync = promisify(findUser);

const user = await findUserAsync('usr_7');
console.log('found:', user?.email);

try {
  await findUserAsync('usr_404');
} catch (err) {
  console.log('failed:', (err as Error).message);
}
```

```text
found: alice@example.com
failed: user usr_404 not found
```

Do not worry yet about `await`; 2.4 explains it. The point here is that the error now lands in an ordinary `try/catch`, which is exactly what the callback version could not do. The real-world rule: when you find a callback API, promisify it once at the edge of your code and use promises everywhere else.

#### Try it yourself

**1. Predict the order.**

```ts
function loadCart(userId: string, callback: (err: Error | null, items?: string[]) => void) {
  setTimeout(() => callback(null, ['mirror-01', 'probe-02']), 10);
}

console.log('1: handler starts');
loadCart('usr_7', (err, items) => {
  if (err) return console.error(err.message);
  console.log(`3: cart has ${items!.length} items`);
});
console.log('2: handler returns');
```

**2. Find the bug.** A user applies the coupon `FREEBIE`, which does not exist. What does this print, and what is wrong?

```ts
function applyCoupon(code: string, callback: (err: Error | null, percentOff?: number) => void) {
  setTimeout(() => {
    if (code !== 'SAVE10') {
      callback(new Error(`coupon ${code} is not valid`));
    }
    callback(null, 10);
  }, 10);
}

applyCoupon('FREEBIE', (err, percentOff) => {
  if (err) {
    console.log('coupon rejected:', err.message);
    return;
  }
  console.log(`coupon applied: ${percentOff}% off`);
});
```

**Answers.**

1. `1: handler starts`, `2: handler returns`, `3: cart has 2 items`. The callback always runs after the current synchronous code.
2. It prints `coupon rejected: coupon FREEBIE is not valid` and then `coupon applied: 10% off`. The `if` block calls the callback but does not `return`, so execution falls through to the success call. The caller's `return` inside its own `if (err)` does not help; that only leaves the callback, not `applyCoupon`. The fix is `return callback(new Error(...))` inside `applyCoupon`.
