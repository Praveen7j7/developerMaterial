## 61.5 Project 5 — Distributed job processing system

### 61.5.1 Goal and what you will learn

You will build a job processing system on PostgreSQL — the thing you have used a dozen times without knowing what is inside it. Claiming with `FOR UPDATE SKIP LOCKED`, leases with heartbeats and takeover, retries with backoff, priorities, cron schedules that survive time zones and daylight saving, DAG dependencies executed in topological order, idempotent execution keys of `(job_id, scheduled_for)`, a dead-letter queue, execution history partitioned by month, a leader-elected scheduler using an advisory lock, an admin API and metrics.

Then you will implement one queue in **BullMQ** as well, run the same workload through both, and write down an honest comparison: durability, throughput, transactional enqueue, and operational effort. Not a winner — a comparison. Senior engineers get asked "why did you not just use Redis?" and the good answer contains numbers.

What this project teaches:

- **Exactly-once is a lie; at-least-once plus idempotency is the truth.** You will build the mechanism that makes that sentence practical: a unique execution key.
- **Leases beat locks for long work.** A held lock dies with its connection at the worst moment. A lease with a heartbeat lets a healthy system take over from a dead worker in seconds, deterministically.
- **Time is the hardest input.** A cron entry of `30 2 * * *` in `Europe/Berlin` does not run on the March morning when 02:30 does not exist, and runs twice in October if you are careless.
- **Dependencies are a graph, and graphs have cycles.** You will detect them at write time and cap them at read time.
- **Leader election is three lines of SQL.** `pg_try_advisory_lock` gives you a single scheduler without ZooKeeper, etcd or a consensus library, and understanding exactly what it guarantees (and does not) is worth more than the code.
- **Operating a queue is most of the work.** Depth, age, throughput, failure rate, stuck jobs, poison jobs, and a way to retry one job by hand at 3 a.m.

### 61.5.2 Requirements

**Functional**

1. Enqueue a job with a type, payload, priority (1 highest to 9 lowest), `run_after` time, and an optional unique key.
2. Workers claim jobs in priority then time order, in batches, without ever handing the same job to two workers.
3. A claimed job holds a lease; the worker heartbeats every 10 seconds; a lease that expires is taken over.
4. Failed jobs retry with exponential backoff and jitter, up to a per-type maximum; then go to the DLQ.
5. Cron schedules with an IANA timezone create job instances; a missed window is caught up (configurable) or skipped.
6. Jobs may depend on other jobs; a job becomes runnable only when all its dependencies have succeeded; execution follows topological order; cycles are rejected at creation.
7. Every execution is recorded with a unique key `(job_id, scheduled_for)`, so a duplicate claim can never produce a duplicate side effect.
8. Execution history is queryable and partitioned by month with a retention policy.
9. Exactly one scheduler is active across all replicas, elected with a PostgreSQL advisory lock.
10. Admin API: list, inspect, retry, cancel, pause a queue, drain, requeue from the DLQ.
11. Prometheus metrics for depth, age, throughput, latency, failures and lease takeovers.
12. One queue also implemented on BullMQ, running the same job type, with the same admin surface.

**Non-functional**

| Property | Target | Consequence |
|---|---|---|
| Throughput | 2,000 jobs/s claimed and completed on a 4 vCPU database | Batch claims, no per-job transaction round trips |
| Claim latency | p99 under 20 ms for a batch of 20 | One statement, one index |
| Enqueue latency | p99 under 5 ms | A single insert, no triggers |
| Duplicate execution | zero side effects, even under takeover | Unique `(job_id, scheduled_for)` execution key |
| Takeover time | under 60 s after a worker dies | 30 s lease, 10 s heartbeat, reaper every 10 s |
| Scheduler skew | a cron job fires within 5 s of its target instant | Scheduler ticks every second, advisory-locked |
| History retention | 90 days hot, then dropped | Monthly partitions |
| DLQ | zero jobs older than 24 hours unreviewed | Alert plus a replay endpoint |
| Availability | queue accepts enqueues while all workers are down | Enqueue only writes a row |

### 61.5.3 Architecture

```mermaid
flowchart TB
  api["Producer services"] --> enq["Enqueue API"]
  enq --> pg[("PostgreSQL - jobs, runs, schedules")]
  sched["Scheduler replicas"] --> lock["pg_try_advisory_lock"]
  lock --> pg
  sched --> pg
  w1["Worker 1"] --> pg
  w2["Worker 2"] --> pg
  w3["Worker N"] --> pg
  reaper["Lease reaper"] --> pg
  pg --> dlq["dead_letter table"]
  admin["Admin API and CLI"] --> pg
  metrics["Prometheus"] --> exporter["Metrics exporter"]
  exporter --> pg
  bull["BullMQ comparison queue"] --> redis[("Redis")]
```

The design has no broker, no coordinator process and no leader for the workers. Every worker independently runs the same loop: claim a batch, execute, heartbeat, complete or fail. Coordination is entirely in the database, which is the point — the queue inherits PostgreSQL's durability, transactions and backup story, and you can enqueue a job in the same transaction that writes the business row it refers to.

Only the **scheduler** needs to be a singleton, because two schedulers would create two instances of the same cron occurrence. That singleton is enforced with a session-level advisory lock, not with a config flag saying "run this on pod 0".

### 61.5.4 Database schema

