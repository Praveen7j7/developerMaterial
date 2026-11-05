## 58.4 Project 4 — Payment and order system

### 58.4.1 Goal and what you will learn

This is the project where mistakes cost money, and that changes how you write code. You will build an orchestrated **saga** across three modules — order, payment, inventory — driven by payment intents with end-to-end idempotency keys, a mock payment provider behind a circuit breaker with timeouts and retries, HMAC-verified webhooks processed idempotently, a **double-entry ledger**, refunds including partial refunds, a reconciliation job that compares your books with the provider's, `FOR UPDATE` on the order row for every state transition, an outbox with a relay, and a delayed job that cancels unpaid orders after fifteen minutes.

What you will learn that the earlier projects could not teach:

- **Distributed transactions do not exist, so you compensate.** A saga is a sequence of local transactions, each with a compensating action. Getting the compensation right — and idempotent — is the whole discipline.
- **Idempotency end to end.** The client's key, your key, the provider's key. Three layers, and a retry at any of them must produce one charge. "We charged the customer twice" is the incident that ends trust in a team.
- **Money is not a float, and money is not a status column.** A double-entry ledger means every movement is two balanced entries, and "how much do we owe this customer?" is a query, not a guess.
- **The provider is asynchronous even when it looks synchronous.** You will get a `200 OK` and then a webhook that contradicts it, a webhook before the API response, a webhook twice, and a webhook for a payment you have never heard of.
- **Reconciliation is a first-class feature.** Anything you cannot reconcile daily will eventually be wrong in a way nobody notices for six months.
- **Partial failure everywhere.** Money captured, inventory not reserved. Order cancelled, refund not issued. Each combination needs a defined outcome, not an exception in a log.

### 58.4.2 Requirements

**Functional**

1. Create an order from a validated cart; the order starts `pending_payment` and holds an inventory reservation.
2. Create a payment intent for the order, idempotent on `(order_id, idempotency_key)`.
3. Confirm the intent against the provider with a timeout, retries and a circuit breaker; record every attempt.
4. Process provider webhooks (`payment.succeeded`, `payment.failed`, `refund.succeeded`, `dispute.opened`) idempotently, with HMAC verification.
5. On success: capture funds, commit the inventory reservation, transition the order to `paid`, post ledger entries, publish `order.paid`.
6. On failure: release the reservation, transition to `payment_failed`, allow one retry with a new intent.
7. Cancel unpaid orders 15 minutes after creation with a delayed job; release the reservation; the cancellation must lose a race against a late success safely.
8. Refund fully or partially; a refund can never exceed captured minus already refunded.
9. Maintain a double-entry ledger where every transaction balances to zero.
10. Run a daily reconciliation against the provider's settlement report and report mismatches.
11. Expose an admin view of an order's full timeline: saga steps, payment attempts, webhooks, ledger entries.

**Non-functional**

| Property | Target | Why |
|---|---|---|
| Checkout throughput | 50 orders/s sustained, 200/s peak | A flash sale is the realistic worst case |
| Confirm latency | p95 under 2.5 s including the provider | Users abandon after about 3 s of a spinner |
| Provider timeout | connect 2 s, total 8 s | Longer than the provider's own p99, shorter than the user's patience |
| Double charge rate | zero, provably | Idempotency at three layers plus a unique constraint |
| Lost payment rate | zero; every captured cent has a ledger entry | Reconciliation must find nothing |
| Webhook processing | p95 under 500 ms, accepted within 5 s always | Providers disable endpoints that are slow |
| Saga completion | 99.99 percent complete within 60 s | A stuck saga is a stuck customer |
| Reconciliation | daily, mismatches under 0.01 percent, all explained | Finance signs off on this number |
| Ledger consistency | every `transaction_id` sums to zero, checked continuously | The one invariant you never bend |
| Availability | 99.95 percent for confirm, 99.99 percent for webhook ingest | You cannot ask a provider to retry forever |

### 58.4.3 Architecture

```mermaid
flowchart TB
  client["Checkout client"] --> api["Order and Payment API - NestJS"]
  api --> pg[("PostgreSQL")]
  api --> redis[("Redis - idempotency, locks, breaker")]
  api --> psp["Payment provider - mock adapter"]
  psp --> hook["Webhook receiver"]
  hook --> pg
  pg --> outbox["outbox table"]
  outbox --> relay["Outbox relay"]
  relay --> bus["Kafka - order.events, payment.events"]
  bus --> saga["Saga orchestrator"]
  saga --> api
  bus --> workers["Workers - cancel timer, reconciliation, ledger check"]
  workers --> pg
  workers --> psp
```

The orchestrator is a service in the same process, not a framework. It reads a `sagas` row, decides the next step, executes it through the owning module's service, and records the outcome. Everything it does is idempotent and re-runnable, because the only reliable recovery from "the pod died mid-saga" is to run the saga again from its recorded state.

Choreography (each service reacting to events without a coordinator) is the popular alternative, and for a payment flow it is the wrong choice: nobody owns the timeout, nobody can answer "where is this order stuck?", and compensations become a guessing game spread across four repositories. Orchestration puts the flow in one file you can read.

