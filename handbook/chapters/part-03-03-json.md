## 3.4 JSON: the data format of APIs

### 3.4.1 What JSON is and how to use it safely

#### Concept

JSON (JavaScript Object Notation) is a text format for structured data. It looks like JavaScript objects and arrays — curly braces for objects, square brackets for arrays, with strings, numbers, booleans and `null`. It is the format almost every modern API uses for request and response bodies, because it is human-readable, compact enough, and supported by every programming language.

#### Why does it exist?

A server written in TypeScript needs to send data to a mobile app written in Swift or Kotlin, or to a browser, or to another server written in Go. They need a shared text format that all of them can produce and parse. JSON won that role because it is simple, maps cleanly onto the basic data types every language has, and is easy for humans to read when debugging.

#### How it works

```json
{
  "id": "ord_1001",
  "status": "pending",
  "totalCents": 2000,
  "paid": false,
  "shippedAt": null,
  "items": [
    { "productId": "42", "quantity": 2 },
    { "productId": "99", "quantity": 1 }
  ],
  "customer": { "id": "usr_7", "email": "alice@example.com" }
}
```

The allowed value types are: **string** (double quotes only — single quotes are invalid JSON), **number**, **boolean** (`true`/`false`), **null**, **object** (`{}`), and **array** (`[]`). That is the whole list. Notably missing: dates (sent as strings, usually ISO 8601 like `"2026-11-04T09:30:00Z"`), comments (not allowed), and `undefined` (not a JSON value).

In JavaScript and TypeScript you convert between JSON text and objects with two built-in functions:

```ts
// Object -> JSON text (for sending in a response or request body)
const order = { id: 'ord_1001', totalCents: 2000 };
const text = JSON.stringify(order);   // '{"id":"ord_1001","totalCents":2000}'

// JSON text -> object (for reading a request body or a file)
const parsed = JSON.parse(text);      // { id: 'ord_1001', totalCents: 2000 }
```

#### Step by step: a full round trip, and what gets lost

Most JSON bugs happen at the edges: a value that does not survive the trip from object to text and back. Run this and compare each line with your guess.

```ts
const order = {
  id: 'ord_1001',
  createdAt: new Date('2026-11-04T09:30:00Z'),
  couponCode: undefined,                 // not set
  discountRate: NaN,                     // a bad calculation
  total() { return 2000; },              // a method
};

const text = JSON.stringify(order);
console.log(text);

const back = JSON.parse(text);
console.log(typeof back.createdAt, back.createdAt);   // a string, not a Date
console.log('couponCode' in back);                    // the key is gone entirely

// Big integer ids lose precision as JSON numbers.
console.log(JSON.parse('{"id": 9007199254740993}').id);
console.log(JSON.parse('{"id": "9007199254740993"}').id);

// A circular reference cannot be turned into JSON.
const customer: { name: string; lastOrder?: unknown } = { name: 'Alice' };
customer.lastOrder = { id: 'ord_1001', customer };
try {
  JSON.stringify(customer);
} catch (err) {
  console.log((err as Error).message.split('\n')[0]);
}

// Malformed JSON: single quotes are not allowed.
try {
  JSON.parse("{'id': 'ord_1001'}");
} catch (err) {
  console.log((err as Error).name + ': ' + (err as Error).message);
}
```

```text
{"id":"ord_1001","createdAt":"2026-11-04T09:30:00.000Z","discountRate":null}
string 2026-11-04T09:30:00.000Z
false
9007199254740992
9007199254740993
Converting circular structure to JSON
SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
```

Line by line:

