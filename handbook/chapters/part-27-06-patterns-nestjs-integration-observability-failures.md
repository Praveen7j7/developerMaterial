## 27.12 Everyday Redis patterns in a NestJS backend

These are the five things almost every production NestJS service ends up putting in Redis. Each one is short because the structures were covered above; the value here is the shape that survives production.

### 27.12.1 Session store

#### Concept

A session is server-side state tied to a session id in a cookie. Redis is the standard session store because every pod must see the same session, reads happen on every request, and sessions expire naturally.

#### How it works

The session id is a random 128-bit value; the Redis key is `sess:v1:{id}`; the value is a JSON hash of user id, roles, CSRF token and issued-at; the TTL is the idle timeout, refreshed on access (sliding) or fixed (absolute). Logout deletes the key. "Log out everywhere" needs an index: a set `user:sessions:{userId}` of session ids, deleted together.

```ts
// auth/session-store.service.ts
@Injectable()
export class SessionStore {
  private readonly ttlMs = 30 * 60 * 1000; // 30 min idle timeout
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(userId: string, data: SessionData): Promise<string> {
    const sid = randomBytes(32).toString('base64url');
    await this.redis.multi()
      .set(`sess:v1:${sid}`, JSON.stringify({ userId, ...data, issuedAt: Date.now() }), 'PX', this.ttlMs)
      .sadd(`user:sessions:${userId}`, sid)
      .expire(`user:sessions:${userId}`, 30 * 86_400)
      .exec();
    return sid;
  }

  // GETEX reads and slides the TTL in one round trip.
  async touch(sid: string): Promise<SessionData | null> {
    const raw = await this.redis.getex(`sess:v1:${sid}`, 'PX', this.ttlMs);
    return raw ? JSON.parse(raw) : null;
  }

  async revokeAll(userId: string): Promise<void> {
    const sids = await this.redis.smembers(`user:sessions:${userId}`); // bounded: a user has few sessions
    if (sids.length) await this.redis.unlink(...sids.map((s) => `sess:v1:${s}`), `user:sessions:${userId}`);
  }
}
```

A session store is a store, not a cache: `noeviction` and AOF persistence, on its own Redis instance. With `allkeys-lru` a busy day logs users out at random, and that incident is common enough to deserve its own sentence.

### 27.12.2 Idempotency-key store

#### Concept

An idempotency key lets a client safely retry `POST /payments` without creating two payments. The server remembers the key, the request fingerprint and the response, and replays the response for a repeat.

#### How it works

1. On request: `SET idem:v1:{key} {status:"processing"} NX PX 86400000`. If `nil`, another request with this key is in flight or done: read the stored value; if `processing`, return 409; if complete, return the stored response.
2. Process the request. Store `{ status: "done", fingerprint, statusCode, body }` under the same key.
3. If processing fails with a non-retryable error, store the error response too. If it fails with a transient error, delete the key so the client can retry.
4. The window is the TTL (24 hours is common). A retry after that creates a new operation; document it.

For payments and orders, the idempotency record belongs in PostgreSQL in the same transaction as the business write (Part 30 — Distributed Transactions: Sagas, Outbox, Inbox and Idempotency covers the inbox table). Redis is fine as a fast first check in front of it, and sufficient on its own for non-financial operations.

```ts
// idempotency/idempotency.interceptor.ts (excerpt)
async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
  const req = ctx.switchToHttp().getRequest();
  const key = req.headers['idempotency-key'];
  if (!key) return next.handle();
  const redisKey = `idem:v1:${req.user.id}:${key}`;      // scope to the caller so keys cannot collide across users
  const claimed = await this.redis.set(redisKey, JSON.stringify({ status: 'processing' }), 'PX', 86_400_000, 'NX');
  if (claimed !== 'OK') {
    const stored = JSON.parse((await this.redis.get(redisKey)) ?? '{}');
    if (stored.status === 'processing') throw new ConflictException('Request in progress');
    ctx.switchToHttp().getResponse().status(stored.statusCode);
    return of(stored.body);                                  // replay
  }
  return next.handle().pipe(
    tap(async (body) => this.redis.set(redisKey, JSON.stringify({ status: 'done', statusCode: 201, body }), 'PX', 86_400_000)),
    catchError(async (err) => { await this.redis.del(redisKey); throw err; }),
  );
}
```

