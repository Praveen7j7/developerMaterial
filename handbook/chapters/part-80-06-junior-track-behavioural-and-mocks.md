## 80.8 The junior and entry-level track

### 80.8.1 What juniors are asked, and how it is graded

#### Concept

Junior and entry-level loops (internships, graduate roles, first jobs, career changers) test whether you can learn quickly and work safely on a team. Nobody expects you to design a feed. They expect correct fundamentals, a small working piece of code, the everyday tools (Git, HTTP, a little SQL), and one project you understand all the way down.

A typical junior loop:

| Round | What happens | What they look for |
|---|---|---|
| Fundamentals | Questions on JavaScript, HTML, CSS, HTTP | Correct basics in your own words; honesty about gaps |
| Small coding task | 30–45 minutes: transform data, render a list, call an API | Working code, readable names, testing your own output |
| Tools | Git workflow, the terminal, reading an error | You can work in a team repository without breaking things |
| Project walkthrough | 15–20 minutes on something you built | You made the decisions, you know why, you know what is weak |
| Behavioural | Learning, asking for help, handling feedback | Coachability, curiosity, reliability |

#### Why does it exist?

A junior engineer costs the team mentoring time for months. The loop estimates two things: how much support you will need, and how fast you will grow. Fundamentals predict the first; the project walkthrough and how you react to hints predict the second.

#### Mental model

Imagine a driving test. The examiner does not expect racing skills. They expect you to check mirrors every time, follow the rules, stay calm when something unexpected happens, and admit when you are unsure of the route. Safe and teachable beats fast and flashy.

#### How it works — the small coding task

A typical task: "Given this array of orders, render them grouped by status with a total per group, and add a filter by customer name." Work in this order: restate the task, write the data transformation as a plain function and print its output, then render it, then add the filter. Say what you are checking as you go.

```tsx
import { useState } from 'react';

type Order = { id: string; customer: string; status: 'placed' | 'shipped' | 'delivered'; totalMinor: number };

export function totalsByStatus(orders: Order[]): Record<Order['status'], number> {
  const totals = { placed: 0, shipped: 0, delivered: 0 };       // every status present, even with no orders
  for (const o of orders) totals[o.status] += o.totalMinor;
  return totals;
}

export function OrdersSummary({ orders }: { orders: Order[] }) {
  const [name, setName] = useState('');
  const visible = orders.filter((o) => o.customer.toLowerCase().includes(name.trim().toLowerCase())); // derived, not state
  const totals = totalsByStatus(visible);
  return (
    <section>
      <label htmlFor="customer-filter">Filter by customer</label>
      <input id="customer-filter" value={name} onChange={(e) => setName(e.target.value)} />
      <ul>
        {Object.entries(totals).map(([status, total]) => (
          <li key={status}>{status}: {(total / 100).toFixed(2)}</li>
        ))}
      </ul>
      {visible.length === 0 && <p>No orders match.</p>}
    </section>
  );
}
```

What gets a junior hired here: a separate pure function that is easy to test, an empty state, a real label, a stable `key`, money kept in minor units, and saying "the filtered list is derived, so I did not put it in state".

#### How it works — presenting a portfolio project

Prepare a two-minute walkthrough and be ready for ten minutes of questions. Use this shape:

1. **The problem, in one sentence.** "A small app for a local bakery to take pre-orders for pickup."
2. **The stack and why.** "React with Vite for the frontend, a NestJS API, PostgreSQL. I chose Postgres because orders and items are relational."
3. **One hard thing you solved.** "Two customers could book the last pickup slot at once. I fixed it with a unique constraint on slot and date, and the API returns a clear 409 the UI turns into a message."
4. **What you would change.** "I store the session token in localStorage; I now know an HttpOnly cookie is safer, and I would move to that."
5. **Proof.** A live link, a README with setup steps, a few tests, and a clean commit history.

Interviewers will open your repository. They look at the README, whether the app runs, whether commits have meaningful messages, and whether there is at least one test. A project you deployed and maintained for two months beats five tutorial clones.

#### Common mistakes

- Memorising definitions and being unable to give an example.
- Saying "we" for a team project and being unable to say what you built.
- Presenting a tutorial project as your own design; one follow-up question exposes it.
- Not testing your own code in the coding task: run it with an empty array and one odd input before saying "done".
- Bluffing. "I have not used that yet; here is how I would find out" is a good junior answer (59.0.4 shows the pattern).
- Ignoring the hint. When the interviewer nudges, they are helping; take it and say thank you.

