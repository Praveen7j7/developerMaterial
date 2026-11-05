# Part 2 — Asynchronous JavaScript

Backend code spends most of its life waiting. It waits for the database to answer a query, for a payment provider to respond, for a file to be read from disk, for another service across the network. Those waits are long — a database query is a few milliseconds, a cross-region HTTP call can be a hundred — and if your program stopped dead during every wait, it could serve one user at a time. Asynchronous programming is how JavaScript handles thousands of simultaneous requests on a single thread by never standing still during a wait.

This Part teaches asynchronous JavaScript from the beginning. We start with the event loop at a level a beginner can hold in their head (Part 9 goes much deeper). Then callbacks, the original way to handle "do this when the result arrives", and the "callback hell" that made them painful. Then promises, the object that represents a future value. Then `async`/`await`, the modern syntax that makes asynchronous code read like ordinary code. We finish with error handling in asynchronous code and the pitfalls that catch everyone at least once.

If this is the one Part of Volume 0 you half-skip, your backend career will be a long series of confusing bugs. Asynchronous code is where beginners write things that work on their laptop with one user and fall apart in production with a thousand. Spend the time here.

**How to run the examples.** Every complete example in this Part is a script you can run, and the output under it is what it really printed. Save it as, say, `trace.ts` and run `node trace.ts`; Node 22.18 and newer (every current LTS release) strips TypeScript types by itself. On an older Node, use `npx tsx trace.ts`. Timings will differ a little on your machine; the order of lines will not. Snippets that call made-up functions such as `fetchOrder` show a shape and are not meant to run.

The habit that teaches asynchronous code fastest: **predict the output before you run it.** Write your guess down, run the script, and when you were wrong, work out why. Each "Try it yourself" block gives you a few of these, with answers.

## 2.1 Why asynchronous code exists

### 2.1.1 The single thread and the event loop

#### Concept

Node.js runs your JavaScript on **one thread** — one worker, doing one thing at a time. That sounds like a limitation, and it would be, except that Node does not sit idle during slow operations. When your code asks for something slow (a database query, a network call, a file read), Node hands that work off to the operating system, moves on to other work, and comes back to your code when the result is ready. The mechanism that juggles this is the **event loop**.

#### Why does it exist?

A web server must handle many requests at once. The old model gave each request its own operating-system thread, which is simple but expensive: each thread uses memory and the operating system spends effort switching between thousands of them. Node took a different bet: one thread, but never block it. Because most of a backend's time is spent **waiting** (on I/O — input/output — not on computing), one thread that never waits idly can handle enormous concurrency cheaply. This is why a single Node process can serve tens of thousands of simultaneous connections.

#### Mental model

Imagine a single chef in a kitchen (the one thread). A naive chef puts a pot on to boil and stands there watching it for ten minutes, doing nothing else. A good chef puts the pot on, sets a timer, and starts chopping vegetables for the next order. When the timer rings (the event), they come back to the pot. The chef is never cloned — there is always exactly one — but they are never idle while something cooks. The event loop is the chef's habit of always checking "what is ready now?" and never standing and staring at a pot.

The crucial consequence: if the chef ever does a task that cannot be set aside — say, hand-grinding spices for ten minutes with full attention — then every other order waits, because there is only one chef. In Node, a long **synchronous** computation (a giant loop, parsing a huge string, a slow regular expression) is exactly that: it blocks the one thread, and every other request freezes until it finishes. This is the most important thing to understand about Node.

#### How it works

Here is the beginner's picture of the event loop. (Part 9.16 to 9.18 cover the event loop phases, microtasks, macrotasks and libuv in full.)

```text
  Your synchronous code runs top to bottom on the one thread.
        |
        |  hits a slow operation (query, HTTP, timer, file read)
        v
  Node hands it to the OS / a thread pool and registers a callback
        |
        |  your code keeps running; the thread is free
        v
  [ Event loop ] keeps checking: "is any result ready?"
        |
        |  when a result arrives, its callback is queued
        v
  The callback runs on the one thread when it is free again
```

Three things to take away:

1. **Your own JavaScript is never interrupted mid-function.** A function runs to completion before anything else runs. This makes a lot of reasoning simple — there are no surprise interruptions in the middle of your code.
2. **Slow I/O does not block the thread**, because Node hands it off and comes back via a callback.
3. **Slow computation does block the thread**, because computation is your JavaScript, and your JavaScript holds the one thread until it returns.

#### Practical example