### 27.12.3 Feature flags and config cache

#### Concept

Flags and configuration are tiny, read on every request, and changed rarely by humans. They are the textbook hot key, so the pattern is the two-level cache from 27.6: a hash in Redis (`flags:v1` with one field per flag), a 2 second in-process cache, and a Pub/Sub broadcast on change.

```ts
// flags/flags.service.ts
@Injectable()
export class FlagsService implements OnModuleInit {
  private local: Record<string, string> = {};
  private loadedAt = 0;
  constructor(@Inject(REDIS) private readonly redis: Redis, @Inject(REDIS_SUBSCRIBER) private readonly sub: Redis) {}

  async onModuleInit() {
    await this.sub.subscribe('flags:changed');
    this.sub.on('message', () => { this.loadedAt = 0; });     // force reload on next read
  }

  async isEnabled(name: string, userId?: string): Promise<boolean> {
    if (Date.now() - this.loadedAt > 2000) {
      try { this.local = await this.redis.hgetall('flags:v1'); this.loadedAt = Date.now(); }
      catch { /* keep the last known flags: fail open to the previous state */ }
    }
    const raw = this.local[name];
    if (!raw) return false;
    const flag = JSON.parse(raw) as { enabled: boolean; percentage?: number };
    if (!flag.enabled) return false;
    if (flag.percentage === undefined || !userId) return flag.enabled;
    const bucket = parseInt(createHash('sha1').update(`${name}:${userId}`).digest('hex').slice(0, 8), 16) % 100;
    return bucket < flag.percentage;                          // stable per user, spreads evenly
  }
}
```

The source of truth for flags is a `feature_flags` table in PostgreSQL edited through an admin endpoint that writes the row, updates the hash and publishes. Redis is the distribution mechanism, not the store.

### 27.12.4 Leaderboards

The ZSET from 27.8.4, with three production details: use `ZADD ... GT` so a lower score never overwrites a higher one when events arrive out of order; keep one ZSET per period (`lb:weekly:2026-W36`) with a TTL so old boards expire; and page with `ZRANGE ... REV LIMIT offset count` plus `MGET` for display names rather than storing names in the ZSET.

```ts
async recordScore(period: string, userId: string, score: number): Promise<void> {
  await this.redis.multi().zadd(`lb:${period}`, 'GT', score, userId).expire(`lb:${period}`, 60 * 86_400).exec();
}

async top(period: string, offset = 0, count = 20) {
  const rows = await this.redis.zrange(`lb:${period}`, offset, offset + count - 1, 'REV', 'WITHSCORES');
  const out: { userId: string; score: number; rank: number }[] = [];
  for (let i = 0; i < rows.length; i += 2) out.push({ userId: rows[i], score: Number(rows[i + 1]), rank: offset + i / 2 + 1 });
  return out;
}

async rankOf(period: string, userId: string): Promise<number | null> {
  const r = await this.redis.zrevrank(`lb:${period}`, userId);
  return r === null ? null : r + 1;
}
```

## 27.13 NestJS integration

### 27.13.1 `CacheModule`, `CacheInterceptor` and their limits

#### Concept

`@nestjs/cache-manager` wraps the `cache-manager` library and gives you an injectable `Cache` plus an interceptor that caches whole HTTP responses. With a Redis store it is the quickest way to cache read endpoints, and the quickest way to leak one user's data to another if you do not understand its keying.

#### How it works

The module is configured with a Keyv Redis store (cache-manager v6 and `@nestjs/cache-manager` v3):

```ts
// app.module.ts
import { CacheModule } from '@nestjs/cache-manager';
import { Keyv } from 'keyv';
import KeyvRedis from '@keyv/redis';

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => ({
        stores: [new Keyv({ store: new KeyvRedis(process.env.REDIS_URL), namespace: 'app' })],
        ttl: 60_000, // ms
      }),
    }),
  ],
})
export class AppModule {}
```

`CacheInterceptor` applied to a controller or route caches responses for `GET` requests, keyed by the request URL (path plus query string), for the TTL from `@CacheTTL()` or the module default, under the key from `@CacheKey()` if given.

