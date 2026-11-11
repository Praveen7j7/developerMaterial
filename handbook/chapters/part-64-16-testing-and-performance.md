### Q226. What does code coverage tell you, and what does it not?

- **Expected answer** — Coverage measures which lines and branches executed during the suite. It is useful as a *negative* signal: a critical module at 10% coverage is genuinely untested and worth attention. It is a poor positive signal, because executing a line is not the same as asserting anything about it — you can reach 100% with tests that have no assertions at all, and coverage says nothing about whether you tested the right inputs, the error paths, or the concurrent case. Chasing a number produces low-value tests written for the metric, especially on generated code, DTOs and mappers, and it creates resistance to deleting dead code. So I set a floor rather than a target (say, do not let coverage drop on changed files), exclude generated and trivial code, and look at coverage per module rather than one global percentage. **Mutation testing** (Stryker) is the stronger signal: it changes your code deliberately — flipping a comparison, removing a call — and checks whether any test fails; surviving mutants show tests that execute code without verifying it. It is slow, so run it periodically or on the critical modules only, not on every commit.

- **Why it matters** — Coverage targets are a common source of wasted effort and false confidence.

- **Follow-ups** — Would you enforce 80% coverage as a gate? What is a surviving mutant telling you? Which modules do you actually want near-complete coverage on?

- **Senior signal** — Uses coverage as a negative signal only, and knows mutation testing as the real quality check.

### Q227. How do you do performance testing, and where does it fit in CI?

- **Expected answer** — Distinguish the types: a **load test** at expected peak to verify the SLO holds; a **stress test** past the limit to find where it breaks and confirm it degrades gracefully rather than collapsing; a **soak test** running for hours to reveal leaks, connection exhaustion and slow bloat; and a **spike test** for sudden traffic, which is what breaks autoscaling assumptions. Tools: `k6` or Gatling for scripted scenarios, `autocannon` for a quick endpoint check. What makes it meaningful: realistic data volume (a query that is fast on 10,000 rows and terrible on 10 million), realistic traffic mix and think time rather than a single endpoint hammered flat out, and warm caches or explicitly cold ones depending on what you are testing. In CI, run a short smoke-level benchmark on every merge to catch a gross regression (a p95 that doubled), and a full load test on a schedule or before a major release against an environment sized like production — full load tests are too slow and too noisy for every commit. Always measure the *system*, not just the API: during the test, watch database CPU, connection counts, event loop lag and queue depth, because the interesting result is usually which component saturated first.

- **Why it matters** — Performance regressions are cheap to prevent and expensive to discover in production.

- **Follow-ups** — What data volume do you test against and why? What would you alert on in a CI benchmark? How do you keep load tests from being noisy?

- **Senior signal** — Names the four test types with distinct purposes and watches downstream saturation, not just response times.

### Q228. What does "testing in production" mean responsibly?

- **Expected answer** — It means accepting that no pre-production environment fully reproduces production — real data distributions, real traffic patterns, real third-party behaviour — and building controls so that production verification is safe. The tools: **feature flags** to decouple deploy from release, so code ships dark and is enabled for internal users, then 1%, then everyone, with an instant kill switch; **canary deploys** where a small percentage of traffic hits the new version while you compare error rate and latency against the baseline, with automated rollback on regression; **shadow traffic**, mirroring real requests to the new version without using its responses, which is excellent for validating a rewritten query path; **synthetic monitoring**, scripted journeys running continuously so you detect breakage before users report it; and **chaos experiments** — deliberately killing a pod, adding latency to a dependency — run in a controlled window with a hypothesis and an abort condition. The prerequisites matter more than the techniques: you need good observability to see the difference, a fast and reliable rollback, and blast-radius control so an experiment cannot take out everyone. Without those, "testing in production" is just shipping bugs to customers.

- **Why it matters** — This is where modern delivery practice and operational maturity meet.

- **Follow-ups** — What is your rollback time? How do you canary a database migration? What is the prerequisite for a chaos experiment?

- **Senior signal** — Names the prerequisites (observability, rollback, blast-radius control) rather than just listing techniques.

## 64.19 Performance

### Q229. A product manager says "the API is slow". What do you do?

