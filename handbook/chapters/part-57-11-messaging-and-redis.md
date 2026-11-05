### Q153. How do you evolve message schemas without breaking consumers?

- **Expected answer** — Treat the message as a published contract with more discipline than an HTTP API, because messages are consumed by systems you may not know about and are also *replayed from history*. Use a schema with a registry (Avro, Protobuf or JSON Schema plus Confluent Schema Registry) and enforce a compatibility mode in CI: **backward** compatible (new consumers can read old messages) is the usual minimum, **full** compatibility (both directions) if producers and consumers deploy independently in any order. Safe changes: adding an optional field with a default, adding a new event type. Unsafe: removing a field, renaming, changing a type, tightening an enum. Practical rules I enforce: every event carries `event_id`, `event_type`, `event_version`, `occurred_at` and a `producer` identifier; consumers ignore unknown fields (tolerant reader); never reuse a field name with new meaning; and if a truly breaking change is needed, publish a new event type in parallel, migrate consumers, then retire the old one — the same expand-and-contract as an API. Remember replay: if you can replay a topic from 30 days ago, your consumer must still parse messages produced by the code from 30 days ago.

- **Why it matters** — Schema breakage in an event pipeline can corrupt many downstream systems at once.

- **Follow-ups** — What compatibility mode do you set and why? How does replay constrain your schema changes? How do you deprecate an event type?

- **Senior signal** — The replay constraint, which is the point people forget, plus a required envelope with `event_id` for dedupe.

### Q154. How do you tune producer and consumer throughput?

- **Expected answer** — Producer side: batching is everything — `linger.ms` (wait a few milliseconds to fill a batch; going from 0 to 5–20 ms often multiplies throughput), `batch.size`, and `compression.type` (`lz4` or `zstd`, which usually reduces both network and disk substantially for JSON). `acks=all` with `min.insync.replicas=2` for durability, at the cost of a round trip to replicas; `acks=1` is faster and can lose data on leader failure. Keep `enable.idempotence=true` so retries do not duplicate or reorder. Consumer side: `max.poll.records` and `fetch.min.bytes`/`fetch.max.wait.ms` control batch shape; then batch the *downstream* work — a consumer that does one `INSERT` per message at 5,000 messages per second is doing 5,000 round trips, whereas batching 500 rows per statement drops that to 10. Parallelism inside a consumer (processing a batch concurrently) is fine as long as you preserve per-key ordering and only commit once the whole batch is durable. And always measure end-to-end: the bottleneck is usually the database or an external API, not the broker, so tuning broker settings when your handler takes 40 ms in Postgres is wasted effort.

- **Why it matters** — Throughput tuning is where measurement discipline shows.

- **Follow-ups** — What does `linger.ms` cost you in latency? How do you batch database writes without losing per-message error reporting? Which metric tells you the broker is not the bottleneck?

- **Senior signal** — Batching the downstream work, and profiling before tuning broker knobs.

### Q155. What retention and replay strategy do you set?

- **Expected answer** — Retention (`retention.ms`, `retention.bytes`) determines how far back you can replay and how long a broken consumer has to recover. Set it from two requirements: the longest realistic consumer outage you want to survive (a weekend plus a fix is a common 7-day answer), and any need to rebuild a downstream store from history. For topics that represent *state* rather than events — a compacted "current value per key" topic — use `cleanup.policy=compact` so the latest value per key is retained forever, which lets a new service bootstrap its state by reading from the beginning. Replay is a capability you must design for, not one you get for free: consumers must be idempotent (replaying charges twice is catastrophic), side effects like emails must be suppressible during a replay, and you need a documented procedure to reset a group's offsets to a timestamp. I also keep a separate archival sink to object storage for long-term history, because keeping 90 days in the broker is expensive compared with S3 and you rarely need broker-speed access to old data.

- **Why it matters** — Retention is a data-loss deadline and a recovery capability at once.

