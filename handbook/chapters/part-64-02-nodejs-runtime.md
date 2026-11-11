## 64.2 Node.js runtime

This is the section that separates people who *use* Node from people who can debug it at 3 a.m. Interviewers love it because the answers are checkable and the failure stories are vivid.

### Q13. Walk me through the phases of the Node.js event loop.

- **Expected answer** — libuv runs the loop in ordered phases, and each turn goes through them: **timers** (callbacks whose `setTimeout`/`setInterval` threshold has elapsed), **pending callbacks** (some deferred system callbacks such as certain TCP errors), **idle/prepare** (internal), **poll** (retrieve new I/O events and run their callbacks; this is where the loop blocks waiting for work), **check** (`setImmediate` callbacks), and **close callbacks** (`socket.on('close')`). Between every callback — not just between phases — Node drains the microtask queues: `process.nextTick` first, then promise reactions. The poll phase is the important one: if there are no timers due and no `setImmediate` pending, the loop parks in `epoll_wait`/`kqueue` until an fd is ready or a timeout fires. Everything that "feels async" is one of three things: an fd watched in poll, a task completed on the libuv thread pool, or a timer.

- **Why it matters** — Almost every latency mystery in Node ("my p99 is 800 ms but the query is 3 ms") is explained by loop phases and blocking.

- **Follow-ups** — Where does a `pg` query result callback run? Where does `fs.readFile` complete? What blocks the poll phase from being entered?

- **Senior signal** — Says microtasks drain between *every* callback, and knows the poll phase is where the process idles. A mid-level answer lists phase names from a diagram without the poll-blocking insight.

### Q14. What does this print, and why?

```ts
console.log('1');
setTimeout(() => console.log('2'), 0);
setImmediate(() => console.log('3'));
process.nextTick(() => console.log('4'));
Promise.resolve().then(() => console.log('5'));
(async () => { console.log('6'); await null; console.log('7'); })();
console.log('8');
```

- **Expected answer** — Output: `1, 6, 8, 4, 5, 7, 2, 3` — with the caveat that `2` and `3` can swap. Reasoning: synchronous code runs first (`1`, then the async IIFE runs synchronously up to its first `await`, printing `6`, then `8`). The stack empties, so microtasks drain: the `nextTick` queue has absolute priority, printing `4`; then the promise microtask queue in FIFO order, printing `5` and then `7` (the continuation after `await null` was queued when the IIFE suspended, which was after the `.then` was registered). Then the loop enters its phases: the timer `2` and the check-phase `3`. On the *first* tick from the main module, whether the 1 ms-clamped timer is already due depends on how long startup took, so `2` before `3` or `3` before `2` are both legal; inside an I/O callback, `setImmediate` always wins because you are already past the timers phase.

- **Why it matters** — This single question exposes whether the mental model is real or memorised.

- **Follow-ups** — Why is the `2`/`3` order non-deterministic only at the top level? What changes if you wrap the last two lines in `fs.readFile(__filename, () => { ... })`? What happens if `process.nextTick` recursively schedules itself?

- **Senior signal** — Volunteering the non-determinism and the "inside I/O, immediate always beats timeout" rule, plus the starvation hazard of recursive `nextTick`.

### Q15. What is the libuv thread pool, what uses it, and how big should it be?

- **Expected answer** — It is a small pool of OS threads (default 4, `UV_THREADPOOL_SIZE`, max 1024) that libuv uses for work that has no non-blocking kernel API. That includes almost all `fs` operations, `dns.lookup` (the `getaddrinfo` path), `crypto.pbkdf2`, `scrypt`, `randomBytes` in async form, and zlib compression. Network sockets do **not** use it: TCP/HTTP go through epoll/kqueue in the poll phase. The failure mode is pool saturation: four concurrent `pbkdf2` calls with high iterations mean every subsequent file read and DNS lookup queues behind them, so unrelated endpoints get slow while CPU looks fine and the event loop looks idle. Sizing: raise it toward the number of cores times two if your workload is file- or crypto-heavy, but a bigger pool competes for CPU; the better fix is usually to move heavy crypto to worker threads or a dedicated service and to use `dns.resolve` or a DNS cache instead of `dns.lookup`.

- **Why it matters** — Thread pool saturation is a classic invisible latency source that only experienced Node operators diagnose quickly.

- **Follow-ups** — Does an HTTPS request use the pool? How would you prove saturation from metrics? Why does `UV_THREADPOOL_SIZE` have to be set before the first async call?

