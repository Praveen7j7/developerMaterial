## 3.3 Responses: status codes and headers

### 3.3.1 Status codes

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
| 304 | Not Modified | Your cached copy is still good | Conditional `GET` with ETags (Part 11.11) |
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

#### Reading a status code you have never seen

You will meet codes that are not in the table. Do not panic and do not guess from the number alone; use the family first, then the name. Here is the method applied to three real codes:

1. **`413 Content Too Large`.** First digit 4: the client did something wrong. The name says the body was too big. So the fix is on the client side: send a smaller file, or upload it a different way. Retrying the same request will fail the same way.
2. **`307 Temporary Redirect`.** First digit 3: go somewhere else. The `Location` header says where. Unlike `302`, a `307` promises the client will repeat the **same method and body** at the new address, which matters for a `POST`.
3. **`507 Insufficient Storage`.** First digit 5: the server's problem. The client did nothing wrong. It may be worth retrying later, and someone on the server side should be alerted.

The official list is the IANA HTTP Status Code Registry (most codes are defined in RFC 9110), and MDN's "HTTP response status codes" page explains each one in plain language. Part 15.4 discusses which codes a well-designed API actually uses.

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
- **Returning `404` versus `403`** for a resource the user may not see: sometimes `404` is deliberately used to avoid revealing that a resource exists (Part 40.12).
- **Retrying `4xx`** is usually pointless (the request is wrong and will stay wrong); retrying `5xx` and `429` can help (the server may recover).

#### How a Senior Backend Engineer thinks about this

A senior is precise with status codes because machines, not just humans, read them: load balancers route on them, caches decide what to store by them, clients decide whether to retry by them, and dashboards alert on them. They keep the discipline that `5xx` means "our bug or outage" and `4xx` means "the caller's mistake", so the `5xx` rate is a clean signal of system health. They also return a consistent error body shape alongside the code (Part 15), so clients get both a machine-readable status and a human-readable reason.

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

#### Worked answer to the exercise

| Situation | Code | Why |
|---|---|---|
| Order created | `201 Created` | A new resource exists; send its URL in `Location` and the order in the body |
| No auth token | `401 Unauthorized` | We do not know who the caller is |
| Normal user creating an order for another user | `403 Forbidden` | We know who they are; they are not allowed to do this |
| Unknown product id in the body | `422 Unprocessable Entity` | The request is well formed and the URL `/v1/orders` exists; the content breaks a rule ("the product must exist"). Some teams use `400` or `404` here; whichever you choose, be consistent and say so in the error body |
| Negative quantity | `422 Unprocessable Entity` (or `400`) | Valid JSON, invalid value. Many NestJS apps return `400` for all validation failures, because that is what `ValidationPipe` does by default (Part 6); that is also acceptable if it is consistent |
| Unexpected database error | `500 Internal Server Error` | Our fault, not the client's; log it with the request id and alert on the rate |

The justification the exercise asked for: `401` and `403` differ in **whether we know who you are**; `400` and `422` differ in **whether we could understand the request at all**.

#### Try it yourself

Give the status code for each response from an e-commerce API.

1. `GET /v1/products/42` and the product exists.
2. `DELETE /v1/cart/items/7` succeeded and there is nothing useful to send back.
3. A client sent `{"quantity": 2` (the closing brace is missing).
4. A client sent 500 requests in one minute and the limit is 100.
5. `POST /v1/users` with an email that is already registered.
6. Your API called the payment provider and the provider did not answer within 10 seconds.
7. The product page moved from `/products/42` to `/p/dental-mirror-42` for good.

**Answers.** 1: `200 OK`. 2: `204 No Content`. 3: `400 Bad Request`, because the JSON cannot be parsed at all. 4: `429 Too Many Requests`, ideally with a `Retry-After` header saying when to try again. 5: `409 Conflict`, because the request conflicts with existing data (a unique email). 6: `504 Gateway Timeout` is the most precise (a server you depend on did not answer in time); some teams use `503`. Either way it is a `5xx`, because the client did nothing wrong. 7: `301 Moved Permanently` with `Location: /p/dental-mirror-42`.

### 3.3.2 Headers

#### Concept

Headers are key-value pairs attached to a request or response that carry information **about** the message rather than the message itself. "What format is the body?" "Who is sending this?" "Is the client allowed to cache this?" "Here is my authentication token." Headers answer all of these.

#### Why does it exist?

The body carries the data; everything else the client and server need to know about that data has to live somewhere. Headers are that somewhere — metadata that both sides understand without it polluting the actual content. Authentication, content type, caching, compression, language and dozens of other concerns are negotiated through headers.

#### How it works — the headers you will meet most

| Header | On | Purpose |
|---|---|---|
| `Content-Type` | both | What format the body is (`application/json`, `text/html`, `image/png`) |
| `Content-Length` | both | Size of the body in bytes |
| `Authorization` | request | Credentials, usually `Bearer <token>` (Part 40.3) |
| `Accept` | request | What formats the client can handle in the response |
| `Accept-Encoding` | request | Compression the client supports (`gzip`, `br`) |
| `Content-Encoding` | response | How the body is compressed |
| `Cache-Control` | response | Whether and how long to cache (Part 11.11, Part 27) |
| `ETag` | response | A version fingerprint for conditional requests |
| `Set-Cookie` | response | Tells the browser to store a cookie |
| `Cookie` | request | Sends stored cookies back |
| `Location` | response | Where to go, on a `201` (new resource) or `3xx` (redirect) |
| `X-Request-Id` | both | A trace id to follow one request across services (Part 43.4) |

`Content-Type` is the one you must always get right. When your API returns JSON, it must send `Content-Type: application/json`, or clients may misinterpret the bytes. When a client sends a JSON body, it must send the same header, or your server may not parse it.

