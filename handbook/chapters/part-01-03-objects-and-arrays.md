## 1.5 Objects and arrays

### 1.5.1 Objects: grouping related data

#### Concept

An object is a collection of named values. Each name is a **property** (or **key**), and each property holds a value. Objects are how you represent a thing with several attributes — an order has an id, a status, a total and a list of items, so an order is naturally an object.

#### Why does it exist?

Primitives hold one value each. Real things have many attributes that belong together. Passing around five separate variables for one order (`orderId`, `orderStatus`, `orderTotal`, ...) is error-prone; passing one `order` object keeps them together and named. Objects are the backbone of every API request and response, because JSON — the format APIs speak — is objects and arrays.

#### Mental model

An object is a labelled drawer unit. Each small drawer has a label on the front (the key) and holds one thing (the value). You open the drawer by its label: `order.status` opens the drawer labelled `status`.

#### How it works

```ts
const order = {
  id: 'ord_1001',
  status: 'pending',
  totalCents: 4299,
  customer: {                      // a nested object
    id: 'usr_42',
    email: 'alice@example.com',
  },
};

// Reading properties: two ways.
console.log(order.status);          // dot notation: "pending"
console.log(order['status']);       // bracket notation: same thing
console.log(order.customer.email);  // reaching into a nested object

// Writing properties
order.status = 'paid';              // change an existing one
// order.trackingNumber = 'XZ99';   // in plain JS you can add new ones freely
```

Bracket notation matters when the key is in a variable: `order[fieldName]` where `fieldName` is `'status'`. Dot notation needs a literal key.

**Destructuring** pulls properties out into variables in one line. You will use this constantly.

```ts
const { status, totalCents } = order;      // two new variables
console.log(status, totalCents);           // "paid" 4299

// Rename while destructuring, with a default:
const { status: orderStatus, giftWrap = false } = order;
```

**Spread** copies properties from one object into another. It is the standard way to make a changed copy without mutating the original.

```ts
const paidOrder = { ...order, status: 'paid', paidAt: new Date() };
// order is unchanged; paidOrder is a new object with status overridden
```

#### Typing objects with interfaces and type aliases

In TypeScript you describe an object's shape with an **interface** or a **type alias**. They are nearly interchangeable for this purpose; teams usually pick one and stay consistent.

```ts
interface Order {
  id: string;
  status: 'pending' | 'paid' | 'cancelled';  // a union of literals
  totalCents: number;
  customer: Customer;
  trackingNumber?: string;                    // optional
  readonly createdAt: Date;                   // cannot be reassigned
}

interface Customer {
  id: string;
  email: string;
}

// The same thing as a type alias:
type OrderStatus = 'pending' | 'paid' | 'cancelled';
```

Now TypeScript enforces the shape. Reading `order.totl` is an error. Assigning `status = 'shipped'` is an error, because `'shipped'` is not in the union. Forgetting `totalCents` when building an order is an error. This is the type system doing its job: the shape of your core nouns becomes impossible to get wrong.

#### Practical example

Turning a database row into an API response, dropping internal fields.

```ts
interface OrderRow {
  id: string;
  status: OrderStatus;
  total_cents: number;    // snake_case from the database
  internal_notes: string; // must NOT go to the client
  created_at: Date;
}

interface OrderResponse {
  id: string;
  status: OrderStatus;
  totalCents: number;     // camelCase for the API
  createdAt: string;      // ISO string for JSON
}

function toResponse(row: OrderRow): OrderResponse {
  return {
    id: row.id,
    status: row.status,
    totalCents: row.total_cents,
    createdAt: row.created_at.toISOString(),
    // internal_notes is deliberately not copied
  };
}
```

This "mapper" pattern — convert a database row to a response shape — is one you will write hundreds of times. Doing it explicitly (rather than returning the raw row) is how you avoid leaking internal fields like `internal_notes` or a password hash to clients, which is a real and common security bug.

#### Edge cases & failure modes

- **Mutation surprises.** Objects are passed by reference. If function A changes a property of an object that function B still holds, B sees the change. The spread copy (`{ ...order }`) makes a **shallow** copy — one level deep. Nested objects are still shared. For a deep copy use `structuredClone(order)` (built into modern Node).
- **Accessing a property of `null`/`undefined`** throws `Cannot read properties of undefined (reading 'email')`. Use optional chaining `order.customer?.email`, which yields `undefined` instead of throwing if `customer` is missing.
- **Key order** is mostly preserved but should not be relied on for logic. Treat objects as unordered maps of key to value.

#### How a Senior Backend Engineer thinks about this

A senior defines the core domain objects (`Order`, `Customer`, `Product`) as interfaces first, before writing much logic, because those shapes are the contract everything else depends on. They keep separate types for the database row, the internal domain object, and the API response, and they map between them on purpose — never returning a raw database row to a client, never trusting a raw request body as a domain object. They prefer making changed copies with spread over mutating in place, because shared mutable objects cause the bugs that are hardest to trace.

#### Common mistakes

