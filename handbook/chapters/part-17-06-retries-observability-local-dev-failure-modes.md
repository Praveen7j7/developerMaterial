## 17.13 Retry strategy by error type

#### Concept

Not every failure deserves a retry. A network timeout will probably succeed in a second; a validation error will fail identically a thousand times; a message that crashes the deserializer will never be parsed. A consumer that treats all three the same either loses recoverable work or loops forever on unrecoverable work. Error classification is the difference.

#### How it works

| Error class | Examples | Retry? | Where | Then |
|---|---|---|---|---|
| **Transient** | Connection reset, HTTP 502/503/504, request timeout, PostgreSQL deadlock (`40P01`) or serialization failure (`40001`), lock timeout, broker `NotEnoughReplicas`, rate limited (429) | Yes, with exponential backoff and jitter | In-process for the first 2 to 3 attempts (tens of ms to seconds); then delayed retry via wait queue or retry topic (30 s, 2 min, 10 min) | DLQ after the budget (5 to 8 attempts over roughly 15 minutes); alert if transient DLQ rate rises, because that means an outage, not bad data |
| **Dependency down** | Circuit breaker open, every call failing for more than N seconds | Do not retry individual messages | Pause the partition or stop consuming the queue; resume when the breaker half-opens | Nothing goes to the DLQ; lag grows and the lag alert tells the story |
| **Permanent (business)** | Entity not found, state transition not allowed, insufficient stock, HTTP 400/404/409/422 from a downstream, unique violation you did not expect | No | Nowhere | DLQ immediately with the error; commit; often the fix is a data correction and a replay, or a decision that the message is obsolete |
| **Poison** | Cannot parse, envelope invalid, unknown `type` or unsupported `version`, handler throws `TypeError`, message causes the consumer process to crash | No | Nowhere | DLQ immediately; page if a poison message caused a crash loop; the fix is a code deploy, then replay |
| **Unknown** | Anything not classified | Bounded: 3 attempts | In-process | DLQ; every unknown error seen in the DLQ gets classified and added to the table |

The backoff formula that avoids retry storms: `delay = min(cap, base * 2^attempt) * random(0.5, 1.5)`. With `base = 200 ms` and `cap = 60 s`, attempts land at roughly 0.2, 0.4, 0.8, 1.6, 3.2 seconds and then at wait-queue tiers. Jitter is not optional: 500 consumers retrying at exactly 30 seconds is a synchronized hammer on a recovering dependency.

```ts
// messaging/error-classifier.ts
export type ErrorKind = 'transient' | 'permanent' | 'poison' | 'unknown';

export function classifyError(err: unknown): ErrorKind {
  if (err instanceof PoisonMessageError || err instanceof SyntaxError || err instanceof TypeError) return 'poison';
  if (err instanceof NotFoundException || err instanceof ConflictException || err instanceof BadRequestException) return 'permanent';
  const e = err as { code?: string; status?: number; name?: string; message?: string };
  if (e.code === '40001' || e.code === '40P01' || e.code === '55P03') return 'transient';        // PG serialization, deadlock, lock_not_available
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED') return 'transient';
  if (e.status !== undefined && [408, 425, 429, 500, 502, 503, 504].includes(e.status)) return 'transient';
  if (e.status !== undefined && e.status >= 400 && e.status < 500) return 'permanent';
  return 'unknown';
}
```

```ts
// messaging/retry-policy.ts
@Injectable()
export class RetryPolicy {
  async run<T>(op: () => Promise<T>, opts: { maxAttempts: number; baseDelayMs: number; capMs?: number; onAttempt?: () => Promise<void> }): Promise<T> {
    const cap = opts.capMs ?? 60_000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const kind = classifyError(err);
        if (kind === 'permanent' || kind === 'poison') throw err;                      // no retry
        const budget = kind === 'unknown' ? Math.min(3, opts.maxAttempts) : opts.maxAttempts;
        if (attempt >= budget) throw err;
        const delay = Math.min(cap, opts.baseDelayMs * 2 ** attempt) * (0.5 + Math.random());
        await opts.onAttempt?.();                                                      // heartbeat
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
```

## 17.14 Observability

#### Concept

