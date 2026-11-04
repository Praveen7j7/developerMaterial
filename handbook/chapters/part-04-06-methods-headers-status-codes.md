## 4.7 HTTP methods, headers and status codes

### 4.7.1 Methods: safe, idempotent, and why retries depend on it

#### Concept

An HTTP **method** states the intent of a request. Two properties of a method matter far more than its name:

- **Safe**: the request does not change server state. Caches may store the response, crawlers may issue it freely, and a proxy may replay it.
- **Idempotent**: sending the request once or ten times leaves the server in the same state. The response may differ (the second `DELETE` returns 404), but the state does not.

| Method | Safe | Idempotent | Typical NestJS use | Retry on timeout? |
|---|---|---|---|---|
| `GET` | yes | yes | read a resource or list | yes, freely |
| `HEAD` | yes | yes | check existence, size, ETag without a body | yes |
| `OPTIONS` | yes | yes | CORS preflight, capability discovery | yes |
| `PUT` | no | yes | full replace: `PUT /carts/:id` | yes |
| `DELETE` | no | yes | remove: `DELETE /sessions/:id` | yes |
| `POST` | no | **no** | create, or any action: `POST /orders`, `POST /payments/:id/capture` | **only with an idempotency key** |
| `PATCH` | no | **no** (in general) | partial update: `PATCH /orders/:id` with `{"status":"packed"}` | only if the patch is absolute, not relative |

`PATCH` is not idempotent in general because a patch like `{"op":"increment","qty":1}` applied twice adds two. A patch that sets absolute values (`{"status":"packed"}`) happens to be idempotent, but the client cannot know that from the method, so treat `PATCH` as unsafe to retry unless you add an idempotency key or an `If-Match` precondition.

#### Why does it exist?

The network fails after the request is sent and before the response arrives. The client then faces a question it cannot answer: did the server do the work? For an idempotent method, it does not matter; retry. For a non-idempotent method, a blind retry creates a duplicate order, a double charge, or two emails. Method semantics are the contract that lets load balancers, SDKs, retry libraries and browsers decide when a retry is safe. Browsers will re-issue a `GET` when the connection drops; they show a "resubmit form?" dialog for `POST`. Cloud SDKs retry idempotent calls automatically.

#### Mental model

Imagine sending a text message to a friend: "What time is dinner?" (GET) can be sent twice harmlessly. "Set dinner to 8pm" (PUT) sent twice is still 8pm. "Add one guest" (POST) sent twice adds two guests unless you also say "this is request #42", so your friend can ignore the duplicate.

#### How it works

1. A client sends `POST /orders`. The request reaches NestJS, the order is created, and the response is lost because a NAT dropped the flow.
2. The client's HTTP library sees a timeout. If it is configured to retry unsafe methods, it sends `POST /orders` again.
3. Without protection, a second order is created.
4. With an **`Idempotency-Key`** header (a client-generated UUID per logical operation), the server looks up the key before doing work. If the key exists, it returns the stored response. If not, it records the key (with a lock or unique constraint) and proceeds. The key's lifetime is typically 24 hours.
5. For `PUT`, the same retry is harmless by definition, which is why senior engineers prefer client-generated IDs and `PUT /orders/:clientGeneratedId` over `POST /orders` where possible.

#### Practical example

A food-delivery app's checkout `POST /orders` succeeded on the server but the phone lost signal before the response. The app retried three times. Three orders, three charges, one furious customer. The fix combined an `Idempotency-Key` per checkout attempt with a unique index on `(user_id, idempotency_key)` so even two concurrent retries could not both insert.

#### NestJS example

```ts
// idempotency.interceptor.ts
import {
  BadRequestException, CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor,
} from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import Redis from 'ioredis';
import { Request, Response } from 'express';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: Redis) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    if (req.method !== 'POST' && req.method !== 'PATCH') return next.handle();

    const key = req.header('idempotency-key');
    if (!key) throw new BadRequestException('Idempotency-Key header is required');
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'anon';
    const redisKey = `idem:${userId}:${req.method}:${req.path}:${key}`;

    return from(this.redis.set(redisKey, 'IN_PROGRESS', 'EX', 86_400, 'NX')).pipe(
      switchMap(async (acquired) => {
        if (acquired) return null;                       // first time: run the handler
        const stored = await this.redis.get(redisKey);
        if (stored === 'IN_PROGRESS') throw new ConflictException('Request already in progress'); // 409
        return JSON.parse(stored!) as { status: number; body: unknown };
      }),
      switchMap((replay) =>
        replay
          ? of(replay.body).pipe(tap(() => res.status(replay.status)))
          : next.handle().pipe(
              tap((body) => this.redis.set(redisKey, JSON.stringify({ status: res.statusCode, body }), 'EX', 86_400)),
            ),
      ),
    );
  }
}
```

