# Part 71 — How the Web Works

Before you build a backend, you need a clear picture of what a backend actually does. A backend is a program that sits on a computer somewhere, waits for requests to arrive over the internet, and sends back responses. That is the whole job, at the highest level. Everything else — databases, caches, authentication — is detail in service of that one loop: receive a request, produce a response.

This Part explains the web from the ground up for a beginner: what a client is and what a server is, what the browser does, what an HTTP request and response look like, status codes and headers, URLs, JSON, and what people mean when they say "REST API". Part 4 covers the networking stack (TCP, DNS, TLS) in full depth and Part 8 covers API design as a craft; this Part is the on-ramp, the mental model you need before those make sense. We keep it concrete: every example is a real request you could send with a browser or with `curl`.

## 71.1 Client and server

### 71.1.1 The request-response model

#### Concept

The web runs on a simple pattern: a **client** asks, a **server** answers. The client sends a **request**; the server sends back a **response**. That single exchange — one request, one response — is the atom of the web. A web page loading is dozens of these exchanges; using an app is thousands.

The client is whatever makes the request: a web browser, a mobile app, another server, or a tool like Postman or `curl`. The server is the program that listens for requests and produces responses — that program is your backend.

#### Why does it exist?

Your data and logic cannot live only on the user's device. If an e-commerce site kept every product and every order on each shopper's phone, no two shoppers would see the same catalog, nobody could place an order anyone else could fulfil, and a lost phone would lose the business. So the shared truth lives on a server, and clients talk to it over the network. The request-response model is the agreed way for millions of clients to safely share one source of truth.

#### Mental model

Imagine a restaurant with a kitchen behind a serving hatch. You (the client) write your order on a slip and pass it through the hatch (the request). The kitchen (the server) prepares the dish and passes it back (the response). You cannot walk into the kitchen; you can only pass slips and receive plates. Many customers use the same hatch and the same kitchen. The hatch is the network; the slip format is HTTP; the kitchen's rules for which slips it accepts are your API.

#### How it works

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server
    B->>S: GET /products/42 (request)
    S->>S: look up product 42 in the database
    S-->>B: 200 OK + product JSON (response)
    B->>B: render the product on the page
```

1. The client builds a request: a method (what it wants to do), a URL (what it wants to act on), headers (extra information), and sometimes a body (data it is sending).
2. The request travels over the internet to the server (Part 4 explains how — DNS, TCP, TLS).
3. The server reads the request, does its work (query a database, call another service), and builds a response.
4. The response travels back: a status code (how it went), headers, and usually a body (the data).
5. The client uses the response — the browser renders it, the mobile app updates the screen, another server continues its logic.

The connection is usually closed or reused after the exchange, and the server forgets about you. This is what "stateless" means (71.3): each request stands alone and carries everything the server needs to handle it.

#### Practical example

When you open `https://shop.example.com/products/42` in a browser, the browser sends roughly this request:

```text
GET /products/42 HTTP/1.1
Host: shop.example.com
Accept: text/html
User-Agent: Mozilla/5.0 ...
```

The server responds with roughly:

```text
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Length: 5120

<!doctype html><html>... the product page ...</html>
```

That page then triggers more requests — for the stylesheet, the images, and often a call to an API like `GET /api/products/42` that returns JSON for the dynamic parts. A single page load can be fifty request-response exchanges.

#### Production scenario

A product API server handles 3,000 requests per second. Each request is independent: it arrives, the server reads it, queries PostgreSQL, builds a response and sends it, all in a few milliseconds, then forgets about it. Because each request is self-contained, the business can run twenty identical copies of the server behind a load balancer (Part 26), and any copy can handle any request — there is no "your" server that remembers you. This is only possible because of the stateless request-response model.

#### Edge cases & failure modes

- **The request never arrives** (network drops). The client sees a timeout and may retry.
- **The response never arrives** even though the server did the work. The client cannot tell "did it fail?" from "did the reply get lost?" — which is exactly why writes need idempotency (Part 18).
- **The server is slow**, so the client waits. A client should have a timeout (Part 70).
- **A large body** (a big upload or a huge response) takes time and memory; servers stream large bodies rather than loading them whole (Part 3).