- **Expected answer** — Refuse to guess, and turn it into a measurable statement first: which endpoint, for which users, at what time, and slow compared with what? Then look at the data in a fixed order. (1) Is it real and where — per-endpoint p50/p95/p99 latency over time, so you know whether it is everything (infrastructure, event loop, database, a shared dependency) or one route (a query, a new feature). (2) When did it start, and what changed then — a deploy, a config change, a data volume crossing a threshold, a traffic increase, a third-party degradation. (3) Where is the time going — a distributed trace of a slow request breaks the total into service, database, cache and external calls, which usually ends the investigation in a minute. Without tracing, fall back to per-layer metrics: database query time from `pg_stat_statements`, event loop lag, external call latency. (4) Is it latency or queueing — a saturated connection pool or worker pool shows as time waiting, not time working, and that distinction changes the fix completely. Only then form a hypothesis, test it, fix, and verify with the same metric you started from.

- **Why it matters** — Diagnostic method is the most transferable performance skill.

- **Follow-ups** — What if there is no tracing? How do you distinguish queueing from slow work? What number do you report back to the PM?

- **Senior signal** — Starts from percentiles and change correlation, and separates waiting from working.

### Q230. Why do averages lie, and which percentiles do you track?

- **Expected answer** — An average hides the shape of the distribution. If 95 requests take 20 ms and 5 take 2 seconds, the mean is 119 ms — a number no user experienced, and it looks fine on a dashboard while one in twenty users is having a terrible time. Track p50 (the typical experience), p95 and p99 (the tail, which is where timeouts, retries and abandonment live), and the max. Tail latency matters disproportionately because a single page often makes ten backend calls, so a p99 of 2 seconds means roughly one in ten page loads is slow. Track it per endpoint and per dependency, because a global percentile is dominated by whichever route has the most traffic. Two subtleties a senior adds: percentiles do not average or add — you cannot compute a service's p99 by averaging the p99s of its instances, which is why you aggregate histogram buckets rather than pre-computed percentiles; and the metric must be measured where the user is, since server-side timing excludes queueing at the load balancer, TLS handshakes and network time. Also watch the *shape*: a bimodal distribution (fast cache hits, slow misses) needs a different fix from a uniformly slow one.

- **Why it matters** — Choosing the wrong statistic makes real problems invisible.

- **Follow-ups** — Why can't you average p99s across pods? What does a bimodal latency histogram usually mean? Where exactly do you measure latency?

- **Senior signal** — The non-averageability of percentiles and the "ten calls per page" tail amplification argument.

### Q231. Walk me through fixing a slow endpoint that does too many queries.

- **Expected answer** — Confirm the count first: log or count queries per request in development, or find the fingerprint with a huge `calls` value in `pg_stat_statements`. A typical N+1 is 1 + 200 queries at 2 ms each, so 400 ms of pure round trips even though every query is "fast" — which is why the database looks healthy while the endpoint is slow. Fix in order of leverage: (1) load the related data in one query — a join with `leftJoinAndSelect`, or two queries plus an in-memory stitch when the join multiplies rows badly; (2) make sure the resulting query is indexed for its actual predicate and sort, verified with `EXPLAIN (ANALYZE, BUFFERS)` rather than assumed; (3) reduce what you select — pulling 40 columns including a 200 KB JSONB payload to render a list is a large hidden cost; (4) paginate with keyset instead of offset; (5) cache only after the query is as good as it can be, because caching a bad query hides it until the cache misses. Then guard the fix: an assertion on query count in the integration test for that endpoint, so the N+1 cannot silently return in six months.

- **Why it matters** — This is the single most common backend performance defect.

- **Follow-ups** — When is two queries better than one join? How do you assert query count in a test? Why not just add a cache?

- **Senior signal** — Adds a regression guard, and orders the fixes so caching comes last.

### Q232. My service is slow but CPU is low and the database is idle. What is happening?

- **Expected answer** — Almost always queueing somewhere. The usual suspects: a saturated database connection pool, where requests wait for a connection while the database itself is bored — visible as a non-zero `waiting` count on the pool; a saturated HTTP agent (`maxSockets` reached) queueing outbound calls; the libuv thread pool blocked by crypto or file operations; a bounded worker pool with a backlog; or an upstream dependency that is slow, so your requests sit waiting on I/O. Little's Law is the tool: `concurrency = arrival rate x service time`, so if requests take 200 ms and you receive 100 per second, you need 20 concurrent slots; with a pool of 10, half the requests wait and latency doubles. The fix is not automatically "make the pool bigger" — a bigger database pool can make things worse by contending inside Postgres. The right move is to measure where the wait is (instrument pool `waiting`, agent queue depth, event loop lag), then either reduce service time (faster query), increase capacity where it genuinely helps, or shed load with a fail-fast timeout so the queue cannot grow unbounded. An unbounded queue always converts a small slowdown into a total outage.