The `NX` set is the lock: two concurrent retries cannot both proceed. A handler failure should delete the key so the client can retry; add that in an error path with `catchError`. Store the response so a replay returns the same `201` and body rather than a new one.

#### PostgreSQL example

Redis is fast but the database is the source of truth; a unique constraint is the last line of defence when Redis is flushed or a second data centre shares the table.

```sql
CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  idempotency_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'created',
  total_cents      integer NOT NULL CHECK (total_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Two retries with the same key cannot both insert; the loser gets a unique violation (23505)
CREATE UNIQUE INDEX orders_user_idem_uidx ON orders (user_id, idempotency_key);

-- Insert-or-return pattern: the retry gets the original row back instead of an error
INSERT INTO orders (user_id, idempotency_key, total_cents)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, idempotency_key) DO UPDATE SET user_id = EXCLUDED.user_id
RETURNING id, status, total_cents, (xmax = 0) AS inserted;
```

The `xmax = 0` trick tells you whether the row was freshly inserted (`true`) or already existed (`false`), so the handler can return `201` on first creation and `200` on replay.

#### TypeORM example

```ts
// orders.service.ts
import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrdersService {
  constructor(private readonly ds: DataSource) {}

  async create(userId: string, idempotencyKey: string, totalCents: number): Promise<Order> {
    return this.ds.transaction(async (em) => {
      const existing = await em.findOne(Order, { where: { userId, idempotencyKey } });
      if (existing) return existing; // replay: same result, no new side effects
      try {
        return await em.save(em.create(Order, { userId, idempotencyKey, totalCents }));
      } catch (e: unknown) {
        // Unique violation from a concurrent retry that won the race
        if ((e as { code?: string }).code === '23505') {
          const winner = await em.findOneOrFail(Order, { where: { userId, idempotencyKey } });
          return winner;
        }
        throw new ConflictException('could not create order');
      }
    });
  }
}
```

#### Sequelize example

```ts
// orders.service.ts (Sequelize)
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import { Order } from './order.model';

@Injectable()
export class OrdersService {
  constructor(@InjectModel(Order) private readonly orders: typeof Order) {}

  async create(userId: string, idempotencyKey: string, totalCents: number) {
    const [order, created] = await this.orders
      .findOrCreate({ where: { userId, idempotencyKey }, defaults: { totalCents } })
      .catch(async (e) => {
        if (e instanceof UniqueConstraintError) {
          const row = await this.orders.findOne({ where: { userId, idempotencyKey }, rejectOnEmpty: true });
          return [row, false] as const;
        }
        throw e;
      });
    return { order, statusCode: created ? 201 : 200 };
  }
}
```

#### Production scenario

A payments API processes 800 captures per minute. About 0.4% of client requests are retries after a timeout, 3 per minute. Without idempotency that is 3 double charges per minute, 4,300 per day. With `Idempotency-Key` stored in Redis (24-hour TTL, about 1.2 million keys, 200 MB) and the unique index as backstop, the duplicate rate is zero and the replay path is served in under 2 ms.

#### Failure scenario

An SDK team enabled "retry all 5xx and timeouts" in a shared HTTP client. Every service that used it started retrying `POST`s. A downstream notification service that had a 30-second timeout during a slow period received three copies of each request. Customers got three "your order shipped" emails. The client library was changed to retry only idempotent methods by default, and to retry `POST` only when the caller supplied an idempotency key.

#### Edge cases & failure modes

- A retry that arrives while the original is still executing: the `NX` lock returns `409`; the client should back off and retry, then get the stored response.
- Idempotency keys reused across different payloads: return `422` if the key exists with a different request hash.
- Key scope: scope to the user and the route, or one client's key could collide with another's.
- `DELETE` returning `404` on the second try is correct; clients must treat `404` after a `DELETE` retry as success.
- `PUT` with server-generated fields (`updated_at`) is still idempotent in state terms; do not confuse changing timestamps with non-idempotence.
- Browsers may automatically retry a `GET` whose connection dropped before any response bytes arrived; a `GET` that has side effects (`GET /orders/:id/cancel`) will be executed twice.

