## 43.6 Health, readiness and build info as observability

### 43.6.1 Health endpoints tell the platform; metrics tell the humans

#### Concept

A **liveness** endpoint answers "is this process alive enough to keep, or should it be restarted". A **readiness** endpoint answers "can this pod take traffic right now". A **build info** metric answers "which exact version is this". All three are observability: the platform reads the first two, humans and dashboards read the third.

#### Why does it exist?

Kubernetes has no idea what your process is doing. It can only see whether the container is running. Liveness lets you tell it "I am deadlocked, restart me"; readiness lets you tell it "I am starting, or my database connection is gone, do not route to me yet". Without readiness, a rolling deploy sends requests to pods that have not finished connecting to PostgreSQL and the deploy itself causes an error spike.

#### How it works

- **Liveness** must be cheap and must not depend on external systems. If liveness checks the database and the database is down, Kubernetes restarts every pod in a loop and the outage gets worse. Liveness answers 200 as long as the event loop is responsive.
- **Readiness** may check dependencies you cannot serve without: the database pool can acquire a connection, Redis answers `PING`, the Kafka consumer has joined its group. It flips to 503 during shutdown so the load balancer drains before the process exits.
- **Startup** probes exist for slow-starting processes so liveness does not kill them during boot.

```ts
// health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator, MemoryHealthIndicator } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  live() {
    // Only in-process checks. Never touch the network here.
    return this.health.check([() => this.memory.checkHeap('heap', 1_500 * 1024 * 1024)]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.db.pingCheck('postgres', { timeout: 1_000 }),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
```

Expose the build in three places so nobody has to guess what is running: the `app_build_info` gauge from 43.3.4, the `version` field on every log line, and `service.version` on every span's resource. During an incident the first question is "what changed", and the second is "which version is this pod". Both should be answerable from the dashboard.

A useful PromQL trick joins any metric with the build info to split it by version during a rollout:

```text
sum by (version) (
  rate(http_requests_total{service="orders-api", status=~"5.."}[5m])
  * on (pod) group_left(version) app_build_info
)
```

If the new version's error rate is higher than the old version's during a canary, that one panel tells you to roll back.

## 43.7 Observability for the database, Redis, Kafka and Kubernetes

### 43.7.1 PostgreSQL

#### Concept

The database is where most latency incidents end up, and it has excellent built-in instrumentation that most teams never turn on. `postgres_exporter` turns catalog views into Prometheus metrics; `pg_stat_statements` records per-query statistics; a handful of views cover replication, locks and vacuum.

#### The dashboard

| Panel | Source | What it tells you |
|---|---|---|
| Connections by state | `pg_stat_activity` | `idle in transaction` climbing means an app is holding transactions open; `active` at `max_connections` means the pool math is wrong |
| Transactions per second, commits vs rollbacks | `pg_stat_database` | Rollback spike is an app error or deadlocks |
| Cache hit ratio | `pg_stat_database` | Below 99 percent on OLTP means the working set does not fit |
| Top queries by total time and by mean time | `pg_stat_statements` | The queries to fix, ranked |
| Replica lag in bytes and seconds | `pg_stat_replication` on the primary, `pg_last_xact_replay_timestamp()` on replicas | Reads from a replica 30 seconds behind explain "I just saved it and it is gone" |
| Locks: waiting sessions | `pg_locks` joined to `pg_stat_activity` where `wait_event_type = 'Lock'` | Lock contention before it becomes a timeout storm |
| Dead tuples and last vacuum per table | `pg_stat_user_tables` | Bloat and the reason a table got slow with no code change |
| Long-running transactions | `pg_stat_activity` with `xact_start` | Anything over 5 minutes blocks vacuum and holds locks |
| Disk and WAL growth | node exporter and `pg_wal` size | A replication slot that fell behind fills the disk |

The two queries a senior engineer runs by hand during an incident:

```sql
-- Who is blocking whom
SELECT blocked.pid AS blocked_pid, blocked.query AS blocked_query,
       blocking.pid AS blocking_pid, blocking.query AS blocking_query,
       now() - blocking.xact_start AS blocking_for
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.wait_event_type = 'Lock';

-- Replica lag as seen from the replica
SELECT now() - pg_last_xact_replay_timestamp() AS replay_lag;
```

### 43.7.2 Redis

`redis_exporter` exposes the fields of `INFO`. The panels that matter: `used_memory` against `maxmemory` (eviction begins at the line), `evicted_keys` rate (your cache is too small or a key leak), `keyspace_hits` versus `keyspace_misses` (hit ratio), `connected_clients` (a leak looks like a slow climb), `blocked_clients`, `instantaneous_ops_per_sec`, and `rdb_last_bgsave_status` plus `aof_last_write_status` (persistence failing silently). From the application side, the `redis_command_duration_seconds` histogram from 43.3.2 is the one that pages: Redis p99 above 5 ms from the app while the server reports sub-millisecond latency means the network or the client pool is the problem. `SLOWLOG GET 10` shows commands over the configured threshold, typically `KEYS *` written by someone who should have used `SCAN`.

### 43.7.3 Kafka

The single metric is **consumer lag per group per partition**: the difference between the partition's latest offset and the group's committed offset. `kafka_exporter` or the broker's own metrics provide it, and kafkajs can report it from the client side. Alert on lag that grows for 10 minutes, not on a fixed number, because a burst can legitimately create lag that drains in a minute. Also watch rebalances per minute (a consumer that crashes in a loop rebalances the whole group and stops everyone), under-replicated partitions (a broker is sick), and request latency at the producer. Put the lag panel on the service dashboard of the consumer, not on a "Kafka" dashboard nobody opens.

### 43.7.4 Kubernetes

`kube-state-metrics` plus `cAdvisor` give the pod-level truth. The panels: restarts per pod (`kube_pod_container_status_restarts_total` rate), last termination reason (`OOMKilled` is the one that matters), CPU throttling (`container_cpu_cfs_throttled_seconds_total`, which explains latency on a pod whose CPU "looks" at 60 percent because it is being throttled against its limit), memory working set against the limit, HPA current versus desired replicas, and pending pods. A pod at 95 percent of its memory limit is a future OOMKilled; a pod being CPU-throttled is a present latency problem with no error anywhere.

## 43.8 Dashboards and on-call

### 43.8.1 What the first screen must answer in 30 seconds

#### Concept

On-call is a reading test under stress. The first screen is not for exploring; it is for deciding what to do next. It should let a tired engineer answer four questions without scrolling:

1. Are customers affected right now? (error ratio versus SLO, p99 versus target)
2. Since when? (the time the lines changed, with deploy annotations)
3. Is it us or a dependency? (process saturation row versus dependency row)
4. Is it getting worse? (the slope of the last 15 minutes)

Everything else, per-route breakdowns, per-pod detail, database internals, lives one click down.

#### Runbook links from alerts

Every alert carries `runbook_url`. The runbook is short: what the alert means, the dashboard to open, the three most likely causes with the query that confirms each, the mitigation for each, and who to escalate to. It is a checklist, not an essay. It is stored next to the code, reviewed in PRs, and updated in the incident retrospective. Part 49 — Site Reliability Engineering covers the runbook format and the incident process; here the rule is simply that no alert ships without one.

#### Incident-style example

At 02:14 the pager fires: `OrdersApiHighErrorBurn`. The runbook link opens the orders overview dashboard with the time range preset to the last hour. Row 1 shows error ratio at 6 percent since 02:09, a deploy annotation at 02:08. Row 2 shows nothing unusual. Row 3 shows `db_pool_connections{state="waiting"}` at 20 on every pod and DB query p99 at 4 seconds for `operation="select_orders"`. The runbook's "pool exhausted after a deploy" branch says: check `pg_stat_statements` for a new slow query, roll back if found. The query is a new `SELECT ... WHERE lower(email) = $1` with no index. Roll back at 02:19, error ratio recovers at 02:21. Total time: seven minutes, no exploring, no guessing. The retrospective adds the missing index and a lint rule for functions on indexed columns.

