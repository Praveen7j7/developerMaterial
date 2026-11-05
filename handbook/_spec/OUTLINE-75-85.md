# Outline — Parts 75–85 (Batch 3: Volume 7 — Frontend and Full Stack)

This file is the assignment for every writer agent in batch 3. Read `_spec/STYLE.md` first, then this file, then only your own Part below.

## Who this volume is for

The reader is the same backend engineer as the rest of the book (Node.js, TypeScript, NestJS, PostgreSQL). They can build APIs and now have to build, review or debug the screens that call them. Teach frontend the way the rest of the book teaches backend: the mechanism first, then the tool, with production numbers and failure stories. Always show where the frontend meets the backend.

Stack for this volume: TypeScript, React 18, Next.js 14 (App Router), Vite, TanStack Query, Zustand (where client state is needed), zod, Vitest/Jest, Testing Library, MSW, Playwright, Lighthouse, and the NestJS backend from the rest of the book. Mobile apps are out of scope.

## Overrides to STYLE.md for this batch

- **Write it yourself.** Do not start sub-agents or forks; at most two writers run at once on this account.
- **Write path:** `/Users/maclapctp409/Downloads/files/hpStuff/learning/senior-backend-handbook/chapters/`.
- **Markdown only.** Do not touch `slides/`, `dist/`, `site/` or `build/`.
- **Only write files for your own Part number.** Never edit or rename other files.
- **Do not repeat existing Parts.** Each Part below lists what already exists. Reference it ("see Part 4 — Networking and HTTP") and go deeper or wider.
- File naming, heading levels, Mermaid rules, closing sections (Senior Checklist + Key Takeaways) and the 2,500–4,500 words-per-file split are unchanged from STYLE.md.
- Target per Part: **18,000–28,000 words**, typically 5–7 files.
- Code fence tags `tsx`, `html` and `css` are allowed in this volume, in addition to the STYLE.md list.
- Code: real React, Next.js and browser APIs only. Do not invent hooks, Next.js functions or library options. Name the version when behaviour differs between versions (for example Next.js Pages Router vs App Router).

## Teaching template for this volume

Use these `####` headings in this order for every major concept (skip one only when it genuinely does not apply):

```markdown
#### Concept
#### Why does it exist?
#### Mental model
#### How it works
#### Practical example
#### React / Next.js example
#### Backend side (NestJS)
#### Production scenario
#### Failure scenario
#### Edge cases & failure modes
#### How a Senior Full-Stack Engineer thinks about this
#### Common mistakes
#### Interview questions
#### Practical exercise
```

- **Backend side (NestJS)** shows what the API must do to make the frontend correct and fast: response shapes, headers, cookies, cache headers, pagination, error format, CORS, idempotency keys. This block is what makes the volume belong in this book.
- Example domains as elsewhere: orders, cart, checkout, payments, products, inventory, notifications, order tracking, food delivery.

---

# Volume 7 — Frontend and Full Stack (Parts 75–85)

## Part 75 — How the Browser Builds a Page

Exists already: what the browser does with a request (Part 71.6), HTTP caching and CORS (Part 4.11, 4.13), TLS (Part 4.12).

- From URL to pixels: navigation, HTML parsing, the DOM, CSSOM, render tree, layout, paint, compositing
- HTML that matters to engineers: semantic elements, forms and their default behaviour, the `<head>` (meta, preload, preconnect)
- CSS essentials: the box model, cascade and specificity, flexbox and grid, responsive design and media queries, why a CSS change can cause layout shift
- JavaScript in the page: script loading (`defer`, `async`, modules), the main thread, event loop in the browser vs Node (link Part 3.8), long tasks
- Browser storage: cookies, localStorage, sessionStorage, IndexedDB, Cache API — what each is for and what must never go in them
- Accessibility (a11y) as engineering: roles, labels, keyboard navigation, focus management, contrast; how a screen reader reads a page
- DevTools for backend engineers: Network panel (waterfall, timing, initiator), Performance panel, Application panel
- Worked example: tracing a product page from the first byte to interactive, with the network waterfall annotated

## Part 76 — Frontend Tooling and TypeScript in the Browser

Exists already: npm/packages basics (Part 72.3), Git workflow (Part 73).