```ts
@Controller('products')
@UseInterceptors(CacheInterceptor)
export class ProductsController {
  @Get(':id')
  @CacheTTL(300_000)
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.products.findOne(id); }

  @Get('top')
  @CacheKey('products:top')   // fixed key: every query-string variant shares it, which may or may not be what you want
  @CacheTTL(30_000)
  top() { return this.products.top(); }
}
```

Its limitations, each of which has caused a real incident:

- **Keyed by URL only.** An endpoint whose response depends on the `Authorization` header, an `Accept-Language` header or a tenant header serves user A's data to user B. Override `trackBy(context)` in a subclass to include the user id, or do not use the interceptor on authenticated endpoints.
- **Caches the whole response body**, including errors if your handler returns them as values rather than throwing. Only `GET` is cached by default (`isRequestCacheable` is overridable), which is correct.
- **No invalidation hook.** Writes must call `cache.del(key)` with the exact key the interceptor built, which for URL-keyed entries is the request path. Teams get this wrong and end up relying on TTL alone.
- **No stampede protection, no negative caching, no jitter.** Ten pods and a hot endpoint expire together.
- **Serializes with JSON** and stores whatever the handler returned; `Date` fields come back as strings, `BigInt` throws.

The senior position: use `CacheInterceptor` for public, unauthenticated, URL-determined read endpoints (category trees, public product pages, static lists). For everything else, cache in the service with `ioredis` where the key includes exactly the inputs that determine the output.

### 27.13.2 A custom `RedisModule` with `ioredis`

#### How it works

Three connections with different roles, configured from environment, with the client options that determine behaviour during an outage.

```ts
// redis/redis.module.ts
import { Global, Module, Logger, OnApplicationShutdown, Inject } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';

export const REDIS = Symbol('REDIS');                     // general commands
export const REDIS_SUBSCRIBER = Symbol('REDIS_SUBSCRIBER'); // Pub/Sub only
export const REDIS_BLOCKING = Symbol('REDIS_BLOCKING');     // BRPOP, XREADGROUP BLOCK

function options(): RedisOptions {
  return {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    connectTimeout: 2000,
    commandTimeout: 250,          // a cache call slower than this is a miss, not a wait
    maxRetriesPerRequest: 1,      // fail fast; the app decides what to do
    enableOfflineQueue: false,    // do not buffer commands while disconnected; fail immediately
    keepAlive: 10_000,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(50 * 2 ** attempt, 5000), // reconnect with capped backoff
    reconnectOnError: (err) => err.message.includes('READONLY'),    // after a failover, reconnect to the new primary
  };
}

function createClient(role: string): Redis {
  const logger = new Logger(`Redis:${role}`);
  const client = new Redis(role === 'blocking' ? { ...options(), commandTimeout: undefined } : options());
  client.on('error', (err) => logger.error(err.message));
  client.on('reconnecting', () => logger.warn('reconnecting'));
  client.on('ready', () => logger.log('ready'));
  return client;
}

@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: () => createClient('main') },
    { provide: REDIS_SUBSCRIBER, useFactory: () => createClient('subscriber') },
    { provide: REDIS_BLOCKING, useFactory: () => createClient('blocking') },
  ],
  exports: [REDIS, REDIS_SUBSCRIBER, REDIS_BLOCKING],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly main: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly sub: Redis,
    @Inject(REDIS_BLOCKING) private readonly blocking: Redis,
  ) {}

  // Graceful shutdown: QUIT waits for pending replies; disconnect() would drop them.
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.main.quit(), this.sub.quit(), this.blocking.quit()]);
  }
}
```

Why these options matter:

- **`commandTimeout: 250`**: without it, a stalled Redis (blocked by a slow command, or a network black hole) makes every request wait for the TCP timeout, which is minutes. With it, the cache path fails in 250 ms and falls through to PostgreSQL. Blocking commands need it disabled.
- **`enableOfflineQueue: false`**: with the default `true`, commands issued while disconnected queue in memory and all fire at once on reconnect, which is a thundering herd against a recovering Redis and a memory leak during a long outage.
- **`maxRetriesPerRequest: 1`**: ioredis retries a command on reconnect up to this many times. For a cache, failing fast is better than retrying.
- **Connection pool**: `ioredis` multiplexes all commands on one TCP connection, which is what Redis prefers. You do not need a pool for ordinary commands; you need separate connections only for subscribers and blocking commands, which is why the module has three. In Cluster mode, `new Redis.Cluster([...], { redisOptions: options() })` manages one connection per node.
- **Remember to call `app.enableShutdownHooks()`** in `main.ts`, or `onApplicationShutdown` never runs.