A messaging system fails quietly. HTTP failures show up as 500s on a dashboard within seconds; a consumer that stopped processing shows up as a customer complaint three hours later. The observability goal is to turn "silently behind" into a page within minutes.

#### How it works

| Signal | Source | Alert threshold (starting point) | What it tells you |
|---|---|---|---|
| Consumer lag (messages) | `kafka_consumergroup_lag` from kafka-lag-exporter or Burrow; RabbitMQ `rabbitmq_queue_messages_ready`; SQS `ApproximateNumberOfMessagesVisible` | Above 2x the normal steady state for 5 minutes, or above a business number (10,000 unshipped orders) | Consumers slower than producers, stuck, or crashed |
| Consumer lag (seconds) | `kafka_consumergroup_lag_seconds`; SQS `ApproximateAgeOfOldestMessage`; or your own `now - occurredAt` histogram at the consumer | Above the business SLO (emails within 60 s; inventory within 5 s) | Time-to-effect, the number product cares about |
| DLQ depth | Messages in `*.dlq` topics or queues; the `dead_letters` table with `status = 'parked'` | Greater than 0 for 10 minutes in business hours; greater than 100 any time | Data that needs a human |
| DLQ rate | Increase per minute | Sudden jump | A new bug or a producer contract change |
| Processing latency | Histogram per handler (`consumer_process_duration_seconds{topic,type,result}`) | p99 above 50 percent of the session timeout | Approaching kick-out; downstream slowness |
| Rebalance count | kafkajs `consumer.events.GROUP_JOIN` counter; Java `rebalance-rate-per-hour` | More than 3 per 10 minutes outside deploys | Flapping consumer, session timeouts, crash loops |
| Publish failures and latency | `producer_send_errors_total`, `producer_send_duration_seconds` | Any sustained errors | Broker unavailable, `NotEnoughReplicas`, auth |
| Outbox backlog | `SELECT count(*) FROM outbox WHERE published_at IS NULL` and the age of the oldest | Oldest unpublished older than 60 s | Relay down or broker unreachable |
| Under-replicated partitions | Broker JMX `UnderReplicatedPartitions`; MSK CloudWatch | Greater than 0 for 5 minutes | Broker or disk trouble; durability at risk |
| Duplicate rate | Counter incremented when the dedup table says "already processed" | Above 1 percent sustained | Rebalance storms or a replay in progress |
| Consumer liveness | Pod ready and a heartbeat gauge updated on every poll | Gauge stale for 60 s | The process is up but the loop is dead |

Two instrumentation habits:

1. **Tag every message metric with `topic` and `type`**, never with `messageId` or `orderId` (unbounded cardinality kills Prometheus).
2. **Propagate the trace.** Put the W3C `traceparent` header on every published message (the OpenTelemetry kafkajs and amqplib instrumentations do this automatically) and start the consumer span as a child of it with a `messaging.*` semantic convention. One trace then shows the HTTP request, the outbox write, the relay publish, and every consumer's work, with the queue wait time visible as the gap between spans. Part 25 — Observability covers the OpenTelemetry setup; the messaging-specific point is that without header propagation the trace stops at the broker.

```ts
// messaging/consumer-metrics.ts (prom-client)
import { Counter, Gauge, Histogram } from 'prom-client';

export const processDuration = new Histogram({
  name: 'consumer_process_duration_seconds',
  help: 'Handler duration per message',
  labelNames: ['topic', 'type', 'result'] as const,               // result: ok | retry | dlq | duplicate
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
export const endToEndLag = new Histogram({
  name: 'consumer_end_to_end_lag_seconds',
  help: 'now minus occurredAt at processing time',
  labelNames: ['topic', 'type'] as const,
  buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600],
});
export const dlqParked = new Counter({ name: 'consumer_dlq_parked_total', help: 'Messages parked to DLQ', labelNames: ['topic', 'reason'] as const });
export const rebalances = new Counter({ name: 'consumer_rebalances_total', help: 'Group joins', labelNames: ['group'] as const });
export const lastPollAt = new Gauge({ name: 'consumer_last_poll_timestamp_seconds', help: 'Liveness of the consume loop', labelNames: ['group'] as const });
```