- Why browsers need a build step: modules, TypeScript, JSX, old browsers, size
- Bundlers and dev servers: what Vite, esbuild, webpack and Turbopack do; hot module replacement; tree shaking; code splitting at build time
- Environment variables in frontends: build-time vs runtime, why every "secret" in a frontend bundle is public
- Source maps, minification and debugging production bundles
- TypeScript configuration for frontends: strictness, path aliases, DOM types, sharing types with the backend
- Monorepos: npm/pnpm workspaces, Nx/Turborepo concepts, a shared `contracts` package used by NestJS and React
- Linting and formatting (ESLint, Prettier) and pre-commit checks
- Decision table: Vite SPA vs Next.js vs plain server-rendered pages
- Worked example: a pnpm monorepo with `apps/api` (NestJS), `apps/web` (React) and `packages/contracts`

## Part 77 — React Fundamentals for Backend Engineers

Exists already: nothing dedicated.

- Components, props and JSX; thinking in components for an order page
- State and re-rendering: `useState`, how React decides what to re-render, reconciliation and keys
- Effects: `useEffect` done right (synchronising with the outside world), cleanup, why most data fetching should not be hand-written effects
- Other core hooks: `useMemo`, `useCallback`, `useRef`, `useReducer`, `useContext`; custom hooks
- Forms: controlled vs uncontrolled inputs, validation, React Hook Form with zod, double-submit protection (link idempotency, Part 8.5)
- Lists, tables and large lists (virtualisation)
- Component patterns: composition, lifting state up, container/presentational, error boundaries, Suspense
- Performance basics: unnecessary renders, memoisation tradeoffs, the React Profiler
- Worked example: a checkout form with address, coupon and payment steps

## Part 78 — Client State, Data Fetching and Caching

Exists already: HTTP caching (Part 4.11), backend caching (Part 16), pagination on the API side (Part 8.2).

- Server state vs client state; why putting API data in a global store goes wrong
- TanStack Query: queries, keys, stale time vs cache time, background refetch, deduplication, retries
- Mutations: invalidation, optimistic updates and rollback, idempotency keys from the client
- Pagination and infinite scroll from the client side; cursor contracts with the API
- Real-time data in the UI: polling vs SSE vs WebSockets from the browser (link Part 35), merging pushed events into the cache
- Client state stores: Context, Zustand, Redux Toolkit; when each is worth it
- Offline and flaky networks: retries, timeouts, `AbortController`, showing stale data honestly
- Loading, empty and error states as a design requirement
- Worked example: an order list with filters, infinite scroll, live status updates and an optimistic "cancel order"

## Part 79 — Next.js and Rendering Strategies

Exists already: CDN and edge (Part 28.3), caching (Part 16).

- Rendering strategies: client-side rendering, server-side rendering, static generation, incremental static regeneration, streaming; what each costs in latency, server load and SEO
- Next.js App Router: layouts, routes, server components vs client components, the boundary between them
- Data fetching on the server: `fetch` caching and revalidation, route segment config, Server Actions, Route Handlers
- Next.js caching layers (request memoisation, data cache, full route cache, router cache) and how to invalidate each
- The backend-for-frontend (BFF) pattern: Next.js as a BFF in front of NestJS services; when to keep a separate gateway
- Edge vs Node runtime; middleware; where auth checks run
- Hydration and hydration errors
- Deploying Next.js: static export vs Node server vs serverless; containers on ECS/Kubernetes
- Decision table: rendering strategy per page type (product page, cart, order history, admin dashboard)
- Worked example: a product listing page with ISR plus a personalised cart rendered on the client

## Part 80 — Frontend–Backend Contracts

Exists already: REST design (Part 8), GraphQL and gRPC (Part 61), API compatibility (Part 32), file uploads (Part 33), real-time (Part 35).

- Why contracts break between frontend and backend teams; the cost of "just change the field name"
- OpenAPI from NestJS (`@nestjs/swagger`) and generated typed clients (openapi-typescript, orval concepts)
- Shared schema packages with zod; validating at both ends; class-validator vs zod tradeoffs
- tRPC concepts and when end-to-end type safety is worth the coupling
- GraphQL clients and codegen for the frontend (Apollo/urql concepts)
- Error contracts: one error shape (RFC 7807 style), mapping errors to form fields and toasts
- Dates, money, IDs and enums across the wire: time zones, decimals as strings, large integers, unknown enum values
- Uploads and downloads from the browser: presigned URLs, progress, resumable uploads (link Part 33)
- Versioning and rollout with a frontend in the loop: old tabs still open, mobile and web on different versions, feature flags
- Contract testing (consumer-driven contracts, Pact concepts) between web and API
- Worked example: an order API, its generated client, and a breaking change caught in CI

## Part 81 — Auth and Security in the Browser

Exists already: authentication, JWT, OAuth2/OIDC, sessions (Part 22.1–22.4), XSS, CSRF (Part 22.21–22.22), CORS (Part 4.13).