1. **The `Date` became a string** in ISO 8601 format, in UTC (the `Z`). That is good for sending, but after `JSON.parse` it is still a string. If you want a `Date` back, convert it yourself: `new Date(back.createdAt)`.
2. **`couponCode: undefined` disappeared**, key and all. A client that checks `'couponCode' in body` will see `false`. If "no coupon" matters, send `null`, which JSON does keep.
3. **`NaN` became `null`.** So did `Infinity`. A silent `null` in a price field is how a bad calculation slips into a client's screen as "$0.00". Validate numbers before you send them.
4. **The method `total()` vanished.** JSON carries data, never behaviour.
5. **The big id changed** from `...993` to `...992`. JavaScript numbers hold integers exactly only up to 9,007,199,254,740,991 (`Number.MAX_SAFE_INTEGER`). PostgreSQL `bigint` ids can be larger, which is why such ids should travel as strings (the next line kept every digit).
6. **Circular data throws.** This happens in practice when you try to send an ORM entity whose relations point back at each other; map it to a plain response object first.
7. **Single quotes are invalid JSON.** The error says position 1, the `'` right after `{`. This is the error your server sees when a client hand-writes JSON badly, and the right response is `400 Bad Request`.

#### Practical example — parsing untrusted input safely

Here is the single most important JSON habit for a backend engineer: data parsed from the outside world is `unknown` and must be validated before you trust it. `JSON.parse` tells you the text was valid JSON; it does **not** tell you the data has the shape you expect.

```ts
function parseOrderRequest(bodyText: string): { productId: string; quantity: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);           // throws on malformed JSON -> 400
  } catch {
    throw new Error('body is not valid JSON');
  }
  // Validate the shape; do not trust it just because it parsed.
  if (
    typeof raw !== 'object' || raw === null ||
    typeof (raw as any).productId !== 'string' ||
    typeof (raw as any).quantity !== 'number' ||
    !Number.isInteger((raw as any).quantity) ||
    (raw as any).quantity <= 0
  ) {
    throw new Error('invalid order: productId (string) and positive integer quantity required');
  }
  return { productId: (raw as any).productId, quantity: (raw as any).quantity };
}
```

In a real NestJS backend you do not write this by hand — you use DTOs with `class-validator` (Part 6), which does exactly this validation declaratively. But understanding what the framework does for you is the point: parse, then validate, then trust.

#### Where the body text comes from

`parseOrderRequest` takes the body as a string, but a server does not receive one neat string. The body arrives over the network in **chunks** (pieces of bytes), and a plain `node:http` server has to collect them. This helper is what NestJS and Express do for you before your controller runs, including the most important protection: a size limit.

```ts
import type { IncomingMessage } from 'node:http';

// Collect the request body (it arrives in chunks), refusing anything over maxBytes.
async function readBody(req: IncomingMessage, maxBytes = 10_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
```

`for await` reads the stream one chunk at a time (an asynchronous loop, Part 2.4). The size check runs on every chunk, so a 50 MB upload is refused after the first 10 KB instead of being held in memory. The worked example in 3.7 uses this exact helper, and you will see it reject a 20 KB body with `413 Content Too Large`.

#### Edge cases & failure modes

- **Malformed JSON** from a client throws on `JSON.parse`; catch it and return `400`, do not let it crash the request.
- **Valid JSON, wrong shape** (missing fields, wrong types) parses fine but is invalid for your purpose; you must validate separately.
- **Numbers losing precision**: JSON numbers are floating-point, so a huge integer id (a 64-bit database id) can lose precision. Send such ids as strings.
- **`JSON.stringify` drops `undefined` and functions** and turns `Date` into an ISO string; parsing it back gives you a string, not a `Date`, which surprises people.
- **Deeply nested or huge JSON** can be slow to parse and can be used as a denial-of-service (a 50 MB body, or an object nested 100,000 levels deep); limit body size at the gateway (Part 40 — Security).
- **Circular references** (an object that contains itself) make `JSON.stringify` throw.

#### How a Senior Backend Engineer thinks about this

A senior treats every incoming JSON body as hostile until validated: parse it (catching malformed input as a `400`), then validate its shape and values against a schema before a single field reaches business logic. They cap body size to stop oversized-payload attacks. They send large integer ids as strings to avoid precision loss. They know `JSON.stringify` loses `undefined`, functions and `Date` types, so they map domain objects to explicit response shapes (Part 13.23) rather than stringifying raw internal objects, which both fixes the type issues and prevents leaking internal fields.

#### Common mistakes

