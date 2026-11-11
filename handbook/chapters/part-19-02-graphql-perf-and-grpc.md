### 19.1.3 GraphQL performance, security and API evolution

#### Concept

GraphQL's flexibility — any client can ask for any shape — is also its risk. A malicious or careless client can send a deeply nested or hugely expensive query. Caching is harder than REST because every query can be different. And evolving the schema has its own rules (you add and deprecate rather than version). This section covers the guardrails and practices that make a GraphQL API safe and maintainable.

#### Why does it exist?

A REST endpoint does a bounded, known amount of work. A GraphQL query's cost depends on what the client asks for, so without limits a client can request `order -> items -> product -> relatedProducts -> ...` nested dozens of levels deep, or request thousands of objects, and make one request do enormous work — a denial-of-service by query. Caching, which REST gets largely for free via HTTP, is harder because the single endpoint receives varied `POST` queries. These guardrails and techniques exist to keep GraphQL's flexibility from becoming a liability.

#### How it works — security limits

| Risk | Defense |
|---|---|
| Deeply nested query | **Depth limit**: reject queries nested beyond N levels |
| Hugely expensive query | **Complexity limit**: assign each field a cost, cap the total per query |
| Many expensive queries (abuse) | **Rate limiting** by cost, not just request count |
| Arbitrary queries from untrusted clients | **Persisted queries**: only allow pre-registered query ids |
| Introspection revealing the whole schema | Disable introspection in production for non-public APIs |

```ts
// Depth limit: a GraphQL validation rule from the graphql-depth-limit package.
import depthLimit from 'graphql-depth-limit';

GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  autoSchemaFile: true,
  validationRules: [depthLimit(7)],   // rejected during validation, before any resolver runs
});
```

```ts
// complexity.plugin.ts -- cost limit with graphql-query-complexity, registered as an Apollo plugin
import { Plugin } from '@nestjs/apollo';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

const MAX_COST = 1_000;

@Plugin()
export class ComplexityPlugin implements ApolloServerPlugin {
  constructor(private readonly schemaHost: GraphQLSchemaHost) {}

  async requestDidStart(): Promise<GraphQLRequestListener<any>> {
    const { schema } = this.schemaHost;
    return {
      async didResolveOperation({ request, document }) {
        const cost = getComplexity({
          schema, query: document, operationName: request.operationName, variables: request.variables,
          estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
        });
        if (cost > MAX_COST) {
          throw new GraphQLError(`Query cost ${cost} exceeds ${MAX_COST}`, { extensions: { code: 'QUERY_TOO_COSTLY' } });
        }
      },
    };
  }
}

// Per-field costs live on the schema: a list costs its page size times its children.
// @Field(() => OrderConnection, { complexity: ({ args, childComplexity }) => (args.first ?? 20) * childComplexity })
```

Add `ComplexityPlugin` to the module's `providers` and Nest registers it with Apollo. A query for 20 orders, each with 10 items, each with a product, costs about 20 x (1 + 10 x 2) = 420 and passes; asking for `first: 100` orders with nested `customer { orders(first: 100) }` costs over a million and is rejected in under a millisecond, before a single SQL query runs.

**Persisted queries** are the strongest control for first-party clients: instead of the client sending an arbitrary query string, you pre-register the allowed queries (at build time) and the client sends only a query id. The server runs only known queries, which eliminates arbitrary expensive queries and shrinks the request size. For a public API where you cannot control clients, you rely on depth, complexity and cost-based rate limits instead.

Be careful with names. Apollo Server's built-in **automatic persisted queries (APQ)** are a bandwidth optimisation, not a security control: the client sends a SHA-256 hash, and if the server does not know it, the client re-sends the full query and the server stores it. Anyone can register any query that way. A **safelist** (also called trusted documents) is different: the mobile build extracts every operation into a manifest, CI uploads the hashes, and the server refuses anything not in the list.

