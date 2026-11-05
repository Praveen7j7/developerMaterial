## 50.5 Caching, CDN and autoscaling as cost tools

#### Concept

The previous sections cut cost by removing waste. This one is different: it spends money in one place to remove more of it somewhere else. A cache, a CDN and an autoscaler are all performance tools, but each is also an arbitrage — you buy cheap capacity to avoid buying expensive capacity.

#### Why does it exist?

Not all compute is priced the same. A Redis `GET` costs a fraction of a cent-hour of a cache node. The equivalent PostgreSQL query costs a slice of an instance that is 5 to 10 times more expensive per unit of work, plus IOPS, plus (on Aurora Standard) a per-I/O charge. Serving a product image from CloudFront costs about $0.085 per GB; serving it from a NestJS pod costs event loop time, a socket, and egress at $0.09 per GB *plus* the compute.

When the same work can be done on cheaper infrastructure, moving it there is a cost optimisation that also makes the system faster. Those are rare and you should take them.

#### Mental model

Imagine a restaurant kitchen. The chef (your database) is expensive and there is exactly one. The hot counter (Redis) holds prepared dishes and any waiter can grab from it. The takeaway fridge by the door (the CDN) holds pre-packed items customers take themselves without entering the building at all.

Every dish served from the counter or the fridge is a dish the chef does not cook. You do not hire a second chef; you buy a bigger counter, which costs a fraction as much.

#### How it works

**Trading Redis cost against a smaller database instance.** The arithmetic is usually decisive.

```text
Situation: the orders API does 4,200 reads/second, 78 percent of which are
repeated product and category lookups. The database is at 70 percent CPU on a
db.r6g.4xlarge and the team is being asked to move to db.r6g.8xlarge.

Option A: scale the database up
  db.r6g.4xlarge -> db.r6g.8xlarge, Multi-AZ (both instances)
  +$1,410 x 2 = +$2,820/month

Option B: add a cache layer
  cache.r6g.large ElastiCache, 2 nodes for HA  = ~$300/month
  Absorbs 78 percent of reads. Database CPU falls to ~28 percent.
  Saving vs Option A: $2,520/month.
  Bonus: cached reads are ~0.4 ms instead of ~3 ms.
```

Redis is roughly an order of magnitude cheaper per read than a relational database, and it is faster. That is why caching is the highest-leverage cost tool in most backend systems.

The honest caveats, because this is not free:

- You now own cache invalidation, stampede protection, and a second failure mode (Part 26 — Caching).
- The database must still be able to survive a cold cache. If Redis restarts at peak and the database cannot take 4,200 reads per second, you have traded cost for an outage. Size the database for *survivable degraded mode*, not for the cached steady state.
- Cache what is read often and changes rarely. Caching a value that changes on every write adds cost and gains nothing.

```ts
// product-cache.service.ts — cache-aside with stampede protection and a jittered TTL.
import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class ProductCacheService {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as T;

    // Single-flight: only one pod loads on a miss; the rest wait briefly and re-read.
    // Without this, a cold key at 4,000 RPS sends 4,000 identical queries to the database.
    const lockKey = `lock:${key}`;
    const gotLock = await this.redis.set(lockKey, '1', 'EX', 10, 'NX');
    if (!gotLock) {
      await new Promise((r) => setTimeout(r, 50));
      const retry = await this.redis.get(key);
      if (retry) return JSON.parse(retry) as T;
    }

    try {
      const value = await loader();
      // Jitter the TTL so a batch of keys written together does not all expire together.
      const jittered = ttlSeconds + Math.floor(Math.random() * ttlSeconds * 0.2);
      await this.redis.set(key, JSON.stringify(value), 'EX', jittered);
      return value;
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
```

**CDN offload reduces both egress and origin compute.** For our platform, product images are 8 million objects served 50 million times a day.

```text
Serving images from S3 directly:
  GET requests: 50M/day x 30 = 1.5B/month
  At $0.0004 per 1,000 GETs  = $600/month in request charges
  Egress at 300 KB average   = 450 TB/month x $0.09 = $40,500/month  (!)

Serving through CloudFront with a 94 percent cache hit ratio:
  CloudFront egress: 450 TB x ~$0.085 (tiered, lower at volume) = ~$32,000
  Origin fetches: 6 percent of 450 TB = 27 TB from S3 to CloudFront = $0 (free)
  S3 GET requests: 6 percent of 1.5B = 90M = $36/month
```

