## 41.9 Compression, serialization and HTTP client tuning

### 41.9.1 Compression

#### Concept

Compression trades CPU for bytes. gzip at level 6 turns a 200 KB JSON response into about 25 KB (JSON compresses 6–10×). Brotli at quality 4–5 gets 10–15% smaller than gzip for similar CPU; at quality 11 it is smaller still but 10–50× slower to compress, which is only sensible for static assets compressed once at build time.

#### Why does it exist?

For a mobile client on a 5 Mbit/s connection, 200 KB is 320 ms of transfer; 25 KB is 40 ms. For API-to-API traffic inside one data centre, bandwidth is plentiful and the CPU spent compressing is often the larger cost.

#### How it works — where to compress

| Location | Pros | Cons | Use when |
|---|---|---|---|
| In the Node process (`compression` middleware, `@fastify/compress`) | Simple; works everywhere | Uses event loop CPU: about 1–3 ms per 100 KB at gzip level 6, which is a significant fraction of a 20 ms request | Small deployments without a smart edge |
| At the load balancer / ingress (NGINX, Envoy, ALB does not compress; CloudFront and most CDNs do) | Offloads CPU from the app; centralised config | Needs the edge to see plaintext (TLS terminates there) | Default for production |
| At the CDN for cacheable responses | Compress once, serve millions | Only for cacheable responses | Static assets, public catalog endpoints |

Measure the CPU: `node --cpu-prof` on a load test with and without compression; `zlib` frames in the flame graph tell you the share. A common finding is that gzip costs 8–15% of the event loop at level 6 on an API returning 50–100 KB responses. Move it to the edge and the pod handles 10% more traffic for free.

```ts
// main.ts: compress only when the edge cannot; skip small bodies and already-compressed types
import compression from 'compression';
app.use(compression({
  threshold: 1024,       // bodies under 1 KB are not worth it
  level: 4,              // level 6 is default; 4 is ~30% cheaper with ~5% larger output
  filter: (req, res) => !req.headers['x-no-compression'] && compression.filter(req, res),
}));
```

#### Edge cases & failure modes

- Compressing a streaming response buffers it unless the middleware flushes per chunk; `res.flush()` after each write with `compression`.
- Double compression (app and edge) wastes CPU and can corrupt responses when `Content-Encoding` is set twice; pick one layer.
- `Content-Length` is unknown for compressed streams, so responses become chunked; some old clients misbehave.
- BREACH-style attacks: compressing responses that mix secrets and attacker-controlled input leaks the secret through size; do not compress responses containing CSRF tokens next to reflected input.

### 41.9.2 Serialization cost

#### Concept

Turning objects into bytes (`JSON.stringify`) and applying transformation layers (`class-transformer`, DTO mapping) runs on the event loop. For small responses it is negligible; for large ones it is the single biggest CPU cost in the request.

#### How it works — numbers

- `JSON.stringify` runs at roughly 100–300 MB/s depending on the shape. A 50 KB response: about 0.3 ms. A 5 MB response: 20–50 ms, during which the event loop is blocked for every other request.
- `ClassSerializerInterceptor` calls `class-transformer`'s `instanceToPlain` on the result. It walks every object and property, checks `@Expose`/`@Exclude`/`@Transform` metadata, and builds a new object graph. Cost scales with object count: 1,000 nested entities with 20 fields each is typically 15–40 ms. On a list endpoint that is the whole latency budget.
- `fast-json-stringify` compiles a JSON Schema into a specialised serializer that is 2–5× faster than `JSON.stringify` for known shapes, and it drops unknown properties by construction, which doubles as an allow-list.

#### NestJS example — measure, then decide per route

```ts
// Measure: how much of the request is serialization?
// Wrap the interceptor call with a timer for one hot route
@Injectable()
export class SerializationTimingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => {
      const t0 = process.hrtime.bigint();
      const plain = instanceToPlain(body);            // what ClassSerializerInterceptor does
      const json = JSON.stringify(plain);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      serializationHistogram.labels(ctx.getHandler().name).observe(ms / 1000);
      return json.length > 0 ? plain : plain;
    }));
  }
}
```