- **Follow-ups** — What breaks if you replay a topic containing "send email" events? How would you rebuild a read model from a compacted topic? Where do you store history beyond retention?

- **Senior signal** — Treats replay as something requiring side-effect suppression, and uses compaction and archival deliberately.

### Q156. When would you not use a message broker?

- **Expected answer** — When the caller needs the result to continue, a synchronous call is simpler and more debuggable; wrapping it in a broker adds latency, an extra failure domain, and eventual consistency you then have to explain to product. When volume is modest (say under a few hundred jobs per second) and you already run Postgres, a jobs table with `FOR UPDATE SKIP LOCKED` gives you transactional enqueue with no dual-write problem, no extra infrastructure and easier debugging — you can `SELECT` your queue. When you need simple background work in a managed environment, SQS or a hosted queue costs almost nothing to operate. And when the team has no experience operating the broker: an under-operated Kafka cluster (no lag alerting, no DLQ, no schema discipline) is worse than no Kafka. The senior framing is that a broker buys you decoupling, buffering, fan-out and replay, and charges you in operational complexity, eventual consistency, ordering caveats and debugging difficulty. If you are not using at least two of the four benefits, you are probably paying the cost for nothing.

- **Why it matters** — Anti-hype judgement is explicitly part of the senior bar.

- **Follow-ups** — What would make you migrate from a Postgres queue to Kafka? What is the debugging difference in practice? How do you decouple without a broker?

- **Senior signal** — A clear cost/benefit test and willingness to recommend the boring option.

## 57.12 Caching and Redis

### Q157. Which Redis data structures do you use, and for what?

- **Expected answer** — Strings for cached JSON blobs, counters (`INCR`) and locks (`SET NX PX`). Hashes for objects where you update fields independently, and they are memory-efficient for small objects thanks to listpack encoding. Sorted sets for leaderboards, rate-limiter sliding windows (score = timestamp, then `ZREMRANGEBYSCORE` to trim), and priority queues or delayed jobs (score = run-at time). Lists for simple FIFO queues (`LPUSH`/`BRPOP`), though a real broker is usually better. Sets for membership and deduplication. HyperLogLog for approximate unique counts (unique visitors per day in 12 KB, with about 0.8% error) when exactness is not needed. Bitmaps for per-user daily flags at very low memory. Streams (`XADD`/`XREADGROUP`) when you want a log with consumer groups and acknowledgement without running Kafka. Geospatial for radius queries. The important skill is picking the structure that makes the operation atomic on the server — `ZADD` plus `ZREMRANGEBYRANK` beats reading a list into Node, editing it and writing it back, which is both slower and racy.

- **Why it matters** — Choosing the right structure removes whole classes of race conditions.

- **Follow-ups** — How would you build a delayed job queue with a sorted set? When is a HyperLogLog acceptable? What is the memory profile of a hash with 1 million fields?

- **Senior signal** — Chooses structures to make operations server-side and atomic, and knows the memory characteristics.

### Q158. Compare cache-aside, write-through and write-behind.

- **Expected answer** — **Cache-aside (lazy loading)**: the application checks the cache, and on a miss reads the database and populates the cache. Simple, resilient (a cache outage degrades to slow, not broken), and only caches what is actually used — my default. Downsides: every miss pays the full cost, the first request after a deploy or eviction is slow, and stale data lingers until TTL or explicit invalidation. **Write-through**: writes go to the cache and the database together, so the cache is always fresh; it adds latency to every write and caches data that may never be read. **Write-behind (write-back)**: write to the cache and flush to the database asynchronously — fastest writes, but you can lose data if the cache dies before the flush, and it is only acceptable for data you can afford to lose (view counts, last-seen timestamps). In practice I use cache-aside with a TTL as the safety net plus explicit invalidation on write, and I choose the TTL from the business tolerance for staleness, not from habit. One rule worth stating: never make the cache the source of truth by accident — if losing Redis loses data, you have built a database without durability.

