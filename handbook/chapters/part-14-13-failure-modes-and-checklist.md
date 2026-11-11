## 14.15 Edge cases and failure modes across networking

#### Concept

This section is the incident catalogue for everything in Part 14. Each entry follows the same shape: what the on-call sees, what is actually happening in which layer, how to prove it in minutes, and the fix that stops it recurring. These are not hypothetical. Every one of them has paged a real team, usually at night, and usually with application dashboards that looked perfectly healthy.

The senior mantra applies to the network exactly as it applies to code: *Can it timeout? Can it fail? Can it become slow? Can it duplicate? Can it return a wrong response? Can it partially succeed?* The network answers "yes" to all six, every day.

#### Why does it exist?

Application code is deterministic and testable; the network between two processes is neither. Most backend engineers spend their training on the deterministic half and meet the other half for the first time during an outage. Having a catalogue turns a 90-minute investigation into a 10-minute one, because the shapes repeat: "healthy app, failing users" has about a dozen causes and they are all in this list.

#### Mental model

Imagine a hospital's differential diagnosis chart: a set of symptoms points to a short list of conditions, each with a test that confirms or rules it out. "Server healthy, users failing" is the fever; the tests are `dig`, `ss`, the ALB access log, `openssl s_client`, `tcpdump`, and the sysctl values on the node.

#### How it works

The quick diagnosis matrix:

| Symptom | First suspect | Confirming test |
|---|---|---|
| Timeouts to a service that recently failed over | stale DNS | `dig +short name` from the client host versus authoritative; compare with the connection's remote IP |
| `EADDRNOTAVAIL` or `connect` failures under load, server idle | ephemeral port exhaustion | `ss -s` shows tens of thousands in `timewait` |
| First request after idle hangs for minutes | half-open connection | `ss -tan` shows `ESTAB` on the client while the server has no matching socket |
| `502` or `504` with no app log line | load balancer generated | ALB access log `elb_status_code` versus `target_status_code` |
| Connections pile up, few requests complete | slowloris or slow read | `ss -tan state established` count far above request rate; long `headersTimeout` |
| `413` from users uploading photos | body size limits at some hop | check limits on ALB, NGINX, `bodyParser`, multipart middleware |
| Every TLS client fails at once at a round hour | certificate expiry | `openssl s_client -connect host:443 -servername host` shows `notAfter` |
| TLS or JWT errors on one node only | clock skew | `timedatectl` or `date -u` on the node versus `ntpdate -q` |
| Small requests work, large ones hang, no errors | MTU or fragmentation | `ping -M do -s 1472 host` fails; `tracepath` shows a smaller PMTU |
| One carrier's users fail, others fine | IPv6 handling | `dig AAAA`; test from an IPv6-only network; check IP parsing and rate-limit keys |
| Recovery from an outage causes a second outage | retry storm | request rate spike at the exact moment health returns; client retry config |

### 14.15.1 DNS TTL sending traffic to dead IPs after failover

**What you see.** A database or service failed over cleanly; half the fleet recovered and half keeps failing (`ECONNREFUSED`, timeouts, or `read-only transaction` errors) for minutes to hours.

**What is happening.** Some cache between the client and the authority is serving the old address: a resolver with a TTL floor, a JVM or custom in-process cache with no expiry, a sidecar DNS cache, or pooled connections that never re-resolve. Route 53 changed the answer in 40 seconds; the caches did not.

**Proving it.** On an affected pod, `dig +short orders-db.internal` and compare with `dig @<authoritative or VPC resolver>`; then `ss -tanp | grep 5432` to see which IP the pool actually holds.

**Fix.** Respect TTLs everywhere (no floors, no forever caches), keep failover-participating records at 60 seconds or less, bound the lifetime of pooled connections (`idleTimeoutMillis`, `keepAliveMaxTimeout`), and make drivers discard sockets on `read-only transaction`. Add a synthetic write check that alerts on read-only responses within 30 seconds. See 14.3.

### 14.15.2 Ephemeral port exhaustion

**What you see.** Outbound calls fail with `EADDRNOTAVAIL` or `connect ETIMEDOUT` while CPU is low and the destination is healthy. Often only calls to one destination fail.

**What is happening.** Every new outbound connection consumes a source port; each closed one holds that port in `TIME_WAIT` for 60 seconds. At about 28,000 ports and 60 seconds, the ceiling is roughly 470 new connections per second to one destination per source IP. A client without keep-alive, or a NAT gateway shared by many pods, hits it.

