## 28.10 Message design

### 28.10.1 The envelope

#### Concept

A message has two parts: the **envelope** (metadata every message carries, in the same shape, forever) and the **payload** (the event-specific data). The envelope is what lets generic infrastructure (dedup, tracing, routing, DLQ tooling, replay) work without knowing what the payload means.

#### Why does it exist?

Without a standard envelope, every consumer parses messages differently, dedup has no id to key on, traces stop at the broker, and nobody can tell from a DLQ entry where the message came from or when. The envelope is a contract with the future: the payload will evolve, the envelope will not.

#### How it works

| Field | Type | Purpose |
|---|---|---|
| `id` | UUID v4 or v7 | Unique per message; the dedup key. Assigned by the producer once, reused on every retry |
| `type` | string, `OrderPlaced` | What happened; routes to the handler |
| `version` | integer | Schema version of the payload; consumers branch on it |
| `occurredAt` | ISO 8601 UTC | When the fact happened in the producer, from the database clock where possible |
| `producer` | string, `orders-api` | Owning service; for debugging and DLQ triage |
| `correlationId` | UUID | Ties every message in one business flow together (one checkout, one ride) |
| `causationId` | UUID | The `id` of the message that caused this one; builds the causal chain |
| `traceparent` | W3C trace header | Distributed tracing across the broker (in headers, not the body) |
| `subject` or `key` | string | The entity id this is about; also used as the partition key |
| `payload` | object | The event-specific data |

```ts
// messaging/envelope.ts
import { IsISO8601, IsInt, IsObject, IsString, IsUUID, Min } from 'class-validator';

export class Envelope<T = unknown> {
  @IsUUID() id!: string;
  @IsString() type!: string;
  @IsInt() @Min(1) version!: number;
  @IsISO8601() occurredAt!: string;
  @IsString() producer!: string;
  @IsUUID() correlationId!: string;
  @IsUUID() causationId!: string;
  @IsString() subject!: string;
  @IsObject() payload!: T;
}

export function envelope<T>(type: string, version: number, subject: string, payload: T, ctx: { correlationId: string; causationId?: string }): Envelope<T> {
  const id = randomUUID();
  return {
    id, type, version, subject, payload,
    occurredAt: new Date().toISOString(),
    producer: process.env.SERVICE_NAME ?? 'unknown',
    correlationId: ctx.correlationId,
    causationId: ctx.causationId ?? id,
  };
}
```

Consumers validate the envelope with `class-validator` before touching the payload; an envelope that fails validation goes to the DLQ immediately as a poison message, because retrying cannot fix a missing `id`.

### 28.10.2 Schema evolution

#### Concept

A topic outlives every version of the code that writes to it. Producers and consumers deploy independently, and a topic with 7 days of retention holds messages written by last week's producer. Schema evolution is the discipline that keeps old consumers reading new messages and new consumers reading old ones.

#### How it works

The rules that keep a JSON payload compatible:

1. **Add fields, never remove or rename them.** A consumer that ignores unknown fields (the default with `JSON.parse`) handles additions. Removal breaks anyone who read the field.
2. **New fields are optional with a default** in the consumer, because old messages in the topic do not have them.
3. **Never change a field's type or meaning.** `amount` in cents becoming `amount` in dollars is a silent financial bug; add `amountMinor` instead.
4. **Breaking changes get a new `version`** (and often a new type name: `OrderPlacedV2`), and the consumer handles both for as long as old messages can exist: retention plus DLQ replay window.
5. **A schema registry** (Confluent Schema Registry with Avro, Protobuf or JSON Schema) enforces these rules at publish time, rejecting an incompatible schema before it reaches the topic. Part 25 — Backward Compatibility: APIs, Schemas, Events and Clients covers registries, compatibility modes and the tooling.
6. **Consumer-driven contract tests** (Part 41 — Testing) catch a producer change that would break a consumer before deploy.

```ts
// A consumer that reads two versions during the transition window
function toOrderPlaced(env: Envelope): OrderPlacedV2 {
  if (env.version === 1) {
    const p = env.payload as OrderPlacedV1;
    return { ...p, currency: 'INR', lines: p.items.map((i) => ({ sku: i.sku, qty: i.quantity, unitMinor: i.priceCents })) };
  }
  if (env.version === 2) return env.payload as OrderPlacedV2;
  throw new PoisonMessageError(`unsupported OrderPlaced version ${env.version}`);
}
```

### 28.10.3 Size limits and the claim-check pattern

#### How it works