```ts
console.log('1: start');

setTimeout(() => {
  console.log('3: timer fired after everyone else');
}, 0);

console.log('2: end');

// Output order:
// 1: start
// 2: end
// 3: timer fired after everyone else
```

Even though the timer is `0` milliseconds, `3` prints last. The `setTimeout` callback is handed to the event loop and can only run **after** the current synchronous code (`1` and `2`) finishes. This surprises every beginner and is the clearest demonstration that "asynchronous" means "later, when the thread is free", not "right now in parallel".

#### Step-by-step trace: two requests sharing one thread

Let us slow the event loop right down and watch it work. Below, two "requests" each send a database query. We fake the queries with timers: request 1's query takes 20 ms, request 2's takes 10 ms.

```ts
console.log('A: request 1 arrives, query sent');
setTimeout(() => console.log('D: request 1 query result'), 20);
setTimeout(() => console.log('C: request 2 query result'), 10);
console.log('B: request 2 arrives, query sent');
```

```text
A: request 1 arrives, query sent
B: request 2 arrives, query sent
C: request 2 query result
D: request 1 query result
```

Here is what the one thread does, moment by moment:

| Time | What the thread does | Waiting in the background |
|---|---|---|
| 0 ms | Prints `A`. Registers a 20 ms timer. Registers a 10 ms timer. Prints `B`. The script's top-level code ends. | 20 ms timer, 10 ms timer |
| 0 to 10 ms | Nothing. The thread is idle and free for any other work. | both timers |
| 10 ms | The event loop sees the 10 ms timer is due and runs its callback: prints `C`. | 20 ms timer |
| 10 to 20 ms | Idle again. | 20 ms timer |
| 20 ms | Runs the 20 ms timer's callback: prints `D`. Nothing is left, so Node exits. | nothing |

Three lessons are hiding in that table:

1. **Both queries were "in flight" at the same time**, even with one thread. The waiting happened in the background; the thread only did the tiny bits of work at the start and the end.
2. **Results come back in the order they finish, not the order you asked.** Real database and HTTP calls behave the same way; never assume a reply order.
3. **The total time was about 20 ms, not 30 ms.** The waits overlapped, which is the whole reason Node can serve many users on one thread.

#### Seeing the block for yourself

Now the bad case. In this script a "heartbeat" timer fires every 100 ms; think of each beat as "other users being served". At about 250 ms, one request does 600 ms of pure computation, like the CSV parser in the failure story below.

```ts
// Every 100 ms the "heartbeat" stands in for other users being served.
const start = Date.now();
let last = start;
const heartbeat = setInterval(() => {
  const now = Date.now();
  console.log(`t=${now - start} ms  other users served (gap ${now - last} ms)`);
  last = now;
}, 100);

// At about 250 ms, one request does 600 ms of pure computation.
setTimeout(() => {
  console.log(`t=${Date.now() - start} ms  CSV request starts a synchronous parse`);
  const busyUntil = Date.now() + 600;
  while (Date.now() < busyUntil) {
    // pretend to parse rows; the thread never gets a chance to do anything else
  }
  console.log(`t=${Date.now() - start} ms  CSV parse finished`);
}, 250);

setTimeout(() => clearInterval(heartbeat), 1150);
```

```text
t=101 ms  other users served (gap 101 ms)
t=203 ms  other users served (gap 102 ms)
t=251 ms  CSV request starts a synchronous parse
t=851 ms  CSV parse finished
t=851 ms  other users served (gap 648 ms)
t=952 ms  other users served (gap 101 ms)
t=1053 ms  other users served (gap 101 ms)
```

Look at the gap of `648 ms`. The heartbeat wanted to run at 300, 400 and so on up to 800 ms, but the thread was stuck in the `while` loop. Those beats were simply skipped, and the next one ran the moment the loop let go. In a real server, every request that arrived during those 600 ms waited up to 600 ms extra, no matter how simple it was. That delay is called **event-loop lag**, and production teams graph it (Part 9.27 shows how).

#### Production scenario

A NestJS endpoint handles 2,000 requests per second on a single Node process. Each request does three database queries (about 2 ms each) and one call to a pricing service (about 40 ms). The thread is busy with actual JavaScript for maybe 0.5 ms per request; the other ~46 ms is waiting on I/O, during which the thread serves other requests. That is how one thread serves 2,000 requests per second: it is almost never computing, almost always waiting, and the event loop fills the waits with other requests' work.

#### Failure scenario