## 43.9 Cost control

### 43.9.1 Where the money goes and how to keep it

| Lever | Effect | Typical setting |
|---|---|---|
| Log level in production | Largest single lever; DEBUG is 5 to 10 times INFO | `info`; `debug` per request via a header, never globally |
| Request log sampling | Cuts the dominant line type | 100 percent of errors and slow requests, 5 percent of the rest |
| Log retention | Storage cost scales linearly | 7 to 14 days hot, 30 to 90 days cold or archived to object storage |
| Metric cardinality | Prometheus memory and query time | Under 500 series per pod; no unbounded labels; drop unused default metrics with relabeling |
| Scrape interval | Samples per second | 15 s default; 60 s for slow-moving infrastructure |
| Trace head sampling | Spans exported from the app | 10 to 20 percent for high-traffic services; 100 percent for low-traffic |
| Trace tail sampling | Spans stored | All errors and slow traces, 5 percent baseline |
| Trace retention | Object storage | 7 to 30 days |
| Span attribute size | Export bandwidth | No bodies, no full SQL with parameters, truncate at 1 KB |

A useful discipline is a monthly "observability bill review" with one table per service: log GB per day, series count, spans per second, and dollars. The service that produces 40 percent of the log volume with 3 percent of the traffic is always a surprise to its team and always has a debug loop that nobody remembers adding.

## 43.10 Edge cases & failure modes

This section collects the ways observability itself fails. Each one has taken down a real system or hidden a real incident.

- **Logging PII or secrets.** A `console.log(req.body)` on `/login` writes passwords to a log store with 90 day retention and 200 readers. Redact by path in the logger config, scrub in the collector as a second line, and run a regular scan of the log store for patterns like card numbers and JWTs. Under GDPR a leak into logs is a reportable breach.
- **Logs dropping under load.** The agent's buffer fills, and the lines you most need during the incident are the ones that vanish. Monitor the agent's dropped-records metric, size its buffer for a burst of 10 times normal, and alert when it drops anything.
- **Disk full from logs.** A pod logging 500 lines per second of stack traces fills a node's disk in hours; Kubernetes then evicts unrelated pods from that node. Rotation limits (10 MB times 5 files per container by default) cap the damage, but a node with 40 chatty pods still suffers. Rate limit repeated errors at the source.
- **Metric cardinality explosion killing Prometheus.** One service adds `userId` as a label. Within an hour Prometheus has 2 million series, uses 16 GB, and its queries time out; every team's dashboards go blank at once. Enforce a series limit per scrape target (`sample_limit`), review label additions in code review, and alert on `prometheus_tsdb_head_series` growth.
- **Missing trace context across queues, timers and Promise boundaries.** A `setTimeout` scheduled at bootstrap, an `EventEmitter` created in a module constructor, a `p-queue` worker or a `Promise` created in a different request all lose the ALS context, and the logs from that code carry no `requestId` or the wrong one. Use `cls.run` or `context.with` at every boundary, and write a test that asserts the id survives.
- **Sampling hiding the rare failure.** At 1 percent head sampling, an error that occurs 50 times a day is traced once every two days. The incident where "we have no trace of any failing request" is the tail sampling argument in one sentence.
- **Clock skew making spans negative.** A node whose clock is 300 ms ahead produces child spans that end before they start relative to their parent. Traces render strangely and duration math goes wrong. Run chrony on every node and alert on node clock offset from `node_timex_offset_seconds`.
- **Alert storms during incidents.** The database goes down, and 45 alerts fire across 12 services. The on-call cannot find the one that says "database down". Group by cluster, inhibit downstream alerts when an upstream fires, and page once per incident with a summary.
- **Dashboards lying because of averaging.** Average latency 60 ms with p99 at 5 seconds. A fleet-average CPU of 40 percent while one pod is at 100 percent. A 1 hour graph resolution that smooths a 3 minute outage into a small bump. Always show quantiles, per-pod lines and enough resolution to see a deploy.
- **Logging inside hot loops.** A `log.debug` inside a loop that runs 10,000 times per request costs nothing when `debug` is off, if and only if the arguments are cheap. `log.debug({ item: JSON.stringify(item) })` serializes 10,000 objects per request even at `info` level, because the argument is evaluated before the level check. Guard with `if (log.isLevelEnabled('debug'))` or pass the raw object and let pino skip it.
- **The observability agent consuming more CPU than the app.** A Fluent Bit with a regex parser on multi-line stack traces, or a collector doing tail sampling on a node-sized budget, or auto-instrumentation of `fs` producing a span per file read. Measure the agent's CPU next to the app's; budget observability overhead at 5 to 10 percent of the service's CPU and treat more as a bug.
- **Exporters blocking shutdown.** `sdk.shutdown()` flushes to the collector; if the collector is down, the flush waits for its timeout, the pod exceeds its termination grace period, and Kubernetes kills it, losing the buffered spans anyway and delaying the rollout. Bound the flush with `Promise.race` and a 3 second timer.
- **The observability stack in the blast radius.** Prometheus, Loki and Tempo running in the same cluster that is having the outage. When the cluster's network fails, the dashboards fail with it. Run the monitoring stack in a separate cluster or a managed service, and keep a minimal external uptime check that does not depend on anything internal.
- **Health checks that lie.** A readiness endpoint that returns 200 while the Kafka consumer is dead, or a liveness endpoint that checks the database and restarts healthy pods during a database blip. Liveness checks only the process; readiness checks what the pod needs to serve.