- **Senior signal** — Distinguishes network I/O (epoll) from pool I/O, and gives a diagnosis path rather than just a tuning knob.

### Q16. What does "blocking the event loop" mean and how do you detect it in production?

- **Expected answer** — Node runs your JavaScript on one thread. Any synchronous work — a 200 ms `JSON.parse` of a 20 MB payload, a regex with catastrophic backtracking, `crypto.pbkdf2Sync`, a `for` loop over 2 million rows, `fs.readFileSync` — stops the loop, so no other request progresses, no timer fires, and no health check is answered. Symptoms are p99 latency spikes across *all* endpoints simultaneously, timeouts on unrelated calls, and readiness probes failing while CPU on one core sits at 100%. Detect it by measuring event loop delay with `perf_hooks.monitorEventLoopDelay()` (an `IntervalHistogram` you export as a metric) or `toobusy`-style sampling, and alert on p99 loop lag above ~50–100 ms. To find the culprit, take a CPU profile (`--cpu-prof`, `node --inspect` plus Chrome DevTools, or `0x`/`clinic flame`) during the spike; the flame graph names the synchronous function. Fixes: chunk the work with `setImmediate`, stream instead of buffering, move to a worker thread, or push it to a background job.

- **Why it matters** — This is the single most common Node production pathology.

- **Follow-ups** — Which metric would page you? Why does chunking with `setImmediate` help but `setTimeout(fn, 0)` in a tight loop is worse? What is a ReDoS and how do you prevent it?

- **Senior signal** — Names loop-lag as an SLI with a threshold and describes the profiling workflow, instead of saying "don't write blocking code".

### Q17. Worker threads versus cluster — when do you use each?

- **Expected answer** — `cluster` (and the same idea done properly by your orchestrator) forks whole processes that share a listening socket; each has its own V8 heap and event loop. Use it to use all cores for *request throughput* on a normal I/O-bound API. `worker_threads` creates threads inside one process, each with its own isolate and loop, communicating by message passing and able to share raw memory via `SharedArrayBuffer`. Use them for CPU-bound work inside a request path: image resizing, PDF generation, large CSV parsing, heavy crypto, so the main loop stays responsive. Key differences: workers start in ~10–40 ms versus ~50–200 ms for a process, share the process's memory limit, and can transfer `ArrayBuffer`s with zero copy; processes are isolated so one crash does not take the others down. In Kubernetes I usually skip `cluster` entirely and run one Node process per container with `replicas` handling the fan-out, because then the scheduler, not my app, owns scaling and restarts.

- **Why it matters** — A common design decision, and the Kubernetes answer shows whether the candidate has operated Node in a modern platform.

- **Follow-ups** — What is the cost of passing a 50 MB buffer to a worker, and how do you avoid the copy? How do you bound a worker pool? What happens to in-flight requests if a worker throws?

- **Senior signal** — Says "one process per container, let the platform scale" and can justify it, and knows about transferable objects.

### Q18. Explain streams and backpressure. What goes wrong without them?

- **Expected answer** — A stream processes data in chunks with a bounded buffer (`highWaterMark`, 16 KB by default for byte streams). Backpressure is the mechanism where a slow consumer tells a fast producer to pause: `writable.write()` returns `false` when its buffer is full, and a correct producer stops until the `'drain'` event. `pipe()` and, better, `pipeline()` implement that for you and also propagate errors and destroy the streams on failure, which manual `pipe()` does not. Without backpressure — for example reading a 2 GB S3 object into memory and then writing it, or ignoring the return value of `write()` in a loop — the buffer grows unbounded and the process is OOM-killed. A realistic case: exporting 5 million orders to CSV. Streaming from a Postgres cursor through a transform into the HTTP response holds a few megabytes; buffering the array holds several gigabytes and kills the pod.

  ```ts
  await pipeline(queryStream, csvTransform, res); // errors propagate, sockets destroyed
  ```

- **Why it matters** — Streaming is the difference between an export endpoint that works at 10x growth and one that OOMs.

- **Follow-ups** — Why `pipeline` over `pipe`? What does `highWaterMark` mean for an object-mode stream? How do you stream rows out of Postgres with TypeORM or `pg`?

- **Senior signal** — Knows `pipe` leaks on error, and can tie backpressure to a specific OOM incident with numbers.

### Q19. How do you find a memory leak in a Node service?