#### Practical exercise

Pick one project. Write the two-minute walkthrough in the five-part shape above, record yourself saying it, and fix the README so a stranger can run the project in under ten minutes. Acceptance criteria: the recording is under two and a half minutes; it names one hard problem and one thing you would change; a friend can clone and run the app from the README alone.

### 80.8.2 A six-week junior plan

| Week | Study | Build | Practise |
|---|---|---|---|
| 1 | Part 1 — Programming Fundamentals in JavaScript and TypeScript | Ten small data-transformation functions on an orders array | Answer J1–J8 aloud |
| 2 | Part 2 — Asynchronous JavaScript; Part 3 — How the Web Works | Fetch a public API and render it with loading and error states | J9–J20 |
| 3 | Part 5 — Git Basics and the Development Workflow; Part 4 — Linux and the Command Line | Put your project on GitHub with branches and pull requests | J25–J28 |
| 4 | Part 7 — Your First Frontend | Add a form with validation to your project | J21–J24 |
| 5 | Part 6 — Your First Backend, with its SQL section | Add a small API and a table behind your frontend | J29–J30 |
| 6 | Review your log | Deploy the project; write the README | Two mock interviews with friends |

### 80.8.3 Thirty junior questions with short answers

Each answer is the short version you should be able to say in under a minute. The pointer tells you where Volume 0 teaches it properly.

**JavaScript and TypeScript**

- **J1. What is the difference between `let`, `const` and `var`?** `const` cannot be reassigned, `let` can, both are block-scoped; `var` is function-scoped and hoisted, which causes bugs, so modern code avoids it. A `const` object can still be changed inside. (1.1.2)
- **J2. What are the primitive types?** string, number, bigint, boolean, undefined, null and symbol; everything else is an object, including arrays and functions. Primitives are copied by value, objects by reference. (1.1.1)
- **J3. Why use `===` instead of `==`?** `===` does not convert types, so `'1' === 1` is false; `==` converts and gives surprises like `0 == ''` being true. (1.1.3)
- **J4. What is a closure?** A function that remembers the variables from where it was created, even after that outer function has finished. Event handlers use them all the time. (1.4.2)
- **J5. What do `map`, `filter` and `reduce` do?** `map` turns each item into a new item, `filter` keeps items that pass a test, `reduce` combines all items into one value such as a total. None of them change the original array. (1.5.2)
- **J6. When would you use a `Map` or a `Set`?** A `Set` for unique values (seen order IDs); a `Map` for key-value lookups where keys are not just strings or the order of insertion matters. (1.5.3)
- **J7. What does TypeScript add?** Types checked before the code runs, so many mistakes (wrong property name, missing argument) are caught in the editor. The types are removed when the code is compiled to JavaScript. (1.2.1)
- **J8. What is a union type?** A value that can be one of several types, such as `'placed' | 'shipped'`; TypeScript makes you handle each possibility. (1.7.2)

**Asynchronous code**

- **J9. Why is JavaScript code asynchronous?** It runs on one thread; waiting for the network without blocking means starting the request and continuing, then handling the result later through the event loop. (2.1.1)
- **J10. What is a promise?** An object for a value that will arrive later: pending, then fulfilled with a value or rejected with an error. (2.3.1)
- **J11. What does `await` do?** It pauses the `async` function until the promise settles, then gives you the value or throws the error, without blocking the rest of the page. (2.4.1)
- **J12. How do you handle errors with `async`/`await`?** Wrap the `await` in `try/catch`; and with `fetch`, check `response.ok`, because a 404 or 500 does not throw. (2.5.1)
- **J13. How do you run two requests at the same time?** Start both and `await Promise.all([a, b])`; it fails if either fails, so use `Promise.allSettled` when one is optional. (2.3.1, 2.4.1)

**HTTP and the web**

