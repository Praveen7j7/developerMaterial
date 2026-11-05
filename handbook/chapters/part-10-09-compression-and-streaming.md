## 10.10 Compression, streaming and chunked transfer

### 10.10.1 Compression: gzip and Brotli

#### Concept

HTTP compression shrinks the response body before it goes on the wire. The client advertises what it can decode in `Accept-Encoding: gzip, deflate, br, zstd`; the server picks one, compresses, and sets `Content-Encoding: br` and `Vary: Accept-Encoding`. JSON, HTML, CSV and JavaScript compress 5 to 10 times. Images, video, PDFs and already-compressed archives do not compress at all and only burn CPU.

- **gzip** (DEFLATE): universal, fast, ratio about 5x on JSON at level 6. Compression costs roughly 30 to 60 MB per second per core at level 6 in Node's zlib.
- **Brotli** (`br`): 15 to 25% smaller than gzip at comparable speed for levels 4 to 5; levels 9 to 11 are far slower and belong to build-time compression of static assets, not dynamic API responses.
- **zstd**: newer, fast; browser support arrived in Chrome 123 and Firefox 126, Node has `zlib.zstdCompress` from v22.15.

#### Why does it exist?

Bytes on the wire are the lever that latency and loss multiply (10.5). A 900 KB feed becomes 140 KB with gzip; on a lossy 4G link that is the difference between 20 seconds and 2 seconds. Compression also cuts bandwidth cost: cloud egress at about 0.09 USD per GB means a 5x reduction on 50 TB per month saves 3,600 USD.

#### Mental model

Imagine shipping feathers. Vacuum-packing them (compression) makes the box a fifth the size; it takes a minute per box (CPU) but saves hours of transport (bandwidth). Vacuum-packing a brick (a JPEG) does nothing except waste the minute.

#### How it works

1. The client sends `Accept-Encoding`.
2. The server decides: is the body compressible (`Content-Type` text, JSON, JavaScript, SVG)? Is it large enough (below about 1 KB, headers dominate and compression can make it larger)? Does the client accept an encoding we support?
3. The server streams the body through a compressor. With a known full body, `Content-Length` is set to the compressed size; with streaming, chunked encoding is used.
4. `Vary: Accept-Encoding` tells caches to store compressed and uncompressed variants separately.
5. The client decompresses transparently; `fetch` and browsers do this before your code sees the body.

**Where to compress.** Compression can happen at the CDN, the ALB (ALBs do not compress; CloudFront does), a reverse proxy (NGINX), or the Node process. Node compression costs event-loop-adjacent CPU: zlib runs on the libuv threadpool, so a heavy compression load competes with DNS lookups and `fs` (10.3). At 500 responses per second of 200 KB each, gzip level 6 uses about 2 full cores. Prefer compressing at the CDN or NGINX when you have one; compress in Node when the API is called directly by clients or when the ALB is the only thing in front.

**When NOT to compress.**

- Already-compressed content: images, video, `application/zip`, `application/pdf` (mostly), protobuf.
- Tiny responses (`threshold` of about 1 KB).
- Responses carrying secrets alongside attacker-controlled input over TLS: the **BREACH** attack recovers secrets (CSRF tokens) from compressed sizes. Do not compress responses that reflect user input next to a secret; or rotate tokens per request.
- Server-Sent Events and long-lived streams where the compressor's buffering delays delivery; either disable, or flush after each event.
- When CPU is the bottleneck and the network is a fast internal link (service-to-service in one AZ).

#### Practical example

A catalogue endpoint returns 40 products at 320 KB uncompressed. Enabling Brotli level 4 in the CDN cut it to 41 KB. Time to first render on a 4G phone fell from 2.1 s to 0.9 s. CPU on the NestJS pods was unaffected because the CDN did the work; the origin still sent 320 KB per cache miss, about 3% of requests.

#### NestJS example

`compression` middleware for Express, configured with a threshold, a filter that skips streams and binary types, and Brotli preference when the client supports it.

```ts
// main.ts (excerpt)
import compression from 'compression';
import { constants } from 'zlib';
import { Request, Response } from 'express';

app.use(
  compression({
    threshold: 1024,                       // do not compress bodies under 1 KB
    level: 6,                              // gzip level; 6 is the speed/ratio sweet spot for dynamic JSON
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }, // br when accepted; quality 4 for dynamic content
    filter: (req: Request, res: Response) => {
      if (req.headers['x-no-compression']) return false;           // per-request opt-out for debugging
      const type = String(res.getHeader('Content-Type') ?? '');
      if (type.startsWith('text/event-stream')) return false;      // SSE must not be buffered by a compressor
      if (/image|video|zip|pdf|octet-stream/.test(type)) return false; // already compressed
      return compression.filter(req, res);                          // default: text, json, js, svg
    },
  }),
);
```

