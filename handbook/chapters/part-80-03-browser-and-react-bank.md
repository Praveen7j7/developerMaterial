## 80.3 Browser and web platform questions

These questions separate engineers who write components from engineers who can debug a page. Many loops do not run a separate browser round; the questions appear inside the React round, the design round, or as follow-ups ("why is this slow?", "why does the API call fail only from the browser?"). Volume 0's Part 7 — Your First Frontend meets several of these for the first time; Part 69 is the full treatment.

### Q13. What happens between receiving HTML and seeing pixels?

- **Model answer** — The browser parses HTML into the **DOM** and CSS into the **CSSOM**. It combines them, computing the style of every visible element (**style**), then works out each box's size and position (**layout**), then fills in pixels for text, colours, borders and images, usually into several layers (**paint**), then the compositor thread assembles the layers on the GPU (**composite**). CSS is render-blocking: the browser will not paint until the stylesheets in the `<head>` have loaded. A classic `<script>` without `defer` or `async` blocks the parser, because the script might change the document.

  ```text
  HTML bytes → DOM ─┐
                    ├→ style → layout → paint → composite → pixels
  CSS bytes → CSSOM ┘
  ```

- **What a strong answer adds** — Connects stages to costs and metrics: a large render-blocking stylesheet delays first paint and LCP; changing `width` re-runs layout, changing `color` re-runs paint, changing `transform` or `opacity` can be done by the compositor alone, which is why animations should use those two properties. Uses `defer` for app scripts and `<link rel="preload">` for the LCP image (69.3, 76.6). Mentions that the backend owns the first step: a 900 ms TTFB delays everything after it (76.10).
- **Where it is taught** — 3.6.1 From URL to rendered page; 69.1 From URL to pixels; 69.6 Script loading; 76.6 The critical rendering path.

### Q14. Reflow versus repaint. What is layout thrashing?

- **Model answer** — A **reflow** (layout) recalculates geometry: it happens when something that affects size or position changes, such as width, font size, adding DOM nodes, or the window resizing. A **repaint** redraws pixels without changing geometry, such as a colour change. Reflow is more expensive because a change can ripple to parents, siblings and children. **Layout thrashing** is forcing many reflows in one frame by alternating writes and reads: reading `offsetHeight` or `getBoundingClientRect()` after a style write forces the browser to do layout immediately to give you a correct answer.

  ```ts
  // Thrashing: one forced layout per row (1,000 rows = 1,000 layouts in one frame)
  rows.forEach((row) => { row.style.height = `${row.offsetHeight + 8}px`; });

  // Batched: all reads, then all writes = one layout
  const heights = rows.map((row) => row.offsetHeight);
  rows.forEach((row, i) => { row.style.height = `${heights[i] + 8}px`; });
  ```

- **What a strong answer adds** — How you would find it: the Performance panel shows purple "Layout" blocks with a "Forced reflow" warning (69.10). Long tasks from thrashing hurt INP (76.4). Fixes beyond batching: `transform` instead of `top/left`, CSS `contain` to limit how far layout spreads, and virtualisation for very long lists (71.9).
- **Where it is taught** — 69.1; 69.5 Layout shift; 69.7 long tasks; 76.4 INP.

### Q15. Explain CORS and the preflight request.

- **Model answer** — Browsers enforce the **same-origin policy**: a page from `https://shop.example` may send requests to `https://api.shop.example`, but its JavaScript may not read the response unless the API says so. CORS is the protocol for the API to say so, with `Access-Control-Allow-Origin` and related response headers. For requests that could not have been sent by an old HTML form (a method other than GET, HEAD or POST; custom headers such as `Authorization`; or a `Content-Type` such as `application/json`), the browser first sends a **preflight**: an `OPTIONS` request asking "may I send this method with these headers?". Only if the preflight response allows it does the real request go out.

  ```text
  OPTIONS /v1/orders                         ← preflight
  Origin: https://shop.example
  Access-Control-Request-Method: POST
  Access-Control-Request-Headers: content-type, idempotency-key

  204 No Content
  Access-Control-Allow-Origin: https://shop.example
  Access-Control-Allow-Methods: GET, POST, PATCH
  Access-Control-Allow-Headers: content-type, idempotency-key
  Access-Control-Allow-Credentials: true
  Access-Control-Max-Age: 600                ← cache the answer for 10 minutes
  ```

