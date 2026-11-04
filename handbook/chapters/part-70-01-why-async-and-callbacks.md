# Part 70 — Asynchronous JavaScript

Backend code spends most of its life waiting. It waits for the database to answer a query, for a payment provider to respond, for a file to be read from disk, for another service across the network. Those waits are long — a database query is a few milliseconds, a cross-region HTTP call can be a hundred — and if your program stopped dead during every wait, it could serve one user at a time. Asynchronous programming is how JavaScript handles thousands of simultaneous requests on a single thread by never standing still during a wait.

This Part teaches asynchronous JavaScript from the beginning. We start with the event loop at a level a beginner can hold in their head (Part 3 goes much deeper). Then callbacks, the original way to handle "do this when the result arrives", and the "callback hell" that made them painful. Then promises, the object that represents a future value. Then `async`/`await`, the modern syntax that makes asynchronous code read like ordinary code. We finish with error handling in asynchronous code and the pitfalls that catch everyone at least once.

If this is the one Part of Volume 0 you half-skip, your backend career will be a long series of confusing bugs. Asynchronous code is where beginners write things that work on their laptop with one user and fall apart in production with a thousand. Spend the time here.

## 70.1 Why asynchronous code exists

### 70.1.1 The single thread and the event loop

#### Concept

Node.js runs your JavaScript on **one thread** — one worker, doing one thing at a time. That sounds like a limitation, and it would be, except that Node does not sit idle during slow operations. When your code asks for something slow (a database query, a network call, a file read), Node hands that work off to the operating system, moves on to other work, and comes back to your code when the result is ready. The mechanism that juggles this is the **event loop**.

#### Why does it exist?

A web server must handle many requests at once. The old model gave each request its own operating-system thread, which is simple but expensive: each thread uses memory and the operating system spends effort switching between thousands of them. Node took a different bet: one thread, but never block it. Because most of a backend's time is spent **waiting** (on I/O — input/output — not on computing), one thread that never waits idly can handle enormous concurrency cheaply. This is why a single Node process can serve tens of thousands of simultaneous connections.

#### Mental model

Imagine a single chef in a kitchen (the one thread). A naive chef puts a pot on to boil and stands there watching it for ten minutes, doing nothing else. A good chef puts the pot on, sets a timer, and starts chopping vegetables for the next order. When the timer rings (the event), they come back to the pot. The chef is never cloned — there is always exactly one — but they are never idle while something cooks. The event loop is the chef's habit of always checking "what is ready now?" and never standing and staring at a pot.

The crucial consequence: if the chef ever does a task that cannot be set aside — say, hand-grinding spices for ten minutes with full attention — then every other order waits, because there is only one chef. In Node, a long **synchronous** computation (a giant loop, parsing a huge string, a slow regular expression) is exactly that: it blocks the one thread, and every other request freezes until it finishes. This is the most important thing to understand about Node.

#### How it works

Here is the beginner's picture of the event loop. (Part 3 covers microtasks, macrotasks, phases and libuv in full.)

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

#### Production scenario

A NestJS endpoint handles 2,000 requests per second on a single Node process. Each request does three database queries (about 2 ms each) and one call to a pricing service (about 40 ms). The thread is busy with actual JavaScript for maybe 0.5 ms per request; the other ~46 ms is waiting on I/O, during which the thread serves other requests. That is how one thread serves 2,000 requests per second: it is almost never computing, almost always waiting, and the event loop fills the waits with other requests' work.

#### Failure scenario

At 14:20 an endpoint that validates uploaded CSV files starts timing out for **all** users, not just the ones uploading. The cause: a new feature parsed each uploaded file with a synchronous loop that, for a large file, ran for 800 milliseconds of pure computation. During those 800 ms the one thread was held, so every other request — logins, product pages, checkouts — queued behind it. The dashboard showed the whole service degraded whenever anyone uploaded a big file. The fix was to move the parsing off the main thread (a worker thread, Part 3) and to stream the file instead of loading it whole. The lesson: on Node, one slow synchronous operation harms everyone.

#### Edge cases & failure modes

- A long synchronous loop or heavy computation blocks every request (CPU-bound work needs worker threads or a separate service; Part 3).
- A synchronous file read (`fs.readFileSync`) in a request handler blocks the thread for the duration of the read; always use the asynchronous versions in a server.
- A catastrophic regular expression (ReDoS) can block the thread for seconds on a crafted input — both a performance and a security problem (Part 23).

#### How a Senior Backend Engineer thinks about this

A senior carries one rule from this section into everything: **do not block the event loop.** They know Node's superpower is handling many concurrent waits cheaply and its weakness is CPU-bound work, so they keep request handlers light on computation, push heavy work to background workers (Part 20), and measure event-loop lag as a first-class metric (Part 3). When someone proposes doing image processing or large-file parsing inside a request handler, the senior's first question is "how long does that hold the thread, and whom does it block while it runs?"

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

## 70.2 Callbacks

