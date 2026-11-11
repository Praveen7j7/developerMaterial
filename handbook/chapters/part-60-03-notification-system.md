## 60.3 Project 3 — Notification system

### 60.3.1 Goal and what you will learn

You will build the service every product eventually needs and almost nobody builds well: one place that turns "something happened" into "the right person was told, once, in the channel they chose, in their language, at a reasonable hour".

Four channels sit behind one interface: **email**, **push**, **SMS**, and **in-app** over WebSocket. Templates are versioned and localised. Users have preferences and quiet hours. Delivery is asynchronous through Kafka with one topic per channel, idempotent consumers backed by an inbox table, retries with backoff, provider fallback, delivery-status webhooks, digests, a dead-letter queue with a replay tool, per-provider rate limits, and unsubscribe handling.

What this project teaches that the previous two did not:

- **Fan-out and the difference between an event and a notification.** `order.shipped` is one event; it may become three notifications for one user and none for another.
- **Idempotency across a network boundary you do not control.** Kafka gives you at-least-once. Email providers give you at-least-once. Users must experience exactly-once. The inbox table is where those meet.
- **Third-party reality.** Providers rate-limit, time out, return 202 and then bounce the message an hour later, and go down during your biggest campaign. Fallback, circuit breakers and status webhooks are not optional decoration.
- **Time zones done properly.** Quiet hours are the single best exercise in timezone handling: you must schedule "not before 08:00 local" for a user in Kolkata from a server in Frankfurt, across a DST boundary, for a job written yesterday.
- **Poison messages.** One malformed payload must not stop a partition. You will build the DLQ and, more importantly, the tool that replays it.
- **Backpressure.** When 2 million push notifications are enqueued in 30 seconds, the correct behaviour is to slow down, not to fall over.

### 60.3.2 Requirements

**Functional**

1. Accept a notification request by API or by consuming a domain event; both paths converge on the same pipeline.
2. Resolve recipients, preferences, locale and channels; a request may fan out to several channels.
3. Render a versioned template per channel and locale, with a strict variable contract.
4. Respect per-user, per-category preferences: opted in, opted out, or digest.
5. Respect quiet hours in the user's own timezone; defer rather than drop, except for `critical` category which always sends.
6. Deliver through a primary provider with automatic fallback to a secondary on failure.
7. Record every delivery attempt with provider, status, latency, and provider message id.
8. Ingest provider webhooks (delivered, bounced, complained, clicked) and update delivery status idempotently.
9. Build daily and weekly digests for users who chose them.
10. Handle unsubscribe links and one-click list-unsubscribe headers; a bounce or complaint suppresses the address permanently.
11. Deliver in-app notifications over WebSocket in real time and store them for later retrieval.
12. Provide a DLQ browser and a replay command for operators.

**Non-functional**

| Property | Target | Design consequence |
|---|---|---|
| Volume | 10 million notifications/day, 2,000/s peak, 20,000/s burst for campaigns | Kafka, not a database queue; per-channel topics so campaigns cannot starve OTPs |
| Transactional latency | p95 under 15 s from event to provider accept | Separate topic and consumer group for `critical` |
| Campaign latency | best effort within 2 hours | Lower priority, rate-limited to the provider quota |
| Duplicate rate | under 1 in 100,000 delivered messages | Inbox table plus provider idempotency keys |
| Availability | 99.9 percent for ingest; delivery degrades, never drops | Accepting a request must survive a provider outage |
| Provider limits | email 200 msg/s, SMS 50 msg/s, push 5,000 msg/s | Token buckets per provider in Redis |
| Template render | p99 under 5 ms | Compiled templates cached in memory |
| Retention | notifications 90 days, deliveries 90 days, in-app 1 year | Monthly partitions on the two big tables |
| DLQ | zero messages older than 24 hours unresolved | An alert, and a replay tool someone actually uses |

### 60.3.3 Architecture

```mermaid
flowchart TB
  producers["Other services and public API"] --> ingest["Ingest API - NestJS"]
  ingest --> pg[("PostgreSQL - notifications")]
  ingest --> kin["Kafka topic notify.requests"]
  kin --> planner["Planner consumer"]
  planner --> redis[("Redis - buckets, quiet hours, dedupe")]
  planner --> temail["topic notify.email"]
  planner --> tpush["topic notify.push"]
  planner --> tsms["topic notify.sms"]
  planner --> tapp["topic notify.inapp"]
  temail --> wemail["Email workers"]
  tpush --> wpush["Push workers"]
  tsms --> wsms["SMS workers"]
  tapp --> wapp["WebSocket gateway"]
  wemail --> providers["Providers - primary and fallback"]
  wsms --> providers
  wpush --> providers
  providers --> hooks["Webhook receiver"]
  hooks --> pg
  wemail --> dlq["topic notify.email.dlq"]
```

Two stages, and the split is the whole design. The **planner** does everything that requires thinking: expand the audience, load preferences, decide channels, check quiet hours, render nothing yet, and emit one message per channel per recipient. The **channel workers** do one thing each: render, call a provider, record the attempt. Because the planner is separate, a slow provider cannot delay decision-making, and because the workers are per channel, an SMS provider outage does not back up email.

The ingest API writes the notification row and produces to `notify.requests` in one logical unit using the outbox pattern from Project 2 — the API returns `202 Accepted` with a notification id as soon as the row is committed. Callers never wait for a provider.

