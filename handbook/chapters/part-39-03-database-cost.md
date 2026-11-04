## 39.3 Database cost

#### Concept

The database is usually the second largest line item after compute, and it is the one where a single checkbox can double the bill. Unlike compute, database cost is *sticky*: you cannot scale an RDS instance down at night without a restart, replicas take minutes to create and destroy, and storage that has grown never shrinks on its own.

#### Why does it exist?

Managed databases price four things independently, and each has its own trap:

1. **Instance** — vCPU and memory, billed per hour whether idle or saturated.
2. **Storage** — GB provisioned per month, and it only ever goes up.
3. **IOPS and throughput** — either included in the storage type or provisioned separately at a price that can exceed the instance.
4. **I/O operations** — on Aurora Standard, billed per million reads and writes, which is where write-heavy workloads get an unpleasant surprise.

Getting a design wrong on any of these produces a bill that grows faster than your traffic.

#### Mental model

Imagine renting a warehouse. The instance is the rent on the building. Storage is the floor space you have leased, and the landlord will not shrink the lease. IOPS is a contract for how many forklift trips per hour you are guaranteed. And on Aurora's standard pricing, there is an additional charge *per forklift trip*, which is fine until the day you decide to move every pallet twice.

#### How it works

**Instance class.** Approximate `us-east-1` on-demand list prices for RDS PostgreSQL:

| Instance | vCPU | RAM | Approx. $/hour | Approx. $/month |
|---|---|---|---|---|
| `db.t4g.medium` | 2 | 4 GB | 0.065 | 47 |
| `db.r6g.large` | 2 | 16 GB | 0.24 | 175 |
| `db.r6g.xlarge` | 4 | 32 GB | 0.48 | 350 |
| `db.r6g.2xlarge` | 8 | 64 GB | 0.97 | 705 |
| `db.r6g.4xlarge` | 16 | 128 GB | 1.93 | 1,410 |

Two immediate levers. **Graviton (`r6g`, `r7g`) is roughly 10 to 20 percent cheaper than the equivalent Intel (`r6i`) class** with equal or better PostgreSQL performance, and switching is a modify-with-restart, not a migration. **A 1-year no-upfront Reserved Instance is roughly 35 to 40 percent off**, and a 3-year all-upfront is around 55 to 60 percent. Databases are the best possible candidate for reservations, because unlike compute they rarely change shape in a hurry.

Our `db.r6g.4xlarge` at $1,410 on demand is roughly $880 with a 1-year reservation. That is a $530 monthly saving for a purchasing decision, with no engineering work at all. Do this before you do anything else in this section.

**Storage and IOPS.** RDS gp3 storage is about $0.115 per GB-month, and it includes 3,000 IOPS and 125 MB/s baseline regardless of volume size. Our 2 TB database costs about **$230 a month in storage**.

Provisioned IOPS (io1/io2) is priced separately at roughly $0.10 to $0.125 per provisioned IOPS-month. This is where bills explode:

```text
20,000 provisioned IOPS x $0.10  = $2,000/month
That is more than the db.r6g.4xlarge instance it is attached to.
```

The senior instinct here is to fix the queries before buying the IOPS. A missing index that causes a sequential scan on a 40 million row table can generate tens of thousands of IOPS on its own. Provisioning IOPS to serve a bad plan is paying rent on a mistake, monthly, forever. Run `EXPLAIN (ANALYZE, BUFFERS)` on your top queries by total time from `pg_stat_statements` before you touch the storage configuration.

gp3 also lets you provision extra IOPS and throughput independently and far more cheaply than io2, so for most workloads the ladder is: fix queries, then add gp3 IOPS, and only then consider io2 (which you want for its higher durability guarantees and Multi-AZ cluster support, not usually for price).

**Multi-AZ doubles the instance cost.** RDS Multi-AZ runs a full standby instance in another AZ with synchronous replication. You pay for two instances and two sets of storage. Our `db.r6g.4xlarge` goes from $1,410 to $2,820 on demand.

Is it worth it? For the production order database, unambiguously yes: it converts an instance failure from a 90 minute PITR restore into a 60 to 120 second automatic failover (Part 38). For staging, unambiguously no. The mistake teams make is applying the same answer to both.

Multi-AZ *cluster* deployments (two readable standbys instead of one non-readable standby) cost more still but give you faster failover and two extra read endpoints, which can replace separately-paid read replicas. Compare the two configurations rather than assuming.