**Proving it.** `ss -s` (look at `timewait`), `ss -tan state time-wait | wc -l`, NAT gateway `ErrorPortAllocation` metric.

**Fix.** Keep-alive agents and pools with caps (14.9.2), `net.ipv4.tcp_tw_reuse = 1`, widening `ip_local_port_range` to `1024 65535` as a stopgap, additional NAT gateways or VPC endpoints for AWS services, and a Prometheus alert on `node_sockstat_TCP_tw` above 15,000. See 14.2.

### 14.15.3 Half-open connections

**What you see.** The first request after a quiet period hangs for 15 minutes and then fails; database queries stall after a maintenance reboot; a worker "freezes" overnight.

**What is happening.** The peer, or a NAT, firewall or load balancer in between, silently forgot the connection. The client still believes it is `ESTABLISHED` and sends data into the void; TCP retransmits with exponential back-off for `tcp_retries2` (about 15 minutes) before giving up.

**Proving it.** `ss -tan` on the client shows `ESTAB` with a growing `Send-Q`; on the server there is no matching socket, or `pg_stat_activity` has no backend for that `client_port`.

**Fix.** TCP keepalive with a short idle time (`socket.setKeepAlive(true, 30_000)`, `keepAlive: true` in `pg`), sysctls `tcp_keepalive_intvl=10` and `tcp_keepalive_probes=3`, `statement_timeout` and request timeouts, a readiness probe that runs a query through the pool, and `tcp_retries2` lowered to 5 or 6 on the node where you control it. See 14.4.3.

### 14.15.4 Load balancer 502 and 504 versus application 500

**What you see.** The error dashboard shows `5xx`; the application logs show fewer errors than the dashboard, or none.

**What is happening.** The ALB generates `502` when the target resets or closes a connection mid-request (keep-alive race, deploy without draining, malformed response), `503` when no target is healthy, `504` when the target fails to answer within the idle timeout (60 seconds), and `460` in its log when the client gave up. Your app generates `500` for unhandled exceptions. They are different failures with different fixes, and a combined "5xx rate" hides which one you have.

**Proving it.** ALB access log: `elb_status_code` versus `target_status_code` (`-` means the target never answered). CloudWatch `HTTPCode_ELB_5XX_Count` versus `HTTPCode_Target_5XX_Count`.

**Fix.** Separate alerts. For `502`: `keepAliveTimeout` above the ALB idle timeout, `headersTimeout` above that, deregistration delay with graceful shutdown. For `504`: your own timeout interceptor at 10 to 30 seconds so the client gets an honest answer sooner, and streaming heartbeats for long responses. For `503`: readiness checks that only fail for essential dependencies. See 14.7.3 and 14.9.1.

### 14.15.5 Slowloris and slow-read attacks

**What you see.** Thousands of open connections, few completed requests, new connections refused or queued, CPU low. Legitimate users see timeouts.

**What is happening.** Slowloris opens many connections and sends request headers one byte at a time, never finishing, so each connection occupies a server slot for as long as the server's header timeout allows. Slow-read does the opposite: it requests a large response and reads it one byte at a time, so the server's write buffers and the response stream stay pinned. Node's defaults (`headersTimeout` 60 s, `requestTimeout` 300 s) are generous; a server with a large `keepAliveTimeout` (which we set for the ALB, 14.9.1) is more exposed to slowloris if reachable directly.

**Proving it.** `ss -tan state established | wc -l` far above request rate; many connections with tiny `Recv-Q` and old age; ALB `ActiveConnectionCount` high with `RequestCount` flat.

**Fix.** Put the ALB and a WAF in front (the ALB itself enforces header timeouts and absorbs slow clients; AWS WAF rate-based rules limit connections per IP). In Node, set `headersTimeout` to the ALB timeout plus a margin (it applies to header completion, not idle keep-alive between requests, on a healthy socket) and `requestTimeout` to a sane bound; never expose Node directly to the internet. For slow reads, respect backpressure and bound per-connection buffers; do not `res.write()` without checking the return value.

### 14.15.6 Request body too large

**What you see.** `413 Payload Too Large` or a mysterious `400`/reset for some uploads; a `POST` with a big JSON array fails while small ones succeed; a pod's memory spikes on uploads.

