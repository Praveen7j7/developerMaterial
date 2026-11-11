## 80.2 JavaScript and TypeScript question bank

Part 59, 59.1 already covers TypeScript from a backend view (`type` vs `interface`, generics, discriminated unions, `unknown`, utility types, narrowing). The questions here are the ones frontend loops ask, framed around the browser and the UI. Each has a model answer, what a strong answer adds, and where the topic is taught.

### Q1. What is a closure, and where have you seen one cause a bug?

- **Model answer** — A closure is a function together with the variables from the scope where it was created. The function keeps access to those variables after the outer function has returned, because the variables live as long as something references them, not as long as the call that created them (1.4.2). Every event handler and every React callback is a closure. The classic bug is a **stale closure**: the function captured a value at creation time and keeps using it after the value changed.

  ```tsx
  function OrderTimer({ orderId }: { orderId: string }) {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
      const id = setInterval(() => {
        setSeconds(seconds + 1); // bug: `seconds` is always 0 inside this closure
      }, 1000);
      return () => clearInterval(id);
    }, []); // the effect ran once, so the callback captured the first render's `seconds`
    return <p>Order {orderId}: waiting {seconds}s</p>;
  }
  ```

  The display goes 0, 1, 1, 1. The fix is the functional update `setSeconds((s) => s + 1)`, which reads the latest value from React instead of from the closure.

- **What a strong answer adds** — That each render of a component creates new closures over that render's props and state, so "stale" means "from an older render". Mentions the `var`-in-a-loop version (`for (var i...)` with `setTimeout` prints the final value three times because there is one `i` for the whole function; `let` creates a new binding per iteration). Mentions that closures also keep memory alive: a handler attached to `window` that closes over a large array keeps that array until the handler is removed.
- **Where it is taught** — 1.4.2 Scope, closures and the call stack; 71.4 Effects; 71.6 for callbacks and custom hooks.

### Q2. How is `this` decided in JavaScript?

- **Model answer** — `this` is decided by **how a function is called**, not where it is written, with one exception: arrow functions have no `this` of their own and use the `this` of the scope they were written in. The rules, in order of priority:
  1. `new Fn()`: `this` is the new object.
  2. `fn.call(obj)`, `fn.apply(obj)`, or a function made with `fn.bind(obj)`: `this` is `obj`.
  3. `obj.method()`: `this` is `obj`, the thing before the dot.
  4. A plain call `fn()`: `this` is `undefined` in strict mode (all ES modules and classes are strict), or the global object in old sloppy scripts.

  ```ts
  class CartService {
    private items: string[] = [];
    add(sku: string) { this.items.push(sku); }
  }
  const cart = new CartService();
  button.addEventListener('click', () => cart.add('SKU-1')); // fine: called as cart.add
  const add = cart.add;
  add('SKU-2'); // TypeError: Cannot read properties of undefined (reading 'items')
  ```

- **What a strong answer adds** — That passing `cart.add` as a callback (`onClick={cart.add}`, `setTimeout(cart.add)`) is the same as the plain call, and the three fixes: wrap in an arrow, `bind` once in the constructor, or define the method as an arrow class field (`add = (sku: string) => {...}`), which costs one function per instance instead of one on the prototype. Knows that in a DOM `addEventListener` callback written as a normal function, `this` is the element (`event.currentTarget`), and that function components in React made most `this` questions disappear from UI code.
- **Where it is taught** — 1.4.1 and 1.5.1 for functions and objects; 59.1 for TypeScript class details.

### Q3. Explain prototypes. What does `class` actually create?

- **Model answer** — Every object has a hidden link to another object, its **prototype**. When you read a property that the object does not have, the engine looks on the prototype, then on its prototype, until it reaches `null`. That chain is how methods are shared. `class Order { total() {} }` creates a constructor function `Order` and puts `total` on `Order.prototype`; each `new Order()` gets its own fields, and a link to `Order.prototype` for methods. `extends` links one prototype to another. Classes are mostly syntax over this mechanism, with real differences: class bodies are strict, classes cannot be called without `new`, and private `#fields` are truly private.

  ```ts
  class Order { constructor(public id: string) {} label() { return `Order ${this.id}`; } }
  const o = new Order('ORD-1001');
  Object.getPrototypeOf(o) === Order.prototype;      // true
  Object.hasOwn(o, 'label');                          // false: it is on the prototype
  ```

- **What a strong answer adds** — Why it matters in practice: `structuredClone` and `JSON.parse(JSON.stringify(x))` return plain objects, so a cloned `Order` has lost its methods; data from an API is never a class instance unless you build one; adding methods to built-in prototypes (`Array.prototype.last = ...`) can collide with future standard methods, which is why that practice is banned. Can mention that `instanceof` checks the prototype chain and fails across iframes or duplicated library copies.
- **Where it is taught** — 1.5.1 Objects; 1.7.2 Interfaces, type aliases and unions for typing plain data instead of classes.

