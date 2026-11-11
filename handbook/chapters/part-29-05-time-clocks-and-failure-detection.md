## 29.13 Time and clocks

#### Concept

Every machine has a clock, and no two clocks agree. A **wall clock** (`Date.now()`, PostgreSQL `now()`) tells you what time it is according to that machine, and it can be wrong, can be corrected by jumping forwards or backwards, and drifts constantly. A **monotonic clock** (`process.hrtime.bigint()`, `performance.now()`) only ever moves forward and is only meaningful on the machine that produced it. Distributed systems must use each for what it is good for, and must never use wall-clock timestamps from different machines to decide which event happened first.

#### Why does it exist?

Backends use time for everything: token expiry, lock TTLs, "latest record wins", ordering logs, timeouts, scheduling, rate-limit windows, cache expiry. If two machines disagree by 3 seconds, a token issued by one is "not yet valid" on the other, a lock expires early or late, and a record written first appears to have been written last. Clock skew is invisible until it produces an incident, and then it is very hard to see, because the logs you use to investigate carry the same wrong timestamps.

#### Mental model

Asha's watch is two minutes fast; Ben's is one minute slow. Asha writes "order 41 cancelled, 10:02". Ben writes "order 41 baked, 10:01". Reading the notebook later, it looks like the cake was baked before the cancellation, so the cancellation must have arrived too late. In reality Ben baked it two minutes *after* the cancellation, and their watches lied. To know what really happened you need something other than watches: numbered slips ("this is my 17th note, and I had seen your 12th when I wrote it"). That is a logical clock.

#### How it works

**How wrong are clocks?** NTP-synchronized servers in one datacenter typically agree within 1–10 ms. Under load, after a VM pause, on a machine whose NTP daemon is broken, or on a laptop, skew of seconds to minutes is routine. Google's Spanner needs custom atomic clocks and GPS to get a *known* bound of about 7 ms; everyone else has an *unknown* bound. NTP corrects skew by **slewing** (speeding the clock slightly) for small errors and by **stepping** (jumping) for large ones. A step backwards means `Date.now()` returns a smaller value than it did a moment ago.

**Wall clock versus monotonic clock in Node.js:**

```ts
// Measuring a duration: monotonic, immune to NTP steps.
const start = process.hrtime.bigint();
await paymentClient.charge(orderId, amount);
const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

// Recording when something happened for humans and for cross-system comparison: wall clock.
const chargedAt = new Date();   // fine as a label; not fine as an ordering key across machines

// Wrong: a duration from the wall clock can be negative or wildly off after a clock step.
const t0 = Date.now();
await doWork();
const badElapsed = Date.now() - t0;
```

**Why timestamps cannot order events across machines.** Service A on host 1 writes `updated_at = 10:00:00.120`. Service B on host 2 writes the same row with `updated_at = 10:00:00.090` a moment *later*, because host 2's clock is 50 ms behind. A "latest timestamp wins" rule keeps A's value and discards the newer write. The error is silent; there is no exception to catch.

**Logical clocks.** A **Lamport clock** is a counter per node. Before each local event, increment it. When sending a message, include the counter. On receiving, set your counter to `max(own, received) + 1`. If event X caused event Y (same node, or through a message chain), then `clock(X) < clock(Y)`. The reverse is not true: two events with different counters may be concurrent and unrelated. Lamport clocks give you a consistent order to break ties deterministically; they do not tell you what really happened first in wall time.

```text
Order service (counter)      Inventory service (counter)
  create order 8813  -> 1
  send "reserve"     -> 2  ----message(2)---->  receive: max(0,2)+1 = 3
                                                 reserve stock       -> 4
  receive "reserved" <-- message(4) ------------- send "reserved"    -> 5
  set clock = max(2,5)+1 = 6
  mark STOCK_RESERVED -> 7
```

