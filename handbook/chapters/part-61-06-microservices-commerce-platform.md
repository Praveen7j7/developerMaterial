## 61.6 Project 6 — Microservices-based commerce platform

### 61.6.1 Goal and what you will learn

You will take the modular monolith from Project 2 and the payment system from Project 4 and cut them into services: a **gateway BFF** plus **auth**, **catalog**, **orders**, **payments**, **inventory** and **notification**. A Kafka event backbone with a written schema-compatibility policy. A PostgreSQL database per service, with no shared tables and no cross-service joins. Sagas that now span the network. Authentication and rate limiting at the gateway. Service-to-service authentication. OpenTelemetry tracing across every hop. Kubernetes manifests or a Helm chart per service. A CI/CD pipeline per service with contract tests. Shared dashboards. A chaos test plan. And a strangler-fig migration plan that gets you from the monolith to this without a big-bang rewrite.

The goal is not to convince you that microservices are good. It is to make you competent enough to have the argument. By the end you will have felt, in your own hands, that:

- **Every in-process call you replace with a network call gains four new failure modes**: slow, failed, duplicated, and partially applied. The mantra from the rest of this book stops being a slogan here.
- **A database per service is the actual boundary.** Shared tables are the thing that makes "microservices" a distributed monolith with extra latency.
- **Events are a public API.** Once another team consumes your event, its shape is a contract, and you need a compatibility policy before you need a schema registry.
- **Sagas across the network need timeouts, compensation and observability**, and the observability is the hard part.
- **Tracing is not optional at six hops.** Without a trace id that survives HTTP and Kafka, debugging becomes archaeology.
- **The operational surface multiplies.** Six pipelines, six databases, six sets of dashboards, six on-call runbooks. That cost is real and you should be able to quantify it.

### 61.6.2 Requirements

**Functional**

1. All Project 2 and Project 4 capabilities still work end to end: browse, search, cart, checkout, payment, refund, notification.
2. The gateway is the only public entry point; it authenticates, rate-limits, and composes responses for the client.
3. Each service owns its data; no service reads another service's database.
4. Services communicate synchronously (HTTP or gRPC) only where the caller needs an answer now; everything else is an event.
5. Checkout is a saga orchestrated by the orders service across payments and inventory, with compensation.
6. All events are published through per-service outboxes and consumed idempotently through per-service inboxes.
7. Every request carries a trace context across HTTP and Kafka; every span is attributable to a service and a version.
8. Each service deploys independently with its own pipeline, its own migrations and its own rollback.
9. Contract tests fail a producer's build if it breaks a consumer's expectations.
10. A documented schema-compatibility policy governs every topic.
11. A chaos test plan exercises each cross-service dependency failing.
12. A strangler-fig plan describes the sequence from monolith to platform with no big-bang cutover.

**Non-functional**

| Property | Target | Notes |
|---|---|---|
| Checkout end to end | p95 under 3 s including the provider | Budget: gateway 20 ms, orders 80 ms, inventory 40 ms, payments 2.4 s, slack 400 ms |
| Product page | p95 under 200 ms at the gateway | Composed from catalog plus inventory, with a stale-tolerant cache |
| Availability, read path | 99.95 percent | Catalog must survive orders being down |
| Availability, checkout | 99.9 percent | It depends on four services and a provider |
| Inter-service timeout | 800 ms default, 2 s for payments confirm | Shorter than the caller's own budget, always |
| Event lag | p99 under 5 s from produce to consume | Beyond that, users notice stale state |
| Deploy frequency | any service, any time, no coordination | The reason for doing this at all |
| Rollback time | under 3 minutes per service | `helm rollback` plus a compatible schema |
| Trace coverage | 100 percent of checkout requests sampled | Tail-based sampling elsewhere |

### 61.6.3 Architecture

```mermaid
flowchart TB
  client["Web and mobile"] --> gw["Gateway BFF"]
  gw --> auth["Auth service"]
  gw --> cat["Catalog service"]
  gw --> ord["Orders service"]
  gw --> inv["Inventory service"]
  ord --> pay["Payments service"]
  ord --> inv
  pay --> psp["Payment provider"]
  cat --> catdb[("catalog db")]
  ord --> orddb[("orders db")]
  pay --> paydb[("payments db")]
  inv --> invdb[("inventory db")]
  auth --> authdb[("auth db")]
  notif["Notification service"] --> notifdb[("notify db")]
  kafka["Kafka backbone"] --> notif
  ord --> kafka
  pay --> kafka
  inv --> kafka
  cat --> kafka
```

The gateway is a **backend for frontend**: it terminates authentication, applies rate limits, fans out to two or three services, and returns one response shaped for the client. It holds no business logic and no database. When a product page needs catalog data plus live stock, the gateway makes two parallel calls with a 300 ms budget each and degrades: if inventory is slow, the page renders with `stockStatus: "unknown"` rather than failing.

Synchronous calls exist in exactly three places: gateway to services, orders to inventory (reserve and commit need an answer), and orders to payments (the customer is waiting). Everything else is an event. That rule is worth writing on the wall, because every extra synchronous edge multiplies your availability: three services at 99.9 percent in series give 99.7 percent, and nobody notices the arithmetic until the incident review.

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Gateway
  participant O as Orders
  participant I as Inventory
  participant P as Payments
  participant K as Kafka
  participant N as Notifications
  C->>G: POST /checkout with token
  G->>G: verify JWT, rate limit
  G->>O: POST /orders s2s token traceparent
  O->>I: POST /reservations 800ms budget
  I-->>O: reservation held
  O->>P: POST /payments/intents
  P-->>O: intent requires_confirmation
  O-->>G: 201 order pending_payment
  C->>G: POST /payments/pi_1/confirm
  G->>P: confirm
  P->>K: payment.captured via outbox
  K->>O: consume payment.captured
  O->>I: POST /reservations/commit
  O->>K: order.paid
  K->>N: send confirmation email