- **Why it matters** — Cache strategy determines both correctness and blast radius when Redis fails.

- **Follow-ups** — Invalidate or update the cache on write, and why? What happens to your database when the cache is flushed? Where would write-behind be acceptable?

- **Senior signal** — TTL as a safety net behind explicit invalidation, and the "never accidentally the source of truth" rule.

### Q159. What is a cache stampede and how do you prevent it?

- **Expected answer** — A stampede (thundering herd) happens when a hot key expires and hundreds of concurrent requests all miss and all hit the database simultaneously — turning a cache hit path of 0.3 ms into a database spike of hundreds of identical expensive queries, which can take the database down. Three defences, usually combined. (1) **Locking / single-flight**: the first miss takes a short Redis lock (`SET lock:key token NX PX 5000`) and recomputes; others either wait briefly and re-read, or serve the stale value. In-process, coalesce concurrent identical requests so one pod issues one query. (2) **Early recomputation with jitter**: store the value with a logical expiry earlier than the physical TTL, and let a request that sees it is close to expiring refresh it in the background while still serving the current value (probabilistic early expiration). (3) **Jittered TTLs**: never set the same TTL for a batch of keys populated together, or they all expire in the same second — add ±10% randomness. The related event to plan for is a cold cache after a Redis restart or failover: the whole key space misses at once, so load-test with the cache empty and consider warming the top N keys on startup.

- **Why it matters** — It is the most common way a cache causes an outage rather than preventing one.

- **Follow-ups** — What does the request that loses the lock race do? How do you implement stale-while-revalidate in Redis? What is your plan for a Redis failover?

- **Senior signal** — Serving stale during recompute, TTL jitter, and treating the cold-cache case as a load-test requirement.

### Q160. Explain Redis eviction policies and `maxmemory`.

- **Expected answer** — `maxmemory` caps the dataset size; when it is reached, `maxmemory-policy` decides what happens. `noeviction` (the default) returns errors on writes — correct for a queue or a lock store where silently dropping data would be a correctness bug, and catastrophic for a cache because your application starts failing writes. `allkeys-lru` evicts the least recently used key regardless of TTL — the right choice for a pure cache. `volatile-lru`/`volatile-ttl`/`volatile-random` evict only keys that have a TTL, which is right when you mix cached data with persistent structures in one instance, though it fails hard if you forget to set TTLs and then have nothing to evict. `allkeys-lfu` (least frequently used) is better than LRU when a small set of keys is genuinely hot and you do not want a one-off scan to evict them. Redis's LRU is *approximate*, sampling a handful of keys (`maxmemory-samples`), which is fine in practice. The operational rules: always set `maxmemory` explicitly (an unbounded Redis gets OOM-killed), monitor `evicted_keys` and `used_memory` versus the limit, and do not mix cache and non-cache workloads in one instance precisely because they need different policies.

- **Why it matters** — A wrong policy turns a memory pressure event into either data loss or application errors.

- **Follow-ups** — Which policy for a session store, and why? What does a rising `evicted_keys` rate tell you? Why separate cache and queue instances?

- **Senior signal** — Ties the policy to the workload and refuses to mix workloads in one instance.

### Q161. How do you implement a distributed lock in Redis, and what is Redlock's controversy?

- **Expected answer** — The basic single-instance lock is `SET lock:resource <random-token> NX PX 30000`: atomic acquire with an expiry so a crashed holder does not deadlock. Release must be a Lua script that compares the token before deleting, otherwise you can delete someone else's lock after your own has expired. If the work may exceed the TTL you need a watchdog that extends the lease — and you must handle the case where extension fails. **Redlock** extends this to N independent Redis nodes, requiring a majority of acquisitions within a bounded time. The controversy (Kleppmann versus antirez) is that Redlock relies on bounded clock drift and bounded process pauses, and neither is guaranteed: a GC pause longer than the TTL means you believe you hold a lock you have lost, so it is not safe for correctness-critical mutual exclusion. The practical senior position: Redis locks are fine for *efficiency* (avoiding duplicate work, deduplicating a cron run) where a rare double execution is merely wasteful; for *correctness* (money, inventory), use the database — a row lock, a unique constraint, or a fencing token checked by the resource — because the guarantee has to live where the data lives.