- **Expected answer** — First confirm it is a leak and not just heap growth toward the limit: chart `process.memoryUsage().heapUsed` and RSS over hours; a leak shows a sawtooth whose troughs rise after each GC. Then capture two heap snapshots minutes apart under load (`node --inspect` plus Chrome DevTools, or `v8.writeHeapSnapshot()` triggered by a signal in production), and use the *comparison* view sorted by delta with "objects allocated between snapshot 1 and 2" — retained size and the retainer path tell you who is holding the memory. Typical culprits I have actually found: an unbounded `Map` used as a cache with no eviction, event listeners added per request to a long-lived emitter (watch for the `MaxListenersExceededWarning`), closures captured by a `setInterval` that is never cleared, request-scoped data pushed into a module-level array for "metrics", and retained references in a global logger context. Also check native/RSS growth separately — a leak outside the JS heap points at Buffers, native addons or fragmentation, and heap snapshots will not show it.

- **Why it matters** — Tests real debugging method rather than tool name-dropping.

- **Follow-ups** — Snapshot on a 4 GB heap pauses the process; how do you do this safely in production? What is the difference between shallow and retained size? How would you find a Buffer leak?

- **Senior signal** — Mentions RSS-versus-heap divergence and the operational cost of taking a snapshot on a live pod, and has a named list of real culprits.

### Q20. How does V8 garbage collection work and when do you touch `--max-old-space-size`?

- **Expected answer** — V8 is generational. New objects go into the small **new space** and are collected by Scavenge, a copying collector that runs often and is fast (sub-millisecond to a few ms) because most objects die young. Survivors are promoted to **old space**, collected by Mark-Compact with incremental marking and concurrent/parallel phases, so pauses are usually a few milliseconds but can reach tens of milliseconds on large heaps. `--max-old-space-size=N` (megabytes) sets the old-space ceiling; exceeding it gives `FATAL ERROR: Ineffective mark-compacts near heap limit — Allocation failed`. You raise it when the working set is genuinely large (a big in-process cache, large batch jobs) *and* the container memory limit is higher — the classic production bug is a container limited to 512 MB with Node defaulting to a larger heap, so the kernel OOM-kills the process before V8 ever GCs. Modern Node reads cgroup limits better, but I still set it explicitly to roughly 75–80% of the container limit, leaving room for Buffers, native memory and the stack.

- **Why it matters** — The heap-limit-versus-container-limit mismatch causes silent `OOMKilled` restarts that people misdiagnose as crashes.

- **Follow-ups** — What is the difference between `OOMKilled` by the kernel and a V8 heap OOM, and how do you tell from the logs? Do Buffers count toward old space? How do you observe GC pauses?

- **Senior signal** — The 75–80% rule with the reason, and distinguishing kernel OOM from V8 OOM by the evidence each leaves.

### Q21. What happens on an unhandled promise rejection, and what should your policy be?

- **Expected answer** — Since Node 15 the default `--unhandled-rejections=throw` turns an unhandled rejection into an uncaught exception, which terminates the process unless you have an `uncaughtException` handler. That is the right default: an unhandled rejection means a code path you did not think about, and continuing with unknown state risks corrupt data. My policy is: keep the default, add a `process.on('unhandledRejection')` handler whose only job is to *log with context* and then let the process die, run a supervisor (Kubernetes) that restarts it, and make sure graceful shutdown drains in-flight requests. Never swallow. In Nest, most rejections inside a request are caught by the framework and turned into a 500 by the exception filter; the dangerous ones are fire-and-forget calls in event handlers, `setInterval` bodies and `@Cron` jobs, which is exactly why `no-floating-promises` lint is worth enforcing.

- **Why it matters** — Reveals attitude to failure: hide it or surface it.

- **Follow-ups** — Why is `uncaughtException` a bad place to keep serving traffic? How does this interact with a readiness probe? What is the difference between the rejection being unhandled and being handled late?

- **Senior signal** — Crash-only thinking: log, exit, restart, drain — instead of "catch everything and keep going".

### Q22. How do you implement graceful shutdown?