- **What a strong answer adds** — CORS protects users' data in the browser; it is **not** server security, because curl and Postman ignore it (that is why "it works in Postman" means nothing). With cookies (`credentials: 'include'`), the server must echo a specific origin, `*` is refused, and `Vary: Origin` must be set so a CDN does not serve one origin's headers to another. Preflights add a round trip, which matters on mobile: `Access-Control-Max-Age` or serving the API from the same origin through a BFF or proxy path (73.8) removes them. A CORS error in the console often hides a real 500 that lacked the CORS headers.
- **Where it is taught** — 11.13 CORS; Part 7 — Your First Frontend for the first encounter; 73.8 The BFF pattern.

### Q16. Cookies, localStorage, sessionStorage, IndexedDB: what goes where?

- **Model answer** —

  | Store | Sent to server automatically | Readable by JS | Size (approximate) | Lifetime | Use for |
  |---|---|---|---|---|---|
  | Cookie with `HttpOnly; Secure; SameSite=Lax` | Yes, to matching domain and path | No | About 4 KB each | Until expiry | Session identifiers, refresh tokens |
  | Cookie without `HttpOnly` | Yes | Yes | About 4 KB | Until expiry | Non-secret preferences the server needs (locale) |
  | `localStorage` | No | Yes, synchronously | About 5 MB per origin | Until cleared | Non-sensitive preferences, drafts |
  | `sessionStorage` | No | Yes, synchronously | About 5 MB | Per tab, until closed | Per-tab wizard state |
  | IndexedDB | No | Yes, asynchronously | Large, quota-based | Until cleared or evicted | Offline data, large caches |

  Tokens that grant access should live in `HttpOnly` cookies, because anything JavaScript can read, an XSS bug can steal.

- **What a strong answer adds** — The trade-off is honest: `HttpOnly` cookies resist token theft but bring CSRF, handled with `SameSite`, Fetch Metadata headers and, where needed, a double-submit token (75.6); access tokens kept in memory vanish on reload and need silent refresh (75.3). `localStorage` is synchronous and blocks the main thread on large reads, and Safari can evict script-written storage after a period without visits. Storing personal data in `localStorage` survives logout unless you clear it.
- **Where it is taught** — 11.8 Cookies and sessions; 69.8 Browser storage; 75.1 Where tokens live; 75.2 Session cookies done right.

### Q17. What is XSS and how does CSP help? Does React prevent XSS?

- **Model answer** — Cross-site scripting is an attacker getting their script to run in your origin, usually by getting text they control rendered as HTML. Once it runs, it can do anything the user can: read non-`HttpOnly` storage, call your API with the user's cookies, change the page. React escapes values rendered in JSX, so `<p>{comment.body}</p>` is safe. It does not protect `dangerouslySetInnerHTML`, URLs in `href` or `src` (a `javascript:` URL from user input), direct DOM APIs such as `innerHTML`, or HTML you build outside React. **Content Security Policy** is a response header that tells the browser which scripts may run; a strict policy with per-response nonces blocks injected inline scripts even when an escaping bug slips through.

  ```text
  Content-Security-Policy: script-src 'nonce-r4nd0m' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'
  ```

- **What a strong answer adds** — Sanitise rich text with a maintained library (DOMPurify) on output, validate URL schemes (`https:` only) for user-supplied links, and treat Markdown rendering as HTML rendering. Roll CSP out with `Content-Security-Policy-Report-Only` first and collect reports, because a strict policy breaks third-party tags. Trusted Types make DOM sinks reject plain strings. XSS defeats CSRF defences, so it is the bug to prevent first.
- **Where it is taught** — 75.7 XSS from the frontend side; 75.8 Third-party scripts; 78.9 Frontend security headers at the edge.

### Q18. How does HTTP caching work for a frontend? What headers do you set?