The `compression` package added Brotli support in version 1.8 via the `brotli` option; on older versions only gzip and deflate are negotiated. For Fastify use `@fastify/compress` with `{ encodings: ['br', 'gzip'], threshold: 1024 }` registered through `app.register`.

#### PostgreSQL example

Compression can begin before HTTP: TOAST compresses large `text` and `jsonb` values on disk, and the wire protocol itself is not compressed, so a 2 MB `jsonb` document travels to the app as 2 MB. If a column is only ever sent to the client as-is, storing it pre-compressed (`bytea` of gzip) and forwarding with `Content-Encoding: gzip` saves the database round trip bytes, the app CPU and the response bytes at once.

```sql
-- PostgreSQL 14+: choose the TOAST compression per column (lz4 is faster, pglz is default)
ALTER TABLE product_documents ALTER COLUMN body SET COMPRESSION lz4;

-- Inspect what is being compressed on disk
SELECT pg_column_compression(body) AS algo, pg_column_size(body) AS stored_bytes,
       octet_length(body::text) AS raw_bytes
FROM product_documents
ORDER BY raw_bytes DESC
LIMIT 5;
```

#### Production scenario

An API at 1,200 RPS with 60 KB average JSON responses: uncompressed egress 72 MB per second, about 186 TB per month; with gzip at the pods, 14 MB per second and roughly 36 TB, saving about 13,000 USD per month at list egress prices, at the cost of about 1.5 cores of zlib CPU across the fleet. Moving compression to CloudFront saved the cores too, since 85% of responses were cache hits served compressed from the edge.

#### Failure scenario

A team enabled `compression()` globally, including on a Server-Sent Events endpoint that pushed order status updates. Updates stopped arriving in real time; they appeared in batches every few seconds or on disconnect. The gzip stream buffered output until its internal block filled. The fix was excluding `text/event-stream` in the filter (and, where compression of SSE is really wanted, calling `res.flush()` after each event).

#### Edge cases & failure modes

- Missing `Vary: Accept-Encoding`: a cache serves a Brotli body to a client that cannot decode it, which looks like corrupted JSON.
- Double compression: NGINX compresses an already-gzipped Node response; clients get garbage. Compress at exactly one hop.
- `Content-Length` mismatch when a middleware sets it before compression changes the body size; let the compressor manage headers.
- BREACH on responses that mix secrets and reflected input.
- zlib on the threadpool: heavy compression starves DNS and file reads; raise `UV_THREADPOOL_SIZE` or move compression out of Node.
- Compressing error responses: fine, but ensure the exception filter runs before the compressor writes headers.
- Range requests (`Range: bytes=...`) and compression do not mix; ranges refer to the encoded body.

#### How a Senior Backend Engineer thinks about this

Compress at the edge where possible, in Node when necessary, never twice. Set a threshold, exclude binaries and streams, and always emit `Vary`. They measure the CPU cost and the byte savings and choose levels accordingly: level 4 to 6, never 9, for dynamic content. To a product manager: "Shrinking every response to a fifth of its size made the app faster on bad networks and cut the bandwidth bill, at the price of some CPU that we moved to the CDN."

#### Common mistakes

- Compressing images and PDFs.
- Compressing SSE.
- Forgetting `Vary`.
- Brotli quality 11 on dynamic responses (10 times slower than gzip for a few percent gain).
- Enabling compression in both NGINX and Node.

#### Interview questions

1. **When should you not compress a response?** Already-compressed types, tiny bodies, SSE and streams without flushing, secret-plus-reflected-input responses (BREACH), CPU-bound internal calls.
2. **What does `Vary: Accept-Encoding` prevent?** Caches mixing encoded variants.
3. **Where in the AWS path can compression happen, and where would you put it?** CloudFront, NGINX, Node; the ALB does not compress. Put it at the CDN if present, else Node with a threshold.
4. **Why does compression in Node affect DNS lookups?** Both use the libuv threadpool.
5. **gzip versus Brotli for dynamic JSON?** Brotli 4 to 5 gives 15 to 20% smaller output at similar CPU; either is fine, both beat none by a mile.