```mermaid
sequenceDiagram
  participant C as Client
  participant O as OrderService
  participant S as Saga
  participant I as Inventory
  participant P as PaymentService
  participant G as Provider
  C->>O: POST /orders with IdempotencyKey
  O->>I: reserve stock
  I-->>O: reservation held 15m
  O->>S: start saga order_checkout
  C->>P: POST /payments/intents
  P->>G: create intent idem key
  G-->>P: intent id pi_123 requires_confirm
  C->>P: POST /payments/pi_123/confirm
  P->>G: confirm with 8s timeout
  G-->>P: 202 processing
  G->>P: webhook payment.succeeded
  P->>S: step payment_captured
  S->>I: commit reservation
  S->>O: transition paid
  S->>P: post ledger entries
```

### 58.4.4 Database schema

```sql
CREATE TYPE order_status AS ENUM
  ('pending_payment','paid','payment_failed','cancelled','fulfilled','refunded','partially_refunded');
CREATE TYPE payment_status AS ENUM
  ('requires_confirmation','processing','captured','failed','cancelled','refunded','partially_refunded');

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  status         order_status NOT NULL DEFAULT 'pending_payment',
  currency       char(3) NOT NULL,
  total_cents    bigint NOT NULL CHECK (total_cents > 0),
  captured_cents bigint NOT NULL DEFAULT 0 CHECK (captured_cents >= 0),
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  idempotency_key text NOT NULL,
  expires_at     timestamptz NOT NULL,       -- created_at + 15 minutes
  version        int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_idem_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT orders_refund_le_capture CHECK (refunded_cents <= captured_cents)
);
CREATE INDEX orders_unpaid_expiry_idx ON orders (expires_at)
  WHERE status = 'pending_payment';

CREATE TABLE order_items (
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id bigint NOT NULL,
  quantity   int NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  PRIMARY KEY (order_id, variant_id)
);

CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id),
  status         payment_status NOT NULL DEFAULT 'requires_confirmation',
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  currency       char(3) NOT NULL,
  provider       text NOT NULL DEFAULT 'mockpay',
  provider_intent_id text,
  idempotency_key text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_idem_unique UNIQUE (order_id, idempotency_key),
  CONSTRAINT payments_provider_intent_unique UNIQUE (provider, provider_intent_id)
);
-- At most one live payment per order: prevents two intents charging twice.
CREATE UNIQUE INDEX payments_one_live_idx ON payments (order_id)
  WHERE status IN ('requires_confirmation','processing','captured');

CREATE TABLE payment_attempts (
  id           bigserial PRIMARY KEY,
  payment_id   uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  attempt      smallint NOT NULL,
  request_hash bytea NOT NULL,
  http_status  int,
  provider_code text,
  error_class  text,               -- 'timeout' | 'transient' | 'declined' | 'invalid'
  latency_ms   int,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_unique UNIQUE (payment_id, attempt)
);

CREATE TABLE ledger_accounts (
  code       text PRIMARY KEY,          -- 'asset:psp_receivable', 'liability:customer'
  kind       text NOT NULL,             -- asset | liability | revenue | expense | equity
  currency   char(3) NOT NULL,
  normal_side char(2) NOT NULL CHECK (normal_side IN ('dr','cr'))
);

CREATE TABLE ledger_entries (
  id            bigserial,
  transaction_id uuid NOT NULL,         -- groups the two or more sides
  account_code  text NOT NULL REFERENCES ledger_accounts(code),
  direction     char(2) NOT NULL CHECK (direction IN ('dr','cr')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      char(3) NOT NULL,
  order_id      uuid,
  payment_id    uuid,
  memo          text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE ledger_entries_2026_09 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE INDEX ledger_2026_09_txn_idx ON ledger_entries_2026_09 (transaction_id);
CREATE INDEX ledger_2026_09_account_idx ON ledger_entries_2026_09 (account_code, occurred_at);
CREATE INDEX ledger_2026_09_order_idx ON ledger_entries_2026_09 (order_id);

CREATE TABLE webhook_events (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  provider_event_id text NOT NULL,
  type          text NOT NULL,
  signature_ok  boolean NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text,
  CONSTRAINT webhook_unique UNIQUE (provider, provider_event_id)
);
CREATE INDEX webhook_unprocessed_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE sagas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,             -- 'order_checkout' | 'order_refund'
  correlation_id uuid NOT NULL,           -- the order id
  state        text NOT NULL,             -- current step name
  status       text NOT NULL DEFAULT 'running',  -- running | completed | compensating | failed
  step_index   smallint NOT NULL DEFAULT 0,
  context      jsonb NOT NULL DEFAULT '{}',
  last_error   text,
  attempts     smallint NOT NULL DEFAULT 0,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sagas_one_per_correlation UNIQUE (type, correlation_id)
);
CREATE INDEX sagas_runnable_idx ON sagas (next_run_at)
  WHERE status IN ('running','compensating');

CREATE TABLE saga_steps (
  saga_id     uuid NOT NULL REFERENCES sagas(id) ON DELETE CASCADE,
  step        text NOT NULL,
  status      text NOT NULL,               -- pending | done | compensated | failed
  result      jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (saga_id, step)
);

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  aggregate    text NOT NULL,
  aggregate_id text NOT NULL,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
```