- **Model answer** — The browser and CDNs cache by URL and obey `Cache-Control`. Two kinds of file need opposite rules:
  - **Hashed static assets** (`app.3f9a1c.js`): the name changes when the content changes, so cache forever: `Cache-Control: public, max-age=31536000, immutable`.
  - **HTML and the entry point**: must always be revalidated so users pick up new deploys: `Cache-Control: no-cache` (which means "store but check first"), with an `ETag` so the check returns a cheap `304 Not Modified`.
  - **Personal API responses**: `Cache-Control: private, no-store` or `private, max-age=0`, never cached by a shared CDN.
  - **Public API data**: `s-maxage` for the CDN, plus `stale-while-revalidate` so users get an instant response while the CDN refreshes in the background.
- **What a strong answer adds** — `no-cache` is not `no-store`; mixing them up is a classic answer error. Caching the HTML for an hour while assets are hashed means users keep loading old HTML that references deleted chunks after a deploy (78.3, 78.4). The client has its own cache layers above HTTP (TanStack Query, the Next.js caches), and each needs its own invalidation story (72.4, 73.7). The back/forward cache is broken by `Cache-Control: no-store` on the HTML and by `unload` handlers (76.9).
- **Where it is taught** — 11.11.1 ETags and conditional requests; 11.11.2 Cache-Control; 76.9 Caching for frontends; 78.3 Cache busting and versioned assets.

### Q19. What are the accessibility basics you check in every component?

- **Model answer** — Five checks catch most problems:
  1. **Semantic elements first**: a `<button>` for actions, an `<a href>` for navigation, real `<label>` elements tied to inputs, headings in order, lists as lists. A `<div onClick>` is not focusable, not announced as a button and does not respond to Enter or Space.
  2. **Keyboard**: everything works with Tab, Shift+Tab, Enter, Space, Escape and arrow keys where expected, and focus is visible.
  3. **Focus management**: a dialog moves focus in, traps it, and returns it to the trigger on close; a route change moves focus to the new heading.
  4. **Text alternatives**: meaningful `alt` on content images, empty `alt=""` on decorative ones, accessible names on icon buttons (`aria-label="Remove item"`).
  5. **Contrast and state**: text contrast at least 4.5:1 for normal text, and state not shown by colour alone (an error has text, not just a red border).
- **What a strong answer adds** — "No ARIA is better than bad ARIA": ARIA changes what assistive technology announces but adds no behaviour. Live regions (`aria-live="polite"`) announce async results such as "8 results" or "Added to cart". Automated tools (axe in tests, 77.10) catch roughly a third to a half of issues, so a keyboard-only pass and a quick screen reader pass are still needed. Accessibility is often a legal requirement, and accessible forms convert better for everyone.
- **Where it is taught** — 69.2 Semantic elements and forms; 69.9 Accessibility as engineering; 77.10 Accessibility testing with axe.

### Q20. What are the Core Web Vitals and how do you improve each?

- **Model answer** — Three field metrics judged at the **75th percentile** of real page loads:
  - **LCP** (Largest Contentful Paint): when the largest image or text block appears. Good is 2.5 s or less. Improve with a faster TTFB, a preloaded and prioritised hero image (`fetchpriority="high"`), no lazy-loading of the LCP image, and less render-blocking CSS and JavaScript.
  - **INP** (Interaction to Next Paint): the latency from a click, tap or key press to the next frame, taken from close to the worst interaction on the page. Good is 200 ms or less. Improve by breaking long tasks, shipping less JavaScript, deferring non-urgent updates (`startTransition`), and avoiding huge re-renders on input.
  - **CLS** (Cumulative Layout Shift): how much visible content jumps unexpectedly. Good is 0.1 or less. Improve with `width` and `height` (or `aspect-ratio`) on images and embeds, reserved space for ads and banners, and font loading that does not reflow text.
- **What a strong answer adds** — Lab tools (Lighthouse) and field data (RUM, the Chrome UX Report) disagree, and the field is what counts: a fast developer laptop hides a mid-range phone's INP (76.2). LCP splits into four subparts (TTFB, resource load delay, resource load duration, element render delay) and you fix the biggest one first (76.3). INP replaced FID as a Core Web Vital in 2024. A strong candidate tells one story with numbers (80.9).
- **Where it is taught** — 76.2 Core Web Vitals; 76.3 LCP; 76.4 INP; 76.5 CLS in the field; 76.12 Worked example.