If the histogram shows serialization above 10–15% of route latency, act:

1. Return DTOs built explicitly (a mapper function that picks fields) rather than entities passed through `class-transformer`. A hand-written mapper for an `Order` list is 10–30× cheaper than `instanceToPlain` and easier to read.
2. Apply `ClassSerializerInterceptor` per controller where it is needed rather than globally with `APP_INTERCEPTOR`.
3. For the few very hot, fixed-shape endpoints, `fast-json-stringify` with a schema.
4. Shrink the payload: fewer fields, no nested graphs on list endpoints, pagination caps.

```ts
// A plain mapper: no reflection, no metadata, explicit allow-list
export function toOrderSummary(o: OrderEntity): OrderSummaryDto {
  return { id: o.id, status: o.status, totalCents: o.totalCents, createdAt: o.createdAt.toISOString() };
}
```

#### Fastify adapter vs Express

Nest supports both through `@nestjs/platform-express` and `@nestjs/platform-fastify`. On a hello-world benchmark Fastify serves roughly 2× the requests per second of Express (tens of thousands versus around 15–20k RPS on one core, numbers vary by machine). On a realistic endpoint that does two database queries and returns 20 KB of JSON, the difference shrinks to 5–15%, because the request is dominated by the database and serialization, not routing. Fastify also brings schema-based serialization (`fast-json-stringify` built in) and faster body parsing. Choose Fastify for new services if your middleware ecosystem allows it; do not migrate an existing Express-based service *for performance* until a profile shows the framework is where time goes, which it rarely is.

### 41.9.3 HTTP client tuning

#### Concept