#### How a Senior Backend Engineer thinks about this

They design every mutating endpoint to answer "what happens if this arrives twice?" before writing it. They prefer client-generated IDs and `PUT`, use `Idempotency-Key` for `POST`, and forbid side effects in `GET`. They configure retries per method. To a product manager: "Retries are what make the app feel reliable on bad networks, and idempotency is what makes retries safe. Without both, we choose between a flaky app and double charges."

#### Common mistakes

- `GET /reports/generate` that creates a file.
- Retrying `POST` on timeout without a key.
- Treating `PATCH` as idempotent because "it usually is".
- Generating the idempotency key on the server, which defeats its purpose.

#### Interview questions

1. **Define safe and idempotent, and give a method that is one but not the other.** Safe means no state change; idempotent means repeated calls leave the same state. `DELETE` is idempotent but not safe.
2. **Why is `POST` dangerous to retry, and how do you make it safe?** Not idempotent; use a client-generated `Idempotency-Key` with a stored response and a unique constraint.
3. **A client times out on `DELETE /items/42` and retries, getting `404`. Is that a bug?** No; the state is the same, and the client should treat it as success.
4. **When is `PATCH` idempotent?** When it sets absolute values; relative operations like increments are not.
5. **How do you prevent two concurrent retries from both creating an order?** A `SET NX` lock in Redis and a unique index in the database as backstop.

#### Practical exercise

Implement `POST /orders` with an `Idempotency-Key`. Write a Jest test that fires the same request 20 times in parallel and asserts exactly one row exists, one `201`, and nineteen `200` or `409` responses with identical bodies. Acceptance criteria: the test passes against a real Postgres and Redis in Docker, and killing Redis mid-test still results in exactly one row.

### 4.7.2 Headers that matter

#### Concept

Headers are the metadata of a request or response: key-value pairs that tell the other side how to interpret the body, who is asking, what is acceptable, and how the response may be cached or retried. Names are case-insensitive; Node lowercases them all. A production NestJS API should treat the following as part of its contract.

#### Why does it exist?

Without headers, a body is just bytes. Headers let one URL serve JSON and CSV, let intermediaries cache safely, carry identity, propagate tracing context, and let a server tell a client precisely how to retry. Many outages are header bugs: a missing `Cache-Control` that let a CDN cache a personalised response, a `Content-Type` of `text/html` on a JSON error page, or an `X-Forwarded-For` that was trusted from an untrusted source.

#### Mental model

Imagine a parcel. The address label (`Host`), the "fragile, this way up" sticker (`Content-Type`), the customs declaration (`Content-Length`), the sender's ID badge (`Authorization`), the "do not store in warehouse" note (`Cache-Control: no-store`), and the tracking number (`X-Request-Id`). The parcel's contents are the body; everything on the outside is a header.

#### How it works

| Header | Direction | What it does | NestJS practice |
|---|---|---|---|
| `Content-Type` | both | media type of the body, e.g. `application/json; charset=utf-8` | set automatically for objects; set explicitly for CSV, PDF, `application/problem+json` |
| `Content-Length` | both | body size in bytes | set by Node when the body is known; absent with chunked streaming |
| `Accept` | request | what the client can consume: `application/json`, `text/csv` | content negotiation in a controller; reject unsupported with `406` |
| `Authorization` | request | credentials: `Bearer <jwt>`, `Basic <base64>` | read in a Passport guard; never log it |
| `Cache-Control` | both | caching rules (see 4.11) | interceptor that sets `private, no-store` for user data, `public, max-age` for catalog |
| `ETag` / `If-None-Match` | response / request | resource version; conditional GET returns `304` | see 4.11 |
| `If-Match` | request | precondition: only apply if the version matches | optimistic concurrency on `PATCH`, `412` on mismatch |
| `Idempotency-Key` | request | client-generated key to dedupe retries | required on `POST` that charges or creates |
| `X-Request-Id` | both | correlation id across services and logs | generate in middleware if absent; echo in the response; put in every log line |
| `traceparent` | both | W3C trace context for OpenTelemetry | propagated automatically by the OTel SDK |
| `X-Forwarded-For` | request | client IP chain added by proxies | trust only the hop added by your ALB; `trust proxy` setting |
| `X-Forwarded-Proto` | request | original scheme (`https`) at the LB | needed to build absolute URLs and set `Secure` cookies correctly |
| `Retry-After` | response | seconds (or date) to wait before retrying; with `429` and `503` | set from the rate limiter and during maintenance |
| `Location` | response | URL of a created resource (`201`) or redirect target (`3xx`) | `@Header` or `res.setHeader` after creation |
| `Vary` | response | which request headers affect the response; caches key on them | `Vary: Accept-Encoding, Authorization` when responses differ by those |
| `Content-Encoding` | response | `gzip`, `br` | set by compression middleware |
| `Strict-Transport-Security` | response | force HTTPS for a period | set by `helmet` |
| `WWW-Authenticate` | response | how to authenticate, sent with `401` | `Bearer realm="api"` |

