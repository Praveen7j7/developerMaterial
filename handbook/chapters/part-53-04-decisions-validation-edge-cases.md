## 53.9 Turning estimates into decisions and validating them

An estimate that does not change a configuration value is a maths exercise. Every number should land on a setting.

| Estimate | Setting it determines | Example from 53.8.1 |
|---|---|---|
| Peak RPS / measured RPS per pod | Pod count, HPA `minReplicas` / `maxReplicas` | 3,000 / 250 / 0.65 = 20 pods, HPA 12–40 |
| Measured knee of the latency curve | HPA target utilization | Knee at 80% CPU, so target 60% |
| p99 connection hold time * peak RPS per pod | Pool `max` | 8 ms * 150 = 1.2, floor to 8 |
| Pods * pool * surge | `max_connections`, PgBouncer `default_pool_size` | 315 peak, so PgBouncer with pool 30, `max_connections` 200 |
| Reads after cache, split by staleness tolerance | Read replica count | 800 rps tolerant / 400 per replica = 2 replicas |
| Rows per day * retention | Partition strategy and interval | 60k orders/day, 7 years: monthly `RANGE` partitions |
| Working set * (value + overhead) / 0.7 | Redis instance class and `maxmemory` | 8.3 GB, `cache.r6g.large`, `maxmemory 9gb`, `allkeys-lru` |
| Recovery consumer count | Kafka partition count | 18 pods to drain in 15 min, so 24 partitions |
| Peak bytes/s out | CDN decision, egress budget, response size limits | 45 MB/s: CDN for images, brotli for JSON |
| Heap peak / 0.75 | `--max-old-space-size` and container limit | 373 MB, so 512 MB heap in a 1 GiB container |
| Backlog during the longest tolerable outage | Broker disk, queue memory, DLQ policy | 4.3 GB * RF 3 |

### 53.9.1 Validate with a load test, then correct the model

Estimates are hypotheses. The load test is the experiment. Do it in this order: **write the predictions down first**, then run the test, then compute the ratio. Writing them afterwards is not validation, it is rationalization.

| Quantity | Predicted | Measured at 3,000 RPS | Ratio | What it taught |
|---|---|---|---|---|
| RPS per pod | 250 | 165 | 0.66 | `class-transformer` on the order DTO costs 2.1 ms per response; the constant was optimistic |
| p95 latency | 180 ms | 240 ms | 1.33 | Acceptable; driven by the same serialization |
| Primary ops/s | 665 | 1,180 | 1.77 | Cache hit ratio was 88%, not 95%: the long tail of the catalog is hotter than assumed |
| Redis memory | 8.3 GB | 6.1 GB | 0.73 | Values compress better than assumed; `maxmemory` can stay |
| Connections at peak | 315 | 298 | 0.95 | Model was good |
| Egress | 45 MB/s | 31 MB/s | 0.69 | Brotli at the edge did better than the gzip assumption |

Every ratio outside 0.5–2.0 is a lesson, not a failure. Correct the **constant**, not the method: the pod count becomes `3,000 / 165 / 0.65 = 28`, and the cache assumption becomes 88 percent, which raises the primary's steady load to 1,180 and still leaves it at 6 percent utilization. Then record the corrected constants in the runbook so the next estimate starts from measured numbers. After two or three cycles your constants are your own, and your estimates land inside 30 percent routinely.

Re-run the validation when anything material changes: a new instance class, a Node major version, a serialization change, a 2x growth in data volume, or a new region.

### 53.9.2 The formulas, in one table