**Vector clocks** keep one counter per node and can tell "concurrent" apart from "before"; they are what version vectors (section 29.9) are built on. **Hybrid logical clocks (HLC)** combine a wall-clock part with a logical counter so that timestamps look like real time, stay close to real time, and still respect causality; CockroachDB and YugabyteDB use them. **Google TrueTime** returns an interval `[earliest, latest]` and Spanner waits out the uncertainty before committing; it is the only mainstream system that orders by wall clock safely, and it needs special hardware.

**Where skew bites a NestJS backend:**

| Feature | What skew does | Defense |
|---|---|---|
| JWT `exp`, `nbf`, `iat` | A token issued by a server 30 s ahead is "not yet valid" on a server that is behind; a token expires "early" on a server ahead | Short skew allowance (`clockTolerance` of 30–60 s); keep NTP healthy; alert on skew |
| Redis lock TTL | Redis expires the key on *its* clock; the client computes "I still have 5 s left" on *its* clock | Never reason about remaining time on the client; renew early; use fencing |
| Lease `expires_at` in PostgreSQL | If the app compares `expires_at` to `Date.now()`, skewed pods disagree about expiry | Compare in SQL with `now()` |
| Cache TTLs | Harmless: expiry happens on the cache's clock | None needed |
| "Latest wins" merges | Newer write discarded | Version numbers, vector clocks, or a single leader |
| Rate limit windows | Pods with skewed clocks put the same second in different windows | Compute the window from the Redis server time (`TIME` command) or use a Lua script on the server |
| Log correlation | Logs from two services appear out of order; investigations chase ghosts | Trace ids and spans (OpenTelemetry) carry causal order; timestamps are decoration |
| Scheduled jobs | A cron on a fast clock fires early and "the 09:00 run" happens twice on two pods | Leader election plus idempotent runs keyed by the scheduled slot |

#### Practical example

Order service and payment service each set `updated_at = now()` from their own database connection, and both databases are the same PostgreSQL primary, so their clocks agree. A reporting service joins these with events from Kafka that carry producer-side `Date.now()` from 40 pods with up to 400 ms of skew between them. Reports show payments "received before the order existed" twice a day. The fix: order events by Kafka offset within a partition (a logical order) and treat the timestamp as a display value.

#### NestJS example

Allowing a small skew when verifying JWTs, and measuring timeouts with the monotonic clock:

```ts
// auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
      // Passed through to jsonwebtoken: tolerate up to 30 s of skew when checking exp and nbf.
      verifyOptions: { clockTolerance: 30 },
    }),
  ],
  exports: [JwtModule],
})
export class AuthModule {}
```

```ts
// deadline.ts: a request-scoped deadline that survives NTP steps.
export class Deadline {
  private readonly endNs: bigint;
  constructor(budgetMs: number) { this.endNs = process.hrtime.bigint() + BigInt(budgetMs) * 1_000_000n; }
  remainingMs(): number { return Math.max(0, Number(this.endNs - process.hrtime.bigint()) / 1_000_000); }
  signal(): AbortSignal { return AbortSignal.timeout(Math.ceil(this.remainingMs())); }
}

// Usage inside a service: give each downstream call whatever budget is left, never more.
const deadline = new Deadline(2_000);
await fetch(inventoryUrl, { signal: deadline.signal() });
await fetch(pricingUrl, { signal: deadline.signal() });
```

#### PostgreSQL example

PostgreSQL has three "now"s, and picking the wrong one causes subtle bugs:

```sql
-- now() and transaction_timestamp(): frozen at the START of the transaction. Every row written in
-- a long transaction gets the same timestamp, which is what you usually want for consistency.
-- statement_timestamp(): start of the current statement.
-- clock_timestamp(): the actual current time, changes within a statement. Use for measuring.
SELECT now(), statement_timestamp(), clock_timestamp();

-- Always timestamptz, never timestamp: 'timestamp without time zone' silently depends on the
-- session's TimeZone and turns into a skew bug across pods in different regions.
CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  response    jsonb,
  expires_at  timestamptz NOT NULL
);

-- Expiry decided by the database clock, the one clock all pods share.
DELETE FROM idempotency_keys WHERE expires_at < now();

-- Ordering events: never by created_at across writers. Use a sequence, which is monotonic
-- within the database regardless of who wrote it.
CREATE TABLE order_events (
  seq        bigserial PRIMARY KEY,
  order_id   uuid NOT NULL,
  type       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT * FROM order_events WHERE order_id = $1 ORDER BY seq;
```