Topics are partitioned by `user_id` so that everything for one user is ordered and one user cannot be split across workers, which matters for quiet-hours deferral and for digest grouping. `critical` traffic gets its own topic (`notify.email.critical`) and its own consumer group with dedicated workers; a marketing campaign filling the standard topic then cannot delay a password reset. This is the single most valuable architectural decision in the project, and it costs one extra topic.

### 60.3.4 Database schema

```sql
CREATE TYPE channel AS ENUM ('email','push','sms','inapp');
CREATE TYPE notify_status AS ENUM ('accepted','planned','sent','delivered','failed','suppressed','deferred');

CREATE TABLE templates (
  id           bigserial PRIMARY KEY,
  key          text NOT NULL,             -- 'order.shipped'
  channel      channel NOT NULL,
  locale       text NOT NULL,             -- 'en', 'de', 'fr-CA'
  version      int NOT NULL,
  subject      text,                      -- email only
  body         text NOT NULL,             -- handlebars-style source
  variables    jsonb NOT NULL DEFAULT '[]',  -- declared contract, validated at render
  active       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_unique UNIQUE (key, channel, locale, version)
);
CREATE UNIQUE INDEX templates_one_active_idx
  ON templates (key, channel, locale) WHERE active;

CREATE TABLE preferences (
  user_id      uuid NOT NULL,
  category     text NOT NULL,             -- 'transactional','shipping','marketing','security'
  channel      channel NOT NULL,
  mode         text NOT NULL DEFAULT 'immediate',  -- immediate | digest_daily | digest_weekly | off
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel)
);

CREATE TABLE user_settings (
  user_id      uuid PRIMARY KEY,
  timezone     text NOT NULL DEFAULT 'UTC',        -- IANA name, e.g. 'Asia/Kolkata'
  locale       text NOT NULL DEFAULT 'en',
  quiet_start  time,                                -- local wall-clock time
  quiet_end    time,
  email        citext,
  phone_e164   text,
  CONSTRAINT quiet_pair CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);

CREATE TABLE suppressions (
  address      text NOT NULL,             -- email address or phone
  channel      channel NOT NULL,
  reason       text NOT NULL,             -- 'hard_bounce','complaint','unsubscribe','manual'
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address, channel)
);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text,                   -- caller supplied, unique per key+template
  user_id       uuid NOT NULL,
  template_key  text NOT NULL,
  category      text NOT NULL,
  priority      smallint NOT NULL DEFAULT 5,   -- 1 critical .. 9 bulk
  payload       jsonb NOT NULL DEFAULT '{}',
  status        notify_status NOT NULL DEFAULT 'accepted',
  created_at    timestamptz NOT NULL DEFAULT now(),
  planned_at    timestamptz,
  CONSTRAINT notifications_idem_unique UNIQUE (user_id, template_key, idempotency_key)
);
CREATE INDEX notifications_user_recent_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_pending_idx ON notifications (created_at)
  WHERE status IN ('accepted','planned','deferred');

CREATE TABLE deliveries (
  id            bigserial,
  notification_id uuid NOT NULL,
  channel       channel NOT NULL,
  provider      text NOT NULL,            -- 'ses','sendgrid','twilio','fcm','inapp'
  attempt       smallint NOT NULL DEFAULT 1,
  status        notify_status NOT NULL,
  provider_message_id text,
  error_code    text,
  latency_ms    int,
  scheduled_for timestamptz,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE deliveries_2026_09 PARTITION OF deliveries
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE INDEX deliveries_2026_09_notif_idx ON deliveries_2026_09 (notification_id);
CREATE UNIQUE INDEX deliveries_2026_09_provider_msg_idx
  ON deliveries_2026_09 (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Consumer-side idempotency. One row per (consumer group, event id).
CREATE TABLE inbox (
  consumer     text NOT NULL,
  event_id     text NOT NULL,
  handled_at   timestamptz NOT NULL DEFAULT now(),
  result       text,
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX inbox_cleanup_idx ON inbox (handled_at);

CREATE TABLE inapp_messages (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL,
  notification_id uuid NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  link         text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inapp_unread_idx ON inapp_messages (user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
```

```mermaid
erDiagram
  USER_SETTINGS ||--o{ PREFERENCES : configures
  USER_SETTINGS ||--o{ NOTIFICATIONS : receives
  NOTIFICATIONS ||--o{ DELIVERIES : attempts
  NOTIFICATIONS ||--o| INAPP_MESSAGES : materialises
  TEMPLATES ||--o{ NOTIFICATIONS : renders
  SUPPRESSIONS ||--o{ DELIVERIES : blocks
  NOTIFICATIONS {
    uuid id PK
    uuid user_id
    text template_key
    text category
    notify_status status
  }
  DELIVERIES {
    bigint id PK
    uuid notification_id FK
    channel channel
    text provider
    text provider_message_id
  }
```

### 60.3.5 APIs