Two headers deserve extra attention:

**`X-Forwarded-For`** is a comma-separated chain: `client, proxy1, proxy2`. Each proxy appends the address it saw. An attacker can send `X-Forwarded-For: 1.2.3.4` and, if you take the first value, you rate limit the wrong address. Express's `trust proxy` setting resolves this: with `trust proxy = 1`, `req.ip` is the value immediately before your one trusted hop, which is what the ALB appended. Never trust more hops than you own.

**`X-Request-Id`** is the single most useful header for operations. Generate a UUID at the edge (ALBs add `X-Amzn-Trace-Id`; API gateways add their own), or in your first middleware if none arrived, attach it to the async context, include it in every log line and every outbound call, and return it in the response so a support ticket can quote it.

#### NestJS example

```ts
// request-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Accept an upstream id (ALB, gateway) but never trust arbitrary length or characters.
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);           // echo so the client can quote it
    requestContext.run({ requestId }, () => next());    // available to every log and outbound call
  }
}
```

```ts
// exports.controller.ts: content negotiation with Accept
import { Controller, Get, Header, Headers, NotAcceptableException, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller('exports')
export class ExportsController {
  @Get('orders')
  @Header('Cache-Control', 'private, no-store')
  async orders(@Headers('accept') accept: string | undefined, @Res() res: Response) {
    const wantsCsv = accept?.includes('text/csv');
    const wantsJson = !accept || accept.includes('application/json') || accept.includes('*/*');
    if (!wantsCsv && !wantsJson) throw new NotAcceptableException('Supported: application/json, text/csv'); // 406

    res.setHeader('Vary', 'Accept');                    // caches must key on Accept
    if (wantsCsv) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
      return res.send('id,status,total_cents\n');
    }
    return res.json({ orders: [] });
  }
}
```

#### PostgreSQL example

Headers rarely touch SQL directly, but the request id should: log it with slow queries so a trace in Grafana links to a row in `pg_stat_statements` or the Postgres log.

```sql
-- Tag the session so the request id appears in pg_stat_activity and in log_line_prefix (%a)
SET LOCAL application_name = 'orders-api:req-7f3a9c1e';

-- Then the slow-query log line reads:
-- 2026-09-06 10:22:01 UTC [orders-api:req-7f3a9c1e] LOG: duration: 1432.118 ms  statement: SELECT ...
```

In `pg`, run `SET LOCAL application_name = $1` at the start of each transaction, or pass `application_name` in the connection string and rely on tracing for the request id.

#### Production scenario

A support ticket says "my order failed at 14:05". With `X-Request-Id` echoed in the app's error toast and present in every log line across the gateway, the API, the payment worker and the Postgres slow log, the engineer finds the full path in 30 seconds. Without it, they grep 4 million log lines for a user id and guess.

#### Failure scenario

A rate limiter keyed on the first `X-Forwarded-For` value was bypassed by a scraper that set the header to random IPs. 40 million product pages were scraped in a night. The fix was `trust proxy: 1` and keying on `req.ip`, plus a WAF rule.

#### Edge cases & failure modes

- Header size limits: Node rejects headers over 16 KB (`--max-http-header-size`) with `431`; an ALB's limit is 64 KB for all headers. A JWT with 200 roles can hit this.
- Duplicate headers: most are joined with commas; `Set-Cookie` is an array; `Content-Length` twice is a request smuggling vector and is rejected.
- `Content-Type` without `charset` on text responses leads to mojibake for non-ASCII names.
- Missing `Vary: Accept-Encoding` lets a cache serve gzip to a client that did not ask for it.
- `Retry-After` ignored by clients that retry immediately; combine with server-side rate limiting.
- Case: Node lowercases; an app that reads `req.headers['X-Request-Id']` gets `undefined`.

