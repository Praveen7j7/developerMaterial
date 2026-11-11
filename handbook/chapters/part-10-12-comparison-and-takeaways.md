## 10.18 Choosing the right structure

Sixteen structures is a lot to hold in your head during a design review. This section compresses them into three tables you can use at the whiteboard: what each structure is for and what replaces it when a single process is no longer enough; the complexity numbers side by side; and the production symptoms that point back at a data-structure mistake.

### 10.18.1 Structure, use, anti-use, and what replaces it at scale

"At scale" here means one or more of: the data must survive a restart, must be shared between pods, or no longer fits in one process. The right-hand column names the durable, shared version of the same idea.

| Structure | Typical backend use | When NOT to use it | What replaces it at scale |
|---|---|---|---|
| Array | result pages, batches, ring buffers of samples, bulk-insert chunks | as a queue (`shift`), for membership tests (`includes`), when the database controls its size | keyset-paginated queries, streams, Kafka partitions (an append-only array on disk) |
| String / Buffer | keys, JSON, SQL text, log lines, response bodies | building large bodies with `+=` or `join`; storing substrings of large payloads | streamed responses, cached serialized `Buffer`s, object storage for blobs |
| Linked list | LRU recency order, in-flight registries, stream chunk buffers, idle-connection lists | indexed access, search by value, small n (arrays win), ordering rows in SQL by `next_id` | Redis lists, `position` columns with a unique index |
| Stack | recursion made iterative, savepoints, undo, DFS, interceptor unwinding | anything FIFO; deep recursion over user-controlled data | PostgreSQL savepoints, explicit stacks in the heap |
| Queue | decoupling producers from consumers, batching, job systems | in-process for work that must not be lost; unbounded buffers | BullMQ on Redis, RabbitMQ, Kafka, PostgreSQL `SKIP LOCKED` tables |
| Deque | sliding windows, recent-N buffers, rate-limit logs, front-of-line retries | touching the middle; per-key deques with unbounded keys | Redis lists with `LTRIM`, sorted sets for sliding windows |
| Hash map | lookup by id, sessions, feature flags, routing, in-memory joins, single-flight | keys controlled by outsiders without a bound; plain objects as dictionaries; cluster-wide truth | Redis hashes and keys, PostgreSQL hash and B-tree indexes |
| Set | de-duplication, membership, roles, visited sets | uniqueness across pods or time; objects by value | unique indexes with `ON CONFLICT`, Redis sets, `SET NX`, HyperLogLog for counts |
| Tree | categories, org charts, threads, JSON, plan trees, module graphs | loading whole user-sized trees; N+1 per node; nested sets on write-heavy data | `ltree` with GiST, recursive CTEs with depth limits, closure tables |
| BST / ordered map | range queries, next-slot lookups, ordered iteration in memory | hand-written unbalanced trees; sorted input; shared ordered data | PostgreSQL B-tree indexes, Redis sorted sets, sorted arrays with binary search |
| Heap | top-k, k-way merge, timers, schedulers | searching or iterating in order; durable schedules | `ORDER BY ... LIMIT` with an index, Redis sorted sets, BullMQ delayed jobs |
| Priority queue | dispatch by deadline, retry by importance, SLA ordering | one shared queue with no protection for low priorities; client-chosen priority | per-class queues with reserved capacity, Redis `ZPOPMIN`, jobs tables with `(priority, run_at)` |
| Trie | autocomplete, routing tables, longest-prefix match | exact-match-only workloads; whole-name keys with no depth cap; subtree walks per request | `text_pattern_ops` and `pg_trgm` indexes, RediSearch suggestions, Elasticsearch completion |
| Graph | dependencies, workflows, social and service graphs, routing | ORM relation loading for traversal; unbounded depth; supernodes without caps | edge tables with both indexes, bounded recursive CTEs, precomputed neighbourhoods, graph databases |
| Bloom filter | cache-penetration guard, "seen it" at huge scale, skipping storage segments | exact answers, deletes, granting access on "probably" | RedisBloom, PostgreSQL `bloom` index, HyperLogLog for counting |
| LRU cache | per-pod read caches, session fronts, negative caches | no TTL, no capacity, shared with bulk scans, no hit-rate metric | Redis with `allkeys-lru` or `allkeys-lfu`, PostgreSQL `shared_buffers`, CDN caches |

### 10.18.2 Complexity side by side

Average-case costs for the operations that dominate backend workloads. The "ordered range" column is the one that separates hash-based from tree-based structures.