| Method | Path | Auth | Request | Response | Codes | Idempotency |
|---|---|---|---|---|---|---|
| POST | `/notifications` | service token | `{userId,templateKey,category,priority,payload}` + `Idempotency-Key` | `202 {notificationId,status}` | 202, 400, 409 duplicate, 429 | Yes; the unique index makes a replay return the original id |
| POST | `/notifications/bulk` | service token | `{templateKey,category,recipients:[...]}` max 1,000 | `202 {batchId,accepted,rejected}` | 202, 413 too large | Yes per recipient via key |
| GET | `/notifications/:id` | service token | — | `200 {status,deliveries:[...]}` | 200, 404 | Yes |
| GET | `/inapp` | user token | `?cursor&limit&unreadOnly` | `200 {items,nextCursor,unreadCount}` | 200, 401 | Yes |
| POST | `/inapp/:id/read` | user token | — | `204` | 204, 404 | Yes |
| POST | `/inapp/read-all` | user token | — | `204` | 204 | Yes |
| GET | `/preferences` | user token | — | `200 {settings,preferences[]}` | 200 | Yes |
| PUT | `/preferences` | user token | `{category,channel,mode}` | `200` | 200, 422 cannot opt out of security | Yes |
| PUT | `/settings` | user token | `{timezone,locale,quietStart,quietEnd}` | `200` | 200, 422 bad IANA zone | Yes |
| GET | `/unsubscribe/:token` | none | — | `200` page | 200, 410 expired | Yes |
| POST | `/unsubscribe/:token` | none | `{category}` | `204` | 204 | Yes; one-click List-Unsubscribe posts here |
| POST | `/webhooks/:provider` | HMAC signature | provider payload | `200` | 200, 401 bad signature, 400 | Yes; `(provider, provider_message_id, event)` deduped |
| GET | `/admin/dlq` | admin | `?topic&cursor` | `200 {items,nextCursor}` | 200, 403 | Yes |
| POST | `/admin/dlq/replay` | admin | `{topic,ids[]}` or `{topic,before}` | `202 {replayed}` | 202, 403 | Yes; replayed messages carry the original event id, so the inbox dedupes |
| GET | `/admin/templates` | admin | `?key` | `200` | 200 | Yes |
| POST | `/admin/templates/:id/activate` | admin | `{}` | `200` | 200, 409 | Yes |

`WS /realtime` upgrades with the access token; the server subscribes the socket to `user:{id}` and pushes `inapp.message` frames. On connect, the client sends its last-seen id and the server replays anything newer from `inapp_messages`, so a reconnect never loses a notification. WebSocket is a delivery optimisation, not a delivery guarantee — the database is the guarantee.

### 60.3.6 NestJS modules

```text
src/
  ingest/     ingest.module.ts  ingest.controller.ts  ingest.service.ts
  planner/    planner.module.ts planner.consumer.ts   audience.service.ts
              preferences.service.ts  quiet-hours.ts
  channels/   channel.interface.ts
              email/ email.channel.ts  ses.provider.ts  sendgrid.provider.ts
              sms/   sms.channel.ts    twilio.provider.ts
              push/  push.channel.ts   fcm.provider.ts
              inapp/ inapp.channel.ts  realtime.gateway.ts
  delivery/   delivery.module.ts  dispatcher.service.ts  ratelimit.service.ts
              circuit-breaker.ts  delivery.repository.ts
  templates/  templates.module.ts  template.service.ts  renderer.ts
  webhooks/   webhooks.module.ts   webhook.controller.ts  signature.guard.ts
  inbox/      inbox.module.ts      inbox.service.ts
  digests/    digests.module.ts    digest.scheduler.ts
  admin/      dlq.controller.ts    dlq.service.ts
```

**`channel.interface.ts` — the abstraction everything hangs from.**

```ts
export interface RenderedMessage {
  to: string;                  // email, phone in E.164, device token, or user id
  subject?: string;
  body: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  acceptedAt: Date;
}

export class TransientProviderError extends Error {   // retry
  constructor(message: string, readonly retryAfterMs?: number) { super(message); }
}
export class PermanentProviderError extends Error {   // do not retry, suppress
  constructor(message: string, readonly code: string) { super(message); }
}

export interface ChannelProvider {
  readonly name: string;              // 'ses'
  readonly channel: 'email' | 'sms' | 'push' | 'inapp';
  /** Must be idempotent for the same idempotencyKey where the provider supports it. */
  send(msg: RenderedMessage, idempotencyKey: string): Promise<SendResult>;
  healthy(): boolean;
}
```

Every provider is a `ChannelProvider`. The dispatcher knows nothing about SES, Twilio or FCM; it knows about ordered lists of providers, timeouts, breakers and buckets. When you add a fourth email provider in year two, you write one class and one config line.

**`dispatcher.service.ts` — rate limit, breaker, timeout, fallback, record.**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ChannelProvider, PermanentProviderError, RenderedMessage, TransientProviderError } from '../channels/channel.interface';
import { RateLimitService } from './ratelimit.service';
import { CircuitBreaker } from './circuit-breaker';
import { DeliveryRepository } from './delivery.repository';

@Injectable()
export class DispatcherService {
  private readonly log = new Logger(DispatcherService.name);

  constructor(
    private readonly limits: RateLimitService,
    private readonly deliveries: DeliveryRepository,
    private readonly breakers: Map<string, CircuitBreaker>,
  ) {}