- **J14. What happens when you type a URL and press Enter?** DNS finds the server's address, the browser opens a connection (with TLS for HTTPS), sends an HTTP request, receives HTML, then fetches CSS, JavaScript and images and renders the page. (3.6.1)
- **J15. What are the main HTTP methods?** GET reads, POST creates, PUT replaces, PATCH updates part, DELETE removes. GET must not change data. (3.2.1)
- **J16. What do status codes 200, 201, 400, 401, 403, 404 and 500 mean?** OK, created, bad request, not logged in, logged in but not allowed, not found, server error. 2xx success, 4xx client problem, 5xx server problem. (3.3.1)
- **J17. What is a header? Name two.** Extra information sent with a request or response: `Content-Type` says the body format, `Authorization` carries credentials, `Cache-Control` says how long to cache. (3.3.2)
- **J18. What is JSON and what can go wrong parsing it?** A text format for data with objects, arrays, strings, numbers, booleans and null; parsing an HTML error page as JSON throws "Unexpected token <". (3.4.1)
- **J19. What is a REST API?** An API organised around resources (`/orders/42`) and HTTP methods, returning JSON and status codes. (3.5.1)
- **J20. What is CORS, in one sentence?** The browser's rule that a page may only read responses from another origin if that server allows it with CORS headers. (Part 7 — Your First Frontend; 11.13)

**HTML, CSS and the browser**

- **J21. Why does semantic HTML matter?** Elements like `<button>`, `<nav>` and `<label>` give keyboard support, screen reader meaning and better SEO for free; a clickable `<div>` gives none of that. (Part 7 — Your First Frontend; 69.2)
- **J22. Explain the CSS box model.** Every element is content, then padding, then border, then margin; `box-sizing: border-box` makes width include padding and border, which is easier to reason about. (Part 7 — Your First Frontend; 69.4)
- **J23. Flexbox or grid?** Flexbox for laying out items in one direction (a toolbar, a row of buttons); grid for two-dimensional layouts (a page or a card gallery). (Part 7 — Your First Frontend; 69.4)
- **J24. What is the DOM?** The browser's tree of objects built from the HTML, which JavaScript can read and change; React changes it for you. (Part 7 — Your First Frontend; 69.1)

**Git and tools**

- **J25. What is a commit, and what makes a good one?** A saved snapshot of changes with a message; a good commit is small, does one thing and says why. (5.1.1)
- **J26. Describe the pull request workflow.** Create a branch, commit, push, open a pull request, get review, fix feedback, merge into main. (5.3.1, 5.5.1)
- **J27. How do you resolve a merge conflict?** Open the conflicted files, choose or combine the changes between the markers, run the tests, then commit the resolution. (5.4.1)
- **J28. How do you undo a commit that is already pushed?** `git revert <commit>` creates a new commit that undoes it, which is safe for shared branches; do not rewrite shared history with `reset`. (5.7.1)

**SQL basics**

- **J29. Write a query for the ten most recent orders of one customer.** `SELECT id, total_minor, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10;` and mention that an index on `(customer_id, created_at)` makes it fast. (6.3.1; Part 18 — SQL Mastery for Backend Engineers, 18.4.1, when you are ready for more)
- **J30. What is the difference between an inner join and a left join?** An inner join returns only rows that match in both tables; a left join returns every row from the left table, with nulls where the right table has no match, for example customers with no orders. (6.3.1; 18.2.1)

**What a strong junior answer adds, for any of the thirty:** one concrete example from something you built, and one thing that can go wrong. "A left join, for example to show customers with zero orders, and I learned to count `orders.id` rather than `*` or every customer shows at least 1."

## 80.9 Behavioural rounds for frontend and full-stack engineers

### 80.9.1 Four stories to prepare, with STAR examples

#### Concept

STAR (Situation, Task, Action, Result) is the shape. Part 59, 59.21 covers the general behavioural questions (incidents, disagreement, mentoring, saying no); this section covers the four stories frontend and full-stack interviewers ask for most. Keep each to about two minutes, put the numbers in the Result, and spend most of the time on Action: what **you** did.

#### Practical example — working with design and product

> **Situation.** Design delivered a checkout redesign with a multi-step carousel of offers before the payment step. **Task.** I was the engineer on the checkout team, and the release was four weeks out. **Action.** I built a quick prototype on a throttled mid-range phone and showed the designer and product manager that the carousel added 380 KB of JavaScript and pushed INP to 340 ms. Instead of saying no, I proposed two options: a static offers row with the same content, or the carousel lazy-loaded after payment. We ran the static version as an A/B test behind a flag. **Result.** The static version kept offer click-through within 2% of the design's estimate, checkout INP stayed at 150 ms, and the designer added a "performance budget" note to the design system template.

