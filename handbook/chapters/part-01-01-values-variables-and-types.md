# Part 1 — Programming Fundamentals in JavaScript and TypeScript

Welcome to Volume 0. This volume exists for one reader: the person who wants to become a backend engineer and is starting close to zero. Maybe you have written a little JavaScript in a browser, maybe you have followed a tutorial once, maybe you have never written a line. Either way, this volume takes you from "I can run `node file.js`" to "I can build a small, correct NestJS API backed by PostgreSQL". The rest of the book (Parts 8–52, 54–68 and 81–88) assumes you already have that foundation. This volume builds it.

This Part is about the language. Not toy JavaScript, and not clever tricks. We teach the parts of JavaScript and TypeScript that you will actually use every day in a backend: values and variables, the type system, functions, objects, arrays, control flow, modules, and error handling. We deliberately build toward the backend. The examples use orders, users, products and payments from the first page, because those are the nouns you will model for the rest of your career, not `foo` and `bar`.

A note before we start. JavaScript is the language that runs in the browser and, through Node.js, on the server. TypeScript is JavaScript with a type checker bolted on top. You write TypeScript, a compiler checks it and strips the types away, and what actually runs is plain JavaScript. Every backend in this book is written in TypeScript, so we teach both together: the JavaScript mechanism first, then the TypeScript type that describes it.

## 1.1 Values, variables and types

### 1.1.1 What a value is, and the primitive types

#### Concept

A value is a piece of data your program works with. The number `4200`, the text `"pending"`, the fact `true` — each is a value. JavaScript has a small set of built-in kinds of value called **primitive types**. You will use these constantly.

The primitives are: `number` (every number, whole or decimal, like `42` or `19.99`), `string` (text, like `"alice@example.com"`), `boolean` (`true` or `false`), `null` (a deliberate "no value"), `undefined` (a value that was never set), `bigint` (for integers too large for `number`), and `symbol` (rare, a unique marker). For a backend developer, the first five matter every day; `bigint` and `symbol` you can learn later.

#### Why does it exist?

A program is useless if it cannot hold data. An order has a total, a status, a flag for whether it is paid. Those are a number, a string and a boolean. The type system exists so the language — and later, TypeScript — knows what kind of thing it is holding, which decides what you are allowed to do with it. You can add two numbers. Adding two booleans is almost always a bug.

#### Mental model

Imagine a warehouse with labelled bins. Each bin holds one thing. Some bins hold weights (numbers), some hold written notes (strings), some hold a yes/no switch (boolean). The label on the bin tells the warehouse worker what kind of thing is inside without opening it. A **type** is that label. A **value** is the thing in the bin. A **variable** is the bin itself with its name painted on the front.

#### How it works

JavaScript figures out the type of a value automatically from how you write it. `42` is a number. `"42"` with quotes is a string. `true` is a boolean. There is no step where you declare "this is a number" in plain JavaScript — the quotes, or their absence, decide.

```js
// Plain JavaScript. Node figures out each type from the literal.
const orderTotalCents = 4299;        // number
const currency = 'USD';              // string
const isPaid = false;                // boolean
const cancelledAt = null;            // null: we deliberately have no cancel time
let discountCode;                    // undefined: declared but not yet assigned

console.log(typeof orderTotalCents); // "number"
console.log(typeof currency);        // "string"
console.log(typeof isPaid);          // "boolean"
console.log(typeof cancelledAt);     // "object"  <-- a famous JavaScript quirk
console.log(typeof discountCode);    // "undefined"
```

The `typeof null` returning `"object"` is a 25-year-old bug in the language that can never be fixed without breaking the web. Memorize it as a quirk and move on.

#### Practical example

Here is a tiny piece of order logic written with primitives only. It decides whether an order qualifies for free shipping.

```js
const orderTotalCents = 4299;        // $42.99
const freeShippingThresholdCents = 5000; // $50.00
const isPrimeMember = true;

const qualifiesForFreeShipping =
  orderTotalCents >= freeShippingThresholdCents || isPrimeMember;

console.log(qualifiesForFreeShipping); // true, because the member flag is set
```