```mermaid
erDiagram
  ORDERS ||--o{ ORDER_ITEMS : contains
  ORDERS ||--o{ PAYMENTS : charged_by
  PAYMENTS ||--o{ PAYMENT_ATTEMPTS : tried
  ORDERS ||--o| SAGAS : coordinated_by
  SAGAS ||--o{ SAGA_STEPS : records
  LEDGER_ACCOUNTS ||--o{ LEDGER_ENTRIES : posts
  ORDERS ||--o{ LEDGER_ENTRIES : affects
  WEBHOOK_EVENTS ||--o{ PAYMENTS : updates
  PAYMENTS {
    uuid id PK
    uuid order_id FK
    payment_status status
    text provider_intent_id
    text idempotency_key
  }
  LEDGER_ENTRIES {
    bigint id PK
    uuid transaction_id
    text account_code FK
    char direction
    bigint amount_cents
  }
```

### 58.4.5 APIs

| Method | Path | Auth | Request | Response | Codes | Idempotency |
|---|---|---|---|---|---|---|
| POST | `/orders` | user | `{cartId,addressId}` + `Idempotency-Key` | `201 {orderId,status,expiresAt}` | 201, 409 stock, 422 | Yes; `(user_id, idempotency_key)` unique returns the original order |
| GET | `/orders/:id` | user | — | `200` order with timeline | 200, 403, 404 | Yes |
| POST | `/orders/:id/cancel` | user | `{reason}` | `200` | 200, 409 already paid | Yes |
| POST | `/payments/intents` | user | `{orderId,method}` + `Idempotency-Key` | `201 {paymentId,clientSecret,status}` | 201, 409 order not payable, 422 | Yes; returns the existing intent for the same key |
| POST | `/payments/:id/confirm` | user | `{paymentMethodToken}` + `Idempotency-Key` | `200 {status}` | 200, 202 processing, 402 declined, 409, 504 | Yes; same key returns the same outcome |
| GET | `/payments/:id` | user | — | `200 {status,attempts}` | 200, 403, 404 | Yes |
| POST | `/payments/:id/refunds` | admin or user | `{amountCents,reason}` + `Idempotency-Key` | `201 {refundId,status}` | 201, 409 exceeds refundable, 422 | Yes |
| POST | `/webhooks/mockpay` | HMAC | provider event | `200 {received:true}` | 200, 401 bad signature, 400 | Yes; `(provider, provider_event_id)` unique |
| GET | `/admin/orders/:id/timeline` | admin | — | `200` saga steps, attempts, webhooks, ledger | 200, 403 | Yes |
| GET | `/admin/ledger/balance` | admin | `?account&from&to` | `200 {debits,credits,balance}` | 200 | Yes |
| POST | `/admin/reconciliation/run` | admin | `{date}` | `202 {jobId}` | 202 | Yes per date |
| GET | `/admin/reconciliation/:date` | admin | — | `200 {matched,mismatched,items[]}` | 200, 404 | Yes |

The confirm endpoint's `504` deserves attention. When the provider times out, you genuinely do not know whether the charge happened. Returning `504` with `{"status":"unknown","retryAfter":2}` and a payment row in `processing` is honest; the reconciler or the webhook will settle it within seconds. Returning `500` and leaving the row in `requires_confirmation` is how you charge a customer twice.

### 58.4.6 NestJS modules

```text
src/
  orders/    orders.module.ts  orders.service.ts  order.repository.ts
  payments/  payments.module.ts payments.service.ts  intent.service.ts
             providers/ mockpay.adapter.ts  provider.interface.ts
             refunds.service.ts
  saga/      saga.module.ts  saga.orchestrator.ts  definitions/checkout.saga.ts
             saga.repository.ts  saga.runner.ts   (@Interval poller)
  ledger/    ledger.module.ts  ledger.service.ts  ledger.invariant.check.ts
  webhooks/  webhooks.module.ts webhook.controller.ts  webhook.processor.ts
             hmac.guard.ts
  inventory/ inventory.client.ts        (module boundary; HTTP in Project 6)
  recon/     recon.module.ts  reconciliation.job.ts  settlement.parser.ts
  outbox/    outbox.module.ts  outbox.relay.ts
  common/    idempotency/ idempotency.interceptor.ts  circuit-breaker.ts  money.ts
```

**`idempotency.interceptor.ts` — one place, every write endpoint.**

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, ConflictException } from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