One caution with sequences: `bigserial` values are assigned at insert time, but a transaction that started earlier may commit later, so a row with `seq = 100` can become visible after `seq = 101`. For a strictly gap-free, commit-ordered stream you need the outbox relay techniques in Part 30.

#### Production scenario

A fleet of 200 pods across two regions ran NTP against a public pool through a NAT that occasionally rate-limited them. Measured skew: p50 4 ms, p99 180 ms, max observed 41 s on a pod whose NTP daemon had died. Symptoms before they added skew monitoring: sporadic `jwt not active` errors (0.02% of requests, always from the same few pods), a lock that "expired early" in one region, and analytics with events from the future. They added a node exporter alert on `abs(node_timex_offset_seconds) > 0.1` and a startup check that refuses to serve if the offset is above 1 s.

#### Failure scenario

At 00:00 on a New Year's Eve, a leap second was applied on the hosts as a one-second step backwards, while the cloud provider's NTP servers smeared it over 24 hours. For a few minutes, hosts disagreed by up to a second. A rate limiter computed windows as `Math.floor(Date.now() / 1000)`; requests landed in the "same" second twice; limits were double-counted; 3% of API clients were throttled wrongly for two minutes. The same night a job scheduler fired its 00:00:00 job twice on one pod, because its clock went through midnight twice. Neither was a data-loss incident, both took hours to explain, and both were fixed by moving the window calculation into Redis and by making the job idempotent per scheduled slot.

#### Edge cases & failure modes

- A VM is live-migrated or paused; its clock resumes seconds behind and then steps forward; every timer in the process fires at once.
- A container image ships with no NTP, and the host clock is fine, so nobody notices until the node is replaced by one with a bad clock.
- `setTimeout(fn, 30_000)` in Node uses a monotonic source and is unaffected by steps; `new Date(expiresAt) < new Date()` comparisons are affected.
- JWT `iat` in the future (issuer ahead) is rejected by some libraries unless tolerance is set.
- A database migration converts `timestamp` to `timestamptz` and shifts every historical value by the session offset.
- Two datacenters observe a daylight-saving change differently because one host has the wrong tzdata; logs are an hour apart.

#### How a Senior Backend Engineer thinks about this

They separate three uses of time and use the right clock for each: *durations and timeouts* use the monotonic clock; *labels for humans* use wall clock; *ordering and conflict resolution* use logical order (sequences, offsets, versions, vector clocks) and never wall clock. They put expiry comparisons in the store that owns the data. They monitor clock offset like any other metric, and they design every time-based rule with a tolerance, because the question is never "is the clock right?" but "how wrong can it be before this breaks?"

#### Common mistakes

- Using `Date.now()` differences for timeouts and metrics.
- "Last updated wins" merges based on timestamps from different machines.
- Comparing lease or token expiry using the application clock instead of the store's clock.
- `timestamp without time zone` columns.
- No skew alerting, so the first sign of a broken NTP daemon is an authentication outage.

#### Interview questions

1. *Why can't you use timestamps to order events from two services?* Expected: clocks disagree by unknown amounts; a later event can carry an earlier timestamp. Follow-up: what do you use instead? (Sequences, partition offsets, Lamport or vector clocks, HLC.)
2. *Difference between `Date.now()` and `process.hrtime`, and when to use each?* Expected: wall versus monotonic; durations use monotonic.
3. *A lock in Redis has a 30 s TTL. Can the client know how much time it has left?* Expected: not reliably; only Redis knows; renew early and fence writes.
4. *How would you handle JWT verification failures caused by clock skew?* Expected: `clockTolerance` of tens of seconds, NTP monitoring, short-lived tokens with refresh.
5. *What is a hybrid logical clock and why do distributed databases use it?* Expected: wall-clock-like timestamps that respect causality without special hardware.

