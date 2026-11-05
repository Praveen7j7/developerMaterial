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

The business rules did not change at all. They moved into a class so NestJS can share one instance of `ShippingService` across the whole application. We explain that machinery in Part 6 and, in depth, in Part 12 (dependency injection).

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

### 1.4.2 Scope, closures and the call stack

#### Concept

**Scope** is the set of variables a piece of code can see. **A closure** is a function that remembers the variables from where it was created, even after that place has finished running. **The call stack** is the list of functions currently in progress. These three ideas explain a lot of otherwise-mysterious behavior.

#### Why does it exist?

Scope exists so that two functions can both use a variable named `i` without colliding — each has its own. Closures exist so a function can carry some private state with it, which is how you build things like a counter, a rate limiter, or a configured client. Understanding the call stack is how you read a stack trace, which is the single most useful debugging skill (Part 35).

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
- **Stack overflow.** A function that calls itself with no stopping condition fills the call stack until Node crashes with `Maximum call stack size exceeded`. Every recursive function needs a base case (Part 8).
- **Memory leaks via closures.** A closure keeps its captured variables alive. If a long-lived closure captures a huge object, that object cannot be garbage-collected (Part 9). This is a real source of slow memory growth in long-running servers.

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