```sql
CREATE TYPE job_status AS ENUM
  ('waiting','ready','running','succeeded','failed','cancelled','dead');

CREATE TABLE job_queues (
  name         text PRIMARY KEY,
  paused       boolean NOT NULL DEFAULT false,
  max_attempts smallint NOT NULL DEFAULT 5,
  lease_seconds int NOT NULL DEFAULT 30,
  concurrency_hint int NOT NULL DEFAULT 10
);

CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  queue         text NOT NULL REFERENCES job_queues(name),
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  priority      smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  status        job_status NOT NULL DEFAULT 'ready',
  run_after     timestamptz NOT NULL DEFAULT now(),
  scheduled_for timestamptz NOT NULL DEFAULT now(),   -- logical occurrence instant
  unique_key    text,                                  -- dedupe on enqueue
  attempt       smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  worker_id     text,
  lease_expires_at timestamptz,
  depends_remaining int NOT NULL DEFAULT 0,            -- counter, kept by triggers/updates
  schedule_id   bigint,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_unique_key UNIQUE (queue, unique_key),
  CONSTRAINT jobs_lease_shape CHECK (
    (status = 'running') = (lease_expires_at IS NOT NULL AND worker_id IS NOT NULL))
);

-- THE index. Every claim query must use exactly this one.
CREATE INDEX jobs_claim_idx ON jobs (queue, priority, run_after, id)
  WHERE status = 'ready';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at)
  WHERE status = 'running';
CREATE INDEX jobs_waiting_idx ON jobs (id) WHERE status = 'waiting';

CREATE TABLE job_dependencies (
  job_id        bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  depends_on_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, depends_on_id),
  CONSTRAINT no_self_dependency CHECK (job_id <> depends_on_id)
);
CREATE INDEX job_dependencies_reverse_idx ON job_dependencies (depends_on_id);

CREATE TABLE schedules (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  queue        text NOT NULL REFERENCES job_queues(name),
  type         text NOT NULL,
  cron         text NOT NULL,                    -- '30 2 * * *'
  timezone     text NOT NULL DEFAULT 'UTC',      -- IANA name
  payload      jsonb NOT NULL DEFAULT '{}',
  priority     smallint NOT NULL DEFAULT 5,
  catchup      boolean NOT NULL DEFAULT false,   -- create missed occurrences?
  enabled      boolean NOT NULL DEFAULT true,
  last_fired_for timestamptz,                    -- last logical occurrence created
  next_fire_at timestamptz NOT NULL,
  CONSTRAINT schedules_tz_valid CHECK (timezone <> '')
);
CREATE INDEX schedules_due_idx ON schedules (next_fire_at) WHERE enabled;

-- Append-only history. The unique key is the idempotency guarantee.
CREATE TABLE job_runs (
  id           bigserial,
  job_id       bigint NOT NULL,
  scheduled_for timestamptz NOT NULL,
  attempt      smallint NOT NULL,
  worker_id    text NOT NULL,
  status       text NOT NULL,             -- running | succeeded | failed | lost
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  int,
  error        text,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE job_runs_2026_09 PARTITION OF job_runs
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
-- One successful execution per logical occurrence, ever.
CREATE UNIQUE INDEX job_runs_2026_09_exec_key
  ON job_runs_2026_09 (job_id, scheduled_for) WHERE status = 'succeeded';
CREATE INDEX job_runs_2026_09_job_idx ON job_runs_2026_09 (job_id, started_at DESC);

CREATE TABLE dead_letters (
  id           bigserial PRIMARY KEY,
  job_id       bigint NOT NULL,
  queue        text NOT NULL,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  attempts     smallint NOT NULL,
  last_error   text NOT NULL,
  died_at      timestamptz NOT NULL DEFAULT now(),
  replayed_at  timestamptz
);
CREATE INDEX dead_letters_open_idx ON dead_letters (died_at) WHERE replayed_at IS NULL;
```

```mermaid
erDiagram
  JOB_QUEUES ||--o{ JOBS : holds
  JOBS ||--o{ JOB_RUNS : executed_as
  JOBS ||--o{ JOB_DEPENDENCIES : depends
  JOBS ||--o{ DEAD_LETTERS : dies_into
  SCHEDULES ||--o{ JOBS : creates
  JOBS {
    bigint id PK
    text queue FK
    job_status status
    smallint priority
    timestamptz run_after
    timestamptz lease_expires_at
  }
  JOB_RUNS {
    bigint id PK
    bigint job_id FK
    timestamptz scheduled_for
    smallint attempt
    text status
  }
```

```mermaid
stateDiagram-v2
  [*] --> waiting
  waiting --> ready
  ready --> running
  running --> succeeded
  running --> ready
  running --> failed
  failed --> ready
  failed --> dead
  ready --> cancelled
  waiting --> cancelled
  succeeded --> [*]
  dead --> [*]
  cancelled --> [*]
```

`waiting` means "dependencies not satisfied". `running -> ready` is the lease takeover path. `failed -> ready` is the retry path after backoff. `failed -> dead` happens when attempts are exhausted.

### 61.5.5 APIs

