## 34.7 Connection management

### 34.7.1 Limits, memory, file descriptors and load balancers

#### Concept

A long-lived connection is a resource on every hop: a file descriptor and socket buffers in the kernel, a socket object and its buffers in Node.js, a connection table entry in the load balancer, and NAT state in the client's network. Managing connections means knowing those limits, staying inside them, and getting connections off a pod cleanly when it must go away.

#### How it works

**Per-pod limits.** A Node.js process holding 50,000 idle Socket.IO connections uses roughly 1 to 1.5 GB of heap (about 20 to 30 KB per socket for the objects, buffers and room maps) and a similar amount in kernel socket buffers. The container also needs enough file descriptors: the default `ulimit -n` of 1,024 in many base images means the 1,025th connection fails with `EMFILE`. Set it to at least 2 times the connection target (`ulimit -n 131072` in the entrypoint, or the container runtime's `nofile` limit). A practical per-pod target is 10,000 to 30,000 connections, sized so a single pod's loss is a manageable reconnect wave (34.9).

**Sticky sessions versus stateless with the Redis adapter.** Socket.IO's long-polling transport requires that every HTTP request of one session hits the same pod, so with polling enabled you need sticky sessions at the load balancer (cookie-based or IP hash). With `transports: ['websocket']` only, there is one TCP connection per client and stickiness is irrelevant: the connection is pinned to a pod by nature. The Redis adapter handles fan-out. The tradeoff is that clients behind a proxy that blocks WebSocket upgrades cannot connect at all. Most teams run websocket-only on the mobile apps and websocket-with-polling-fallback on the web, and enable stickiness at the ingress for the polling path.

**Load balancer and ingress configuration.** Three settings break WebSockets when wrong:

| Layer | Setting | Safe value | Symptom when wrong |
|---|---|---|---|
| AWS ALB | `idle_timeout.timeout_seconds` | 300 or more, above the ping interval | Connections closed every 60 s with no close frame; clients reconnect in a wave |
| AWS NLB | Idle timeout is fixed at 350 s | Ping at least every 60 s so the flow stays alive | Same as above after 350 s of silence |
| nginx ingress | `proxy-read-timeout`, `proxy-send-timeout` | 3600 | Connections dropped at 60 s |
| nginx ingress | `Upgrade` and `Connection` headers passed through | On by default in the ingress-nginx controller; manual nginx needs `proxy_set_header Upgrade $http_upgrade` and `Connection "upgrade"` | Handshake returns 400 or 502 |
| Cloudflare and other CDNs | WebSocket support enabled; timeouts around 100 s | Ping under the timeout | Periodic drops |

**Graceful shutdown.** A pod that receives `SIGTERM` must drain, not vanish. The order matters: fail readiness first so the load balancer stops sending new upgrades, tell connected clients to reconnect with a spread of delay, close sockets, then exit before the termination grace period ends.

```ts
// realtime/orders.gateway.ts (shutdown handling)
import { BeforeApplicationShutdown } from '@nestjs/common';

export class OrdersGateway implements BeforeApplicationShutdown {
  @WebSocketServer() server: Server;

  async beforeApplicationShutdown(signal?: string) {
    this.log.warn({ signal, clients: this.server.engine.clientsCount }, 'draining websocket connections');
    this.health.markNotReady();                          // readiness returns 503 from now on
    await new Promise((r) => setTimeout(r, 5_000));      // let the LB observe the readiness change
    const sockets = await this.server.local.fetchSockets();
    for (const socket of sockets) {
      // Tell each client when to reconnect; spread over 0 to 10 seconds to avoid a stampede.
      socket.emit('server.reconnect', { afterMs: Math.floor(Math.random() * 10_000) });
    }
    await new Promise((r) => setTimeout(r, 2_000));      // give the emits time to flush
    this.server.local.disconnectSockets(true);           // close what is left
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
```

Set `terminationGracePeriodSeconds` on the pod to more than the sum of those waits (30 seconds here is safe). `server.local` restricts `fetchSockets` and `disconnectSockets` to this pod, which is what you want during a shutdown; without it, the Redis adapter would ask the whole fleet.

**Backpressure on slow clients.** A client on a bad mobile link cannot read as fast as you write. Every `emit` to it appends to the socket's write buffer in Node.js; nothing stops the buffer growing until the process runs out of memory. For high-frequency streams, prefer the newest message over the complete history: coalesce (keep only the latest driver location per client, not the last 50), or use Socket.IO's `volatile` flag, which drops the emit when the underlying transport is not writable.

```ts
// Coalescing location updates: only the latest position per order is kept for a slow client.
this.server.to(`order:${orderId}`).volatile.emit('driver.location', { orderId, lat, lng, seq });

// Detecting a slow client on raw ws: check the buffered amount before writing.
if (ws.bufferedAmount > 256 * 1024) {
  ws.close(1008, 'slow consumer');   // or skip this message and let the client refetch
}
```

For Socket.IO, `socket.conn.transport.writable` and the Engine.IO `writeBuffer` length tell you whether the client is keeping up; a bounded policy ("drop the connection when the buffer exceeds 1 MB") protects the pod from one bad client.

#### Production scenario

A gateway deployment of 10 pods at 20,000 connections each, 2 CPU and 3 GB memory per pod, `ulimit -n 65536`, websocket-only transport, ALB idle timeout 600 seconds, ping every 25 seconds. A rolling deploy with `maxSurge: 2, maxUnavailable: 0` replaces one pod at a time; each drain moves 20,000 clients over 10 seconds, about 2,000 reconnects per second across the remaining 11 pods, each costing one JWT verify and one Redis round trip. The deploy of 10 pods takes 8 minutes and never exceeds 3,000 handshakes per second fleet-wide.

#### Failure scenario

At 10:00 a cost-saving change lowers the ALB idle timeout from 600 to 60 seconds. The ping interval is 25 seconds, so connections should survive. But the mobile client has a battery optimization that pauses timers in the background, so backgrounded apps stop answering pings and the ALB closes them at 60 seconds instead of the server's 45. Every backgrounded app now reconnects every minute: 150,000 extra handshakes per minute, JWT verification CPU triples, and the p99 of the REST API on the shared pods goes from 80 to 900 ms. The fix was the timeout back to 600 seconds and a separate gateway deployment so that WebSocket handshake load can never affect the REST path again.

#### Edge cases & failure modes

- `EMFILE` when the file descriptor limit is hit; the process keeps running but every new connection and every outbound HTTP call fails.
- Kernel `net.core.somaxconn` and `tcp_max_syn_backlog` too low for a reconnect wave; connections are refused at the TCP level before Node.js sees them.
- A pod at 95 percent memory during a reconnect wave gets OOMKilled, which triggers another wave on the other pods: a cascade. Keep 40 percent headroom on gateway pods.
- `SIGTERM` handled but readiness not failed first; the load balancer keeps sending upgrades to a pod that is closing them.
- `disconnectSockets()` without `server.local` during shutdown disconnects every socket on every pod.

#### How a Senior Backend Engineer thinks about this

They run the gateway as its own deployment with its own HPA scaled on connection count and CPU, never inside the REST API pods, so a reconnect storm cannot take down checkout. They set the per-pod connection ceiling from the reconnect arithmetic ("if this pod dies, can the others absorb 20,000 handshakes in 10 seconds?") rather than from memory alone. They put every timeout in a table, from the client's ping to the CDN's idle limit, and make sure each layer's timeout is longer than the one below it.

## 34.8 Heartbeats

### 34.8.1 Detecting dead connections

#### Concept

TCP does not tell you a peer is gone. A phone that loses signal, a laptop that closes its lid, a NAT gateway that forgets a mapping, a pod that is killed: none of them send a close frame. The server keeps the socket, keeps the room membership, keeps counting the client as online, and keeps writing into a buffer nobody reads. Heartbeats exist to turn silence into a decision.

#### How it works

- **Server ping, client pong** (Socket.IO's default): the server sends a ping every `pingInterval` (25 seconds); if no pong arrives within `pingTimeout` (20 seconds), the server closes the socket and fires `disconnect` with reason `ping timeout`. Cost: one tiny frame per connection per 25 seconds; at 200,000 connections that is 8,000 frames per second fleet-wide, negligible.
- **Client ping** as well, for detecting a dead server from the client side: a client that has not received anything (including pings) within `pingInterval + pingTimeout` assumes the connection is dead and reconnects. Socket.IO clients do this automatically.
- **Protocol-level ping/pong frames** on raw `ws`: call `ws.ping()` on a timer, mark the socket alive on `pong`, and terminate sockets that missed two consecutive pings.

```ts
// Raw ws heartbeat: terminate sockets that did not answer the previous ping.
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as any).isAlive === false) { ws.terminate(); continue; }   // missed a ping
    (ws as any).isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('connection', (ws) => {
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });
});
```

**NAT and idle timeouts** are why the interval is what it is. Home routers and mobile carrier NATs drop idle TCP mappings after somewhere between 30 seconds and a few minutes; once the mapping is gone, the next server-to-client frame vanishes, and the client only finds out when it tries to send. A ping every 25 seconds keeps the mapping alive on almost every network. Below 15 seconds you waste battery on mobile; above 60 seconds you start losing connections on aggressive carriers.

Choose the numbers as a table, with each layer's timeout larger than the one it wraps: ping interval 25 s, pong timeout 20 s (so detection takes at most 45 s), load balancer idle timeout at least 120 s, ingress read timeout 3,600 s. Detection latency is the sum of interval and timeout; a product that needs "offline within 10 seconds" needs a 5 second interval and pays for it in traffic and battery.

#### Edge cases & failure modes

- A pong is answered by the client's network stack even when the application is frozen (protocol-level pong is automatic in browsers). If you need "the app is alive", send an application-level heartbeat message and have the app respond.
- Mobile OS background restrictions suspend JavaScript timers; the client cannot ping, and the server sees a timeout. Treat mobile background as an expected disconnect, keep the presence TTL, and let the client reconnect on foreground.
- Ping frames count as traffic to some load balancers' idle timers and not to others; test yours.
- A ping timeout during a GC pause or event loop stall on the server disconnects healthy clients in bulk; the event loop lag metric from Part 42 tells you that this is what happened.

#### Interview questions

1. *Why does a WebSocket message emitted on one pod not reach a client on another, and how do you fix it?* Expected: rooms are in-memory per process; a Pub/Sub adapter broadcasts emit intent to every pod. Follow-up: what happens when Redis is down? (Pods become islands; readiness should fail.)
2. *Design presence for a chat app with multiple devices per user.* Expected: TTL key per device refreshed on heartbeat, device set per user, offline only when no live devices, lazy cleanup, last-seen in PostgreSQL. Follow-up: what is the staleness bound after a pod crash?
3. *How do you drain a WebSocket pod during a deploy?* Expected: fail readiness, wait, tell clients to reconnect with jitter, close local sockets, exit within the grace period.
4. *What is backpressure on a WebSocket and how do you handle it?* Expected: slow client, write buffer grows; coalesce, `volatile`, drop the connection at a threshold.
5. *Why 25 seconds for a ping interval?* Expected: NAT mapping timeouts and load balancer idle timeouts versus battery; detection latency is interval plus timeout.
6. *Sticky sessions or not?* Expected: required only for long-polling; websocket-only plus the Redis adapter is stateless from the LB's point of view.

#### Practical exercise

Make the order gateway safe to run as three pods:

1. Install the Redis adapter; run three instances of the gateway behind a local nginx with WebSocket upgrade support and a 60 second read timeout.
2. Implement `PresenceService` with 60 second TTL keys and 25 second refresh; expose `GET /presence/:userId` for the notification service.
3. Implement graceful drain on `SIGTERM` with a jittered `server.reconnect` message.
4. Acceptance: a message published through pod 1 reaches a client on pod 3 within 50 ms; killing pod 2 with `SIGKILL` leaves its users online in Redis for at most 60 seconds; sending `SIGTERM` to pod 2 reconnects its clients to the other pods spread over 10 seconds with no client seeing an error; a client that stops answering pings is disconnected within 45 seconds and its presence key deleted; with the nginx read timeout at 60 seconds and pings at 25 seconds, no connection drops over a 10 minute idle test.