/**
 * Stores (key, route, request_hash) -> response. A repeat with the same body
 * returns the stored response; a repeat with a different body is a 409.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly ds: DataSource) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['idempotency-key'];
    if (!key) return next.handle();

    const route = `${req.method} ${req.route?.path}`;
    const hash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest();

    return from(this.begin(key, route, hash)).pipe(
      switchMap((existing) => {
        if (existing?.response) return from([existing.response]);   // replay
        return next.handle().pipe(
          switchMap(async (body) => {
            await this.ds.query(
              `UPDATE idempotency_keys SET response = $3, completed_at = now()
                 WHERE key = $1 AND route = $2`, [key, route, body]);
            return body;
          }),
        );
      }),
    );
  }

  private async begin(key: string, route: string, hash: Buffer) {
    const rows = await this.ds.query(
      `INSERT INTO idempotency_keys (key, route, request_hash)
       VALUES ($1,$2,$3)
       ON CONFLICT (key, route) DO UPDATE SET key = EXCLUDED.key
       RETURNING request_hash, response, completed_at`,
      [key, route, hash]);
    const row = rows[0];
    if (!row.request_hash.equals(hash)) {
      throw new ConflictException({ code: 'idempotency_key_reuse' });
    }
    if (!row.completed_at && row.response === null) {
      // First writer wins; a concurrent duplicate gets 409 and should retry later.
      return null;
    }
    return row;
  }
}
```

**`mockpay.adapter.ts` — timeouts, retries, breaker, provider idempotency.**

```ts
import { Injectable } from '@nestjs/common';
import { CircuitBreaker } from '../../common/circuit-breaker';

export class ProviderTimeout extends Error {}
export class ProviderDeclined extends Error { constructor(readonly code: string) { super(code); } }
export class ProviderTransient extends Error {}

@Injectable()
export class MockPayAdapter {
  private readonly breaker = new CircuitBreaker({ failureThreshold: 5, halfOpenAfterMs: 30_000 });

  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  async confirm(intentId: string, token: string, idempotencyKey: string) {
    if (this.breaker.isOpen()) throw new ProviderTransient('breaker_open');

    // Two attempts only: the provider is idempotent on the key, so a retry is safe,
    // but every retry costs the user latency and doubles the timeout window.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8_000);
      try {
        const res = await fetch(`${this.baseUrl}/v1/intents/${intentId}/confirm`, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,     // the provider dedupes on this
            authorization: `Bearer ${this.secret}`,
          },
          body: JSON.stringify({ paymentMethodToken: token }),
        });
        if (res.status === 402) { this.breaker.recordSuccess(); throw new ProviderDeclined((await res.json()).code); }
        if (res.status >= 500 || res.status === 429) throw new ProviderTransient(`http_${res.status}`);
        this.breaker.recordSuccess();
        return await res.json();
      } catch (err) {
        if (err instanceof ProviderDeclined) throw err;
        this.breaker.recordFailure();
        if (attempt === 2) throw err instanceof Error && err.name === 'AbortError'
          ? new ProviderTimeout('confirm_timeout') : err;
        await sleep(250 * attempt + Math.random() * 100);   // jittered backoff
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ProviderTransient('unreachable');
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

**`ledger.service.ts` — double entry that cannot go out of balance.**

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface LedgerLine {
  account: string; direction: 'dr' | 'cr'; amountCents: bigint | number; memo: string;
}

@Injectable()
export class LedgerService {
  /** Posts one balanced transaction. Must be called inside the caller's transaction. */
  async post(em: EntityManager, txnId: string, currency: string, lines: LedgerLine[],
             refs: { orderId?: string; paymentId?: string }) {
    if (lines.length < 2) throw new BadRequestException('ledger_needs_two_sides');
    const dr = lines.filter(l => l.direction === 'dr').reduce((s, l) => s + BigInt(l.amountCents), 0n);
    const cr = lines.filter(l => l.direction === 'cr').reduce((s, l) => s + BigInt(l.amountCents), 0n);
    if (dr !== cr) throw new BadRequestException(`ledger_unbalanced dr=${dr} cr=${cr}`);

    const values = lines.map((_, i) =>
      `($1, $${i * 4 + 4}, $${i * 4 + 5}, $${i * 4 + 6}, $2, $3, $${i * 4 + 7})`).join(',');
    await em.query(
      `INSERT INTO ledger_entries
         (transaction_id, account_code, direction, amount_cents, currency, order_id, memo)
       VALUES ${values.replace(/\$2, \$3/g, '$2, $3')}`,
      [txnId, currency, refs.orderId ?? null,
       ...lines.flatMap(l => [l.account, l.direction, String(l.amountCents), l.memo])],
    );
  }
}
```

The four transactions you will post, and the accounts they touch:

| Business event | Debit | Credit | Meaning |
|---|---|---|---|
| Payment captured, 5,000 cents | `asset:psp_receivable` 5000 | `liability:customer_prepayment` 5000 | The provider owes us; we owe the customer goods |
| Order fulfilled | `liability:customer_prepayment` 5000 | `revenue:sales` 4200 and `liability:vat` 800 | We earned it |
| Provider payout received | `asset:bank` 4850 and `expense:psp_fees` 150 | `asset:psp_receivable` 5000 | Cash in, fee recognised |
| Partial refund, 1,200 cents | `revenue:sales` 1008 and `liability:vat` 192 | `asset:psp_receivable` 1200 | Reversal, split the same way |

Run an invariant check every five minutes: `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(CASE WHEN direction='dr' THEN amount_cents ELSE -amount_cents END) <> 0`. It should always return zero rows. Alert as a page if it does not, because the only causes are a bug or a partial write, and both are urgent.

**`checkout.saga.ts` — the flow as data.**

```ts
export const CheckoutSaga = {
  type: 'order_checkout',
  steps: [
    { name: 'reserve_inventory',  run: 'inventory.reserve',   compensate: 'inventory.release' },
    { name: 'create_intent',      run: 'payments.createIntent', compensate: 'payments.cancelIntent' },
    { name: 'await_capture',      run: 'payments.awaitCapture', compensate: 'payments.refundFull', timeoutMs: 900_000 },
    { name: 'commit_inventory',   run: 'inventory.commit',    compensate: 'inventory.restock' },
    { name: 'mark_paid',          run: 'orders.markPaid',     compensate: 'orders.markRefunded' },
    { name: 'post_ledger',        run: 'ledger.postCapture',  compensate: 'ledger.postReversal' },
    { name: 'publish_events',     run: 'outbox.publishPaid',  compensate: 'noop' },
  ],
} as const;
```

The runner polls `sagas` with `SELECT ... WHERE next_run_at <= now() AND status IN ('running','compensating') ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED`, executes the next step, records it in `saga_steps`, and sets `next_run_at` with exponential backoff on failure. After a configured number of attempts it flips to `compensating` and walks the completed steps backwards. Every step handler must be idempotent, because the runner will re-run a step whose result was never recorded.

### 58.4.7 PostgreSQL design decisions

**Transactions and the order row lock.** Every order state transition happens inside a transaction that begins with `SELECT status, version FROM orders WHERE id = $1 FOR UPDATE`. That lock is what makes the 15-minute cancel job and a late webhook safe: whichever gets the lock first decides, and the second sees the new status and does the right thing. Without it you get the worst bug in this project — the order is cancelled and the stock released at the same moment the payment is captured, leaving a paid order with no inventory.

```sql
BEGIN;
SELECT status FROM orders WHERE id = $1 FOR UPDATE;         -- serialise transitions
-- application asserts the transition is legal for the status it just read
UPDATE orders SET status = 'paid', captured_cents = $2, version = version + 1
 WHERE id = $1 AND status = 'pending_payment';              -- belt and braces