```ts
// safelist.plugin.ts -- reject any operation whose hash is not in the build-time manifest
import { Plugin } from '@nestjs/apollo';
import { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { createHash } from 'crypto';
import manifest from './persisted-operations.json';   // { "<sha256>": "query OrderDetail { ... }", ... }

const allowed = new Set(Object.keys(manifest));

@Plugin()
export class SafelistPlugin implements ApolloServerPlugin {
  async requestDidStart(): Promise<GraphQLRequestListener<any>> {
    return {
      async didResolveSource({ source }) {
        const hash = createHash('sha256').update(source).digest('hex');
        if (!allowed.has(hash)) {
          throw new GraphQLError('Operation not in safelist', { extensions: { code: 'PERSISTED_QUERY_NOT_ALLOWED' } });
        }
      },
    };
  }
}
```

The operational catch: old app versions stay installed for months, so the manifest only ever grows, and removing an entry breaks every phone still running that version (see 28.5 in Part 28 — Backward Compatibility).

#### How it works — caching

REST caches naturally: a `GET /products/42` response can be cached by URL at the browser, CDN and server (Part 30). GraphQL is harder because requests are `POST`s with varied query bodies to one endpoint, so URL-based HTTP caching does not apply directly. The approaches:

- **Per-field / entity caching** on the server: cache the resolved data for an entity (a product by id) in Redis (Part 30), so resolvers hit the cache; DataLoader's per-request cache handles within-request reuse.
- **Persisted queries over GET**: a persisted query with a stable id can be sent as a `GET` and cached by a CDN like REST.
- **Client-side caching** (the GraphQL client libraries cache normalized entities), which reduces repeat requests.

The honest tradeoff: GraphQL gives clients flexibility at the cost of the easy HTTP caching REST enjoys, so you rebuild caching at the entity and client layers.

#### How it works — pagination, errors and evolution

- **Pagination** uses connections (the Relay cursor pattern): a list field returns `edges` with `cursor`s and a `pageInfo`, enabling stable cursor pagination (Part 18). Every list field is paginated, as in REST.
- **Errors**: GraphQL can return partial data plus an `errors` array (a query touching several fields can succeed for some and fail for others), which clients must handle; this differs from REST's single status code.
- **Evolution without versions**: GraphQL APIs evolve by **adding** fields and types (additive, non-breaking) and **deprecating** old fields (`@deprecated`) rather than minting `/v2`. Removing or changing a field is breaking, so you deprecate, monitor usage, and remove only when no client uses it — the same compatibility discipline as Part 28, applied field by field.

#### Federation and supergraphs

As an organization grows, one GraphQL schema can span many services. **Federation** lets each service own part of the graph (orders service owns `Order`, products service owns `Product`), and a gateway composes them into one **supergraph** the client queries as a single graph. This is powerful but adds operational complexity (the gateway, cross-service resolution, shared types), so it is for organizations with many teams and services where a single unified graph genuinely helps — not a starting point.

#### Edge cases & failure modes

- **Aliases multiply cost**: `a: order(id:1) { ... } b: order(id:2) { ... }` repeated 500 times is shallow but expensive; complexity analysis counts aliases, depth limits do not.
- **Batched requests**: some servers accept an array of operations in one HTTP request; one request becomes 1,000 operations. Disable batching or count each operation against the limit.
- **Introspection disabled but errors still leak**: "Did you mean `internalNotes`?" suggestions in validation errors reveal field names; mask them in production.
- **Field suggestions and stack traces**: set `includeStacktraceInErrorResponses: false` (Apollo Server 4) so internals never reach clients.
- **Cost estimates that ignore arguments**: a list field with `first: 10000` must cost more than `first: 10`; use argument-aware complexity functions and a hard maximum page size.
- **Rate limiting by request count**: one GraphQL request can cost 1 or 10,000; rate-limit by computed cost per client (a token bucket in Redis, Part 30).
- **CDN caching of POST**: CDNs do not cache POST; only persisted queries sent as GET with stable URLs are CDN-cacheable, and they must never be cached if the response depends on the user.

#### Failure scenario