- Where tokens live: HttpOnly cookies vs memory vs localStorage; the real threat model for each
- Session cookies done right: `HttpOnly`, `Secure`, `SameSite`, domain and path, cookie size limits
- Access and refresh tokens in a browser app: silent refresh, rotation, reuse detection, logout everywhere
- OIDC for single-page apps: authorization code flow with PKCE; why the implicit flow is dead
- Protecting routes and UI: route guards, role-based UI, why hiding a button is not authorization
- CSRF in practice with cookies; double-submit and SameSite
- XSS from the frontend side: React escaping, `dangerouslySetInnerHTML`, Content Security Policy, Trusted Types concept
- Third-party scripts, supply-chain risk, Subresource Integrity
- Clickjacking, open redirects and other browser-only attacks
- Worked example: login, refresh and logout for a Next.js app against a NestJS auth service

## Part 82 — Web Performance

Exists already: backend performance (Part 24), compression and HTTP/2 (Part 4), CDN (Part 28.3), cost (Part 39).

- Why frontend performance is revenue: conversion numbers, mobile networks, low-end devices
- Core Web Vitals: LCP, INP, CLS — what each measures and what moves it
- The critical rendering path; render-blocking resources; resource hints
- JavaScript cost: bundle size budgets, code splitting, lazy loading, third-party scripts
- Images and fonts: formats, responsive images, lazy loading, font loading strategies
- Caching for frontends: immutable hashed assets, HTML caching, service workers
- The backend's share: TTFB, API waterfalls, over-fetching, chatty endpoints, BFF aggregation
- Measuring: Lighthouse, WebPageTest, real-user monitoring (RUM), performance budgets in CI
- Worked example: taking a slow product page from LCP 4.8 s to under 2.5 s, step by step with numbers

## Part 83 — Frontend Testing and Quality

Exists already: backend testing strategy (Part 23), contract testing concepts (Part 23.4), CI (Part 29).

- The frontend testing pyramid (or trophy): what to test where
- Unit tests with Vitest/Jest for hooks and utilities
- Component tests with Testing Library: testing behaviour, not implementation
- Mocking the network with MSW; sharing mocks with the backend contract
- End-to-end tests with Playwright: stable selectors, test data, auth state, parallel runs, flakiness control
- Visual regression and accessibility testing (axe)
- Testing against a real NestJS backend in CI (docker compose)
- Code review for frontend changes: what a backend reviewer should look for
- Worked example: tests for the checkout flow from unit to end-to-end

## Part 84 — Shipping and Operating Frontends

Exists already: CI/CD and deployment strategies (Part 29), feature flags (Part 29.6), observability (Part 25), containers (Part 26).

- Hosting options: static hosting on S3 + CloudFront, Vercel/Netlify concepts, Node servers for SSR
- Build once, deploy many: runtime configuration for frontends
- Cache busting and versioned assets; what happens to users on the old version during a deploy
- Rollouts for frontends: canaries, feature flags, kill switches, rollback
- Error tracking (Sentry concepts) with source maps; correlating a browser error with a backend trace (link Part 25.4)
- Real-user monitoring and frontend SLOs
- Frontend security headers at the edge (CSP, HSTS)
- Incident story: a deploy that broke checkout only for users with a cached old bundle
- Worked example: a GitHub Actions pipeline that builds, tests and deploys the web app with preview environments

## Part 85 — Full-Stack Worked Project: Live Order Tracking

Exists already: every Part above; NestJS backend examples throughout the book.

Build one feature end to end and show every decision, in this order:

- Requirements and non-functional requirements (latency, freshness, scale numbers)
- API design and contract (REST + SSE), shared types package
- NestJS backend: endpoints, PostgreSQL schema, status events, SSE stream, auth, rate limits
- Next.js frontend: order page (server-rendered shell), live status (client component with SSE), optimistic actions, error states
- Auth across both: cookies, refresh, guards on both sides
- Performance: caching, payload size, Core Web Vitals check
- Tests: backend unit/integration, frontend component, one Playwright journey across both
- Deployment: containers, CDN, environment config, feature flag rollout
- Observability: one trace from a browser click to a database write
- Failure drills: backend down, SSE disconnects, stale bundle, slow database
- Senior review: what you would change at 10x scale

---

## Wave plan

One writer agent per Part, at most 2 agents at a time, interleaved with the expansion work in `_spec/EXPANSION.md`. After each Part: `node build/check-structure.js` and `node build/validate-mermaid.js part-NN`.