## 80.4 React and Next.js questions

The React round is where backend engineers moving to full-stack are most often caught out, because the API is small and the behaviour underneath is subtle. Every question here ends up testing one of three ideas: a render is a function call, state is a snapshot per render, and identity (references and keys) decides what React keeps.

### Q21. What does "render" mean in React, and what triggers a re-render?

- **Model answer** — Rendering is React **calling your component function** to get a description of the UI. Then React compares the new description with the previous one (**reconciliation**) and applies the minimal DOM changes in the **commit** phase. A component re-renders when its state changes (`setState` with a value that is not `Object.is`-equal to the current one), when its parent re-renders (by default, whether or not props changed), or when a context it reads changes. Re-rendering is not the same as touching the DOM: if the output is identical, nothing is committed.
- **What a strong answer adds** — State updates are batched (since React 18, also inside promises and timeouts) and state is a snapshot: after `setCount(count + 1)` the variable `count` in that render does not change. Reconciliation rules: a different element type at the same position unmounts the old subtree (losing its state); the same type updates in place. Re-renders are usually cheap; the problem is a re-render that is expensive or very frequent, found with the React Profiler (71.12), not guessed.
- **Where it is taught** — 71.2 State and re-rendering; 71.3 Reconciliation and keys; 71.12 Performance basics.

### Q22. Why do lists need keys, and what goes wrong with the array index as a key?

- **Model answer** — A key tells React which item is which between renders, so it can keep the right component state and DOM node with the right data. With the index as key, inserting at the top, deleting, or re-sorting shifts every index, so React reuses component instances for different items: a half-typed quantity input or an expanded row "moves" to the wrong product. Use a stable unique id from the data (`order.id`).

  ```tsx
  {cartItems.map((item) => (
    <CartRow key={item.sku} item={item} />   // stable: state follows the item, not the position
  ))}
  ```

- **What a strong answer adds** — Index keys are acceptable only for static lists that never reorder and hold no state. Keys must be unique among siblings, not globally. Changing a key on purpose is a tool: `<OrderForm key={orderId} />` resets all state inside the form when the user switches orders, which is simpler than an effect that resets fields. Generating keys with `Math.random()` remounts every row on every render.
- **Where it is taught** — 71.3 Reconciliation and keys; 71.9 Lists, tables and large lists.

### Q23. When should you use `useEffect`, and when should you not?

- **Model answer** — An effect is for **synchronising with something outside React**: a subscription, a timer, a WebSocket or SSE connection, a non-React widget, a manual DOM measurement. You do not need an effect to compute values from props or state (compute them during render), to respond to a user event (do it in the event handler), or to reset state when a prop changes (use a key). Every effect that subscribes must return a cleanup.

  ```tsx
  function useOrderEvents(orderId: string, onEvent: (e: OrderEvent) => void) {
    const latest = useRef(onEvent);
    latest.current = onEvent;                      // always call the newest handler without resubscribing
    useEffect(() => {
      const source = new EventSource(`/v1/orders/events?orderId=${encodeURIComponent(orderId)}`, { withCredentials: true });
      source.onmessage = (msg) => latest.current(JSON.parse(msg.data) as OrderEvent);
      return () => source.close();                 // runs on unmount and before re-subscribing to a new orderId
    }, [orderId]);
  }
  ```

- **What a strong answer adds** — In development, Strict Mode mounts, unmounts and remounts components to expose missing cleanups, so an effect that runs twice is a hint, not a bug in React. Fetching in an effect needs race handling (an `ignore` flag or `AbortController`) and usually belongs in a data library (TanStack Query, 72.2) or a server component instead. An effect that sets state that its own dependencies read is an infinite loop. The dependency list is not an optimisation knob: lying to it creates stale closures (80.2 Q1). Updating a ref during render as above is a common pattern, though React's documentation prefers doing it in an effect or using the newer `useEffectEvent` hook where your React version has it.
- **Where it is taught** — 71.4 Effects: `useEffect` done right; 72.8 Real-time data in the UI.