#### How a Senior Backend Engineer thinks about this

A senior keeps the request-response atom in mind constantly, especially its failure mode: the client can never be sure whether a request that got no response actually happened. That single fact drives idempotency keys, retries, and the design of every write endpoint. They also lean on statelessness as the thing that makes horizontal scaling possible — keep the server forgetful between requests, push any shared state into the database or cache, and you can run as many copies as you need.

#### Common mistakes

- Assuming a request always reaches the server and a response always comes back; the network loses both.
- Keeping per-client state in the server's memory, which breaks the moment you run more than one copy.
- Not setting client timeouts, so a slow server hangs the client.

#### Interview questions

1. **What is the request-response model?** A client sends a request, a server sends back one response; each exchange is independent and self-contained.
2. **Why is statelessness important for scaling?** If the server keeps no per-client memory between requests, any copy can handle any request, so you can run many copies behind a load balancer.
3. **Why can't a client be sure a write succeeded if it gets no response?** The failure could be before the work (safe to retry) or after the work but the reply was lost (retry would duplicate); this is why writes need idempotency.

#### Practical exercise

Using `curl` (or a browser's network tab), make a `GET` request to any public API and identify in the output: the method, the URL, three request headers, the status code, and three response headers. Acceptance criteria: you can label each part and say in one sentence what it is for.

## 71.2 HTTP: the language of the web

### 71.2.1 Requests, methods and URLs

#### Concept

HTTP (HyperText Transfer Protocol) is the set of rules for how clients and servers phrase requests and responses. It defines the shape of a request (method, URL, headers, body) and a response (status code, headers, body). Almost every backend you build speaks HTTP. Understanding its pieces is understanding the web.

#### Why does it exist?

Clients and servers are written by different people in different languages on different machines. They need a shared, agreed format so a browser written by one company can talk to a server written by another. HTTP is that shared format — a universal envelope that everyone understands.

#### Mental model

HTTP is like the format of a physical letter. There is an action on the outside (the method: deliver, return, update), an address (the URL), information on the envelope (the headers: who it is from, what language, how urgent), and the contents inside (the body). The post office (the network) does not care what is inside; it just follows the envelope. A server reads the envelope and the contents and writes a reply in the same format.

#### How it works — the methods

The HTTP **method** (also called the verb) says what the client wants to do. The common ones:

| Method | Means | Changes data? | Idempotent? | Typical use |
|---|---|---|---|---|
| `GET` | Read something | No | Yes | Fetch a product, a list, a profile |
| `POST` | Create something, or do an action | Yes | No | Create an order, log in, trigger a job |
| `PUT` | Replace something entirely | Yes | Yes | Replace a whole resource |
| `PATCH` | Change part of something | Yes | Usually | Update one field |
| `DELETE` | Remove something | Yes | Yes | Delete a resource |

Two properties in that table matter a lot. **"Changes data"** (the technical word is "safe" for methods that do not) tells you whether the request is a read or a write; reads can be cached and retried freely. **"Idempotent"** means doing it twice has the same effect as doing it once. `GET`, `PUT` and `DELETE` are idempotent — deleting an already-deleted thing still ends with it deleted. `POST` is not — posting the same order twice creates two orders. This is why retrying a lost `GET` is safe but retrying a lost `POST` needs care (Part 18).

#### How it works — the URL

A URL (Uniform Resource Locator) is the address of what the client wants to act on. Its parts:

```text
https://api.shop.example.com:443/v1/products/42?color=red&size=l#reviews
\___/   \____________________/\_/\_____________/\_____________/\______/
scheme        host           port   path          query        fragment
```

- **Scheme**: `https` (encrypted) or `http` (not). Always `https` in production.
- **Host**: which server to reach (`api.shop.example.com`). DNS turns this into an IP address (Part 4).
- **Port**: which door on the server (443 for https, 80 for http, often omitted because they are the defaults).
- **Path**: which resource (`/v1/products/42`). This is what your backend routes on.
- **Query string**: optional parameters after `?`, as `key=value` pairs joined by `&`. Used for filtering, pagination, search.
- **Fragment**: after `#`, used only by the browser (to jump to a section); it is never sent to the server.

The path is the heart of API design. `/products/42` names "product number 42". `/products` names the collection. Good APIs use nouns for paths and methods for actions, so `GET /products/42` reads product 42 and `DELETE /products/42` removes it.

#### The request body

`POST`, `PUT` and `PATCH` usually carry a **body** — the data being sent. For APIs the body is almost always JSON (71.4). A `GET` has no body; its inputs go in the path and query string.

```text
POST /v1/orders HTTP/1.1
Host: api.shop.example.com
Content-Type: application/json
Content-Length: 84

{"items":[{"productId":"42","quantity":2}],"couponCode":"SAVE10"}
```

#### Practical example

Here is a small API's endpoints expressed as method-plus-path, the way you will design them:

```text
GET    /v1/products            -> list products (with ?category=&page=)
GET    /v1/products/42         -> get product 42
POST   /v1/products            -> create a product (admin)
PATCH  /v1/products/42         -> update some fields of product 42
DELETE /v1/products/42         -> delete product 42
POST   /v1/orders             -> place an order
GET    /v1/orders/ord_1001    -> get one order
```

#### Edge cases & failure modes

- **Using `GET` to change data** (for example `GET /deleteUser?id=5`) is a classic mistake: search engines and browsers prefetch and cache `GET`s, so a crawler could delete your data. Reads must be safe; writes must use `POST`/`PUT`/`PATCH`/`DELETE`.
- **Very long URLs** (huge query strings) can be truncated by proxies; there is a practical limit around 2,000 to 8,000 characters. Large inputs belong in a `POST` body.
- **Query-string injection**: query values are user input and must be validated like any other (Part 23).
- **Unencoded characters** in a URL (spaces, `&`, non-ASCII) break parsing; they must be percent-encoded (`%20` for a space).

#### How a Senior Backend Engineer thinks about this

A senior maps each operation to the method whose safety and idempotency match it: reads are `GET`, creates are `POST`, full replacements are `PUT`, partial updates are `PATCH`, removals are `DELETE`. They never hide a write behind a `GET`, because safe methods get retried, prefetched and cached by machinery outside their control. They design paths as nouns and keep them stable, because a URL printed in a mobile app or an integration is a contract that is expensive to change (Part 32 on compatibility).

#### Common mistakes

- Changing data with `GET`, inviting accidental deletions by crawlers and prefetchers.
- Putting actions in the path (`/getProduct`, `/createOrder`) instead of using the method on a noun.
- Forgetting to percent-encode special characters in URLs.
- Cramming large data into the query string instead of the body.

#### Interview questions

1. **What does it mean for an HTTP method to be idempotent, and which methods are?** Doing it twice has the same effect as once; `GET`, `PUT`, `DELETE` are idempotent, `POST` is not. It matters for safe retries.
2. **Why should a read never use `POST` and a write never use `GET`?** Reads should be safe and cacheable; writes must not be, because `GET`s are prefetched and cached by browsers, crawlers and proxies, which would trigger the write unexpectedly.
3. **What are the parts of a URL and which part never reaches the server?** Scheme, host, port, path, query, fragment; the fragment (after `#`) stays in the browser.
4. **Where do a `GET` request's inputs go, versus a `POST`?** `GET` inputs go in the path and query string; `POST` inputs go in the body.

#### Practical exercise

Design the endpoints (method + path) for a simple "notes" API that supports listing notes, getting one note, creating a note, editing a note's text, and deleting a note. Mark which are idempotent. Acceptance criteria: reads use `GET`, writes use the correct write method, paths are nouns, and no write is hidden behind a `GET`.