- **Why it matters** — Queueing effects are counter-intuitive and cause the most confusing incidents.

- **Follow-ups** — Apply Little's Law to a real number. Why can a bigger pool be worse? What does a fail-fast timeout buy you?

- **Senior signal** — Reaches for Little's Law and bounded queues with fail-fast, rather than raising limits.

### Q233. How do payload size and serialisation affect performance?

- **Expected answer** — More than people expect, because `JSON.stringify` is synchronous and blocks the event loop: serialising a 10 MB response can take tens of milliseconds during which nothing else in the process runs, so one large endpoint degrades every other request. Fixes: return less — field selection or sparse fieldsets so clients ask for what they need, pagination with sane limits, and never embed a large JSONB blob in a list response. Compression (`gzip` or `brotli`) reduces bytes on the wire substantially for JSON, but it costs CPU per response, so terminate it at the load balancer or CDN when you can rather than burning application CPU. For very large responses, stream rather than buffer — `pipeline` from a database cursor through a transform to the response keeps memory flat. Also watch `class-transformer`: `plainToInstance` on a 5,000-item array is surprisingly expensive, and a `ClassSerializerInterceptor` applied globally to a large payload is a common invisible cost. Measure the actual sizes: an endpoint whose p95 response is 2 MB is a design problem, not a tuning problem, and the honest fix is usually a narrower contract.

- **Why it matters** — Serialisation cost is invisible in query metrics and blocks the single thread.

- **Follow-ups** — Where would you enable compression and why? How would you profile serialisation cost? What is the biggest response your API returns?

- **Senior signal** — Knows `stringify` blocks the loop and that `class-transformer` on big arrays is a real cost centre.

### Q234. Where do you add a cache, and what do you check first?

- **Expected answer** — Only after the underlying operation is as fast as it reasonably can be, because a cache in front of an unindexed query hides the problem until the day the cache is cold and the database falls over. Then choose the layer by what you are caching: CDN or HTTP cache headers for public, cacheable responses (cheapest and furthest from your servers); a shared Redis cache for hot, expensive, tolerably-stale data used by all pods; a small in-process cache with a very short TTL for extremely hot keys, which absorbs the top of the distribution and cuts Redis round trips, at the cost of per-pod staleness; and a materialised view or precomputed table in Postgres for expensive aggregations. Before adding any of them, answer four questions: what is the staleness budget, how is it invalidated on write, what happens when the cache is empty or unavailable, and how will you know the hit ratio. That last one matters — a cache with a 40% hit ratio is usually a design mistake and should be visible on a dashboard, along with the load test you ran with the cache disabled to confirm the origin can survive a cold start.

- **Why it matters** — Caching is the most common source of both big wins and subtle correctness bugs.

- **Follow-ups** — What is your hit ratio and is it good? What happens when Redis restarts? How do you invalidate on a write from another service?

- **Senior signal** — The four questions as a gate, and load testing with the cache off.

### Q235. How do you reduce round trips?

- **Expected answer** — Count them first: a request that makes 12 sequential calls at 5 ms each spends 60 ms doing nothing but waiting. Techniques: **parallelise** independent calls with `Promise.all` instead of awaiting in sequence, which is often a one-line change worth 50% of the latency; **batch** — `MGET` instead of N `GET`s, Redis pipelines, a single `WHERE id = ANY($1)` instead of N selects, and a DataLoader-style per-request batcher that coalesces lookups automatically; **denormalise** the read path so one query returns what a screen needs rather than five; **co-locate** — keep chatty services in the same availability zone, since a cross-AZ hop is around 1 ms and a cross-region hop 80–150 ms, which makes a chatty design unusable across regions; and **keep connections warm** with keep-alive agents so you are not paying handshakes. The senior addition is knowing when *not* to parallelise: firing 200 concurrent database queries from one request is a good way to exhaust the pool and hurt every other request, so bound the concurrency (a `p-limit` style semaphore) and be explicit about the limit.

- **Why it matters** — Round trips dominate latency in distributed systems, and the fixes are cheap.

