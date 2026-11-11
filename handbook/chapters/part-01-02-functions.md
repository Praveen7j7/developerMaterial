## 1.4 Functions

### 1.4.1 Declaring and calling functions

#### Concept

A function is a named, reusable block of code that takes inputs (called parameters), does something, and usually gives back an output (the return value). Functions are how you break a big problem into small, nameable pieces. Almost everything you write in a backend lives inside a function.

#### Why does it exist?

Without functions, you would copy the same logic everywhere it is needed, and fixing a bug would mean fixing it in twenty places. A function is a single place where one idea lives. "Calculate the order total" should exist once; every part of the system that needs an order total calls that one function. When the tax rules change, you change one function.

#### Mental model

Imagine a vending machine. You put in coins and a code (the inputs), the machine does its internal work, and a snack drops out (the return value). You do not need to know how the machine is wired inside; you only need to know what it takes and what it gives back. A well-named function is a vending machine with a clear label.

#### How it works

There are two main ways to write a function. A **function declaration** uses the `function` keyword. An **arrow function** uses `=>` and is stored in a variable. In modern backend code you will see both; arrow functions are more common for small helpers and callbacks.

```ts
// Function declaration
function orderTotalCents(subtotal: number, tax: number, shipping: number): number {
  return subtotal + tax + shipping;
}

// Arrow function stored in a const
const orderTotalCents2 = (subtotal: number, tax: number, shipping: number): number => {
  return subtotal + tax + shipping;
};

// Calling them is identical
const total = orderTotalCents(3499, 280, 599); // 4378
```

The parts of a function: the **name** (`orderTotalCents`), the **parameters** in parentheses with their types, the **return type** after the colon, and the **body** in braces. The `return` statement sends a value back to whoever called the function. A function with no `return` gives back `undefined`.

#### Parameters: default, optional and rest

```ts
// Default parameter: used when the caller omits the argument.
function paginate(page: number, pageSize: number = 20): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
paginate(3);        // pageSize defaults to 20 -> { skip: 40, take: 20 }
paginate(3, 50);    // { skip: 100, take: 50 }

// Optional parameter: may be undefined. Marked with ?.
function greet(name: string, title?: string): string {
  return title ? `${title} ${name}` : name;
}

// Rest parameter: collects any number of trailing arguments into an array.
function sumCents(...amounts: number[]): number {
  return amounts.reduce((acc, n) => acc + n, 0);
}
sumCents(100, 200, 50); // 350
```

#### Practical example

A function that decides shipping cost. Notice it takes typed inputs and returns a typed output, and that it has one job.

```ts
function shippingCostCents(
  subtotalCents: number,
  isPrimeMember: boolean,
  country: string,
): number {
  if (isPrimeMember) return 0;
  if (country !== 'US') return 2500;          // flat international rate
  if (subtotalCents >= 5000) return 0;        // free over $50 domestic
  return 599;                                  // standard domestic
}
```

#### NestJS example