### Q4. The event loop: predict the output

This is the most common fundamentals exercise in frontend loops. Part 59, Q14 has the Node.js version with `process.nextTick` and `setImmediate`; this is the browser version.

```ts
console.log('1 script start');

setTimeout(() => console.log('2 timeout'), 0);

Promise.resolve()
  .then(() => console.log('3 then A'))
  .then(() => console.log('4 then B'));

queueMicrotask(() => console.log('5 microtask'));

(async () => {
  console.log('6 async body');
  await null;
  console.log('7 after await');
})();

requestAnimationFrame(() => console.log('8 animation frame'));

console.log('9 script end');
```

- **Model answer** — `1, 6, 9, 3, 5, 7, 4`, then `2` and `8`. The reasoning, step by step:
  1. The script itself is one task. Synchronous code runs to completion: `1`, then the async function body runs synchronously up to its first `await`, printing `6`, then `9`.
  2. While running, it queued **microtasks** in this order: `then A` (the promise was already resolved, so its callback is queued at once), the `queueMicrotask` callback, and the continuation after `await null`.
  3. When the call stack empties, the browser drains the **whole microtask queue** before doing anything else: `3` (which resolves the next promise and queues `then B` at the back), `5`, `7`, then `4`.
  4. Only then does the event loop move on. The `setTimeout` callback is a **task** (often called a macrotask); the `requestAnimationFrame` callback runs in the rendering step, just before the next paint.

  ```text
  call stack:      1 6 9
  microtasks:      3 5 7 4        (drained completely, including newly added ones)
  then, order not fixed by the spec:
  task:            2              (timer task, usually first)
  render step:     8              (before the next paint, roughly every 16.7 ms at 60 Hz)
  ```

- **What a strong answer adds** — That the order of `2` and `8` is not guaranteed: the timer usually wins, but a render opportunity can come first, and a background tab may not render at all, so `requestAnimationFrame` can wait indefinitely. That because microtasks drain completely, a microtask that keeps queueing microtasks starves rendering and input, which is a frozen tab with no long `setTimeout` in sight. That a long task (over 50 ms) blocks input, which is what INP measures (76.4). Strong candidates draw the loop: one task, all microtasks, maybe render, next task.
- **Where it is taught** — 2.1.1 The single thread and the event loop; 10.16 and 10.17 for the runtime view; 69.7 The main thread, the browser event loop and long tasks.

### Q5. How do errors work with promises and `async`/`await`? Where do they get lost?

- **Model answer** — An `async` function always returns a promise. A `throw` inside it rejects that promise; `await` on a rejected promise throws at that line, so `try/catch` works as you expect, but only around an `await`. Errors are lost in four common ways:
  1. A promise that is never awaited or given a `.catch` (a "floating" promise). The browser fires an `unhandledrejection` event and logs it; your UI shows nothing.
  2. `array.forEach(async (x) => ...)`: `forEach` ignores the returned promises, so nothing waits and nothing catches.
  3. `try { return fetchOrder(id); } catch {}` without `await`: the function returns the promise before it rejects, so the `catch` never runs. Use `return await` inside `try`.
  4. `fetch` resolves on HTTP 404 and 500. It only rejects on network failure or abort. You must check `res.ok`.

  ```ts
  async function loadDashboard(userId: string) {
    const results = await Promise.allSettled([
      api.getOrders(userId),
      api.getRecommendations(userId), // optional panel: may fail without breaking the page
    ]);
    const [orders, recs] = results;
    if (orders.status === 'rejected') throw orders.reason; // the page cannot work without orders
    return { orders: orders.value, recs: recs.status === 'fulfilled' ? recs.value : [] };
  }
  ```

- **What a strong answer adds** — The combinators and their failure semantics: `Promise.all` rejects on the first rejection but **does not cancel** the others (they keep running and their later rejections are ignored), `allSettled` never rejects, `any` resolves with the first success, `race` settles with the first to settle. Cancellation is a separate mechanism (`AbortController`, 72.10). Mentions reporting `unhandledrejection` to error tracking (78.6), and that the backend version of this policy is in Part 59, Q21.
- **Where it is taught** — 2.3.1 What a promise is; 2.4.1; 2.5.1 Errors, timeouts and cancellation; 2.7.1 Reading the clues.

### Q6. `==` versus `===`, and the coercion questions

