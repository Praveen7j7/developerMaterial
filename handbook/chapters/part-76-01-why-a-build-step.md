# Part 76 — Frontend Tooling and TypeScript in the Browser

A NestJS service has a simple relationship with its tooling. You write TypeScript, `tsc` (or `nest build`, which calls `tsc` or SWC) turns it into JavaScript in `dist/`, and Node.js runs that JavaScript on a machine you control. Nobody downloads your `dist/` folder over a 4G connection. Nobody runs it on a five-year-old phone. Nobody can read your `process.env` from the outside.

A frontend breaks all three of those assumptions. The code you write runs on millions of machines you do not control, in browsers you did not choose, after travelling across a network that charges you in milliseconds for every kilobyte. And every byte you ship is public: anyone can press F12 and read it. That is why the frontend world has so much tooling, and why that tooling looks strange to a backend engineer the first time: a dev server that does not bundle, a production build that does, environment variables that are frozen into files, source maps that can leak your source code, a TypeScript compiler that is used only to check types and never to produce output.

Part 4 — Linux and the Command Line covered npm, lock files and semantic versioning (4.6). Part 5 — Git Basics and the Development Workflow covered the branch-and-pull-request workflow. Part 75 — How the Browser Builds a Page showed what the browser does with scripts once they arrive: `defer`, `async`, modules and the cost of parsing and executing JavaScript on the main thread (75.6, 75.7). This Part sits between those. It explains what happens from the moment you save a `.tsx` file to the moment a hashed, minified, compressed bundle sits on a CDN, and it shows how one TypeScript codebase can feed both a NestJS API and a React web app without the two drifting apart.

We will cover why browsers need a build step at all, how transpilers turn TypeScript and JSX into JavaScript for a chosen set of browsers, what bundlers and dev servers (Vite, esbuild, webpack, Turbopack) actually do, how hot module replacement works, how tree shaking and code splitting decide what each user downloads, why every "secret" in a frontend bundle is public, how source maps and minification interact with production debugging, how to configure TypeScript for the browser and share types with the backend, how monorepos with pnpm workspaces and Turborepo or Nx hold it all together, and how ESLint, Prettier and pre-commit checks keep it clean. We finish with a decision table for choosing a frontend stack and a worked pnpm monorepo with `apps/api` (NestJS), `apps/web` (React) and `packages/contracts`.

As in the rest of this Volume, every concept ends with a **Backend side (NestJS)** block: what the API, or the backend team, must do so that the frontend build is correct, fast and safe.

## 76.1 Why browsers need a build step

#### Concept

A **build step** is a program that runs on your machine or in CI before deployment and turns the code you write into the code the browser runs. For a backend you already have one: `tsc` compiles `src/` to `dist/`. For a frontend the build step does more, because the gap between "what developers want to write" and "what browsers can efficiently download and execute" is wider.

Developers want to write TypeScript, JSX (`<OrderCard order={order} />`), hundreds of small files that import each other, imports of npm packages by bare name (`import { z } from 'zod'`), CSS modules, images imported as values, and modern syntax. Browsers natively understand JavaScript, HTML and CSS, ES modules loaded by URL (not by package name), and whatever syntax and APIs their particular version supports. The build step closes that gap: it **transpiles** (TypeScript and JSX to JavaScript, new syntax to older syntax), **bundles** (many files into a few), **resolves** (bare package names into real files), **optimises** (removes unused code, minifies, compresses) and **fingerprints** (adds a content hash to every file name so it can be cached forever).

#### Why does it exist?

Five separate problems, each of which alone would justify a build step:

1. **TypeScript and JSX are not JavaScript.** No browser runs `.ts` or `.tsx`. Type annotations must be stripped and JSX must become function calls (`jsx('div', {...})`). Node.js 22.6+ can strip simple TypeScript types with a flag and Node 23.6+ does it by default, but browsers do not, and JSX is not part of any standard.
2. **Modules over the network are slow.** Browsers do support ES modules (75.6), but each `import` is discovered only after the importing file is downloaded and parsed. A real React app has 1,500 to 4,000 modules once you include `node_modules`. Loading them one by one, level by level, even over HTTP/2, takes many round trips. On a 150 ms mobile connection, a dependency graph eight levels deep costs at least 1.2 s in discovery alone.
3. **Bare imports do not resolve.** `import { useQuery } from '@tanstack/react-query'` means nothing to a browser. It needs a URL. Import maps can map names to URLs, but you still need something to find the right file inside `node_modules`, read its `package.json` `exports` field and choose the browser build.
4. **Old browsers.** Your users are not all on the latest Chrome. Safari on an iPhone that can no longer update, an embedded browser inside a banking app, a corporate Windows machine with an old Edge: each supports a different set of syntax and APIs. Writing for the lowest common denominator by hand would mean giving up `?.`, `??`, `async`/`await` and class fields.
5. **Size is user-visible latency.** Every kilobyte is downloaded over a mobile network and then parsed and compiled on a slow CPU (75.7). Comments, long variable names, whitespace, unused functions in a library and development-only warnings all cost the user time. A build step removes them.

Without a build step you get one of two bad outcomes: a codebase written in plain old JavaScript with globals and script tags (how much of the web worked before 2015), or a page that loads 3,000 files one by one and runs development-mode React in production.

#### Mental model

Imagine a restaurant kitchen. Chefs work with whole ingredients, scraps, notes on the recipe, measuring spoons and tasting spoons. The customer receives a plated dish: trimmed, portioned, arranged so it can be eaten quickly, with no measuring spoons on the plate. The build step is the pass between kitchen and dining room. It throws away what the customer does not need (types, comments, unused code), combines components into portions that can be delivered in one trip (bundles), and labels each plate with a unique ticket so the waiter never serves yesterday's version (content hashes).

The kitchen also has a tasting mode for the chef, which is very different from service: dishes are prepared one component at a time, half-assembled, and adjusted in seconds. That is the dev server. It optimises for "see my change in 50 ms", not for "smallest download".

#### How it works

A frontend build is a pipeline. Different tools implement different stages, but the stages are the same everywhere:

```mermaid
flowchart LR
    src["Source: .ts .tsx .css .svg"] --> resolve["Resolve imports to files"]
    resolve --> transform["Transform: strip types, JSX, down-level syntax"]
    transform --> mgraph["Module graph"]
    mgraph --> shake["Tree shake unused exports"]
    shake --> chunk["Split into chunks"]
    chunk --> minify["Minify and mangle"]
    minify --> hash["Content hash file names"]
    hash --> out["dist: index.html plus hashed assets"]
    out --> cdn["CDN with immutable caching"]
```

Step by step, for a Vite + React app:

1. **Entry.** The build starts from `index.html`, finds `<script type="module" src="/src/main.tsx">`, and treats `main.tsx` as the entry module.
2. **Resolve.** For every `import`, the bundler finds the file. Relative paths are easy. Bare names (`react`) go through Node-style resolution: look in `node_modules/react/package.json`, read its `exports` map, pick the `browser` or `import` or `default` condition, and also honour any path aliases you configured.
3. **Load and transform.** Each file is read and transformed. TypeScript types are stripped (by esbuild in Vite 2 to 7, by Oxc in Vite 8), JSX becomes `jsx()` calls from `react/jsx-runtime`, CSS is processed, an imported `logo.svg` becomes a URL string.
4. **Build the module graph.** The bundler now knows every module and every import edge. This graph is the core data structure of every bundler.
5. **Tree shake.** Starting from the entry, the bundler marks which exports are actually used and drops the rest (76.5).
6. **Chunk.** Modules are grouped into output files. Dynamic `import()` calls create split points, so the admin dashboard does not ship to every shopper (76.5).
7. **Minify.** Whitespace and comments go, local variable names become one letter, `if (process.env.NODE_ENV !== 'production')` blocks that were replaced with `if (false)` are removed entirely.
8. **Hash and emit.** Each output file is named after a hash of its content: `assets/index-B7xQ2kLm.js`. `index.html` is rewritten to reference those names. Because the name changes whenever the content changes, the files can be cached for a year with `Cache-Control: public, max-age=31536000, immutable`, while `index.html` itself is revalidated on every load (Part 14 — Networking and HTTP, 14.11).