This is a sneak peek at Part 6. In NestJS, the methods on a service are just functions with a decorator on the class. The function below is pure business logic; the framework calls it.

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class ShippingService {
  // A method is a function that belongs to a class.
  cost(subtotalCents: number, isPrimeMember: boolean, country: string): number {
    if (isPrimeMember) return 0;
    if (country !== 'US') return 2500;
    return subtotalCents >= 5000 ? 0 : 599;
  }
}
```

The business rules did not change at all. They moved into a class so NestJS can share one instance of `ShippingService` across the whole application. We explain that machinery in Part 6 and, in depth, in Part 13 (dependency injection).

#### Edge cases & failure modes

- A function that returns `undefined` implicitly (no `return`) when the caller expected a value is a classic bug. TypeScript's return-type annotation catches it: declaring `: number` forces every path to return a number.
- Passing arguments in the wrong order (`shippingCostCents(country, isPrime, subtotal)`) compiles only if the types happen to line up. This is why a single argument **object** is often safer than many positional parameters (see 1.4.3).
- A function that both returns a value and changes something outside itself (a "side effect") is harder to test and reason about. Prefer functions that only transform their inputs where you can.

#### How a Senior Backend Engineer thinks about this

A senior aims for functions that are small, named for what they produce, and free of hidden side effects where possible. The test they apply: "Can I describe this function in one sentence without the word 'and'?" If the sentence needs an "and", the function is doing two jobs and should be split. They also prefer **pure functions** — same input always gives same output, no side effects — for business rules, because pure functions are trivial to unit-test (Part 41) without a database or network.

#### Common mistakes

- Giant functions that do ten things; impossible to name, test or reuse.
- Forgetting a `return`, so the function silently yields `undefined`.
- Too many positional parameters, so callers pass them in the wrong order.
- Mutating a parameter that is an object or array, surprising the caller (covered in 1.5).

#### Interview questions

1. **What is a pure function and why is it desirable?** A function whose output depends only on its inputs and which has no side effects. It is easy to test and reason about, and safe to call repeatedly.
2. **What is the difference between a function declaration and an arrow function?** Beyond syntax, arrow functions do not have their own `this` and are not hoisted. For most backend helpers the difference rarely matters; `this` matters inside classes.
3. **When would you pass an options object instead of positional parameters?** When there are more than two or three parameters, or several are optional, to avoid order mistakes and make call sites self-documenting.

#### Practical exercise

Write a pure function `orderSummary` that takes `subtotalCents`, `taxCents`, `shippingCents` and `discountCents` and returns an object `{ subtotalCents, taxCents, shippingCents, discountCents, grandTotalCents }`. Acceptance criteria: the grand total never goes below zero (clamp it), and the function has no side effects.

#### Worked answer to the exercise

```ts
interface OrderSummary {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly shippingCents: number;
  readonly discountCents: number;
  readonly grandTotalCents: number;
}

function orderSummary(
  subtotalCents: number,
  taxCents: number,
  shippingCents: number,
  discountCents: number,
): OrderSummary {
  // Clamp: a discount bigger than the order never produces a negative total.
  const grandTotalCents = Math.max(0, subtotalCents + taxCents + shippingCents - discountCents);
  return { subtotalCents, taxCents, shippingCents, discountCents, grandTotalCents };
}

console.log(orderSummary(3499, 280, 599, 500));
console.log(orderSummary(1000, 80, 0, 5000).grandTotalCents); // 0, not -3920

// Purity check: same input gives the same output, and nothing outside changed.
const first = orderSummary(3499, 280, 599, 500);
const second = orderSummary(3499, 280, 599, 500);
console.log(JSON.stringify(first) === JSON.stringify(second)); // true
```

```text
{
  subtotalCents: 3499,
  taxCents: 280,
  shippingCents: 599,
  discountCents: 500,
  grandTotalCents: 3878
}
0
true
```

Why it is right: `Math.max(0, x)` returns `x` when it is positive and `0` when it is negative, which is exactly "clamp at zero". The function is pure: it reads only its four parameters, it does not touch any variable outside itself, it does not log, write to a database or call the network, and it builds a brand-new object every time. Same input, same output, always. The `readonly` fields stop a caller from quietly changing the summary afterwards. The shorthand `{ subtotalCents, taxCents, ... }` means `{ subtotalCents: subtotalCents, ... }`.

The trap most learners fall into is adding "just one" side effect: a `console.log` inside the function, or updating a running total in an outer variable, or accepting an order object and writing `order.grandTotalCents = ...` onto it. Each of those makes the function harder to test and surprises its callers (1.4.1). A subtler trap: clamping hides bad input. A negative `subtotalCents` is a bug somewhere upstream, and clamping turns it into a silent zero. A stricter version would throw when any input is negative or not an integer, and clamp only the legitimate case of a discount larger than the order.

Check it yourself: run it, then write the two cases as a unit test (Part 41 — Testing Backend Systems with Jest and NestJS, 41.3): `expect(orderSummary(1000, 80, 0, 5000).grandTotalCents).toBe(0)`. Because the function is pure, the test needs no database, no mocks and no setup.

### 1.4.2 Scope, closures and the call stack

#### Concept

**Scope** is the set of variables a piece of code can see. **A closure** is a function that remembers the variables from where it was created, even after that place has finished running. **The call stack** is the list of functions currently in progress. These three ideas explain a lot of otherwise-mysterious behavior.

#### Why does it exist?

Scope exists so that two functions can both use a variable named `i` without colliding — each has its own. Closures exist so a function can carry some private state with it, which is how you build things like a counter, a rate limiter, or a configured client. Understanding the call stack is how you read a stack trace, which is the single most useful debugging skill (Part 10.15).

#### Mental model

Imagine nested rooms. Code in an inner room can see out through the open doors into the rooms that contain it, but code in an outer room cannot see into the inner rooms. A closure is like taking a photograph of what the outer rooms held at the moment you walked into the inner room — even after those rooms are torn down, the function still has the photo.

#### How it works

```ts
function makeCounter(): () => number {
  let count = 0;                 // this lives in makeCounter's scope
  return () => {
    count = count + 1;           // the inner function "closes over" count
    return count;
  };
}