#### Practical exercise

On a test VM, use `date -s` to step the clock forward 2 minutes while a NestJS service is running with a Redis lock, a JWT-protected endpoint and a job scheduled with `@Cron`. Then step it back. Acceptance criteria: you can list every behavior that changed (tokens rejected, cron double-fired or skipped, lock renewal errors), you have fixed each with the techniques above, and after the fix the same clock steps produce no incorrect behavior.

## 29.14 Failure detection: deciding that something is dead

#### Concept

**Failure detection** is how one node decides that another node, process or connection is no longer working. In a distributed system it is always a *guess*, because "no reply" can mean dead, slow, partitioned, or paused. The tools are **heartbeats** (periodic "I am alive" messages), **timeouts** (no reply within T means suspect), and smarter detectors such as the **phi accrual** detector that turn heartbeat history into a suspicion level rather than a yes/no.

#### Why does it exist?

Every failover, rebalance and retry starts with a failure detector saying "that one is gone". If the detector is too eager, you get false positives: unnecessary failovers, Kafka consumer group rebalances that stop consumption for seconds, pods restarted while healthy. If it is too patient, you get long outages while a dead leader is still trusted. There is no setting that is right for every case, so the senior job is to understand what each detector is measuring and to pick timeouts on purpose.

#### Mental model

You phone a friend and get no answer. Are they dead, asleep, in a tunnel, or is your phone broken? You cannot know from one unanswered call. If they normally answer within two rings and have not answered in ten minutes, you start to worry. If they are often slow, ten minutes means nothing. Phi accrual is exactly this: "how unusual is the current silence, given how this friend usually behaves?"

#### How it works

1. **Heartbeats.** The monitored side sends a small message every interval `I` (Kafka consumers every 3 s by default; Patroni every `loop_wait`; Kubernetes kubelet posts node status every 10 s).
2. **Timeout.** The monitor declares failure after `T` without a heartbeat (Kafka `session.timeout.ms`, default 45 s in recent clients; Kubernetes marks a node `NotReady` after `node-monitor-grace-period`, 40 s). Rule of thumb: `T >= 3 x I` so a single lost heartbeat does not trigger.
3. **Phi accrual (Cassandra, Akka).** Keep the recent history of inter-arrival times; model their distribution; compute phi = how many "sigmas" late the current heartbeat is. Declare failure when phi crosses a threshold (say 8). The detector adapts to a slow network automatically and reacts fast on a normally quick one.
4. **Action.** Failover, rebalance, remove from load balancer, restart. The action's cost determines how confident you must be; removing a pod from a load balancer is cheap and can be eager, promoting a database replica is expensive and must be conservative and quorum-based (section 29.11).

**False positives you will actually see:**

- **GC pauses.** A Node.js process with a 2 GB heap can pause for 200 ms to a few seconds in a major garbage collection; during that pause it sends no heartbeats and answers no probes. A 1 s timeout declares it dead once a day.
- **Event-loop blocking.** A synchronous `JSON.parse` of a 50 MB body, a `for` loop over a million rows, or `bcrypt` on the main thread blocks the loop; heartbeats sent from the same loop stop.
- **Rebalance storms.** Kafka consumer A pauses for 50 s processing a batch; the broker evicts it; the group rebalances; A returns and rejoins; another rebalance. Consumption stalls for a minute twice.
- **Slow disks and CPU throttling.** A container with a CPU limit that is throttled at the wrong moment misses its liveness probe and gets restarted; on restart it is even slower (cold caches), misses again; CrashLoopBackOff on a healthy program.

**Where you configure detectors in this stack:**