Here is what that means in numbers for a typical mid-size e-commerce SPA (React 18, React Router, TanStack Query, zod, a date library, an icon set, about 220 source files):

| Measure | Unbundled dev server | Production build |
|---|---|---|
| Modules in the graph | about 1,900 (including `node_modules`) | same graph |
| Files the browser requests | 300 to 600 on first load (dependencies pre-bundled) | 6 to 15 |
| JavaScript transferred | 4 to 7 MB, uncompressed, with dev warnings | 180 to 260 KB gzip for the first route |
| React build | development (extra checks, about 3x slower) | production |
| Source available in DevTools | yes, original files | only through source maps |

The "1,900 modules become 10 files and 220 KB" line is the whole reason the build step exists.

A note on **import maps**. Browsers since 2023 (Chrome 89, Firefox 108, Safari 16.4) support `<script type="importmap">`, which maps bare names to URLs:

```html
<script type="importmap">
  { "imports": { "zod": "https://cdn.jsdelivr.net/npm/zod@3.23.8/+esm" } }
</script>
<script type="module">
  import { z } from 'zod'; // resolved through the import map
</script>
```

That solves bare imports, and for a small internal page with three dependencies it is a fine choice with no build at all. It does not solve TypeScript, JSX, the module waterfall, tree shaking or minification. Rails 7 uses this approach ("no-build" with importmap-rails) precisely for server-rendered apps with little JavaScript. For a React app with thousands of modules, it does not scale.

#### Practical example

An order tracking page in a food delivery app is written as 14 source files: `main.tsx`, `App.tsx`, `routes/track.tsx`, `components/StatusTimeline.tsx`, `components/RiderMap.tsx`, `api/client.ts`, `api/orders.ts`, `hooks/useOrderStatus.ts`, plus styles and icons. It imports React, React DOM, TanStack Query, zod and a map library.

Without a build, the browser would need a TypeScript compiler (it has none), would fail on the first `import React from 'react'`, and even with an import map would request roughly 420 files. With a build:

- `index-Cj3k9P1a.js`, 61 KB gzip: React, React DOM, the router, the app shell.
- `track-D9f2LmQe.js`, 18 KB gzip: the tracking route, TanStack Query, zod schemas.
- `RiderMap-A1b2C3d4.js`, 94 KB gzip: the map library, loaded only when the map scrolls into view.
- `index-Bq7rT0aZ.css`, 9 KB gzip.

On a mid-range phone over 4G the first two files arrive in about 450 ms and execute in about 180 ms. The map chunk arrives later, off the critical path.

#### React / Next.js example

The source you write for that page uses all the things the browser cannot run directly:

```tsx
// src/routes/track.tsx  (React 18, Vite)
import { lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { useOrderStatus } from '../hooks/useOrderStatus';   // TypeScript module
import { StatusTimeline } from '../components/StatusTimeline';
import type { OrderStatus } from '@shop/contracts';         // type-only, erased at build

// Split point: the bundler emits RiderMap as its own chunk.
const RiderMap = lazy(() => import('../components/RiderMap'));

export default function TrackOrderRoute() {
  const { orderId } = useParams<{ orderId: string }>();
  const { data, isPending, error } = useOrderStatus(orderId!);

  if (isPending) return <p aria-busy="true">Loading your order...</p>;
  if (error) return <p role="alert">We could not load this order. Pull down to retry.</p>;

  const status: OrderStatus = data.status;
  return (
    <main>
      <h1>Order {data.displayId}</h1>
      <StatusTimeline status={status} events={data.events} />
      {status === 'OUT_FOR_DELIVERY' && (
        <Suspense fallback={<div style={{ height: 320 }} aria-hidden="true" />}>
          <RiderMap riderId={data.riderId} />
        </Suspense>
      )}
    </main>
  );
}
```