```

### 61.6.4 Database schema

The schema work in this project is not new tables; it is **the cut**. Each service gets its own PostgreSQL database, its own migrations, its own connection pool and its own credentials.

| Service | Owns | Duplicates as read model | Never touches |
|---|---|---|---|
| auth | `users`, `credentials`, `sessions`, `refresh_tokens`, `roles` | — | everything else |
| catalog | `categories`, `products`, `variants`, `reviews` | — | inventory levels |
| inventory | `inventory`, `inventory_reservations`, `stock_movements` | `variant_ref` (id, sku, active) | prices |
| orders | `orders`, `order_items`, `order_events`, `sagas`, `saga_steps` | `product_snapshot` on each item, `user_ref` (id, email hash) | inventory rows |
| payments | `payments`, `payment_attempts`, `ledger_*`, `webhook_events` | `order_ref` (id, total, currency) | order items |
| notification | `notifications`, `deliveries`, `templates`, `preferences`, `inbox` | `user_contact` (email, phone, locale, timezone) | orders |

Every service also gets the same two infrastructure tables:

```sql
-- One per service database. The transactional bridge to Kafka.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  event_id      uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  aggregate     text NOT NULL,
  aggregate_id  text NOT NULL,
  type          text NOT NULL,          -- 'order.paid'
  schema_version int NOT NULL DEFAULT 1,
  payload       jsonb NOT NULL,
  trace_context text,                   -- W3C traceparent captured at write time
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- One per service database. Consumer-side idempotency.
CREATE TABLE inbox (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  topic        text NOT NULL,
  handled_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX inbox_cleanup_idx ON inbox (handled_at);
```

And the read-model tables that replace the joins you lost. Orders can no longer join `products`, so it snapshots what it needs at order time:

```sql
-- orders service: what the customer actually bought, frozen forever.
CREATE TABLE order_items (
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id   bigint NOT NULL,
  sku          text NOT NULL,
  title        text NOT NULL,           -- snapshot, not a join
  image_url    text,
  unit_price_cents bigint NOT NULL,     -- snapshot: the price they agreed to
  quantity     int NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, variant_id)
);

-- inventory service: a slim projection of catalog, kept by consuming catalog events.
CREATE TABLE variant_ref (
  variant_id   bigint PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  active       boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  source_event uuid                       -- last event applied, for debugging
);

-- notification service: contact details, kept by consuming auth events.
CREATE TABLE user_contact (
  user_id      uuid PRIMARY KEY,
  email        citext,
  phone_e164   text,
  locale       text NOT NULL DEFAULT 'en',
  timezone     text NOT NULL DEFAULT 'UTC',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

Snapshotting is not denormalisation for performance; it is **correctness**. An order line must show the price the customer paid, not today's price, and a service that joins live catalog data into old orders will eventually show a customer a receipt that does not match their card statement.

```mermaid
erDiagram
  ORDERS ||--o{ ORDER_ITEMS : snapshots
  ORDERS ||--o| SAGAS : coordinated_by
  ORDERS ||--o{ OUTBOX : publishes
  PAYMENTS ||--o{ LEDGER_ENTRIES : posts
  PAYMENTS ||--o{ INBOX : consumes
  INVENTORY ||--o{ INVENTORY_RESERVATIONS : holds
  INVENTORY ||--o{ VARIANT_REF : projects
  NOTIFICATIONS ||--o{ USER_CONTACT : reads
  ORDER_ITEMS {
    uuid order_id FK
    bigint variant_id
    text title
    bigint unit_price_cents
  }
  VARIANT_REF {
    bigint variant_id PK
    text sku
    boolean active
    uuid source_event
  }
```

### 61.6.5 APIs

**Public, at the gateway.** Same shapes as Projects 2 and 4, so clients do not change during the migration. The gateway adds composition endpoints.

| Method | Path | Auth | Composes | Degradation | Codes |
|---|---|---|---|---|---|
| GET | `/api/products/:slug` | optional | catalog + inventory | Renders without stock if inventory times out | 200, 404, 503 |
| GET | `/api/search` | optional | catalog | none | 200, 422 |
| POST | `/api/cart/items` | optional | catalog price check + cart | 409 if catalog is unavailable | 200, 404, 409, 503 |
| POST | `/api/checkout` | required | orders (which fans out) | none; checkout requires everything | 201, 409, 502, 504 |
| POST | `/api/payments/:id/confirm` | required | payments | none | 200, 202, 402, 504 |
| GET | `/api/orders/:id` | required | orders + payments status | Shows order without payment detail if payments is down | 200, 403, 404 |
| GET | `/api/me/notifications` | required | notification | Empty list with a warning header | 200 |

**Internal, service to service.** Not public, authenticated with a service token, with an explicit timeout and idempotency contract.

| Caller | Callee | Endpoint | Timeout | Idempotency | Failure policy |
|---|---|---|---|---|---|
| gateway | any | `GET /internal/health` | 300 ms | — | Remove from pool |
| gateway | auth | `GET /internal/jwks` | 500 ms | — | Cached 300 s, stale allowed |
| orders | inventory | `POST /internal/reservations` | 800 ms | `Idempotency-Key: order:{id}` | Retry once, then fail the saga |
| orders | inventory | `POST /internal/reservations/:id/commit` | 800 ms | key = reservation id | Retry with backoff; saga step, safe forever |
| orders | inventory | `POST /internal/reservations/:id/release` | 800 ms | key = reservation id | Compensation; retry until success |
| orders | payments | `POST /internal/payments/intents` | 1 s | `Idempotency-Key: order:{id}` | Fail the saga; compensate the reservation |
| orders | payments | `POST /internal/payments/:id/refund` | 2 s | `Idempotency-Key: refund:{orderId}:{n}` | Compensation; retry forever with alert |
| catalog | inventory | none | — | — | Uses events only |

Notice what is missing: nobody calls the notification service synchronously. Notifications are always an event, because a notification that fails must never fail the business action that caused it.

### 61.6.6 NestJS modules

A monorepo (Nx or npm workspaces) with one deployable per service and shared libraries that are versioned, not shared by reaching into each other's source.

```text
platform/
  apps/
    gateway/        src/  Dockerfile  helm/
    auth/           src/  Dockerfile  helm/  migrations/
    catalog/        ...
    inventory/      ...
    orders/         ...
    payments/       ...
    notification/   ...
  libs/
    contracts/      events/*.ts  (typed event payloads + version)
    http-client/    resilient-client.ts (timeout, retry, breaker, propagation)
    kafka/          producer.ts consumer.ts outbox-relay.ts inbox.ts
    observability/  otel.ts logger.ts metrics.ts
    auth-guards/    jwt.guard.ts service-token.guard.ts roles.guard.ts
```

**`libs/http-client/resilient-client.ts` — every synchronous hop goes through this.**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { CircuitBreaker } from './circuit-breaker';

export class UpstreamTimeout extends Error {}
export class UpstreamUnavailable extends Error {}

@Injectable()
export class ResilientClient {
  private readonly log = new Logger(ResilientClient.name);
  private readonly breakers = new Map<string, CircuitBreaker>();

  async call<T>(opts: {
    service: string; method: string; path: string; body?: unknown;
    timeoutMs: number; idempotencyKey?: string; retries?: number;
  }): Promise<T> {
    const breaker = this.breakers.get(opts.service)
      ?? this.breakers.set(opts.service, new CircuitBreaker({ failureThreshold: 5, halfOpenAfterMs: 15_000 })).get(opts.service)!;
    if (breaker.isOpen()) throw new UpstreamUnavailable(`${opts.service}_breaker_open`);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${await this.serviceToken(opts.service)}`,
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    };
    // Inject W3C traceparent so the callee's spans join this trace.
    propagation.inject(context.active(), headers);

    const span = trace.getTracer('http-client').startSpan(`${opts.service} ${opts.method} ${opts.path}`);
    const attempts = (opts.retries ?? 0) + 1;
    for (let i = 1; i <= attempts; i++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), opts.timeoutMs);
      try {
        const res = await fetch(`http://${opts.service}${opts.path}`, {
          method: opts.method, headers, signal: ac.signal,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        if (res.status >= 500) throw new UpstreamUnavailable(`http_${res.status}`);
        breaker.recordSuccess(); span.setStatus({ code: SpanStatusCode.OK });
        return (await res.json()) as T;
      } catch (err) {
        breaker.recordFailure();
        const timedOut = (err as Error).name === 'AbortError';
        if (i === attempts) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw timedOut ? new UpstreamTimeout(`${opts.service}_timeout`) : err;
        }
        await new Promise((r) => setTimeout(r, 100 * i + Math.random() * 100));
      } finally { clearTimeout(t); span.end(); }
    }
    throw new UpstreamUnavailable('unreachable');
  }
}
```

Retries are **opt-in and only for idempotent calls**. Retrying `POST /internal/payments/intents` without an idempotency key is how you create two payment intents for one order. The rule in the codebase: `retries > 0` requires `idempotencyKey`, enforced by a type constraint or a runtime assertion.

**`libs/auth-guards/service-token.guard.ts` — service-to-service authentication.**

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify, createRemoteJWKSet } from 'jose';

/** Short-lived service JWTs issued by auth, aud = callee, sub = caller service. */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly jwks = createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL!));

  constructor(private readonly reflector: Reflector, private readonly me: string) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: 'https://auth.internal', audience: this.me,
    });
    const allowed = this.reflector.get<string[]>('allowedCallers', ctx.getHandler()) ?? [];
    if (allowed.length && !allowed.includes(String(payload.sub))) {
      throw new ForbiddenException({ code: 'caller_not_allowed', caller: payload.sub });
    }
    req.caller = payload.sub;
    return true;
  }
}
```