A public GraphQL API had no depth or complexity limits. An attacker sent a query nesting `order -> customer -> orders -> customer -> orders ...` many levels deep, each level multiplying the work; one request consumed enormous CPU and database load, and a handful of such requests took the service down — a denial-of-service through a single crafted query. The fixes: a depth limit, a complexity limit with per-field costs, cost-based rate limiting, and persisted queries for the first-party clients so only known queries run. The lesson: GraphQL's open query surface must be bounded, or one request can do unbounded work.

#### How a Senior Backend Engineer thinks about this

A senior treats a GraphQL endpoint's open query surface as an attack surface and bounds it from day one: depth limits, complexity limits with per-field costs, cost-aware rate limiting, and persisted queries for first-party clients (disabling introspection on non-public APIs). They rebuild the caching that REST gave for free at the entity (Redis) and client layers, accepting that as the price of flexibility. They paginate every list with cursor connections, handle partial errors, and evolve the schema additively with deprecation and usage monitoring rather than versioning. They reach for federation only at the scale where many teams and services justify a gateway's complexity. Throughout, they keep REST for the simple, public, cacheable parts of the surface where its simplicity wins.

#### Common mistakes

- No depth/complexity limits, allowing denial-of-service by query.
- Allowing arbitrary queries from untrusted clients instead of persisted queries.
- Expecting REST-style HTTP caching to work and getting none.
- Unpaginated list fields; ignoring partial errors.
- Breaking the schema by removing/changing fields instead of deprecating.
- Reaching for federation before the scale justifies it.

#### Interview questions

1. **Why is a GraphQL endpoint a denial-of-service risk, and how do you defend it?** A client controls the query's cost; a deeply nested or huge query does unbounded work. Defend with depth limits, complexity limits with per-field costs, cost-based rate limiting, and persisted queries.
2. **Why is caching harder in GraphQL than REST, and what do you do?** Varied `POST` queries to one endpoint defeat URL-based HTTP caching; rebuild caching at the entity (Redis) and client layers, and use persisted queries over GET for CDN caching.
3. **How does a GraphQL API evolve without versioning?** Add fields/types (non-breaking) and deprecate old fields with `@deprecated`, monitor usage, and remove only when unused — the compatibility discipline of Part 28, field by field.
4. **What is federation and when is it appropriate?** Each service owns part of the graph, composed by a gateway into one supergraph; appropriate at organizational scale with many teams/services, not as a starting point.
5. **What are persisted queries and why use them?** Pre-registered allowed queries referenced by id; they eliminate arbitrary expensive queries from first-party clients and enable GET/CDN caching.

#### Practical exercise

Add guardrails to the orders GraphQL API: a depth limit, a complexity limit with per-field costs, and cursor-based pagination on the orders list. Then demonstrate that a deeply nested or oversized query is rejected before execution. Add entity caching in Redis for the product resolver. Acceptance criteria: an abusive deep query is rejected, lists are cursor-paginated, and repeated product fetches hit the Redis cache.

## 19.2 gRPC

### 19.2.1 Protobuf, services and streaming

#### Concept

**gRPC** is a high-performance framework for service-to-service communication. You define services and messages in a **protobuf** (Protocol Buffers) schema, and gRPC generates typed client and server code. It uses a compact binary format over HTTP/2, making it fast and efficient, with a typed contract shared by both sides. It is the common choice for internal communication between microservices.

#### Why does it exist?

Between internal services, REST over JSON is wasteful: JSON is verbose text to serialize and parse, there is no enforced contract (a field rename breaks the caller at runtime), and HTTP/1.1 allows only one in-flight request per connection, so concurrency means opening and pooling many connections. gRPC fixes all three: binary protobuf is compact and fast, the `.proto` schema is a strict typed contract both sides generate code from, and HTTP/2 multiplexes many calls over one connection and supports streaming. It exists because internal service-to-service traffic — high volume, trusted, performance-sensitive — benefits enormously from a fast, typed, efficient protocol that a public browser-facing API does not need.

#### Mental model