## 17.15 Local development and testing

#### How it works

**Docker Compose** with a single-node Kafka in KRaft mode (no ZooKeeper) and RabbitMQ with the management UI covers development. The `KAFKA_ADVERTISED_LISTENERS` line is the one everyone gets wrong: it must be the address your application uses to reach the broker from outside the container.

```yaml
# docker-compose.yml
services:
  kafka:
    image: apache/kafka:3.8.0
    ports: ["9092:9092"]
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"     # same as production: topics are created explicitly
  rabbitmq:
    image: rabbitmq:3.13-management
    ports: ["5672:5672", "15672:15672"]           # UI at http://localhost:15672, guest/guest
  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment: { POSTGRES_PASSWORD: postgres }
```

Create topics with a script that runs in CI and in production migrations alike, with the same partition counts and `min.insync.replicas` (set to 1 locally, 2 in production through an environment variable), so that the local environment does not hide production constraints.

**Testing consumers** has three layers (Part 23 — Testing covers the pyramid; here is the messaging shape):

1. **Unit**: call the handler method directly with a fake `KafkaContext` (a small object exposing `getMessage`, `getPartition`, `getTopic`, `getConsumer` with a spy on `commitOffsets`, and `getHeartbeat`). Assert the business effect, the commit, and the DLQ call for each error class. Fast, no broker.
2. **Integration with Testcontainers**: `@testcontainers/kafka` starts a real broker in a container; the test publishes with kafkajs and asserts on PostgreSQL state. This is where you test duplicates, rebalances and ordering, because those behaviours come from the real broker.
3. **Contract**: a schema test that fails when a producer changes an envelope or payload incompatibly, run in the producer's pipeline against consumers' expectations.

```ts
// test/order-events.consumer.int-spec.ts (excerpt)
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { Kafka } from 'kafkajs';

let kafka: StartedKafkaContainer;
beforeAll(async () => {
  kafka = await new KafkaContainer('confluentinc/cp-kafka:7.6.0').withKraft().start();
  process.env.KAFKA_BROKERS = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
  const admin = new Kafka({ brokers: [process.env.KAFKA_BROKERS] }).admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: 'orders.events', numPartitions: 3 }] });
  await admin.disconnect();
}, 120_000);

it('processes a duplicated OrderPlaced exactly once', async () => {
  const env = envelope('OrderPlaced', 2, order.id, payload, { correlationId: randomUUID() });
  await producer.send({ topic: 'orders.events', messages: [{ key: order.id, value: JSON.stringify(env) }, { key: order.id, value: JSON.stringify(env) }] });
  await waitFor(async () => (await processedCount(env.id)) === 1, { timeout: 10_000 });
  expect(await reservationsFor(order.id)).toHaveLength(1);
});
```

Test the duplicate path and the crash path on purpose. A consumer test suite without a duplicate test is testing the happy path of an at-least-once system.

## 17.16 Edge cases and failure modes

Each entry: what happens, how you notice, what to do.