Notice we store money in **cents as an integer**, not `42.99` as a decimal. This is the first real backend habit: floating-point numbers like `0.1 + 0.2` do not equal `0.3` exactly in any language that uses the IEEE 754 standard, and JavaScript does. Storing money as integer cents avoids rounding errors that turn into off-by-a-penny bugs and angry customers.

```js
console.log(0.1 + 0.2);              // 0.30000000000000004, not 0.3
console.log(0.1 + 0.2 === 0.3);      // false
```

#### Production scenario

A real payment service receives an order total, a tax amount and a shipping fee, all in cents, and sums them. Because every value is an integer number of cents, the sum is exact. If the same service had stored `42.99` and `3.50` as floating-point dollars, a few million additions per day would accumulate fractional-cent errors, and the daily reconciliation job that compares your totals against the payment provider's totals would fail by a few cents — which, to a finance team, is an all-hands incident, because a payment system that cannot add up is a payment system nobody trusts.

#### Edge cases & failure modes

- `NaN` ("not a number") is itself of type `number`. It appears when a calculation makes no sense, like `Number("abc")`. Worse, `NaN === NaN` is `false`; use `Number.isNaN(x)` to test for it.
- `undefined` means "never set"; `null` means "set to nothing on purpose". Mixing them up causes real bugs. A database column that is `NULL` maps to `null`; a function argument you forgot to pass is `undefined`.
- Numbers lose precision above `Number.MAX_SAFE_INTEGER` (about 9 quadrillion). Database IDs that large must be handled as `bigint` or strings, which is why some APIs return IDs as strings.

#### How a Senior Backend Engineer thinks about this

A senior picks the representation that makes wrong states impossible. Money is integer cents. A status is a small fixed set of strings, never a free-form string. A timestamp is stored as a proper date type, never "March 3rd" as text. The type you choose on day one decides which bugs are possible for the life of the system, so you choose it on purpose, not by accident.

#### Common mistakes

- Storing money as floating-point dollars. Use integer cents.
- Using `==` instead of `===` (covered in 1.1.3); `==` does surprising type coercion.
- Treating `undefined` and `null` as interchangeable, then crashing on `cancelledAt.getTime()` when `cancelledAt` is `null`.

#### Interview questions

1. **Why is `0.1 + 0.2 !== 0.3` in JavaScript?** Because numbers are IEEE 754 doubles and 0.1 cannot be represented exactly in binary, so the sum carries a tiny error. Follow-up: how do you store money? Integer cents, or a dedicated decimal type in the database.
2. **What is the difference between `null` and `undefined`?** `undefined` is the absence of assignment; `null` is an intentional empty value. Why it matters: database `NULL`s map to `null`, and conflating the two causes crashes.
3. **What does `typeof NaN` return, and how do you test for `NaN`?** `"number"`; test with `Number.isNaN`. Why it matters: a stray `NaN` from bad input silently poisons every calculation downstream.

#### Practical exercise

Write a function-free script (just variables and `console.log`) that computes the grand total of an order: subtotal 3499 cents, tax 280 cents, shipping 599 cents, minus a discount of 500 cents. Print the grand total in cents and also as a dollar string like `$38.78`. Acceptance criteria: the dollar string must always show exactly two decimal places, even for a total like 4000 cents (`$40.00`).

#### Worked answer to the exercise

```ts
// grand-total.ts: no functions, just variables and console.log.
const subtotalCents = 3499;
const taxCents = 280;
const shippingCents = 599;
const discountCents = 500;

// All the arithmetic happens in whole cents, so it is exact.
const grandTotalCents = subtotalCents + taxCents + shippingCents - discountCents;

// Divide by 100 only at the very end, for display, and force two decimals.
const grandTotalDollars = `$${(grandTotalCents / 100).toFixed(2)}`;

console.log(grandTotalCents);   // 3878
console.log(grandTotalDollars); // $38.78

// The acceptance check: a round total must still show two decimals.
const roundTotalCents = 4000;
console.log(`$${(roundTotalCents / 100).toFixed(2)}`); // $40.00
console.log(`$${roundTotalCents / 100}`);              // $40 (what you get without toFixed)
```