| Structure | Lookup by key | Insert | Delete | Membership | Ordered range / next | Memory per item (approx.) |
|---|---|---|---|---|---|---|
| Array (unsorted) | O(1) by index | O(1) append | O(n) | O(n) | O(n log n) sort first | 8 bytes + item |
| Sorted array | O(log n) | O(n) | O(n) | O(log n) | O(log n + k) | 8 bytes + item |
| Linked list | O(n) | O(1) at ends or by handle | O(1) by handle | O(n) | O(n) | 48 bytes + item |
| Ring queue / deque | O(1) at ends | O(1) | O(1) at ends | O(n) | not supported | 8 bytes + item |
| Hash map / Set | O(1) | O(1) | O(1) | O(1) | not supported | 40 to 60 bytes + key + value |
| Balanced BST | O(log n) | O(log n) | O(log n) | O(log n) | O(log n + k) | 56 bytes + key + value |
| B-tree (PostgreSQL) | O(log_f n), 3 to 4 pages | O(log_f n) | O(log_f n) | O(log_f n) | O(log_f n + k), sequential leaves | about 20 bytes per entry on disk |
| Heap | O(1) min only | O(log n) | O(log n) min only | O(n) | not supported | 8 bytes + item |
| Trie | O(L) | O(L) | O(L) | O(L) | prefix in O(L + k) | 250 bytes per node |
| Graph (adjacency list) | O(1) vertex | O(1) edge | O(1) edge | O(1) with `Set` | traversal O(V + E) | 150 bytes per vertex, 40 per edge |
| Bloom filter | not supported | O(k) | not supported | O(k), probabilistic | not supported | about 1.2 bytes per item at 1 percent |
| LRU cache | O(1) | O(1) | O(1) | O(1) | recency order O(n) | 150 bytes + key + value |

### 10.18.3 From production symptom to data structure

Most data-structure incidents announce themselves with one of a handful of graphs. Learn to read them backwards.

| Symptom on the dashboard | Likely structural cause | First thing to check |
|---|---|---|
| CPU grows with data size while RPS is flat | O(n) scan inside a loop (`includes`, `find`, `indexOf`, `shift`, `sort` per insert) | profile with `--cpu-prof`; look for array methods in hot frames |
| Memory grows linearly with uptime | unbounded `Map`, `Set`, array or queue keyed by external data | heap snapshot; find the largest retained collection |
| GC pauses of 100 ms or more | giant `Map` or array resizes, millions of small long-lived objects | `--trace-gc`; check collection sizes and node object counts |
| Redis latency spikes for every client | O(n) command on a big list, hash or set (`LRANGE 0 -1`, `HGETALL`, `SMEMBERS`, `KEYS`) | `SLOWLOG GET`; replace with `LLEN`, `HSCAN`, `SSCAN` |
| PostgreSQL connection pool exhausted, database idle | N+1 loading of a tree or graph (one query per node) | query count per request in logs; batch with `ANY($1)` or a CTE |
| Database CPU pinned by one query | unbounded traversal (two-hop join on a supernode, recursive CTE without depth limit) | `pg_stat_activity`; add `statement_timeout`, depth and degree caps |
| Cache hit rate collapses with no deploy | a scan (export, backfill, crawler) flushing an LRU | correlate with job schedules; add bypass or a separate cache |
| False 404s for new rows | stale Bloom filter or stale per-pod snapshot | watermark on new ids; rebuild interval; pub/sub health |
| Low-priority work never completes | starvation in a single priority queue | per-class oldest-job age; reserved capacity or aging |
| Duplicate charges or e-mails after scaling out | per-pod `Set` or `Map` used as cluster-wide truth | move to a unique index or Redis atomic operation |
| Requests hang forever | cycle in a linked structure or graph walked without a visited set | `CYCLE` clause, visited sets, step budgets |
| `RangeError: Maximum call stack size exceeded` | recursion over user-controlled depth or a data cycle | explicit stack, cycle guard, depth limit |
| `RangeError: Invalid string length` or OOM during export | building a huge string or array instead of streaming | stream with backpressure; keyset pagination |

### 10.18.4 A decision path for the whiteboard