- **Model answer** — `===` compares without converting types. `==` converts first, with rules that surprise people: `0 == ''` is `true`, `'1' == 1` is `true`, `null == undefined` is `true` but `null == 0` is `false`, `[] == false` is `true`. Use `===` everywhere, with one accepted exception some teams allow: `value == null` to check for both `null` and `undefined`. `NaN` is not equal to anything including itself; use `Number.isNaN`. `Object.is` is `===` except that `Object.is(NaN, NaN)` is `true` and `Object.is(0, -0)` is `false`, and it is what React uses to decide whether state changed.
- **What a strong answer adds** — Where coercion bites in UI code: input values are always strings, so `quantity + 1` from an input gives `"21"`; `if (count)` hides a legitimate `0` (render `{count && <Badge />}` and React prints a literal `0` on the page); `typeof null === 'object'`; and money must never be a float (`0.1 + 0.2 !== 0.3`), which is why the contract sends minor units (74.7). Uses `??` instead of `||` when `0` or `''` are valid values.
- **Where it is taught** — 1.1.3 Equality, truthiness and coercion; 74.7 Dates, money, IDs and enums across the wire.

### Q7. How do you copy objects and arrays, and why does immutability matter in React?

- **Model answer** — Assignment copies the reference, not the object. Spread (`{ ...order }`, `[...items]`) makes a **shallow** copy: the top level is new, nested objects are shared. `structuredClone(value)` makes a deep copy of plain data, `Map`, `Set`, `Date` and typed arrays, but throws on functions and DOM nodes and drops class prototypes. `JSON.parse(JSON.stringify(x))` is worse: it turns `Date` into strings and drops `undefined`. React decides whether to re-render by comparing references with `Object.is`, so mutating state in place (`cart.items.push(item); setCart(cart)`) gives React the same reference and the UI does not update.

  ```ts
  type Cart = { id: string; items: { sku: string; qty: number }[] };
  function setQty(cart: Cart, sku: string, qty: number): Cart {
    return {
      ...cart,                                   // new cart object
      items: cart.items.map((i) => (i.sku === sku ? { ...i, qty } : i)), // new array, one new item
    };                                           // unchanged items keep their identity, so memoised rows skip re-render
  }
  ```

- **What a strong answer adds** — That structural sharing (copy only the path you change) is what makes immutability cheap and what lets `React.memo` rows skip work. That `Object.freeze` is shallow. That the newer non-mutating array methods (`toSorted`, `toReversed`, `toSpliced`, `with`) avoid the classic bug of `items.sort()` mutating state. That Immer (used inside Redux Toolkit, 72.9) lets you write mutating code that produces immutable updates.
- **Where it is taught** — 1.5.1 and 1.5.2; 71.2 State and re-rendering; 72.9 Client state stores.

### Q8. ES modules versus CommonJS. What does a bundler do with them?

- **Model answer** — ES modules (`import`/`export`) are the language standard and are **static**: imports are declared at the top level, so tools can see the whole dependency graph without running code. That is what makes tree shaking possible (70.5). Imports are **live bindings**: if the exporting module changes the value, importers see the change. CommonJS (`require`, `module.exports`) is Node's older system, resolved at runtime, so a bundler cannot always tell what is used. `import()` is a dynamic import that returns a promise and is how code splitting works: the bundler emits a separate chunk loaded on demand.
- **What a strong answer adds** — Circular imports give `undefined` (or a temporal-dead-zone error) at module-evaluation time, which shows up as "works in dev, crashes in production build". Side-effectful modules (those that patch globals or register CSS) must be listed under `sideEffects` in `package.json` or tree shaking may drop them. Top-level `await` exists in ES modules and blocks modules that import it. After a deploy, a lazy chunk that was deleted from the server produces "ChunkLoadError" for users on the old version (78.4).
- **Where it is taught** — 1.7.1 Modules; 69.6 Script loading; 70.5 Tree shaking and code splitting at build time.

### Q9. Write a generic TypeScript helper for the UI and explain the constraint

- **Model answer** — A typical one is a typed `groupBy` used to render orders by status:

  ```ts
  function groupBy<T, K extends PropertyKey>(items: readonly T[], keyOf: (item: T) => K): Record<K, T[]> {
    const out = {} as Record<K, T[]>;
    for (const item of items) {
      const k = keyOf(item);
      (out[k] ??= []).push(item);              // create the bucket on first use
    }
    return out;
  }

  type Order = { id: string; status: 'placed' | 'shipped' | 'delivered' };
  const byStatus = groupBy(orders, (o) => o.status); // Record<'placed' | 'shipped' | 'delivered', Order[]>
  ```

  `K extends PropertyKey` restricts the key to `string | number | symbol`, the only types usable as object keys. Inference does the rest: the caller never writes the type parameters.