#### How a Senior Backend Engineer thinks about this

They define a small set of mandatory headers for every service (request id, trace context, content type, cache control) and enforce them with middleware and tests, not with code review. They never trust a client-supplied header for security decisions unless it was added by a hop they control. To a product manager: "The tracking number on every request is why we can tell you exactly what happened to a customer's order in under a minute."

#### Common mistakes

- Logging the `Authorization` header.
- Reading the first `X-Forwarded-For` value.
- Forgetting `Vary`.
- Serving JSON with `text/html` (a browser may execute it).
- Sending `Retry-After` with a `500`.

#### Interview questions

1. **How do you get the real client IP behind an ALB, and what is the trap?** `X-Forwarded-For` with `trust proxy` set to the number of hops you own; the trap is trusting client-supplied values.
2. **What does `Vary` do and when does omitting it cause a bug?** Tells caches which request headers change the response; omitting `Vary: Accept-Encoding` mixes compressed and uncompressed bodies.
3. **Design the request id flow across three services.** Generate at the edge, propagate on every outbound call, log everywhere, echo in responses.
4. **Why is `Content-Type: application/json` on error responses important?** Clients and browsers parse based on it; HTML error pages break JSON clients and can be an XSS vector.

#### Practical exercise

Add a middleware that enforces `X-Request-Id`, an interceptor that sets `Cache-Control` defaults, and a Jest e2e test that asserts every response carries `X-Request-Id`, a correct `Content-Type`, and `Vary: Accept-Encoding` when compressed. Acceptance criteria: tests green, and a log line that includes the request id for a deliberately slow query.

### 4.7.3 Status codes: what a NestJS API should return, and what the load balancer returns on its own

#### Concept

A status code tells the client, and every proxy between you and the client, what happened. Clients branch on it: retry, refresh a token, show a validation error, or give up. Load balancers and CDNs also generate their own codes when they cannot reach you, and distinguishing "the app said 503" from "the ALB said 503" is a daily task in operations.

#### Why does it exist?

Without a shared vocabulary, every client would need to parse error bodies. Status codes let generic infrastructure (browsers, SDK retry logic, CDNs, monitoring) act correctly without understanding your domain. A `503` with `Retry-After` triggers back-off; a `401` triggers a token refresh; a `304` saves bandwidth; a `422` shows a form error. Getting them wrong makes clients retry when they should not and give up when they should retry.

#### How it works

Classes: `2xx` success, `3xx` redirection, `4xx` the client did something wrong, `5xx` the server failed. The practical guide:

| Code | Meaning | When a NestJS API returns it | Should the client retry? |
|---|---|---|---|
| `200 OK` | success with body | `GET`, `PATCH`, `PUT` that returns the resource, idempotent replay of a `POST` | n/a |
| `201 Created` | resource created | `POST /orders` first time; include `Location` | n/a |
| `202 Accepted` | accepted for async processing | `POST /exports` that enqueues a job; body has a status URL | n/a |
| `204 No Content` | success, no body | `DELETE`, `PUT` that returns nothing | n/a |
| `301 Moved Permanently` | permanent redirect; caches remember | API version retirement; use rarely for APIs | follow |
| `302 Found` / `307` | temporary redirect | OAuth flows; `307` preserves the method | follow |
| `304 Not Modified` | cached copy is still valid | conditional `GET` with matching `ETag` | n/a |
| `400 Bad Request` | malformed request | invalid JSON, missing required header, bad query type | no |
| `401 Unauthorized` | not authenticated | missing or expired token; send `WWW-Authenticate` | after refreshing credentials |
| `403 Forbidden` | authenticated but not allowed | user is not the order's owner; role lacks permission | no |
| `404 Not Found` | no such resource | unknown id; also used to hide existence from unauthorised users | no |
| `405 Method Not Allowed` | route exists, method does not | `DELETE /orders` on a collection; include `Allow` | no |
| `409 Conflict` | state conflict | duplicate email; idempotent request in progress; version conflict on `@VersionColumn` | after re-reading state |
| `410 Gone` | existed, deliberately removed | deleted account endpoints, retired API version | no |
| `412 Precondition Failed` | `If-Match` did not match | optimistic concurrency on `PATCH` | after refetching and reapplying |
| `413 Payload Too Large` | body over the limit | upload over `bodyParser` limit or ALB limit | no, shrink the body |
| `415 Unsupported Media Type` | wrong `Content-Type` | `text/plain` sent to a JSON endpoint | no |
| `422 Unprocessable Entity` | well-formed but semantically invalid | `class-validator` DTO failures (NestJS uses `400` by default; many teams switch to `422`) | no, fix input |
| `429 Too Many Requests` | rate limited | `@nestjs/throttler`; include `Retry-After` | after `Retry-After` |
| `500 Internal Server Error` | unhandled exception | a bug; the default from NestJS's exception filter for unknown errors | maybe once, with a key |
| `502 Bad Gateway` | upstream gave an invalid response | almost always the LB, not you: target closed the connection, sent garbage, or reset | yes, with back-off |
| `503 Service Unavailable` | temporarily unable | your app during shutdown or when a dependency is down (with `Retry-After`); the ALB when no healthy targets | yes, with back-off |
| `504 Gateway Timeout` | upstream did not respond in time | the ALB after its idle timeout (60 s); your own timeout interceptor if you choose it | maybe, idempotent only |