REST-over-JSON between services is like two departments mailing each other long typed letters in plain language, re-reading and interpreting each one. gRPC is like them sharing a strict pre-printed form (the protobuf schema) and exchanging compact filled-in forms over a dedicated fast line (HTTP/2). The shared form guarantees both sides agree on the fields; the compact format and fast line make exchanges quick; and the line can carry many forms at once and even a continuous stream.

#### How it works — the protobuf contract

```proto
// orders.proto -- the shared, typed contract both sides generate code from
syntax = "proto3";
package orders;

service OrderService {
  rpc GetOrder (GetOrderRequest) returns (Order);              // unary (one request, one response)
  rpc ListOrders (ListOrdersRequest) returns (stream Order);  // server streaming
}

message GetOrderRequest { string id = 1; }                    // field numbers matter (see evolution)
message Order {
  string id = 1;
  string status = 2;
  int32 total_cents = 3;
  repeated OrderItem items = 4;
}
message OrderItem { string product_id = 1; int32 quantity = 2; }
message ListOrdersRequest { string user_id = 1; int32 limit = 2; }
```

The **field numbers** (`= 1`, `= 2`) are how protobuf identifies fields on the wire — not the names. This is central to schema evolution (19.2.2). gRPC supports four call types: **unary** (one request, one response, like a normal function call), **server streaming** (one request, a stream of responses), **client streaming** (a stream of requests, one response), and **bidirectional streaming** (both stream). Streaming over the persistent HTTP/2 connection is efficient for large result sets or continuous data.

#### NestJS example

NestJS has a gRPC microservice transport.

```ts
// orders.grpc.controller.ts -- implement the service defined in the .proto
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';

@Controller()
export class OrdersGrpcController {
  constructor(private readonly orders: OrdersService) {}

  @GrpcMethod('OrderService', 'GetOrder')     // maps to the rpc in the .proto
  async getOrder(data: { id: string }) {
    const order = await this.orders.findOne(data.id);
    return { id: order.id, status: order.status, totalCents: order.totalCents, items: order.items };
  }
}
```

```ts
// Calling the gRPC service from another NestJS service (the client side).
// ClientGrpc methods return RxJS Observables, so convert to a Promise for async/await.
import { firstValueFrom } from 'rxjs';

const order = await firstValueFrom(this.orderService.getOrder({ id: 'ord_1001' })); // typed, binary, HTTP/2
```

The full wiring (the microservice bootstrap, `ClientsModule`, `getService`, deadlines, metadata, streaming and error mapping) is in 19.7, and the generated client types come from the `.proto` with a code generator such as `ts-proto`.

#### Deadlines and status codes

Like any network call, a gRPC call needs a **deadline** (timeout) — gRPC has first-class deadline propagation, where a caller's deadline flows to downstream calls, so a chain of services all respect the original budget (excellent for preventing cascading slowness, see Part 34 — Reliability Engineering, 34.2 Timeouts). gRPC has its own **status codes** (not HTTP status codes): `OK`, `NOT_FOUND`, `INVALID_ARGUMENT`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`, `PERMISSION_DENIED`, etc. You map your errors to these, and clients decide retry behavior from them (`UNAVAILABLE` is retryable, `INVALID_ARGUMENT` is not), the same reasoning as HTTP status codes (see Part 18 — API Design, 18.4 Status codes).

#### Production scenario

An order service calls an inventory service and a pricing service on every order placement, thousands of times per second internally. Over REST/JSON this was measurable serialization overhead and a separate connection per call. Switching the internal calls to gRPC cut serialization cost and per-call latency, multiplexed the calls over persistent HTTP/2 connections, and gave a typed contract so a field change in the inventory schema was caught at build time in the generated code rather than breaking at runtime. Deadline propagation meant the order placement's overall timeout budget flowed to the downstream calls automatically. For high-volume internal traffic, gRPC's efficiency and typed contract paid off clearly.

#### Failure scenario