What makes it strong: you brought evidence instead of opinion, offered options, and left the decision with the right person.

#### Practical example — accessibility advocacy

> **Situation.** A customer complaint said our checkout could not be completed with a keyboard. **Task.** I was not on the checkout team, but I owned the shared component library. **Action.** I reproduced it: our custom select trapped focus. I fixed the component, added axe checks to the component tests and a keyboard-only Playwright journey to CI (77.7, 77.10), and ran a 30-minute session for two teams on the five checks from 80.3 Q19. **Result.** Critical axe violations went from 41 to 0 across the library in six weeks; the keyboard journey has caught three regressions since; support tickets mentioning keyboard or screen reader dropped from about 12 a month to 1.

#### Practical example — a performance win

> **Situation.** Our product page LCP was 4.1 s at the 75th percentile on mobile, and the page was the entry point for 60% of paid traffic. **Task.** I was asked to get it under 2.5 s within a quarter. **Action.** RUM showed most of the time was resource load delay: the hero image was discovered late because it was set by client-side JavaScript. I moved the image into the server-rendered HTML with `fetchpriority="high"` and correct `srcset` sizes, cut the API waterfall from three sequential calls to one BFF call (76.10), and deferred two third-party tags. **Result.** LCP went to 2.2 s at p75 in field data within three weeks; mobile conversion on the page rose 6% in the following month's A/B comparison, and I added a performance budget to CI so it stayed there (76.11).

#### Practical example — a bug in production

> **Situation.** After a Friday deploy, error tracking showed a spike in "ChunkLoadError" and checkout completions fell 18% within 40 minutes. **Task.** I was on call for the web app. **Action.** The source-mapped stack traces showed users on the old HTML requesting JavaScript chunks the deploy had deleted (78.4, 78.10). I rolled back first, which restored conversion in 6 minutes, then fixed the cause: we kept the previous two releases' assets on the CDN, set the HTML to `no-cache`, and added a handler that reloads the page once on a chunk load failure. **Result.** Total impact was about 50 minutes and roughly 300 failed checkouts; we have had zero chunk errors in eleven deploys since, and the blameless review added an "old bundle" check to the deploy checklist.

What makes it strong: mitigation before diagnosis, the cause in one sentence, a fix to the system rather than a promise to be careful, and honest numbers including the cost.

#### Common mistakes

- Stories with "we" throughout and no clear action of yours.
- No numbers, or numbers with no baseline ("made it 50% faster" from what?).
- Blaming design, product or the backend team. Describe their constraint, then what you did.
- Choosing a story where nothing was at stake.

## 80.10 Mock interviews and rubrics

### 80.10.1 A React deep-dive transcript, with rubric notes

> **Interviewer:** This component shows the wrong user's orders for a moment when I switch users quickly. Why?
>
> **Candidate:** Can I see how it fetches? ... It fetches in a `useEffect` keyed on `userId` and sets state when the response arrives. If I switch from user A to user B, both requests are in flight; if A's response is slower, it arrives last and overwrites B's data. It is a race.
>
> **Interviewer:** How do you fix it?
>
> **Candidate:** Minimal fix: an `AbortController` created in the effect and aborted in the cleanup, so A's request is cancelled when `userId` changes, and I ignore `AbortError`. In production code I would move this to TanStack Query with the key `['orders', userId]`, because each user's data then has its own cache entry and the race cannot happen; it also gives me caching when switching back.
>
> **Interviewer:** And the flash of the old user's data?
>
> **Candidate:** With separate cache keys, switching to B shows B's loading state or B's cached data, never A's. If they want the previous data to stay visible while loading, `placeholderData` does that, but for different users I would not, because showing A's orders under B's name is a privacy problem, not a UX nicety.

**Rubric notes.** Strong: named the race precisely, gave a minimal fix and a production fix, and raised the privacy angle unprompted. A mid-level answer stops at "add a loading spinner", which hides the bug instead of fixing it.

### 80.10.2 The first five minutes of a frontend system design round