  /** providers is ordered: primary first, fallback second. */
  async dispatch(
    providers: ChannelProvider[],
    msg: RenderedMessage,
    ctx: { notificationId: string; idempotencyKey: string; attempt: number },
  ) {
    let lastError: unknown;
    for (const provider of providers) {
      const breaker = this.breakers.get(provider.name)!;
      if (breaker.isOpen()) { this.log.warn(`breaker open ${provider.name}`); continue; }

      // Token bucket: waits up to 2 s for capacity, then tries the next provider.
      const allowed = await this.limits.acquire(provider.name, 2000);
      if (!allowed) { lastError = new TransientProviderError('rate_limited'); continue; }

      const startedAt = Date.now();
      try {
        const res = await withTimeout(provider.send(msg, ctx.idempotencyKey), 5000);
        breaker.recordSuccess();
        await this.deliveries.record({ ...ctx, provider: provider.name, status: 'sent',
          providerMessageId: res.providerMessageId, latencyMs: Date.now() - startedAt });
        return res;
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        if (err instanceof PermanentProviderError) {
          await this.deliveries.record({ ...ctx, provider: provider.name, status: 'failed',
            errorCode: err.code, latencyMs });
          throw err;                    // no fallback for "invalid address"
        }
        breaker.recordFailure();
        await this.deliveries.record({ ...ctx, provider: provider.name, status: 'failed',
          errorCode: 'transient', latencyMs });
        lastError = err;                // try the next provider
      }
    }
    throw lastError ?? new TransientProviderError('no_provider_available');
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new TransientProviderError('timeout')), ms)),
  ]);
}
```

The distinction between `TransientProviderError` and `PermanentProviderError` is the single most important line of thinking in the whole project. Retrying a `550 mailbox does not exist` a thousand times gets your sending domain blocked; not retrying a `503` loses real messages.

**`quiet-hours.ts` — timezone-correct deferral.**

```ts
import { DateTime } from 'luxon';

export interface QuietHours { timezone: string; start: string | null; end: string | null; }

/**
 * Returns null if it is fine to send now, otherwise the UTC instant to send at.
 * Handles windows that cross midnight and DST gaps, where 02:30 local may not exist.
 */
export function nextAllowedSend(now: Date, q: QuietHours): Date | null {
  if (!q.start || !q.end) return null;
  const local = DateTime.fromJSDate(now, { zone: q.timezone });
  if (!local.isValid) return null;                    // unknown zone: send now, log it

  const [sh, sm] = q.start.split(':').map(Number);
  const [eh, em] = q.end.split(':').map(Number);
  const startToday = local.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  let endToday = local.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  const crossesMidnight = endToday <= startToday;
  if (crossesMidnight) endToday = endToday.plus({ days: 1 });

  const inQuiet = crossesMidnight
    ? local >= startToday || local < endToday.minus({ days: 1 })
    : local >= startToday && local < endToday;
  if (!inQuiet) return null;

  let target = local < startToday ? endToday.minus({ days: 1 }) : endToday;
  // If the local wall-clock time does not exist because of a DST spring-forward,
  // Luxon moves it forward; adding a minute and re-normalising makes that explicit.
  if (!target.isValid) target = target.plus({ minutes: 60 });
  return target.toUTC().toJSDate();
}
```

Store `timezone` as an IANA name, never as an offset. An offset stored in March is wrong in November for half the planet, and you will find out through a support ticket that says "your app woke my baby".

**`inbox.service.ts` — idempotent consumption.**

```ts
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

@Injectable()
export class InboxService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Runs work exactly once per (consumer, eventId). The inbox insert and the
   * work share one transaction, so a crash rolls both back and redelivery retries.
   */
  async once<T>(consumer: string, eventId: string, work: (em: EntityManager) => Promise<T>): Promise<T | 'duplicate'> {
    return this.ds.transaction(async (em) => {
      const res = await em.query(
        `INSERT INTO inbox (consumer, event_id) VALUES ($1, $2)
         ON CONFLICT (consumer, event_id) DO NOTHING RETURNING event_id`,
        [consumer, eventId],
      );
      if (res.length === 0) return 'duplicate' as const;
      return work(em);
    });
  }
}
```

**`planner.consumer.ts` — the decision stage, in outline.**

```ts
@Injectable()
export class PlannerConsumer {
  constructor(
    private readonly inbox: InboxService,
    private readonly prefs: PreferencesService,
    private readonly producer: KafkaProducer,
  ) {}