### 27.13.3 Health checks

Terminus has no Redis indicator built in; write one with `HealthIndicatorService`. Decide whether Redis is part of readiness: for a pure cache it usually is not (the app works without it), for a session store it is.

```ts
// health/redis.health.ts
import { Injectable, Inject } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

@Injectable()
export class RedisHealthIndicator {
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly his: HealthIndicatorService) {}

  async isHealthy(key = 'redis') {
    const indicator = this.his.check(key);
    const start = Date.now();
    try {
      await this.redis.ping();
      return indicator.up({ latencyMs: Date.now() - start, status: this.redis.status });
    } catch (err) {
      return indicator.down({ error: (err as Error).message, status: this.redis.status });
    }
  }
}
```

### 27.13.4 Circuit breaking to Redis

#### Concept

When Redis is degraded, every cache call pays the 250 ms timeout before falling through. At 1,000 RPS that is 250 concurrent requests waiting on nothing. A circuit breaker counts failures and, past a threshold, skips Redis entirely for a cooling-off period, then probes.

```ts
// redis/redis-circuit.ts: a small breaker; the opossum library does this with metrics if you prefer
export class RedisCircuit {
  private failures = 0;
  private openUntil = 0;
  constructor(private readonly threshold = 5, private readonly cooldownMs = 10_000) {}

  async run<T>(op: () => Promise<T>, fallback: () => T): Promise<T> {
    if (Date.now() < this.openUntil) return fallback();       // open: skip Redis
    try {
      const result = await op();
      this.failures = 0;                                        // success closes the circuit
      return result;
    } catch {
      if (++this.failures >= this.threshold) this.openUntil = Date.now() + this.cooldownMs;
      return fallback();
    }
  }
}
// usage: this.circuit.run(() => this.redis.get(key), () => null)
```

Expose the breaker state as a metric (`redis_circuit_open` 0 or 1). An open circuit means PostgreSQL is taking 100 percent of reads; you want to know immediately.

## 27.14 Observability

#### Concept

A cache you cannot measure is a cache you cannot trust. The four numbers on a Redis dashboard are hit ratio, latency, evictions and memory. Everything else is context.

#### How it works

From `INFO` (and exported by `redis_exporter` to Prometheus):

| Metric | Source | Healthy | Alert | Meaning |
|---|---|---|---|---|
| Hit ratio | `keyspace_hits / (keyspace_hits + keyspace_misses)`; exporter `redis_keyspace_hits_total`, `redis_keyspace_misses_total` | 90 to 99 percent for a catalog cache | Drops 10 points in 5 min | Cold cache, key version change, penetration attack, or TTL too short |
| Latency (client side) | Histogram around every `ioredis` call in your app | p99 under 2 ms same AZ | p99 over 10 ms | Slow command blocking, network, CPU saturation |
| Server-side latency | `LATENCY LATEST`, `latency-monitor-threshold 10` | Empty | Any event over 10 ms | Blocking command, fork, AOF fsync stall |
| Evictions | `evicted_keys`; exporter `redis_evicted_keys_total` | 0 for a store; low and steady for a cache | Sudden rise | At `maxmemory`; working set larger than memory |
| Expired keys | `expired_keys` | Steady | Spike | Avalanche in progress |
| Memory | `used_memory`, `maxmemory`; exporter `redis_memory_used_bytes`, `redis_memory_max_bytes` | Under 80 percent of maxmemory | Over 90 percent | Approaching eviction or OOM |
| Fragmentation | `mem_fragmentation_ratio` | 1.0 to 1.5 | Over 1.5 or under 1.0 | Fragmentation (enable `activedefrag`) or swapping |
| Clients | `connected_clients`, `blocked_clients`, `rejected_connections` | Stable | `rejected_connections` rising | Hit `maxclients`; connection leak in the app |
| Replication | `master_repl_offset` minus replica offset; `master_link_status` | Lag under 1 MB | Link down | Replica behind; failover would lose data |
| Slowlog | `SLOWLOG GET 25` (`slowlog-log-slower-than 10000` microseconds) | Empty | Any entry | The command name tells you the culprit |
| Keyspace | `INFO keyspace`: keys and keys with expires per db; exporter `redis_db_keys`, `redis_db_keys_expiring` | Keys with expires equals keys, for a cache | Keys without TTL growing | Someone is `SET`ting without `PX` |
| Ops per second | `instantaneous_ops_per_sec`; exporter `redis_commands_processed_total` | Depends | Sudden drop to zero | Redis blocked or app disconnected |