Run it with `npx tsx grand-total.ts`:

```text
3878
$38.78
$40.00
$40
```

Why it is right: every addition and subtraction works on whole numbers of cents, so there is no floating-point error to accumulate (3499 + 280 + 599 - 500 = 3878). Division by 100 happens exactly once, at the edge, only to make a string for a human. `toFixed(2)` always returns a string with exactly two digits after the decimal point, which is what turns `40` into `40.00`.

The trap most learners fall into is the last line: printing `grandTotalCents / 100` directly. It looks fine for `38.78` and then shows `$40` or `$40.5` the first time the total is round. The second trap is doing the maths in dollars (`34.99 + 2.80 + ...`) and formatting at the end; that works for some numbers and is off by a fraction of a cent for others (remember `0.1 + 0.2`). Also remember that `toFixed` returns a string: format once, at the end, and never do more arithmetic on the result.

Check it yourself: change `subtotalCents` to `3621`. The total becomes exactly 4000 cents, and the second line must print `$40.00`, not `$40`. In production you would usually format with `new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)`, which also adds thousands separators, but the rule stays the same: integer cents inside, formatting only at the edge.

### 1.1.2 Variables: let, const and the ghost of var

#### Concept

A variable is a named bin that holds a value. In modern JavaScript you declare variables with `const` or `let`. `const` means the bin's contents will not be reassigned. `let` means they might be. There is an older keyword, `var`, which you should never use in new code; we explain why so you recognize it in old code.

#### Why does it exist?

You need names so you can refer to a value more than once and so your code reads like a description of a problem rather than a soup of literals. `const freeShippingThresholdCents = 5000` tells the next reader (often you, in six months) what `5000` means. A magic number `5000` buried in a condition tells them nothing.

#### Mental model

`const` is a bin welded shut around one value — you can look inside, but you cannot swap the value for a different one. `let` is a bin with a lid you can open to put something new in. `var` is a bin that, bizarrely, teleports itself to the top of the room the moment the room is entered, which is why it causes confusing bugs.

#### How it works

```js
const maxRetries = 3;      // cannot be reassigned
let attempt = 0;           // will be reassigned in a loop
attempt = attempt + 1;     // fine

// maxRetries = 4;         // TypeError: Assignment to constant variable.
```

A crucial subtlety: `const` stops you from **reassigning the variable**, not from **changing the contents of an object** it points to. An object held by `const` can still have its properties changed.

```js
const order = { id: 'ord_1', status: 'pending' };
order.status = 'paid';     // ALLOWED: we changed a property, not the binding
// order = { id: 'ord_2' }; // NOT ALLOWED: reassigning the variable itself
```

This confuses every beginner once. `const` protects the arrow from the bin to the object, not the object.

`var` has two traps. It is **function-scoped**, not block-scoped, so a `var` declared inside an `if` block leaks out of the block. And it is **hoisted**: the declaration is moved to the top of the function, so you can reference a `var` before the line that declares it and get `undefined` instead of an error. Both behaviors cause bugs that `let` and `const` simply do not have.

```js
// Why var is dangerous:
function demo() {
  if (true) {
    var leaked = 'I escape the block';
  }
  console.log(leaked); // works with var; would be a ReferenceError with let
}
```

#### TypeScript angle

In TypeScript, `const` and `let` behave the same but the type checker infers tighter types for `const`. A `const status = 'paid'` has the literal type `'paid'`, while `let status = 'paid'` has the wider type `string`, because `let` might be reassigned. This matters when you build the small fixed sets of values we meet in 1.1.4.

#### Practical example

```ts
// A retry loop for calling a flaky payment provider.
const maxAttempts = 3;
let lastError: unknown = null;

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    // callProvider() is defined later in the book; imagine it here.
    // const result = await callProvider(order);
    // return result;
    break;
  } catch (err) {
    lastError = err;
    // wait and retry (covered in Part 2)
  }
}
```