const next = makeCounter();
console.log(next()); // 1
console.log(next()); // 2  -- count survived, private to this counter
const other = makeCounter();
console.log(other()); // 1  -- a separate count
```

`makeCounter` finished running after the first call, yet `count` is still alive, held by the returned function. That is a closure. Each call to `makeCounter` creates a fresh `count`, which is why `next` and `other` are independent.

The call stack: when `a()` calls `b()` which calls `c()`, the stack is `a -> b -> c`. When `c` returns, it is popped off. If `c` throws an error, the error message includes the whole stack, so you can see the exact path that led to the failure.

```text
Error: payment declined
    at chargeCard        (payment.service.ts:42)   <- where it threw
    at processOrder      (orders.service.ts:88)    <- who called that
    at OrdersController   (orders.controller.ts:23) <- who called that
```

Read a stack trace top to bottom: the top line is where the error happened, and each line below is the caller.

#### Practical example

A closure that builds a configured API client. The base URL and key are captured once and reused by every call.

```ts
function makePaymentClient(baseUrl: string, apiKey: string) {
  // baseUrl and apiKey are private to the returned functions.
  return {
    charge: async (amountCents: number) => {
      // uses baseUrl and apiKey without them being global
      return fetch(`${baseUrl}/charges`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ amountCents }),
      });
    },
  };
}
```

#### Edge cases & failure modes

- **The classic loop-closure bug.** With `var i` in a `for` loop, all closures share the one `i` and see its final value. With `let i`, each iteration gets a fresh `i`. This is the single most common closure bug and the reason `let` exists.
- **Stack overflow.** A function that calls itself with no stopping condition fills the call stack until Node crashes with `Maximum call stack size exceeded`. Every recursive function needs a base case (Part 9).
- **Memory leaks via closures.** A closure keeps its captured variables alive. If a long-lived closure captures a huge object, that object cannot be garbage-collected (Part 10). This is a real source of slow memory growth in long-running servers.

#### How a Senior Backend Engineer thinks about this

Closures are not an exotic trick; they are everywhere in backend code — every event handler, every middleware, every configured client is a closure. A senior is comfortable reading them and is alert to the memory implication: a closure captured by something long-lived (a cache, a global event emitter) can quietly pin large objects in memory. When they read a stack trace, they read it as a story: this called that called the thing that broke.

#### Common mistakes

- The `var`-in-a-loop closure bug (use `let`).
- Recursion with no base case, causing a stack overflow.
- Capturing large objects in long-lived closures, leaking memory.
- Not reading the stack trace and guessing at the cause instead.

#### Interview questions

1. **What is a closure?** A function bundled with the variables from the scope where it was created, which it can access even after that scope has returned. Follow-up: give a use (private state, configured client, memoization).
2. **Why does the classic `for` loop with `var` print the final value in every callback?** All iterations share one `var` binding; `let` creates a new binding each iteration.
3. **How do you read a stack trace?** Top line is where it threw; each line below is the caller up the chain.

#### Practical exercise

Write `makeRateLimiter(maxPerMinute)` that returns a function `allow()` which returns `true` the first `maxPerMinute` times it is called within a rolling minute and `false` afterward, using a closure to hold the timestamps privately. Acceptance criteria: two separate limiters created by two calls to `makeRateLimiter` do not share state.

#### Worked answer to the exercise

```ts
const WINDOW_MS = 60_000;