Instrumenting the app side is the part people skip. Wrap the client so every call records duration and outcome with the command name as a label; a `redis_client_duration_seconds` histogram and a `redis_client_errors_total` counter answer "is it Redis or is it us" in one glance. Also count hits and misses per key namespace (`cache_requests_total{namespace="products",result="hit"}`), because a global hit ratio hides a single broken namespace.

#### Production scenario

A dashboard shows hit ratio falling from 96 percent to 71 percent over ten minutes with no deploy. `redis_db_keys_expiring` is flat, `evicted_keys` is climbing at 400 per second, memory is pinned at `maxmemory`. Someone has started caching search results keyed by raw query string: cardinality exploded, evictions pushed out the product keys, and PostgreSQL CPU doubled. The namespace metric points at `search:*` in one query. The fix is a hashed, canonicalized key with a 60 second TTL, and a per-namespace memory budget checked in review.

## 27.15 Edge cases and failure modes

Each entry: what happens, how you notice, what to do.

- **Redis unavailable, cache use case.** Reads fall through to PostgreSQL. Fail open with a short `commandTimeout`, a circuit breaker and a load test that proves PostgreSQL survives 100 percent of traffic for the outage duration, or add a longer-TTL L1 to absorb it.
- **Redis unavailable, rate limiter.** Decide per endpoint: public reads fail open, auth and payment endpoints fail closed with a 503 and an alert.
- **Redis unavailable, locks.** Fail closed. "Could not acquire lock" means skip the run, never "run anyway".
- **Redis unavailable, session store.** Every user is effectively logged out. This is why the session store gets Sentinel or Cluster with replicas and AOF, and why readiness depends on it.
- **Stale cache after a failed invalidation.** A `DEL` that failed during a Redis blip leaves an old value until TTL. Log failed deletes at error level, retry them from an outbox-style table, and keep the TTL short enough that the business tolerates the window.
- **Hot key.** One shard at 100 percent CPU while others idle; `--hotkeys` names it. L1 cache with short TTL, key replication across slots, coalescing.
- **Stampede after deploy (cold cache).** A version bump or a Redis restart empties the cache and PostgreSQL takes the full miss storm. Warm-up in `onApplicationBootstrap`, gated readiness, single-flight, and never `FLUSHALL`.
- **Eviction storm at `maxmemory`.** `evicted_keys` climbs, hit ratio collapses, PostgreSQL load rises. Find the namespace that grew, fix its cardinality or TTL, raise `maxmemory` if the working set legitimately grew.
- **`noeviction` OOM write errors.** Writes fail with `OOM command not allowed`. Reads still work, so the app looks half alive: sessions cannot be created, idempotency keys cannot be claimed. Alert on memory over 85 percent long before this, and handle the error explicitly (for a session store, that is a 503; for a cache, that is a skipped `SET`).
- **Big key blocking.** `SLOWLOG` shows `DEL` or `SMEMBERS` at 300 ms; every client sees timeouts simultaneously. `UNLINK`, lazy freeing, split the key, cap value sizes at write time.
- **Cluster `MOVED` / `ASK` errors.** A non-cluster client, or a client with a stale slot map during resharding. Use `Redis.Cluster`, which follows redirections; if errors persist after a resharding, restart clients so they refresh.
- **Cluster `CROSSSLOT` errors.** A multi-key command or script spans slots. Hash tags, or restructure into single-key operations.
- **Failover losing recent writes.** Async replication means the last few milliseconds of acknowledged writes on the old primary are gone. For caches this is a few misses. For counters, idempotency keys and locks, it is a correctness gap: a lock acquired just before failover may not exist on the new primary. Use `WAIT 1 100` for the few writes that matter, and design the consumer to survive a lost key.
- **TTL and clock issues.** Redis uses its own monotonic-ish clock for expiry; a VM clock jump can expire everything at once or nothing for a while. Application-side timestamps in values (`staleAt`, ZSET scores) come from pod clocks that can disagree by hundreds of milliseconds without NTP discipline. Never compare a Redis-side time with a pod-side time for correctness.
- **Serialization version mismatch after deploy.** Old pods write `v3` shape under a `v3` key and new pods expect a new field. Symptom: `undefined` reads and TypeErrors on half the pods during a rolling deploy. Bump the key version with every shape change; treat it as a schema migration.
- **Cache poisoning by caching an error response.** A loader that returns a partial object or an error DTO instead of throwing gets cached for the full TTL. Symptom: an outage in a downstream service is "remembered" for 15 minutes after it recovers. Cache only successful, complete results; never cache exceptions; validate the shape before `SET`.
- **Negative cache hiding a newly created row.** `GET /products/8812` is negatively cached at 10:00:00; the product is created at 10:00:05; readers see 404 until the negative TTL expires. Delete the key in the create path, keep negative TTLs short, and do not negative-cache ids the client itself just generated (the same client creating then immediately reading is the common case).
- **Subscriber connection reused for commands.** `ERR only (P)SUBSCRIBE / (P)UNSUBSCRIBE / PING / QUIT / RESET allowed in this context`. Dedicated connections per role.
- **Offline queue thundering herd.** A long outage with the default `enableOfflineQueue: true` buffers hundreds of thousands of commands in pod memory and replays them on reconnect. Disable it for cache clients.
- **Pipeline partial failure.** `pipeline.exec()` resolves even when some commands errored; the errors are inside the result array. Check each `[err, value]` pair.
- **Lua script too slow.** A script iterating a large set blocks the server; `SCRIPT KILL` only works if the script has not written yet, otherwise it is `SHUTDOWN NOSAVE`. Keep scripts O(1) or O(small N).