**Each read replica costs a full instance.** This is obvious when stated and constantly forgotten in practice. A `db.r6g.2xlarge` read replica is $705 a month, every month, whether it serves 4,000 queries per second or zero.

Ask three questions before adding one:

1. **What exactly will use it?** "Reporting" is not an answer; name the queries.
2. **Can the primary handle it after the queries are fixed?** Most "we need a read replica" requests are really "we have an N+1 query and a missing index". Fixing those is free and permanent.
3. **Does it need to be the same size?** A replica serving nightly analytics can often be two classes smaller than the primary. A replica serving user-facing reads generally cannot, because it must survive being promoted.

The pattern that wastes the most money: three read replicas added during an incident two years ago, still running, now serving 3 percent of read traffic between them, because the connection routing was never updated. Check `pg_stat_database.xact_commit` per replica; a replica with near-zero activity is $705 a month of nothing.

**The Aurora I/O pricing trap.** Aurora Standard charges about **$0.20 per million I/O requests** in addition to instance and storage. For read-heavy workloads with a good buffer cache hit ratio this is cheap. For write-heavy workloads it is brutal, because every write generates I/O that no cache can absorb.

```text
Sustained 5,000 write I/O per second:
  5,000 x 86,400 x 30 = 12.96 billion I/O per month
  12,960 million x $0.20 = $2,592/month in I/O charges alone

Plus the instance (~$700) plus storage (~$200). The I/O is the largest line item.
```

Aurora **I/O-Optimized** removes per-I/O charges entirely in exchange for roughly 30 percent higher instance pricing and higher storage pricing. The break-even is well known and worth memorising: **if I/O charges exceed about 25 percent of your total Aurora spend, I/O-Optimized is cheaper.** Check the `VolumeReadIOPs` and `VolumeWriteIOPs` CloudWatch metrics and do the arithmetic; teams routinely discover they have been paying a 40 percent premium for months.

Also worth knowing: Aurora's I/O count is driven by cache misses and by write amplification, so the same optimisations that improve latency (larger instance with more buffer cache, fewer indexes, batched writes) directly reduce the bill. On Aurora Standard, a bad query costs you twice.

**Connection pooling lets you buy a smaller instance.** PostgreSQL allocates a backend process per connection, each with its own `work_mem` allocations and a base memory footprint of several megabytes. `max_connections` on RDS defaults to a formula based on instance memory, and pushing it higher trades memory that the buffer cache needs.

A NestJS fleet of 20 pods with a pool of 20 connections each opens 400 connections. That may require an instance class chosen for connection capacity rather than for actual query load — which means you are buying RAM to hold idle backend processes.

PgBouncer (or RDS Proxy) in transaction pooling mode collapses this. 400 client connections multiplex onto 40 server connections. Now the instance is sized for query throughput, and query throughput usually needs a class or two less.

```ts
// database.module.ts — a pool sized for the app, behind a pooler sized for the database.
TypeOrmModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    type: 'postgres',
    // Point at PgBouncer, not at RDS directly.
    host: config.getOrThrow('PGBOUNCER_HOST'),
    port: 6432,
    extra: {
      // Small per-pod pool: 20 pods x 8 = 160 client connections into PgBouncer,
      // which holds maybe 40 real PostgreSQL backends.
      max: 8,
      min: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 15_000,
    },
    // Transaction pooling does not support session-level features.
    // Prepared statements must be disabled or PgBouncer must be in session mode.
    extra_prepare: false,
  }),
  inject: [ConfigService],
});
```

The saving is real: moving from `db.r6g.4xlarge` to `db.r6g.2xlarge` because connections are no longer the constraint is $705 a month. The cost is one more component to operate, and the constraint that transaction pooling breaks session-level features (`LISTEN`/`NOTIFY`, session-scoped advisory locks, some prepared statement behaviour). Know which of those you use before you switch.

**Archiving cold data to S3.** Storage grows monotonically. An `orders` table with 5 years of history serves 99 percent of its queries from the last 90 days.

```sql
-- How much of the database is cold? This query usually surprises people.
SELECT
  date_trunc('year', created_at) AS year,
  count(*) AS rows,
  pg_size_pretty(sum(pg_column_size(o.*))) AS approx_size
FROM orders o
GROUP BY 1 ORDER BY 1;
```