- Kafka's default `max.message.bytes` is 1 MB; RabbitMQ handles larger but performance degrades above a few hundred kilobytes; SQS is 256 KB.
- A 5 MB PDF, a base64 image, or a full product catalog does not belong in a message. Put the blob in object storage (S3) and put the URL (with an expiry or a signed URL policy) in the message: the **claim-check pattern**. The consumer fetches what it needs when it needs it.
- Keep events small and factual: `OrderPlaced` carries order id, customer id, totals and line items (ids, quantities, prices at the time), not the customer's full profile and the product descriptions. Consumers that need more query the owning service or a read model. The exception is when consumers must be independent of the producer's availability, in which case a richer "fat event" is a deliberate choice with a documented size cap.
- Compress at the producer (Kafka batch compression, or gzip the body with a `contentEncoding` header on RabbitMQ) for JSON above tens of kilobytes.

### 28.10.4 Personal data in messages

#### How it works

A retained log is a copy of personal data that lives outside the database you protect. Three consequences:

1. **Retention conflicts with erasure.** A "delete my data" request cannot delete an immutable log entry. The pattern is **crypto-shredding**: encrypt personal fields with a per-user key stored in a key table; to erase, delete the key, and every message with that user's data becomes unreadable.
2. **Minimise.** Put the user id in the event, not the email address, unless the consumer genuinely needs it (the email sender does; the analytics consumer does not). Two events for two audiences is often cleaner than one event with everything.
3. **Access control.** Topic ACLs so that only the services that need `payments.events` can read it; TLS in transit; encryption at rest on brokers; no personal data in message keys or headers, which are often logged in plaintext by tooling.

## 28.11 Producer side

### 28.11.1 The dual-write problem and the outbox pattern

#### Concept

A handler that writes to PostgreSQL and then publishes to a broker has two commits that cannot be made atomic. Commit the database and fail to publish: the order exists and nobody knows. Publish and fail to commit: everyone reacts to an order that does not exist. The **transactional outbox** solves it by writing the event into an `outbox` table inside the same database transaction as the business change, and having a separate relay process publish rows from that table to the broker.

#### How it works

1. `BEGIN; INSERT INTO orders ...; INSERT INTO outbox (id, topic, key, payload, headers) ...; COMMIT;` One transaction, one durability decision.
2. A relay (a polling worker in the same service, or Debezium reading the WAL) reads unpublished outbox rows in order, publishes them, and marks them published.
3. The relay can crash after publishing and before marking: the row is published again on restart. This is the producer-side duplicate path; the envelope `id` is the outbox row's id, so consumers dedup it.
4. Ordering per key is preserved if the relay publishes rows in insertion order with the row's key as the partition key.

Part 30 — Distributed Transactions: Sagas, Outbox, Inbox and Idempotency covers the table design, the polling relay versus CDC, batching, and the failure modes in depth. Here the rule is: **never publish business events directly from a request handler**; write the outbox row and let the relay publish.

#### PostgreSQL example

```sql
CREATE TABLE outbox (
  id           uuid        PRIMARY KEY,              -- becomes the message id
  topic        text        NOT NULL,
  message_key  text        NOT NULL,
  headers      jsonb       NOT NULL DEFAULT '{}',
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;

-- Relay: claim a batch in order, skipping rows another relay instance holds
SELECT id, topic, message_key, headers, payload
  FROM outbox
 WHERE published_at IS NULL
 ORDER BY created_at
 LIMIT 200
 FOR UPDATE SKIP LOCKED;
```

### 28.11.2 Publish after commit, retries, batching and compression

#### How it works

- **Publish after commit** is the minimum discipline even without an outbox (for non-critical notifications, say): never publish inside the transaction, because a rollback after publishing announces something that never happened. With TypeORM, publish in the code after `dataSource.transaction()` resolves; with Sequelize, use `transaction.afterCommit(() => publish())`.
- **Retries** in the producer client (kafkajs `retry.retries`, amqplib reconnect via `amqp-connection-manager`) handle broker blips. Beyond the client's retries, the outbox is the retry: the row stays unpublished and the relay tries again next cycle. A producer without an outbox must choose between failing the request and dropping the event; make the choice explicit.
- **Batching**: the relay publishes 100 to 500 outbox rows per `send`, in key order. kafkajs `producer.send` with many messages is one batch per partition. `linger.ms` on the Java producer does the same for direct publishers.
- **Compression** per batch (`CompressionTypes.GZIP` in kafkajs; `lz4`/`zstd` need a codec plugin) cuts network and broker disk by 5 to 10x for JSON.

#### NestJS example