After the build, the type annotations and the `import type` line are gone, the JSX is calls to `jsx()` and `jsxs()`, `lazy(() => import('../components/RiderMap'))` points to `./RiderMap-A1b2C3d4.js`, and the whole module is merged with its neighbours into `track-D9f2LmQe.js`. With Next.js 14 the same transformation happens inside `next build`, using SWC for transforms and webpack for bundling by default; Turbopack takes over bundling as an opt-in in Next.js 15 and as the default from Next.js 16.

#### Backend side (NestJS)

When the built SPA is served by your NestJS application (common for admin panels and internal tools, where a separate CDN setup is overkill), the backend must understand the shape of a build output: one HTML entry that must never be cached for long, many hashed files that should be cached forever, and client-side routes that do not exist as files. `@nestjs/serve-static` handles this:

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    OrdersModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'web', 'dist'),
      // Do not let the SPA fallback swallow API routes. NestJS 11 (Express 5,
      // path-to-regexp v8) uses '/api/{*path}'; NestJS 10 and earlier used '/api*'.
      exclude: ['/api/{*path}'],
      serveStaticOptions: {
        // Unknown paths like /orders/123 return index.html, so the client router can handle them.
        fallthrough: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache'); // always revalidate the entry
          } else if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      },
    }),
  ],
})
export class AppModule {}
```

Three things the backend owns here:

- **The SPA fallback must not hide API 404s.** A request to `/api/v1/ordrs` (typo) must return a JSON 404, not `index.html` with status 200. Otherwise the frontend's JSON parser fails with `Unexpected token '<'` and the real error is invisible.
- **Missing assets must 404, not fall back to HTML.** If `/assets/track-OLDHASH.js` is requested after a deploy, returning `index.html` produces a confusing "Failed to fetch dynamically imported module" or a MIME type error. The fallback should apply only to paths without a file extension.
- **Caching follows the hash.** Immutable for `assets/`, `no-cache` for `index.html`. Get this backwards and users run yesterday's bundle against today's API.

#### Production scenario

A logistics company ran its dispatcher console as a single 2.4 MB JavaScript file built by a hand-written Gulp script in 2016: concatenation plus Uglify, no modules, no hashing, served with `Cache-Control: max-age=3600`. Every deploy produced an hour of support tickets because some browsers kept the old file while the API had already changed. Load time on the warehouse tablets was 6 to 8 s.

They moved to Vite with React and TypeScript. The production build produced 14 hashed files; the dispatcher's first route was 210 KB gzip; the map and reporting screens loaded on demand. Load time on the same tablets fell to 1.9 s, and because file names now changed with content and `index.html` was revalidated, stale-bundle tickets after deploys went to zero. The build took 38 s in CI, compared with 3 minutes for the old Gulp pipeline.

#### Failure scenario

At 16:40 on a Friday a team shipped a new internal returns dashboard. In staging it worked. In production every page showed a blank screen and the console said `Uncaught ReferenceError: process is not defined`.

The cause: a shared utility file, written for the NestJS backend, read `process.env.FEATURE_RETURNS_V2` directly. Webpack 4, which the team's older apps used, automatically polyfilled `process` for the browser, so this had always "worked". The new app was built with Vite, which does not polyfill Node globals and only replaces `import.meta.env.*` and an explicit list of `define` keys. Staging worked because the developer had a `define: { 'process.env': {} }` hack in a local config file that was never committed.

The fix took ten minutes: read feature flags from a runtime config endpoint instead of `process.env`, and add an ESLint `no-restricted-globals` rule for `process` in browser code. The lesson took longer to learn: code that runs in the browser is not Node.js, and the build tool decides which Node-isms silently "work". Webpack 5 removed automatic Node polyfills for exactly this reason.

#### Edge cases & failure modes

- **Development and production differ.** Dev servers serve unbundled modules with development React; production is bundled, minified and tree-shaken. Bugs that only appear after minification (code that relies on `function.name`, which mangling changes) or after tree shaking (a side effect in an "unused" import) never show in dev.
- **Case-insensitive file systems.** `import './orderCard'` when the file is `OrderCard.tsx` works on macOS and Windows and fails on the Linux CI runner or Docker build.
- **Node globals in shared code**: `process`, `Buffer`, `__dirname`, `require` do not exist in the browser; behaviour depends on the bundler.
- **Packages without a browser build**: a library that ships only CommonJS or depends on `fs` will either fail to build or bloat the bundle with polyfills.
- **Unhashed asset names** cached at the CDN keep serving old code after a deploy.
- **A build that "succeeds" with type errors**: most bundlers do not type-check (76.2), so a green build does not mean correct types.

#### How a Senior Full-Stack Engineer thinks about this

A senior treats the frontend build as part of the production system, not a developer convenience. The build output is the artefact that ships, so it is reviewed, measured and reproducible like a Docker image (Part 48 — Docker for Backend Engineers). They ask: what is the size of the first-route JavaScript, and is it in a budget? Which browsers do we support, and who decided? Is the build deterministic from the lock file? Does a green build also mean a green type check?

They also refuse the opposite extreme. A two-page internal status page does not need a bundler, a framework and a monorepo; server-rendered HTML with a small `<script type="module">` and an import map is simpler and will still work in ten years. To a product manager they would say: "The build step is what lets us write the app quickly and still send phones a small, fast download. We keep it simple and measure what it produces."

#### Common mistakes

- **Treating the dev server as a preview of production.** Always test the production build (`vite build && vite preview`, or `next build && next start`) before release.
- **Shipping development builds.** A missing `NODE_ENV=production` in a custom webpack setup ships React's development build, about 3x slower and much larger.
- **Long-caching unhashed files** or short-caching hashed ones.
- **Sharing backend utility files with the frontend** without checking for Node-only globals and modules.
- **Assuming the build checks types.** It usually does not; run `tsc --noEmit` separately.

#### Interview questions

1. **Browsers support ES modules. Why do we still bundle?**
   Expected answer: module discovery is a waterfall (one round trip per level of the import graph), thousands of small files have per-request overhead, bare imports do not resolve without a tool, and bundling enables tree shaking, minification and hashed caching. Why it matters: shows the candidate understands the network cost, not just "because everyone does". Follow-up: when would you skip bundling? (Small pages, import maps, few dependencies.)
2. **What does a content hash in a file name buy you?**
   Expected answer: the URL changes whenever content changes, so the file can be cached forever with `immutable`, and only the HTML entry needs revalidation. Follow-up: what happens to a user with the old `index.html` open during a deploy? (Old chunk names; keep previous assets available, see Part 84.)
3. **What are the stages of a frontend build?**
   Expected answer: resolve, transform, build the module graph, tree shake, chunk, minify, hash, emit.
4. **Your SPA shows `Unexpected token '<'` when parsing an API response. What happened?**
   Expected answer: the server returned HTML (often the SPA fallback `index.html` or a proxy error page) where JSON was expected; fix the routing so API paths never fall through to the SPA.
5. **Why does code that worked with webpack 4 fail with `process is not defined` in Vite or webpack 5?** Expected answer: webpack 4 polyfilled Node globals automatically; newer tools do not, so Node-specific code must not run in the browser.

#### Practical exercise

Create a Vite React TypeScript app (`npm create vite@latest web -- --template react-ts`), add an order list route and a lazily loaded order detail route, then build it.

Acceptance criteria:

- You can list every file in `dist/assets/`, its gzip size (`gzip -c file | wc -c`), and which source modules ended up in each.
- You can explain why the order detail route is a separate file.
- You serve `dist/` from a NestJS app with `ServeStaticModule`, and verify with `curl -I` that `index.html` has `Cache-Control: no-cache`, hashed assets have `immutable`, `/orders/42` returns the HTML, and `/api/does-not-exist` returns a JSON 404.

