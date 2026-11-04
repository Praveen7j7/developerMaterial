## 71.3 Responses: status codes and headers

### 71.3.1 Status codes

#### Concept

Every HTTP response starts with a three-digit **status code** that says, at a glance, how the request went. `200` means "OK". `404` means "not found". `500` means "the server broke". The first digit groups them into five families, and knowing those families lets you understand any status code you have never seen.

#### Why does it exist?

The client needs a fast, standard way to know the outcome without parsing the whole response. A mobile app that gets a `401` knows to prompt for login; one that gets a `429` knows to slow down; one that gets a `503` knows to retry later. Status codes are the shared vocabulary of outcomes, so clients can react correctly without reading English error messages.

#### Mental model

Status codes are like the response you get when you mail a letter. `2xx` is "delivered and handled". `3xx` is "the recipient moved; here is the new address". `4xx` is "there is something wrong with your letter — wrong address, missing postage, you are not allowed to send this". `5xx` is "the post office itself broke". The first digit tells you whose fault it is and what to do next.

#### How it works — the five families

```text
1xx  Informational   rare; "continue"                     (you can mostly ignore)
2xx  Success         the request worked
3xx  Redirection     go somewhere else for the resource
4xx  Client error    the client did something wrong
5xx  Server error    the server failed
```

The ones you will use constantly:

| Code | Name | Meaning | When your backend sends it |
|---|---|---|---|
| 200 | OK | Success with a body | A successful `GET` or update |
| 201 | Created | A new resource was created | A successful `POST` that creates something |
| 204 | No Content | Success, no body | A successful `DELETE` |
| 301 | Moved Permanently | Resource has a new URL forever | Permanent redirects |
| 302 | Found | Temporary redirect | Temporary redirects |
| 304 | Not Modified | Your cached copy is still good | Conditional `GET` with ETags (Part 4) |
| 400 | Bad Request | The request is malformed or fails validation | Invalid JSON, missing required field |
| 401 | Unauthorized | You are not authenticated | No or invalid login token |
| 403 | Forbidden | You are authenticated but not allowed | A normal user hitting an admin endpoint |
| 404 | Not Found | The resource does not exist | Product id that is not in the database |
| 409 | Conflict | The request conflicts with current state | Duplicate unique value, version conflict |
| 422 | Unprocessable Entity | Well-formed but semantically invalid | Business-rule validation failure |
| 429 | Too Many Requests | You are being rate-limited | Client exceeded its request quota |
| 500 | Internal Server Error | The server threw an unexpected error | An unhandled exception |
| 502 | Bad Gateway | An upstream server gave a bad response | A proxy's backend failed |
| 503 | Service Unavailable | The server is temporarily down or overloaded | Maintenance, overload, failing health check |
| 504 | Gateway Timeout | An upstream server timed out | A downstream dependency hung |

The 401-versus-403 distinction trips up beginners. `401` means "I do not know who you are" — log in. `403` means "I know who you are, and you may not do this." The 400-versus-422 distinction: `400` is "I could not even understand your request" (broken JSON); `422` is "I understood it, but it breaks a rule" (ordering a negative quantity).

#### Practical example

```text
POST /v1/orders           -> 201 Created   (order placed, body has the new order)
GET  /v1/orders/missing   -> 404 Not Found (no such order)
POST /v1/orders (no auth) -> 401 Unauthorized
DELETE /v1/orders/1 (not yours) -> 403 Forbidden
POST /v1/orders (qty: -1) -> 422 Unprocessable Entity (validation)
(server bug)              -> 500 Internal Server Error
```

#### Production scenario