- **Duplicate message.** Normal. Detected by the dedup table's "already processed" count. Idempotent handler; idempotency keys to external providers; a duplicate-rate metric to distinguish "occasional" from "rebalance storm".
- **Consumer crash mid-batch.** Messages processed but not committed are redelivered; with batch-level commit, the whole batch. Notice via duplicate-rate spikes after restarts. Keep batches small enough that reprocessing is cheap; idempotency makes it harmless.
- **Consumer lag increasing: slow database.** Handler p99 climbs, lag climbs uniformly across partitions. Batch the writes, add an index, or add consumers up to the partition count; beyond that, more partitions.
- **Consumer lag increasing: hot partition.** One partition's lag grows while others are flat. Key skew (one tenant, one product on sale) or a slow message on that partition. Change the key to a finer grain (`orderId` instead of `tenantId`), or add a random suffix for keys that need no ordering, or process that partition's messages with more internal lanes.
- **Consumer lag increasing: too few partitions.** All consumers busy, adding pods does nothing (extra pods sit idle with no partition). Increase partitions during a quiet window with consumers drained, accepting the key re-hash, or start a new topic with more partitions and migrate.
- **Consumer lag increasing: rebalancing storm.** Rebalance counter spikes; throughput drops to zero repeatedly. Session timeouts from slow handlers, pods flapping on memory limits, or deploys with too many pods restarting at once. Static membership, cooperative rebalancing where the client supports it, one pod at a time rollouts, handlers well under the session timeout.
- **Rebalancing during deploy.** Each pod stop and start triggers a rebalance; in-flight messages duplicate. Expected; mitigated by graceful shutdown (`LeaveGroup` immediately), `maxUnavailable: 1`, and idempotency.
- **Out-of-order events after retries.** `OrderCancelled` succeeds while `OrderPlaced` is in a 2 minute retry queue; the cancel arrives first. Retry topics and wait queues break ordering by design. Consumers must tolerate it: version guards, conditional transitions, or a "pending events" buffer keyed by entity for strictly ordered domains. If order truly matters more than throughput, use blocking retry on the partition instead.
- **Poison message loop.** The same message fails, is requeued to the head of the queue, fails again, forever; the partition or queue is blocked. Every consumer has a maximum attempt count and a poison classification; quorum queues get `x-delivery-limit`; RabbitMQ `requeue=true` is banned for failures.
- **DLQ never monitored.** Messages accumulate, retention deletes them, and the loss is discovered by a customer months later. A DLQ alert with an owner, a weekly review, retention of 30 days or more, and a PostgreSQL mirror for searchability.
- **Broker down, producer side.** Direct publishers throw or buffer in memory (kafkajs retries for `retry.retries` then throws; amqplib connection errors). With an outbox, the request succeeds, rows accumulate, and the outbox age alert fires; publishing resumes automatically. Without an outbox, decide explicitly: fail the request (correct for `OrderPlaced`) or drop the event (acceptable for a page-view metric). Never buffer unboundedly in process memory.
- **Broker down, consumer side.** Consumers reconnect with backoff; nothing is lost because the log is durable. Alert on the consumer's connection state so a broker outage is not first noticed as lag.
- **Partition key skew.** One partition takes 40 percent of traffic; its consumer is the bottleneck. Visible as per-partition lag imbalance and one hot consumer pod. Finer key, or composite key with a bounded random suffix for keys that only need per-key order within short windows.
- **Message too large.** Kafka rejects with `MessageSizeTooLarge` (default 1 MB); SQS rejects above 256 KB. The producer sees the error; if it happens in the outbox relay, the row is stuck at the head and blocks the ordered batch. Validate size at outbox insert time, use the claim-check pattern, and let the relay park an oversized row to the DLQ table rather than stall.
- **Retention expiring unprocessed messages.** A consumer down for longer than retention (a forgotten staging consumer, a group that was disabled for a migration) comes back and finds its committed offset no longer exists; `auto.offset.reset` decides whether it jumps to `earliest` or `latest`. Set retention from the recovery time objective, alert on lag that approaches retention, and set the reset policy explicitly rather than accepting the default.
- **Schema change breaking consumers.** A producer renames `priceCents` to `amount`; three consumers start parking every message. DLQ rate alert fires; the trace shows the producer deploy. Roll back the producer, replay the DLQ. Prevent it with a schema registry in backward-compatible mode or contract tests in the producer's CI.
- **Clock skew in `occurredAt`.** Two services with clocks 3 seconds apart produce events whose `occurredAt` order does not match causal order; a consumer that sorts by `occurredAt` applies them backwards. Use the database clock (`clock_timestamp()` at commit) for `occurredAt`, use `causationId` and entity version numbers for ordering decisions, and never compare timestamps across producers for correctness.
- **At-least-once plus non-idempotent side effects.** The double email, the double charge, the double push notification. Every external call carries an idempotency key derived from the message id or the business key (`Idempotency-Key: charge:{orderId}` to the payment provider, a `dedupKey` to the push service). Where the provider offers no idempotency, record the intent in PostgreSQL first (`email_sends(message_id) PRIMARY KEY`) and treat a conflict as "already sent"; accept that a crash between the send and the record is a duplicate you cannot eliminate, only minimize by making the record write fast and immediately after the send.
- **Consumer group id reused by another service.** Two services share offsets; each sees half the messages and both believe they are the only consumer. Group ids are prefixed with the service name and checked in code review.
- **Auto topic creation.** A typo in a topic name creates a new topic with default partitions and replication factor 1, and events go nowhere anyone reads. `allowAutoTopicCreation: false` everywhere; topics come from migrations.
- **Producer acknowledgement lost, no idempotent producer, no consumer dedup.** Silent duplicates at the source that no metric distinguishes from real traffic. Turn on idempotence; dedup in consumers; a reconciliation job comparing event counts with source rows for critical flows.
- **Replay into a live system.** An operator resets offsets to re-run a day; every non-idempotent consumer re-applies a day of effects. Replay only through consumers proven idempotent, with the dedup table retention longer than the replay reach, and with external side effects gated by idempotency keys.