#### Practical exercise

Add compression to a NestJS API and measure, for a 300 KB JSON endpoint, the response size and p99 latency at 200 RPS for: none, gzip 6, Brotli 4, Brotli 11. Record pod CPU for each. Then add an SSE endpoint and demonstrate the buffering bug and its fix. Acceptance criteria: a table with size, latency and CPU per configuration, and a filter that excludes SSE and binaries.

### 10.10.2 Streaming and chunked transfer encoding

#### Concept

A normal HTTP response has a known size, announced in `Content-Length`. **Chunked transfer encoding** (`Transfer-Encoding: chunked`) lets a server send a body of unknown length as a series of size-prefixed chunks terminated by a zero-length chunk. That is what makes **streaming** possible: sending the first rows of a 2 GB CSV export before the last rows have been read from the database, with constant memory. HTTP/2 and HTTP/3 have no chunked encoding because their framing is inherently streamed; the same NestJS code works on all three because Node handles the framing.

In NestJS, streaming comes in three shapes: `StreamableFile` (return a Node `Readable` from a handler and let NestJS pipe it), direct `res.write()` with `@Res()`, and Server-Sent Events via `@Sse()`.

#### Why does it exist?

Without streaming, an export of 5 million orders means loading 5 million rows into memory, serialising a 2 GB string, and only then sending byte one. The pod OOMs, or the client times out at the ALB's 60-second idle limit before seeing any bytes. Streaming keeps memory flat (a few megabytes of buffers), starts the response in milliseconds, and keeps the connection active so idle timeouts never fire.

#### Mental model

Imagine a factory shipping pallets as they are produced, rather than waiting until the whole order of 10,000 units is finished and renting a warehouse to hold it in the meantime. The truck starts moving after the first pallet; the customer starts receiving in minutes; the factory never needs the warehouse. Chunked encoding is the label on each pallet saying how many units it holds and a final empty pallet meaning "that was the last one".

#### How it works

1. The handler sets headers (`Content-Type`, `Content-Disposition`) and does not set `Content-Length`.
2. Node writes the headers with `Transfer-Encoding: chunked` (HTTP/1.1) and begins emitting chunks as `res.write()` is called or as a piped stream produces data.
3. **Backpressure**: if the client (or the ALB) reads slower than the server produces, the socket's write buffer fills, `res.write()` returns `false`, and a properly piped stream pauses the source (the database cursor) until `drain`. Ignoring backpressure and calling `res.write()` in a tight loop buffers the whole body in memory anyway.
4. The database side must also stream: a **cursor** (`pg-cursor` or `pg-query-stream`) fetches rows in batches of, say, 1,000 rather than the whole result set. A `SELECT` of 5 million rows without a cursor is loaded into the driver's memory in full.
5. The final zero-length chunk marks the end. If the server crashes mid-stream, the client sees a truncated body with no terminator, which is detectable; a `Content-Length` response cut short is detectable too, but a chunked one is explicit.
6. Trailers (headers after the body) exist in chunked encoding and HTTP/2 and are how gRPC reports status; browsers mostly ignore them.

**Interaction with load balancers.** An ALB forwards chunks as they arrive, and its 60-second idle timeout counts the gap between bytes, not the total; a stream that sends something at least every few seconds never times out. A stalled stream (waiting 90 seconds on a slow query with nothing written) does. Some proxies buffer responses by default (NGINX `proxy_buffering on`), which kills the streaming benefit; set `proxy_buffering off` for streaming routes or send `X-Accel-Buffering: no`.

#### Practical example

A finance team requests a CSV of all orders in the last year: 4.2 million rows, 1.1 GB. The naive endpoint OOM-killed the pod at 1.5 GB heap after 40 seconds. The streaming version: a `pg-query-stream` cursor with a batch size of 2,000, a transform stream that formats each row as a CSV line, gzip, and `StreamableFile`. First byte after 60 ms, 1.1 GB (140 MB compressed) delivered in about 3 minutes, pod memory flat at 180 MB, and the ALB never timed out because bytes flowed continuously.

#### NestJS example