**Who returns what.** The distinction matters during incidents:

| Code | Returned by the ALB itself when | Returned by NestJS when |
|---|---|---|
| `400` | malformed HTTP, header too large, bad `Host` | validation failure |
| `413` | body exceeds the ALB limit (1 MB for Lambda targets, larger for instances) | `bodyParser` limit exceeded |
| `460` | client closed the connection before the ALB finished (ALB-specific code, appears in access logs only) | never |
| `502` | target reset the connection, closed it while a request was in flight (the keep-alive race, 4.9), sent malformed headers, or TLS to target failed | never; if you see 502 the app did not answer |
| `503` | zero healthy targets in the target group, or target group not attached | health check failing on purpose during shutdown, or circuit open |
| `504` | target did not send response headers within the idle timeout | only if you emit it deliberately |

The ALB access log has fields `elb_status_code` and `target_status_code`; when they differ, the ALB generated the response. Alert on `elb_status_code = 5xx AND target_status_code = "-"` as "infrastructure 5xx" separately from application 5xx.

#### NestJS example

A global exception filter that maps domain errors to codes consistently, uses `application/problem+json`, includes the request id, and never leaks stack traces. Plus the two lines that turn validation failures into `422`.

```ts
// http-exception.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = res.getHeader('X-Request-Id');

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      title = typeof body === 'string' ? body : (body as { message?: string }).message ?? exception.message;
      detail = typeof body === 'object' ? body : undefined;
    } else if (exception instanceof QueryFailedError) {
      const code = (exception as QueryFailedError & { code?: string }).code;
      if (code === '23505') { status = HttpStatus.CONFLICT; title = 'Duplicate resource'; }         // 409
      else if (code === '23503') { status = HttpStatus.UNPROCESSABLE_ENTITY; title = 'Invalid reference'; } // 422
      else if (code === '57014') { status = HttpStatus.SERVICE_UNAVAILABLE; title = 'Query timed out'; res.setHeader('Retry-After', '2'); } // statement_timeout
    }

    if (status >= 500) this.logger.error({ requestId, path: req.path, err: exception }); // log 5xx with stack, never send it
    res.status(status).setHeader('Content-Type', 'application/problem+json').json({
      type: 'about:blank', title, status, detail, instance: req.originalUrl, requestId,
    });
  }
}
```

```ts
// main.ts (excerpt): make DTO validation failures 422 instead of the default 400
app.useGlobalPipes(new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, transform: true,
  errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
}));
app.useGlobalFilters(new AllExceptionsFilter());
```

```ts
// orders.controller.ts (excerpt): 201 with Location, 202 for async, 204 for delete
@Post()
@HttpCode(201)
async create(@Body() dto: CreateOrderDto, @Res({ passthrough: true }) res: Response) {
  const order = await this.orders.create(dto);
  res.setHeader('Location', `/v1/orders/${order.id}`);
  return order;
}

@Post(':id/export')
@HttpCode(202)
async export(@Param('id', ParseUUIDPipe) id: string) {
  const job = await this.exports.enqueue(id);
  return { jobId: job.id, statusUrl: `/v1/exports/${job.id}` };
}

@Delete(':id')
@HttpCode(204)
async remove(@Param('id', ParseUUIDPipe) id: string) {
  await this.orders.remove(id); // idempotent: removing a missing order is a no-op
}
```