  async handle(msg: { eventId: string; notificationId: string; userId: string;
                      templateKey: string; category: string; priority: number }) {
    const outcome = await this.inbox.once('planner', msg.eventId, async (em) => {
      const settings = await this.prefs.load(em, msg.userId);           // one query, cached
      if (!settings) return { skipped: 'unknown_user' };

      const channels = this.prefs.channelsFor(settings, msg.category);  // [] means opted out
      if (channels.length === 0) {
        await em.query(`UPDATE notifications SET status='suppressed' WHERE id=$1`, [msg.notificationId]);
        return { skipped: 'opted_out' };
      }

      const sendAt = msg.category === 'security' || msg.priority <= 2
        ? null                                                          // critical ignores quiet hours
        : nextAllowedSend(new Date(), settings.quiet);

      for (const channel of channels) {
        if (this.prefs.isDigest(settings, msg.category, channel)) {
          await em.query(
            `INSERT INTO digest_queue (user_id, channel, notification_id, bucket)
             VALUES ($1,$2,$3, date_trunc('day', now())) ON CONFLICT DO NOTHING`,
            [msg.userId, channel, msg.notificationId]);
          continue;
        }
        await this.producer.send(topicFor(channel, msg.priority), {
          key: msg.userId,
          value: { ...msg, channel, sendAt: sendAt?.toISOString() ?? null },
          headers: { eventId: `${msg.eventId}:${channel}` },            // per-channel event id
        });
      }
      await em.query(`UPDATE notifications SET status='planned', planned_at=now() WHERE id=$1`, [msg.notificationId]);
      return { planned: channels.length };
    });
    return outcome;
  }
}
```

Note `eventId: ${msg.eventId}:${channel}`. Each downstream consumer needs its own idempotency key, or the email worker and the SMS worker would collide in the inbox and one of them would silently skip.

### 60.3.7 PostgreSQL design decisions

**Transactions.** The inbox insert and the handler's writes always share one transaction — that is the entire idempotency guarantee, and it breaks the moment someone "optimises" the insert into a separate connection. Recording a delivery attempt is a single insert and needs no transaction. The webhook handler updates a delivery and possibly inserts a suppression in one transaction, because a bounce that suppresses the address but fails to record the bounce leaves you unable to explain the suppression later.

**Locks.** Almost none, deliberately. This system is insert-heavy, not update-heavy. The one place with contention is the digest builder, which claims a user's digest bucket with `SELECT ... FOR UPDATE SKIP LOCKED` so that two scheduler replicas cannot build the same digest twice.

**Indexes.**

- `notifications_idem_unique (user_id, template_key, idempotency_key)` — makes the API idempotent in the database rather than in a `if (exists)` race.
- `notifications_pending_idx` partial on unfinished statuses — the reconciliation job that finds notifications stuck in `accepted` because the planner crashed. Partial, because 99.9 percent of rows are finished.
- `deliveries_*_provider_msg_idx` unique partial per partition — the webhook lookup by `(provider, provider_message_id)` and, simultaneously, protection against processing the same provider event twice.
- `inapp_unread_idx` partial on `read_at IS NULL` — the unread badge, which is queried on every page load and must be cheap.
- `inbox_cleanup_idx` — a nightly `DELETE FROM inbox WHERE handled_at < now() - interval '7 days'` in batches of 10,000. Without cleanup, the inbox becomes the largest table in the database within a year.

**Partitioning.** `deliveries` is the hot table: 10 million notifications a day with an average of 1.4 delivery rows each is 14 million rows a day, over 400 million a month. Monthly range partitions keep each index small enough to stay in memory and turn retention into `DROP TABLE`. Create partitions three months ahead with a scheduled job, and alert on their absence: a missing partition means every insert fails, which means every notification fails, which is a total outage from a forgotten cron.

**Migrations.** Templates are data, not schema, so template changes ship as seeded rows with a version number and an `active` flag, and activation is an API call, not a deploy. This lets you roll back a bad template in 10 seconds without a release. Schema migrations follow the same expand-contract rules as before; adding a new `channel` enum value is `ALTER TYPE channel ADD VALUE 'webhook'`, which cannot run inside a transaction block, so it gets its own migration file.

### 60.3.8 Redis usage

| Key | Structure | TTL | Purpose | Notes |
|---|---|---|---|---|
| `bucket:{provider}` | Token bucket via Lua: `{tokens,updatedAt}` | 60 s idle | Per-provider rate limit, for example 200/s for SES | One Lua script does refill and take atomically |
| `breaker:{provider}` | Hash `{state,failures,openedAt}` | 300 s | Circuit breaker state shared across worker pods | Local state alone means 20 pods each learn the outage separately |
| `prefs:{userId}` | String JSON | 600 s | Preferences and settings for the planner | Deleted on preference update |
| `dedupe:{templateKey}:{userId}:{hash}` | `SET NX EX 3600` | 1 h | Collapses identical notifications, for example five "back in stock" in a minute | Business rule, configurable per template |
| `digest:{userId}:{bucket}` | Set of notification ids | 48 h | Accumulates digest items between builds | Authoritative copy also in PostgreSQL |
| `ws:user:{userId}` | Set of socket ids | while connected | Which gateway pods hold this user's sockets | Pub/Sub channel `ws:{podId}` fans out |
| `unread:{userId}` | Counter | 24 h | Unread badge without a query | Rebuilt from PostgreSQL on miss |
| `lock:digest:{bucket}` | `SET NX PX 60000` | 60 s | One builder per bucket | Belt and braces with `SKIP LOCKED` |
| `webhook:seen:{provider}:{id}` | `SET NX EX 86400` | 24 h | Fast duplicate webhook rejection | The unique index is still the real guard |

The token bucket script is worth writing yourself once:

```text
-- KEYS[1] bucket key, ARGV[1] rate/s, ARGV[2] burst, ARGV[3] now_ms, ARGV[4] cost
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or tonumber(ARGV[2])
local ts     = tonumber(b[2]) or tonumber(ARGV[3])
local delta  = math.max(0, tonumber(ARGV[3]) - ts) / 1000.0
tokens = math.min(tonumber(ARGV[2]), tokens + delta * tonumber(ARGV[1]))
if tokens < tonumber(ARGV[4]) then return 0 end
redis.call('HMSET', KEYS[1], 'tokens', tokens - tonumber(ARGV[4]), 'ts', ARGV[3])
redis.call('PEXPIRE', KEYS[1], 60000)
return 1
```

### 60.3.9 Messaging usage

**Topics.**

| Topic | Partitions | Key | Retention | Consumer group |
|---|---|---|---|---|
| `notify.requests` | 12 | `user_id` | 7 days | `planner` |
| `notify.email` | 24 | `user_id` | 3 days | `email-worker` |
| `notify.email.critical` | 6 | `user_id` | 3 days | `email-worker-critical` |
| `notify.sms` | 6 | `user_id` | 3 days | `sms-worker` |
| `notify.push` | 24 | `user_id` | 1 day | `push-worker` |
| `notify.inapp` | 12 | `user_id` | 1 day | `inapp-worker` |
| `notify.*.retry.{1,2,3}` | same as parent | `user_id` | 3 days | delayed consumers |
| `notify.*.dlq` | 3 | `user_id` | 30 days | none; drained by the replay tool |

**Retries.** Kafka has no native delay, so use the classic retry-topic ladder. A failed message is produced to `notify.email.retry.1` with a header `notBefore = now + 30 s`; the retry-1 consumer reads, and if `notBefore` is in the future it pauses that partition until then rather than looping. Ladder: 30 s, 5 min, 30 min, then DLQ. Permanent errors skip the ladder and go straight to the DLQ. Never retry in place by re-processing the same offset without committing — that stalls the partition and eventually triggers a rebalance storm.

**Consumer groups and ordering.** Keying by `user_id` gives per-user ordering, which is what users perceive. Global ordering is neither needed nor achievable. `max.poll.records` is small (50) and the handler is fast, because a consumer that takes longer than `max.poll.interval.ms` gets kicked out of the group, and a rebalance during a campaign is how a 20-minute outage starts.

**Outbox and inbox.** Producers (the ingest API, and the other services in Project 6) write to the outbox in the business transaction; the relay publishes. Every consumer wraps its work in `InboxService.once()`. Together these give effectively-once processing on top of at-least-once transport, and it is worth saying the sentence precisely: *the message may arrive many times; the effect happens once*.

**The DLQ replay tool.** Not a script someone writes during an incident — a tested admin endpoint plus a CLI. It lists DLQ messages with their original topic, partition, offset, error and payload; it lets an operator filter by error code; and it republishes to the original topic with the original event id, so that anything that actually succeeded earlier is absorbed by the inbox. Add a dry-run flag that shows what would be replayed. The first real incident where you replay 40,000 messages and cause zero duplicates is the day this project pays for itself.

```mermaid
sequenceDiagram
  participant P as Planner
  participant K as KafkaEmail
  participant W as EmailWorker
  participant A as PrimaryProvider
  participant B as FallbackProvider
  P->>K: produce key userId
  K->>W: deliver message
  W->>W: inbox once eventId
  W->>A: send with 5s timeout
  A-->>W: 503 transient
  W->>B: fallback send
  B-->>W: 202 accepted id msg_88
  W->>W: record delivery sent
  B->>W: webhook delivered msg_88
  W->>W: update delivery status delivered