INSERT INTO outbox (aggregate, aggregate_id, type, payload) VALUES (...);
COMMIT;
```

The `AND status = 'pending_payment'` in the `UPDATE` is not redundant. It means that even if someone later removes the `FOR UPDATE`, the write still cannot apply to the wrong state; the row count of 0 tells the caller the transition lost the race.

**Isolation level.** `READ COMMITTED` everywhere, with explicit locks. `SERIALIZABLE` would also be correct and would let you drop some locks, but it introduces serialization failures that every caller must retry, and payment code that retries automatically is code you must reason about very carefully. Choose explicit locks here; choose `SERIALIZABLE` for reporting jobs where a retry is free.

**Unique constraints doing real work.** `payments_one_live_idx` is a partial unique index that makes "two live payments for one order" impossible at the storage layer. `orders_idem_unique` and `payments_idem_unique` make retried API calls return the original object. `webhook_unique` makes duplicate webhooks a cheap insert conflict rather than a business decision. Every one of these replaces a piece of application logic that would otherwise race.

**Indexes.** `orders_unpaid_expiry_idx` (partial on `pending_payment`) drives the cancel job — the whole table has millions of rows, the index has only the few thousand currently unpaid. `sagas_runnable_idx` (partial) drives the runner poll. `ledger_*_txn_idx` supports the balance invariant check. `ledger_*_account_idx` supports the balance report by account and period. `webhook_unprocessed_idx` (partial) finds webhooks that were accepted but never processed, which is the recovery path when the processor crashed.

**Partitioning.** `ledger_entries` is append-only and grows forever; monthly partitions keep the invariant check and the account queries on small indexes, and let finance archive closed months. Never delete ledger rows; that is what "append-only" means. If you need to reverse something, post a reversing entry — the audit trail is the product.

**Migrations.** Money columns are `bigint` cents from day one; converting `numeric` to `bigint` on a live payments table is a rewrite and a rounding argument you do not want. Enum changes use `ALTER TYPE ... ADD VALUE` in a standalone migration. Any migration touching `orders` or `payments` runs with `lock_timeout = '2s'` and is rehearsed on a restored production snapshot, because these tables are locked by the busiest code path in the system.

### 58.4.8 Redis usage

| Key | Structure | TTL | Purpose | Notes |
|---|---|---|---|---|
| `idem:{route}:{key}` | String `in_progress` via `SET NX EX 60` | 60 s | Fast rejection of two concurrent identical requests before they reach PostgreSQL | The database table is still the source of truth |
| `lock:order:{orderId}` | `SET NX PX 15000` | 15 s | Advisory lock for multi-statement flows spanning several transactions | `FOR UPDATE` remains the real guarantee |
| `breaker:mockpay` | Hash `{state,failures,openedAt}` | 300 s | Shared circuit breaker state across pods | Local-only breakers learn outages 20 times |
| `psp:rate` | Token bucket | 60 s | Respect the provider's 100 req/s limit | Prevents self-inflicted 429s |
| `recon:{date}:progress` | Hash | 48 h | Reconciliation job progress for the admin UI | Rebuildable |
| `webhook:seen:{provider}:{eventId}` | `SET NX EX 172800` | 48 h | Sub-millisecond duplicate rejection under a webhook storm | Unique index is the durable guard |
| `order:timeline:{id}` | String JSON | 30 s | Admin timeline cache | Deleted on any order write |

Nothing about money lives only in Redis. If Redis is wiped, the system is slower and slightly noisier, and every financial fact is still correct. That sentence is the test for whether you have used a cache correctly.

### 58.4.9 Messaging usage

**Topics:** `order.events` (`order.created`, `order.paid`, `order.cancelled`, `order.refunded`), `payment.events` (`payment.captured`, `payment.failed`, `payment.refunded`), both partitioned by `order_id` so all events for one order are ordered, 12 partitions, 30-day retention because finance sometimes wants to replay.

**Outbox and relay.** Every state change writes its event to `outbox` in the same transaction as the state change. The relay polls `WHERE published_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`, publishes with the event id as the Kafka message key header, and marks published. Two relay replicas can run safely because of `SKIP LOCKED`. The relay is at-least-once by design; the duplicate protection is the consumer's inbox.

**Consumers.** The saga orchestrator consumes `payment.events` to advance sagas that are waiting on capture. The notification service (Project 3) consumes `order.events`. Analytics consumes both. Each has its own consumer group and its own inbox table.

**Delayed cancellation.** The 15-minute cancel is a BullMQ delayed job scheduled at order creation with `jobId = order:{id}:cancel`, which makes scheduling idempotent — creating the same job twice is a no-op. When it fires, it takes `FOR UPDATE` on the order, checks the status is still `pending_payment` and `expires_at <= now()`, and only then cancels. A safety-net sweeper also runs every minute over `orders_unpaid_expiry_idx` to catch orders whose delayed job was lost when Redis was flushed. Two mechanisms, one outcome, both idempotent: this is the correct amount of paranoia for a step that releases inventory.

**Retries and DLQ.** Consumer failures retry three times with 5 s, 30 s, 5 min backoff and then land in `<topic>.dlq` with the original headers. Because these are financial events, DLQ depth above zero is a page, not a ticket, and the replay tool from Project 3 is reused.

### 58.4.10 Testing strategy

Unit: the order state machine, refundable-amount arithmetic (`captured - refunded`), ledger balancing, provider error classification, saga step ordering and compensation ordering. Integration with Testcontainers plus a controllable mock provider service (a real HTTP server you can make time out, decline, or double-webhook). E2E: the full checkout journey with the provider in each of its moods.

The ten cases:

1. **Double-submitted checkout** — two identical `POST /orders` with the same `Idempotency-Key` in parallel; one order, one reservation, one 201 and one replayed 201 (or a 409 that resolves on retry).
2. **Confirm times out but the charge succeeded** — the provider takes 12 s then reports success by webhook; the API returned 504, the payment ends `captured` exactly once, and the ledger has exactly one capture transaction.
3. **Duplicate webhook** — the same `payment.succeeded` delivered five times; one status change, one ledger transaction, four insert conflicts.
4. **Webhook arrives before the confirm response** — process the webhook first; the confirm response must not overwrite `captured` with `processing`.
5. **Cancel races a late capture** — schedule the cancel and deliver the success webhook in the same 50 ms window, 200 times; every run ends either `paid` with committed stock or `cancelled` with released stock, never a mixture.
6. **Partial refunds sum correctly** — refund 1,200 then 2,000 of a 5,000 charge, then attempt 2,000 more; the third returns 409 and `refunded_cents` is 3,200.
7. **Ledger always balances** — property test: generate 1,000 random sequences of capture, refund, payout; after each, every `transaction_id` sums to zero and account balances match a recomputation.
8. **Saga compensation** — force `commit_inventory` to fail permanently; the saga compensates back through refund and release, and the order ends `refunded` with stock restored.
9. **Provider outage opens the breaker** — 20 consecutive 503s; the breaker opens, confirms fail fast with 503 rather than hanging, and it half-opens after 30 s.
10. **Reconciliation finds a planted mismatch** — inject a settlement row for a payment you never recorded and a payment you recorded but the provider did not; the job reports both, and neither is auto-corrected.

The chaos test worth writing: run 500 checkouts while randomly killing the API pod, the saga runner and the mock provider. At the end, assert three invariants — every ledger transaction balances, no order is `paid` without a captured payment, and no captured payment lacks a `paid` or `refunded` order. If those three hold after chaos, the design works.

### 58.4.11 Docker

```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: payments }
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U postgres -d payments"], interval: 5s, retries: 10 }
  redis: { image: redis:7-alpine, ports: ["6379:6379"] }
  redpanda:
    image: redpandadata/redpanda:latest
    command: ["redpanda","start","--smp","1","--memory","1G","--overprovisioned",
              "--kafka-addr","PLAINTEXT://0.0.0.0:9092","--advertise-kafka-addr","PLAINTEXT://redpanda:9092"]
    ports: ["9092:9092"]
  mockpay:
    build: ./tools/mockpay
    environment:
      WEBHOOK_URL: http://api:3000/webhooks/mockpay
      WEBHOOK_SECRET: whsec_dev_only
      MODE: normal            # normal | slow | flaky | decline | double_webhook | silent
    ports: ["4020:4020"]
  api:
    build: { context: ., target: runtime }
    environment: &env
      DATABASE_URL: postgres://postgres:dev@postgres:5432/payments
      REDIS_URL: redis://redis:6379
      KAFKA_BROKERS: redpanda:9092
      PSP_BASE_URL: http://mockpay:4020
      PSP_WEBHOOK_SECRET: whsec_dev_only
    depends_on: { postgres: { condition: service_healthy } }
    ports: ["3000:3000"]
  saga-runner:
    build: { context: ., target: runtime }
    command: ["node","dist/saga-runner.js"]
    environment: *env
  workers:
    build: { context: ., target: runtime }
    command: ["node","dist/worker.js"]     # cancel timer, outbox relay, reconciliation
    environment: *env