- **Expected answer** — On `SIGTERM`: (1) immediately flip the readiness probe to failing so the load balancer stops sending new requests, and wait a few seconds for endpoints to propagate — this is the step everyone forgets and it is the reason for 502s during deploys; (2) call `server.close()` so no new connections are accepted while in-flight requests finish, and destroy idle keep-alive sockets; (3) stop consuming from queues and let in-flight messages finish or be nacked for redelivery; (4) stop cron/schedulers; (5) close the database pool and Redis clients; (6) `process.exit(0)`. Everything gets a hard timeout — typically 20–25 seconds against a Kubernetes `terminationGracePeriodSeconds` of 30 — after which you force exit, because a hung shutdown becomes a `SIGKILL` and a truncated write. Nest gives you this with `app.enableShutdownHooks()` plus `OnApplicationShutdown`/`beforeApplicationShutdown` on providers.

- **Why it matters** — Deploy-time 5xx spikes are almost always missing readiness-first shutdown.

- **Follow-ups** — Why sleep before `server.close()`? What happens to a message you have pulled from SQS but not finished? How do keep-alive connections from an ALB complicate this?

- **Senior signal** — The readiness-first ordering with the propagation delay, and hard timeouts on every step.

### Q23. `process.nextTick` versus `setImmediate` — what is the difference and when does it bite?

- **Expected answer** — `process.nextTick` puts the callback on a queue that is drained *before* promise microtasks and before the loop advances to the next phase — it is not part of the loop at all. `setImmediate` schedules for the check phase, so it runs after the current poll phase completes. So `nextTick` is "as soon as the current operation finishes", `setImmediate` is "on the next loop iteration". It bites in two ways: recursive `nextTick` starves the event loop completely (I/O never runs, the process hangs while CPU idles), and library authors use `nextTick` to make a callback consistently asynchronous, which can surprise you with ordering. The safe default in application code is `setImmediate` when you want to yield to I/O — for example, chunking a large loop so requests keep being served. Use `nextTick` only to guarantee "always async" semantics for an API that might otherwise call back synchronously.

- **Why it matters** — Direct probe of event-loop understanding with a real starvation failure mode.

- **Follow-ups** — Write a chunked processor for 1 million rows that yields. What order do `nextTick` and `Promise.resolve().then` run in? Which one would you use to defer an error emit?

- **Senior signal** — The starvation failure mode and the "use setImmediate to yield to I/O" rule.

### Q24. Why do you need HTTP keep-alive agents in Node, and what breaks without them?

- **Expected answer** — By default the legacy `http.globalAgent` did not keep connections alive (this changed in Node 19, where keep-alive is on by default), and `fetch`/undici pools separately. Without keep-alive, every outbound call does a fresh TCP handshake plus a TLS handshake — roughly 1 RTT plus 1–2 RTTs — which on a 30 ms link adds 60–90 ms per call, and it burns ephemeral ports and file descriptors. With a shared agent (`new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 20, timeout: 60_000 })`), calls reuse warm connections and latency drops to the raw RTT. The failure modes to know: `maxSockets` too low silently queues requests inside the agent, so you see client-side latency with no server-side latency; keep-alive idle timeout longer than the peer's or the ALB's produces `ECONNRESET`/`socket hang up` on the first request after the peer closes, which you fix by setting your idle timeout below theirs and enabling retries on idempotent requests only.

- **Why it matters** — Service-to-service latency and mysterious ECONNRESETs both trace back here.

- **Follow-ups** — Why must the retry be restricted to idempotent requests? How would you see agent queuing in metrics? What does `maxFreeSockets` control?

- **Senior signal** — The idle-timeout mismatch story and the "queue is invisible unless you instrument the agent" point.

### Q25. Can DNS resolution block your Node process?

- **Expected answer** — Yes, indirectly. `dns.lookup()` — which is what `http.request`, `pg`, and most clients use under the hood — calls `getaddrinfo` on the libuv thread pool, not through an async DNS protocol implementation. With the default pool of four threads, four slow lookups (a DNS server timing out at 5 seconds) occupy the entire pool, so all `fs` operations, crypto and further lookups queue behind them, and the whole service appears to stall even though the event loop is technically free. `dns.resolve*()` uses c-ares and real async sockets, so it does not consume the pool, but it ignores `/etc/hosts` and the system resolver order. Mitigations: cache DNS results in-process (`cacheable-lookup` wired into your agents), keep connections alive so you resolve rarely, raise `UV_THREADPOOL_SIZE`, and in Kubernetes reduce `ndots` churn with an explicit `dnsConfig` or fully qualified names so you do not do five failed lookups per resolution.

- **Why it matters** — DNS is the classic hidden dependency in "everything got slow at once" incidents.