```

### 60.3.10 Testing strategy

Unit: quiet-hours across DST boundaries and midnight-crossing windows, template variable validation, the retry ladder's backoff calculation, transient versus permanent error classification for each provider's real error codes. Integration with Testcontainers: PostgreSQL, Redis and Redpanda, with a fake provider HTTP server you can make slow, flaky or broken on demand. E2E: post a notification, assert the fake provider received exactly one message with the right rendered body.

The ten cases:

1. **Duplicate event, one delivery** — deliver the same Kafka message three times; exactly one provider call and one `deliveries` row.
2. **Primary down, fallback used** — primary returns 503; the message is sent by the fallback within one attempt; the breaker opens after five failures.
3. **Permanent error is not retried** — provider returns "invalid address"; zero retries, delivery marked failed, address suppressed.
4. **Quiet hours defer** — a user in `Asia/Kolkata` with quiet 22:00 to 08:00, event at 23:30 local; the message is scheduled for 08:00 local, not 08:00 UTC.
5. **DST correctness** — the same user on the day the clock shifts; the deferred instant differs from the naive calculation by exactly one hour and the test asserts the UTC value.
6. **Critical bypasses quiet hours and preferences** — a security notification is delivered even when the category is set to `off`.
7. **Rate limit respected** — enqueue 5,000 emails with a 200/s bucket; the provider never sees more than 210 in any one-second window over five minutes.
8. **Webhook idempotency** — the same `delivered` webhook posted five times; one status change, four fast rejections; a webhook with a bad HMAC returns 401 and changes nothing.
9. **Poison message goes to DLQ and replays cleanly** — a message with an unknown template lands in the DLQ after the ladder; fix the template, replay, and the message is delivered exactly once.
10. **WebSocket reconnect loses nothing** — disconnect a client, send three in-app messages, reconnect with the last-seen id; all three arrive, none duplicated.

Add a soak test: 20,000 notifications per second produced for ten minutes into a system with a provider that responds in 200 ms, asserting that consumer lag returns to zero within five minutes of the burst ending and that no message is lost.

### 60.3.11 Docker

```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: notify }
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U postgres -d notify"], interval: 5s, retries: 10 }
  redis: { image: redis:7-alpine, ports: ["6379:6379"] }
  redpanda:
    image: redpandadata/redpanda:latest
    command: ["redpanda","start","--smp","1","--memory","1G","--overprovisioned",
              "--kafka-addr","PLAINTEXT://0.0.0.0:9092",
              "--advertise-kafka-addr","PLAINTEXT://redpanda:9092"]
    ports: ["9092:9092"]
  console:
    image: redpandadata/console:latest
    environment: { KAFKA_BROKERS: redpanda:9092 }
    ports: ["8080:8080"]
  mailhog: { image: mailhog/mailhog, ports: ["8025:8025"] }
  fake-provider:
    build: ./tools/fake-provider     # controllable 200/429/503/timeout + webhook callback
    environment: { WEBHOOK_URL: http://api:3000/webhooks/fake, FAILURE_RATE: "0.05" }
    ports: ["4010:4010"]
  api:
    build: { context: ., target: runtime }
    command: ["node","dist/main.js"]
    environment: &env
      DATABASE_URL: postgres://postgres:dev@postgres:5432/notify
      REDIS_URL: redis://redis:6379
      KAFKA_BROKERS: redpanda:9092
      EMAIL_PRIMARY_URL: http://fake-provider:4010
      SMTP_URL: smtp://mailhog:1025
    depends_on: { postgres: { condition: service_healthy } }
    ports: ["3000:3000"]
  planner:
    build: { context: ., target: runtime }
    command: ["node","dist/planner.js"]
    environment: *env
  email-worker:
    build: { context: ., target: runtime }
    command: ["node","dist/worker.js","--channel=email"]
    environment: *env
    deploy: { replicas: 2 }
```

The `fake-provider` container is the most valuable thing in this compose file. Make it configurable at runtime (`POST /control {failureRate, latencyMs, mode}`) so your integration tests can turn a provider outage on and off. Testing resilience against a mock inside the process proves nothing about timeouts, sockets or DNS.

### 60.3.12 CI/CD

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: dev, POSTGRES_DB: notify_test }, ports: ["5432:5432"], options: --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10 }
      redis:    { image: redis:7, ports: ["6379:6379"] }
      redpanda: { image: redpandadata/redpanda:latest, ports: ["9092:9092"] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run lint && npx tsc --noEmit
      - run: npm run migration:run
      - run: npm run test:unit
      - run: npm run test:integration        # Testcontainers reuses the service containers
      - run: npm run test:templates          # renders every active template in every locale
      - run: npm run test:e2e
  build-and-scan:
    needs: verify
    steps:
      - uses: docker/build-push-action@v6
        with: { push: true, tags: "ghcr.io/${{ github.repository }}/notify:${{ github.sha }}" }
      - uses: aquasecurity/trivy-action@master
        with: { image-ref: "ghcr.io/${{ github.repository }}/notify:${{ github.sha }}", severity: "CRITICAL,HIGH", exit-code: "1" }
  deploy:
    needs: build-and-scan
    if: github.ref == 'refs/heads/main'
    steps:
      - run: kubectl apply -f k8s/ && kubectl wait --for=condition=complete job/notify-migrate --timeout=300s
      - run: kubectl rollout status deploy/notify-api deploy/notify-planner deploy/notify-email --timeout=600s
      - run: ./scripts/smoke-notify.sh      # posts one notification, asserts fake provider receipt
```

`test:templates` is the cheap job that saves you most often: it renders every active template in every locale with a fixture payload and fails on an undefined variable. A missing `{{orderNumber}}` in the German template is the kind of bug that reaches 40,000 customers before anyone notices.

Deployment order matters here. Roll out consumers **before** producers when a new message field is added (consumers must tolerate it), and producers before consumers when a field is removed. Write that rule in the repository, because you will get it wrong once.

### 60.3.13 Observability

**Metrics:** `notify_accepted_total{category,channel}`; `notify_planned_total{decision="send|digest|suppressed|deferred"}`; `notify_sent_total{channel,provider,result}`; `notify_delivery_latency_seconds{channel}` measured from `notifications.created_at` to provider accept (the number the business actually cares about); `notify_provider_duration_seconds{provider}`; `notify_breaker_state{provider}`; `notify_bucket_wait_seconds{provider}`; `kafka_consumer_lag{topic,group}`; `notify_dlq_depth{topic}` and `notify_dlq_oldest_seconds`; `notify_webhook_total{provider,event}`; `ws_connections` and `ws_fanout_duration_seconds`.

**Log fields:** `traceId, notificationId, userId, templateKey, category, channel, provider, attempt, providerMessageId, errorCode, latencyMs, decision`. Never log the rendered body (it contains personal data and often a magic link), never log phone numbers or email addresses in full — log a hash and the domain part.

**Traces:** one trace should span ingest, planner and worker. That means propagating the W3C `traceparent` through Kafka headers, which OpenTelemetry's Kafka instrumentation does if you let it, and which you must do by hand if you wrote your own producer wrapper. The payoff is a waterfall showing that a "slow email" was 4 seconds of consumer lag, 40 ms of rendering and 900 ms of provider, so you know which team owns the problem.

**Dashboards:** a pipeline row (accepted, planned, sent, delivered, failed as a funnel, with drop-off percentages); a provider row (latency, error rate, breaker state, bucket saturation per provider); a lag row (consumer lag per topic and group); a DLQ row (depth and age per topic).

**Alerts:** `notify_dlq_oldest_seconds > 3600` (ticket) and `> 86400` (page); consumer lag on `notify.email.critical` above 1,000 messages for 2 minutes (page); provider error rate above 20 percent for 5 minutes (page); `notify_delivery_latency_seconds` p95 for the `security` category above 60 s (page); suppression rate spike, which usually means someone imported a bad address list; zero notifications accepted for 10 minutes during business hours, which catches the outage where everything looks green because nothing is happening.

### 60.3.14 Failure scenarios

| Failure | Expected behaviour | How you test it |
|---|---|---|
| Primary email provider returns 503 for 10 minutes | Breaker opens after 5 failures, all traffic moves to the fallback, no message lost, one alert | Fake provider set to 503; assert fallback deliveries and breaker metric |
| Both providers down | Messages ride the retry ladder; after 3 rungs they DLQ; when providers recover, replay delivers them | Both fakes down for 40 minutes in a soak test |
| Provider is slow, 8 s per call | 5 s timeout fires, message retried elsewhere; workers do not exhaust their pool | Fake provider latency 8,000 ms |
| Kafka broker restart | Consumers rebalance, no message loss, duplicates absorbed by the inbox | Restart Redpanda mid-soak |
| Consumer crashes after send, before commit | Redelivery hits the inbox, no second email | Kill the worker with `SIGKILL` after a provider call in an integration test |
| Poison payload, unknown template | Immediately permanent-failed to DLQ, partition keeps moving | Publish a malformed message into a busy topic |
| Redis down | Rate limits and breakers fail closed to conservative defaults; deliveries continue at a reduced rate; preferences fall back to PostgreSQL | Stop Redis during the soak |
| Webhook flood, 5,000/s from a provider | Ingest is 202 fast, work is queued; duplicates rejected in under 1 ms | k6 against `/webhooks/fake` |
| Deliveries partition for next month missing | Alert fires before the 1st; if it happens, inserts fail loudly and the reconciliation job replays | Drop the partition in staging and observe |
| WebSocket gateway pod dies with 20,000 sockets | Clients reconnect with backoff and jitter, replay from last-seen id, no duplicates | Kill a gateway pod under load |

### 60.3.15 Scaling strategy

**1x — 100k notifications/day, 5/s peak.** One API pod, one planner, one worker per channel, a 3-partition topic each, one PostgreSQL, one Redis. Honestly, at this volume BullMQ on Redis would do the job and Kafka is over-engineering; build it with Kafka anyway because the point is to learn, but know that you could defend the simpler choice.

**10x — 1M/day, 200/s peak, 2,000/s bursts.** Partitions to 12 for email, 6 for SMS. Three email workers, two push workers. The limit is now the provider quota, not you: 200 emails/s means a 2,000/s burst takes 10 seconds to drain, which is fine, and a campaign of 500,000 takes 40 minutes, which needs a product conversation, not an engineering one. Split critical traffic to its own topic and worker set now, before a campaign delays a password reset and you learn this lesson expensively.

**100x — 10M/day, 2,000/s sustained, 20,000/s bursts.** Email partitions to 24 and workers to 12; consumer count must never exceed partition count, so partitions are your scaling knob and you should over-provision them at creation (they are cheap to have, painful to add later because keys rehash and per-user ordering breaks across the change). `deliveries` at 14 million rows a day needs the monthly partitions plus a 90-day retention drop; consider writing delivery attempts to Kafka and into ClickHouse for analytics while PostgreSQL keeps only the current status. Provider quotas dominate: negotiate them, shard across multiple sending domains and IP pools, and keep a warm-up schedule for new IPs. The WebSocket tier scales separately — 200,000 concurrent sockets is 20 pods at 10,000 each, with fan-out through Redis Pub/Sub, and that tier's failure must not affect email.

### 60.3.16 Security checklist

- [ ] Provider webhooks verified by HMAC with a constant-time comparison, a timestamp window of 5 minutes, and a replay cache.
- [ ] Unsubscribe tokens are signed and scoped to `(user, category)`, single-purpose, and cannot be used to enumerate users.
- [ ] `List-Unsubscribe` and `List-Unsubscribe-Post` headers on every marketing email; one click must work without login.
- [ ] Security-category notifications cannot be disabled by preference, and that rule is enforced server-side with a 422.
- [ ] Templates render with autoescaping on; user-supplied payload values are never treated as HTML.
- [ ] No secrets or full personal data in logs, traces, or DLQ payloads; payloads in the DLQ are redacted for anything marked sensitive in the template contract.
- [ ] Service-to-service auth on `/notifications` with a token that carries an allowed `templateKey` prefix, so the marketing service cannot send password resets.
- [ ] Per-caller rate limits so a looping client cannot spend your SMS budget; a daily spend cap with a hard stop.
- [ ] SMS destinations validated against an allow-list of country codes to blunt toll-fraud (`SMS pumping`), which is a real and expensive attack.
- [ ] Suppression list honoured before every send, checked in the worker, not only in the planner.
- [ ] PII columns (`email`, `phone_e164`) restricted by database grants; deletion request removes them and keeps aggregate counts.
- [ ] Sending domain has SPF, DKIM and DMARC; a broken DKIM key is an alert, not a mystery.

### 60.3.17 Stretch goals

Template editing with a preview and a safe subset of expressions, plus an approval workflow. A/B testing with a variant assignment stored on the notification. Send-time optimisation that learns each user's most likely open hour. Batching pushes into a summary when more than N arrive in a window. Localised number, date and currency formatting through `Intl`. A "notification centre" API with categories and read state. Multi-tenant isolation with per-tenant quotas and provider credentials. A cost dashboard converting volume into euros per channel per tenant, which is often the most-read dashboard in the company. Finally, replace one channel's Kafka path with an SQS FIFO queue and write down what got easier and what got worse.

### 60.3.18 Definition of done

- [ ] All 12 functional requirements implemented; four channels behind one `ChannelProvider` interface with at least two providers for email.
- [ ] Inbox-based idempotency proven by the triple-delivery test and by a `SIGKILL` crash test.
- [ ] Quiet hours correct across midnight and across a DST transition, proven by unit tests with fixed clocks and real IANA zones.
- [ ] Rate limits hold under a 5,000-message burst; the provider never sees more than quota plus 5 percent.
- [ ] Retry ladder and DLQ implemented; a poison message is replayed successfully with zero duplicates.
- [ ] Webhook handler verifies HMAC, is idempotent, and updates delivery status; unsigned requests are rejected.
- [ ] Digests build once per bucket even with two scheduler replicas running.
- [ ] `deliveries` partitioned monthly with automated creation three months ahead and an alert on absence.
- [ ] End-to-end trace spans ingest, planner and worker with propagated `traceparent`.
- [ ] Dashboards for pipeline funnel, providers, lag and DLQ; all alerts drilled in staging.
- [ ] Soak test: 20,000/s for 10 minutes, lag returns to zero within 5 minutes, zero lost messages verified by counting.
- [ ] Deployed to a real cluster with separate API, planner, worker and gateway deployments and a tested rollback.
- [ ] Runbook covers provider outage, DLQ replay, partition creation failure, and a stuck consumer group.