- **Why it matters** — Misusing a Redis lock for correctness is a real and expensive mistake.

- **Follow-ups** — Write the release script. What is a fencing token and why does Redis not give you one? Give an example where a double execution is acceptable.

- **Senior signal** — The efficiency-versus-correctness distinction, and pushing correctness into the database.

### Q162. RDB or AOF — how do you configure Redis persistence?

- **Expected answer** — **RDB** takes point-in-time snapshots by forking and writing a compact binary file; restarts are fast and backups are easy, but you lose everything since the last snapshot (potentially minutes), and the fork briefly doubles memory pressure through copy-on-write, which on a large instance can cause a latency spike or an OOM if `vm.overcommit_memory` is not set. **AOF** appends every write command to a log, with `appendfsync everysec` as the usual setting (losing at most about one second) or `always` (much slower). AOF files are larger and need periodic rewriting to compact, and restart is slower because the log is replayed. Many deployments use both: AOF for durability and RDB for fast restore and backups. The decision follows from what the instance holds: for a pure cache, persistence is often unnecessary — but then you must have a plan for a cold start (see Q159). For a session store or a queue, you need AOF at minimum, and honestly you should question whether that data belongs in Redis at all. In managed services (ElastiCache, Memorystore) you pick from a smaller menu, but the same trade-off applies and you should know your actual RPO.

- **Why it matters** — People assume Redis is durable and discover otherwise during an incident.

- **Follow-ups** — What is your RPO for this instance? Why does a fork cause a latency spike? What data should not be in Redis at all?

- **Senior signal** — Ties persistence choice to the data's role and knows the copy-on-write fork hazard.

### Q163. Redis Sentinel or Redis Cluster?

- **Expected answer** — **Sentinel** provides high availability for a single logical dataset: one primary with replicas, and Sentinel processes monitor and promote a replica on failure, with clients discovering the current primary through Sentinel. It does not shard, so your data must fit in one node's memory and one node's throughput. **Cluster** shards the keyspace across 16,384 hash slots distributed over multiple primaries, each with replicas, and handles both scaling and failover. The costs of Cluster: multi-key operations and transactions only work when keys are in the same slot, which requires hash tags (`{user:123}:cart` and `{user:123}:orders` share a slot); Lua scripts must touch only one slot; clients must be cluster-aware and follow `MOVED`/`ASK` redirects; and resharding is an operational task. So the rule is to use Sentinel (or a managed equivalent) until you genuinely exceed one node's memory or CPU, then move to Cluster and design keys with hash tags from day one. Also note that many "we need Cluster" cases are actually a hot key or a big key problem, which sharding does not fix.

- **Why it matters** — Cluster imposes real constraints on how you name keys, decided before you migrate.

- **Follow-ups** — How would you key a rate limiter so it works in Cluster? What breaks in your Lua scripts? What is a `MOVED` redirect?

- **Senior signal** — Hash tags and the multi-key restriction, plus noting that sharding does not solve skew.

### Q164. What are pipelining and Lua scripting good for?

