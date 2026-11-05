## 3.7 Worked example: a tiny products API with no framework

### 3.7.1 Building it, then talking to it with curl

#### Concept

Everything in this Part fits in one small program: a server that reads the method and URL, routes on them, parses and validates a JSON body with a size limit, and answers with honest status codes, correct headers and one consistent error shape. We build it with nothing but Node's `node:http`, so no framework hides anything. Part 6 then rebuilds the same idea properly with NestJS and PostgreSQL, and you will recognize every piece.

#### Practical example

The first half is setup and three helpers. `readBody` is the helper from 3.4.

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

type Product = { id: string; name: string; priceCents: number };
const products = new Map<string, Product>([['42', { id: '42', name: 'Dental Mirror', priceCents: 1299 }]]);
let nextId = 43;

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

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, body === undefined ? headers : { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { code, message } });
}
```

The second half is the request handler. Put it in the same file, under the helpers.

```ts
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const [, version, collection, id] = url.pathname.split('/'); // "/v1/products/42"
  console.log(`${req.method} ${url.pathname}${url.search}`);

  if (version !== 'v1' || collection !== 'products') {
    return sendError(res, 404, 'not_found', `no route for ${url.pathname}`);
  }

  if (req.method === 'GET' && !id) {                       // list, with a page size
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
    return send(res, 200, { items: [...products.values()].slice(0, limit) });
  }

  if (req.method === 'GET' && id) {                        // read one
    const product = products.get(id);
    if (!product) return sendError(res, 404, 'not_found', `product ${id} not found`);
    return send(res, 200, product);
  }

  if (req.method === 'POST' && !id) {                      // create
    if (!req.headers['content-type']?.startsWith('application/json')) {
      return sendError(res, 415, 'unsupported_media_type', 'send Content-Type: application/json');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch (err) {
      const tooLarge = (err as Error).message === 'body too large';
      return sendError(res, tooLarge ? 413 : 400, tooLarge ? 'too_large' : 'bad_json', (err as Error).message);
    }
    const { name, priceCents } = (raw ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') {
      return sendError(res, 422, 'invalid_name', 'name must be a non-empty string');
    }
    if (typeof priceCents !== 'number' || !Number.isInteger(priceCents) || priceCents < 0) {
      return sendError(res, 422, 'invalid_price', 'priceCents must be a non-negative integer');
    }
    const product = { id: String(nextId++), name: name.trim(), priceCents };
    products.set(product.id, product);
    return send(res, 201, product, { Location: `/v1/products/${product.id}` });
  }

  if (req.method === 'DELETE' && id) {                     // remove
    return products.delete(id) ? send(res, 204) : sendError(res, 404, 'not_found', `product ${id} not found`);
  }

  res.setHeader('Allow', id ? 'GET, DELETE' : 'GET, POST');
  return sendError(res, 405, 'method_not_allowed', `${req.method} is not supported here`);
});