### 70.2.1 The callback pattern

#### Concept

A callback is a function you give to another function to be called **later**, when some work finishes. "Here is my phone number; call me back when the result is ready." Callbacks were the original way JavaScript handled asynchronous results, and they still appear in older Node APIs and some libraries.

#### Why does it exist?

Because the result is not ready yet. A function that reads a file cannot `return` the file contents immediately — the file takes time to read. So instead it says "give me a function, and I will call it with the contents once I have them." The callback is how the slow function delivers its result after the wait.

#### Mental model

You order a coffee and the barista takes your name. You do not stand frozen at the counter staring at the machine (that would be blocking). You sit down and do other things. When the coffee is ready, the barista calls your name (the callback) and you come get it. Your name is the callback; the barista calling it is the asynchronous completion.

#### How it works

Node's traditional callbacks follow the **error-first** convention: the callback's first argument is an error (or `null` if all went well), and the second is the result. This convention is everywhere in older Node code.

```ts
import { readFile } from 'node:fs';

// readFile is asynchronous: it returns immediately and calls the callback later.
readFile('order.json', 'utf8', (err, data) => {
  if (err) {
    console.error('failed to read file:', err.message);
    return;                          // must return so we do not use data
  }
  console.log('file contents:', data);
});

console.log('this prints BEFORE the file contents');
```

The `console.log` at the bottom runs first, because `readFile` returns immediately and the callback runs later when the file has been read. Checking `err` first, and returning on error, is mandatory — forgetting it leads to using an `undefined` result.

#### Practical example

Chaining two dependent asynchronous steps with callbacks: read a config file, then read the file it points to.

```ts
import { readFile } from 'node:fs';

readFile('config.json', 'utf8', (err, configRaw) => {
  if (err) return console.error('config read failed:', err.message);

  const config = JSON.parse(configRaw);
  readFile(config.dataPath, 'utf8', (err2, data) => {
    if (err2) return console.error('data read failed:', err2.message);
    console.log('data:', data);
  });
});
```

Notice the nesting. Each dependent step goes one level deeper. With two steps it is fine. With six, it becomes the problem described next.

#### Failure scenario (callback hell)

A real order-processing flow had seven dependent asynchronous steps: validate, check inventory, reserve stock, charge card, create shipment, send email, write audit log. Written with callbacks, it became a pyramid eight levels deep, with error handling duplicated at every level and a growing rightward drift that engineers nicknamed "the christmas tree". A bug in the refund path went unnoticed for weeks because the error handling at level six silently swallowed it — a `return` was missing, so after logging the error the code fell through and continued as if nothing was wrong, charging the card after inventory had failed. The deep nesting hid the control-flow bug. Promises and `async`/`await` were invented largely to make this class of bug visible and rare.

```text
doA(function (err, a) {
  if (err) ...
  doB(a, function (err, b) {
    if (err) ...
    doC(b, function (err, c) {
      if (err) ...
        doD(c, function (err, d) {    // the pyramid keeps growing right
          ...
        });
    });
  });
});
```

#### Edge cases & failure modes

- **Forgetting `return` after handling an error**, so the code continues with a bad or `undefined` result (the refund bug above).
- **Calling the callback twice** (for example in both a success and an error path), causing downstream logic to run twice — a real source of double-charges.
- **Errors thrown inside a callback** are not caught by a `try/catch` around the function that scheduled it, because the callback runs later, on a different turn of the event loop. This is a major reason promises are better.
- **Unhandled errors** in a callback with no error handling crash the process.

#### How a Senior Backend Engineer thinks about this

A senior reads callback-based code carefully for the two classic bugs — missing `return` after an error, and double invocation — because both are invisible in deeply nested code and both cause money bugs (double charges, continuing after a failed step). In new code they never write raw callbacks for multi-step flows; they promisify the callback API (`util.promisify`, or use the `fs/promises` version) and use `async`/`await`. Callbacks remain fine for genuine event streams (an event emitter firing many times), which promises do not model well.

#### Common mistakes

- Deeply nested callbacks ("callback hell") that hide control-flow bugs.
- Missing `return` after an error check.
- Mixing `try/catch` with callbacks and wondering why errors are not caught.
- Calling a callback more than once.

#### Interview questions

1. **What is the error-first callback convention?** The callback's first argument is an error (or `null`), the second is the result; you must check the error before using the result.
2. **Why does `try/catch` not catch errors thrown inside an asynchronous callback?** The callback runs on a later turn of the event loop, after the `try/catch` has already finished; the error has no surrounding `try` at that point.
3. **What is callback hell and what replaced it?** Deeply nested callbacks for dependent async steps; promises and `async`/`await` replaced it with flat, readable, properly-catchable code.

#### Practical exercise

Take a three-level nested callback flow (read file, parse, write a derived file) and identify where a missing `return` after an error check would cause the next step to run with bad data. Then note which line a double callback invocation would break. Acceptance criteria: you can point to the exact failure for each bug without running the code.