`maxAttempts` is `const` because the policy does not change mid-loop. `attempt` and `lastError` are `let` because they change on every pass.

#### How a Senior Backend Engineer thinks about this

Default to `const`. Reach for `let` only when a value genuinely must change, which is less often than beginners expect — most loops that mutate a `let` accumulator can be written more clearly with array methods (1.4). A codebase full of `const` is a codebase where the reader knows, at a glance, which things move and which do not. That is a small, free form of documentation, and seniors value it.

#### Common mistakes

- Using `var` in new code. It has no advantage and several traps.
- Thinking `const` makes an object immutable. It does not; it only stops reassignment of the variable.
- Declaring `let` for values that never change, which forces the reader to wonder whether they do.

#### Interview questions

1. **What is the difference between `let`, `const` and `var`?** `let` and `const` are block-scoped and not hoisted in a usable way; `const` cannot be reassigned. `var` is function-scoped and hoisted, which causes leaks and confusing bugs.
2. **Can you mutate an object declared with `const`?** Yes — `const` protects the binding, not the object's contents. Follow-up: how do you make the contents read-only? `Object.freeze`, or TypeScript's `readonly` and `as const`.

#### Practical exercise

Take a buggy snippet that uses `var` inside a `for` loop to register three callbacks and prints `3, 3, 3` instead of `0, 1, 2`. Rewrite it with `let` so it prints `0, 1, 2`. Acceptance criteria: explain in one sentence why `let` fixes it (a fresh binding per iteration).

#### Worked answer to the exercise

```ts
// Buggy: var creates ONE binding for the whole loop, shared by every callback.
const buggy: Array<() => void> = [];
for (var i = 0; i < 3; i++) {
  buggy.push(() => console.log('var:', i));
}
buggy.forEach((callback) => callback()); // var: 3, var: 3, var: 3

// Fixed: let creates a fresh binding for each iteration.
const fixed: Array<() => void> = [];
for (let j = 0; j < 3; j++) {
  fixed.push(() => console.log('let:', j));
}
fixed.forEach((callback) => callback()); // let: 0, let: 1, let: 2
```

```text
var: 3
var: 3
var: 3
let: 0
let: 1
let: 2
```

The one sentence: with `let`, the loop creates a new binding of the loop variable for every iteration, so each callback closes over its own copy; with `var` there is a single function-wide binding, and by the time the callbacks run the loop has already pushed it to `3`.

Notice that the callbacks do not run inside the loop. They run afterwards, which is exactly what happens with `setTimeout`, event handlers or promise callbacks in a real server. `for (var i = 0; i < 3; i++) setTimeout(() => console.log(i), 0)` prints `3, 3, 3` for the same reason.

The trap: "fixing" it with `for (const i = 0; i < 3; i++)`. It looks consistent with "default to `const`", but `i++` reassigns the variable, so it throws `TypeError: Assignment to constant variable.` on the first increment. `const` is right in `for...of` (`for (const id of ids)`), where each iteration gets a new value and nothing is reassigned; a counting loop needs `let`.

Check it yourself: run the file with `npx tsx`, then change `let j` to `var j` in the fixed half and watch it print `3, 3, 3` again. That one-word change is the whole difference.

### 1.1.3 Equality, truthiness and coercion

#### Concept

JavaScript has two equality operators. `===` (strict equality) compares value and type with no conversion. `==` (loose equality) converts the operands to a common type first, with rules so surprising that professionals simply never use it. "Truthiness" is the set of rules for which values count as `true` in an `if`.

#### Why does it exist?

Early JavaScript tried to be forgiving, so `"5" == 5` is `true`. That forgiveness causes bugs: `0 == ""`, `null == undefined` and `[] == false` are all `true`, none of which you want. `===` exists to give you the predictable behavior you actually need.

#### How it works

```js
console.log(5 === 5);       // true
console.log('5' === 5);     // false: different types, no conversion
console.log('5' == 5);      // true: == converts the string to a number
console.log(null == undefined); // true (a rare useful case)
console.log(null === undefined); // false
```