## 27.16 Decision table: use case to Redis design

| Use case | Redis structure | TTL | Invalidation | Redis-down behaviour |
|---|---|---|---|---|
| Product detail cache | String (JSON) with versioned key | 5 to 15 min plus jitter | Delete after commit; double delete; CDC or event for cross-service writes | Fail open to PostgreSQL; circuit breaker |
| Rendered menu / page fragment | String | 60 s plus jitter | Event on any dependent write; TTL backstop | Fail open |
| Search results | String keyed by hashed canonical query | 30 to 60 s | TTL only | Fail open |
| Negative "not found" | String sentinel | 30 to 60 s | Delete on create | Fail open |
| User session | String (JSON) or Hash; `noeviction`, AOF | Idle timeout, sliding via `GETEX` | Delete on logout; set index for revoke-all | Fail closed (503 or re-login); Redis is on the readiness path |
| Idempotency key (non-financial) | String with `NX` | 24 h | None; TTL | Fail closed for the operation (reject with 503) or fall back to PostgreSQL inbox |
| Idempotency key (financial) | PostgreSQL inbox table; Redis as optional fast pre-check | 24 h in Redis | None | Ignore Redis; PostgreSQL decides |
| Rate limit | Token bucket Hash via Lua, or ZSET sliding log | 2x window | None; TTL | Per endpoint: open for public reads, closed for auth and payments |
| Distributed lock (efficiency) | String `SET NX PX` with token; heartbeat | Job p99 times 2, extended | Compare-and-delete on release | Fail closed: skip the run |
| Distributed lock (correctness) | Prefer PostgreSQL advisory lock or `FOR UPDATE`; Redis only with fencing | Transaction scope | Automatic at commit | Not applicable |
| Counters (views, likes) | Hash with `HINCRBY`, write-behind flush | 24 h | Flushed to PostgreSQL every 10 s | Lose the unflushed window; document it |
| Inventory display count | String | 5 to 30 s | TTL, or event on stock change | Fail open |
| Inventory reservation (flash sale) | String via Lua `DECRBY` guard | Duration of the sale | Reconciled with PostgreSQL each minute | Fail closed: sale paused |
| Leaderboard | ZSET with `GT` | Period plus 60 days | None; new period is a new key | Return empty board; read model only |
| Delayed jobs | ZSET score = run time, Lua claim | None | Removed on claim | Use BullMQ; jobs wait |
| Event log / lightweight queue | Stream with consumer groups, `MAXLEN` | Trim by length | `XACK`; DLQ stream | AOF `everysec`; consumers reconnect |
| Cross-pod broadcast (invalidation, WebSocket fan-out) | Pub/Sub | None | Not applicable | Messages lost; L1 TTL covers it |
| Unique counts (dashboards) | HyperLogLog | 90 days | None | Read model only |
| Daily active users | Bitmap | 90 days | None | Read model only |
| Nearby drivers | Geo ZSET plus presence keys | Presence 30 s | `ZREM` on offline; sweeper | Fail closed for dispatch; retry |
| Feature flags, config | Hash plus L1 plus Pub/Sub | L1 2 s; hash none | Publish on change; PostgreSQL is truth | Keep last known values in L1 |