// `now` is injectable so a test can control time; it defaults to the real clock.
function makeRateLimiter(maxPerMinute: number, now: () => number = Date.now): () => boolean {
  const timestamps: number[] = []; // private: only allow() below can reach it

  return function allow(): boolean {
    const t = now();
    // Forget calls that have slid out of the rolling one-minute window.
    while (timestamps.length > 0 && timestamps[0] <= t - WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length >= maxPerMinute) return false;
    timestamps.push(t);
    return true;
  };
}

// A fake clock we move by hand, so the demo runs instantly.
let fakeTime = 0;
const clock = (): number => fakeTime;

const limiterA = makeRateLimiter(3, clock);
const limiterB = makeRateLimiter(3, clock);

console.log('A:', [limiterA(), limiterA(), limiterA(), limiterA()]); // 4th call refused
console.log('B:', [limiterB()]);                                      // B has its own budget
fakeTime = 30_000;
console.log('A at 30 s:', limiterA()); // still inside the window
fakeTime = 60_001;
console.log('A at 60 s:', limiterA()); // the early calls slid out
```

```text
A: [ true, true, true, false ]
B: [ true ]
A at 30 s: false
A at 60 s: true
```

Why it is right: `timestamps` is declared inside `makeRateLimiter`, so every call to `makeRateLimiter` creates a new, separate array, and the returned `allow` function is the only code that can see it. That is the closure doing its job, and it is why limiter B still has its full budget after A ran out. "Rolling minute" means "the last 60 seconds counted from now", so on every call we first drop timestamps older than 60 seconds, then decide. The array never holds more than `maxPerMinute` entries, because we only record calls we allowed.

The trap most learners fall into is declaring `const timestamps: number[] = []` at the top of the file, outside `makeRateLimiter`. Everything still works with one limiter, and the moment you create a second one, both share one array: exactly the failure the acceptance criteria test for. The second trap is building a fixed window instead ("reset the counter at the start of each minute"), which lets a client send `maxPerMinute` calls at 10:00:59 and another `maxPerMinute` at 10:01:00.

Passing `now` as a parameter is what makes this testable without waiting a real minute (41.11 covers testing time). Check it yourself: run the file and compare. Note that this limiter lives in one process's memory; with three API instances behind a load balancer, each has its own count, which is why production rate limits usually live in Redis (27.11; 9.17 builds the algorithms properly).

### 1.4.3 Typing functions well

#### Concept

TypeScript lets you describe a function's shape as a type: what it takes and what it returns. This lets you pass functions around safely (as callbacks) and define contracts that many functions must satisfy.

#### How it works

```ts
// A type for a function value.
type PriceRule = (subtotalCents: number) => number;

const tenPercentOff: PriceRule = (subtotal) => Math.round(subtotal * 0.9);
const fiveDollarsOff: PriceRule = (subtotal) => Math.max(0, subtotal - 500);

// A function that takes another function as an argument (a "higher-order function").
function applyRules(subtotalCents: number, rules: PriceRule[]): number {
  return rules.reduce((total, rule) => rule(total), subtotalCents);
}