### 43.10.1 How a Senior Backend Engineer thinks about this

They treat observability as a product with users (the on-call) and a budget, not as a checkbox. They design it before the first deploy: field names, correlation, metrics naming, alert ownership. They measure the cost of every signal and the overhead of every agent. They run game days where they break something and time how long the dashboards take to point at it; if the answer is more than five minutes, the dashboards change. They know that the most dangerous state is not "no monitoring" but "monitoring that looks fine while customers suffer", so they alert on symptoms, show quantiles, and keep an external check that does not trust anything inside the cluster.

### 43.10.2 Common mistakes

- Building dashboards from whatever metrics exist rather than from the questions the on-call asks.
- Twelve services with twelve different `requestId` field names.
- One giant dashboard with 80 panels that takes 20 seconds to load during an incident.
- Alerts with no owner, no runbook and no `for:` duration.
- Treating the collector, Prometheus and Loki as "not real production" and giving them no memory limits, no dashboards and no on-call.
- Sampling logs of business events that are actually audit records.

### 43.10.3 Interview questions

1. *Design the observability for a new NestJS service that talks to PostgreSQL, Redis and Kafka.* Expected: structured JSON logs to stdout with a shared field set and correlation id via ALS; `/metrics` with RED per route, process metrics, pool and consumer lag gauges, build info; OTel auto-instrumentation exporting to a collector with tail sampling; overview dashboard in five rows; two or three SLO burn-rate alerts with runbooks. Why it matters: shows the candidate can go from zero to observable without gold-plating.
2. *What should a liveness probe check and what must it never check?* Expected: only in-process health; never external dependencies, or a dependency outage becomes a restart storm.
3. *How do you keep a `debug` log line from costing CPU in production?* Expected: cheap arguments, level checks before expensive serialization, no string interpolation.
4. *A dashboard shows everything green but customers report failures. List three reasons.* Expected: averages hiding tails; alerts on causes not symptoms; monitoring inside the blast radius; readiness lying; sampling dropping the failing traces.
5. *How would you find which deploy caused an error spike?* Expected: `app_build_info` joined to error rate by version, deploy annotations, per-version canary panel.
6. *Where does tracing lose context in Node.js and how do you fix it?* Expected: timers, emitters, external Promise chains, queue consumers; `context.with` or `cls.run` at the boundary.