Moving 4 years of closed orders out of PostgreSQL and into Parquet files on S3 (queryable with Athena when finance asks) turns 1.4 TB of $0.115/GB-month RDS storage into 180 GB of compressed $0.023/GB-month S3 storage:

```text
1,400 GB in RDS gp3    = $161/month
  180 GB in S3 Standard = $4/month     (Parquet compresses 6 to 10x)
  Saving: $157/month, plus faster backups, faster restores (Part 38),
  smaller indexes and better cache hit ratios.
```

The secondary effects are often larger than the direct saving. A 600 GB database restores in a third of the time of a 2 TB one, its indexes fit in the buffer cache, and `VACUUM` finishes.

**Retention by dropping partitions.** If the table is partitioned by month (Part 15 — Database Scaling), retention becomes a metadata operation instead of a `DELETE`:

```sql
-- Partitioned table: dropping a partition is instant and reclaims space immediately.
CREATE TABLE events (
  id bigserial, occurred_at timestamptz NOT NULL, payload jsonb
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_09 PARTITION OF events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- Retention job: instant, no bloat, space returned to the filesystem.
DROP TABLE events_2026_03;

-- Compare with the alternative, which is a disaster on a large table:
--   DELETE FROM events WHERE occurred_at < '2026-04-01';
-- It writes as much WAL as the rows it deletes, leaves dead tuples that
-- VACUUM must reclaim, does NOT return space to the OS without VACUUM FULL
-- (which needs an ACCESS EXCLUSIVE lock and double the disk), and can take hours.
```

Partitioning for retention is one of the few designs that improves cost, performance and operability simultaneously. If you have a table that grows forever and is queried by time, partition it.

**Unused indexes charge you twice.** Every index costs storage *and* write throughput. On a write-heavy `orders` table, each additional index means another B-tree page to modify per insert, more WAL, more I/O (billed directly on Aurora Standard), and slower `VACUUM`.

```sql
-- Indexes that have never been used since the last stats reset.
SELECT
  s.schemaname, s.relname AS table_name, s.indexrelname AS index_name,
  s.idx_scan AS times_used,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique          -- never drop a unique index blindly; it is a constraint
  AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;

-- Duplicate / redundant indexes: (a) is redundant if (a, b) exists and is used.
SELECT indrelid::regclass AS table_name, array_agg(indexrelid::regclass) AS indexes
FROM pg_index GROUP BY indrelid, indkey HAVING count(*) > 1;
```

A typical finding on a mature system: 12 unused indexes totalling 180 GB, on tables taking 3,000 writes per second. Dropping them saves about $21 a month in storage, and — far more valuable — reduces write latency, WAL volume, replication lag, backup size and restore time. Use `DROP INDEX CONCURRENTLY`, and check `idx_scan` across *all* replicas first, because an index used only by a reporting replica shows zero scans on the primary.

#### Production scenario

The platform's database line, before and after a review:

| Item | Before | After | Action |
|---|---|---|---|
| Primary `db.r6g.4xlarge` on demand | $1,410 | $880 | 1-year Reserved Instance |
| Multi-AZ standby | $1,410 | $880 | Same reservation |
| Read replica A (analytics) | $705 | $350 | Downsized to `xlarge`; analytics is not latency-critical |
| Read replica B (added in an incident, 2 percent of reads) | $705 | $0 | Deleted after routing fixed |
| Storage 2 TB gp3 | $230 | $69 | Archived 4 years of orders to S3 as Parquet |
| Provisioned IOPS 12,000 | $1,200 | $0 | Two missing indexes removed the need; gp3 baseline is enough |
| Snapshot storage | $180 | $120 | Expired 40 orphaned manual snapshots |
| **Total** | **$5,840** | **$2,299** | **-61 percent** |

Backup retention, Multi-AZ and cross-region copies were untouched. Every saving came from waste, purchasing or query work, not from resilience.

#### Failure scenario

A team migrated a write-heavy event-ingestion workload from RDS to Aurora, expecting better performance. It delivered. The first full month's bill included **$4,100 of Aurora I/O charges** against a $700 instance.

Investigation found two causes. The obvious one: the workload wrote 8,000 rows per second and every write generated I/O. The less obvious one: the table had 9 indexes, six of which were unused, so each insert generated roughly three times the necessary I/O.