Truthy and falsy: in an `if`, these eight values are **falsy** — `false`, `0`, `-0`, `0n`, `""` (empty string), `null`, `undefined`, and `NaN`. Everything else is **truthy**, including `"0"`, `"false"`, `[]` (empty array) and `{}` (empty object). That last pair trips up everyone: an empty array is truthy.

```js
if ([]) console.log('empty array is truthy'); // this prints
if ('0') console.log("the string '0' is truthy"); // this prints
```

#### Practical example

A common bug: checking whether a quantity was supplied.

```js
function describeQuantity(quantity) {
  // Bug: if quantity is 0, this treats it as "not supplied".
  if (!quantity) return 'no quantity';
  return `quantity is ${quantity}`;
}
console.log(describeQuantity(0)); // "no quantity" -- WRONG, 0 is a real quantity
```

Because `0` is falsy, `!quantity` is `true` for a legitimate zero. The fix is to test for the thing you actually mean:

```js
function describeQuantity(quantity) {
  if (quantity === undefined || quantity === null) return 'no quantity';
  return `quantity is ${quantity}`;
}
```

TypeScript helps here: `quantity ?? 'no quantity'` (the nullish coalescing operator `??`) falls back only for `null` or `undefined`, never for `0` or `""`. This is one of the most useful operators in backend code.

```ts
const shippingNote = order.note ?? 'no note';   // keeps '' if note is ''
const retries = config.retries ?? 3;            // keeps 0 if retries is 0
```

#### Edge cases & failure modes

- `!value` to check "is it missing" treats `0`, `""` and `false` as missing. Use `=== undefined`, `=== null`, or `??`.
- `NaN === NaN` is `false`, so `===` cannot detect `NaN`.
- Comparing objects with `===` compares identity, not contents: `{a:1} === {a:1}` is `false` because they are two different objects.

#### How a Senior Backend Engineer thinks about this

A senior reads `if (!x)` as a smell and asks "what exactly is being tested — null, undefined, zero, or empty?" Vague truthiness checks are a top source of production bugs where a legitimate zero or empty string is dropped. Be explicit about the condition you mean, and prefer `??` over `||` whenever `0`, `""` or `false` are valid values.

#### Common mistakes

- Using `==` and getting bitten by coercion.
- Using `||` for defaults when `0` or `""` are valid (`count || 10` turns a real `0` into `10`); use `??`.
- Comparing arrays or objects with `===` and expecting content comparison.

#### Interview questions

1. **What is the difference between `==` and `===`?** `===` compares without coercion; `==` coerces types first, with surprising rules. Always use `===`.
2. **Which values are falsy in JavaScript?** `false`, `0`, `-0`, `0n`, `""`, `null`, `undefined`, `NaN`. Follow-up: is `[]` truthy? Yes.
3. **When would you use `??` instead of `||`?** When `0`, `""` or `false` are legitimate values and only `null`/`undefined` should trigger the fallback.

#### Practical exercise

Write a function `getPageSize(requested)` that returns `requested` if it is a number between 1 and 100, and `20` otherwise. It must accept `0`? No — `0` is invalid here, so it falls back. But it must not accidentally reject a valid `1`. Acceptance criteria: `getPageSize(0)` returns `20`, `getPageSize(1)` returns `1`, `getPageSize(500)` returns `20`, `getPageSize(undefined)` returns `20`.

#### Worked answer to the exercise

```ts
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function getPageSize(requested: unknown): number {
  // Say exactly what "valid" means; never rely on truthiness.
  if (
    typeof requested === 'number' &&
    Number.isInteger(requested) && // also rejects NaN, Infinity and 2.5
    requested >= 1 &&
    requested <= MAX_PAGE_SIZE
  ) {
    return requested;
  }
  return DEFAULT_PAGE_SIZE;
}

console.log(getPageSize(0));         // 20
console.log(getPageSize(1));         // 1
console.log(getPageSize(100));       // 100
console.log(getPageSize(500));       // 20
console.log(getPageSize(undefined)); // 20
console.log(getPageSize(NaN));       // 20
console.log(getPageSize('50'));      // 20: a string is not a number
```

