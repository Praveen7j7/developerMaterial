# Part 79 — Full-Stack Worked Project: Live Order Tracking

This Part builds one feature end to end, in the order a senior team would build it, and shows every decision along the way: a live order tracking page for the grocery storefront that has run through this whole volume. A customer places an order, opens `shop.example/orders/<id>`, and watches it move from "Paid" to "Packing" to "Out for delivery" to "Delivered", with an arrival window, a timeline, a delivery note they can edit, and a cancel button that works only while cancelling is still possible.

Nothing in this Part is new technology. Every mechanism was introduced earlier, and this Part cites where: the shared contracts package and error shape (Part 74), the BFF and its cookies (Parts 73 and 75), the query cache and the SSE merge rules (Part 72), Web Vitals budgets (Part 76), the test layers (Part 77), and the delivery pipeline (Part 78). On the backend it uses the transactional outbox (Part 30.10), optimistic concurrency (Part 21.5), Redis Streams and SSE (Parts 27 and 35). The point is to see them work together, and to see the places where they pull against each other.

Stack and versions, as in the rest of the volume: Next.js 14 App Router with notes for 15, React 18, TanStack Query v5, zod 3, NestJS 10 with TypeORM 0.3, PostgreSQL 16, Redis 7, Vitest 3, MSW 2, Playwright 1.5x, OpenTelemetry, and the AWS setup of Part 78 (ECS Fargate, ALB, CloudFront, S3).

## 79.1 Requirements and non-functional requirements

#### Concept

A **requirement** says what the feature does for the user. A **non-functional requirement (NFR)** says how well it must do it: how fast, how fresh, how available, at what scale, at what cost. For a live feature the NFRs decide the architecture more than the functional requirements do. "Show the order status" can be built with a page refresh; "show a status change within 2 seconds to 60,000 people watching at once" cannot.

#### Why does it exist?

Because without numbers, every design choice is an opinion. Polling or SSE? One stream per order or per customer? Cache the page at the CDN or not? Each question has a different answer at 500 viewers and at 60,000, at a 30-second freshness target and at a 2-second one. Writing the numbers down first is what lets a team argue about the design instead of about taste.

#### Mental model

Imagine commissioning a bridge. "It crosses the river" is the requirement. "It carries 40-tonne trucks, survives a 1-in-100-year flood, and costs under budget" are the NFRs, and they decide whether you build a footbridge or a suspension bridge.

#### How it works

**Functional requirements**, written as a product manager and an engineer would agree them:

1. A signed-in customer can open the tracking page for **their own** order from the confirmation page, the order list (72.12), a push notification or an email link.
2. The page shows: order number, items, total, delivery address, the current status in words, an **arrival window** ("Arriving 7:10 to 7:30 pm" in the store's time zone, 74.7), and a timeline of status changes with times.
3. Status changes appear **without a reload**: Paid, Packing, Out for delivery, Delivered (or Cancelled).
4. The customer can **edit the delivery note** ("Leave at the door, ring once") until the order is out for delivery. The change shows immediately.
5. The customer can **cancel** while the order is Paid; once packing starts the button explains why it is gone.
6. If live updates stop, the page says so honestly and keeps showing the last known status with its time (72.10, 72.11).
7. Screen reader users hear status changes, but not every ETA tweak (69.9, 83.10).

**Non-functional requirements**, with the numbers that drive the design:

| NFR | Target | Why this number |
|---|---|---|
| Orders per day | 400,000; evening peak 18,000 per hour | Current volume x 1.5 headroom |
| Concurrent tracking viewers at peak | 60,000 (about 1 in 3 active orders has a tab open) | RUM data from the old polling page |
| Status changes per order | 5 on average (PAID, PACKING, OUT_FOR_DELIVERY, DELIVERED, plus ETA updates) | Dispatch data |
| Events at peak | about 120 per second, bursts to 600 when a dark store releases a batch of riders | 18,000 orders/h x 5 / 3,600 x safety factor |
| Freshness | p95 under 2 s from the database commit to the customer's screen; p99 under 5 s | Customers stare at this page while waiting; support calls rise when it lags |
| Tracking page load | TTFB p75 under 400 ms; LCP p75 under 2.0 s on mobile; INP p75 under 150 ms; CLS under 0.05 | Volume budgets from 76.2, tighter LCP because the page is mostly text |
| Availability | 99.9 % for reading tracking (page and stream combined), 28-day window | One of the frontend SLOs of 78.8 |
| Degradation | API down: last known status stays visible; stream down: polling every 30 s within 10 s of detecting it | 72.10 "honest stale data" |
| Security | Customers see only their own orders; enumeration returns 404, not 403; delivery notes are personal data | Part 40.12 IDOR, 40.31 data protection |
| Cost | Under 0.02 cents per tracked order in compute and data transfer | Finance's ceiling for the feature |

**What is out of scope**, written down so nobody builds it by accident: a live rider map (the driver app and the WebSocket gateway of 35.13 own locations), chat with the rider, and native mobile apps (they consume the same API and events).

#### Practical example

Turning the NFRs into first estimates, before any code:

- **Connections**: 60,000 concurrent SSE streams. A NestJS process holding idle SSE connections uses roughly 30-60 KB of memory per connection (socket buffers, the RxJS subscription, the Redis consumer bookkeeping). At 50 KB, 60,000 streams need about 3 GB of memory in total; spread over 6 tasks of 2 GB, that is 10,000 streams and 500 MB per task, comfortable.
- **Event fan-out**: 120 events per second, each to exactly one customer stream. Fan-out is 1:1 per order, not broadcast, so the stream layer does about 120 writes per second at peak, trivial; the cost is the connections, not the events.
- **Page loads**: 18,000 orders per hour, each tracking page opened about 4 times (notification, reopen, refresh): about 20 page loads per second at peak, each one server-rendered with one API call. Small.
- **Polling comparison**: the old page polled every 10 s; at 60,000 viewers that was 6,000 requests per second, 95 % unchanged (the same numbers as 72.8's meal-kit story). SSE replaces it with 60,000 mostly idle connections and 120 events per second.
- **Bandwidth**: an event is about 250 bytes on the wire with SSE framing; heartbeats every 20 s are 20 bytes. 60,000 x 20 bytes / 20 s = 60 KB/s of heartbeats. Negligible.

#### Backend side (NestJS)

The NFRs translate into backend commitments that shape every later section:

- **One source of truth for status**: the `orders` row, changed only by conditional updates with a version (79.3), never by two services writing independently.
- **Events derived from committed state** through an outbox (Part 30.10), so a status the customer sees always exists in the database, and no committed change is lost if Redis or the process dies.
- **Long-lived connections isolated** from request/response traffic, so a reconnect storm cannot starve checkout (bulkheads, Part 31.6; deployment in 79.10).
- **Every endpoint bounded**: rate limits, payload caps, timeouts and a connection cap per user (79.4).

#### Production scenario

The team that owned the polling page measured it for a week before starting: p50 freshness 5.1 s (half the poll interval plus processing), 6,000 requests per second at peak hitting the orders API, 31 % of the API's peak CPU spent on unchanged tracking responses, and 2,400 support contacts a week starting with "where is my order" while the page showed a stale status. Those four numbers became the success criteria: p95 freshness under 2 s, tracking API load down by 90 %, and "where is my order" contacts down by a third.

#### Failure scenario

A previous attempt, two years earlier, started from the code. A developer added a WebSocket gateway, one socket per order card, broadcast every status change to every connected client ("the client filters"), and shipped it on a Friday. At the evening peak, 40,000 connected clients each received every one of 120 events per second: 4.8 million messages per second, most of them discarded by the browser. The gateway pods ran out of CPU in nine minutes, the load balancer marked them unhealthy, every client reconnected at once, and the reconnect storm took down the orders API they shared. Nobody had written down "fan-out is 1:1 per order".

#### Edge cases & failure modes

- **Viewers per order greater than one**: a customer with the page open on a phone and a laptop, plus a family member; plan for 1.3 streams per active order.
- **Batch releases**: a dark store dispatching 200 orders at once produces a burst of 200 events in a second; the burst, not the average, sizes the relay.
- **Very long-lived tabs**: a tab left open overnight after delivery must stop streaming (79.6).
- **Time zones**: arrival windows are shown in the store's time zone, not the device's (74.7); a customer travelling still sees store time.
- **Orders from other channels** (phone orders placed by support) must be trackable the same way.

#### How a Senior Full-Stack Engineer thinks about this

The senior starts with a one-page brief: requirements, NFRs with numbers, out-of-scope items, and back-of-envelope estimates for connections, events, page loads and cost. They make freshness a measured SLO from day one, because a live feature that is sometimes 30 seconds late is worse than an honest refresh button. They notice the shape of the load (many idle connections, few events, 1:1 fan-out) and let it pick the transport. And they decide what the page does when each dependency fails before they decide how it looks when everything works.

#### Common mistakes

- **Choosing the transport first** (WebSockets "because real-time") and the numbers later.
- **Averages instead of bursts** for sizing.
- **No degradation requirement**, so the first outage produces a blank page.
- **Forgetting authorization** in the requirement: "my order", not "an order".

#### Interview questions

1. **What NFRs would you write for a live order tracking page?** Expected answer: concurrent viewers, events per second at peak and in bursts, freshness percentiles, page load budgets, availability, degradation behaviour, security and cost.
   Follow-up: which of them decides SSE versus polling? (Freshness and viewer count together.)
2. **How do you estimate the cost of 60,000 SSE connections?** Expected answer: memory per connection times count, spread across tasks; events per second are small because fan-out is 1:1.
3. **Why write out-of-scope items down?** Expected answer: they stop scope creep and keep the design from being sized for features nobody asked for (a rider map needs a different transport and rate).

#### Practical exercise

Write the one-page brief for live tracking of your own product (a parcel, a ride, a food order).

Acceptance criteria:

- Functional requirements as numbered user-visible behaviours, including what happens when live updates fail.
- At least eight NFRs with numbers and a reason for each.
- Back-of-envelope estimates for connections, events per second (average and burst), page loads per second and memory.
- An out-of-scope list of at least three items.

## 79.2 API design and contract: REST, SSE and the shared types package

#### Concept

The feature needs four things from the API: read one order's tracking state, push changes to it, change the delivery note, and cancel. Following the volume's decisions, the reads and writes are **REST endpoints** (Part 15), the push is the **per-customer SSE stream** already used by the order list (72.8), and every shape lives in `@shop/contracts` as zod schemas (74.3), validated on both sides, with errors in the one problem-document shape (74.6) and the SSE payloads covered by Pact message contracts (74.10).

#### Why does it exist?

Because the contract is what lets three teams (web, orders API, dispatch) work in parallel. Once `OrderTrackingSchema` and the event schema are merged, the web team builds against MSW fixtures parsed through them (77.6), the API team builds the endpoints that must produce them, and Pact checks that what is deployed still matches. Without the contract first, the frontend waits for the backend, or guesses, and the guesses become production bugs.

#### Mental model

Imagine building a house where the plumber and the electrician work at the same time. They can, if the drawings show where every pipe and cable enters each room. The contract is the drawing. Change it, and both trades must see the change before they cut a hole in a wall.

#### How it works

**Transport choice**, from the browser's side (72.8) and the server's (35.1), applied to this feature's numbers:

| Option | Freshness | Load at 60,000 viewers | Complexity | Verdict |
|---|---|---|---|---|
| Polling every 10 s | p50 about 5 s | 6,000 RPS, mostly unchanged | Lowest | Fails the 2 s freshness target |
| Polling every 2 s | p50 about 1 s | 30,000 RPS | Low | Meets freshness, fails cost |
| SSE, one stream per customer | Sub-second | 60,000 idle connections, 120 events/s | Medium | Chosen |
| WebSocket | Sub-second | Same connections | Higher: own reconnection, upgrade support | Not needed: the client sends nothing on this channel |

The per-customer stream of 72.8 (`GET /v1/orders/events`) is reused rather than adding `GET /v1/orders/:id/events`, for three reasons: the order list and the tracking page share one connection per tab; a customer with two orders in flight needs one stream, not two (connections are the cost, 79.1); and the server-side replay already exists. The client filters by `orderId`, which is cheap because events are only for that customer.

**Endpoints:**

| Method and path | Purpose | Notes |
|---|---|---|
| `GET /v1/orders/:id/tracking` | Everything the page needs in one response | `private, no-cache` with `ETag`; 404 for other customers' orders |
| `GET /v1/orders/events` | Per-customer SSE stream (72.8) | Event types `order`, `reset`, `reauth`, `ping`; replay from `Last-Event-ID` |
| `PATCH /v1/orders/:id/delivery-note` | Change the note | `Idempotency-Key`; `expectedVersion`; returns the new tracking state |
| `POST /v1/orders/:id/cancel` | Cancel (72.12) | `Idempotency-Key`; `409 ORDER_NOT_CANCELLABLE` once packing started |

Through the BFF, the browser calls them as `shop.example/api/v1/...` (the `rewrites` proxy of 73.8), and the stream is routed by CloudFront straight to the API's realtime tasks (79.10), so no Next.js process buffers it.

**New statuses, rolled out in the right order.** The existing `OrderStatusSchema` (74.7) has `PENDING, PAID, SHIPPED, DELIVERED, CANCELLED`. Grocery delivery needs `PACKING` and `OUT_FOR_DELIVERY` (`SHIPPED` stays for parcel orders). A new response enum value is a change where the **clients ship first** (the table in 74.9): the web already reads statuses through `openEnum` (74.7), which maps unknown values to `UNKNOWN` and renders a generic "Updated" badge; mobile apps get a release with the new labels; only after version telemetry shows old mobile builds below the threshold does the API start emitting the new values.

#### Practical example — the contracts

```ts
// packages/contracts/src/orders.ts (additions)
import { z } from 'zod';
import { OrderSummarySchema } from './orders.summary';     // 80.11: id, displayId, status, totalMinor, currency, items,
                                                           // placedAt, deliveryDate, deliveredAt, storeTimeZone, version, updatedAt
export const OrderStatusSchema = z.enum([
  'PENDING', 'PAID', 'PACKING', 'OUT_FOR_DELIVERY', 'SHIPPED', 'DELIVERED', 'CANCELLED',
]);                                                        // closed for writers; readers use openEnum (80.7)

const Instant = z.string().datetime({ offset: true });

export const EtaWindowSchema = z.object({ from: Instant, to: Instant })
  .refine((w) => Date.parse(w.from) <= Date.parse(w.to), 'from must not be after to');

export const TrackingStepSchema = z.object({ status: OrderStatusSchema, at: Instant });

export const OrderTrackingSchema = OrderSummarySchema.extend({
  status: OrderStatusSchema,
  etaWindow: EtaWindowSchema.nullable(),                   // null until dispatch has a window
  timeline: z.array(TrackingStepSchema).max(20),           // oldest first
  deliveryNote: z.string().max(200).nullable(),
  cancellable: z.boolean(),                                // computed by the server with canCancel() (83.2)
  noteEditable: z.boolean(),
});
export type OrderTracking = z.infer<typeof OrderTrackingSchema>;

export const UpdateDeliveryNoteSchema = z.object({
  note: z.string().trim().max(200).transform((s) => (s === '' ? null : s)),
  expectedVersion: z.number().int().nonnegative(),         // optimistic concurrency (Part 21.5)
});
export type UpdateDeliveryNote = z.infer<typeof UpdateDeliveryNoteSchema>;
```

The event schema of 72.8 grows by two **optional** fields. Adding optional fields to an event is backward compatible (Part 25.4): old clients' `z.object` parsers strip unknown keys, and the Pact message contract (74.10) keeps asserting the fields each consumer reads.

```ts
// packages/contracts/src/order-events.ts (78.8's schema, extended)
export const OrderEventSchema = z.object({
  orderId: z.string().uuid(),
  status: OrderStatusSchema,
  version: z.number().int().nonnegative(),                 // the orders.version column, as in OrderSummary
  updatedAt: z.string().datetime({ offset: true }),
  etaWindow: EtaWindowSchema.nullable().optional(),        // new: present when dispatch changed the window
  summary: z.string().max(160).optional(),                 // new: human text for the live region (83.10)
});
export type OrderEvent = z.infer<typeof OrderEventSchema>;
```

What the wire looks like for one status change on the stream:

```text
id: 1730813127412-0
event: order
data: {"orderId":"1d6c0b6e-2f3a-4c55-9d1e-8a7b6c5d4e3f","status":"OUT_FOR_DELIVERY","version":7,
data:  "updatedAt":"2026-11-05T13:45:27.402Z","etaWindow":{"from":"2026-11-05T13:55:00Z","to":"2026-11-05T14:10:00Z"},
data:  "summary":"Out for delivery. Arriving 7:25 to 7:40 pm."}

```

(SSE allows a payload over several `data:` lines; the browser joins them with newlines before `JSON.parse`, which accepts the whitespace. In practice NestJS writes one line.) The `id` is the Redis Stream entry ID, which is what `Last-Event-ID` sends back on reconnect (72.8).

#### React / Next.js example

The web side reads the contract through the tolerant readers of 74.7, so a status this build does not know never crashes the page:

```ts
// apps/web/src/orders/tracking.read.ts
import { OrderTrackingSchema, OrderEventSchema, OrderStatusSchema } from '@shop/contracts';
import { openEnum } from '@/wire/decode';                       // 80.7: unknown values -> 'UNKNOWN', reported once

const status = openEnum(OrderStatusSchema, 'OrderStatus');

export const OrderTrackingRead = OrderTrackingSchema.extend({
  status,
  timeline: OrderTrackingSchema.shape.timeline.element.extend({ status }).array().max(20),
});
export const OrderEventRead = OrderEventSchema.extend({ status });
export type OrderTrackingView = ReturnType<typeof OrderTrackingRead.parse>;
```

The labels live in one place, with a fallback:

```ts
// apps/web/src/orders/status-copy.ts
import type { OrderTrackingView } from './tracking.read';

export const STATUS_COPY: Record<OrderTrackingView['status'], { label: string; step: number }> = {
  PENDING: { label: 'Waiting for payment', step: 0 },
  PAID: { label: 'Order confirmed', step: 1 },
  PACKING: { label: 'Packing your order', step: 2 },
  OUT_FOR_DELIVERY: { label: 'Out for delivery', step: 3 },
  SHIPPED: { label: 'Shipped', step: 3 },
  DELIVERED: { label: 'Delivered', step: 4 },
  CANCELLED: { label: 'Cancelled', step: -1 },
  UNKNOWN: { label: 'Updated', step: -1 },                     // a status this build has never heard of
};
```

#### Backend side (NestJS)

The API validates writes with the shared schemas through `ZodValidationPipe` (74.3), maps entities to the read shape in one mapper (so `cancellable` and `noteEditable` are computed in exactly one place), and documents everything in the OpenAPI spec generated from the same schemas (74.2):

```ts
// apps/api/src/orders/tracking.mapper.ts
import { canCancel, type OrderTracking } from '@shop/contracts';
import type { OrderEntity } from './order.entity';
import type { OrderStatusEventEntity } from './order-status-event.entity';
import { toOrderSummary } from './order-summary.mapper';         // 80.7: minor units, ISO instants, store time zone

const NOTE_EDITABLE = new Set(['PENDING', 'PAID', 'PACKING']);

export function toOrderTracking(order: OrderEntity, events: OrderStatusEventEntity[]): OrderTracking {
  return {
    ...toOrderSummary(order),
    etaWindow: order.etaFrom && order.etaTo ? { from: order.etaFrom.toISOString(), to: order.etaTo.toISOString() } : null,
    timeline: events.slice(-20).map((e) => ({ status: e.status, at: e.occurredAt.toISOString() })),
    deliveryNote: order.deliveryNote,
    cancellable: canCancel(order.status),                       // the same rule the API enforces on POST /cancel
    noteEditable: NOTE_EDITABLE.has(order.status),
  };
}
```

The consumer-side Pact for the event (74.10's `MessageConsumerPact`), written by the web team and verified by the API's event builder:

```ts
// apps/web/src/orders/order-events.pact.test.ts  (@pact-foundation/pact 12)
import { MatchersV3, MessageConsumerPact, synchronousBodyHandler } from '@pact-foundation/pact';
import { it } from 'vitest';
import { OrderEventRead } from './tracking.read';

const { like, uuid, integer, regex } = MatchersV3;
const pact = new MessageConsumerPact({ consumer: 'web', provider: 'orders-events', dir: './pacts' });

it('handles an order status event as the tracking page does', () =>
  pact
    .given('order 1d6c moves to OUT_FOR_DELIVERY')
    .expectsToReceive('an order event with status, version and eta window')
    .withContent({
      orderId: uuid('1d6c0b6e-2f3a-4c55-9d1e-8a7b6c5d4e3f'),
      status: like('OUT_FOR_DELIVERY'),
      version: integer(7),
      updatedAt: regex('^\\d{4}-\\d{2}-\\d{2}T.*Z$', '2026-11-05T13:45:27.402Z'),
      etaWindow: { from: like('2026-11-05T13:55:00Z'), to: like('2026-11-05T14:10:00Z') },
      summary: like('Out for delivery. Arriving 7:25 to 7:40 pm.'),
    })
    .verify(synchronousBodyHandler((body) => { OrderEventRead.parse(body); })));   // the page's real parser
```

#### Production scenario

The contract pull request was 140 lines and took two days of review between the three teams. It changed twice: dispatch asked for `etaWindow` instead of a single `eta` (a window is honest about uncertainty, and dispatch already computed one), and support asked for `timeline` so agents and customers would see the same history. After it merged, the web team worked against MSW fixtures for nine days while the API was built; the first integration on staging found two bugs, both in the API's mapper, both caught by the Pact verification before anyone opened a browser.

#### Failure scenario

In an earlier project, the team added `OUT_FOR_DELIVERY` to the server's enum and started emitting it the same day, reasoning that "the web is deployed with the API". The Android app, two releases behind for 18 % of users, parsed statuses with a strict enum, threw on the unknown value, and showed a blank tracking screen for every order that went out for delivery that evening. The contract said nothing about rollout order. The rule from 74.9, clients with a fallback first, then the server emits, would have avoided it, and a Pact verification of `deployedOrReleased` mobile versions would have failed the API deploy.

#### Edge cases & failure modes

- **Events for orders the page has not loaded yet** (another tab placed a new order): the client ignores them for this page; the order list invalidates (72.8).
- **Events older than the page's server-rendered state**: the version guard drops them.
- **Payload growth**: keep events small; the page fetches full details on a `reset`, never through the stream.
- **Optional fields that become required**: never in place; a new event type or a versioned event name (Part 25.4).
- **Enum additions on the stream** follow the same client-first rule as REST responses.
- **`ETag` on a personal resource** must be `private`; a shared cache must never store it (76.9).

#### How a Senior Full-Stack Engineer thinks about this

The senior writes the contract before the code, in the shared package, reviewed by every team that touches it, and treats it as the feature's real specification. They reuse what exists (the per-customer stream, the summary schema, the error shape) rather than inventing a parallel channel, and they plan enum and field changes as rollouts with an order, not as edits. Their one-sentence explanation to a product manager: "We agree the exact shape of the data first, so the app, the website and the API can be built at the same time, and a robot checks they still agree before every deploy."

#### Common mistakes

- **A separate stream per order** when a per-customer stream already exists.
- **Shipping a new enum value from the server first.**
- **Computing `cancellable` in the client** from a status list that can drift from the server's rule.
- **Putting large or personal fields in events** that may be logged or replayed.

#### Interview questions

1. **Why reuse a per-customer SSE stream instead of one per order?** Expected answer: connections are the cost; one stream per tab serves the list and every order; replay already exists; client-side filtering is cheap because events are scoped to the customer.
2. **How do you add a new status value safely?** Expected answer: clients that tolerate unknown values ship first, verified by contract tests against deployed and released versions; then the server emits it.
3. **What belongs in an event payload?** Expected answer: identity, the new state's key fields, the version and timestamps, small optional extras; never large or sensitive data, which the client fetches.
4. **Where should `cancellable` be computed?** Expected answer: on the server, with the same rule the cancel endpoint enforces, exposed as a field.

#### Practical exercise

Write the contract pull request for your tracking feature.

Acceptance criteria:

- `OrderTrackingSchema`, the extended `OrderEventSchema` and the write schemas in `@shop/contracts`, with OpenAPI generated from them.
- MSW fixtures for tracking built through the schemas (77.6), including an order with an unknown status.
- A Pact message interaction for the event, verified by the API's event builder in CI.
- A written rollout order for the new statuses, naming the telemetry threshold that allows the server to emit them.