## Senior Checklist — Part 27

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
- [ ] I can state, per cached data type, how stale it may be and what happens when it is
- [ ] I invalidate after commit, with double delete or versioned values, and a TTL as the backstop
- [ ] I can prevent a stampede with a `SET NX` lock, single-flight and stale-while-revalidate
- [ ] I add TTL jitter everywhere and never `FLUSHALL` in production
- [ ] I can explain why `KEYS *`, `SMEMBERS` on a big set and `DEL` on a big key hurt every client
- [ ] I run separate Redis instances for cache (`allkeys-lru`, no persistence) and store (`noeviction`, AOF)
- [ ] I know what a Sentinel or Cluster failover loses and which of my keys care
- [ ] I can pick the right data structure for a leaderboard, rate limiter, delayed queue, unique count and geo search
- [ ] I release locks with compare-and-delete, extend them with a heartbeat, and fence writes where correctness matters
- [ ] I know when PostgreSQL `FOR UPDATE` or an advisory lock is the better lock
- [ ] My `ioredis` client has `commandTimeout`, `enableOfflineQueue: false`, a `retryStrategy`, and a graceful `quit()`
- [ ] I have decided fail-open versus fail-closed for every Redis use in the service
- [ ] I can read `INFO`, the slowlog and `redis_exporter` metrics and find a hot key, a big key or an eviction storm

## Part 27 — Key Takeaways

- A cache is a copy that is allowed to be wrong for a bounded time; write down the bound per data type and turn it into the TTL.
- Cache the read, verify at the write: display from Redis, decide from PostgreSQL.
- Cache-aside with delete-after-commit is the default; write-through for read-after-write data; write-behind only when losing seconds of writes is acceptable.
- Invalidation is the hard part: events for freshness, TTL as the safety net, double delete or versioned values for the race.
- Stampede, avalanche, penetration, hot keys and big keys each have a cheap fix (lock and single-flight, jitter, negative cache, L1 and replication, `UNLINK` and splitting); apply them before the incident.
- Redis is single-threaded per command: one slow command is everyone's outage. `SCAN` not `KEYS`, `UNLINK` not `DEL`, scan collections, keep Lua short.
- One Redis per role: cache instances evict, store instances refuse writes and persist.
- Replication is asynchronous; a failover can lose the last writes. Design locks, counters and idempotency keys to survive that.
- A lock with a TTL can be held by two parties; only idempotent operations or fencing tokens make it safe, and PostgreSQL is often the better lock.
- `SET NX PX` plus Lua compare-and-delete, Lua check-and-set, ZSET sliding windows and token buckets cover locks, atomics and rate limiting; BullMQ and Streams cover queues before you need a broker.
- The `ioredis` options `commandTimeout`, `enableOfflineQueue: false` and `retryStrategy`, plus a circuit breaker, decide how your app behaves during a Redis outage; the defaults decide badly.
- Measure hit ratio per namespace, client-side latency, evictions and memory; the first sign of most cache incidents is one of those four moving.