```text
20
1
100
20
20
20
20
```

Why it is right: the condition states the rule in full, "a whole number from 1 to 100", and everything else falls through to the default. Taking `unknown` instead of `number` means the function is safe even when someone passes a string or `undefined` from a query string. `Number.isInteger` quietly handles the odd cases too: `NaN`, `Infinity` and `2.5` are all rejected, because a page size of 2.5 rows makes no sense.

The trap most learners fall into is reaching for truthiness: `return requested || 20`. That happens to turn `0` into `20`, so it seems to pass the first test, but it lets `500` straight through and would let `-5` through as well. The second trap is checking only one bound (`requested > 0`) and forgetting the maximum, which in a real API is how a client asks for a million rows in one request.

A real request delivers `?limit=50` as the string `'50'`, which this function rejects on purpose: converting and validating input is the job of the request boundary (in NestJS, a DTO with `class-validator`, shown in 6.5), and this helper only accepts a number that has already been parsed.

Check it yourself: run the file and compare with the expected output, or replace the `console.log` lines with assertions so a wrong answer fails loudly:

```ts
import assert from 'node:assert/strict';
assert.equal(getPageSize(0), 20);
assert.equal(getPageSize(1), 1);
assert.equal(getPageSize(500), 20);
assert.equal(getPageSize(undefined), 20);
```

## 1.2 TypeScript types: the second half of the language

### 1.2.1 Why types, and basic type annotations

#### Concept

TypeScript lets you write down what type a variable, parameter or return value is supposed to be, and then a compiler checks that you never violate it. The types are erased before the code runs — Node never sees them — so types cost nothing at runtime. Their entire value is catching mistakes before the code ever runs.

#### Why does it exist?

In plain JavaScript, a typo like `order.totl` (missing an `a`) is `undefined` at runtime and crashes three functions later with a useless stack trace. A function that expects a number but receives a string fails deep inside some library. TypeScript catches both at the moment you write them, in your editor, with a red underline. On a backend of any size, this turns a whole category of 2 a.m. incidents into a squiggle you fix in two seconds.

#### Mental model

Think of TypeScript as a spell-checker for data shapes. A spell-checker does not change what you write; it underlines words that cannot be right. TypeScript underlines data flows that cannot be right — passing a string where a number is required, reading a property that does not exist, forgetting that a value might be `null`.

#### How it works

You add a type after a colon:

```ts
const orderTotalCents: number = 4299;
const currency: string = 'USD';
const isPaid: boolean = false;

function applyDiscount(totalCents: number, percent: number): number {
  return Math.round(totalCents * (1 - percent / 100));
}

applyDiscount(4299, 10);     // fine
// applyDiscount('4299', 10); // Error: string is not assignable to number
```

Most of the time you do not need to write the type, because TypeScript **infers** it. `const currency = 'USD'` is already known to be a string. The rule professionals follow: let TypeScript infer local variables, but always annotate function parameters and return types, because those are the contracts other code depends on.

#### The `any` escape hatch and why it is dangerous

`any` turns the type checker off for a value. It is the single most misused feature in TypeScript. The moment a value is `any`, every mistake involving it becomes invisible again.

```ts
let data: any = JSON.parse('{"total": 4299}');
data.total.toUpperCase(); // no error at compile time, crashes at runtime
```

Prefer `unknown` when you genuinely do not know the type yet. `unknown` forces you to check the type before using it, which is exactly what you want for data coming from the outside world (a request body, a JSON file, a third-party API).

```ts
let data: unknown = JSON.parse('{"total": 4299}');
// data.total;          // Error: data is unknown, you must narrow first
if (typeof data === 'object' && data !== null && 'total' in data) {
  // now TypeScript lets you proceed, after you have proven the shape
}
```

#### Practical example

A function that parses a price from a request. With `unknown` and narrowing, bad input is caught at the boundary instead of corrupting the database.

```ts
function parsePriceCents(input: unknown): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
    throw new Error('price must be a non-negative integer number of cents');
  }
  return input;
}
```

#### How a Senior Backend Engineer thinks about this