server.listen(3000, () => console.log('products API on http://localhost:3000'));
```

Run it with `node api.ts`. In a second terminal, run this curl session. `-w '  [%{http_code}]\n'` tells curl to print the status code after each body, which keeps the output short.

```bash
B=http://localhost:3000/v1/products
J="Content-Type: application/json"
W='  [%{http_code}]\n'
curl -s -w "$W" $B/42
curl -s -i -X POST $B -H "$J" -d '{"name":"Probe","priceCents":899}' | grep -E '^HTTP|^Location|^\{'
curl -s -w "$W" "$B?limit=10"
curl -s -w "$W" $B/999
curl -s -w "$W" -X POST $B -H "$J" -d '{"name":"Probe","priceCents":899'
curl -s -w "$W" -X POST $B -H "$J" -d '{"name":"Gloves","priceCents":-5}'
curl -s -w "$W" -X POST $B -d 'name=Probe'
curl -s -w "$W" -X PUT $B
curl -s -w "$W" -X DELETE $B/43
curl -s -w "$W" -X DELETE $B/43
```

```text
{"id":"42","name":"Dental Mirror","priceCents":1299}  [200]
HTTP/1.1 201 Created
Location: /v1/products/43
{"id":"43","name":"Probe","priceCents":899}
{"items":[{"id":"42","name":"Dental Mirror","priceCents":1299},{"id":"43","name":"Probe","priceCents":899}]}  [200]
{"error":{"code":"not_found","message":"product 999 not found"}}  [404]
{"error":{"code":"bad_json","message":"Expected ',' or '}' after property value in JSON at position 32 (line 1 column 33)"}}  [400]
{"error":{"code":"invalid_price","message":"priceCents must be a non-negative integer"}}  [422]
{"error":{"code":"unsupported_media_type","message":"send Content-Type: application/json"}}  [415]
{"error":{"code":"method_not_allowed","message":"PUT is not supported here"}}  [405]
  [204]
{"error":{"code":"not_found","message":"product 43 not found"}}  [404]
```

Sending a body over 10 KB returns `{"error":{"code":"too_large","message":"body too large"}}` with status `413`.

#### How it works

Map each line of output back to an idea from this Part:

| Request | Status | The idea behind it |
|---|---|---|
| `GET /v1/products/42` | `200` | A safe read of one resource (3.2) |
| `POST /v1/products` | `201` + `Location` | A create; the header says where the new product lives (3.3.2) |
| `GET /v1/products?limit=10` | `200` | A list is always bounded; even a huge `limit` is capped at 100 (3.5) |
| `GET /v1/products/999` | `404` | The resource does not exist |
| Broken JSON | `400` | We could not understand the request (3.4) |
| Negative price | `422` | We understood it, but it breaks a rule |
| No `Content-Type` | `415 Unsupported Media Type` | curl's `-d` sends `application/x-www-form-urlencoded` unless told otherwise; we only accept JSON |
| `PUT` on the collection | `405 Method Not Allowed` + `Allow` | The path exists but not with that method; `Allow` lists what does work |
| First `DELETE /v1/products/43` | `204` | Done, nothing to send back |
| Second `DELETE` | `404` | The state is the same (gone), so `DELETE` is still idempotent (3.2) |

Every error has the same shape, `{"error":{"code","message"}}`, so a client needs one piece of code to handle all of them. The server keeps nothing about the client between requests: it is stateless, though the `products` map itself lives in memory and vanishes on restart, which is exactly the problem Part 6 solves with PostgreSQL.

#### Production scenario

Nobody ships a framework-free server like this for a real shop. Here is what NestJS gives you for each piece you just wrote by hand: routing by method and path (`@Get`, `@Post`, `@Param`), body reading with a size limit (the built-in body parser), validation (`ValidationPipe` with `class-validator` DTOs), errors as exceptions (`NotFoundException` becomes a `404` with a JSON body), and status codes (`@HttpCode`). Writing it once by hand means you know what each of those is doing for you, and you can debug it when one of them surprises you.

#### Edge cases & failure modes

- **Trailing slash.** `/v1/products/` splits into an empty `id`, so it behaves like the collection. Real routers decide this explicitly.
- **`limit=abc`.** `Number('abc')` is `NaN`, `Math.min(NaN, 100)` is `NaN`, and `slice(0, NaN)` returns an empty list. A real API returns `400` for a bad `limit`.
- **An unexpected exception.** If code inside this `async` handler throws, nothing turns it into a `500`: the rejected promise is unhandled, so Node stops the whole server (Part 130.4, trap 3), and every client is cut off. NestJS wraps every handler in an exception filter that always answers with a `500` instead.

#### Try it yourself

With the server running, predict the status code and error `code` for each request, then run it to check.

1. `curl -s -X POST $B -H "$J" -d '{"name":"   ","priceCents":5}'`
2. `curl -s -X POST $B -H "$J" -d '{"name":"Probe","priceCents":12.5}'`
3. `curl -s http://localhost:3000/v2/products`
4. `curl -s -X POST $B -H "$J" -d 'null'`
5. `curl -s -i -X DELETE $B` (no id). Which header in the response tells you what you could have done instead?