- Trusting parsed JSON without validating its shape ("it parsed, so it must be fine").
- Letting `JSON.parse` throw crash the request instead of returning `400`.
- Sending 64-bit ids as JSON numbers and losing precision.
- Expecting a `Date` back after `JSON.parse` (you get a string).
- No body-size limit, allowing huge-payload denial-of-service.

#### Interview questions

1. **What value types does JSON support?** String (double-quoted), number, boolean, null, object, array. No dates (sent as strings), no comments, no `undefined`.
2. **Why must you validate JSON after parsing it?** `JSON.parse` only confirms the text is valid JSON, not that the data has the expected fields and types; untrusted input must be validated before use.
3. **Why might a large integer id be wrong after a round-trip through JSON?** JSON numbers are floating-point, so integers beyond ~9 quadrillion lose precision; send them as strings.
4. **What happens to a `Date` and to `undefined` when you `JSON.stringify` and `JSON.parse`?** A `Date` becomes an ISO string and does not come back as a `Date`; `undefined` properties are dropped entirely.

#### Practical exercise

Write `safeParse(text)` that returns a discriminated union `{ ok: true, value } | { ok: false, error }`, returning an error for malformed JSON instead of throwing. Then extend it to validate that the parsed value is an object with a string `email` and a positive integer `quantity`. Acceptance criteria: malformed JSON, a non-object, and a valid-JSON-but-wrong-shape input each return a clear `{ ok: false }` with a useful message.

#### Worked answer to the exercise

```ts
type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
type OrderRequest = { email: string; quantity: number };

function safeParse(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `malformed JSON: ${(err as Error).message}` };
  }
}

function parseOrderRequest(text: string): ParseResult<OrderRequest> {
  const parsed = safeParse(text);
  if (!parsed.ok) return parsed;

  const raw = parsed.value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const { email, quantity } = raw as Record<string, unknown>;
  if (typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, error: 'email must be a string containing @' };
  }
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, error: 'quantity must be a positive integer' };
  }
  return { ok: true, value: { email, quantity } };
}

const inputs = [
  '{"email":"alice@example.com","quantity":2}',
  '{"email":"alice@example.com","quantity":2',      // missing closing brace
  '[1, 2, 3]',                                       // valid JSON, not an object
  '{"email":"alice@example.com","quantity":"2"}',    // quantity is a string
  '{"email":"alice@example.com","quantity":-1}',     // negative
];
for (const input of inputs) console.log(parseOrderRequest(input));
```

```text
{ ok: true, value: { email: 'alice@example.com', quantity: 2 } }
{
  ok: false,
  error: "malformed JSON: Expected ',' or '}' after property value in JSON at position 41 (line 1 column 42)"
}
{ ok: false, error: 'body must be a JSON object' }
{ ok: false, error: 'quantity must be a positive integer' }
{ ok: false, error: 'quantity must be a positive integer' }
```

Three choices in this answer are worth copying:

- **Two layers.** `safeParse` only answers "is this JSON?"; `parseOrderRequest` answers "is this an order?". They map to two different status codes: malformed JSON is `400`, a wrong shape is `400` or `422` (3.3.1).
- **`Array.isArray(raw)` is checked.** `typeof [1, 2, 3]` is `'object'`, so without that check an array would slip through as "an object".
- **`"2"` is rejected.** A string that looks like a number is not a number. Silently converting it would hide a broken client. (NestJS's `ValidationPipe` can be told to convert types on purpose with `transform: true`; that is a decision, not an accident.)

#### Try it yourself

1. What does `JSON.stringify({ items: [] , note: null, gift: undefined })` produce?
2. Is `"hello"` (with the quotes) valid JSON on its own? Is `hello`?
3. A client sends `{"priceCents": 12.5}`. It parses fine. Is it valid for a field that stores integer cents, and which check from the worked answer would catch it?

**Answers.** 1: `{"items":[],"note":null}`; the empty array and `null` survive, `undefined` is dropped. 2: `"hello"` is valid JSON (a lone string is a complete JSON value), so `JSON.parse('"hello"')` returns `hello`; bare `hello` is not valid and throws. 3: It is not valid; half a cent does not exist. `Number.isInteger(12.5)` is `false`, so the integer check catches it.