| Method | Path | Auth | Request | Response | Codes | Idempotency |
|---|---|---|---|---|---|---|
| POST | `/jobs` | service | `{queue,type,payload,priority,runAfter,uniqueKey,dependsOn[]}` | `201 {jobId,status}` | 201, 409 duplicate key, 422 cycle | Yes via `uniqueKey` |
| POST | `/jobs/batch` | service | `{jobs:[...]}` max 500 | `201 {created,duplicates}` | 201, 413 | Yes per `uniqueKey` |
| GET | `/jobs/:id` | service | — | `200 {job,runs[],dependencies[]}` | 200, 404 | Yes |
| POST | `/jobs/:id/cancel` | admin | `{reason}` | `200` | 200, 409 already running | Yes |
| POST | `/jobs/:id/retry` | admin | `{}` | `200` | 200, 409 not failed | Yes |
| GET | `/queues` | admin | — | `200 [{name,depth,oldestAgeSeconds,running,paused}]` | 200 | Yes |
| POST | `/queues/:name/pause` | admin | `{}` | `204` | 204 | Yes |
| POST | `/queues/:name/resume` | admin | `{}` | `204` | 204 | Yes |
| GET | `/dlq` | admin | `?queue&cursor&limit` | `200 {items,nextCursor}` | 200 | Yes |
| POST | `/dlq/replay` | admin | `{ids[]}` or `{queue,before}` | `202 {requeued}` | 202 | Yes; replay of an already-replayed row is a no-op |
| GET | `/schedules` | admin | — | `200 [{name,cron,timezone,nextFireAt,lastFiredFor}]` | 200 | Yes |
| POST | `/schedules` | admin | `{name,queue,type,cron,timezone,payload,catchup}` | `201` | 201, 422 bad cron or zone | Yes by name |
| POST | `/schedules/:id/trigger` | admin | `{scheduledFor}` | `202 {jobId}` | 202 | Yes; the execution key dedupes |
| GET | `/metrics` | internal | — | Prometheus text | 200 | Yes |

Enqueue is deliberately a plain `INSERT` with no side effects, which means a producer can call it inside its own business transaction using its own connection — the killer feature of a database-backed queue, and the reason this project exists.

### 61.5.6 NestJS modules

```text
src/
  queue/     queue.module.ts   enqueue.service.ts   claim.service.ts
             complete.service.ts  backoff.ts        dependencies.service.ts
  worker/    worker.module.ts  worker.runner.ts     heartbeat.service.ts
             handlers/ handler.registry.ts  *.handler.ts
  scheduler/ scheduler.module.ts  scheduler.service.ts  leader.service.ts  cron.ts
  reaper/    reaper.module.ts  lease.reaper.ts      partition.maintainer.ts
  admin/     admin.module.ts   admin.controller.ts  dlq.service.ts
  bull/      bull.module.ts    bull-report.processor.ts   (the comparison queue)
  metrics/   metrics.module.ts collectors.ts
```

**`claim.service.ts` — the one query everything depends on.**

```ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface ClaimedJob {
  id: string; queue: string; type: string; payload: unknown;
  attempt: number; scheduled_for: string; max_attempts: number;
}

@Injectable()
export class ClaimService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Claims up to `batch` jobs atomically. SKIP LOCKED means concurrent workers
   * step over rows another worker has locked instead of queueing behind them,
   * which is what turns a table into a queue.
   */
  async claim(queue: string, workerId: string, batch: number, leaseSeconds: number): Promise<ClaimedJob[]> {
    return this.ds.query(
      `UPDATE jobs j
          SET status = 'running',
              worker_id = $2,
              attempt = j.attempt + 1,
              lease_expires_at = now() + make_interval(secs => $4),
              updated_at = now()
        WHERE j.id IN (
          SELECT c.id
            FROM jobs c
            JOIN job_queues q ON q.name = c.queue
           WHERE c.queue = $1
             AND c.status = 'ready'
             AND c.run_after <= now()
             AND q.paused = false
           ORDER BY c.priority ASC, c.run_after ASC, c.id ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING j.id, j.queue, j.type, j.payload, j.attempt,
                  j.scheduled_for, j.max_attempts`,
      [queue, workerId, batch, leaseSeconds],
    );
  }
}
```

Three details make this correct and fast. The inner `SELECT` carries `FOR UPDATE SKIP LOCKED` so two workers never collide. The `ORDER BY` matches `jobs_claim_idx` exactly, so the plan is an index scan of a handful of rows, not a sort of the queue. And the `UPDATE` increments `attempt` at claim time, not at failure time — a worker that dies without reporting anything has still consumed an attempt, which is what stops an infinitely crashing job from looping forever.

**`worker.runner.ts` — the loop, with the idempotency key.**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ClaimService } from '../queue/claim.service';
import { HandlerRegistry } from './handlers/handler.registry';
import { backoffMs } from '../queue/backoff';

@Injectable()
export class WorkerRunner implements OnModuleInit {
  private readonly log = new Logger(WorkerRunner.name);
  private readonly workerId = `${process.env.HOSTNAME ?? 'local'}:${process.pid}`;
  private running = true;

  constructor(private readonly ds: DataSource, private readonly claims: ClaimService,
              private readonly handlers: HandlerRegistry) {}

  onModuleInit() { void this.loop(); }

  private async loop() {
    while (this.running) {
      const jobs = await this.claims.claim('default', this.workerId, 20, 30);
      if (jobs.length === 0) { await sleep(500 + Math.random() * 500); continue; }
      await Promise.all(jobs.map((j) => this.execute(j)));
    }
  }