- **Follow-ups** — What is `ndots:5` doing in a Kubernetes pod and why does it multiply lookups? How would you prove DNS is the problem? Which is safer for a service mesh, `lookup` or `resolve`?

- **Senior signal** — Connects DNS to thread pool saturation and mentions the Kubernetes `ndots` amplification, which is a scar you only get from operating clusters.

### Q26. Your service starts throwing `EMFILE`. What is happening and how do you fix it?

- **Expected answer** — `EMFILE` means "too many open files": the process has hit its file-descriptor limit (`ulimit -n`, often 1024 in a stock container). In Node, sockets, files, pipes and epoll instances are all descriptors. Common causes: a leak of open file handles or sockets (streams never closed on error paths, `pipe()` without error handling), a client library creating a new connection pool per request, keep-alive with `maxSockets: Infinity` against a slow upstream so sockets pile up, or genuine high concurrency with an unrealistically low limit. Diagnose with `lsof -p <pid>` or counting `/proc/<pid>/fd`, grouped by type — that instantly tells you if it is sockets to one host or files. Fixes in order: fix the leak, bound the pools, then raise the limit (`LimitNOFILE`/`ulimit -n 65535`) and confirm the container's limit matches. Raising the limit first just delays the incident and hides the leak.

- **Why it matters** — Tests systems knowledge beyond JavaScript and a disciplined diagnosis order.

- **Follow-ups** — How do you count descriptors by type? What does `EMFILE` do to your ability to accept *any* new connection, including the health check? Why is `graceful-fs` a band-aid?

- **Senior signal** — "Fix the leak before raising the limit", plus knowing the health check dies too, which is why the pod looks unhealthy rather than slow.

### Q27. Node is single-threaded. So why do race conditions still happen?

- **Expected answer** — Single-threaded means no *preemption* inside one synchronous block, not no interleaving. Every `await` is a yield point: between the two halves of an `async` function, other requests run and can change shared state. So classic races appear: read-modify-write on a module-level `Map`, two requests both checking "does this email exist?" then both inserting, a cached value refreshed by two requests at once, or a counter incremented after an `await`. Add multiple processes and pods, and any in-process guard is worthless anyway. The correct fixes are the boring ones: push the invariant into the database (`UNIQUE` constraint, `INSERT ... ON CONFLICT`, `SELECT ... FOR UPDATE`, optimistic concurrency with a version column) or into Redis (`SET key val NX PX ttl` as a lock, `INCR` for counters). An in-memory mutex is acceptable only for a single-process-local resource such as serialising writes to one file.

  ```ts
  // race: two concurrent calls both see 0 and both write 1
  const n = await redis.get(key); await redis.set(key, Number(n) + 1);
  // correct: atomic
  await redis.incr(key);
  ```

- **Why it matters** — This misconception ("Node is single-threaded so no locks needed") causes duplicate orders and double charges.

- **Follow-ups** — Where exactly is the yield point in your example? Why does a process-local mutex fail with three replicas? How would you make "create user if not exists" correct?

- **Senior signal** — Names `await` as the yield point and immediately moves the invariant to the database, rather than reaching for an application-level lock.

### Q28. How do you profile a Node service that is using too much CPU?

- **Expected answer** — Start from evidence, not guesses. Confirm it is CPU and not loop lag from I/O by looking at process CPU, event loop delay and GC time together. Then capture a CPU profile from the affected instance: `node --cpu-prof` for a bounded run, `--inspect` plus DevTools for a live capture, `clinic flame`/`0x` for a flame graph, or a continuous profiler (Pyroscope, Datadog) if you have one, which is far better because you can profile the past rather than trying to reproduce. Read the flame graph by self time first: wide plateaus are the cost. Typical findings are JSON serialisation of oversized responses, `class-transformer` on big arrays, regex backtracking, synchronous crypto, logging at debug level in a hot path, and unnecessary deep clones. Fix, then re-profile to confirm — and set a regression guard, such as an autocannon benchmark in CI or an alert on CPU per request. Also compare against a baseline: 100% of one core with 40 ms of GC per second is a memory problem wearing a CPU costume.

- **Why it matters** — Method beats tools; the answer shows whether they measure or guess.

- **Follow-ups** — What does high GC time in the profile tell you? How do you profile a pod you cannot restart? What is the overhead of a continuous profiler?

- **Senior signal** — Continuous profiling, self-time-first reading, and closing the loop with a regression guard.