| What | Formula |
|---|---|
| Seconds per day | 86,400, round to 10^5 |
| Average RPS | `dau * actions_per_user / 86400` |
| Peak-hour RPS | `daily_requests * peak_hour_share / 3600` (share ~0.10–0.12) |
| Peak-second RPS | `peak_hour_rps * 1.5 to 3` |
| Provisioned capacity | `peak_rps / utilization_target * az_loss_factor` |
| Database read load | `cacheable_rps * (1 - hit_ratio) + uncacheable_rps` |
| Row bytes | `sum(column_bytes) + 24 (tuple header) + 4 (line pointer) + alignment` |
| Rows per page | `8150 / (row_bytes + 4)` |
| Index bytes | `rows * (key_bytes + 12) * 1.3` |
| Table growth | `rows_per_day * row_bytes * retention_days` |
| Provisioned storage | `(tables + indexes) * bloat * (1 + replicas) / 0.7` |
| Bandwidth | `rps * payload_bytes`; 1 KB at 1,000/s = 1 MB/s = 86 GB/day = 2.6 TB/month |
| Redis memory | `keys * (key_bytes + value_bytes + 90) * 1.3 / 0.7` |
| Node RSS | `max_old_space_size + 150 to 250 MB` |
| Concurrency (Little's law) | `throughput * latency` |
| Pool size | `p99_hold_seconds * peak_rps_per_pod`, floor ~4 |
| Peak connections | `sum(replicas * pool_max) * surge + workers + cron + humans` |
| PgBouncer server pool | `tx_per_second * avg_tx_seconds`, then round up for burst |
| Consumers needed | `required_rate / measured_rate_per_consumer` |
| Partitions | `>= max(recovery_consumers, throughput / 10 MB per second)` |
| Backlog | `producer_rate * outage_seconds` |
| **Drain time** | `backlog / (consumer_rate - producer_rate)` |
| Connections per gateway pod | `min(usable_memory / bytes_per_conn, measured_event_loop_limit)` |

### 53.9.3 Interview questions

1. *We have 20 million monthly actives on a shopping app. How many API pods do we need?* Expected: walk the chain out loud — DAU/MAU ratio, calls per user, average RPS, peak factor, measured RPS per pod, utilization target, zone loss. The interviewer is checking whether you state assumptions before computing, and whether you ask for the measured per-pod number instead of inventing one.
2. *Your cache hit ratio is 95 percent. Redis restarts empty. What happens?* Expected: database read load jumps 20x instantly; name the protections (request coalescing so one miss per key rebuilds it, stale-while-revalidate, staged warm-up, load shedding) and say whether the database was provisioned for the cold number. Follow-up: what does your dashboard show in the first 30 seconds?
3. *How do you decide the number of partitions for a Kafka topic?* Expected: from the consumer count needed to drain a backlog within the recovery SLO, not from throughput; mention that consumers cannot exceed partitions and that raising the count later breaks per-key ordering.
4. *A table has 50 million rows and the "database is 20 GB". What is missing from that number?* Expected: indexes, bloat and fillfactor, TOAST, replicas, backups, WAL and archive, temp space, and 30 percent free headroom.
5. *We need to store every GPS point from 500,000 drivers. How much storage?* Expected: compute it (576 GB/day), then push back with product questions about who reads it, and show the 25x reduction from downsampling and trip-scoping. The interviewer wants to see that you treat the requirement as negotiable.
6. *Why is 80 percent CPU utilization a bad target?* Expected: the queueing curve — latency rises hyperbolically as utilization approaches 1; autoscaling needs 60–180 seconds to react; losing one of three zones instantly adds 50 percent load.

### 53.9.4 Practical exercise

Take a service you already run. Without opening a dashboard, estimate: peak RPS, RPS per pod, primary database operations per second, the size of the largest table including indexes, the peak connection count during a rolling deploy, and monthly egress. Write the assumptions and formulas first. Then open the dashboards and fill in a measured column.

Acceptance criteria: every predicted value has a stated formula and assumption; you compute the ratio measured/predicted for each; you identify at least one ratio outside 0.5–2.0 and explain which assumption was wrong; and you commit the corrected constants into the service's runbook next to a sentence naming which resource saturates first.

## 53.10 Edge cases and failure modes

- **Planning for the average instead of the peak.** The most common and most expensive error. A service sized for 580 RPS falls over every evening at 20:00 and nobody can explain why the dashboards "look fine" (they show 24-hour averages). Always compute three numbers: daily average, peak hour, peak second, and label which decision each one drives.
- **Forgetting indexes, replicas and backups in the storage number.** A 370 GB dataset becomes 2.4 TB of block storage and 4.4 TB of object storage once you count indexes, bloat, headroom, two replicas, WAL archive and backups. Present the provisioned number, not the logical one, or the finance conversation and the volume-full incident both arrive as surprises.
- **Ignoring payload growth over time.** The order response was 4 KB at launch. Two years later it embeds the loyalty summary, three promotion objects, a recommendation block and full address history: 22 KB. Egress went up 5.5x, serialization CPU went up 5x, and nobody made a decision. Track average response size as a metric with an alert on a 30-day trend, and put a hard size budget in the API design review.
- **Unbounded retention.** "We might need it later" is how a table gets to 4 billion rows with no partitioning, at which point every maintenance operation is a project. Every table gets a retention answer at creation time, even if the answer is "forever, and here is why". Tables with a finite retention are partitioned from day one.
- **Hot partitions make the average meaningless.** 8 Redis shards at 21,000 ops/s each is fine on paper; if one city produces 40 percent of the traffic, that shard is at 67,000 ops/s and it is the only one that matters. The same applies to Kafka partitions keyed by `tenant_id` when one tenant is 60 percent of the volume, and to database partitions when today's partition takes every write. Always ask "what is the distribution?" after computing an average, and estimate the **hottest** unit, not the mean one.
- **Assuming linear scaling.** Doubling pods does not double throughput once the shared resource behind them saturates. 20 pods at 250 RPS each is 5,000 RPS only if the database, the cache, the connection pool and the downstream provider all have room. Every capacity estimate should name **which resource saturates first** and at what number; that is the real capacity of the system.
- **Ignoring the CPU limit on a Node pod.** Node is single-threaded for JavaScript. A pod with `limits.cpu: 2` does not run your handler twice as fast; the second core helps GC, libuv threads and native crypto, and that is all. Worse, CPU limits are enforced by CFS quota over a 100 ms period: a pod that briefly needs more than its quota gets **throttled**, adding tens of milliseconds of latency while `kubectl top` cheerfully reports 55 percent usage. Watch `container_cpu_cfs_throttled_seconds_total`, and prefer more small pods to fewer large ones.
- **Connection arithmetic that quietly exceeds `max_connections` on the third deploy of the day.** Steady state is 360 connections against a limit of 500 and everything is green. Each rolling deploy briefly runs old and new pods together; usually the surge peaks at 480. On the third deploy, one pod drains slowly because a long query is still running, the surge reaches 505, and every service in the fleet starts throwing `sorry, too many clients already` simultaneously. Compute the surge peak explicitly, put PgBouncer in the path, and alert at 70 percent of `max_connections`.
- **Estimating throughput but not recovery.** Consumers sized at 1.2x the producer rate keep up perfectly and can never catch up. The drain-time formula has no solution near 1.0x. Size consumers from the recovery requirement.
- **Cache hit ratio treated as a constant.** It is a variable that drops to zero on a Redis restart, on a key-format change, on a cold deploy and during a crawler run. Provision the database for the cold-cache load, or add explicit protection (request coalescing, stale-while-revalidate, staged warm-up) and say which one you chose.
- **Estimating with the wrong unit of work.** "100,000 events per second" sounds like 100,000 requests per second until you notice the client batches 500 per call and it is actually 200 RPS. Conversely "1,000 orders per second" is 6,000 database operations per second. Always convert to the unit the constrained component actually counts.
- **Forgetting the cost of the estimate being right.** A design that needs 160 gateway pods, 8 Redis shards and a sharded database is correct arithmetic and possibly wrong engineering. Compute the monthly bill next to the capacity, and ask whether a product change (a longer heartbeat, a smaller payload, a shorter retention, a batched client) removes an order of magnitude. The best capacity work usually deletes work rather than provisioning for it.

## Senior Checklist — Part 53

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
- [ ] I know the latency ladder from L1 cache to cross-region round trip by order of magnitude
- [ ] I use 86,400 s/day (~10^5) and can convert between per-second, per-day and per-month rates in my head
- [ ] I state assumptions with units before computing, and round to one significant figure
- [ ] I sanity-check every estimate against a component limit or a system I have run
- [ ] I compute daily average, peak hour and peak second, and I know which decision each one drives
- [ ] I split total RPS into reads and writes, and route reads by staleness tolerance
- [ ] I can compute database load from a cache hit ratio, and I size the database for a cold cache
- [ ] I can estimate a PostgreSQL row from its column types, including the 24-byte tuple header
- [ ] I never present a storage number without indexes, bloat, replicas, backups, WAL and headroom
- [ ] I size connection pools with Little's law and compute the rolling-deploy surge against `max_connections`
- [ ] I can compute queue drain time and derive the partition count from the recovery requirement
- [ ] I map every estimate to a concrete setting, then validate it with a load test and correct my constants

## Part 53 — Key Takeaways

- An estimate right to within 3x from stated assumptions beats a precise number from an unexamined one; the fatal errors are missing terms, not imprecise ones.
- Memorize the latency ladder and the throughput table, then replace every constant with a measured one from your own system.
- A day is 86,400 seconds; call it 10^5 and the arithmetic becomes mental.
- State assumptions, write the formula, compute to one significant figure, sanity-check, then add named headroom for utilization, zone loss and growth.
- Nobody experiences the average: size storage from the daily average, autoscaling from the peak hour, and pods, pools and rate limits from the peak second.
- Split reads from writes, route reads by staleness tolerance, and remember one logical write is usually 2–6 database operations.
- Cache hit ratio is a multiplier on database load and it is fragile; provision for the cold-cache number or protect it explicitly.
- Storage estimates need indexes, bloat, replicas, backups, WAL and 30 percent free headroom; a 370 GB dataset is a 2.4 TB bill.
- Partition any table with a retention policy from day one; `DROP PARTITION` is instant, `DELETE` is an outage.
- Connection count is `pods * pool * surge`, and the surge during a rolling deploy is the term that causes the incident.
- Queue capacity is a recovery question: `drain_time = backlog / (consumer_rate - producer_rate)`, and partition count comes from the consumers you need to recover, not the ones you need in steady state.
- Every estimate must land on a setting: pod count, pool size, partition count, `maxmemory`, instance class, HPA threshold. Then load test, compare, and correct the constant.