**Answers.**

1. `422`, `invalid_name`. The name is only spaces; `name.trim() === ''` catches it. Without the `trim()` you would store a product with an invisible name.
2. `422`, `invalid_price`. `12.5` parses fine as JSON, but `Number.isInteger(12.5)` is `false`; there is no such thing as half a cent.
3. `404`, `not_found`, with the message `no route for /v2/products`. Version 2 of the API does not exist.
4. `422`, `invalid_name`. `null` is valid JSON, so there is no `400`. The `(raw ?? {})` turns it into an empty object, and the first missing field is reported. Without that `?? {}`, destructuring `null` would throw and crash the server, as described in the last edge case.
5. `405 Method Not Allowed` with `Allow: GET, POST`. You can delete one product (`DELETE /v1/products/{id}`), but not the whole collection.

#### Practical exercise

Add `PATCH /v1/products/{id}` that accepts `{"priceCents": 1099}`, validates it like `POST`, and returns the updated product. Then add `?minPriceCents=` filtering to the list. Acceptance criteria: a valid patch returns `200` with the new price, a patch to a missing id returns `404`, a negative price returns `422`, `?limit=abc` returns `400`, and `PATCH` appears in the `Allow` header for item URLs.

## Senior Checklist — Part 3

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
- [ ] I can explain the request-response model and why statelessness enables scaling
- [ ] I can read `curl -v` output and tell the request lines from the response lines
- [ ] I can map operations to the correct HTTP method and know which are idempotent
- [ ] I parse URLs with `new URL()` and build query strings with `URLSearchParams`, never by gluing strings
- [ ] I know the status code families and the common codes, and return them honestly
- [ ] I set Content-Type correctly and never trust client-set headers for auth
- [ ] I parse JSON defensively, cap body size, and always validate shape before trusting it
- [ ] I know what JSON loses on a round trip: `Date`, `undefined`, `NaN` and big integers
- [ ] I can design a consistent, paginated REST API around resources
- [ ] I understand what the browser does and can diagnose a CORS error as server-side
- [ ] I can build a small API with `node:http` and explain what NestJS does for each part of it

## Part 3 — Key Takeaways

- The web is request-response: a client asks, a server answers, each exchange self-contained; statelessness is what lets you run many copies of a server.
- A client getting no response cannot know whether the write happened, which is why writes need idempotency.
- `curl -v` shows the whole conversation: `>` is the request, `<` is the response; it is the first tool to reach for.
- Map each operation to the method whose safety and idempotency fit; never hide a write behind a `GET`.
- Never build URLs by gluing strings; `URLSearchParams` and `encodeURIComponent` stop an `&` or `#` in user input from changing what the server receives.
- Status codes are read by machines (caches, load balancers, monitors, clients), so return them honestly: `4xx` is the client's fault, `5xx` is the server's.
- Headers carry metadata and are a security surface; always set `Content-Type`, propagate a request id, and never trust a client-set header for identity.
- JSON supports only strings, numbers, booleans, null, objects and arrays; parse untrusted input defensively, cap its size, and validate its shape before trusting it.
- REST organizes an API around resource nouns with standard methods, JSON, honest status codes and consistent shapes; paginate every list.
- A published URL and response shape are a long-lived contract; change them compatibly or version them.
- The browser turns one page load into dozens of request-response exchanges and enforces rules (CORS, same-origin, mixed-content) that server-to-server callers do not face.
- "Works in Postman, fails in the browser" is almost always CORS, and the fix is on the server; CORS protects browsers, it does not stop anyone from calling your API.