#### PostgreSQL example

Postgres error codes (`SQLSTATE`) map cleanly to HTTP codes, and the mapping should live in one place (the filter above).

| SQLSTATE | Meaning | HTTP |
|---|---|---|
| `23505` | unique violation | `409` |
| `23503` | foreign key violation | `422` |
| `23514` | check constraint violation | `422` |
| `40001` | serialization failure | retry internally, then `409` |
| `40P01` | deadlock detected | retry internally, then `409` |
| `57014` | query cancelled (`statement_timeout`) | `503` with `Retry-After` |
| `53300` | too many connections | `503` |
| `08006` | connection failure | `503` |

```sql
-- Reproduce 57014 to test the mapping
SET statement_timeout = '100ms';
SELECT pg_sleep(1);
-- ERROR:  canceling statement due to statement timeout  (SQLSTATE 57014)
```

#### Production scenario

A healthy API at 1,500 RPS shows roughly: 92% `200`, 4% `201`/`204`, 2.5% `304`, 1% `4xx` (mostly `401` from expired tokens and `404`), and under 0.05% `5xx`. Alerting: application `5xx` rate over 0.5% for 5 minutes; ALB-generated `5xx` over 0.1% for 2 minutes (a lower threshold because it indicates infrastructure problems); `429` rate as a capacity signal, not an error.

#### Failure scenario

At 11:20 the error dashboard showed `503` at 30% of requests. Application logs showed nothing wrong. The ALB access log showed `elb_status_code=503, target_status_code=-`: the ALB itself, meaning no healthy targets. The readiness probe had begun failing because a new version of the health check pinged a Redis instance that was being resized; the app was otherwise fine. Lesson: the readiness check should fail only for dependencies without which the service cannot serve anything, and the dashboard should split ALB-generated codes from app codes.

#### Edge cases & failure modes

- Returning `200` with `{"error": ...}` breaks every client's retry logic and every dashboard.
- `401` versus `403`: `401` triggers token refresh loops; returning `401` for authorisation failures makes clients refresh tokens forever.
- `404` for authorisation hiding is fine but must be consistent, or an attacker learns which ids exist.
- `500` from validation bugs (throwing plain `Error`) instead of `4xx` makes clients retry things that can never succeed.
- `502` storms on deploy indicate the keep-alive race (4.9) or missing draining.
- `504` from the ALB means the client waited 60 seconds; your own timeout at 10 to 30 seconds gives a faster, more honest answer.
- Redirecting `POST` with `301`/`302` changes it to `GET` in browsers; use `307`/`308`.

#### How a Senior Backend Engineer thinks about this

They pick codes for what the client should do next, not for how the error feels. They own a single mapping from domain and database errors to codes. They separate infrastructure-generated codes from application-generated ones in every dashboard. They never return `500` for something the client can fix. To a product manager: "A 4xx is the customer's form to fix; a 5xx is our pager to answer. Mixing them up hides our bugs and blames the customer."

#### Common mistakes

- `200` for everything with an error flag in the body.
- `500` for validation failures.
- `401` when the user is authenticated but not allowed.
- `503` without `Retry-After`.
- Not reading ALB access logs to see who generated a `5xx`.

#### Interview questions

1. **When do you return `409` versus `412` versus `422`?** `409` for a state conflict (duplicate, in progress), `412` for a failed precondition header (`If-Match`), `422` for semantically invalid input.
2. **The ALB returns `502` but your app logs show nothing. What are the three likeliest causes?** Keep-alive timeout race, target closed connection mid-request during a deploy without draining, malformed response headers.
3. **`401` or `403` for "you cannot view another user's order"?** `403` (or `404` to hide existence); `401` means "who are you".
4. **How should a client treat `429` and `503`?** Back off using `Retry-After` with jitter; never tight-loop.
5. **Which status should a failed `statement_timeout` map to?** `503` with `Retry-After`; the request may succeed later.
6. **Why is `202` useful and what must the response contain?** For long-running work; a job id and a status URL.

#### Practical exercise

Write the global exception filter and a test suite that asserts the code for each of: invalid DTO, duplicate email, foreign-key failure, statement timeout, missing token, wrong owner, unknown id, rate limit. Then deploy behind an ALB, kill a pod during a load test, and produce a table from the ALB access log splitting `elb_status_code` from `target_status_code`. Acceptance criteria: all tests green, and a dashboard panel that separates app 5xx from ALB 5xx.