## Senior Checklist — Part 17

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
- [ ] I can say for each message whether it is an event or a command, and whether it belongs on a topic or a queue
- [ ] I choose partition keys for ordering and know what breaks when the partition count changes
- [ ] I commit offsets manually after processing and commit `offset + 1`
- [ ] I can draw the four duplicate paths and explain why no broker setting removes them all
- [ ] Every consumer I ship is idempotent, with the dedup row in the same transaction as the business write
- [ ] Every external side effect from a consumer carries an idempotency key
- [ ] I publish business events through an outbox, never from inside a request handler's transaction
- [ ] I classify errors as transient, permanent or poison and retry only transient ones, with jittered backoff and a maximum attempt count
- [ ] Every consumer has a DLQ with an owner, an alert, retention of 30 days or more, and a replay path
- [ ] I pause consumption when a dependency is down instead of failing messages into the DLQ
- [ ] I configure `acks=all`, `min.insync.replicas=2`, idempotent producers and no auto topic creation for business events
- [ ] I know what Kafka exactly-once covers and I never promise exactly-once across a database and an email provider
- [ ] I set RabbitMQ prefetch, use quorum queues with delivery limits, publish with confirms, and never `requeue=true` on failure
- [ ] I set the SQS visibility timeout above p99 processing and extend it for long work
- [ ] I monitor lag in seconds, DLQ depth, rebalance rate and outbox age, and I propagate trace context through message headers
- [ ] I keep personal data out of messages where possible and can erase it where I cannot
- [ ] I can justify not using a broker at all when one service and one job type is the whole requirement

## Part 17 — Key Takeaways

- Messaging buys decoupling, burst absorption, retry ownership and fan-out; it costs eventual consistency, another system to run, and a permanent duplicate-delivery problem.
- Events are facts on topics with many readers; commands are requests on queues with one handler. Name them that way and the ownership falls out.
- Ordering exists only per key within a partition, queue or message group; retries and parallelism break it, so consumers must tolerate out-of-order arrival with version guards.
- Commit after processing, commit `offset + 1`, and accept at-least-once; auto-commit gives you loss or duplication depending on timing.
- Duplicates arrive through producer retries, consumer crashes before commit, rebalances mid-flight and lease expiry; the only universal defense is an idempotent consumer with the dedup row in the same transaction as the business write.
- Exactly-once is a property of a Kafka-to-Kafka loop with transactions; across a database and an email provider it is effectively-once via idempotency and idempotency keys to providers, or it is a myth.
- Kafka is a retained, partitioned log for streams, replay and high fan-out; RabbitMQ is a router and task queue with native delays and DLX; SQS and SNS are the managed answer when you are on AWS and want no brokers. Pick by what the messages are for.
- The outbox pattern makes the database commit and the publish one decision; publish-after-commit without an outbox still loses events on a crash between them.
- Classify errors: retry transient ones with jittered backoff and a cap, park permanent and poison ones immediately, pause when a dependency is down.
- A DLQ without an alert and an owner is data loss on a delay; retention will delete the evidence.
- Lag in seconds, DLQ depth, rebalance count, outbox age and end-to-end latency with trace propagation are the metrics; a consumer fails silently unless you make it loud.
- Keep messages small and factual with a stable envelope (`id`, `type`, `version`, `occurredAt`, `correlationId`, `causationId`); evolve payloads additively; put blobs in object storage and personal data behind erasable keys.