At 02:14 the on-call was paged: checkout p99 had gone from 180 ms to 30 seconds and the order service had 4,000 in-flight requests. The inventory service had a slow database migration running, and its `ReserveStock` RPC took 25 seconds instead of 8 ms. The order service called it with no deadline, so every checkout waited until the inventory service eventually answered. Node.js does not run out of threads, but it did run out of memory for pending requests and of database connections held open by the waiting transactions. The fix was a 250 ms deadline on `ReserveStock`, a circuit breaker around it (Part 34), and passing the remaining checkout budget down the chain so no downstream call could outlive its caller. gRPC has no default deadline: if you do not set one, a call can wait forever.

#### Edge cases & failure modes

- **No deadline**: gRPC calls default to no deadline; a slow dependency holds resources until it answers.
- **Message size limits**: grpc-js rejects messages over 4 MB by default (`RESOURCE_EXHAUSTED`); large lists should stream or paginate instead of raising the limit.
- **int64 in JavaScript**: protobuf `int64` does not fit in a JS number above 2^53; configure the loader with `longs: String` or use `int32`/strings for ids and money in minor units.
- **Default values are invisible**: in proto3 a scalar set to its default (0, "", false) is not sent, so "zero" and "not set" look the same unless you use `optional` or wrapper types.
- **Retrying non-idempotent RPCs**: retrying `PlaceOrder` on `UNAVAILABLE` can create two orders if the first request actually succeeded; pass an idempotency key in the message.
- **Binary debugging**: `curl` does not work; use `grpcurl` with server reflection (19.7) or the `.proto` file.

#### How a Senior Backend Engineer thinks about this

A senior reaches for gRPC for internal, high-volume, performance-sensitive, trusted service-to-service communication, where its binary efficiency, typed contract, HTTP/2 multiplexing, streaming and deadline propagation are real advantages. They do not use it for public, browser-facing APIs, because browsers cannot speak gRPC directly (needing gRPC-Web and a proxy), it is not human-readable for easy debugging, and REST/GraphQL serve external clients better (19.3). They set deadlines on every call (relying on propagation through the chain), map errors to the right gRPC status codes so retry behavior is correct, and treat the `.proto` as a shared contract evolved carefully (19.2.2). gRPC is an internal-plumbing tool in their mind, not a public-API tool.

#### Common mistakes

- Using gRPC for public browser-facing APIs where REST/GraphQL fit better.
- No deadlines, losing gRPC's cascading-timeout protection.
- Mapping all errors to one status code, breaking clients' retry logic.
- Treating the `.proto` casually and breaking the contract (19.2.2).

#### Interview questions

1. **What is gRPC and why use it between services?** A high-performance RPC framework using binary protobuf over HTTP/2 with a typed shared contract; it is efficient, strictly typed, multiplexed and supports streaming — ideal for high-volume internal service calls.
2. **What are the four gRPC call types?** Unary, server streaming, client streaming, bidirectional streaming.
3. **What is deadline propagation and why does it matter?** A caller's deadline flows to downstream calls so a chain respects the original time budget, preventing cascading slowness.
4. **Why not use gRPC for a public browser API?** Browsers cannot speak gRPC directly (need gRPC-Web + a proxy), the binary format is not human-readable, and REST/GraphQL serve external clients better.
5. **What happens to a gRPC call with no deadline when the server hangs?** It waits indefinitely, holding memory, sockets and often a database transaction on the caller. Expected answer: always set a deadline per call, sized to the caller's own remaining budget. Follow-up: which status code does the caller see when the deadline passes? `DEADLINE_EXCEEDED`, and the server-side handler should check `call.cancelled` or the deadline to stop wasted work.
6. **Which gRPC status codes are safe to retry automatically?** `UNAVAILABLE` (and sometimes `RESOURCE_EXHAUSTED` with backoff); never `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED` or `FAILED_PRECONDITION`. `DEADLINE_EXCEEDED` is retryable only for idempotent methods, because the server may have completed the work.

#### Practical exercise

Define an `OrderService` in a `.proto` with a unary `GetOrder` and a server-streaming `ListOrders`, implement it as a NestJS gRPC microservice, and call it from another NestJS service as a typed client with a deadline. Map a not-found to the `NOT_FOUND` status code. Acceptance criteria: the call is typed end to end from the generated code, the deadline is enforced, and a missing order returns `NOT_FOUND`.