A network policy that says "only pods labelled `app=orders` may reach `inventory:3000`" is the second layer; the token is the first. Do both. mTLS through a service mesh is the third, and worth it only once you have more services than people.

**`libs/kafka/outbox-relay.ts` — the same relay, now in six services.**

```ts
@Injectable()
export class OutboxRelay {
  constructor(private readonly ds: DataSource, private readonly producer: Producer,
              private readonly topicFor: (type: string) => string) {}

  @Interval(500)
  async tick() {
    await this.ds.transaction(async (em) => {
      const rows = await em.query(
        `SELECT id, event_id, type, aggregate_id, payload, schema_version, trace_context
           FROM outbox WHERE published_at IS NULL
          ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`);
      if (!rows.length) return;
      await this.producer.send({
        topic: this.topicFor(rows[0].type),
        messages: rows.map((r: any) => ({
          key: r.aggregate_id,
          value: JSON.stringify(r.payload),
          headers: {
            eventId: r.event_id, eventType: r.type,
            schemaVersion: String(r.schema_version),
            traceparent: r.trace_context ?? '',
          },
        })),
      });
      await em.query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1)`,
        [rows.map((r: any) => r.id)]);
    });
  }
}
```

Note that messages from one batch may span several topics in a real implementation; group them by topic before sending. And note the `trace_context` column: it is what makes an event's consumer span attach to the trace of the HTTP request that caused it, which is the difference between a trace that ends at the outbox and one that reaches the email.

### 61.6.7 PostgreSQL design decisions

**A database per service, physically separate.** Not a schema per service in one instance, at least not permanently: shared instances mean shared connection limits, shared vacuum pressure, shared failover and, eventually, someone writing a cross-schema join "just this once". Start with separate databases on one instance during the migration if budget requires, and split instances before the second team joins.

**No distributed transactions.** There is no `BEGIN` that spans orders and inventory. The saga replaces it, and every step is a local transaction plus an idempotent remote call. Say this out loud when someone proposes two-phase commit: XA across services couples their availability, which is the thing you were trying to avoid.

**Eventual consistency, with names.** After `order.paid`, the notification service knows within a few seconds. Between those moments the system is inconsistent, and that is fine as long as it is *bounded* and *observable*. Set an SLO on event lag (p99 under 5 s), alarm on it, and make the UI honest ("we are preparing your confirmation") rather than pretending.

**Migrations, per service, per pipeline.** Each service runs its own migration Job before its own rollout. Expand-contract is now mandatory rather than good practice, because two versions of a service run simultaneously during every rollout and a consumer may lag a version behind a producer for hours. The order is always: add the new nullable column, deploy code that writes both, backfill in batches, deploy code that reads new, then drop the old in a later release. Never in one deploy.

**Connection pools.** Six services times three pods times a pool of 10 is 180 connections; each database sees only its own share now, which is one of the quiet benefits of the split. Set `max` per pod deliberately and add PgBouncer per database when a service scales past about 100 connections.

**Reference data drift.** `variant_ref` in inventory is a projection built from catalog events. It *will* drift — a missed event, a bug, a topic retention expiry during an outage. Build a nightly reconciliation job that compares projections against the owner and reports differences, and expose `projection_drift_rows` as a metric. Every event-driven system that has run for two years and never reconciled is quietly wrong somewhere.

### 61.6.8 Redis usage

| Owner | Key | Purpose | TTL |
|---|---|---|---|
| gateway | `rl:{userOrIp}:{route}` | Rate limiting at the edge, sliding window in Lua | 60 s |
| gateway | `jwks:auth` | Cached JWKS so every request does not call auth | 300 s |
| gateway | `compose:product:{slug}` | Composed product payload | 30 s |
| catalog | `product:{slug}`, `category:tree` | Same as Project 2 | 300 s |
| inventory | `stock:{variantId}` | Read-mostly stock badge | 15 s |
| orders | `lock:order:{id}` | Advisory lock across multi-step flows | 15 s |
| payments | `breaker:psp`, `idem:{route}:{key}` | As in Project 4 | varies |
| notification | buckets, breakers, `ws:user:{id}` | As in Project 3 | varies |

Each service gets its **own** Redis logical database or its own instance. A shared Redis with shared key prefixes is a shared failure domain and, worse, a shared namespace where one team's `FLUSHDB` during a local debugging session takes down someone else's rate limiter. The gateway's Redis is the most critical one: if it is down, choose fail-open for rate limiting and fail-closed for nothing.

### 61.6.9 Messaging usage

**Topics and ownership.** One producing service per topic. Nobody writes to a topic they do not own.

| Topic | Owner | Partitions | Key | Consumers | Retention |
|---|---|---|---|---|---|
| `auth.events.v1` | auth | 6 | `user_id` | notification, orders | 7 days |
| `catalog.events.v1` | catalog | 12 | `product_id` | inventory, search indexer | 7 days |
| `inventory.events.v1` | inventory | 12 | `variant_id` | catalog, orders | 7 days |
| `order.events.v1` | orders | 12 | `order_id` | payments, notification, analytics | 30 days |
| `payment.events.v1` | payments | 12 | `order_id` | orders, notification, analytics | 30 days |
| `*.dlq` | each | 3 | original key | none; drained by the replay tool | 30 days |

**Schema-compatibility policy.** Write it down, put it in the repository, and enforce it in CI. The policy:

1. Every event has `eventId`, `eventType`, `schemaVersion`, `occurredAt`, `aggregateId` and a `data` object.
2. Schemas live in `libs/contracts`, one file per event and version, published as a versioned package.
3. **Backward compatible changes only** within a major version: add optional fields, add enum values that consumers treat as unknown, never rename, never change a type, never make an optional field required, never remove a field consumers use.
4. A breaking change means a **new topic** (`order.events.v2`) and a period where the producer writes both. Consumers migrate on their own schedule; the old topic is retired only when its consumer-group lag has been zero and its consumer list empty for two weeks.
5. Consumers must ignore unknown fields. This one rule prevents most breakages.
6. CI runs a compatibility check comparing the schema on the branch with the schema on `main` and fails the build on a backward-incompatible change without a version bump.

Confluent Schema Registry with Avro or Protobuf enforces this mechanically; a JSON Schema file plus a CI check enforces it well enough for a platform this size. Pick one and make it non-negotiable.

**Consumer groups, retries, DLQ.** One consumer group per service per topic, named `{service}-{topic}`. Handlers are idempotent through the inbox table. Retries use the retry-topic ladder from Project 3 (30 s, 5 min, 30 min, DLQ). Consumer lag is a first-class alert per group, because in a distributed system lag is how "everything is green but nothing works" manifests.

**Outbox and inbox everywhere.** Every producing service writes to its outbox inside the business transaction; every consuming service records the `eventId` in its inbox inside the handling transaction. Six services, twelve tables, one pattern. The uniformity is the point: an on-call engineer who understands it in one service understands it in all of them.

### 61.6.10 Testing strategy

The test pyramid changes shape. Unit and integration tests stay per service, but a whole new layer appears between them and end-to-end: **contract tests**.

- **Unit** — pure logic, as before.
- **Integration (per service)** — Testcontainers with that service's PostgreSQL, Redis and Redpanda; the service's own HTTP surface and consumers.
- **Contract (consumer-driven)** — with Pact or an equivalent, the orders service (consumer) declares "when I POST `/internal/reservations` with this body, I expect a 201 with `{reservationId, expiresAt}`". That expectation becomes a pact file; the inventory service's pipeline replays it against the real service and fails if it no longer holds. Do the same for events: a consumer declares the fields it reads, and the producer's build verifies its schema still provides them. This is the mechanism that lets six teams deploy independently without a shared staging traffic jam.
- **End-to-end (few, high value)** — five journeys against a fully composed environment: browse to order to paid to notified; cancel unpaid; refund; login and session revocation; search after a catalog update propagates.

The ten most important test cases:

1. **Cross-service saga happy path** — checkout completes; assert order `paid`, reservation `committed`, ledger balanced, notification sent, and one trace containing all six services.
2. **Inventory times out during reserve** — orders retries once, then fails the saga with 409; no orphan reservation; the customer sees a clear error.
3. **Payments succeeds but orders never hears** — drop the `payment.captured` event; the reconciliation job in orders detects a captured payment with an unpaid order within 5 minutes and completes the saga.
4. **Duplicate event delivery** — replay 10,000 events from a topic; inbox dedupe means zero duplicate side effects and zero duplicate emails.
5. **Contract break is caught** — remove a field from `order.paid` in the producer; the notification service's pact verification fails the producer's build.
6. **Schema evolution works** — add an optional field, deploy the producer first, and assert old consumers are unaffected; then add a required field and assert CI blocks it.
7. **Gateway degradation** — kill inventory; product pages still render with unknown stock, checkout returns a clean 503, and no gateway thread pool is exhausted.
8. **Auth key rotation across services** — rotate the signing key; every service picks up the new JWKS within 300 s with zero rejected valid tokens.
9. **Compensation across the network** — force commit-reservation to fail permanently; the saga refunds the payment and restocks; the final state is consistent and the customer is notified.
10. **Trace completeness** — assert programmatically that a checkout trace contains spans from gateway, orders, inventory, payments, Kafka producer, Kafka consumer and notification, with one trace id.

### 61.6.11 Docker

Each service keeps its own Dockerfile (the multi-stage shape from Project 1). Local development uses one compose file with profiles so you can run a subset:

```yaml
x-service: &service
  build: { context: ., dockerfile: apps/${SVC}/Dockerfile }
  environment: &common
    KAFKA_BROKERS: redpanda:9092
    OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
    AUTH_JWKS_URL: http://auth:3000/.well-known/jwks.json
  depends_on: [redpanda, otel-collector]