**What is happening.** Several hops each have a body limit: the ALB (1 MB for Lambda targets; instance and IP targets have no fixed limit but do time out slow uploads), NGINX `client_max_body_size` (1 MB default), Express `json()` (100 KB default), NestJS's `bodyParser` options, and multipart libraries. The smallest wins, and it may not be the one you configured. Separately, an unbounded body limit lets a client send 2 GB of JSON that `JSON.parse` will try to materialise.

**Proving it.** Which hop returned the error: the ALB access log, NGINX error log (`client intended to send too large body`), or the app's exception filter. `curl -v` with a body of a known size at each hop.

**Fix.** Decide the limit per endpoint and set it consistently at every hop; in NestJS, `NestFactory.create(AppModule, { bodyParser: false })` then `app.use(json({ limit: '1mb' }))` and a larger limit only on the upload route; stream large uploads to S3 with pre-signed URLs instead of through the API. Return `413` with a clear message, and set `Retry-After` never, since retrying the same body will never succeed.

### 14.15.7 TLS certificate expiry incident

**What you see.** At a round hour, every client fails at once with `CERT_HAS_EXPIRED` (Node), `NET::ERR_CERT_DATE_INVALID` (Chrome), or `SSL certificate problem` (`curl`). Internal services in a crash loop because readiness checks call an expired endpoint.

**What is happening.** A certificate's `notAfter` passed. Managed certificates (ACM, cert-manager) renew automatically, but manual ones, ones on NLB passthrough targets, ones in a Kubernetes secret nobody rotates, and internal CA certificates do not. Intermediate CA and root rotations (RDS in 2024) cause the same symptom on a schedule announced months earlier.

**Proving it.** `openssl s_client -connect host:443 -servername host 2>/dev/null | openssl x509 -noout -dates`.