applyRules(5000, [tenPercentOff, fiveDollarsOff]); // 4000, then 3500
```

A function that takes or returns another function is called a **higher-order function**. `applyRules` is one. The array methods you meet next (`map`, `filter`, `reduce`) are all higher-order functions: you hand them a function and they call it for you.

#### Function overloads and the options-object pattern

When a function takes many parameters, pass a single typed object instead. It is self-documenting at the call site and immune to argument-order mistakes.

```ts
interface CreateOrderInput {
  userId: string;
  items: { productId: string; quantity: number }[];
  couponCode?: string;
  giftWrap?: boolean;
}

function createOrder(input: CreateOrderInput): void {
  // input.userId, input.items, etc. -- order of fields does not matter
}

createOrder({
  userId: 'usr_1',
  items: [{ productId: 'p1', quantity: 2 }],
  giftWrap: true,
}); // clear and order-independent
```

#### How a Senior Backend Engineer thinks about this

A senior types callbacks and higher-order functions precisely, because a wrong callback signature is a bug that only shows up at runtime otherwise. For any function with more than two or three parameters, or with optional ones, they switch to an options object, because six months later nobody remembers whether `createOrder(a, b, c, d)` puts the coupon before or after the gift-wrap flag.

#### Common mistakes

- Untyped callbacks (`rules: Function[]`), which lets any shape of function through.
- Long positional parameter lists that callers get wrong.

#### Interview questions

1. **What is a higher-order function?** One that takes a function as an argument or returns a function. Examples: `map`, `filter`, `reduce`, and any function that accepts a callback.
2. **Why prefer an options object over many positional parameters?** Self-documenting call sites, order-independence, and easy optional fields.

#### Practical exercise

Define a type `Validator = (value: unknown) => boolean` and write a higher-order function `validateAll(value, validators)` that returns `true` only if every validator passes. Acceptance criteria: it short-circuits (stops) at the first failing validator.

#### Worked answer to the exercise

```ts
type Validator = (value: unknown) => boolean;

function validateAll(value: unknown, validators: readonly Validator[]): boolean {
  // every() stops at the first validator that returns false.
  return validators.every((validator) => validator(value));
}

// Wrap a validator so we can see whether it actually ran.
const traced =
  (name: string, check: Validator): Validator =>
  (value) => {
    console.log(`  ran ${name}`);
    return check(value);
  };

const isString = traced('isString', (v) => typeof v === 'string');
const isEmailShaped = traced('isEmailShaped', (v) => typeof v === 'string' && /^[^@\s]+@[^@\s]+$/.test(v));
const isShortEnough = traced('isShortEnough', (v) => typeof v === 'string' && v.length <= 254);
const rules = [isString, isEmailShaped, isShortEnough];

console.log('alice@example.com ->', validateAll('alice@example.com', rules));
console.log('42 ->', validateAll(42, rules));
```

```text
  ran isString
  ran isEmailShaped
  ran isShortEnough
alice@example.com -> true
  ran isString
42 -> false
```

Why it is right: `Array.prototype.every` calls the callback for each element in order and stops the moment one returns `false`, so the short-circuit comes for free. The trace proves it: for `42`, only `isString` ran. `traced` is itself a higher-order function, one that takes a validator and returns a new validator, which is the same idea as `validateAll` turned around.

The trap most learners fall into is `validators.map((v) => v(value)).every(Boolean)`, or a `reduce` that ANDs the results. Both give the right `true`/`false`, but `map` runs every validator first, so there is no short-circuit. That matters for more than speed: later validators often assume earlier ones passed. A length check written as `(v) => (v as string).length <= 254` would crash with `Cannot read properties of null` when given `null`, if it ran after a failed `isString`.

One edge case to decide on purpose: `validateAll(x, [])` returns `true`, because "every one of zero validators passed" is true. That is usually what you want; if an empty list means a configuration mistake in your system, throw instead.

Check it yourself: run the file and confirm that the `42` case prints only one `ran` line. Then swap `every` for the `map` version and watch all three run.