> **Interviewer:** Design the comment section for our news site.
>
> **Candidate:** Before I design, a few questions. Who are the readers and on what devices? ... Mostly mobile, fine. Do comments need to appear live, or is refresh acceptable? ... Live, okay. Replies: one level or unlimited nesting? ... One level. Do we need SEO for comments? ... No, so the thread can be client-rendered below the article, which keeps the article's LCP unaffected. Scale: how many readers on a popular article? ... About 2,000 at once and a few comments per second. Then I will spend most time on real-time consistency (ordering, duplicates, reconnects) and on not disrupting someone who is reading. Is that the right focus for you?

**Rubric notes.** Strong: requirements drive decisions immediately (no SEO, so client-rendered; live, so a transport choice), and the candidate proposes where to go deep and checks with the interviewer. The rest of the round follows 80.6.3.

### 80.10.3 A scoring sheet for your own mocks

| Round | Score 1 (weak) | Score 3 (meets bar) | Score 5 (strong) |
|---|---|---|---|
| JS fundamentals | Folklore, wrong order in the event loop exercise | Correct answers | Correct answers plus mechanism plus a production symptom |
| Machine coding | Not working at the end | Working with main states | Working, accessible, race-safe, with stated cuts |
| React | API recall only | Correct behaviour explained | Explains why, picks state placement and caching deliberately |
| Frontend design | Library names, no states | Component tree, data flow, API | Numbers, rendering per region, failure states, rollout |
| Full-stack design | Boxes with no contract | Contract and data model | Contract with errors, idempotency and concurrency; user-visible states |
| Behavioural | Vague, "we" | Clear STAR | STAR with baselines, numbers, and what you learned |

Ask your mock interviewer to fill this in honestly, then put the two lowest rows into your log as next week's focus.

## Senior Checklist — Part 80

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
- [ ] I know which rounds my target loop has, what each one signals, and how grading changes by level
- [ ] I have a dated four-week or eight-week plan with booked mock interviews and a log
- [ ] I can predict the browser event loop output (sync, all microtasks, then tasks and the render step) and explain why
- [ ] I can explain closures, `this`, prototypes, promise error handling, coercion, copying and modules with a UI example each
- [ ] I can explain the rendering pipeline, layout thrashing, CORS preflight, cookie and storage trade-offs, CSP, HTTP caching, accessibility basics and Core Web Vitals
- [ ] I can explain re-renders, keys, effects, state placement, memoisation, server and client components, hydration errors and cache invalidation
- [ ] I can build a typeahead with debouncing and `AbortController`, an infinite list with cursor pagination, a form with three layers of double-submit protection, and a status stepper driven by a transition table, each in under an hour
- [ ] I can run a frontend system design with the ten-area framework and pick a rendering strategy per region
- [ ] I can present a full-stack design contract-first, with error codes, idempotency, concurrency control and user-visible pending states
- [ ] I can present one portfolio project in two minutes and answer the thirty junior questions (if I am early in my career, or when I interview juniors)
- [ ] I have four STAR stories with baselines and numbers: design and product, accessibility, performance, production bug

## Part 80 — Key Takeaways

- Frontend and full-stack loops test different failure surfaces from backend loops: the language, the browser, the framework, building UI under time pressure, and the contract between client and server.
- The same question is graded by level; seniority shows in what you raise unprompted (races, accessibility, caching, the API shape) and in what you choose not to build.
- Most React questions reduce to three ideas: a render is a function call, state is a snapshot per render, and identity (references and keys) decides what React keeps.
- In the event loop exercise, run the synchronous code, then drain every microtask, then tasks and the render step; say which orders the spec does not guarantee.
- In machine coding, get a working slice on screen by minute 20, model state as a union, then handle races, errors, empty states and the keyboard.
- Debouncing reduces requests; only cancellation or latest-wins checks fix races. Disabled buttons reduce double submits; only idempotency keys make them safe.
- A transition table drives UI affordances, but the server remains the source of truth; versions make live updates idempotent.
- Frontend system design is a rendering and state decision per region of the page, plus loading, error, accessibility and rollout plans; library names are not a design.
- In full-stack design, write the contract first: full-object responses, server-computed totals, typed error codes mapped to fields, `If-Match` for concurrency and idempotency keys for every retry.
- Juniors are hired for correct fundamentals, a small working task, safe use of Git, and one project they understand deeply and can criticise honestly.
- Behavioural stories need a baseline, an action that was yours, and a measured result; mitigation before diagnosis is the shape of a good incident story.
- Practise out loud, in an interview editor, with real people, and let a log of what went wrong decide next week's work.