The fix was three actions: drop the unused indexes (I/O fell by about 55 percent), batch inserts into multi-row statements (a further 20 percent), and switch to Aurora I/O-Optimized for the remainder. Final bill: $1,180. The unused indexes alone had been costing $2,200 a month in I/O charges — on RDS they would have cost $8 a month in storage and gone unnoticed for years.

#### Edge cases & failure modes

- RDS storage can be increased but **never decreased**. The only way back down is a dump and reload into a new instance, or `pg_repack`. Provision conservatively and use storage autoscaling.
- Storage autoscaling has a cooldown (typically 6 hours) and a maximum; a runaway write can still fill the disk between scaling events (Part 38, scenario 6).
- A read replica with a long-running query blocks WAL replay (or gets cancelled), so a cheap analytics replica can cause replication lag on your DR path.
- Aurora Serverless v2 scales ACUs by load and is genuinely cheap for spiky workloads, but its floor ACU setting is billed continuously, and a floor set high "for safety" removes the entire benefit.
- Deleting an RDS instance without a final snapshot destroys the automated backups with it.
- `DROP INDEX` without `CONCURRENTLY` takes an `ACCESS EXCLUSIVE` lock and stops all queries on the table.
- Reserved Instances are tied to instance family and region; a reservation on `db.r6i` does not apply after you move to `db.r6g`.
- Dropping an index that is only used by a query running once a quarter (a compliance report) turns a 20 second report into a 4 hour one. Check with the owners.

#### How a Senior Backend Engineer thinks about this

They fix queries before they buy hardware. Provisioned IOPS, a bigger instance and a read replica are all ways of paying money to avoid an `EXPLAIN ANALYZE`.

They buy reservations for the database first, because it is the most stable workload in the fleet and the discount is the largest single lever available with zero engineering risk.

They treat every read replica as a service with an owner and a documented consumer. A replica with no named consumer gets deleted.

They partition anything that grows forever and is queried by time, because it converts an operational problem (retention) and a cost problem (storage) into a metadata operation.

And on Aurora they check the I/O line every month, because it is the one AWS bill item that scales with your *inefficiency* rather than with your traffic.

#### Common mistakes

- Adding a read replica to fix a query problem.
- Provisioning IOPS to serve a sequential scan.
- Leaving Multi-AZ on for staging and off for production (yes, this happens).
- Running Aurora Standard on a write-heavy workload without checking the I/O charge.
- Never dropping indexes, because "an index can only help".
- Deleting old rows with `DELETE` instead of dropping partitions, then wondering why the disk did not shrink.
- Buying a 3-year reservation for an instance class the team plans to change.

#### Interview questions

1. **What are the four things a managed database bills you for?** Expected: instance hours, provisioned storage, IOPS/throughput, and (on Aurora Standard) per-I/O charges. Follow-up: which one can exceed the instance cost? Provisioned IOPS, and Aurora I/O on write-heavy workloads.
2. **When is Aurora I/O-Optimized cheaper than Aurora Standard?** Expected: when I/O charges exceed roughly 25 percent of total Aurora spend; typical for write-heavy workloads.
3. **How does connection pooling reduce database cost?** Expected: PostgreSQL is process-per-connection; pooling collapses hundreds of client connections into tens of backends, so the instance can be sized for query throughput rather than connection memory, often one or two classes smaller.
4. **How do unused indexes cost you twice?** Expected: storage, plus write amplification (more pages, more WAL, more I/O, slower VACUUM, more replication lag, longer restores). Follow-up: how do you find them? `pg_stat_user_indexes.idx_scan`, checked on every replica, excluding unique and primary key indexes.
5. **You are asked to add a third read replica. What do you ask first?** Expected: which queries will use it, whether the primary could serve them after fixing plans, whether it can be smaller, and who owns it.
6. **Why is dropping a partition better than `DELETE` for retention?** Expected: instant metadata operation, no WAL for row deletions, no dead tuples, space returned immediately, no `VACUUM FULL` lock.

#### Practical exercise

On a production-like database, run the unused-index query and the cold-data query above. Produce a table of: every index with zero scans and its size, and the percentage of rows older than 90 days.

Acceptance criteria: you can state the storage and write-throughput saving from dropping the unused indexes; you can state the monthly saving from archiving cold data to S3; and you have checked `idx_scan` on every replica before recommending any drop.