### Q24. Where should a piece of state live?

- **Model answer** — Put state as close as possible to where it is used, and in the place whose lifetime matches it. A decision table:

  | Kind of state | Example | Where it lives |
  |---|---|---|
  | Derived from other state or props | Cart total, filtered list | Not state at all: compute during render |
  | Local UI | Is this dropdown open | `useState` in that component |
  | Shared by siblings | Selected address used by two panels | Lift up to the nearest common parent |
  | Should survive reload and be shareable | Filters, sort, page, selected tab | The URL (search params) |
  | Data from the server | Orders, products, the user | A server-state cache (TanStack Query, SWR) or server components |
  | Truly global client state | Theme, feature flags, auth status | Context for rarely changing values; a small store (Zustand, Redux Toolkit) for frequently changing ones |
  | Form draft | Fields being typed | The form library or the form component |

- **What a strong answer adds** — The most expensive mistake is copying server data into a global client store: now you own caching, deduplication, staleness and invalidation by hand, and two copies disagree (72.1). Context is a dependency-injection tool, not a state manager: every consumer re-renders when the value changes, so a context holding a fast-changing object re-renders the whole app. Duplicated state (storing both `items` and `itemCount`) eventually disagrees.
- **Where it is taught** — 71.10 Component patterns; 72.1 Server state vs client state; 72.9 Client state stores.

### Q25. `React.memo`, `useMemo`, `useCallback`: when are they worth it?

- **Model answer** — All three trade memory and comparison work for skipped work. `React.memo(Component)` skips re-rendering when props are shallow-equal. `useMemo` caches a computed value between renders until dependencies change. `useCallback` caches a function's identity. They pay off when a render is measurably expensive (a 2,000-row table, a chart) or when identity matters (a memoised child, or a dependency of an effect). Elsewhere they add noise and can hide bugs with wrong dependency lists.
- **What a strong answer adds** — `React.memo` is defeated by a new object, array or inline function in the props on every render, which is why `useCallback` exists at all. Fix structure before memoising: move state down, or pass expensive children as `children` so they are not re-created. Measure with the Profiler first. The React Compiler, where a team adopts it, inserts this memoisation automatically, which changes the advice to "write plain code and let the compiler handle it" (71.12).
- **Where it is taught** — 71.6 `useMemo`, `useCallback` and custom hooks; 71.12 Performance basics.

### Q26. Server components versus client components in Next.js

- **Model answer** — In the App Router, components are **server components** by default: they run on the server (at build time or per request), can read the database or call internal APIs directly, and send rendered output to the browser with **no component JavaScript**. They cannot use state, effects, or browser APIs. A file starting with `'use client'` marks a **client component** boundary: it and everything it imports become part of the browser bundle, are pre-rendered to HTML on the server, then hydrated so they become interactive. Props passed from a server component to a client component must be serialisable (no functions, no class instances).
- **What a strong answer adds** — Push the `'use client'` boundary down to the leaves (the "Add to cart" button, not the whole product page) to keep bundles small. A server component can pass a server component to a client component as `children`, which keeps the child on the server. Secrets in a server component stay on the server, but anything passed as a prop to a client component is visible to the user. Server-side `fetch` and data caching behaviour has changed between Next.js major versions, so say which version you mean (73.5, 73.7).
- **Where it is taught** — 73.3 The App Router; 73.4 Server components and client components: the boundary.

### Q27. What is a hydration error, and how do you fix one?

- **Model answer** — Hydration is React attaching event handlers to server-rendered HTML by rendering the same tree in the browser and matching it to the existing DOM. A hydration error means the first client render produced different output from the server's HTML. Common causes: values that differ between server and client (`Date.now()`, `Math.random()`, `new Date().toLocaleString()` with a different time zone or locale), branching on `typeof window` during render, reading `localStorage` during render, invalid HTML nesting that the browser silently repairs (a `<div>` inside a `<p>`), and browser extensions that inject markup.
- **What a strong answer adds** — Fixes by cause: format dates on the server with an explicit time zone and locale, or render them in the client after mount; move browser-only reads into `useEffect` and render a placeholder first; for a truly client-only widget use `next/dynamic` with `ssr: false`, called from a client component (the App Router does not allow it in a server component); use `suppressHydrationWarning` only on a single element whose text legitimately differs, such as a timestamp. A mismatch is not only a console warning: React may discard the server HTML for that subtree and re-render it on the client, which costs LCP and can cause layout shift.
- **Where it is taught** — 73.10 Hydration and hydration errors.