`ClientKafka` from `@nestjs/microservices` for the simple case, showing the shape that carries a key and headers. Note that `emit` returns an Observable and does nothing until subscribed; convert with `lastValueFrom` and await it, or the publish silently never happens.

```ts
// orders/orders-events.publisher.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { Envelope } from '../messaging/envelope';

@Injectable()
export class OrdersEventsPublisher implements OnModuleInit {
  constructor(@Inject('KAFKA_CLIENT') private readonly client: ClientKafka) {}

  async onModuleInit(): Promise<void> { await this.client.connect(); }

  async publish(env: Envelope, traceparent?: string): Promise<void> {
    await lastValueFrom(this.client.emit('orders.events', {
      key: env.subject,                                // partition by order id
      value: JSON.stringify(env),
      headers: { 'x-message-id': env.id, 'x-type': env.type, ...(traceparent ? { traceparent } : {}) },
    }));
  }
}
```

```ts
// app.module.ts registration
ClientsModule.register([{
  name: 'KAFKA_CLIENT',
  transport: Transport.KAFKA,
  options: {
    client: { clientId: 'orders-api', brokers: process.env.KAFKA_BROKERS!.split(',') },
    producer: { allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 },
    producerOnlyMode: true,                            // do not join a consumer group just to publish
  },
}]),
```

## 28.12 Consumer side in NestJS

### 28.12.1 `@EventPattern` on the Kafka transport with manual commits

#### Concept

The `@nestjs/microservices` Kafka transport runs a kafkajs consumer and dispatches each message to the handler whose `@EventPattern` (fire-and-forget) or `@MessagePattern` (request/reply over a reply topic) matches the topic. By default it auto-commits. For at-least-once you configure `run: { autoCommit: false }` and commit from the handler through `KafkaContext`.

#### How it works

```ts
// main.ts (consumer service)
const app = await NestFactory.create(AppModule);
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.KAFKA,
  options: {
    client: { clientId: 'inventory-service', brokers: process.env.KAFKA_BROKERS!.split(',') },
    consumer: {
      groupId: 'inventory',                       // owned, unique, never reused by another service
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      rebalanceTimeout: 60_000,
      allowAutoTopicCreation: false,
    },
    run: {
      autoCommit: false,                          // we commit after processing
      partitionsConsumedConcurrently: 4,          // parallelism across partitions, order kept within each
    },
    subscribe: { fromBeginning: false },
  },
});
app.enableShutdownHooks();                        // SIGTERM -> onModuleDestroy hooks -> consumer.disconnect()
await app.startAllMicroservices();
await app.listen(3000);                           // HTTP for health and metrics
```

```ts
// inventory/order-events.consumer.ts
import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, KafkaContext, Payload } from '@nestjs/microservices';
import { validateOrReject } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Envelope } from '../messaging/envelope';
import { IdempotentHandler } from '../messaging/idempotent-handler';
import { DeadLetterService } from '../messaging/dead-letter.service';
import { RetryPolicy } from '../messaging/retry-policy';
import { InventoryService } from './inventory.service';

@Controller()
export class OrderEventsConsumer {
  private readonly logger = new Logger(OrderEventsConsumer.name);
  constructor(
    private readonly idempotent: IdempotentHandler,
    private readonly inventory: InventoryService,
    private readonly dlq: DeadLetterService,
    private readonly retry: RetryPolicy,
  ) {}

  @EventPattern('orders.events')
  async onOrderEvent(@Payload() raw: unknown, @Ctx() ctx: KafkaContext): Promise<void> {
    const msg = ctx.getMessage();
    const partition = ctx.getPartition();
    const topic = ctx.getTopic();
    const heartbeat = ctx.getHeartbeat();

    let env: Envelope;
    try {
      env = plainToInstance(Envelope, raw);
      await validateOrReject(env);
    } catch (err) {
      await this.dlq.park(msg.key?.toString() ?? null, msg.value, headersOf(msg), {
        sourceTopic: topic, partition, offset: msg.offset, consumerGroup: 'inventory', attempts: 1, error: `invalid envelope: ${String(err)}`,
      });
      return this.commit(ctx);                    // poison: park and move on
    }

    if (env.type !== 'OrderPlaced') return this.commit(ctx);   // not for us; still commit

    try {
      await this.retry.run(
        () => this.idempotent.once('inventory', env.id, (m) => this.inventory.reserveForOrder(m, env)),
        { maxAttempts: 5, baseDelayMs: 200, onAttempt: heartbeat },   // heartbeat between attempts
      );
    } catch (err) {
      await this.dlq.park(msg.key?.toString() ?? null, msg.value, headersOf(msg), {
        sourceTopic: topic, partition, offset: msg.offset, consumerGroup: 'inventory', attempts: 5, error: String(err),
      });
    }
    await this.commit(ctx);
  }

  private async commit(ctx: KafkaContext): Promise<void> {
    const { offset } = ctx.getMessage();
    await ctx.getConsumer().commitOffsets([
      { topic: ctx.getTopic(), partition: ctx.getPartition(), offset: (Number(offset) + 1).toString() },  // commit the NEXT offset
    ]);
  }
}

function headersOf(msg: { headers?: Record<string, unknown> }): Record<string, string> {
  return Object.fromEntries(Object.entries(msg.headers ?? {}).map(([k, v]) => [k, v == null ? '' : v.toString()]));
}
```