#### See it yourself: setting and reading headers

This single script starts a small server, sends it a request with headers, and prints what each side sees. It shows three facts beginners often get wrong.

```ts
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const server = createServer((req, res) => {
  // Node gives you request header names in lowercase, whatever case the client used.
  console.log('server sees:', {
    'content-type': req.headers['content-type'],
    'x-user-id': req.headers['x-user-id'],
  });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');               // private data: never cache
  res.setHeader('X-Request-Id', req.headers['x-request-id'] ?? randomUUID());
  res.statusCode = 201;
  res.end(JSON.stringify({ id: 'ord_1001', status: 'pending' }));
});
await new Promise<void>((resolve) => server.listen(4021, resolve));

const res = await fetch('http://localhost:4021/v1/orders', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-User-Id': 'usr_1',            // anyone can type this; it proves nothing
    'X-Request-Id': 'req-7f3c',
  },
  body: JSON.stringify({ items: [{ productId: '42', quantity: 2 }] }),
});

console.log('client sees:', res.status, {
  'content-type': res.headers.get('CONTENT-TYPE'),          // lookups ignore case too
  'cache-control': res.headers.get('cache-control'),
  'x-request-id': res.headers.get('x-request-id'),
});
server.close();
```

```text
server sees: { 'content-type': 'application/json', 'x-user-id': 'usr_1' }
client sees: 201 {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-request-id': 'req-7f3c'
}
```

1. **Header names ignore case.** The client wrote `X-User-Id`; Node's `req.headers` stores it as `x-user-id`. The client asked for `CONTENT-TYPE`; `res.headers.get` found `Content-Type`. Always read request headers in lowercase in Node.
2. **Any client can send any header.** The server happily received `x-user-id: usr_1`. Nothing checked it. If your code trusted that header, anyone with curl could become user 1 by typing `curl -H "X-User-Id: usr_1" ...`. Identity must come from something the server can verify, like a signed token (Part 40.3).
3. **The request id travels both ways.** The server echoed the client's `X-Request-Id`, or made a new one with `randomUUID()` if there was none. Log that id on every line, and you can follow one request through every service it touches.

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
- **Trusting client-supplied headers** (like a `X-User-Id` the client sets) for security decisions; clients can send any header, so authentication must come from a verified token, not a self-declared header (Part 40 — Security).
- **Huge or many headers** can be rejected by proxies and servers (limits are often 8 to 16 KB in total; Node's default is 16 KB).
- **Case and duplicates**: header names are case-insensitive; some headers can appear more than once.
- **Leaking information** in headers (server version, stack details) helps attackers; strip revealing headers in production.

#### How a Senior Backend Engineer thinks about this

A senior treats headers as a contract and a security surface at once. They always set `Content-Type` correctly, always propagate a request-id header for tracing across services, and never trust a client-set header for anything that matters — identity and permissions come from a verified token, period. They use `Cache-Control` deliberately (a private, user-specific response must be `no-store`; a public, shareable one can be cached), because a wrong cache header either leaks one user's data to another or wastes a caching opportunity (Part 27).

#### Common mistakes

- Forgetting `Content-Type: application/json`, breaking clients and parsers.
- Trusting a client-provided header (`X-User-Id`, `X-Role`) for authorization.
- Caching a user-specific response because of a loose `Cache-Control`, leaking data across users.
- Leaking server internals through verbose headers.

#### Interview questions

1. **What is the role of the `Content-Type` header?** It tells the receiver what format the body is in, so it can parse it correctly; JSON APIs must set `application/json`.
2. **Why must you never trust a client-set header for authorization?** Clients can send any header value, so a self-declared `X-User-Id` or `X-Role` is forgeable; identity must come from a server-verified token.
3. **Where does the authentication token usually go, and in what format?** In the `Authorization` request header, typically as `Bearer <token>`.
4. **Why propagate an `X-Request-Id` header?** To trace a single request across multiple services and logs, which is essential for debugging distributed systems (Part 43 — Observability).

#### Practical exercise

Inspect the headers of a real API response in your browser's network tab. Identify the `Content-Type`, any caching header, and whether the response sets a cookie. Then explain why a response containing your personal account data should have `Cache-Control: no-store`. Acceptance criteria: you can read the headers and justify the caching choice for private data.

#### Worked answer to the exercise

Open DevTools (F12 or Cmd+Option+I), go to the **Network** tab, reload the page, click an API request (filter by "Fetch/XHR"), and look at **Response Headers**. On a typical shop's product API you might find `content-type: application/json; charset=utf-8`, `cache-control: public, max-age=60` (anyone may cache this for 60 seconds) and no `set-cookie`. On a login response you would find a `set-cookie` with `HttpOnly; Secure; SameSite=Lax`. (Part 69.10 is a full tour of these panels.)

The caching justification: a response with your account data must say `Cache-Control: no-store`. Otherwise a shared cache (a company proxy, a CDN) could store it and hand **your** address and orders to the next person who requests the same URL. Public product data can be cached; private data never.

#### Try it yourself

1. Your API returns JSON but forgot `Content-Type`. Node's default for `res.end(string)` is no content type at all. What might a client do?
2. Write the `curl` command that sends `Authorization: Bearer abc123` to `GET http://localhost:3000/v1/me`.
3. Which header tells the browser where a newly created order lives?

**Answers.** 1: It may treat the body as plain text or bytes; a strict client refuses to parse it, and a browser may even guess the type ("sniffing"), which is a security risk. Always set it. 2: `curl -H "Authorization: Bearer abc123" http://localhost:3000/v1/me`. 3: `Location`, sent with `201 Created`.