Every outbound call (payment gateway, search service, another team's API) pays DNS, TCP and TLS setup unless connections are reused. A keep-alive pool with sensible limits and timeouts turns a 60 ms cold call into a 20 ms warm one and prevents a slow dependency from consuming all your sockets.

#### How it works

1. **Keep-alive.** Node's default `http.globalAgent` has `keepAlive: true` since Node 19; before that, each request opened a new socket. Explicit agents let you set `maxSockets` (per host concurrency), `maxFreeSockets` and `timeout`.
2. **undici** (the engine behind Node's `fetch`) has its own `Agent`/`Pool` with `connections`, `keepAliveTimeout`, `headersTimeout`, `bodyTimeout` and pipelining; `setGlobalDispatcher` applies it to every `fetch`.
3. **DNS caching.** Node resolves DNS on every new connection through the OS resolver (`getaddrinfo`, in the libuv thread pool). With keep-alive, resolution is rare; without it, a slow resolver adds 5–50 ms per call and DNS timeouts appear as random 5 s hangs. `cacheable-lookup` caches results with TTL and can be attached to agents.
4. **Timeouts** at three levels: connect (fail fast when the host is unreachable), headers (time to first byte), body (total). A request with no timeout is a leak waiting for an incident.

```ts
// src/payments/http-client.provider.ts
import { Agent, setGlobalDispatcher, request } from 'undici';

export const paymentsDispatcher = new Agent({
  connections: 32,            // max sockets to this origin per pod; ties to Little's law: 600 RPS x 30 ms = 18 busy
  keepAliveTimeout: 30_000,   // shorter than the server's idle timeout to avoid reusing a socket the server just closed
  keepAliveMaxTimeout: 60_000,
  connect: { timeout: 1_000 },
  headersTimeout: 2_000,
  bodyTimeout: 3_000,
});
setGlobalDispatcher(paymentsDispatcher); // applies to global fetch too

export async function charge(body: ChargeRequest, idempotencyKey: string) {
  const res = await request(`${process.env.PAYMENT_BASE_URL}/v1/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
    dispatcher: paymentsDispatcher,
  });
  if (res.statusCode >= 500) throw new UpstreamError(res.statusCode);
  return res.body.json();
}
```

With `axios` or Nest's `HttpModule` (which wraps axios), pass explicit agents:

```ts
import { Agent as HttpsAgent } from 'node:https';
HttpModule.register({
  timeout: 3_000,
  maxRedirects: 0,
  httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, timeout: 30_000 }),
});
```

#### The keep-alive mismatch 502

A classic incident: the app's agent `keepAliveTimeout` is 5 s, the upstream load balancer's idle timeout is 4 s. The LB closes an idle connection at 4.0 s; the client reuses it at 4.5 s; the request fails with `ECONNRESET` or, when your service is the upstream behind an ALB, the ALB returns intermittent 502s. Rule: the *server's* keep-alive timeout must be **longer** than the *client's* (or the LB in front of it). For a Node server behind an AWS ALB (60 s idle default), set `server.keepAliveTimeout = 65_000` and `server.headersTimeout = 66_000`.

```ts
// main.ts
const app = await NestFactory.create(AppModule);
await app.listen(3000);
const server = app.getHttpServer();
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
```

#### Edge cases & failure modes

- `maxSockets` too low queues requests inside the agent with no visible error; expose the queue length or set `connections` from Little's law with headroom.
- `maxSockets` unlimited plus a slow upstream opens thousands of sockets, exhausting file descriptors (`EMFILE`).
- Retries without a budget turn one slow upstream into a retry storm (section 41.14).
- DNS TTL of 60 s with a resolver that takes 2 s under load: cache, and set `dns.setDefaultResultOrder('ipv4first')` if IPv6 resolution fails slowly in your network.

#### Interview questions

1. *Why must the server's keep-alive timeout exceed the client's?* Expected: otherwise the server closes an idle socket the client is about to reuse, producing resets and 502s at the LB.
2. *What three timeouts does an HTTP client need?* Expected: connect, headers (first byte), body (total); each catches a different failure.
3. *How does Little's law size `maxSockets`?* Expected: outbound RPS × average call duration = busy sockets; add headroom.

## 41.10 Async offloading, Node/NestJS tuning and the client-facing edge

### 41.10.1 Move work off the request path

#### Concept

Anything the client does not need in the response goes to a queue: sending the confirmation email, rendering the invoice PDF, generating thumbnails, syncing to the CRM, updating search indexes. The request writes the order and an outbox row; a worker does the rest. Part 35 — Background Jobs and Schedulers covers the machinery (BullMQ, retries, idempotent workers). The performance effect is direct: a `POST /orders` that awaited a 400 ms email API now returns in 90 ms, and the email provider's outage no longer becomes your outage.

```ts
// Request path: enqueue, do not await the side effect
await this.ds.transaction(async (m) => {
  await m.save(order);
  await m.insert(OutboxEvent, { type: 'order.placed', payload: { orderId: order.id } });
});
return order; // the relay publishes; a consumer sends the email

// Worker path (BullMQ processor)
@Processor('emails')
export class EmailProcessor extends WorkerHost {
  async process(job: Job<{ orderId: string }>): Promise<void> {
    await this.email.sendOrderConfirmation(job.data.orderId); // idempotent by orderId
  }
}
```

Decision rule: if the client cannot act on the result within this request, it does not belong in this request.

### 41.10.2 Node and NestJS specifics

#### Request-scoped providers on hot paths

`@Injectable({ scope: Scope.REQUEST })` makes Nest create a new instance of the provider for every request *and* of every provider that depends on it (scope bubbles up through the injection graph, including controllers). On a hot route that means dozens of allocations and constructor calls per request plus the loss of singleton caches. Measured on a mid-size module graph, request scope adds 0.3–2 ms per request and a noticeable GC increase. Use it only where per-request state is unavoidable (a DataLoader, a tenant context) and consider `durable: true` providers, which are created once per tenant key rather than per request, or pass request data as method arguments instead.

#### Synchronous crypto and CPU-bound work

`bcrypt.hashSync`, `crypto.pbkdf2Sync`, `scryptSync`, `zlib.gzipSync`, `JSON.parse` of multi-megabyte bodies, image resizing in pure JS: all block the event loop. Use the async variants (`bcrypt.hash`, `crypto.pbkdf2`, which run in the libuv thread pool), and for real CPU work use `worker_threads` through a pool such as `piscina`:

```ts
// src/pdf/pdf.service.ts
import Piscina from 'piscina';
import { resolve } from 'node:path';