Important details in that handler:

- **Commit the next offset.** Kafka's committed offset means "start here next time", so it is `offset + 1`. Committing `offset` reprocesses the last message on every restart.
- **Commit after the DLQ publish**, so a message is never both uncommitted and parked.
- **Non-matching types are committed too**; otherwise the group never advances past them.
- **Heartbeat during retries.** A 5 attempt backoff of several seconds could exceed the session timeout without it.
- **`@MessagePattern` versus `@EventPattern`.** `@MessagePattern` expects to send a reply to a `<topic>.reply` topic and requires the producer to have subscribed to it (`client.subscribeToResponseOf`). For events, use `@EventPattern`.

### 28.12.2 Graceful shutdown

#### How it works

1. Kubernetes sends `SIGTERM`. With `enableShutdownHooks()`, NestJS calls `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown` on providers and closes the microservice, which calls `consumer.disconnect()`.
2. kafkajs `disconnect()` stops fetching and waits for the in-flight `eachMessage` or `eachBatch` handler to return before leaving the group. A handler that takes 40 seconds delays shutdown by 40 seconds; set `terminationGracePeriodSeconds` above the handler's worst case, or the pod is `SIGKILL`ed mid-handler and the message is reprocessed by the next owner.
3. Because the consumer sends `LeaveGroup` on a clean shutdown, the rebalance is immediate rather than waiting for the session timeout.
4. During shutdown, stop accepting new work from any internal queue (an in-process per-key worker pool, below) and drain it before returning from the hook.

### 28.12.3 Backpressure, batch consumption and ordering-preserving parallelism

#### Concept

A consumer that pulls faster than it can process either runs out of memory or exceeds its time budget. Backpressure is the consumer slowing the source. Parallelism is the consumer doing more at once without breaking per-key ordering.

#### How it works

- **Pause and resume.** kafkajs `consumer.pause([{ topic, partitions: [p] }])` stops fetching from a partition; `resume` restarts it. Use it when a downstream dependency is degraded (circuit breaker open) so the consumer stops pulling messages it cannot process, instead of retrying them into the DLQ. In the NestJS transport, `ctx.getConsumer()` gives you the kafkajs consumer for this.
- **Batch consumption** (`eachBatch` in plain kafkajs) lets you write 100 rows to PostgreSQL in one statement instead of 100 statements: the difference between 200 and 5,000 messages per second per partition. The NestJS transport delivers one message at a time; for batch semantics, run a plain kafkajs consumer inside a NestJS provider.
- **Concurrency per partition** is 1 by design. `partitionsConsumedConcurrently` gives parallelism across partitions. To go further while keeping per-key order, route each message to an in-process worker lane chosen by `hash(key) mod lanes`: messages with the same key are processed sequentially in one lane, different keys in parallel.

```ts
// messaging/keyed-lanes.ts: per-key sequential processing, parallel across keys
export class KeyedLanes {
  private readonly tails: Promise<void>[];
  constructor(private readonly lanes = 8) { this.tails = Array.from({ length: lanes }, () => Promise.resolve()); }

  run(key: string, work: () => Promise<void>): Promise<void> {
    const lane = hashToLane(key, this.lanes);
    const next = this.tails[lane].then(work, work);    // chain after whatever this lane is doing
    this.tails[lane] = next.catch(() => undefined);    // a failure must not poison the lane
    return next;
  }

  drain(): Promise<void[]> { return Promise.all(this.tails); }   // call from onModuleDestroy
}
```

Commit only after every message in the batch has completed across all lanes, or commit per lane at the lowest completed offset; the simple correct approach is batch-level commit after `drain()`.