```text
What is the dominant operation?
  |
  +-- "give me item i" or "append"           -> Array (bounded) / typed array
  +-- "is X present?" / "value for key X"    -> Hash map / Set
  |       +-- across pods or time?           -> unique index / Redis SET / SET NX
  |       +-- huge and approximate is fine?  -> Bloom filter (HyperLogLog for counts)
  +-- "oldest first"                         -> Queue (ring buffer) -> BullMQ / Kafka / SKIP LOCKED
  +-- "most recent first"                    -> Stack / Deque
  +-- "most urgent first"                    -> Heap / Priority queue -> Redis ZSET / (priority, run_at) index
  +-- "everything between A and B" / "next"  -> Sorted array / B-tree index / Redis ZSET
  +-- "everything starting with P"           -> Trie / text_pattern_ops index / RediSearch
  +-- "what is under / above this node"      -> Tree: ltree, recursive CTE, closure table
  +-- "how are these things connected"       -> Graph: edges table + both indexes, bounded traversal
  +-- "remember recent answers, bounded"     -> LRU cache -> Redis allkeys-lru
  +-- "unlink this exact item fast"          -> Doubly linked list (usually inside an LRU)

Then ask, for the chosen structure:
  Who controls n?           (code, user, database, upstream)
  Where does it live?       (request, process, Redis, PostgreSQL, Kafka)
  What bounds it?           (capacity, TTL, LIMIT, depth, degree, body size)
  Can it be wrong?          (stale, approximate, per-pod)  In which direction is wrong safe?
  How do I see it?          (size, age of oldest, hit rate, evictions, drops)
```

## Senior Checklist — Part 10

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
- [ ] I can state the best, average and worst-case cost of every operation I put on a request path, and I know who controls n
- [ ] I can explain V8 elements kinds, hidden classes and dictionary mode, and I keep records as objects and dictionaries as `Map`s
- [ ] I measure strings in the right unit (bytes, code units, code points) and I stream anything whose size the user or the database controls
- [ ] I can implement a ring-buffer queue, a deque, a binary heap, a trie with per-node top-k, a Bloom filter and an LRU cache from memory, with tests
- [ ] I never use `shift`, `unshift`, `includes`, `indexOf`, `splice` or `sort` inside a hot loop without checking n
- [ ] I bound every in-process collection keyed by external data with a capacity, a TTL or a sweep, and I export its size and hit rate as metrics
- [ ] I can read `top-N heapsort`, `Hash Join ... Batches`, `HashAggregate`, `Bitmap Heap Scan ... Recheck` and `Index Scan ... Buffers` in `EXPLAIN` output and name the data structure behind each
- [ ] I know why PostgreSQL indexes are B-trees and can find an index's height with `bt_metap`
- [ ] I can pick the right durable replacement (unique index, `SKIP LOCKED` table, Redis list, set, sorted set, RedisBloom, BullMQ, Kafka) and explain what changes when I do
- [ ] I recognise scan pollution, cache stampedes, starvation, supernodes, N+1 recursion and stale probabilistic filters from their dashboard symptoms
- [ ] I design probabilistic structures so they can only be wrong in the safe direction, and I write down what a wrong answer costs
- [ ] I refuse per-pod `Set`s and `Map`s as cluster-wide truth for anything involving money, uniqueness or rate limits

## Part 10 — Key Takeaways

- Data-structure mistakes are silent until n gets large, and n gets large in production, at night; always ask who controls n.
- In Node.js every O(n) on the request path is paid by every concurrent request on one thread; a 30 ms scan at 500 RPS is fifteen cores you do not have.
- Arrays are for bounded, indexed, appended data; membership belongs to a `Set`, ordering to a heap or a B-tree, and "remove from the front" to a real queue.
- Strings are UTF-16 code units in memory and UTF-8 bytes on the wire; measure in the unit the constraint uses, and stream anything large.
- A linked list earns its 48 bytes per node only when you hold node handles and need O(1) unlink; inside an LRU, yes; as a list you search, no.
- Every queue needs an overflow policy, an idempotent consumer and an alert on the age of its oldest item; every priority queue also needs protection for its lowest class.
- Use objects for records with a fixed shape and `Map` for dictionaries; bound every map keyed by outside data or it becomes a memory leak with a delay measured in days.
- Uniqueness across pods and time is a unique index or a Redis atomic operation, never an in-process `Set`.
- Databases use B-trees because page-sized nodes give height 3 or 4 for hundreds of millions of keys; in memory, a sorted array plus binary search usually beats a hand-written tree.
- Top-k is a heap of size k, merging sorted sources is a k-way heap merge, and `ORDER BY ... LIMIT` is PostgreSQL doing exactly that; give it an index so it can stop early.
- Prefix questions belong to tries and sorted indexes; cache the answer at the node and never walk a subtree per request.
- Graph traversal cost is the product of degrees along the path; bound depth, cap degree, precompute for supernodes, and validate DAGs for cycles at definition time.
- A Bloom filter is fifty times smaller than a set and wrong only in one direction; design so that direction is the safe one, and remember that staleness is the false negative you actually get.
- An LRU cache is a hash map plus a linked list, and a cache is a promise about staleness and memory: write both numbers down, graph the hit rate, and keep bulk scans out of it.
- The simplest structure that meets the requirement wins, and the durable version (PostgreSQL, Redis, Kafka) wins the moment data must survive a restart or be shared between pods.