A monitoring dashboard watches the ratio of `5xx` responses. Normally it sits near zero. One afternoon it spikes to 8 percent, all `503`s from one service. Because status codes are standard, the alert fired automatically and the on-call engineer immediately knew the server was failing (5xx = server's fault), not that clients were sending bad requests (which would be 4xx). The clear separation of "client's fault" (4xx) from "server's fault" (5xx) is what makes this kind of automatic alerting possible, and it is why returning the correct code matters operationally, not just aesthetically.

#### Failure scenario

An API returned `200 OK` with a body like `{"error": "not found"}` for everything, including failures. The mobile app could not tell success from failure without parsing the body, caches stored error responses as if they were real data, and the monitoring dashboard showed a perfect `5xx` rate of zero while users were seeing constant errors. A whole outage went undetected for an hour because the status codes lied. The fix — return `404`, `422`, `500` correctly — made the errors visible to every layer that speaks HTTP. The lesson: the status code is not decoration; infrastructure depends on it being honest.

#### Edge cases & failure modes

- **Returning `200` for errors** (the lie above) breaks caching, monitoring and client logic.
- **Returning `500` for a client's bad input** pages the on-call for what is actually a `400`; separate client faults from server faults.
- **Returning `404` versus `403`** for a resource the user may not see: sometimes `404` is deliberately used to avoid revealing that a resource exists (Part 23).
- **Retrying `4xx`** is usually pointless (the request is wrong and will stay wrong); retrying `5xx` and `429` can help (the server may recover).

#### How a Senior Backend Engineer thinks about this

A senior is precise with status codes because machines, not just humans, read them: load balancers route on them, caches decide what to store by them, clients decide whether to retry by them, and dashboards alert on them. They keep the discipline that `5xx` means "our bug or outage" and `4xx` means "the caller's mistake", so the `5xx` rate is a clean signal of system health. They also return a consistent error body shape alongside the code (Part 8), so clients get both a machine-readable status and a human-readable reason.

#### Common mistakes

- Returning `200` with an error in the body.
- Using `500` for validation failures, which should be `400` or `422`.
- Mixing up `401` (not authenticated) and `403` (not allowed).
- Retrying `4xx` responses, which will keep failing.

#### Interview questions

1. **What is the difference between the `4xx` and `5xx` families?** `4xx` is the client's fault (bad request); `5xx` is the server's fault (it failed). This split drives monitoring, alerting and retry decisions.
2. **401 vs 403?** `401` means not authenticated (who are you?); `403` means authenticated but not permitted.
3. **400 vs 422?** `400` means the request could not be understood (malformed); `422` means it was understood but violates a rule.
4. **Which status codes are worth retrying?** `5xx` and `429` (the server may recover; back off first); `4xx` generally not, because the request itself is wrong.

#### Practical exercise

For a "create order" endpoint, list the status code you would return for each of: success, missing auth token, a normal user trying to create an order for another user, an unknown product id, a negative quantity, and an unexpected database error. Acceptance criteria: each maps to the correct code and you can justify the 400-vs-422 and 401-vs-403 choices.

### 71.3.2 Headers

#### Concept

Headers are key-value pairs attached to a request or response that carry information **about** the message rather than the message itself. "What format is the body?" "Who is sending this?" "Is the client allowed to cache this?" "Here is my authentication token." Headers answer all of these.

#### Why does it exist?

The body carries the data; everything else the client and server need to know about that data has to live somewhere. Headers are that somewhere — metadata that both sides understand without it polluting the actual content. Authentication, content type, caching, compression, language and dozens of other concerns are negotiated through headers.

#### How it works — the headers you will meet most

| Header | On | Purpose |
|---|---|---|
| `Content-Type` | both | What format the body is (`application/json`, `text/html`, `image/png`) |
| `Content-Length` | both | Size of the body in bytes |
| `Authorization` | request | Credentials, usually `Bearer <token>` (Part 21) |
| `Accept` | request | What formats the client can handle in the response |
| `Accept-Encoding` | request | Compression the client supports (`gzip`, `br`) |
| `Content-Encoding` | response | How the body is compressed |
| `Cache-Control` | response | Whether and how long to cache (Part 4, Part 16) |
| `ETag` | response | A version fingerprint for conditional requests |
| `Set-Cookie` | response | Tells the browser to store a cookie |
| `Cookie` | request | Sends stored cookies back |
| `Location` | response | Where to go, on a `201` (new resource) or `3xx` (redirect) |
| `X-Request-Id` | both | A trace id to follow one request across services (Part 35) |

`Content-Type` is the one you must always get right. When your API returns JSON, it must send `Content-Type: application/json`, or clients may misinterpret the bytes. When a client sends a JSON body, it must send the same header, or your server may not parse it.

#### Practical example

A request with headers and the matching response:

```text
POST /v1/orders HTTP/1.1
Host: api.shop.example.com
Authorization: Bearer eyJhbGci...        <- who the client is
Content-Type: application/json            <- the body is JSON
Accept: application/json                   <- send me JSON back
Accept-Encoding: gzip                      <- I can decompress gzip
X-Request-Id: 7f3c-...                      <- trace id

{"items":[{"productId":"42","quantity":2}]}
```

```text
HTTP/1.1 201 Created
Content-Type: application/json
Content-Encoding: gzip                      <- the body is gzipped
Location: /v1/orders/ord_1001               <- the new order's URL
Cache-Control: no-store                     <- do not cache this
X-Request-Id: 7f3c-...                       <- same trace id echoed back

{"id":"ord_1001","status":"pending","totalCents":2000}
```

#### Edge cases & failure modes

- **Wrong or missing `Content-Type`** so JSON is treated as plain text and parsing fails.
- **Trusting client-supplied headers** (like a `X-User-Id` the client sets) for security decisions; clients can send any header, so authentication must come from a verified token, not a self-declared header (Part 23).
- **Huge or many headers** can be rejected by proxies (there are size limits around 8 KB total).
- **Case and duplicates**: header names are case-insensitive; some headers can appear more than once.
- **Leaking information** in headers (server version, stack details) helps attackers; strip revealing headers in production.

#### How a Senior Backend Engineer thinks about this

A senior treats headers as a contract and a security surface at once. They always set `Content-Type` correctly, always propagate a request-id header for tracing across services, and never trust a client-set header for anything that matters — identity and permissions come from a verified token, period. They use `Cache-Control` deliberately (a private, user-specific response must be `no-store`; a public, shareable one can be cached), because a wrong cache header either leaks one user's data to another or wastes a caching opportunity (Part 16).

#### Common mistakes

- Forgetting `Content-Type: application/json`, breaking clients and parsers.
- Trusting a client-provided header (`X-User-Id`, `X-Role`) for authorization.
- Caching a user-specific response because of a loose `Cache-Control`, leaking data across users.
- Leaking server internals through verbose headers.

#### Interview questions

1. **What is the role of the `Content-Type` header?** It tells the receiver what format the body is in, so it can parse it correctly; JSON APIs must set `application/json`.
2. **Why must you never trust a client-set header for authorization?** Clients can send any header value, so a self-declared `X-User-Id` or `X-Role` is forgeable; identity must come from a server-verified token.
3. **Where does the authentication token usually go, and in what format?** In the `Authorization` request header, typically as `Bearer <token>`.
4. **Why propagate an `X-Request-Id` header?** To trace a single request across multiple services and logs, which is essential for debugging distributed systems (Part 35).

#### Practical exercise

Inspect the headers of a real API response in your browser's network tab. Identify the `Content-Type`, any caching header, and whether the response sets a cookie. Then explain why a response containing your personal account data should have `Cache-Control: no-store`. Acceptance criteria: you can read the headers and justify the caching choice for private data.

## 71.4 JSON: the data format of APIs

### 71.4.1 What JSON is and how to use it safely

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

In a real NestJS backend you do not write this by hand — you use DTOs with `class-validator` (Part 74), which does exactly this validation declaratively. But understanding what the framework does for you is the point: parse, then validate, then trust.

#### Edge cases & failure modes

- **Malformed JSON** from a client throws on `JSON.parse`; catch it and return `400`, do not let it crash the request.
- **Valid JSON, wrong shape** (missing fields, wrong types) parses fine but is invalid for your purpose; you must validate separately.
- **Numbers losing precision**: JSON numbers are floating-point, so a huge integer id (a 64-bit database id) can lose precision. Send such ids as strings.
- **`JSON.stringify` drops `undefined` and functions** and turns `Date` into an ISO string; parsing it back gives you a string, not a `Date`, which surprises people.
- **Deeply nested or huge JSON** can be slow to parse and can be used as a denial-of-service (a 50 MB body, or an object nested 100,000 levels deep); limit body size at the gateway (Part 23).
- **Circular references** (an object that contains itself) make `JSON.stringify` throw.

#### How a Senior Backend Engineer thinks about this

A senior treats every incoming JSON body as hostile until validated: parse it (catching malformed input as a `400`), then validate its shape and values against a schema before a single field reaches business logic. They cap body size to stop oversized-payload attacks. They send large integer ids as strings to avoid precision loss. They know `JSON.stringify` loses `undefined`, functions and `Date` types, so they map domain objects to explicit response shapes (Part 69) rather than stringifying raw internal objects, which both fixes the type issues and prevents leaking internal fields.

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