```ts
// A plain kafkajs batch consumer inside a NestJS provider, using lanes and batch commit
await this.consumer.run({
  autoCommit: false,
  eachBatch: async ({ batch, heartbeat, resolveOffset, commitOffsetsIfNecessary, isRunning, isStale }) => {
    const lanes = new KeyedLanes(8);
    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;
      const key = message.key?.toString() ?? message.offset;
      void lanes.run(key, async () => {
        await this.handle(message);                    // idempotent; own retry and DLQ inside
        resolveOffset(message.offset);
      });
      if (Number(message.offset) % 50 === 0) await heartbeat();
    }
    await lanes.drain();
    await commitOffsetsIfNecessary();
  },
});
```

#### Production scenario

An inventory consumer on 24 partitions with 6 pods (4 partitions each), `partitionsConsumedConcurrently: 4`, and 8 lanes per partition handles 9,000 `OrderPlaced` events per second with a p99 processing latency of 35 ms and steady-state lag under 500 messages. When PostgreSQL has a failover, the circuit breaker in `InventoryService` opens, the consumer pauses all partitions for 15 seconds, resumes, and the 135,000 message backlog drains in 20 seconds. No message reached the DLQ during the failover, because pausing is not failing.

#### Failure scenario

At 02:14 on-call sees the notifications consumer restarting every 90 seconds with `The group is rebalancing, so a rejoin is needed` followed by `CrashLoopBackOff`. The handler calls a push provider with a 60 second HTTP timeout and no retry budget; during a provider outage every message takes 60 seconds, the session times out at 30, the consumer is kicked, kafkajs crashes the run loop, the pod restarts, the rebalance reassigns the same partition, and the same message is tried again. The fix: a 5 second HTTP timeout, a circuit breaker that pauses the partition when the provider is down, heartbeats during retries, and a session timeout that reflects the real worst case.

#### Edge cases & failure modes

- Handler throws before commit and there is no DLQ path: the transport logs the error and, with `autoCommit: false`, the message is redelivered forever after each restart.
- `emit()` without subscribing: the event is never published; no error.
- Committing `offset` instead of `offset + 1`: one duplicate per partition per restart.
- `partitionsConsumedConcurrently` greater than assigned partitions: harmless; less than: idle capacity.
- Lanes with a shared downstream connection pool smaller than the lane count: lanes serialize on the pool and throughput collapses; size the pool to lanes times partitions.
- A `@MessagePattern` handler on a topic nobody replies to: the consumer tries to produce to `<topic>.reply` and fails if the topic does not exist and auto-creation is off.

#### How a Senior Backend Engineer thinks about this

The senior treats a consumer as a production service with a time budget per message, a dependency health model (pause when the dependency is down, do not fail messages), an explicit commit strategy, a DLQ, and a shutdown path that is tested by killing pods during load. They keep handlers under a second, move long work to a job queue, and do not let the transport's convenience hide the commit.

#### Common mistakes

- Leaving `autoCommit` on because the handler "never fails".
- Using the transport's default `groupId` from an example, shared by two services.
- Retrying in a loop inside the handler for minutes without heartbeating.
- Publishing from inside a database transaction.
- Fat events with the whole customer record, then a support ticket about a customer's address showing up in a log.

#### Interview questions

1. **Why publish through an outbox instead of directly after commit?** Expected: publish-after-commit still loses the event if the process dies between commit and publish; the outbox makes the event part of the transaction and the relay retries. Follow-up: what duplicate does the relay introduce and who handles it?
2. **What offset do you commit after processing offset 41?** Expected: 42.
3. **How do you process in parallel without breaking per-order ordering?** Expected: partitions plus per-key lanes; commit after the batch drains.
4. **A downstream API is down. Retry, DLQ or pause?** Expected: pause the partition (backpressure) with a circuit breaker; DLQ is for messages that cannot succeed, not for a dependency outage.
5. **How does a JSON payload evolve without breaking consumers?** Expected: additive changes, optional with defaults, version bump for breaking changes, registry or contract tests.
6. **Where does a 5 MB PDF go?** Expected: object storage; the message carries the URL.

#### Practical exercise

Build an `orders.events` consumer in NestJS on the Kafka transport with manual commits, envelope validation, the idempotent handler from 28.9, retries with heartbeat, DLQ parking, and graceful shutdown. Acceptance criteria: (a) `kill -TERM` during a 2 second handler finishes the message and commits before exit, verified by logs and a lag check; (b) a message with `version: 99` lands in the DLQ with the reason header and the offset is committed; (c) with the downstream service returning 503, the consumer pauses within 5 seconds, produces zero DLQ entries, and resumes within 30 seconds of recovery; (d) throughput with 8 lanes is at least 5x the single-lane throughput at equal correctness.