| Component | Heartbeat | Timeout / threshold | Consequence of failure |
|---|---|---|---|
| Kubernetes liveness probe | `periodSeconds` (10) | `failureThreshold` (3) x period, plus `timeoutSeconds` | Container restarted |
| Kubernetes readiness probe | same | same | Pod removed from Service endpoints |
| Kafka consumer (KafkaJS) | `heartbeatInterval` (3 s) | `sessionTimeout` (30 s); `rebalanceTimeout` (60 s) | Partition reassigned; in-flight work duplicated |
| PostgreSQL streaming replication | WAL sender/receiver status | `wal_sender_timeout`, `wal_receiver_timeout` (60 s) | Replication connection dropped and re-established |
| PostgreSQL client connections | TCP keepalives | `tcp_keepalives_idle/interval/count`; `client_connection_check_interval` | Dead client sessions closed, locks released |
| Patroni | DCS lock renewal every `loop_wait` | `ttl` (30 s) | Primary demoted; replica promoted |
| Load balancer health check | HTTP probe every 5–10 s | 2–3 failures | Target removed |

#### Practical example

A NestJS worker consumes `orders.events`, and each message takes up to 20 s (it calls a slow supplier API). With `sessionTimeout: 10_000`, the consumer is kicked out whenever a message runs long, its partitions move to another worker, that worker processes the same message again (duplicate side effects), and the original worker rejoins and causes another rebalance. The fix is not "raise the timeout to 10 minutes" (that makes real crashes take 10 minutes to detect); it is: keep heartbeats flowing independently of processing (KafkaJS does this from `eachMessage` via its own heartbeat interval as long as you `await` inside the handler rather than blocking), bound the per-message work with a timeout, and make the handler idempotent so the occasional duplicate is harmless.

#### NestJS example

The most common false-positive cause in Node is a blocked event loop. Measure it, expose it, and make readiness reflect it:

```ts
// event-loop-health.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { monitorEventLoopDelay, IntervalHistogram } from 'node:perf_hooks';

@Injectable()
export class EventLoopHealth implements OnModuleInit {
  private histogram!: IntervalHistogram;

  onModuleInit() {
    this.histogram = monitorEventLoopDelay({ resolution: 20 }); // sample every 20 ms
    this.histogram.enable();
  }

  // p99 delay over the last window, in ms. A healthy API pod sits under 20 ms.
  p99Ms(): number {
    const p99 = this.histogram.percentile(99) / 1_000_000;
    this.histogram.reset();
    return p99;
  }
}

// health.controller.ts (readiness), extending section 18.3's controller
@Get('ready')
@HealthCheck()
ready() {
  return this.health.check([
    () => this.db.pingCheck('postgres', { timeout: 1_500 }),
    async () => {
      const p99 = this.loop.p99Ms();
      const healthy = p99 < 250;   // if the loop is stalling, stop taking new traffic
      return { eventLoop: { status: healthy ? 'up' : 'down', p99Ms: p99 } };
    },
  ]);
}
```

And the Kafka consumer settings that avoid rebalance storms while still detecting real crashes:

```ts
const consumer = kafka.consumer({
  groupId: 'shipping-service',
  sessionTimeout: 30_000,      // declare dead after 30 s without heartbeats
  heartbeatInterval: 3_000,    // 10 heartbeats per session timeout
  rebalanceTimeout: 60_000,    // time members get to rejoin after a rebalance starts
});
```

#### PostgreSQL example

Detecting dead clients matters because a dead client can hold a lock forever:

```sql
-- Server-side TCP keepalives: probe idle client connections so a vanished pod is noticed
-- in ~1 minute instead of the kernel default of ~2 hours.
ALTER SYSTEM SET tcp_keepalives_idle = 30;
ALTER SYSTEM SET tcp_keepalives_interval = 10;
ALTER SYSTEM SET tcp_keepalives_count = 3;

-- PostgreSQL 14+: check the client socket during long-running queries so a query whose
-- client is gone is cancelled instead of running to completion for nobody.
ALTER SYSTEM SET client_connection_check_interval = '10s';

-- Replication-side detectors.
ALTER SYSTEM SET wal_sender_timeout = '30s';
ALTER SYSTEM SET wal_receiver_timeout = '30s';
SELECT pg_reload_conf();

-- Belt and braces: a transaction idle too long is killed, releasing its locks.
ALTER SYSTEM SET idle_in_transaction_session_timeout = '30s';
```