@Injectable()
export class PdfService {
  private readonly pool = new Piscina({ filename: resolve(__dirname, 'render-invoice.worker.js'), maxThreads: 2 });
  render(invoice: InvoiceData): Promise<Buffer> {
    return this.pool.run(invoice); // runs on a worker thread; the event loop keeps serving requests
  }
}
```

Set the thread pool size for async crypto/DNS/fs with `UV_THREADPOOL_SIZE` (default 4) if profiles show queueing there.

#### Parallelism: cluster vs pods

One Node process uses one core. To use a 4-core machine you run 4 processes: either Node's `cluster` module (one master forking workers on the same port) or, in Kubernetes, 4 single-process pods with 1 CPU each. Pods are preferred: the scheduler spreads them across nodes, a crash affects one pod, memory limits apply per process, and horizontal autoscaling works on the same unit. `cluster` is fine on a VM without an orchestrator.

#### Heap size

`node --max-old-space-size=768 dist/main.js` for a pod with a 1 GiB limit (about 75%). Without it, V8 may grow past the cgroup limit and the kernel kills the pod with exit code 137 and no stack trace, which shows up as `OOMKilled` with a healthy-looking heap graph right up to the kill.

#### Heavy interceptors and loggers per route

A global logging interceptor that serialises the request and response body at info level costs `JSON.stringify` twice per request and floods the log pipeline. Rules: log bodies only at debug and only when a flag is on; exclude health and metrics routes from logging and metrics interceptors; bind expensive interceptors per controller with `@UseInterceptors` rather than globally; use a fast structured logger (`pino`) with async transport rather than a synchronous `console.log` into a slow stdout pipe (section 41.14 tells the incident).

### 41.10.3 The client-facing edge: CDN, cache headers, ETags, HTTP/2

The fastest request is the one that never reaches your pod.

- **`Cache-Control`.** Public, rarely changing responses (product details, category trees, static config) get `public, max-age=60, stale-while-revalidate=300` so the CDN serves them and refreshes in the background. Per-user responses get `private, no-store` or `private, max-age=0, must-revalidate`.
- **ETags.** Express (and therefore Nest's Express adapter) generates weak ETags for buffered responses by default; a client sending `If-None-Match` gets `304 Not Modified` with no body. The pod still computes the response to hash it, so ETags save bandwidth, not CPU, unless you compute the ETag from a version column and short-circuit before the query.
- **CDN.** Put static assets and cacheable API responses behind CloudFront/Cloudflare/Fastly. A catalog endpoint at 2,000 RPS with a 60 s TTL becomes about 1 origin request per minute per edge location.
- **HTTP/2** at the load balancer multiplexes many requests on one connection and compresses headers; the pod can keep speaking HTTP/1.1 to the LB. HTTP/3 (QUIC) helps lossy mobile networks. Neither changes what your handler does; both cut the client's connection overhead.

```ts
@Get('products/:id')
@Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
async getProduct(@Param('id', ParseUUIDPipe) id: string): Promise<ProductDto> {
  return this.products.getPublic(id);
}
```

#### Interview questions

1. *Why is a request-scoped provider expensive?* Expected: it and everything depending on it are re-instantiated per request; caches are lost; GC pressure rises.
2. *What is the difference between `bcrypt.hashSync` and `bcrypt.hash` for a server?* Expected: sync blocks the event loop for the whole hash (100+ ms at cost 12); async runs in the thread pool.
3. *Do ETags reduce server CPU?* Expected: not by default; the response is computed then hashed; they save bandwidth. To save CPU, derive the ETag from a version and short-circuit.