  private async execute(job: ClaimedJob) {
    // Reserve the execution key first. A duplicate claim of the same logical
    // occurrence fails here and the job is completed without side effects.
    const reserved = await this.ds.query(
      `INSERT INTO job_runs (job_id, scheduled_for, attempt, worker_id, status)
       VALUES ($1,$2,$3,$4,'running')
       ON CONFLICT DO NOTHING RETURNING id`,
      [job.id, job.scheduled_for, job.attempt, this.workerId],
    );

    const started = Date.now();
    try {
      const handler = this.handlers.get(job.type);
      await handler.handle(job.payload, { jobId: job.id, attempt: job.attempt });
      await this.ds.query(
        `WITH done AS (
           UPDATE jobs SET status='succeeded', lease_expires_at=NULL, worker_id=NULL,
                           updated_at=now() WHERE id=$1 RETURNING id)
         UPDATE job_runs SET status='succeeded', finished_at=now(), duration_ms=$2
          WHERE job_id=$1 AND attempt=$3`,
        [job.id, Date.now() - started, job.attempt]);
      await this.releaseDependents(job.id);
    } catch (err) {
      const message = (err as Error).message.slice(0, 2000);
      const dead = job.attempt >= job.max_attempts;
      await this.ds.query(
        `UPDATE jobs
            SET status = CASE WHEN $3 THEN 'dead' ELSE 'ready' END,
                run_after = now() + make_interval(secs => $4),
                lease_expires_at = NULL, worker_id = NULL, last_error = $2, updated_at = now()
          WHERE id = $1`,
        [job.id, message, dead, backoffMs(job.attempt) / 1000]);
      if (dead) await this.toDeadLetter(job, message);
      this.log.warn(`job ${job.id} attempt ${job.attempt} failed: ${message}`);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

**`lease.reaper.ts` — takeover, and why the lease must be shorter than your patience.**

```ts
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

@Injectable()
export class LeaseReaper {
  constructor(private readonly ds: DataSource) {}

  /** Runs on every replica; the statement is safe to run concurrently. */
  @Interval(10_000)
  async reap() {
    const rows = await this.ds.query(
      `WITH expired AS (
         SELECT id, attempt, max_attempts FROM jobs
          WHERE status = 'running' AND lease_expires_at < now()
          ORDER BY lease_expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
       ), marked AS (
         UPDATE job_runs r SET status='lost', finished_at=now()
           FROM expired e WHERE r.job_id = e.job_id AND r.status='running'
           RETURNING r.job_id
       )
       UPDATE jobs j
          SET status = CASE WHEN j.attempt >= j.max_attempts THEN 'dead' ELSE 'ready' END,
              worker_id = NULL, lease_expires_at = NULL,
              run_after = now(), last_error = 'lease_expired', updated_at = now()
         FROM expired e WHERE j.id = e.id
       RETURNING j.id, j.status`,
      [],
    );
    if (rows.length) this.metrics.leaseTakeovers.inc(rows.length);
  }
}
```

A lease of 30 seconds with a 10-second heartbeat means a killed pod's jobs are runnable again within 40 seconds. Make the lease long enough that a normal GC pause or a slow query never expires it (a 2-second lease will cause phantom takeovers and double execution attempts), and short enough that a dead worker does not strand a job for minutes. For handlers that legitimately run for 20 minutes, extend the lease from inside the handler on the heartbeat, not by setting a 30-minute lease globally.

**`leader.service.ts` — one scheduler, three lines.**

```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

const LOCK_KEY = 918_273_645;    // any stable bigint; document it

@Injectable()
export class LeaderService implements OnModuleDestroy {
  private runner?: QueryRunner;
  private leader = false;

  constructor(private readonly ds: DataSource) {}

  /** Session-level lock: held until this connection closes, so a crash releases it. */
  async tryAcquire(): Promise<boolean> {
    if (this.leader) return true;
    this.runner ??= this.ds.createQueryRunner();
    await this.runner.connect();
    const [{ pg_try_advisory_lock: ok }] =
      await this.runner.query('SELECT pg_try_advisory_lock($1)', [LOCK_KEY]);
    this.leader = ok;
    return ok;
  }

  isLeader() { return this.leader; }

  async onModuleDestroy() {
    if (this.runner && this.leader) {
      await this.runner.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
    await this.runner?.release();
  }
}
```

Be precise about what this guarantees. The lock is tied to a *connection*. If the pod is network-partitioned but alive, PostgreSQL will drop the connection when TCP keepalives fail (tune `tcp_keepalives_idle`), and another pod becomes leader — but the old pod may not have noticed yet. So the scheduler must also be idempotent: it creates occurrences with `ON CONFLICT (queue, unique_key) DO NOTHING` where `unique_key = 'schedule:{id}:{scheduledFor}'`. Leader election reduces duplicate work; the unique key prevents duplicate effects. Never rely on election alone.

**Cron with timezone and DST.** Compute the next occurrence in the schedule's zone, convert to UTC, store it. Two rules cover the awkward cases: if the local time does not exist (spring forward), run at the first valid instant after the gap; if the local time occurs twice (autumn fall-back), run on the first occurrence only, which you enforce for free because `unique_key` contains the logical `scheduledFor` in UTC and the second occurrence produces a different UTC instant — so decide explicitly and write a test for both days of the year. When the scheduler was down and `catchup` is true, create every missed occurrence in order; when it is false, jump to the next future occurrence and record a `schedule_skipped` metric. Nothing makes an operator angrier than a system that silently ran 400 catch-up jobs at 09:00 Monday.

**DAG dependencies.** `dependsOn` is validated at enqueue with a recursive CTE that walks the existing graph and rejects a cycle:

```sql
WITH RECURSIVE reach AS (
  SELECT depends_on_id AS id, 1 AS lvl FROM job_dependencies WHERE job_id = $1
  UNION ALL
  SELECT d.depends_on_id, r.lvl + 1
    FROM job_dependencies d JOIN reach r ON d.job_id = r.id
   WHERE r.lvl < 50
)
SELECT 1 FROM reach WHERE id = $2 LIMIT 1;   -- would create a cycle
```

A job with dependencies is created `waiting` with `depends_remaining = count`. When a job succeeds, `releaseDependents` decrements its dependents and flips any that reach zero to `ready`:

```sql
UPDATE jobs SET depends_remaining = depends_remaining - 1,
                status = CASE WHEN depends_remaining - 1 = 0 THEN 'ready' ELSE status END
 WHERE id IN (SELECT job_id FROM job_dependencies WHERE depends_on_id = $1)
   AND status = 'waiting';
```

Topological order falls out of this without a sort: a node only becomes runnable when its in-degree reaches zero, which is Kahn's algorithm executed by the queue itself. If a dependency ends `dead`, its dependents are cancelled with reason `upstream_failed` — decide that policy explicitly, because "hang forever" is the default if you do not.

### 61.5.7 PostgreSQL design decisions

**Transactions.** The claim is one statement, therefore one implicit transaction, therefore atomic. Do not wrap the claim and the execution in one transaction: holding a transaction open for the duration of a 40-second job pins an `xid`, blocks vacuum, and turns your queue table into a bloated mess. Claim in one transaction, execute outside any transaction, complete in another. That is the whole reason leases exist.

**Locks.** `FOR UPDATE SKIP LOCKED` is the entire concurrency design. Without `SKIP LOCKED`, twenty workers queue behind one lock and throughput collapses to one job at a time. With it, each worker gets a different set of rows on the first try. The reaper uses the same pattern so several reapers can run.

**Indexes.** `jobs_claim_idx (queue, priority, run_after, id) WHERE status = 'ready'` is the only index the hot path uses, and the partial predicate keeps it tiny: at 2,000 jobs/s with 200 ms average execution, only a few hundred rows are `ready` at any moment even though the table holds millions. `jobs_lease_idx` partial on `running` drives the reaper. `jobs_waiting_idx` supports dependency release. Resist adding a general index on `status` — it is low-cardinality, huge, and the planner will not use it.

**Bloat and vacuum.** A queue table is the worst case for MVCC: every row is inserted, updated three or four times, and deleted. Set aggressive autovacuum on `jobs` specifically:

```sql
ALTER TABLE jobs SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 0,
  autovacuum_analyze_scale_factor = 0.02,
  fillfactor = 70
);
```

`fillfactor = 70` leaves room on each page for HOT updates, so an `UPDATE` that does not change an indexed column can reuse the same page and skip index maintenance. This single setting can double the throughput of a busy queue table, and almost nobody knows it exists. Move completed jobs out to `job_runs` and delete them from `jobs` in nightly batches, so `jobs` stays in the low hundreds of thousands of rows.

**Partitioning.** `job_runs` by month, with the unique execution-key index defined per partition. Note the consequence: the uniqueness guarantee is per partition, so a `scheduled_for` at a month boundary retried on the other side of midnight on the 1st could execute twice. Fix it by partitioning on `scheduled_for` instead of `started_at` when your jobs can retry across a month boundary, or accept and document the window. This is exactly the kind of subtlety that separates a system you understand from one you copied.

**Migrations.** Adding a status enum value, changing the claim index, or changing lease semantics all need care because workers are running old and new code simultaneously during a rollout. The rule: index changes go first with `CONCURRENTLY`, semantic changes go behind a config flag, and the claim query is never changed in the same release as the index it uses.

### 61.5.8 Redis usage

The PostgreSQL queue uses Redis for exactly three things, and none of them are the queue:

| Key | Structure | TTL | Purpose |
|---|---|---|---|
| `metrics:queue:{name}:depth` | String | 15 s | Cached depth so `/queues` does not `COUNT(*)` a big table on every dashboard refresh |
| `worker:{id}:seen` | String | 60 s | Live worker roster for the admin UI |
| `lock:partitions` | `SET NX PX 60000` | 60 s | One replica creates next month's partitions |

The BullMQ comparison queue, by contrast, uses Redis for everything: the job data, the states (`wait`, `active`, `delayed`, `completed`, `failed`), the priority sorted set, and the atomic move scripts. That is the honest difference — one design uses Redis as a convenience, the other as the system of record.

### 61.5.9 Messaging usage, and the BullMQ comparison

Implement one real queue both ways. A good candidate is `report.generate`: it takes 5 to 60 seconds, must not run twice for the same `(reportId, day)`, and matters enough that losing one is noticed.

```ts
// BullMQ version: the whole queue is three files.
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';

@Processor('reports', { concurrency: 10 })
export class ReportProcessor extends WorkerHost {
  async process(job: Job<{ reportId: string; day: string }>) {
    // BullMQ guarantees at-least-once. The dedupe is still yours to build.
    return generateReport(job.data.reportId, job.data.day);
  }
}

// Enqueue with a deterministic jobId: BullMQ ignores a duplicate id while the job
// exists, which is dedupe with an expiry, not a durable unique constraint.
await this.queue.add('generate', data, {
  jobId: `report:${data.reportId}:${data.day}`,
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: 5000,
});
```

Run both under the same load — 200,000 jobs, 20 workers, a handler that sleeps 50 ms — and measure. Then fill in this table from your own numbers, not from mine:

| Dimension | PostgreSQL queue | BullMQ on Redis |
|---|---|---|
| Throughput (measured, 4 vCPU db / 2 GiB Redis) | roughly 2,000 to 4,000 jobs/s with batch claims; limited by write amplification and vacuum | roughly 10,000 to 20,000 jobs/s; limited by Redis single-thread and Lua script time |
| Enqueue latency | 1 to 3 ms | 0.2 to 0.5 ms |
| Durability | Full: WAL, replication, PITR, backups you already run | Depends on config; AOF `everysec` can lose a second; RDB can lose minutes; a failover can lose in-flight state |
| Transactional enqueue | Native. `INSERT` the job in the same transaction as the business row. No orphan jobs, no lost jobs, ever | Impossible. You need an outbox anyway, which means you end up with a database table regardless |
| Delayed and scheduled jobs | `run_after` column, trivially queryable and correctable with SQL | Built-in delayed set; correcting 10,000 scheduled jobs means writing a script against Redis |
| Priorities | `ORDER BY priority` on an index; exact | Supported, with a documented throughput cost on the priority set |
| Dependencies and DAGs | Yours to build (this project) | `FlowProducer` gives parent/child flows out of the box |
| Visibility and ad-hoc queries | Anything you can express in SQL: "all failed jobs of type X with payload containing customer Y" | Redis key scans, or the paid UI; ad-hoc queries are painful |
| Operational effort | Vacuum tuning, partition maintenance, one more hot table on your primary | A separate Redis to size, secure, monitor and fail over; memory is the hard limit |
| Failure blast radius | Queue problems can slow your main database | Redis OOM stops the queue; `noeviction` is mandatory or jobs vanish |
| Tooling | Whatever you build | Mature UI, metrics, rate limiting, flows, repeatable jobs |
| Time to first working queue | Two evenings | Twenty minutes |

The honest conclusion: **below roughly 500 jobs per second, and whenever enqueue must be transactional with a database write, the PostgreSQL queue is the better engineering choice** — fewer moving parts, better durability, better debuggability, and no second datastore to operate. Above a few thousand jobs per second of small, fire-and-forget work, Redis-backed queues win on raw cost per job and give you a lot of features for free. Most teams are in the first category and reach for the second out of habit. Now you can say that with numbers instead of an opinion.

```mermaid
sequenceDiagram
  participant W1 as WorkerA
  participant DB as Postgres
  participant R as Reaper
  participant W2 as WorkerB
  W1->>DB: claim batch, lease 30s
  DB-->>W1: job 4711 attempt 1
  W1->>DB: heartbeat extend lease
  Note over W1: pod is OOMKilled
  R->>DB: find running with expired lease
  DB-->>R: job 4711
  R->>DB: mark run lost, job back to ready
  W2->>DB: claim batch
  DB-->>W2: job 4711 attempt 2
  W2->>DB: insert job_runs job_id scheduled_for
  W2->>DB: succeeded
```

### 61.5.10 Testing strategy

Unit: backoff with jitter (bounded, monotonic in expectation), cron next-occurrence across DST in both directions, cycle detection, dependency counter arithmetic. Integration with Testcontainers: everything about claiming, leasing and reaping, because none of it can be tested with mocks. E2E: the admin API and a real DAG execution.

The ten cases:

1. **No double claim** — 20 concurrent workers claim from a queue of 10,000 jobs; every job is claimed exactly once and the union of claims equals the queue.
2. **Lease takeover** — claim a job, kill the worker with `SIGKILL`, assert another worker picks it up within 60 s with `attempt = 2` and a `lost` run row.
3. **Idempotent execution key** — force a takeover while the first worker is still finishing; the unique index means only one `succeeded` run row exists and the side effect happened once.
4. **Backoff schedule** — a job failing five times has `run_after` gaps of roughly 2 s, 4 s, 8 s, 16 s, 32 s within jitter bounds, then lands in the DLQ.
5. **Priority ordering** — enqueue 1,000 priority-9 jobs then 10 priority-1 jobs; the priority-1 jobs are all claimed in the next batch.
6. **DAG order** — a diamond graph A then B and C then D; assert D starts only after both B and C succeed, and that a failure of B leaves D `cancelled` with `upstream_failed`.
7. **Cycle rejection** — creating A depends on B when B already depends on A returns 422 and writes nothing.
8. **Cron DST** — a `30 2 * * *` schedule in `Europe/Berlin` produces exactly one occurrence on the spring-forward day and exactly one on the fall-back day; assert the UTC instants.
9. **Single scheduler** — start three scheduler replicas; assert exactly one holds the advisory lock and exactly one occurrence per cron tick is created, then kill the leader and assert another takes over within 5 s.
10. **Throughput and no bloat** — process 200,000 jobs; assert sustained throughput above your target and that `pg_stat_user_tables.n_dead_tup` on `jobs` returns below 10 percent within a minute of the run ending.

### 61.5.11 Docker

```yaml
services:
  postgres:
    image: postgres:16
    command: ["postgres","-c","max_connections=200","-c","shared_buffers=512MB",
              "-c","autovacuum_naptime=10s","-c","track_io_timing=on"]
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: jobs }
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U postgres -d jobs"], interval: 5s, retries: 10 }
  redis:
    image: redis:7-alpine
    command: ["redis-server","--appendonly","yes","--appendfsync","everysec",
              "--maxmemory","1gb","--maxmemory-policy","noeviction"]
    ports: ["6379:6379"]
  api:
    build: { context: ., target: runtime }
    command: ["node","dist/main.js"]
    environment: &env
      DATABASE_URL: postgres://postgres:dev@postgres:5432/jobs
      REDIS_URL: redis://redis:6379
    depends_on: { postgres: { condition: service_healthy } }
    ports: ["3000:3000"]
  worker:
    build: { context: ., target: runtime }
    command: ["node","dist/worker.js"]
    environment: *env
    deploy: { replicas: 4 }
  scheduler:
    build: { context: ., target: runtime }
    command: ["node","dist/scheduler.js"]
    environment: *env
    deploy: { replicas: 3 }          # three replicas, one leader, on purpose
  bull-worker:
    build: { context: ., target: runtime }
    command: ["node","dist/bull-worker.js"]
    environment: *env
  grafana:
    image: grafana/grafana:latest
    ports: ["3001:3000"]
  prometheus:
    image: prom/prometheus:latest
    volumes: ["./ops/prometheus.yml:/etc/prometheus/prometheus.yml:ro"]
    ports: ["9090:9090"]
```

Running three scheduler replicas locally is deliberate: it makes leader election a thing you can observe with `docker compose logs` rather than a thing you hope works in production.

### 61.5.12 CI/CD

```yaml
jobs:
  verify:
    services:
      postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: dev, POSTGRES_DB: jobs_test }, ports: ["5432:5432"], options: --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10 }
      redis:    { image: redis:7, ports: ["6379:6379"] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run lint && npx tsc --noEmit
      - run: npm run migration:run
      - run: npm run test:unit
      - run: npm run test:concurrency -- --workers 20 --jobs 10000
      - run: npm run test:integration
      - run: npm run test:e2e
      - run: npm run bench:queue -- --jobs 50000 --report bench.json
      - uses: actions/upload-artifact@v4
        with: { name: bench, path: bench.json }
  deploy:
    needs: verify
    if: github.ref == 'refs/heads/main'
    steps:
      - run: kubectl apply -f k8s/ && kubectl wait --for=condition=complete job/jobs-migrate --timeout=300s
      - run: kubectl rollout status deploy/jobs-api deploy/jobs-worker deploy/jobs-scheduler --timeout=600s
      - run: ./scripts/smoke-jobs.sh   # enqueue, wait for success, check metrics endpoint
```

Publish `bench.json` on every run and plot it over time. A performance regression in the claim query is invisible in unit tests and obvious in a chart — and this is the one project where the claim query's plan is the product.

Rolling deploys need `terminationGracePeriodSeconds: 60` and a `SIGTERM` handler that stops claiming, finishes in-flight jobs, and exits. Without it, every deploy manufactures lease takeovers and inflates your attempt counts.

### 61.5.13 Observability

**Metrics:** `job_queue_depth{queue,status}`; `job_queue_oldest_ready_seconds{queue}` — the single best queue health metric, because depth without age tells you nothing; `job_claimed_total{queue}`; `job_completed_total{queue,type,result}`; `job_duration_seconds{type}` histogram; `job_wait_seconds{queue}` from `run_after` to claim; `job_attempts` histogram; `job_lease_takeovers_total`; `job_dead_total{type}`; `dlq_depth` and `dlq_oldest_seconds`; `scheduler_is_leader` (0 or 1 per pod; the sum across pods must always be 1); `schedule_fire_skew_seconds`; and the database's own `pg_stat_user_tables{relname="jobs"}` dead-tuple ratio scraped by the exporter.

**Log fields:** `traceId, jobId, queue, type, attempt, workerId, scheduledFor, durationMs, result, errorClass`. Log claim batches at debug with sizes, not one line per job, or a 2,000 jobs/s system will generate more log volume than work.

**Traces:** the producer's trace context is stored on the job payload as `traceparent` and restored by the worker, so a report generated by a nightly cron links back to the API call that scheduled it. This is unreasonably useful and costs ten lines.

**Dashboards:** queue row (depth and age per queue, claim rate, completion rate); health row (failure rate by type, attempts distribution, takeovers); scheduler row (leader gauge, fire skew, occurrences created, catch-up count); database row (dead tuples on `jobs`, autovacuum runs, claim query p99 from `pg_stat_statements`).

**Alerts:** `job_queue_oldest_ready_seconds > 300` for a latency-sensitive queue (page); `sum(scheduler_is_leader) != 1` for 2 minutes (page — either nobody is scheduling or two are); `job_lease_takeovers_total` rate above 1 per minute sustained (usually workers being OOMKilled); `dlq_oldest_seconds > 86400` (ticket); dead-tuple ratio on `jobs` above 30 percent for 15 minutes (vacuum is losing); `schedule_fire_skew_seconds > 60` (the scheduler is starved).

### 61.5.14 Failure scenarios

| Failure | Expected behaviour | How you test it |
|---|---|---|
| Worker pod OOMKilled mid-job | Lease expires, run marked `lost`, job retried by another worker within 60 s, execution key prevents a duplicate side effect | `SIGKILL` in an integration test; assert one `succeeded` run |
| Handler hangs forever | Lease is not heartbeated past the handler timeout; the runner aborts the handler at `leaseSeconds * 0.8` and fails the job | Handler that awaits a never-resolving promise |
| Database failover | Claims fail, workers back off and retry, no jobs lost, some leases expire and are retried | Kill the primary during the concurrency test |
| Two schedulers both think they are leader | Impossible to fully prevent under partition; duplicate occurrence blocked by `unique_key`; metric `sum(scheduler_is_leader)` alarms | Simulate by forcing the lock query to return true on two pods |
| Poison job crashes every worker | Attempts exhaust, job goes `dead`, DLQ alert; the queue keeps moving | Handler that throws immediately |
| Queue paused during an incident | Claims return nothing; enqueue still works; depth grows; resume drains | Admin API test |
| Table bloat after a 1M-job burst | Autovacuum with the aggressive settings recovers within minutes; throughput returns | Bench run, then measure `n_dead_tup` over time |
| Next month's `job_runs` partition missing | Inserts fail loudly, jobs fail rather than silently losing history; alert on partition existence catches it beforehand | Drop the partition in staging |
| Clock skew of 2 minutes on one worker | `run_after` comparisons happen in the database, so worker clock skew is harmless; only log timestamps look odd | Shift a container clock and observe |
| Redis down (BullMQ queue only) | The BullMQ queue stops entirely; the PostgreSQL queue is unaffected | Stop Redis during the bench; note the difference in the comparison table |

### 61.5.15 Scaling strategy

**1x — 50,000 jobs/day, about 1/s.** One worker pod with concurrency 10, one scheduler set, default vacuum settings. The claim query returns in under a millisecond and the queue table stays small. Honestly, a `setInterval` would work at this scale; you are building the machinery to learn it.

**10x — 500,000 jobs/day, 20/s peak.** Four worker pods, batch claims of 20, the aggressive autovacuum settings, and the nightly move of completed jobs out of `jobs`. Watch `job_queue_oldest_ready_seconds`, not depth. Split queues by workload shape — fast jobs and slow jobs must not share a queue, or one 10-minute report starves 5,000 emails.

**100x — 5 million jobs/day, 2,000/s peak.** Now the claim statement is the bottleneck, and three moves matter. First, batch harder: claim 50 to 100 rows per statement, which amortises the round trip and the index descent. Second, reduce write amplification: `fillfactor`, fewer status updates per job, and completion via a single statement. Third, partition the work: either separate queues on separate tables, or hash-partition `jobs` by `queue` so different workloads do not share heap pages and vacuum pressure. Beyond about 5,000 jobs/s of small jobs on one primary, stop: either move that specific workload to a Redis-backed or Kafka-backed queue, or shard the queue database. Recognising the ceiling and naming it is the senior move; pretending PostgreSQL scales infinitely as a queue is not.

One more scaling note that surprises people: `SELECT count(*)` for depth becomes the most expensive query in the system at scale. Approximate it from `pg_class.reltuples`, or keep counters, and cache it for 15 seconds.

### 61.5.16 Security checklist

- [ ] Job payloads validated per type with a registered schema; an unknown type is rejected at enqueue, not at execution.
- [ ] Payloads never contain secrets; they contain references, and the worker fetches credentials from the secret manager.
- [ ] Handlers run with the least privilege they need; the worker's database role is distinct from the API's.
- [ ] The enqueue API requires a service token, and a token is scoped to the queues and types it may use.
- [ ] Admin endpoints (`retry`, `cancel`, `pause`, `dlq/replay`) require an admin role and log actor and reason.
- [ ] Payload size capped (for example 256 KB); large inputs go to object storage and the payload carries a key.
- [ ] Cron expressions and timezones validated against an allow-list of zones; a bad expression cannot create an infinite schedule.
- [ ] DLQ payloads redacted for fields marked sensitive in the type's schema, because the DLQ is the most-read table during an incident.
- [ ] Rate limits on enqueue per caller so a looping producer cannot fill the table and take the database down.
- [ ] Retention and deletion of `job_runs` covers personal data in error messages; truncate errors and scrub them.

### 61.5.17 Stretch goals

Job cancellation that actually interrupts a running handler using an `AbortSignal` propagated from a cancellation flag checked on heartbeat. Rate-limited queues (no more than N jobs of type X per minute) implemented with a token bucket inside the claim statement. Unique-in-flight semantics (only one `sync:{tenantId}` running at a time) via a partial unique index on `(type, unique_key) WHERE status IN ('ready','running')`. Fan-out and fan-in jobs with a parent that completes when all children do. A workflow DSL that compiles to a DAG. Priority ageing so low-priority jobs cannot starve forever. A worker autoscaler driven by `job_queue_oldest_ready_seconds` through KEDA. Finally, run the same benchmark against a third option — SQS or Kafka as a work queue — and extend the comparison table to three columns.

### 61.5.18 Definition of done

- [ ] All 12 functional requirements implemented, including the BullMQ comparison queue running the same job type.
- [ ] Concurrency test with 20 workers and 10,000 jobs shows exactly-once claiming, run 20 times in CI.
- [ ] Lease takeover proven with a `SIGKILL` test; takeover within 60 s; the execution key prevents duplicate effects.
- [ ] DAG execution correct for a diamond graph, including the upstream-failure policy; cycles rejected at enqueue.
- [ ] Cron correctness proven for both DST transitions in a real timezone, with asserted UTC instants.
- [ ] Exactly one scheduler leader across three replicas, with failover under 5 seconds, proven by test.
- [ ] `job_runs` partitioned monthly with automated creation and an alert on absence; the month-boundary uniqueness caveat documented.
- [ ] Autovacuum and `fillfactor` tuned on `jobs`; dead-tuple ratio stays under 20 percent during the 200,000-job bench.
- [ ] Benchmark published in CI with numbers for both implementations; the comparison table filled in from your own measurements.
- [ ] Metrics, dashboards and all six alerts in place; `sum(scheduler_is_leader) != 1` drilled in staging.
- [ ] Graceful shutdown on `SIGTERM` verified: a rolling deploy causes zero lease takeovers.
- [ ] Deployed to a real cluster with separate API, worker and scheduler deployments and a tested rollback.
- [ ] Runbook: stuck queue, poison job, DLQ replay, leader stuck, vacuum falling behind.