**Fix.** Managed issuance everywhere (ACM at the ALB, cert-manager with Let's Encrypt or a private issuer in the cluster), `setSecureContext` reloads for self-terminating services (14.12), and an expiry alert for every endpoint including internal ones: blackbox exporter `probe_ssl_earliest_cert_expiry - time() < 14 * 86400`. Keep an inventory of certificates as a living document; the ones that expire are the ones nobody listed.

### 14.15.8 Clock skew breaking TLS and JWT

**What you see.** One node (or one pod) rejects fresh certificates as "not yet valid", or rejects valid JWTs with `TokenExpiredError`, or accepts expired ones. Users bounce between "logged in" and "session expired" depending on which pod they hit.

**What is happening.** Certificate validity windows and JWT `exp`, `nbf` and `iat` claims are compared against the local clock. A container inherits the node's clock; a node with a broken or blocked NTP drifts, sometimes by minutes after a suspend or a migration. Clock skew also breaks TOTP codes, signed S3 URLs, AWS SigV4 (requests fail with `RequestTimeTooSkewed` beyond 5 minutes), and Kafka timestamp-based retention.

**Proving it.** `date -u` on the node versus `ntpdate -q pool.ntp.org` or `chronyc tracking`; a Prometheus alert on `node_timex_offset_seconds` above 0.5.

**Fix.** chrony or the cloud provider's time source (Amazon Time Sync at `169.254.169.123`) on every node, monitored; a small leeway (`clockTolerance: 30` seconds in `jsonwebtoken` and `@nestjs/jwt` verify options) for tokens; never issue tokens with `nbf` set to "now" exactly. Treat time as a dependency with an SLO.

### 14.15.9 MTU and packet fragmentation

**What you see.** Health checks pass and small API calls work, but large responses hang or stall at exactly the same byte offset; `curl` hangs after headers; it happens only across a VPN, a VPC peering, an overlay network, or for some users.

**What is happening.** The path MTU is smaller than 1,500 bytes (VPN and overlay encapsulation add 20 to 80 bytes of headers), packets are sent with "don't fragment" set, and somewhere on the path an ICMP "fragmentation needed" message is blocked by a firewall, so the sender never learns to shrink its segments. Small packets fit; the first full-size packet vanishes silently. This is **PMTU blackholing**, and it is one of the strangest-looking bugs in networking because nothing errors.

**Proving it.** `ping -M do -s 1472 host` (1472 plus 28 header bytes equals 1500) fails while `-s 1400` works; `tracepath host` reports the discovered PMTU; `tcpdump` shows retransmissions of the same large segment with no ACK.

**Fix.** Allow ICMP type 3 code 4 through security groups and firewalls (security groups allow it for established flows, network ACLs may not); enable MSS clamping on the VPN or overlay (`iptables -t mangle ... TCPMSS --clamp-mss-to-pmtu`); lower the interface MTU on the affected hosts to match the tunnel (1,400 is a safe common value; AWS jumbo frames at 9,001 within a VPC only work when every hop supports them); enable `net.ipv4.tcp_mtu_probing = 1` so Linux probes a smaller MSS after repeated loss.

### 14.15.10 IPv6-only clients

**What you see.** Users on a specific mobile carrier or country report timeouts, mixed-content errors, or being rate limited immediately; your API shows nothing unusual. Or a `VARCHAR(15)` column truncates addresses and a unique constraint on IP fails.

**What is happening.** Many mobile networks are IPv6-only and reach IPv4-only services through carrier-grade NAT64. That adds latency, breaks some literal-IP usages (an `A`-only hostname works through DNS64; a hard-coded `http://13.234.10.7` does not), and puts thousands of users behind one shared IPv4 address that your per-IP rate limiter throttles. Applications that parse, store, log or geolocate IPs as IPv4 fail on 45-character addresses.

**Proving it.** `dig AAAA api.fooddash.com` returns nothing; test from an IPv6-only network or a `NAT64` test resolver; check rate-limit keys and IP column types.

**Fix.** Dual-stack the ALB (`dualstack` IP address type) and publish `AAAA` records; store IPs as `INET`; key rate limits on user or session where possible, and on a `/64` prefix rather than the full address for IPv6; check every regex and library that validates IPs; log-parse with both families in mind. See 14.2.

### 14.15.11 Retry storms from mobile clients after an outage

**What you see.** The original incident ends; the service comes back; within seconds it falls over again under two to ten times normal load, and this repeats. The load is legitimate traffic, all at once.

**What is happening.** During the outage, every client kept retrying, many with fixed short intervals and no cap. Their retries synchronised on the failure (all started retrying when the outage began) and they all hit the recovered service in the same second. Queued work (notifications, sync jobs) drains simultaneously. The recovered service, with cold caches, empty pools and slow-start connections, cannot absorb a load it would have handled warm.

**Proving it.** Request rate versus time on the ALB shows a cliff-shaped spike aligned to recovery; client version breakdown shows which SDK versions retry without back-off; `429` and `503` counts rise with the spike.

**Fix.** On the client: exponential back-off with full jitter (`sleep = random(0, min(cap, base * 2^attempt))`), a retry budget (for example at most 10% of requests may be retries), honour `Retry-After`, and retry only idempotent requests or ones with an idempotency key. On the server: rate limiting with `@nestjs/throttler` and `Retry-After`, load shedding (return `503` fast when the event loop lag or pool wait crosses a threshold), and gradual re-admission via the load balancer (slow-start mode on the target group, which ramps new targets' share over a configured window) so a recovered pod is not hit with full traffic instantly. Warm caches before marking ready where practical.

```ts
// retry-with-jitter.ts: the client-side policy every mobile SDK and internal client should use
export async function withRetry<T>(fn: () => Promise<T>, opts = { attempts: 4, baseMs: 200, capMs: 5_000 }): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as { statusCode?: number; retryAfterMs?: number; retryable?: boolean };
      if (e.retryable === false) throw err;                                  // 4xx other than 429: never retry
      const backoff = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
      const sleep = e.retryAfterMs ?? Math.floor(Math.random() * backoff);   // full jitter, or honour Retry-After
      await new Promise((r) => setTimeout(r, sleep));
    }
  }
  throw lastErr;
}
```

```ts
// load-shed.middleware.ts: fail fast when the pod is already saturated
import { Injectable, NestMiddleware } from '@nestjs/common';
import { monitorEventLoopDelay } from 'perf_hooks';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class LoadShedMiddleware implements NestMiddleware {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  constructor() { this.loop.enable(); }

  use(req: Request, res: Response, next: NextFunction) {
    const p99LagMs = this.loop.percentile(99) / 1e6;
    if (p99LagMs > 200 && req.path !== '/health/ready') {          // saturated: shed before we make it worse
      res.setHeader('Retry-After', '2');
      res.status(503).json({ title: 'Server busy', status: 503 });
      return;
    }
    next();
  }
}
```

#### Practical example

A single incident that touched five entries above. At 01:10 an RDS failover (14.15.1) left a third of pods writing to a replica because a sidecar cached DNS for 30 minutes. Pods were restarted; the restart storm opened thousands of new connections through a NAT gateway and hit port allocation errors (14.15.2). Meanwhile mobile clients retried every 2 seconds without back-off (14.15.11), so when pods came back, a 6x traffic spike knocked them over again. During that spike the ALB reported `502`s (14.15.4) from pods that were killed mid-request without draining. Total user-facing time: 71 minutes for a 40-second database failover. The postmortem produced six fixes, all from this catalogue, and the next failover six months later was invisible to users.

#### NestJS example

The dependencies that make a service resilient to the catalogue, gathered in one module: TCP keepalive and timeouts on the database pool, pooled outbound clients, rate limiting, load shedding, graceful shutdown, and a readiness probe that exercises the pool.

```ts
// resilience.module.ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TerminusModule } from '@nestjs/terminus';
import { LoadShedMiddleware } from './load-shed.middleware';
import { TimeoutInterceptor } from './timeout.interceptor';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]), // per-client budget; 429 with Retry-After
    TerminusModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useFactory: () => new TimeoutInterceptor(10_000) }, // our 504 before the ALB's
  ],
})
export class ResilienceModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoadShedMiddleware).forRoutes('*');
  }
}
```

```ts
// main.ts (the networking settings from this part in one place)
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
app.use(json({ limit: '1mb' }));                       // explicit body limit (4.15.6)
app.set('trust proxy', 1);                             // X-Forwarded-For from the ALB only
app.enableShutdownHooks();                             // SIGTERM: drain, FIN not RST (14.4.3)
const server = app.getHttpServer();
server.keepAliveTimeout = 65_000;                      // above the ALB idle timeout (14.9.1)
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;
server.on('connection', (s: Socket) => { s.setNoDelay(true); s.setKeepAlive(true, 30_000); });
await app.listen(3000, '0.0.0.0');
```

#### PostgreSQL example

The database-side settings that close the catalogue's gaps: detect dead clients, cap idle transactions, bound query time, and enforce TLS.

```sql
-- Dead client detection and lock hygiene (4.15.3)
ALTER SYSTEM SET tcp_keepalives_idle = 60;
ALTER SYSTEM SET tcp_keepalives_interval = 10;
ALTER SYSTEM SET tcp_keepalives_count = 3;
ALTER SYSTEM SET client_connection_check_interval = '10s';   -- PostgreSQL 14+
ALTER SYSTEM SET idle_in_transaction_session_timeout = '30s';

-- Bound query time for the application role so a half-open socket or a bad plan never holds a pool slot for minutes
ALTER ROLE app_user SET statement_timeout = '10s';
ALTER ROLE app_user SET lock_timeout = '2s';

-- Connection budget visible at a glance during a retry storm (4.15.11)
SELECT count(*) AS backends, max_conn, round(100.0 * count(*) / max_conn, 1) AS pct_used
FROM pg_stat_activity, (SELECT setting::int AS max_conn FROM pg_settings WHERE name = 'max_connections') s
WHERE backend_type = 'client backend'
GROUP BY max_conn;

SELECT pg_reload_conf();
```

#### Production scenario

A mature platform's networking alert set, with realistic thresholds, covers this catalogue: ALB-generated `5xx` above 0.1% for 2 minutes; `TIME_WAIT` sockets above 15,000 per node; NAT `ErrorPortAllocation` above 0; `CLOSE_WAIT` above 500 per pod; certificate expiry under 14 days on any probed endpoint; node clock offset above 0.5 seconds; CoreDNS p99 above 20 ms or error rate above 0.1%; request rate more than 3x the 7-day baseline for the same minute (retry storm); pool `waitingCount` above 5 for 30 seconds; event-loop p99 lag above 200 ms. Ten alerts, each mapped to a runbook entry that names the section of this catalogue.

#### Failure scenario

The MTU one, because it is the least intuitive. At 15:20 a new VPN between the office and the VPC went live so support staff could reach an internal admin API. Logins worked, dashboards loaded, but every "export CSV" and every order page with more than about 15 items hung forever with no error. The API logs showed complete responses sent. `ping` worked. `curl -v` showed headers arriving and the body never completing. An engineer ran `ping -M do -s 1472` across the VPN and got "message too long"; `tracepath` reported a PMTU of 1,380. The VPN appliance was dropping ICMP "fragmentation needed" messages, so the API's kernel never learned to send smaller segments; the first 1,500-byte packet of every large response vanished and TCP retransmitted it forever. MSS clamping on the VPN gateway (`--clamp-mss-to-pmtu`) fixed every symptom in one change. The 55 minutes spent before that command were spent reading application logs.

#### Edge cases & failure modes

A compact list of the ones that did not get their own heading:

- Anycast DNS and health-check flapping cause Route 53 failover records to oscillate; use a failure threshold of 3 checks and a 30-second interval.
- ALB target group slow-start left at 0 means a recovered pod takes full load instantly; set 60 to 120 seconds.
- Kubernetes conntrack table full drops new flows node-wide; alert on `node_nf_conntrack_entries` above 80% of the max.
- `SO_REUSEPORT` and multiple Node processes per pod change how connections distribute; measure before assuming even load.
- An HTTP/2 client with a low `SETTINGS_MAX_CONCURRENT_STREAMS` from the server queues requests silently; the ALB defaults to 128 per connection.
- A CDN that caches `OPTIONS` preflights without `Vary: Origin` returns the wrong allow-origin to the second origin.
- Idle timeout on a WebSocket path: the ALB's 60-second idle timeout closes quiet sockets; send ping frames every 30 seconds.
- Security group rule limits (60 inbound per group by default) block a fix mid-incident; keep headroom.
- Proxy protocol enabled on the NLB but not parsed by Node yields garbage bytes at the start of every connection and a `400` from the parser.
- A `Content-Length` that does not match the body (hand-set headers) makes the next request on a keep-alive connection unparseable; let Node manage it.

#### How a Senior Backend Engineer thinks about this

They assume every one of these will happen and pre-decide the answer: timeouts on every hop, keep-alive probes on every long-lived socket, pooled and capped outbound clients, TTL-respecting DNS, managed certificates with expiry alerts, synchronised clocks, dual-stack endpoints, back-off with jitter in every client they ship, and dashboards that separate infrastructure errors from application errors. They keep a runbook that maps symptoms to tests to fixes, and they practise it: a game day that pauses the database container, blocks ICMP, or sets a node's clock 10 minutes ahead teaches more than any document. To a product manager: "Most outages are not bugs in our code; they are the network doing something we did not plan for. This list is the plan."

#### Common mistakes

- Reading application logs first when the application never received the request.
- Alerting on a combined `5xx` rate.
- Shipping a mobile client with fixed-interval retries.
- Trusting default timeouts at any layer.
- Leaving certificates, clocks and DNS caches as "someone else's problem".
- Fixing an incident by restarting pods without finding which entry in this catalogue it was.

#### Interview questions

1. **A database failover completed in 40 seconds but users saw errors for 30 minutes. List three network-layer causes.** Stale DNS caches with TTL floors, pooled connections to the old host, half-open sockets without keepalive.
2. **How do you distinguish an ALB-generated `502` from an application `500`, and what is the fix for the most common `502`?** Access log target status; keep-alive timeout rule.
3. **Small responses work across a VPN but large ones hang with no error. What is it and how do you prove it?** PMTU blackhole; `ping -M do -s 1472` and `tracepath`; fix with MSS clamping or ICMP allow.
4. **Why does clock skew break both TLS and JWTs, and how do you defend?** Validity windows compared to local time; NTP on every node, monitoring, small verification leeway.
5. **Design a client retry policy for a mobile app.** Exponential back-off with full jitter, a cap, a retry budget, honour `Retry-After`, idempotent requests only or with idempotency keys.
6. **What is slowloris and which single architectural decision mostly neutralises it?** Slow header sends pinning connections; put a Layer 7 load balancer and WAF in front and never expose Node directly.
7. **Your rate limiter is throttling an entire mobile carrier. Why?** IPv6-only users behind NAT64 share IPv4 addresses; key on user or `/64`, and go dual-stack.
8. **Name five networking alerts you would add to a new service on day one.** LB `5xx` separate from app `5xx`, `TIME_WAIT` and `CLOSE_WAIT` counts, certificate expiry, clock offset, pool waiting count.

#### Practical exercise

Run a game day against a NestJS service in Docker Compose or a small Kubernetes cluster. Inject, one at a time: a DNS record change with a 300-second TTL, `Connection: close` on outbound calls at 500 RPS, `docker pause` on Postgres, a Node `keepAliveTimeout` of 2 seconds behind NGINX, a 1,380-byte MTU on the API container with ICMP blocked, a certificate that expires in 5 minutes, a container clock 10 minutes ahead, and a load generator that retries every second without back-off after you kill the service for 30 seconds. For each, record the symptom, the command that proved the cause, the time to diagnose, and the fix. Acceptance criteria: a runbook with eight entries in the symptom-test-fix format, and a set of alert rules that would have fired for at least six of the eight before users noticed.

## Senior Checklist — Part 14

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
- [ ] I can name the layer a symptom lives on and pick the tool for it (`dig`, `ss`, `nc`, `openssl s_client`, `curl -v`, `tcpdump`)
- [ ] I can trace a browser request through DNS, TCP, TLS, HTTP/2, the ALB, NestJS, the pool and Postgres, with a number next to every step
- [ ] I can explain why keep-alive and HTTP/2 remove more user latency than any query optimisation on a mobile network
- [ ] I have set `keepAliveTimeout` and `headersTimeout` above the load balancer's idle timeout on every Node service I own
- [ ] Every outbound dependency in my services uses one pooled, capped, timeout-bearing client
- [ ] Every long-lived socket I own (Postgres, Redis, partner APIs) has TCP keepalive and a statement or request timeout
- [ ] My DNS caches respect TTLs and my pools bound socket lifetime, so a failover is followed within a minute
- [ ] I can state the safe and idempotent methods and I require an `Idempotency-Key` on every `POST` that charges or creates
- [ ] My exception filter maps every domain and SQLSTATE error to the right status code, and my dashboards split LB-generated `5xx` from app `5xx`
- [ ] I set every cookie attribute deliberately, regenerate the session id on login, and never store tokens in `localStorage`
- [ ] Every endpoint has an explicit `Cache-Control` policy that fails safe, with `Vary` set and `public` never on authenticated responses
- [ ] I use version-based ETags for `304`s and `If-Match` for optimistic concurrency on contended resources
- [ ] Large responses stream from a database cursor with backpressure and client-disconnect cleanup
- [ ] Certificates are managed and monitored for expiry, TLS to data stores is verified, and node clocks are synchronised and alerted
- [ ] CORS is configured from an allow-list with credentials only where needed, and I know it is not an authorisation control
- [ ] Every client I ship retries with exponential back-off, jitter, a budget, and `Retry-After` support

## Part 14 — Key Takeaways

- Name the layer before you debug: connection refused is Layer 4, a timeout with silence is Layer 3, a certificate error is Layer 6, a `502` is Layer 7; each has its own tool.
- On a mobile network, three round trips (TCP, TLS, request) are about 70% of a request's latency; the app and database are under 2%. Reuse connections, use HTTP/2 at the edge, and place regions near users before touching a query.
- Every new connection costs a handshake, a TLS negotiation, a slow-start ramp and an ephemeral port; pool and cap every outbound client, and never create a client per request.
- Idle connections get killed silently by NATs, load balancers and reboots; TCP keepalive plus statement and request timeouts turn a 15-minute hang into a 30-second detection.
- The server-side idle timeout must always exceed the client-side one at every hop; Node's 5-second default behind a 60-second ALB is the most common `502` in the industry.
- DNS is a tier-0 dependency: respect TTLs, bound pooled socket lifetimes, and know that `dns.lookup` runs on the libuv threadpool.
- Methods carry a retry contract: `GET`, `PUT`, `DELETE` may be retried; `POST` and `PATCH` may not without an idempotency key backed by a unique constraint.
- Status codes are instructions to the client and to your dashboards; own one mapping from domain and SQLSTATE errors to codes, and separate infrastructure `5xx` from application `5xx`.
- Bytes are the lever that latency and loss multiply: compress at exactly one hop, paginate, stream large responses from a cursor with backpressure, and never compress SSE without flushing.
- `Cache-Control` decides who may store a response; `public` on a personalised endpoint is a data breach, `no-store` on the catalogue throws away your CDN. Default safe, declare explicitly, always set `Vary`.
- Version-based ETags make `304` nearly free and `If-Match` gives you optimistic concurrency with a single conditional `UPDATE`.
- Terminate TLS at the edge with managed certificates, verify TLS to data stores, alert on expiry and clock skew, and treat CORS as a browser safety feature, not as API security.
- Assume the network will time out, fail, slow down, duplicate, mislead and partially succeed; the catalogue of failure modes is the plan, and a game day is the test.