services:
  redpanda:
    image: redpandadata/redpanda:latest
    command: ["redpanda","start","--smp","2","--memory","2G","--overprovisioned",
              "--kafka-addr","PLAINTEXT://0.0.0.0:9092","--advertise-kafka-addr","PLAINTEXT://redpanda:9092"]
  pg-auth:      { image: postgres:16, environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: auth } }
  pg-catalog:   { image: postgres:16, environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: catalog } }
  pg-inventory: { image: postgres:16, environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: inventory } }
  pg-orders:    { image: postgres:16, environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: orders } }
  pg-payments:  { image: postgres:16, environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: payments } }
  pg-notify:    { image: postgres:16, environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: notify } }
  redis:        { image: redis:7-alpine }
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    volumes: ["./ops/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro"]
    ports: ["4318:4318"]
  jaeger:  { image: jaegertracing/all-in-one:latest, ports: ["16686:16686"] }
  grafana: { image: grafana/grafana:latest, ports: ["3001:3000"] }
  gateway:
    build: { context: ., dockerfile: apps/gateway/Dockerfile }
    environment: { <<: *common, REDIS_URL: redis://redis:6379 }
    ports: ["8080:3000"]
  orders:
    build: { context: ., dockerfile: apps/orders/Dockerfile }
    environment: { <<: *common, DATABASE_URL: postgres://postgres:dev@pg-orders:5432/orders }
  # ...one block per service, same shape
```

Be honest about the cost: this compose file starts fifteen containers and needs about 8 GiB of RAM. That is a real tax on every developer's laptop and on every new joiner's first day, and it is one of the items in section 61.6.19.

**Kubernetes, one Helm chart per service.** The chart is a small template with per-service values:

```yaml
# apps/orders/helm/values.yaml
replicaCount: 3
image: { repository: ghcr.io/acme/orders, tag: "" }        # set by CI to the SHA
resources:
  requests: { cpu: 250m, memory: 384Mi }
  limits:   { cpu: "1",  memory: 768Mi }
probes:
  liveness:  { path: /health/live,  initialDelaySeconds: 10, periodSeconds: 10 }
  readiness: { path: /health/ready, periodSeconds: 5, failureThreshold: 3 }
podDisruptionBudget: { minAvailable: 2 }
hpa: { enabled: true, minReplicas: 3, maxReplicas: 20, targetCPUUtilizationPercentage: 65 }
migrationJob: { enabled: true, command: ["node","dist/migrate.js"] }
env:
  KAFKA_BROKERS: kafka-bootstrap:9092
  OTEL_SERVICE_NAME: orders
secrets: [DATABASE_URL, SERVICE_TOKEN_KEY]
networkPolicy:
  ingressFrom: [gateway]
  egressTo: [pg-orders, kafka, inventory, payments]
```

`/health/live` returns 200 if the process is alive. `/health/ready` returns 503 when the database pool cannot serve or Kafka producer is disconnected — but **not** when a downstream service is down, or one slow dependency will cascade into every pod in the cluster being marked unready at once. That distinction has caused more self-inflicted outages than any other Kubernetes setting.

### 61.6.12 CI/CD

One pipeline per service, triggered by path filters so a catalog change does not rebuild payments.

```yaml
name: orders
on:
  push:
    branches: [main]
    paths: ["apps/orders/**", "libs/**"]
  pull_request:
    paths: ["apps/orders/**", "libs/**"]

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: dev, POSTGRES_DB: orders_test }, ports: ["5432:5432"], options: --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10 }
      redis:    { image: redis:7, ports: ["6379:6379"] }
      redpanda: { image: redpandadata/redpanda:latest, ports: ["9092:9092"] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx nx lint orders && npx nx typecheck orders
      - run: npx nx test orders
      - run: npm run schema:compat -- --service orders     # event compatibility gate
      - run: npx nx run orders:test-integration
      - run: npx nx run orders:pact-consumer                # publish consumer pacts
      - run: npx nx run orders:pact-verify                  # verify pacts others hold on us
  build:
    needs: verify
    steps:
      - uses: docker/build-push-action@v6
        with: { file: apps/orders/Dockerfile, push: true, tags: "ghcr.io/acme/orders:${{ github.sha }}" }
      - uses: aquasecurity/trivy-action@master
        with: { image-ref: "ghcr.io/acme/orders:${{ github.sha }}", severity: "CRITICAL,HIGH", exit-code: "1" }
      - run: npx @cyclonedx/cyclonedx-npm --output-file sbom.json
  deploy-staging:
    needs: build
    steps:
      - run: helm upgrade --install orders apps/orders/helm --namespace staging --set image.tag=${{ github.sha }} --wait --timeout 5m
      - run: ./scripts/smoke.sh https://orders.staging.internal
      - run: npx nx run e2e:checkout --env staging
  can-i-deploy:
    needs: deploy-staging
    steps:
      - run: npx pact-broker can-i-deploy --pacticipant orders --version ${{ github.sha }} --to-environment production
  deploy-production:
    needs: can-i-deploy
    environment: production
    steps:
      - run: helm upgrade --install orders apps/orders/helm --namespace prod --set image.tag=${{ github.sha }} --wait --timeout 10m
      - run: ./scripts/smoke.sh https://orders.internal || helm rollback orders --namespace prod
```

`can-i-deploy` is the gate that makes independent deployment safe: it asks the contract broker whether this version of orders is compatible with the versions of its providers and consumers currently in production. Without it, "deploy independently" quietly means "break each other independently".

Migrations run as a Helm pre-upgrade hook Job per service. Rollback is `helm rollback`, which is fast — but only safe if the migration was expand-only, which is why the expand-contract rule is enforced by review and, ideally, by a migration linter.

### 61.6.13 Observability

**Tracing is the backbone.** Every service initialises OpenTelemetry at boot, before any other import:

```ts
// libs/observability/otel.ts - imported first in every main.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';

export function startTelemetry(serviceName: string) {
  const sdk = new NodeSDK({
    resource: new Resource({
      'service.name': serviceName,
      'service.version': process.env.GIT_SHA ?? 'dev',
      'deployment.environment': process.env.ENV ?? 'local',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },   // noisy, useless here
    })],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
```

Auto-instrumentation covers HTTP, PostgreSQL, Redis and KafkaJS. What it cannot do is bridge the outbox: the event is written now and published later, so you capture `traceparent` into the `outbox.trace_context` column at write time and restore it as the parent when the relay produces. Do that, and a single trace runs from the customer's click, through orders, into Kafka, out to notification, and ends at the email provider call. That trace is the single most valuable artefact this project produces.

**Metrics, standardised across services** through the shared library, so every dashboard works for every service: `http_server_duration_seconds{service,route,status}`, `http_client_duration_seconds{service,upstream,status}`, `breaker_state{service,upstream}`, `kafka_consumer_lag{service,topic,group}`, `outbox_lag_seconds{service}`, `inbox_duplicates_total{service}`, `saga_active{state}`, `projection_drift_rows{projection}`, plus each service's business metrics.

**Log fields, standardised:** `timestamp, level, service, version, env, traceId, spanId, requestId, caller, userId, route, status, durationMs, outcome`. Ship them to one place with the trace id indexed, so you can pivot from a slow trace to its logs in one click.

**Shared dashboards.** Build three, and make them the same for every service: a **service dashboard** (RPS, error rate, latency percentiles, saturation, dependency latencies, breaker states) templated by service name; a **platform dashboard** (all services' error budgets, the slowest dependency edge, Kafka lag across all groups, outbox lag across all services); and a **journey dashboard** (checkout funnel with per-step latency taken from traces, so a product manager can see where customers are lost).

**Alerts.** Per service: error rate above 2 percent for 5 minutes; p99 above the SLO for 10 minutes; readiness failures. Platform-wide: any consumer group lag above 10,000 or growing for 15 minutes; any outbox lag above 120 s; breaker open for more than 5 minutes; `projection_drift_rows > 0`; saga stuck over 30 minutes. Route alerts to the owning service's on-call, and make the platform-wide ones page the platform rota — otherwise every Kafka alert wakes six people.

### 61.6.14 Failure scenarios

| Failure | Expected behaviour | How you test it |
|---|---|---|
| Inventory service down | Product pages render without stock; checkout returns 503 with `code: inventory_unavailable`; breaker opens; no cascading thread exhaustion | Scale inventory to 0 replicas; run the journey suite |
| Inventory slow, 3 s responses | 800 ms timeout fires; orders fails fast; gateway p99 unaffected for browse | Inject latency with a toxiproxy sidecar or a chaos mesh delay |
| Kafka unavailable for 20 minutes | Services keep serving; outbox grows; `outbox_lag_seconds` alarms; on recovery everything drains in order with no loss | Stop brokers during a soak test |
| Consumer group rebalance storm | Lag spikes then recovers; no duplicate side effects thanks to the inbox | Roll a consumer deployment repeatedly under load |
| One service deployed with a breaking event change | `can-i-deploy` blocks it in CI; if forced, consumers log unknown-schema and DLQ the message rather than crashing | Deliberately break a schema in a staging branch |
| Auth down | Existing tokens keep working for up to 10 minutes via cached JWKS; new logins fail; the rest of the platform serves | Scale auth to 0; assert browse and checkout with an existing token |
| Payments captures but `order.paid` never publishes | Reconciliation in orders finds captured payments with unpaid orders within 5 minutes and completes the saga | Drop the event in a test harness |
| Network partition between orders and inventory | Reserve times out; saga compensates; reservation may exist in inventory and is released by its own expiry sweeper | Partition with a network policy mid-checkout |
| Gateway Redis down | Rate limiting fails open with an alert; JWKS served from in-process cache; requests continue | Stop the gateway's Redis |
| Cluster node loss with 3 of 9 pods | PDBs and multi-AZ spread keep every service serving; HPA replaces pods | Drain a node during the load test |
| Database failover on one service | That service returns 503 for 10 to 30 s; others unaffected; breakers prevent cascade | Failover the orders database in staging |
| Clock skew across services | Token validation and HMAC windows fail; NTP alert fires | Skew one node's clock by 10 minutes |

**Chaos test plan.** Run it monthly in staging under a 100 req/s synthetic load, one experiment at a time, with a written hypothesis and an abort condition:

1. Kill 30 percent of pods of one service (hypothesis: no user-visible errors).
2. Add 500 ms of latency to one dependency edge (hypothesis: breakers trip, p99 degrades under 20 percent, no cascade).
3. Blackhole one service entirely (hypothesis: documented degradation only).
4. Stop Kafka for 15 minutes (hypothesis: zero data loss, full drain within 10 minutes).
5. Fail over one database (hypothesis: under 60 s of errors for that service only).
6. Fill a disk on one broker (hypothesis: producers back off, alerts fire, no silent loss).
7. Deploy a deliberately broken image (hypothesis: readiness fails, rollout halts, no traffic served).
8. Expire a service token signing key early (hypothesis: alert fires, documented recovery under 10 minutes).

Record the result of every experiment. A chaos plan you run once is theatre; one you run monthly and whose findings change the code is engineering.

### 61.6.15 Scaling strategy

**1x — the platform you just built.** Three replicas per service, one database each, a three-broker Kafka, one Redis per service. The bottleneck at this scale is *you*: six pipelines, six on-call runbooks and fifteen containers on a laptop. Be able to say, honestly, that the monolith would have served this traffic on two pods.

**10x — 8,000 req/s at the gateway.** Scale services independently, which is now the payoff: catalog goes to 20 pods because it takes most of the read traffic; payments stays at 3 because it is bounded by the provider. Kafka partitions increase for the busy topics (plan them at creation). Add read replicas per service database where the read/write ratio justifies it. The gateway becomes the thing to watch: it fans out, so its concurrency and its outbound connection pools are the first saturation point, and it needs its own HPA on both CPU and in-flight requests.

**100x — 80,000 req/s, multi-region.** Now the interesting decisions arrive. Catalog reads move to the edge with a CDN and a stale-while-revalidate policy. Search moves out of PostgreSQL into a dedicated cluster fed by `catalog.events`. Kafka gets tiered storage or shorter retention plus an archive. The write path is regionalised: either an active-passive design with one write region and read replicas everywhere (simple, correct, higher write latency for distant users) or an active-active design with per-region ownership of order ids and a conflict policy (fast, and a genuinely hard distributed-systems problem). Choose active-passive unless someone can articulate why the extra complexity is worth it in revenue.

The scaling insight that matters: at 100x, the platform's limits are almost never CPU. They are partition counts you chose two years ago, connection pools, a single hot row somewhere, a provider's rate limit, and how quickly a human can understand a trace during an incident.

### 61.6.16 Security checklist

- [ ] The gateway is the only ingress; service pods have no public route, enforced by network policy and by ingress configuration.
- [ ] End-user JWTs are verified at the gateway; services re-verify rather than trusting a header, because a compromised pod inside the mesh must not be able to impersonate a user.
- [ ] Service-to-service auth with short-lived JWTs (5 minutes), `aud` set to the callee, `sub` to the caller, and an explicit allowed-callers list per endpoint.
- [ ] Network policies default-deny; every allowed edge is declared in the service's chart and reviewed.
- [ ] mTLS between services if a mesh is in place; TLS to every database and broker regardless.
- [ ] Secrets from a secret manager (External Secrets, Vault or cloud-native); no secrets in charts, images or environment files in git.
- [ ] Per-service database credentials with least privilege; no service can read another's database even if it wanted to.
- [ ] Rate limits at the gateway per user and per IP, plus per-service internal limits so one misbehaving service cannot exhaust another.
- [ ] Kafka ACLs: a service may produce only to the topics it owns and consume only what it declares.
- [ ] Event payloads contain no unnecessary personal data; use ids and let the consumer look up what it needs, or accept the duplication deliberately and document it for deletion requests.
- [ ] Images signed and scanned; only signed images admitted by policy; SBOM published per build.
- [ ] Audit logging at the gateway (who called what) and inside each service for privileged actions.
- [ ] A documented deletion procedure that reaches every service holding a copy of a user's data, including projections and Kafka retention.

### 61.6.17 Stretch goals

A service mesh (Istio or Linkerd) for mTLS, retries and traffic shifting, then a measurement of what it cost in latency and complexity. Canary deployments with automated analysis on error rate and latency. gRPC for the internal hops, with a measurement of the payload-size and latency difference against JSON. CQRS with a dedicated read model for the order history. Event sourcing for one aggregate only, so you feel the difference rather than reading about it. Multi-tenancy with per-tenant quotas. A developer platform: one command that spins up a namespace with only the services you are changing and stubs the rest. Cost attribution per service, which changes architectural conversations more than any diagram. And a written architecture decision record for every major choice, because in eighteen months nobody will remember why the gateway does composition and not the client.

### 61.6.18 Definition of done

- [ ] Six services plus a gateway, each with its own database, pipeline, chart, dashboards and runbook.
- [ ] All Project 2 and Project 4 journeys pass end to end against the composed platform.
- [ ] No service reads another service's database; enforced by credentials and verified by a review checklist.
- [ ] Outbox and inbox in every service; a 10,000-event replay produces zero duplicate side effects.
- [ ] Written schema-compatibility policy, enforced by a CI check that blocks incompatible changes.
- [ ] Consumer-driven contract tests with `can-i-deploy` gating production deploys.
- [ ] One checkout trace contains spans from all six services, including across Kafka; asserted by an automated test.
- [ ] Saga across services completes, compensates correctly, and never leaves a mixed state under the race tests.
- [ ] Reconciliation jobs for the two riskiest projections, with a drift metric that has been at zero for a week.
- [ ] Chaos plan executed at least once end to end, with written results and at least two fixes that came out of it.
- [ ] Independent deploys demonstrated: three services deployed in one afternoon with no coordination and no downtime.
- [ ] Strangler-fig plan written, with the monolith still able to serve every route until the last cutover.
- [ ] Section 61.6.19 written from your own experience, not copied from mine.

### 61.6.19 What got harder

This is the section to write with complete honesty, because it is the one a hiring manager will read most carefully. Everything below genuinely got worse when the monolith became a platform. For each, the mitigation that actually works.

**1. Local development.** One `npm run start:dev` became fifteen containers and 8 GiB of RAM. *Mitigation:* a `docker compose` profile per journey so you run three services, not fifteen; contract stubs generated from pacts for the ones you are not changing; and a shared development namespace in the cluster with per-developer overrides.

**2. Debugging.** A bug that used to be one stack trace is now spread across four services and a topic. *Mitigation:* tracing with propagated context everywhere including the outbox, one log store with `traceId` indexed, and a rule that every error response carries a `traceId` the customer can quote.

**3. Transactions.** `BEGIN ... COMMIT` across orders and inventory no longer exists. Every multi-service change is a saga with compensation, and compensation is code nobody exercises except during incidents. *Mitigation:* sagas defined as data, every step idempotent, compensation paths covered by tests that run on every build, and a `saga_compensations_total` metric so you know when they actually fire.

**4. Data consistency.** The catalog says a product is active; inventory's projection has not caught up; a customer buys something that no longer exists. *Mitigation:* bounded staleness with an SLO on event lag, nightly reconciliation jobs per projection with a drift metric, and UI copy that is honest about eventual consistency.

**5. Testing.** End-to-end tests need the whole platform, so they are slow and flaky, and the temptation is to delete them. *Mitigation:* invest in contract tests so that end-to-end tests can be few (five journeys), and treat a flaky e2e test as a production bug, not a test bug — nine times out of ten it is telling you about a real race.

**6. Deployment coordination.** Independent deploys are only independent if the contracts hold. Our first breaking event change took down notifications for 40 minutes. *Mitigation:* the schema policy, the CI compatibility gate, `can-i-deploy`, and the rule that consumers ignore unknown fields.

**7. Latency.** Checkout gained about 120 ms of pure network and serialisation overhead compared with the monolith's in-process calls. *Mitigation:* keep synchronous hops to a minimum (three, in this design), set explicit budgets per hop, parallelise fan-out at the gateway, and accept the rest as the price of the architecture. Say the number out loud; it stops the argument from being about feelings.

**8. Failure modes multiplied.** Every synchronous edge added timeout, partial failure and retry-duplication. *Mitigation:* the `ResilientClient` as the only way to make a call, timeouts shorter than the caller's budget, idempotency keys on every retryable write, and breakers so a slow service fails fast rather than exhausting its callers.

**9. Operational surface.** Six pipelines, six databases to back up and patch, six sets of alerts, six runbooks, plus Kafka. On-call got noticeably harder. *Mitigation:* uniformity — one chart template, one metrics library, one logging shape, one runbook template — so that knowing one service means knowing all of them. Ruthlessly delete alerts that never lead to action.

**10. Cost.** Infrastructure roughly tripled: more pods with per-pod overhead, six databases instead of one, a Kafka cluster, more inter-AZ traffic, more observability data. *Mitigation:* right-size requests and limits from real usage, use one database instance with several databases until traffic justifies splitting, sample traces (tail-based, keeping all errors), and put a cost-per-service dashboard in front of the team.

**11. Onboarding.** A new engineer used to be productive in two days; now they need a mental model of six services and an event backbone. *Mitigation:* an architecture decision record per major choice, one diagram that is actually maintained, a "your first change" guide that touches exactly one service, and pairing for the first cross-service change.

**12. Reasoning about correctness.** In the monolith, a foreign key guaranteed a product existed. Now it is an event you hope arrived. *Mitigation:* accept that constraints do not cross service boundaries, replace them with reconciliation and monitoring, and be explicit in design reviews about which invariants are enforced and which are merely observed.

**The strangler-fig migration plan.** You do not rewrite. You put the gateway in front of the monolith and move one route at a time:

1. **Deploy the gateway in front of the monolith.** It proxies 100 percent of traffic and does nothing else. Now you have a place to stand. Add authentication and rate limiting here first.
2. **Extract auth.** It has the fewest inbound dependencies. The monolith starts verifying JWTs against the new service's JWKS instead of its own tables. Run both for a week with a comparison log.
3. **Extract notification.** It is asynchronous and nobody blocks on it, so a mistake is cheap. The monolith publishes `order.placed` to Kafka; the new service consumes. Turn off the monolith's email code only after a week of shadow running where both send to a test inbox and you diff them.
4. **Extract catalog reads.** The gateway routes `GET /products/*` to the new catalog service, which reads a replicated copy while the monolith still owns writes. Compare responses in shadow mode. Then move writes and stop dual-writing.
5. **Extract inventory.** The riskiest one, because it owns money-adjacent state. Move the tables, expose the internal API, and change the monolith's `InventoryService` to a thin HTTP client — which is trivial precisely because Project 2 forbade cross-module table access. This is where that lint rule pays for itself.
6. **Extract payments, then orders.** Payments first (it is already isolated behind webhooks and a provider), orders last, because orders is the orchestrator and should be the final thing to move.
7. **Delete the monolith's code path by path**, not in one commit. Keep the route in the gateway pointing at the monolith until the new service has served that route in production for two weeks with equal or better error rates.

At every step: dual-run, compare, and keep the old path deployable for one rollback window. If you cannot roll back a step in ten minutes, the step is too big. Splitting the monolith is not one project; it is fifteen small ones, and the discipline of keeping the system shippable throughout is the actual senior skill on display.

## Senior Checklist — Part 61

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
- [ ] I have built refresh-token rotation with reuse detection and proven it with a test
- [ ] I can prevent overselling under concurrency with an atomic conditional update, and prove it with 50 parallel requests
- [ ] I can explain why my inventory lock ordering makes deadlocks impossible
- [ ] I have written a consumer that is idempotent through an inbox table, and killed it mid-flight to prove it
- [ ] I can implement quiet hours correctly across a DST transition in a named IANA timezone
- [ ] I can build a double-entry ledger and a continuous invariant check that has never fired
- [ ] I know exactly what my system does when a payment provider times out mid-charge
- [ ] I can write a claim query with `FOR UPDATE SKIP LOCKED` and explain every clause and the index it uses
- [ ] I can implement lease-based takeover and explain why leases beat locks for long-running work
- [ ] I can elect a leader with a PostgreSQL advisory lock and explain what it does not guarantee
- [ ] I can compare a PostgreSQL queue with BullMQ using my own measured numbers
- [ ] I can propagate a trace across HTTP and Kafka, including through an outbox
- [ ] I can write a schema-compatibility policy and enforce it in CI
- [ ] I can describe a strangler-fig migration in steps that are each individually reversible
- [ ] I can name twelve things that got harder when I split the monolith, and the mitigation for each

## Part 61 — Key Takeaways

- Build the projects in order; each one assumes the concepts the previous one taught, and skipping ahead means distributing systems you do not yet understand.
- The definition of done, not the feature list, is the assignment: metrics, alerts, a runbook, a real deployment and a tested rollback are part of "finished".
- Authentication teaches every hard theme in miniature: hashing, expiry, replay, rotation, revocation, rate limiting and key management, all in a system small enough to hold in your head.
- Overselling, double charging and duplicate notifications are all the same bug — a race that application code cannot win — and the fix is always in the database: an atomic conditional update, a unique constraint, or a row lock.
- At-least-once delivery plus an inbox table is how you get effectively-once behaviour; there is no exactly-once transport, and anyone who says otherwise is selling something.
- The outbox pattern is the only correct way to publish an event about a database change: same transaction, then relay, then dedupe at the consumer.
- Money needs a double-entry ledger with a continuous zero-sum invariant check, and financial rows are append-only forever; reversals are entries, not updates.
- A PostgreSQL queue with `FOR UPDATE SKIP LOCKED`, leases and heartbeats is the right choice below a few thousand jobs per second and whenever enqueue must be transactional with a business write.
- Leader election reduces duplicate work; a unique execution key prevents duplicate effects. You need both, and only the second one is a guarantee.
- Every synchronous call you move across the network gains four failure modes: slow, failed, duplicated and partially applied. Count your synchronous edges and keep them few.
- A database per service is what makes microservices real; shared tables produce a distributed monolith with worse latency and the same coupling.
- Events are a public API: write the compatibility policy, enforce it in CI, and make consumers ignore unknown fields.
- Tracing propagated across HTTP, Kafka and the outbox is the single most valuable thing you build in a distributed system, because it is the only way debugging stays possible.
- Splitting a monolith makes local development, debugging, transactions, consistency, testing, latency, cost and onboarding all harder; do it when independent deployment and independent scaling are worth that bill, and be able to name the bill.