A senior treats `any` as technical debt and `unknown` as the honest tool for untrusted data. They turn on `strict` mode in `tsconfig.json` on day one, because without it TypeScript allows `null` to sneak into everything and most of the value is lost. The slogan is "parse, don't trust": every piece of data entering the system from outside is `unknown` until a validator has proven its shape, after which it is a precise type for the rest of its life.

#### Common mistakes

- Sprinkling `any` to make red squiggles disappear; this just defers the crash to runtime.
- Not enabling `strict` mode, which leaves `null` and `undefined` holes everywhere.
- Over-annotating obvious local variables, which adds noise without value.

#### Interview questions

1. **What is the difference between `any` and `unknown`?** `any` disables checking; `unknown` requires you to narrow the type before use. Use `unknown` for external data.
2. **Do TypeScript types exist at runtime?** No — they are erased during compilation. You cannot check `x instanceof SomeInterface`; interfaces do not exist at runtime.
3. **Why enable `strict` mode?** It turns on `strictNullChecks` and other flags that catch the largest class of real bugs (null/undefined access).

#### Practical exercise

Write a function `coerceStatus(input: unknown): 'pending' | 'paid' | 'cancelled'` that accepts an unknown value, checks it is one of the three allowed strings, and throws otherwise. Acceptance criteria: the return type is the exact union of three strings, and the function throws a clear error for any other input, including `'PAID'` in the wrong case.

#### Worked answer to the exercise

```ts
const ORDER_STATUSES = ['pending', 'paid', 'cancelled'] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number]; // 'pending' | 'paid' | 'cancelled'

function coerceStatus(input: unknown): OrderStatus {
  if (typeof input !== 'string') {
    throw new Error(`status must be a string, got ${typeof input}`);
  }
  // Find the allowed value that equals the input exactly (case-sensitive).
  const match = ORDER_STATUSES.find((status) => status === input);
  if (match === undefined) {
    throw new Error(
      `invalid status ${JSON.stringify(input)}; expected one of: ${ORDER_STATUSES.join(', ')}`,
    );
  }
  return match; // already typed OrderStatus, no cast needed
}

for (const input of ['paid', 'PAID', 'shipped', 42, null]) {
  try {
    console.log('ok    ', coerceStatus(input));
  } catch (err) {
    console.log('error ', (err as Error).message);
  }
}
```

```text
ok     paid
error  invalid status "PAID"; expected one of: pending, paid, cancelled
error  invalid status "shipped"; expected one of: pending, paid, cancelled
error  status must be a string, got number
error  status must be a string, got object
```

Why it is right: the list of allowed statuses is written once, as a read-only array (`as const`), and the type is derived from it, so the runtime check and the compile-time type can never drift apart. Adding `'refunded'` to the array updates both. `find` with `===` is case-sensitive, so `'PAID'` is rejected, and because `find` returns an element of the array, its type is already `OrderStatus`. The error message names the bad value and the allowed ones, which is what the person reading the log at 2 a.m. needs.

The trap most learners fall into is the cast: `if (typeof input === 'string') return input as OrderStatus;`. It compiles, the return type looks right, and `'shipped'` sails straight into your database. `as` tells the compiler to stop checking; it proves nothing. A second, smaller trap: `ORDER_STATUSES.includes(input)` does not compile, because `includes` on this array only accepts the three literal strings, not any `string`. That is why the answer uses `find`. Lower-casing the input "to be helpful" is a product decision, not a fix: the exercise asks you to reject `'PAID'`.

Check it yourself: run it and compare the five lines. Then hover over `coerceStatus` in your editor; the return type must read `'pending' | 'paid' | 'cancelled'`, not `string`.

## 1.3 Checkpoint: what you have so far

We covered values and the primitive types, why money lives in integer cents, variables with `const` and `let` (and why `var` is retired), equality and truthiness (and the `??` operator), and the opening ideas of TypeScript: annotations, inference, `any` versus `unknown`, and `strict` mode. The next sections build on this with functions, objects, arrays and the type tools that describe them — interfaces, generics and unions — which together let you model the nouns of a real backend.