At 14:20 an endpoint that validates uploaded CSV files starts timing out for **all** users, not just the ones uploading. The cause: a new feature parsed each uploaded file with a synchronous loop that, for a large file, ran for 800 milliseconds of pure computation. During those 800 ms the one thread was held, so every other request — logins, product pages, checkouts — queued behind it. The dashboard showed the whole service degraded whenever anyone uploaded a big file. The fix was to move the parsing off the main thread (a worker thread, Part 9.20) and to stream the file instead of loading it whole. The lesson: on Node, one slow synchronous operation harms everyone.

#### Edge cases & failure modes

- A long synchronous loop or heavy computation blocks every request (CPU-bound work needs worker threads or a separate service; Part 9).
- A synchronous file read (`fs.readFileSync`) in a request handler blocks the thread for the duration of the read; always use the asynchronous versions in a server.
- A catastrophic regular expression (ReDoS) can block the thread for seconds on a crafted input — both a performance and a security problem (Part 39 — Security).

#### How a Senior Backend Engineer thinks about this

A senior carries one rule from this section into everything: **do not block the event loop.** They know Node's superpower is handling many concurrent waits cheaply and its weakness is CPU-bound work, so they keep request handlers light on computation, push heavy work to background workers (Part 35 — Background Jobs and Schedulers), and measure event-loop lag as a first-class metric (Part 9.27). When someone proposes doing image processing or large-file parsing inside a request handler, the senior's first question is "how long does that hold the thread, and whom does it block while it runs?"

#### Common mistakes

- Thinking `setTimeout(fn, 0)` runs `fn` immediately; it runs after the current synchronous code.
- Doing heavy computation in a request handler and blocking all other requests.
- Using synchronous file or crypto functions (`...Sync`) in a server.
- Assuming Node is multi-threaded for your code; your JavaScript runs on one thread.

#### Interview questions

1. **Node runs on one thread — how does it handle thousands of concurrent requests?** It never blocks the thread on I/O; it hands slow operations to the OS and returns to them via callbacks through the event loop, filling the waits with other work.
2. **Why does `setTimeout(fn, 0)` not run `fn` immediately?** The callback is queued and can only run after the current synchronous code finishes and the event loop reaches it.
3. **What is the danger of a CPU-bound loop in a request handler?** It blocks the single thread, freezing every other request until it finishes.

#### Practical exercise

Write a script that prints `A`, schedules a `setTimeout(..., 0)` that prints `C`, and prints `B`, then predict and verify the output order. Then add a synchronous loop that counts to 1 billion between `A` and `B` and observe that `C` is delayed by the whole loop, demonstrating event-loop blocking. Acceptance criteria: explain in two sentences why `C` is delayed.

#### Worked answer to the exercise

```ts
const start = Date.now();
console.log('A');
setTimeout(() => console.log(`C (after ${Date.now() - start} ms)`), 0);

let count = 0;
for (let i = 0; i < 1_000_000_000; i++) {
  count++;
}

console.log(`B (loop counted to ${count} in ${Date.now() - start} ms)`);
```

```text
A
B (loop counted to 1000000000 in 298 ms)
C (after 299 ms)
```

The two-sentence explanation: the timer callback can only run when the thread is free, and the thread is not free until all the top-level synchronous code (including the whole loop) has finished. So a "0 ms" timer waited about 300 ms, and in a server every other request would have waited the same 300 ms.

#### Try it yourself

Predict the output of each script before you run it. Answers follow.

**1. Two timers with the same delay.**

```ts
console.log('order received');
setTimeout(() => console.log('email sent'), 0);
setTimeout(() => console.log('invoice generated'), 0);
console.log('response returned');
```

**2. A slow query and a fast query.**

```ts
setTimeout(() => console.log('slow query done'), 50);
setTimeout(() => console.log('fast query done'), 5);
console.log('handler finished');
```

**3. A timer stuck behind a busy loop.** How many milliseconds will the message report?

```ts
const start = Date.now();
setTimeout(() => console.log(`timer ran after ${Date.now() - start} ms`), 10);
const until = Date.now() + 200;
while (Date.now() < until) {
  // busy: nothing else can run
}
console.log('loop done');
```

**Answers.**

1. `order received`, `response returned`, `email sent`, `invoice generated`. Synchronous lines first. Timers with the same delay run in the order they were registered.
2. `handler finished`, `fast query done`, `slow query done`. The synchronous line runs first; then results arrive in the order they finish, not the order they were asked for.
3. `loop done`, then `timer ran after 201 ms` (about 200 on your machine). The timer asked for 10 ms but could not run until the busy loop gave the thread back. A timer's delay is a minimum wait, never a guarantee.