- **What a strong answer adds** — Notices the honest gap: the return type claims every status key exists, but a status with no orders has no bucket, so `byStatus.shipped.length` can throw. A strong candidate either returns `Partial<Record<K, T[]>>` or pre-fills the known keys. Mentions the built-in `Object.groupBy` (available in current browsers; check your targets, 70.2) and that its TypeScript type is already `Partial`. Links to the generic component pattern: `function Select<T>({ options, getLabel }: SelectProps<T>)`.
- **Where it is taught** — 1.7.3 Generics; 59.1, Q2 for constraints; 70.8 TypeScript configuration for frontends.

### Q10. How does narrowing work, and how do you model UI states with it?

- **Model answer** — Narrowing is the compiler following your checks: after `typeof x === 'string'`, `'error' in r`, `x instanceof Date`, or a check on a literal field, it knows a more specific type in that branch. For UI, the best use is a discriminated union for request state, which makes impossible combinations (loading and error at once, data without success) unrepresentable:

  ```ts
  type Remote<T> =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'success'; data: T }
    | { status: 'error'; message: string; requestId?: string };

  function assertNever(x: never): never { throw new Error(`Unhandled state: ${JSON.stringify(x)}`); }

  function render(s: Remote<Order[]>) {
    switch (s.status) {
      case 'idle': return null;
      case 'loading': return <Spinner />;
      case 'success': return s.data.length ? <OrderList orders={s.data} /> : <EmptyState />;
      case 'error': return <ErrorBanner message={s.message} requestId={s.requestId} />;
      default: return assertNever(s); // compile error if a new status is added and not handled
    }
  }
  ```

- **What a strong answer adds** — User-defined type guards (`function isProblem(x: unknown): x is Problem`) for API errors, and the warning that a guard is a promise to the compiler that nothing checks; for data crossing the network, use a runtime schema (zod) so the type and the check cannot drift (74.3). Narrowing of a `let` variable may not survive into a callback if the variable is reassigned later, and TypeScript is optimistic about object properties: it keeps a narrowed `order.status` across a function call that might have changed it. Empty is its own state, not a special case of success (72.11).
- **Where it is taught** — 1.7.2 Interfaces, type aliases and unions; 59.1, Q3 and Q9; 72.11 Loading, empty and error states as a design requirement.

### Q11. Which utility types do you use in React code?

- **Model answer** — `Partial<T>` for patch payloads and form drafts, `Pick` and `Omit` to derive component props from a domain type, `Record<K, V>` for lookup tables, `ReturnType` and `Awaited` to type what a function or API call produces, `NonNullable` to strip `null`. React adds its own: `React.ComponentProps<'button'>` to accept every native button prop, and `React.ReactNode` for children.

  ```tsx
  type ButtonProps = React.ComponentProps<'button'> & { variant?: 'primary' | 'danger'; loading?: boolean };

  function Button({ variant = 'primary', loading = false, disabled, children, ...rest }: ButtonProps) {
    return (
      <button {...rest} className={`btn btn-${variant}`} disabled={disabled || loading} aria-busy={loading}>
        {loading ? 'Please wait' : children}
      </button>
    );
  }
  ```

- **What a strong answer adds** — `satisfies` to check a config object against a type without widening it (for example, a route table where each key must exist but literal values stay literal). That deriving types from one source (the contracts package, or `z.infer`) beats hand-written duplicates that drift. That `Omit` on a union type does not distribute, which surprises people.
- **Where it is taught** — 59.1, Q6 for the full list; 70.8; 74.3 Shared zod schemas.

### Q12. What is debouncing versus throttling? Implement debounce.

- **Model answer** — **Debounce** waits until calls stop for a given time, then runs once with the last arguments: right for a search box (search after the user pauses for 250 ms). **Throttle** runs at most once per interval while calls keep coming: right for scroll or resize handlers.

  ```ts
  function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debounced = (...args: A) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), waitMs);
    };
    debounced.cancel = () => clearTimeout(timer); // so a component can clean up on unmount
    return debounced;
  }
  ```

- **What a strong answer adds** — That debouncing reduces requests but **does not fix races**: two slow requests can still return out of order, so you also need cancellation or a latest-request check (80.5.2). That a debounced function created inside a component body is recreated every render, so each keystroke gets a fresh timer, the old timers still fire, and nothing is debounced; create it once (`useMemo` or `useRef`) or debounce the value instead (a `useDebouncedValue` hook). That for scroll-linked visual work, `requestAnimationFrame` is usually better than a time-based throttle.
- **Where it is taught** — 72.10 Offline and flaky networks: timeouts, retries, AbortController; 71.6 Custom hooks.