- **Expected answer** — Redis is fast (typically 0.1–0.5 ms per command in the same AZ), so at scale the dominant cost is round trips: 100 sequential `GET`s is 100 round trips, maybe 30 ms, while a **pipeline** sends all 100 in one write and reads one batched response, cutting it to roughly one round trip. `MGET`/`MSET` do the same for simple cases. **Lua scripts** (`EVAL`/`EVALSHA`) run atomically on the server, so read-modify-write logic that would be racy from the client becomes safe — this is how you implement token-bucket rate limiting, conditional cache updates, or a compare-and-delete lock release. Rules: keep scripts short because Redis is single-threaded and a slow script blocks every other client (that is the main hazard); use `EVALSHA` with a cached SHA to avoid resending the body; never call non-deterministic functions in a way that breaks replication; and in Cluster, all keys touched must be in one slot. Also distinguish pipelining from `MULTI/EXEC`: a transaction queues commands and executes them atomically but cannot branch on intermediate results, which is exactly what Lua adds.

- **Why it matters** — Round trips dominate real Redis latency, and atomicity choices determine correctness.

- **Follow-ups** — When is `MULTI/EXEC` not enough? What is the risk of a 50 ms Lua script? How do pipelines interact with errors in the middle?

- **Senior signal** — Names round trips as the real cost, and flags single-threaded blocking as the Lua hazard.

### Q165. What are the dangerous Redis commands and anti-patterns in production?

- **Expected answer** — `KEYS *` scans the entire keyspace and blocks the server for the duration — on a 10 million key instance that is seconds of total unavailability for every client; use `SCAN` with a cursor instead. `FLUSHALL`/`FLUSHDB` do exactly what they say. `DEL` on a huge collection blocks while freeing memory; use `UNLINK` for asynchronous freeing. Large `SORT`, `SMEMBERS` on a million-member set, `HGETALL` on a giant hash, and `LRANGE 0 -1` all pull enormous payloads and block. Beyond commands, the anti-patterns are: **big keys** (a single 500 MB value makes every operation on it slow and makes cluster resharding painful), **hot keys** (one key taking most of the traffic, so sharding does not help), unbounded key growth with no TTL (memory creeps until eviction or OOM), storing data in Redis that must not be lost, and using Redis pub/sub for anything requiring delivery guarantees, since messages are dropped for disconnected subscribers. Operationally: enable slowlog and check it, rename or disable dangerous commands in production, monitor `used_memory`, `evicted_keys`, `blocked_clients` and latency percentiles, and remember the whole server is single-threaded for command execution.

- **Why it matters** — One `KEYS *` in a support script has caused many outages.

- **Follow-ups** — How do you find big keys safely? What replaces pub/sub when you need durability? What does the slowlog tell you?

- **Senior signal** — Explains the single-threaded blocking model as the reason all these are dangerous, rather than listing them as trivia.

### Q166. How do you choose TTLs, and what is negative caching?

- **Expected answer** — A TTL is a staleness budget, so derive it from the business: how wrong can this data be before someone is harmed? Product descriptions can be 10 minutes stale; a price should not be cached at all or only for seconds; a permission check should be very short or explicitly invalidated because a revoked access token cached for an hour is a security incident. Practical guidance: short TTL plus explicit invalidation on write gives freshness with a safety net if invalidation is missed; long TTL alone is only acceptable for immutable data (use content-addressed keys and then TTL barely matters). Always jitter TTLs to avoid synchronised expiry. **Negative caching** means caching the *absence* of a result — if a lookup for a missing product hits the database every time, an attacker or a broken client can hammer you with requests for non-existent ids, and the cache provides zero protection. Cache "not found" with a much shorter TTL (say 30 seconds) so a legitimate creation is picked up quickly, and consider a Bloom filter in front for very large key spaces. The related failure is the null-versus-miss ambiguity: store an explicit tombstone value so your code can distinguish "we know it does not exist" from "not cached".

- **Why it matters** — TTL choice is where staleness bugs and cache-penetration attacks both originate.

- **Follow-ups** — How do you invalidate a cached permission immediately on revocation? How does a Bloom filter help? What is your TTL for a user session and why?

- **Senior signal** — Treats TTL as a stated staleness budget, and knows negative caching plus the tombstone-versus-miss distinction.