The dominant saving here is not the per-GB rate (CloudFront and S3 egress are similar); it is that **S3-to-CloudFront origin transfer is free**, so only cache misses generate S3 charges, and the request charges fall by the cache hit ratio. At volume, CloudFront's tiered pricing and committed-use discounts widen the gap further.

The bigger structural win is what it does to your compute. If those images were served through NestJS pods (32.2's failure scenario), you would need many times the pod count purely to shuffle bytes, plus the sockets, plus the event loop time stolen from actual business logic. Serving static bytes through your application is the most expensive way to serve bytes available to you.

Cache API responses at the edge too, where they are cacheable: product detail JSON with a 60 second TTL and a `stale-while-revalidate` directive removes a large fraction of origin requests for a catalog that changes hourly.

**Scheduled and event-driven scaling.** Two different tools for two different traffic shapes.

*Scheduled* scaling is for predictable patterns. Our platform's traffic is 12x higher at 20:00 than at 04:00, and every weekday looks the same. A scheduled scale-up at 09:00 and scale-down at 23:00 removes the reaction latency of reactive autoscaling and lets you run a lower `minReplicas` overnight safely:

```yaml
# KEDA supports cron triggers alongside metric triggers.
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: orders-api
spec:
  scaleTargetRef:
    name: orders-api
  minReplicaCount: 3
  maxReplicaCount: 24
  triggers:
    - type: cron
      metadata:
        timezone: Europe/London
        start: "0 9 * * 1-5"      # pre-scale before the morning ramp
        end: "0 23 * * 1-5"
        desiredReplicas: "8"
    - type: prometheus            # reactive scaling still applies on top
      metadata:
        serverAddress: http://prometheus.monitoring:9090
        query: sum(rate(http_requests_total{service="orders-api"}[2m]))
        threshold: "60"           # requests per second per pod
```

The value of pre-scaling is that autoscaling always reacts *after* the traffic arrives. Scheduled scaling puts capacity in place before it does, which means you can run reactive thresholds less conservatively the rest of the time.

*Event-driven* scaling is for work whose demand is a queue depth, not a CPU number. This is where the biggest savings are, because workers are usually the most over-provisioned part of a system: they are sized for the nightly batch and then idle for 23 hours.

**KEDA scaling workers to zero.** The invoice generator, the export builder, the image processor, the email sender: all of these do bursts of work and then nothing.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: export-worker
spec:
  scaleTargetRef:
    name: export-worker
  minReplicaCount: 0            # genuinely zero pods when idle
  maxReplicaCount: 40
  pollingInterval: 15
  cooldownPeriod: 180           # wait 3 minutes of an empty queue before scaling to zero
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/exports
        queueLength: "20"       # one pod per 20 visible messages
        awsRegion: us-east-1
```

```text
Export worker before: 4 pods x 1 vCPU / 2 GB, 24/7 on Fargate = $144/month
Export worker after:  averages 0.7 pods over the day             = $25/month
Saving: $119/month for one worker. Multiply by nine workers      = ~$1,070/month.
```

The prerequisites are the same discipline you need anyway: idempotent job handlers, graceful shutdown on `SIGTERM` so an in-flight job is either finished or re-queued, and a cold start short enough that the first job after a quiet period does not time out. If your worker takes 45 seconds to boot because it warms a large in-memory cache at startup, fix that before enabling scale-to-zero.

For a NestJS worker, the shutdown contract is small and important:

```ts
// main.ts — worker process that KEDA can safely scale to zero.
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Enables onModuleDestroy / onApplicationShutdown hooks, so BullMQ workers
  // can finish the current job and stop taking new ones before the pod dies.
  app.enableShutdownHooks();
  await app.init();
}
bootstrap();
```

#### Production scenario

The combined effect on our platform:

| Lever | Cost added | Cost removed | Net |
|---|---|---|---|
| ElastiCache 2 x `cache.r6g.large` | +$300 | Avoided database upgrade -$2,820 | **-$2,520** |
| CloudFront in front of S3 and the API | +$32,000 egress | S3 egress and requests -$41,100 | **-$9,100** |
| KEDA scale-to-zero on 9 workers | +$0 | Worker compute -$1,070 | **-$1,070** |
| Scheduled pre-scaling | +$0 | Lower overnight `minReplicas`, -$180 | **-$180** |

Every one of those also improved latency. That is the signature of a good cost optimisation: when the cheaper option is also the faster one, take it without a meeting.

#### Failure scenario

A team enabled aggressive caching to avoid a database upgrade. It worked: database CPU fell from 72 percent to 24 percent, and they downsized from `db.r6g.4xlarge` to `db.r6g.xlarge`, saving $2,100 a month.

Six weeks later ElastiCache had a maintenance-window failover. The cache was empty for about 90 seconds. In those 90 seconds the full read load — which the cache had been absorbing at a 91 percent hit ratio — hit a database that was now four times smaller than the one that had originally struggled with it. The database saturated, connections queued, the connection pool exhausted, and checkout was down for 11 minutes.

The lesson is a rule worth carrying: **size the database for the load it must survive with a cold cache, not for the load it sees with a warm one.** You may still downsize, but downsize by less, and prove it with a cache-flush game day in staging. In this case the correct answer was `db.r6g.2xlarge` (a $700 saving, not $2,100) plus request coalescing so a cold cache produces one query per key rather than thousands.

#### Edge cases & failure modes

- Cold cache after a Redis failover or deploy overwhelming a downsized database.
- Cache stampede on a hot key when its TTL expires under load. Single-flight locks and jittered TTLs, as above.
- CDN caching a response that contains user-specific data because `Cache-Control` was wrong; a privacy incident, not a cost incident.
- CDN cache hit ratio destroyed by a cache-busting query string on every request.
- Scale-to-zero on a worker whose consumer group rebalance takes longer than the job timeout.
- KEDA scaling on a queue whose messages are invisible (in-flight) rather than visible, so the metric reads zero while work is happening.
- Scheduled scaling that does not account for a public holiday, a marketing email or a flash sale.
- Redis used as a database rather than a cache, so it holds data that cannot be lost, and now it needs backups, replication and an entirely different cost profile (Part 49).

#### How a Senior Backend Engineer thinks about this

They look for arbitrage: work being done on expensive infrastructure that could be done on cheap infrastructure. Cache, CDN and queue-driven workers are the three standard trades, and all three make the system faster as well as cheaper.

They never let a cost optimisation remove a safety margin silently. Downsizing the database because a cache absorbs the load is legitimate *only* with a documented cold-cache plan and a tested degraded mode.

They scale workers on the signal that actually represents demand. CPU-based autoscaling on a queue worker is a category error: a worker waiting on I/O has low CPU and a huge backlog.

And they check the CDN hit ratio like a first-class metric. A hit ratio that drifts from 94 percent to 70 percent is a cost regression and usually also a latency regression, and it is invisible unless someone is watching.

#### Common mistakes

- Adding a cache without stampede protection, then blaming Redis for the database outage.
- Downsizing the database to the cached steady state.
- Serving images and static assets through application pods.
- Autoscaling workers on CPU.
- Scale-to-zero with a 40 second cold start and a 30 second job timeout.
- Caching data that changes on every read, adding a network hop and a cost for zero hit ratio.

#### Interview questions

1. **How can adding a cache reduce total cost?** Expected: Redis is roughly an order of magnitude cheaper per read than a relational database, so absorbing 70 to 90 percent of reads avoids a database upgrade that costs several times more; it also lowers latency. Follow-up: what must you keep? Enough database capacity to survive a cold cache.
2. **Why does a CDN reduce cost beyond egress rates?** Expected: origin transfer from S3 to CloudFront is free, request charges fall with the hit ratio, and origin compute is removed entirely.
3. **What is the right autoscaling signal for a queue worker?** Expected: queue depth or age of the oldest message, not CPU; KEDA with a queue trigger; scale to zero when idle.
4. **What breaks when you scale workers to zero?** Expected: cold start latency, consumer group rebalance, in-flight message visibility metrics reading zero, jobs timing out on the first invocation after idle.
5. **Your team wants to downsize the database after adding a cache. What do you require first?** Expected: a documented and tested cold-cache degraded mode, request coalescing, and a game day that flushes the cache under load in staging.

#### Practical exercise

Take the highest-QPS read endpoint in your system. Measure its database cost contribution (queries per second, average duration, share of instance CPU). Add a cache with a jittered TTL and single-flight protection. Then run a game day: flush the cache at peak load in staging and observe whether the database survives.

Acceptance criteria: cache hit ratio above 80 percent; database CPU contribution from that endpoint reduced by at least 60 percent; the system survives a full cache flush at peak without exhausting the connection pool; and you can state the instance class you could safely downsize to, with evidence.