```

Build `mockpay` yourself and make it hostile. It should support: succeeding after a delay, timing out with no response, returning 500 then succeeding on the idempotent retry, sending the webhook twice, sending the webhook before the HTTP response, sending a webhook for an unknown intent, and sending a webhook with a bad signature. Every failure mode in section 58.4.14 should be reproducible by flipping `MODE`. This container is where your confidence comes from.

### 58.4.12 CI/CD

```yaml
jobs:
  verify:
    services:
      postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: dev, POSTGRES_DB: pay_test }, ports: ["5432:5432"], options: --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10 }
      redis:    { image: redis:7, ports: ["6379:6379"] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run lint && npx tsc --noEmit
      - run: npm run migration:run
      - run: npm run test:unit
      - run: npm run test:money           # property tests on ledger and refund arithmetic
      - run: npm run test:integration     # Testcontainers + mockpay
      - run: npm run test:race -- --repeat 200   # cancel-vs-capture race, 200 iterations
      - run: npm run test:e2e
  build:
    needs: verify
    steps:
      - uses: docker/build-push-action@v6
        with: { push: true, tags: "ghcr.io/${{ github.repository }}/payments:${{ github.sha }}" }
      - uses: aquasecurity/trivy-action@master
        with: { image-ref: "ghcr.io/${{ github.repository }}/payments:${{ github.sha }}", severity: "CRITICAL,HIGH", exit-code: "1" }
      - run: npx @cyclonedx/cyclonedx-npm --output-file sbom.json
      - uses: actions/upload-artifact@v4
        with: { name: sbom, path: sbom.json }
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    environment: production            # requires manual approval
    steps:
      - run: kubectl apply -f k8s/ && kubectl wait --for=condition=complete job/pay-migrate --timeout=300s
      - run: kubectl rollout status deploy/pay-api deploy/pay-saga deploy/pay-workers --timeout=600s
      - run: ./scripts/smoke-payments.sh   # 1-cent order end to end against a sandbox, then refund it
      - run: ./scripts/ledger-invariant.sh # fails the deploy if any transaction is unbalanced
```

Two things separate this pipeline from the earlier ones: the `production` environment gate, so a human approves anything that touches money, and the post-deploy ledger invariant check, which turns "the deploy broke accounting" from a month-end discovery into a five-minute rollback.

### 58.4.13 Observability

**Metrics:** `payment_intents_total{result}`; `payment_confirm_duration_seconds` (with the provider span as a separate histogram so you can see whose latency it is); `payment_result_total{result="captured|declined|timeout|transient"}`; `psp_breaker_state`; `webhook_received_total{type,signature_ok}` and `webhook_duplicate_total`; `saga_active` gauge by `state`, `saga_duration_seconds`, `saga_compensations_total{step}` — the last one is the metric that tells you your design is wrong when it climbs; `orders_auto_cancelled_total`; `ledger_unbalanced_transactions` gauge (must be 0); `refunds_total{kind="full|partial"}`; `reconciliation_mismatches_total{kind}`; `outbox_lag_seconds`.

**Log fields:** `traceId, orderId, paymentId, sagaId, step, providerIntentId, idempotencyKey (hashed), amountCents, currency, errorClass, attempt, latencyMs`. Never log card data, tokens or the raw webhook body of a payment method. Log the `idempotencyKey` as a hash so support can correlate without it being reusable from a log aggregator.

**Traces:** the confirm trace shows `idempotency.begin`, `pg.select for update`, `psp.confirm` (the long one), `pg.update payment`, `outbox.insert`. The saga trace links to it by `correlation_id`. When a customer says "it took forever", you can say precisely how much of it was the provider.

**Dashboards:** a money row (captures, refunds, net, by currency, versus yesterday); a health row (confirm p50/p95/p99, decline rate, timeout rate, breaker state); a saga row (active by state, oldest running, compensations); a reconciliation row (matched, mismatched, unexplained, by day).

**Alerts:** `ledger_unbalanced_transactions > 0` (page immediately); any saga in `running` older than 30 minutes (page); decline rate above 30 percent for 10 minutes, which usually means the provider changed something (page); webhook signature failures above 1 per minute (security page); `reconciliation_mismatches_total > 0` unexplained after the daily run (ticket, escalating to page after 24 hours); `orders_auto_cancelled_total` spiking, which means checkout is broken upstream.

### 58.4.14 Failure scenarios

| Failure | Expected behaviour | How you test it |
|---|---|---|
| Provider times out on confirm | 504 to the client with `status: unknown`; payment stays `processing`; webhook or reconciler settles it; no second charge | `MODE=silent` on mockpay; assert exactly one capture |
| Provider returns 500 then succeeds on retry | The idempotent retry returns the same intent; one charge, one ledger transaction | `MODE=flaky` |
| Webhook arrives twice | Second insert conflicts; no second ledger entry; `webhook_duplicate_total` increments | `MODE=double_webhook` |
| Webhook arrives before the API response | Payment is already `captured`; the confirm handler sees the terminal state and returns it | Force ordering in an integration test |
| Cancel job fires while capture is in flight | The `FOR UPDATE` lock serialises them; outcome is consistently paid-or-cancelled | Race test, 200 iterations |
| Saga runner pod dies mid-step | Another replica picks the saga up after `next_run_at`; the step is re-run idempotently | `SIGKILL` the runner in a chaos test |
| Outbox relay down for an hour | Orders still process; events are delayed; `outbox_lag_seconds` alerts; nothing is lost | Stop the relay, restart, assert all events published |
| Refund exceeds captured amount | 409 with `code: refund_exceeds_captured`; nothing posted to the ledger | Unit and integration tests |
| Provider webhook signature invalid | 401, event stored with `signature_ok = false`, security alert fires, no state change | Send a tampered payload |
| Reconciliation finds a charge you never saw | Reported as `missing_local`; a human decides; the system never auto-creates a payment | Inject the row in the settlement fixture |
| Database failover mid-transaction | The transaction aborts; the client retries with the same idempotency key and gets the original outcome | Kill the primary during the race test |
| Clock skew of 5 minutes on a pod | Webhook timestamp window rejects valid events; alert on signature failures reveals it | Shift the container clock in staging |

### 58.4.15 Scaling strategy

**1x — 500 orders/day.** One API pod, one saga runner, one worker, one PostgreSQL. The provider is the slowest thing in the system by two orders of magnitude, so nothing you do to your own code matters yet. Spend the effort on correctness: this is the scale at which you should build the ledger and the reconciler, because doing it later means backfilling history.

**10x — 5,000 orders/day, 50/s peak.** Three API pods, two saga runners (safe because of `SKIP LOCKED`), two relay replicas. The provider's rate limit becomes visible; the token bucket earns its keep. `payment_attempts` and `ledger_entries` grow to a few million rows a month, which is nothing, but start the monthly partitions now while the tables are small enough to convert in a maintenance window.

**100x — 50,000 orders/day, 500/s peak, several currencies and providers.** The write path is still tiny by database standards (500 writes/s), so PostgreSQL is fine; the pressure moves to three places. First, provider concurrency: you will need multiple merchant accounts or providers, which turns the adapter list into a routing decision (by currency, by card scheme, by cost, by health). Second, the saga runner poll: at thousands of active sagas, polling every second with `LIMIT 50` is not enough — increase the batch, shard the poll by `hashtext(correlation_id) % N` per replica, or move to an event-driven wake-up where the outbox relay signals the runner. Third, reconciliation: parsing a daily settlement file of 50,000 rows in memory stops being reasonable; stream it, `COPY` it into a staging table, and do the comparison in SQL with a full outer join, which is both faster and easier to explain to finance.

What does *not* change with scale: the ledger stays authoritative, the invariant check stays continuous, and nobody is ever allowed to `UPDATE` a ledger row.

### 58.4.16 Security checklist

- [ ] No card data ever touches your servers: the client tokenises with the provider's SDK and you receive only a token. This is what keeps you in PCI SAQ-A instead of a full audit.
- [ ] Webhook HMAC verified with `timingSafeEqual`, a 5-minute timestamp window, and the raw body (verify before any JSON parsing that could normalise bytes).
- [ ] Provider credentials in a secret manager, rotated, with separate sandbox and live keys and a startup check that the key environment matches the deploy environment.
- [ ] Idempotency keys are client-generated UUIDs, scoped per route, and reuse with a different body returns 409.
- [ ] Amounts are `bigint` minor units, computed server-side from the order, never taken from the request body.
- [ ] Every refund requires an authorisation check: the owner for self-service refunds within policy, an admin role plus a second approval above a threshold.
- [ ] Refund amount validated against `captured_cents - refunded_cents` inside the same transaction that writes the refund.
- [ ] The application database role has `INSERT` but no `UPDATE` or `DELETE` on `ledger_entries` and `webhook_events`.
- [ ] Rate limits on `/payments/*` per user and per IP; card-testing attacks look like many small distinct payments and must be alarmed on.
- [ ] Full order and payment audit trail retained for the legally required period; deletion requests remove PII but keep financial records.
- [ ] Admin endpoints require a separate role, are rate-limited, and log actor, target and reason for every action.
- [ ] Reconciliation reports and settlement files are treated as sensitive data at rest.

### 58.4.17 Stretch goals

Multiple payment providers with routing rules and automatic failover, which turns the adapter into a real strategy pattern with cost and success-rate inputs. 3-D Secure with its extra asynchronous redirect state. Multi-currency with FX rates pinned at capture. Payouts to sellers in a marketplace model, which adds a second ledger dimension. Dispute and chargeback handling, including the evidence deadline as a scheduled job. Subscriptions with retry schedules and dunning emails, which is the same saga with a different clock. Invoice PDF generation. Idempotency key expiry and cleanup. Finally, write the finance-facing month-end report from the ledger only, and have someone who is not you check it against the provider dashboard — that exercise finds bugs no test suite will.

### 58.4.18 Definition of done

- [ ] All 11 functional requirements implemented, with the saga defined as data and executed by a restartable runner.
- [ ] End-to-end idempotency: client key, service key, provider key; proven by the double-submit and timeout tests.
- [ ] `FOR UPDATE` on the order row for every transition, with the conditional `UPDATE` as a second guard.
- [ ] Cancel-versus-capture race test green over 200 iterations with no mixed outcomes.
- [ ] Double-entry ledger with a continuous invariant check that has never reported a non-zero imbalance.
- [ ] Partial refunds correct, capped, and reflected in both `orders` and the ledger.
- [ ] Webhook handler verifies HMAC on the raw body, is idempotent, and tolerates out-of-order arrival.
- [ ] Reconciliation job runs daily, reports mismatches in three categories, and auto-corrects nothing.
- [ ] Mock provider supports all six hostile modes and every failure-table row is reproducible locally.
- [ ] Chaos test passes the three invariants after 500 checkouts with random pod kills.
- [ ] Dashboards for money, health, sagas and reconciliation; the unbalanced-ledger alert drilled in staging.
- [ ] Deployed with a manual approval gate, a migration Job, a post-deploy ledger check, and a tested rollback.
- [ ] Runbook: what to do on a stuck saga, a provider outage, a signature-failure spike, and an unexplained mismatch.