### Q28. How do you fetch data and keep it fresh? How do you invalidate after a mutation?

- **Model answer** — On the client, use a server-state library. TanStack Query caches by **query key** (`['orders', { status: 'open' }]`), deduplicates concurrent requests for the same key, refetches stale data in the background, and retries failures. `staleTime` says how long data counts as fresh; garbage-collection time says how long unused data stays in memory. After a mutation, invalidate the affected keys so they refetch, or write the server's response into the cache directly.

  ```ts
  const queryClient = useQueryClient();
  const cancelOrder = useMutation({
    // The key comes in with the variables, so TanStack's automatic retries reuse it: one key per user action.
    mutationFn: ({ orderId, idempotencyKey }: { orderId: string; idempotencyKey: string }) =>
      api.cancelOrder(orderId, { idempotencyKey }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['order', updated.id], updated);          // the detail view updates at once
      return queryClient.invalidateQueries({ queryKey: ['orders'] });    // every list containing it refetches
    },
  });
  // In the click handler: a new key per click, generated once, outside mutationFn.
  cancelOrder.mutate({ orderId, idempotencyKey: crypto.randomUUID() });
  ```

  On the server in Next.js, data fetched in server components is cached by Next's own layers, and a Server Action invalidates them with `revalidatePath` or `revalidateTag`.

- **What a strong answer adds** — Name every cache between the database and the pixel and how each is invalidated: Redis on the backend, the CDN, the HTTP cache, Next's data and route caches, the client query cache (72.4, 73.7). Optimistic updates need a rollback path and an idempotency key so a retry does not cancel twice (72.6). For lists, invalidating a prefix key refetches every filtered variant. Real-time events can be merged into the cache instead of refetching (72.8).
- **Where it is taught** — 72.2 TanStack Query; 72.3 Stale time and background refetch; 72.5 Mutations and invalidation; 73.7 Next.js caching layers.

### Q29. How do you handle errors and loading states in a React tree?

- **Model answer** — Each region of the page owns its own loading, empty and error states, so one failing panel does not blank the page. **Error boundaries** catch errors thrown during rendering in their subtree and show a fallback; they do not catch errors in event handlers or async code, which you handle where they happen. **Suspense** shows a fallback while a child is waiting for data or code; in Next.js, `loading.tsx` and `error.tsx` are route-level Suspense and error boundaries.
- **What a strong answer adds** — Place boundaries by business importance: the recommendations panel can fail silently, the checkout summary cannot. Show the `requestId` from the error contract in the fallback so support can find the trace (74.6, 78.7). Avoid spinners that flash for 80 ms (delay them about 200 ms) and skeletons that shift layout when content arrives.
- **Where it is taught** — 71.11 Error boundaries and Suspense; 72.11 Loading, empty and error states; 74.6 Error contracts.

### Q30. A list page is slow to type into. How do you investigate?

- **Model answer** — Reproduce with CPU throttling (4x or 6x) in DevTools, record a Performance trace while typing, and look for long tasks on each keypress. Then open the React Profiler to see which components re-render and why. Typical findings: the input state lives at the top of a page that re-renders a 3,000-row list per keystroke; an inline object prop defeats `React.memo` on every row; filtering runs on every render instead of being memoised. Fixes in order: move the input state down or debounce the filter value, render the list from a deferred value (`useDeferredValue`) so typing stays responsive, memoise the rows, and virtualise the list so only about 30 rows exist in the DOM.
- **What a strong answer adds** — Gives the before-and-after metric (INP from 450 ms to 120 ms on a mid-range phone) and checks it in field data after release, not only in the lab. Considers moving filtering to the server for very large lists, with a debounced query and cancellation.
- **Where it is taught** — 71.9 Virtualisation; 71.12 The React Profiler; 76.4 INP.