#### Production scenario

An API fleet of 60 pods with 1.5 GB heaps saw one liveness-probe restart per pod per day, always during a major GC coinciding with a probe. Each restart caused a 20 s blip of errors on that pod. They changed the liveness probe from `periodSeconds: 5, failureThreshold: 1, timeoutSeconds: 1` to `periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 3`, kept readiness eager, and added event-loop lag to readiness. Restarts fell to zero; genuine hangs were still caught within 30 s.

#### Failure scenario

At 14:20 a marketing team uploaded a 60 MB CSV through an admin endpoint that parsed it synchronously. The event loop blocked for 9 s. During those 9 s: the readiness probe failed (good), the liveness probe failed twice (its threshold was 2, so the pod was killed), the Kafka consumer in the same process missed its heartbeats and was evicted, and a rebalance stalled order processing for 40 s across the whole consumer group. One blocking parse turned into a fleet-wide hiccup. Fixes: streaming CSV parsing, liveness threshold raised, consumers moved to a separate deployment from the API.

#### Edge cases & failure modes

- **Asymmetric detection**: A thinks B is dead, B thinks A is fine; B keeps sending work A will never acknowledge.
- **Detector on the wrong side of a partition**: the load balancer in zone A cannot reach zone B pods and removes all of them even though zone B users could reach them fine.
- **Cascading detection**: a slow database makes every pod's readiness fail at once; the load balancer has zero healthy targets; some balancers then send traffic to *all* targets ("fail open"), others to none.
- **Timeouts shorter than the p99 of the thing they watch**: a 1 s probe timeout on an endpoint whose p99 is 1.2 s restarts healthy pods.
- **Heartbeats that succeed while the work does not**: a consumer heartbeats happily while its handler is stuck on a lock; it is "alive" and doing nothing. Watch consumer lag, not just membership.

#### How a Senior Backend Engineer thinks about this

They ask, for each detector: what does a false positive cost, what does a false negative cost, and what is the normal variance of the signal? They set `T` from measured p99s plus margin, never from defaults. They keep readiness eager and liveness patient. They move heavy consumers out of API processes so one blocked loop does not trip several detectors. And they know the detector is a guess, so every action it triggers (failover, rebalance, retry) must be safe when the "dead" node turns out to be alive, which brings back fencing and idempotency.

#### Common mistakes

- Liveness probes that check dependencies.
- Kafka session timeouts far below per-message processing time, or far above any reasonable crash-detection time.
- Health endpoints that do real work (queries, cache warms) and become the thing that is slow.
- Ignoring event-loop lag and GC pauses as a source of "random" restarts.
- Fail-open load balancers nobody knew were fail-open.

#### Interview questions

1. *Why is failure detection in a distributed system always a guess, and what follows from that?* Expected: no reply is ambiguous; every action on detection must be safe if the node is actually alive; fencing and idempotency.
2. *How would you set Kafka consumer timeouts for a handler that takes up to 20 s?* Expected: heartbeats independent of processing, session timeout around 30 s, bounded processing, idempotent handler.
3. *What should a liveness probe check? A readiness probe?* Expected: liveness: process responsive only; readiness: dependencies and event-loop health, bounded timeouts.
4. *Explain the phi accrual failure detector in plain language.* Expected: suspicion level based on how unusual the silence is compared to history; adaptive threshold.

#### Practical exercise

Add event-loop lag measurement to a NestJS service and expose it in readiness. Deliberately block the loop for 2 s and for 20 s from an endpoint. Acceptance criteria: readiness fails within one probe period during both; liveness does not fail during the 2 s block; the Kafka consumer in a separate deployment is unaffected; and a Grafana panel shows event-loop p99 for every pod.