- Returning raw database rows to clients, leaking internal or sensitive fields.
- Mutating an object that other code still holds, causing spooky action at a distance.
- Forgetting that spread is a shallow copy and mutating a nested object inside the "copy".
- Crashing on `obj.a.b` when `a` might be missing; use `obj.a?.b`.

#### Interview questions

1. **What does spread (`{ ...obj }`) do, and is it a deep copy?** It copies top-level properties into a new object; it is a shallow copy, so nested objects are shared.
2. **How do you safely read a deeply nested property that might be missing?** Optional chaining: `a?.b?.c`, which yields `undefined` instead of throwing.
3. **Why map a database row to a response object instead of returning it directly?** To control which fields leave the system (security) and to translate naming and date formats for the API contract.

#### Practical exercise

Write a function `publicProfile(user)` where the user object has `id`, `email`, `passwordHash` and `createdAt`. Return an object with only `id`, `email` and `createdAt` (as an ISO string), and prove with a TypeScript type that `passwordHash` cannot appear in the return type. Acceptance criteria: changing the function to include `passwordHash` must cause a compile error.

### 1.5.2 Arrays and the methods you will actually use

#### Concept

An array is an ordered list of values. An order has a list of items; a page of results is a list of orders; a user has a list of addresses. Arrays hold those lists. The array **methods** — functions that live on every array — are how you transform lists without writing manual loops, and they are the single most-used tool in day-to-day backend code.

#### Why does it exist?

Almost all backend work is "take a list, turn it into another list, or boil it down to one value". Take the order items, turn each into a line total (a transform), keep only the in-stock ones (a filter), and sum them (a reduction). You could write `for` loops for all of this, but the array methods say what you mean in one readable line and avoid the off-by-one errors manual loops are famous for.

#### Mental model

Imagine an assembly line. `map` is a station that does the same operation to every item and passes each along (10 items in, 10 items out). `filter` is a gate that lets some items through and drops others (10 in, maybe 6 out). `reduce` is the station at the end that combines everything into a single result (10 in, 1 out). `find` is a worker who grabs the first item matching a description and stops looking.

#### How it works — the core methods

```ts
interface Item { productId: string; quantity: number; priceCents: number; inStock: boolean; }

const items: Item[] = [
  { productId: 'p1', quantity: 2, priceCents: 1000, inStock: true },
  { productId: 'p2', quantity: 1, priceCents: 2500, inStock: false },
  { productId: 'p3', quantity: 3, priceCents: 500, inStock: true },
];

// map: transform each element. Here, item -> line total in cents.
const lineTotals = items.map((item) => item.quantity * item.priceCents);
// [2000, 2500, 1500]

// filter: keep elements that pass a test.
const available = items.filter((item) => item.inStock);
// [p1, p3]

// reduce: collapse to one value. The 0 is the starting accumulator.
const subtotalCents = items.reduce((sum, item) => sum + item.quantity * item.priceCents, 0);
// 6000

// find: first element matching a test, or undefined.
const expensive = items.find((item) => item.priceCents >= 2000);
// the p2 item

// some / every: do any / do all match?
const hasOutOfStock = items.some((item) => !item.inStock); // true
const allHaveQuantity = items.every((item) => item.quantity > 0); // true

// sort: reorder. The comparator returns negative, zero or positive.
const byPriceAsc = [...items].sort((a, b) => a.priceCents - b.priceCents);
```

Two rules that save you from bugs: `map`, `filter`, `some`, `every`, `find`, `reduce` do **not** change the original array — they return a new array or value. But `sort` and `reverse` **mutate the original**, which is why we copy first with `[...items]` before sorting. Forgetting this and sorting an array that other code depends on is a real production bug.

#### Chaining

Methods return arrays (except reduce/find/some/every), so you can chain them into a readable pipeline:

```ts
const inStockSubtotalCents = items
  .filter((item) => item.inStock)
  .map((item) => item.quantity * item.priceCents)
  .reduce((sum, n) => sum + n, 0);
// filter to in-stock, turn each into a line total, sum them -> 3500
```

Read it top to bottom as a sentence: "of the items, keep the in-stock ones, turn each into a line total, and add them up." That readability is the whole point.

#### Typing arrays

```ts
const ids: string[] = ['a', 'b', 'c'];       // array of strings
const totals: number[] = [100, 200];          // array of numbers
const orders: Order[] = [];                    // array of Order objects
const matrix: number[][] = [[1, 2], [3, 4]];   // array of arrays
```

#### Practical example — building an order summary

```ts
interface CartLine { productId: string; name: string; unitCents: number; qty: number; }

function summarize(lines: CartLine[]) {
  const subtotalCents = lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const names = lines.map((l) => l.name);
  return { subtotalCents, itemCount, names };
}
```

#### Production scenario

An endpoint returns the top 10 products by revenue for a dashboard. You fetch the raw sales rows, `map` each to `{ productId, revenue }`, `reduce` into a per-product total using an object keyed by product id, turn that back into an array, `sort` by revenue descending, and `slice(0, 10)`. The whole transformation is maybe eight lines and reads like its own description. The alternative — nested `for` loops with manual index bookkeeping — is longer, harder to read, and where off-by-one bugs live.