- **Follow-ups** — Where would `Promise.all` be dangerous? How does DataLoader work? What is the latency cost of a cross-region call?

- **Senior signal** — Bounds the concurrency when parallelising, and quotes real per-hop latency numbers.

### Q236. What causes tail latency, and how do you attack it?

- **Expected answer** — The tail is rarely the same cause as the median. Common sources: garbage collection pauses; event loop blocking from a synchronous operation on some requests (a large payload, a slow regex); queueing behind a saturated pool; a cold cache or a first-request-after-eviction; a slow shard, a hot key or a hot row in the database; a lock wait; connection setup on a cold keep-alive pool; DNS timeouts; noisy neighbours and CPU throttling in a container; and retries — a request that timed out at 1 second and retried appears as a 2-second request. The attack: instrument enough to attribute the tail (traces sampled to include slow requests specifically — tail-based sampling exists for exactly this), then treat each cause on its merits. Structural remedies worth knowing: hedged requests (send a second request to another replica if the first is slower than p95 and take the first answer) trade a few percent extra load for a much better tail; bounded queues with fail-fast so a slow path does not accumulate; per-dependency timeouts tighter than the overall request budget; and reducing variance at the source, since the tail is usually variance rather than mean slowness.

- **Why it matters** — Tail latency is what users and downstream services actually feel.

- **Follow-ups** — How do you make sure your traces include the slow requests? When are hedged requests a bad idea? How does a retry show up in your latency histogram?

- **Senior signal** — Tail-based sampling and hedged requests, plus recognising retries as a tail contributor.

### Q237. How do garbage collection and memory affect latency in Node?

- **Expected answer** — Minor (scavenge) collections are frequent and cheap, typically well under a millisecond; major mark-compact collections are less frequent and can pause for tens of milliseconds on a large heap, which lands directly in your p99. So the practical levers are about allocation rate and heap size rather than GC flags. Reduce allocation: avoid creating large temporary arrays and objects per request, do not deep-clone big payloads, reuse Buffers where sensible, and stream instead of materialising. Watch heap growth: a heap that keeps climbing means either a leak or an in-process cache with no bound, and as the heap grows major GC pauses grow with it — this is why an unbounded in-memory cache degrades latency long before it causes an OOM. Instrument it: export `heapUsed`, `heapTotal`, RSS and GC pause time (via `perf_hooks` `PerformanceObserver` on the `gc` entry type) and correlate GC pauses with latency spikes; if 40 ms of every second is GC, you have found your tail. Sizing: set `--max-old-space-size` to about 75–80% of the container limit, and prefer more smaller instances over one huge heap, because a 4 GB heap has worse pause characteristics than four 1 GB heaps.

- **Why it matters** — GC is an invisible latency source that people blame on the database.

- **Follow-ups** — How would you prove GC is causing a latency spike? Why prefer smaller heaps? What allocates most in a typical request?

- **Senior signal** — Measures GC pause time as a metric and prefers smaller heaps for pause behaviour.

### Q238. How do you do capacity planning and protect a service under overload?

- **Expected answer** — Planning: measure the per-instance capacity by load testing to the point where latency degrades (not to the point of failure), take that as the safe throughput, and size for peak with headroom — typically 30–40% — so that a node loss or a traffic surge does not immediately breach the SLO. Account for the real peak (campaigns, month-end, a marketing email) rather than the daily average, and revisit as the data grows, since capacity per instance falls as tables grow. Protection under overload matters just as much, because demand eventually exceeds capacity: **load shedding** — reject excess requests quickly with 429 or 503 plus `Retry-After` rather than accepting everything and timing out, since a queue of doomed requests is worse than a fast rejection; **priority** — shed low-value traffic first (background sync, analytics, non-critical endpoints) and protect checkout and login; **bounded queues** everywhere so backlogs cannot grow without limit; **circuit breakers and bulkheads** so a failing dependency cannot consume all capacity; and **autoscaling** with the understanding that it takes minutes, so shedding covers the gap. The principle to state: a system that degrades predictably under overload is far more valuable than one that is slightly faster and collapses.

- **Why it matters** — Graceful degradation under overload is a defining senior/SRE concern.

- **Follow-ups** — What do you shed first and how do you decide? Why is rejecting better than queueing? How much headroom do you keep and why?

- **Senior signal** — Explicit load shedding with prioritisation, and headroom justified by failure scenarios.