```ts
// exports.controller.ts
import { Controller, Get, Header, Query, Res, StreamableFile } from '@nestjs/common';
import { Response } from 'express';
import { Transform } from 'stream';
import { createGzip } from 'zlib';
import { ExportsService } from './exports.service';

@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get('orders.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="orders.csv"')
  @Header('Content-Encoding', 'gzip')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Accel-Buffering', 'no') // tell NGINX-style proxies not to buffer
  async orders(@Query('since') since: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const rows = this.exports.orderRowsSince(new Date(since)); // Readable in objectMode, streamed from a PG cursor

    const toCsv = new Transform({
      objectMode: true,
      transform(row: { id: string; status: string; total_cents: number; created_at: Date }, _enc, cb) {
        cb(null, `${row.id},${row.status},${row.total_cents},${row.created_at.toISOString()}\n`);
      },
    });

    // If the client disconnects, stop the database cursor instead of reading 4 million rows into nothing.
    res.on('close', () => rows.destroy());

    const header = Buffer.from('id,status,total_cents,created_at\n');
    toCsv.push(header);
    return new StreamableFile(rows.pipe(toCsv).pipe(createGzip({ level: 4 })));
  }
}
```

```ts
// exports.service.ts: stream rows from PostgreSQL with a cursor
import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';
import { Pool } from 'pg';
import QueryStream from 'pg-query-stream';

@Injectable()
export class ExportsService {
  constructor(private readonly pool: Pool) {}

  orderRowsSince(since: Date): Readable {
    const out = new Readable({ objectMode: true, read() {} });
    this.pool.connect().then((client) => {
      const query = new QueryStream(
        'SELECT id, status, total_cents, created_at FROM orders WHERE created_at >= $1 ORDER BY created_at',
        [since],
        { batchSize: 2_000, highWaterMark: 4_000 }, // rows per fetch and buffered rows before pausing
      );
      const stream = client.query(query);
      stream.on('data', (row) => { if (!out.push(row)) stream.pause(); });
      out._read = () => stream.resume();              // backpressure: resume the cursor when the consumer drains
      stream.on('end', () => { out.push(null); client.release(); });
      stream.on('error', (err) => { out.destroy(err); client.release(err); });
      out.on('close', () => { stream.destroy(); client.release(); }); // client went away
    }).catch((err) => out.destroy(err));
    return out;
  }
}
```

`pipe` propagates backpressure automatically between `rows`, `toCsv`, gzip and the response socket; the manual `pause`/`resume` bridges the `pg-query-stream` cursor into the object-mode `Readable`. With TypeORM you get the same cursor through `queryBuilder.stream()`, which returns a `ReadStream` backed by `pg-query-stream`.

For **Server-Sent Events** (order status updates to a browser), NestJS provides `@Sse()`: return an `Observable<MessageEvent>`, set no compression, and send a comment line every 15 to 30 seconds as a heartbeat so the ALB idle timeout never fires.

```ts
@Sse('orders/:id/events')
events(@Param('id', ParseUUIDPipe) id: string): Observable<MessageEvent> {
  return merge(
    this.orderEvents.forOrder(id).pipe(map((e) => ({ data: e, type: 'status' }) as MessageEvent)),
    interval(20_000).pipe(map(() => ({ data: 'ping', type: 'heartbeat' }) as MessageEvent)), // keeps the ALB idle timer reset
  );
}
```

#### PostgreSQL example

The database side of streaming is the cursor. A `DECLARE CURSOR` with `FETCH` in batches keeps server memory and client memory flat; `pg-query-stream` does exactly this using the extended protocol's portal with a row limit.

```sql
BEGIN;
DECLARE orders_cur NO SCROLL CURSOR FOR
  SELECT id, status, total_cents, created_at
  FROM orders
  WHERE created_at >= '2025-09-01'
  ORDER BY created_at;

FETCH FORWARD 2000 FROM orders_cur;   -- first batch
FETCH FORWARD 2000 FROM orders_cur;   -- next batch, and so on
CLOSE orders_cur;
COMMIT;

-- The plan should be an index scan in created_at order, not a sort of 4 million rows,
-- or the first batch waits for the full sort:
EXPLAIN (ANALYZE, BUFFERS) SELECT id, status, total_cents, created_at
FROM orders WHERE created_at >= '2025-09-01' ORDER BY created_at LIMIT 2000;
-- Limit  (cost=0.56..214.92 rows=2000 width=48) (actual time=0.041..3.812 rows=2000 loops=1)
--   ->  Index Scan using orders_created_at_idx on orders  (actual time=0.039..3.402 rows=2000 loops=1)
--         Index Cond: (created_at >= '2025-09-01 00:00:00+00'::timestamptz)
--   Buffers: shared hit=1873
-- Execution Time: 4.102 ms
```