### 43.10.4 Practical exercise

Run a game day against your instrumented service:

1. With the stack from the earlier exercises running, inject four faults one at a time: kill Redis, add a 2 second sleep to one repository method, add a `userId` label to a counter, and set `LOG_LEVEL=debug`.
2. For each fault, time how long it takes to identify the cause using only Grafana, starting from the overview dashboard.
3. Acceptance: Redis down is visible on Row 3 and the correct alert fires within 5 minutes; the 2 second sleep is found through an exemplar to a trace showing the gap in under 3 minutes; the `userId` label is caught by a series-count alert before it reaches 10,000 series; the debug level is visible as a 5x jump on a log-volume panel and a `ticket` severity alert fires within 15 minutes.

## Senior Checklist — Part 43

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
- [ ] Every log line in my services is JSON with `time`, `level`, `msg`, `service`, `env`, `version`, `requestId`, `traceId`, and business ids, and never contains PII or secrets
- [ ] I can propagate a correlation id from an inbound request through HTTP calls and Kafka messages into a worker and prove it with a test
- [ ] I can expose RED metrics per route, process metrics, pool and lag gauges and `app_build_info` from NestJS and keep cardinality bounded
- [ ] I can write the PromQL for request rate, error ratio and p99 from a histogram, and a recording rule for each
- [ ] I can write a multi-window burn-rate alert from an SLO and explain why it beats a fixed threshold
- [ ] I can set up OpenTelemetry in NestJS before bootstrap, add manual spans with attributes and exceptions, and read a trace to find the slow span or the gap
- [ ] I can configure an OTel Collector pipeline with memory limiting, tail sampling and attribute scrubbing
- [ ] I can explain the difference between correlation id, trace id and span id and where each lives
- [ ] I can build the five-row service overview dashboard and say what the first screen answers in 30 seconds
- [ ] I can list the PostgreSQL, Redis, Kafka and Kubernetes panels that belong on a service dashboard
- [ ] I can estimate the monthly cost of a service's logs, metrics and traces and name the levers that reduce it
- [ ] I know where AsyncLocalStorage context is lost in Node.js and how to restore it

## Part 43 — Key Takeaways

- Monitoring answers questions you planned; observability answers questions you did not. You need both, and the second needs structured, correlated data.
- Logs are for detail, metrics are for counting and alerting, traces are for "where did the time go". Their value comes from being linked by trace id and exemplars.
- Structured JSON logs with a shared field set are a company-wide contract; `msg` is constant, variables are fields, PII and secrets never appear.
- A correlation id lives in AsyncLocalStorage, on every log line, in every outbound header and every Kafka message header, and in a fresh context per consumed message.
- Write logs to stdout asynchronously; let a node agent ship them. Your logger must never be able to slow your API.
- Histograms over summaries, route templates over raw paths, and never a user id as a label. Cardinality is what kills Prometheus.
- The event loop lag metric explains the latency that no dependency explains.
- Alert on symptoms and SLO burn rates with runbooks and owners; put causes on dashboards. An alert with nothing to do is a bug.
- Start the OpenTelemetry SDK before Nest bootstraps, auto-instrument dependencies, add manual spans at business boundaries, and export through a collector with tail sampling that keeps every error.
- Dashboards show quantiles, per-pod lines and deploy annotations; averages lie.
- The observability stack is production: give it limits, dashboards, an on-call, and a home outside the blast radius.
- Budget observability like any resource: sample successes, keep failures, bound cardinality, tail-sample traces, and review the bill monthly.