#### Failure scenario

At 09:00 a reporting endpoint starts returning the wrong order of results intermittently. The cause: the code called `allOrders.sort(...)` on an array that was also cached and shared across requests. `sort` mutated the shared array in place, so two concurrent requests sorting by different fields corrupted each other's data. The fix was one character of intent: `[...allOrders].sort(...)`, sorting a copy. The lesson — know which methods mutate — is exactly the kind of thing that separates working code from correct code.

#### Edge cases & failure modes

- `sort` without a comparator sorts **as strings**, so `[10, 2, 1].sort()` gives `[1, 10, 2]`. Always pass `(a, b) => a - b` for numbers.
- `find` returns `undefined` when nothing matches; using the result without checking throws.
- `reduce` with no initial value throws on an empty array; always pass the initial accumulator.
- `map` over a huge array builds a whole second array in memory; for millions of rows, stream instead (Part 9).

#### How a Senior Backend Engineer thinks about this

A senior reaches for `map`/`filter`/`reduce` by default and writes a manual `for` loop only when they need early exit for performance, or index arithmetic, or when the loop body has side effects that read awkwardly in a method. They always pass a comparator to `sort`, always copy before sorting shared data, and always provide reduce's initial value. They are also aware of the cost: these methods create new arrays, which is fine for a cart of 20 items and wrong for a stream of 20 million, where they switch to streaming.

#### Common mistakes

- `sort` without a comparator (string sort) on numbers.
- Sorting a shared array in place and corrupting other code.
- Using `find`'s result without handling `undefined`.
- `reduce` with no initial value on a possibly-empty array.
- Reaching for `forEach` to build a result, mutating an outer variable, when `map` or `reduce` says it more clearly.

#### Interview questions

1. **What is the difference between `map` and `forEach`?** `map` returns a new array of transformed values; `forEach` returns nothing and is used only for side effects. Prefer `map` when you want a result.
2. **Which array methods mutate the original?** `sort`, `reverse`, `splice`, `push`, `pop`, `shift`, `unshift`, `fill`. The transforming methods (`map`, `filter`, `slice`, `concat`) do not.
3. **How does `sort` order values by default, and why is that a trap?** Lexicographically (as strings), so numbers sort wrong without a comparator.
4. **What does `reduce` do and what is its initial value for?** It collapses an array to one value by repeatedly combining; the initial value seeds the accumulator and prevents errors on empty arrays.

#### Practical exercise

Given an array of order objects each with `status` and `totalCents`, write one chained expression that computes the total revenue of only the `'paid'` orders. Then write a second expression that returns the three highest-value paid orders. Acceptance criteria: the original array is not mutated, and both handle an empty input array without throwing.

### 1.5.3 Maps, Sets and when to use them

#### Concept

A `Map` is a collection of key-value pairs where keys can be any type (not just strings). A `Set` is a collection of unique values. They complement objects and arrays: use a `Map` for a lookup table, a `Set` for "have I seen this before?".

#### How it works

```ts
// Map: fast lookup by key.
const priceByProduct = new Map<string, number>();
priceByProduct.set('p1', 1000);
priceByProduct.set('p2', 2500);
priceByProduct.get('p1');        // 1000
priceByProduct.has('p3');        // false
priceByProduct.size;             // 2

// Set: uniqueness and membership tests.
const seenOrderIds = new Set<string>();
seenOrderIds.add('ord_1');
seenOrderIds.add('ord_1');       // ignored, already present
seenOrderIds.has('ord_1');       // true
seenOrderIds.size;               // 1

// De-duplicate an array in one line:
const unique = [...new Set(['a', 'b', 'a', 'c'])]; // ['a', 'b', 'c']
```

#### How a Senior Backend Engineer thinks about this

Reaching the right collection is a small decision with a real performance consequence. Checking `array.includes(x)` scans the whole array every time (slow for large lists); a `Set.has(x)` is near-instant. Building a lookup by scanning an array inside a loop is accidentally quadratic; building a `Map` once and looking up is linear. For the data structures behind these (hash tables), see Part 7; here, the habit is: list of things to iterate is an array, lookup by key is a `Map`, uniqueness or membership is a `Set`.

#### Interview questions

1. **When would you use a `Map` instead of a plain object?** When keys are not strings, when you need reliable insertion order and size, or when you add and remove keys frequently. Objects are fine for fixed, string-keyed shapes.
2. **Why is `Set.has` better than `array.includes` for repeated membership tests?** `Set.has` is roughly constant time; `array.includes` scans the array each call, which is slow for large lists and can make an algorithm quadratic.

#### Practical exercise

You have 100,000 order IDs already processed (in an array) and a new batch of 10,000. Write code that returns only the new batch IDs not already processed, using a `Set` so it runs in linear time. Acceptance criteria: do not use `array.includes` inside a loop.