A cursor holds a transaction (and therefore a snapshot) open for the whole export. On a busy table that blocks `VACUUM` from reclaiming rows for the duration; keep exports bounded and consider a read replica.

#### TypeORM example

```ts
// Streaming through TypeORM's query builder (returns a pg-query-stream backed ReadStream)
const stream = await this.ds
  .createQueryBuilder()
  .select(['o.id', 'o.status', 'o.total_cents', 'o.created_at'])
  .from(Order, 'o')
  .where('o.created_at >= :since', { since })
  .orderBy('o.created_at', 'ASC')
  .stream();
// stream is a Readable of raw rows; pipe it exactly as in the controller above
```

#### Production scenario

A reporting service streams about 900 exports per day, median 80 MB, largest 3 GB. Pod memory during exports stays under 250 MB. Two limits protect the database: a concurrency semaphore of 3 exports per pod and a `statement_timeout` of 30 minutes on the export role. The ALB's idle timeout was raised to 120 seconds for this target group only, because a few exports pause for up to 90 seconds on a slow filter, and the app sends a comment line (`# still working`) on CSV exports every 20 seconds as a keep-alive when no rows have been emitted.

#### Failure scenario

At 14:30 the exports pod memory chart went vertical and the pod restarted every three minutes. The streaming endpoint had been changed to add a "total rows" header, which required counting first; the developer implemented it by collecting all rows into an array, computing the length, then writing them. Streaming was gone, and a 2 GB export was back to loading in memory. The review lesson: any code that needs the size before the first byte is not streaming; either run a separate `COUNT(*)` or send the total in a trailer or a final line.

#### Edge cases & failure modes

- Client disconnect mid-stream: without `res.on('close')` cleanup, the cursor runs to completion and the pool connection is held for minutes.
- Errors after headers are sent: you cannot change the status code to `500`; the client sees a truncated body. Validate and pre-check before writing the first byte; use trailers or a final sentinel line for post-hoc errors.
- Proxies that buffer (`proxy_buffering on`) defeat streaming and reintroduce timeouts.
- Compression middleware buffering SSE.
- HTTP/1.0 clients do not support chunked encoding; Node falls back to `Connection: close` and streams anyway.
- ALB idle timeout counts silence between chunks; a slow first query with no output for 60 seconds is a `504`.
- Long-open cursors block `VACUUM` and hold snapshots; bound export duration.
- `res.write()` without checking the return value buffers unbounded data for slow clients (slow-read attacks, 10.15).

#### How a Senior Backend Engineer thinks about this

Any response that can exceed a few megabytes is streamed, with a cursor on the database side, backpressure end to end, cleanup on client disconnect, and a heartbeat for long-running streams. They know where the proxies buffer and set headers to stop it. They push very large exports to a background job that writes to S3 and returns `202` with a signed URL, because a 3 GB streaming HTTP response is fragile on mobile networks and tie up a pod for minutes. To a product manager: "The report starts downloading immediately and never crashes the server, but for anything above a gigabyte we email a download link instead of holding the connection open for ten minutes."

#### Common mistakes

- Collecting all rows before writing.
- No cursor on the database side.
- Ignoring backpressure.
- No cleanup on client disconnect.
- Streaming through a buffering proxy and wondering why nothing arrives until the end.
- Streaming SSE through a compressor.

#### Interview questions

1. **How does chunked transfer encoding work and why does HTTP/2 not need it?** Size-prefixed chunks with a zero terminator; HTTP/2 frames are inherently sized.
2. **What is backpressure and what happens if you ignore it when streaming from Postgres to a slow client?** The write buffer fills, `write()` returns false; ignoring it buffers the whole result in memory.
3. **How do you keep an ALB from timing out a long-running streaming response?** Emit bytes at least every few seconds (heartbeat), or raise the idle timeout for that target group.
4. **What happens if an error occurs after headers were sent?** Status cannot change; the body is truncated; use pre-validation and a trailer or sentinel.
5. **When would you not stream a large export over HTTP at all?** Multi-gigabyte or long-running exports: background job, S3, signed URL, `202`.

#### Practical exercise

Implement a streaming CSV export of 2 million synthetic orders using a Postgres cursor, backpressure and gzip. Verify with `curl --limit-rate 200k` that pod memory stays flat while the client reads slowly, and that killing `curl` mid-download releases the pool connection within a second. Acceptance criteria: memory graph, `pg_stat_activity` showing the cursor's backend ending on disconnect, and first byte under 100 ms.
