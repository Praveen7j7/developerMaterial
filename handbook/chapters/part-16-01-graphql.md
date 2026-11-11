# Part 16 — GraphQL and gRPC

REST (Part 15) is the default API style in this book, and for good reason: it is simple, universal and predictable. But it is not the only style, and a senior engineer chooses the right one for each situation. This Part covers the two most important alternatives: **GraphQL**, a query language that lets clients ask for exactly the data they need in one request, and **gRPC**, a fast binary protocol for service-to-service communication. We teach what each is, how to build it in NestJS, its specific performance and security traps, and — most importantly — when each wins over REST.

The running scenario ties them together: an order service that exposes **REST publicly** (simple, cacheable, universal), **GraphQL for the mobile app** (one round trip for a screen's worth of nested data), and **gRPC internally** between services (fast, typed, efficient). That is a realistic architecture, and the point of the Part is the judgment to choose each, not dogma that one is best.

This Part builds on Part 15 — API Design (REST first), the REST-versus-GraphQL and REST-versus-gRPC decision trees in Part 64 — Architecture Decision Framework (64.3 and 64.4), Part 25 — Backward Compatibility, and the microservices material in Part 12 — Software Architecture. Part 64 tells you *which* style to pick in one page; this Part teaches you how each one actually works, how to build it in NestJS, and how it fails in production. NestJS supports all three styles with real modules (`@nestjs/graphql` with `@nestjs/apollo`, and `@nestjs/microservices` with the gRPC transport), which we use throughout.

## 16.1 GraphQL

### 16.1.1 What GraphQL is

#### Concept

**GraphQL** is a query language for APIs. Instead of many fixed endpoints each returning a fixed shape (as in REST), a GraphQL API exposes a single endpoint and a **schema** of available types and fields, and the client sends a **query** describing exactly which fields it wants, including nested related data, in one request. The server returns precisely that shape — no more, no less.

#### Why does it exist?

REST has two shape problems for rich clients. **Over-fetching**: an endpoint returns fields the client does not need, wasting bandwidth. **Under-fetching (the N+1 round trip problem)**: a client needs related data (an order, its items, each item's product) and must make several sequential REST calls to assemble one screen, which is slow, especially on mobile over a high-latency network. GraphQL solves both: the client asks for exactly the fields it needs, across relationships, in a single request. It exists because mobile and complex frontends needed to fetch tailored, nested data efficiently, and REST made that awkward.

#### Mental model

REST is a fixed-menu restaurant: each dish (endpoint) comes exactly as the kitchen prepares it, and if you want a bit from three dishes you order all three. GraphQL is a build-your-own plate: you describe on one order slip exactly what you want — "the order's total, its items' names, and each item's product image" — and the kitchen assembles that one plate. The schema is the list of ingredients available; the query is your order slip; the response is your custom plate.

#### How it works

A GraphQL API has three core operation types:

- **Query**: read data (like `GET`).
- **Mutation**: change data (like `POST`/`PUT`/`PATCH`/`DELETE`).
- **Subscription**: receive real-time updates over a persistent connection (like a WebSocket feed).

The schema defines types and their fields; **resolvers** are the server functions that fetch each field's data.

```graphql
# Schema (what the server offers)
type Order {
  id: ID!
  status: String!
  totalCents: Int!
  items: [OrderItem!]!        # nested relationship
}
type OrderItem {
  quantity: Int!
  product: Product!           # nested relationship
}
type Product { id: ID!, name: String!, imageUrl: String }

type Query { order(id: ID!): Order }
```

```graphql
# A client query: ask for exactly these fields, including nested ones, in ONE request.
query {
  order(id: "ord_1001") {
    status
    totalCents
    items {
      quantity
      product { name imageUrl }   # fetched in the same request
    }
  }
}
```

The response matches the query's shape exactly. The mobile app got everything for its order screen — the order, its items, each item's product name and image — in one round trip, fetching only the fields it asked for.

#### NestJS example

NestJS supports GraphQL two ways: **code-first** (you write TypeScript classes and decorators, and the schema is generated) and **schema-first** (you write the schema in GraphQL SDL and implement resolvers). Code-first is common in TypeScript projects because the types stay in sync with the code.

```ts
// order.model.ts -- code-first: decorators generate the GraphQL schema
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
export class Order {
  @Field(() => ID) id: string;
  @Field() status: string;
  @Field(() => Int) totalCents: number;
  @Field(() => [OrderItem]) items: OrderItem[];
}
```

```ts
// orders.resolver.ts -- resolvers fetch the data for each query/field
import { Resolver, Query, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { Order } from './order.model';
import { OrdersService } from './orders.service';

@Resolver(() => Order)
export class OrdersResolver {
  constructor(private readonly orders: OrdersService) {}

  @Query(() => Order, { nullable: true })
  order(@Args('id', { type: () => ID }) id: string) {
    return this.orders.findOne(id);              // resolves the top-level order
  }

  @ResolveField(() => [OrderItem])
  items(@Parent() order: Order) {
    return this.orders.itemsFor(order.id);       // resolves the nested items field
  }
}
```

The `@Query` resolver handles the top-level `order` query; the `@ResolveField` resolver handles the nested `items` field. This per-field resolution is GraphQL's power and also the source of its biggest trap (the N+1 problem, 16.1.2).

The module wiring is short. `@nestjs/graphql` is driver-agnostic; `@nestjs/apollo` supplies the Apollo Server driver most teams use.

```ts
// app.module.ts -- code-first GraphQL with the Apollo driver
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'), // generated SDL, commit it and diff it in review
      sortSchema: true,                                       // stable ordering keeps schema diffs readable
      playground: false,                                      // no IDE in production
      introspection: process.env.NODE_ENV !== 'production',   // hide the full schema from the internet
      context: ({ req }) => ({ req }),                        // per-request context (loaders are added in 61.1.2)
    }),
    OrdersModule,
  ],
})
export class AppModule {}
```

**Mutations** are resolvers that change state. Their arguments are `@InputType()` classes, and because NestJS runs pipes on resolver arguments, the same `class-validator` decorators you use on REST DTOs work here (with a global `ValidationPipe`).

```ts
// place-order.input.ts + mutation -- validated input, idempotency key, typed result
import { InputType, Field, ID, Int, Mutation, Args, Resolver } from '@nestjs/graphql';
import { IsUUID, Min, Max, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class OrderLineInput {
  @Field(() => ID) @IsUUID() productId: string;
  @Field(() => Int) @Min(1) @Max(100) quantity: number;
}

@InputType()
export class PlaceOrderInput {
  @Field(() => ID) @IsUUID() idempotencyKey: string;            // mobile retries on flaky networks
  @Field(() => [OrderLineInput]) @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => OrderLineInput)
  lines: OrderLineInput[];
}

@Resolver(() => Order)
export class OrderMutationsResolver {
  constructor(private readonly orders: OrdersService) {}

  @Mutation(() => Order)
  placeOrder(@Args('input') input: PlaceOrderInput) {
    return this.orders.place(input);  // same domain service the REST controller calls
  }
}
```

**Schema-first** inverts the flow: you write the SDL in `.graphql` files, NestJS can generate TypeScript types from it, and resolvers refer to types and fields by name. Teams choose it when the schema is a contract designed with frontend engineers before any code exists, or when several services in other languages share it.

```ts
// Schema-first: the SDL in src/orders/orders.graphql is the source of truth.
//   type Order { id: ID!  status: String!  totalCents: Int!  items: [OrderItem!]! }
//   type Query { order(id: ID!): Order }
GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  typePaths: ['./**/*.graphql'],                                  // load every .graphql file
  definitions: { path: join(process.cwd(), 'src/graphql.ts'), outputAs: 'class' }, // generated types
});

@Resolver('Order')                       // refers to the SDL type by name
export class OrdersSchemaFirstResolver {
  constructor(private readonly orders: OrdersService) {}

  @Query('order')
  order(@Args('id') id: string) { return this.orders.findOne(id); }

  @ResolveField('items')
  items(@Parent() order: { id: string }) { return this.orders.itemsFor(order.id); }
}
```

| | Code-first | Schema-first |
|---|---|---|
| Source of truth | TypeScript classes | `.graphql` SDL files |
| Type safety | Automatic (one definition) | Via generated `graphql.ts` |
| Contract review | Diff the generated `schema.gql` | Diff the SDL directly |
| Best when | One TypeScript team owns the API | Schema designed up front with clients, or shared across languages |
| Risk | Schema changes hide inside code changes | SDL and resolvers drift if generation is skipped |

**Subscriptions** (server-pushed updates such as "order status changed") are covered in their own section, 16.5, because running them across many pods is a different problem from queries.

#### Production scenario

A mobile app's order-detail screen needs the order, its items, each item's product name and image, and the shipping address. Over REST that was four sequential calls (order, items, products, address), about 400 ms of round trips on a mobile network. With GraphQL it is one query returning exactly those fields, about 120 ms. The app also stopped over-fetching the dozen order fields it did not display. For a data-rich mobile client over high latency, the single-round-trip, exact-shape fetch is a real, measurable improvement.

The server side of that win is not free. Each GraphQL request costs more CPU than the equivalent REST call (parsing, validation and per-field resolution add roughly 1–3 ms per request for typical queries in Apollo Server on Node.js), and the endpoint now needs query-cost limits, DataLoaders and its own caching strategy. At 900 requests per second from the mobile app, that is an extra one to two CPU cores across the fleet: cheap compared with 300 ms saved per screen for every user, but a cost you should name in the design review.

#### Failure scenario

At 19:40 on a sale evening, the orders database CPU went from 35% to 97% within ten minutes of a mobile release. Nothing on the server had been deployed. The new app version had added `customer { loyaltyTier }` to the order-history query, and the `customer` field resolver issued one SQL query per order. Each history page showed 50 orders, so every screen view went from 3 queries to 53. The REST endpoints, which nobody had touched, started timing out because they shared the same connection pool. The incident taught the team three things: in GraphQL the **client** can change the server's load profile without a server deploy; every field that loads related data needs a batching loader (16.1.2) before it ships; and per-operation metrics (queries per operation name, resolver time per field) are the only way to see which client query is hurting you.

#### Edge cases & failure modes

- **Client-driven load change**: a new client query uses existing fields in a new combination and multiplies server work without any server change. Track cost per operation name.
- **HTTP 200 with errors**: GraphQL usually returns 200 even when some fields failed; dashboards that count only HTTP 5xx miss real failures (16.4.2).
- **Nullable by default in code-first**: forgetting `nullable: true` on a field that can be missing turns one failed field into a null that bubbles up and wipes out the parent object.
- **Large list fields without limits**: `items` on an order is bounded; `orders` on a customer is not, and must be paginated (16.4.1).
- **Mutations executed serially**: several mutations in one request run one after another, so a client batching ten mutations in one request gets ten times the latency of one.
- **Schema drift in schema-first**: if type generation is not part of the build, resolvers and SDL disagree and the error appears only at runtime.

#### How a Senior Backend Engineer thinks about this

A senior sees GraphQL as the right tool when clients need flexible, nested, tailored data in few round trips — classically a mobile app or a complex frontend (a backend-for-frontend). They also see its costs clearly: the per-field resolver model makes the N+1 problem easy to introduce (16.1.2), caching is harder than REST (16.1.3), and the flexible query surface is an attack surface (a client can ask for an enormous nested query). They do not adopt GraphQL reflexively; they adopt it when the client's data-fetching pain justifies the added server complexity, and they keep REST for simple, public, cacheable APIs where its simplicity wins (16.3).

#### Common mistakes

- Adopting GraphQL for a simple public API where REST's simplicity and cacheability win.
- Ignoring the N+1 problem that the resolver model invites (16.1.2).
- Exposing an unbounded query surface with no depth/complexity limits (16.1.3).
- Treating GraphQL as "REST but better" rather than a different tool with different tradeoffs.

#### Interview questions

1. **What problems does GraphQL solve over REST?** Over-fetching (clients get only the fields they ask for) and under-fetching / multiple round trips (clients fetch nested related data in one request), which especially helps mobile and complex frontends.
2. **What are the three GraphQL operation types?** Query (read), Mutation (write), Subscription (real-time updates over a persistent connection).
3. **What is a resolver?** A server function that fetches the data for a field; GraphQL resolves fields individually, which is its power and the source of the N+1 problem.
4. **Code-first vs schema-first in NestJS?** Code-first writes TypeScript decorated classes and generates the schema (types stay in sync with code); schema-first writes the SDL and implements resolvers against it.
5. **A mobile release doubled database load with no server deploy. How is that possible, and how do you prevent it?** Expected answer: GraphQL lets the client choose fields, so a new query can combine existing fields in an expensive way (often an unbatched related-data resolver). Prevent with DataLoaders on every relation field, complexity limits, persisted queries reviewed before release, and per-operation metrics. Why it matters: it shows you understand that GraphQL moves control of server load to the client. Follow-up: how would you find the offending operation in under five minutes? (Operation-name labels on latency and DB-query metrics.)
6. **How do mutations differ from queries at execution time?** Top-level query fields may resolve in parallel; top-level mutation fields execute serially in order, so side effects are predictable. Follow-up: should a mutation be idempotent? Yes for anything a mobile client may retry; accept an idempotency key as in Part 15.
7. **How do you validate mutation input in NestJS GraphQL?** `@InputType()` classes with `class-validator` decorators and a global `ValidationPipe`, exactly like REST DTOs; GraphQL's own type system checks only types and nullability, not business rules such as "quantity between 1 and 100".

#### Practical exercise

Build a NestJS code-first GraphQL API for orders with an `order(id)` query that returns the order, its items, and each item's product, and write a single client query that fetches the whole order-detail screen's data in one request. Add a `placeOrder` mutation with a validated `PlaceOrderInput` and an idempotency key. Acceptance criteria: the response shape matches the query exactly; the query returns nested items and products in one round trip; a `quantity` of 0 is rejected with a validation error before any database call; sending the same idempotency key twice creates one order; the generated `schema.gql` is committed and changes show up in code review.

### 16.1.2 The N+1 problem and DataLoader batching

#### Concept

GraphQL's per-field resolution creates the **N+1 problem**: a query for a list of N orders, each needing its customer, triggers 1 query for the orders plus N queries for the customers — N+1 database queries for one GraphQL request. **DataLoader** solves this by batching: it collects all the individual customer-id lookups made during one request and issues a single batched query, turning N+1 into 2.

#### Why does it exist?

Because resolvers run per field per object, a naive `customer` resolver runs once for each order in a list, each issuing its own database query. For 100 orders that is 101 queries, which hammers the database and makes the request slow (the same N+1 problem that plagues ORMs, see Part 22 — ORM Engineering, section 22.9, now at the GraphQL layer). DataLoader exists to batch these per-request lookups into one query and to cache them within the request, so a field resolved many times does not hit the database many times.

#### Mental model

Imagine a mail room where each of 100 employees separately walks to the post office to pick up their one letter — 100 trips. DataLoader is the mail clerk who collects everyone's requests, makes one trip, and distributes the letters. It batches many small lookups made during a single request into one trip to the data source, and remembers results so the same lookup within that request is not repeated.

#### How it works

```ts
// A DataLoader batches customer-id lookups made during one GraphQL request.
import DataLoader from 'dataloader';

function createCustomerLoader(customers: CustomersService) {
  return new DataLoader<string, Customer | null>(async (ids: readonly string[]) => {
    // Called ONCE with all the ids collected during this tick -> one batched query.
    const rows = await customers.findManyByIds([...ids]);          // WHERE id = ANY($1)
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id) ?? null);                 // same order as ids; null if missing
  });
}
```

```ts
// In the resolver: use the loader instead of a direct per-order query.
@ResolveField(() => Customer)
customer(@Parent() order: Order, @Context() ctx: { customerLoader: DataLoader<string, Customer | null> }) {
  return ctx.customerLoader.load(order.customerId);   // batched + cached per request
}
```

Each `load(id)` call during the request is collected; DataLoader issues one `WHERE id = ANY(...)` query for all of them, so 100 orders produce 1 orders query plus 1 batched customers query — 2 total, not 101. Crucially, a DataLoader instance is created **per request** (not shared across requests), so its cache does not leak stale data between users; in NestJS you create the loaders in the GraphQL context for each request.

#### NestJS example

The cleanest NestJS pattern builds a fresh set of loaders inside the GraphQL `context` factory, which runs once per request. Avoid making the loader a `REQUEST`-scoped provider: request scope bubbles up the injection chain and makes every dependent provider be re-created per request, which costs real CPU at high RPS.

```ts
// loaders.factory.ts -- one factory, a NEW set of loaders per request
import { Injectable } from '@nestjs/common';
import DataLoader from 'dataloader';
import { CustomersService } from '../customers/customers.service';
import { ProductsService } from '../products/products.service';

export interface Loaders {
  customer: DataLoader<string, Customer | null>;
  product: DataLoader<string, Product | null>;
}

@Injectable()
export class LoadersFactory {
  constructor(private customers: CustomersService, private products: ProductsService) {}

  create(): Loaders {
    return {
      customer: new DataLoader(async (ids) => this.byId(await this.customers.findManyByIds([...ids]), ids)),
      product: new DataLoader(async (ids) => this.byId(await this.products.findManyByIds([...ids]), ids),
        { maxBatchSize: 500 }),                           // keep each IN-list a sane size
    };
  }

  private byId<T extends { id: string }>(rows: T[], ids: readonly string[]): (T | null)[] {
    const map = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => map.get(id) ?? null);
  }
}
```

```ts
// app.module.ts -- the context factory runs per request, so loaders never leak across users
GraphQLModule.forRootAsync<ApolloDriverConfig>({
  driver: ApolloDriver,
  imports: [LoadersModule],
  inject: [LoadersFactory],
  useFactory: (loaders: LoadersFactory) => ({
    autoSchemaFile: true,
    context: ({ req }) => ({ req, loaders: loaders.create() }),
  }),
});

// orders.resolver.ts
@ResolveField(() => Customer, { nullable: true })
customer(@Parent() order: Order, @Context('loaders') loaders: Loaders) {
  return loaders.customer.load(order.customerId);
}
```

#### PostgreSQL example

The batch function should produce one indexed query, not an `IN` list built by string concatenation. `= ANY($1)` with an array parameter keeps one prepared statement for any batch size.

```sql
-- What the customer loader sends for a page of 50 orders (37 distinct customers after de-duplication)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, loyalty_tier FROM customers WHERE id = ANY($1::uuid[]);
```

```text
Index Scan using customers_pkey on customers  (cost=0.43..152.10 rows=37 width=48) (actual time=0.031..0.142 rows=37 loops=1)
  Index Cond: (id = ANY ('{3f2a...,9c01...}'::uuid[]))
  Buffers: shared hit=111
Planning Time: 0.09 ms
Execution Time: 0.17 ms
```

One index scan, 0.17 ms. The unbatched version is 50 separate queries of about 0.1 ms each in the database, but each also pays a network round trip and a pool checkout (often 0.5–1 ms in total), so the real cost is 25–50 ms of wall time and 50 pool checkouts per page instead of one. Notice that DataLoader also **de-duplicated**: 50 orders referenced only 37 distinct customers.

#### TypeORM example

```ts
// customers.service.ts -- the batch query behind the loader
import { In, Repository } from 'typeorm';

async findManyByIds(ids: string[]): Promise<Customer[]> {
  if (ids.length === 0) return [];
  return this.repo.find({
    where: { id: In(ids) },                 // TypeORM renders WHERE id IN (...) with bound parameters
    select: { id: true, name: true, loyaltyTier: true },
  });
}
```

`In()` produces one bound parameter per id. That is fine up to a few hundred ids; for bigger batches, use `createQueryBuilder().where('c.id = ANY(:ids)', { ids })` so the statement shape does not change with batch size, and cap the batch with `maxBatchSize`.

#### Production scenario

A GraphQL query for a list of 50 orders with their customers and item products ran 50 + 50 + 150 = 250 database queries without batching, taking 600 ms and loading the database heavily. With DataLoader on the customer and product fields, it dropped to a handful of batched queries and about 40 ms. On a busy endpoint, that is the difference between the database comfortably serving the traffic and the database falling over, and it is a one-time implementation of per-field loaders.

#### Failure scenario

A team added DataLoader everywhere and still saw p99 jump from 120 ms to 900 ms after a release. The new `product` loader was created in a module-level constant "to save allocations", so it was shared by every request in the process. Two things went wrong. First, its cache never expired, so products that merchandisers had repriced kept showing the old price for hours, until the pod restarted. Second, because one loader served all requests, a single batch could hold ids from hundreds of concurrent requests; one batch hit 6,000 ids, the `IN` list query took 700 ms, and every request waiting on that batch waited 700 ms. The fix was a per-request loader built in the context factory plus `maxBatchSize: 500`. The lesson: DataLoader is a per-request batching and memoization tool, not a cache. Cross-request caching belongs in Redis with explicit TTLs and invalidation (see Part 27 — Caching and Redis).

#### Edge cases & failure modes

- **No batching**: the default N+1 explosion; a list query can issue hundreds of database queries and overload the database.
- **Sharing a DataLoader across requests**: its per-request cache leaks one user's data into another's request; always create loaders per request.
- **Loader returns wrong order**: the batch function must return results in the same order as the input ids (or map by id), or fields get mismatched data.
- **Batching hides, not fixes, a huge query**: a deeply nested query can still fetch a vast amount; combine batching with depth/complexity limits (16.1.3).
- **Caching stale within a long request**: for mutations within a request, you may need to clear the loader cache.

#### How a Senior Backend Engineer thinks about this

A senior treats the N+1 problem as the default risk of GraphQL, not an edge case, and puts DataLoader (or an equivalent batching layer) on every field that fetches related data, created per request. They verify with query logs or `EXPLAIN` that a list query issues a handful of batched queries, not hundreds, because the resolver model makes it trivially easy to ship an N+1 explosion that passes functional tests and then overloads the database under load. They know batching improves efficiency but does not bound the total work, so they pair it with depth and complexity limits so a client cannot request an enormous nested result (16.1.3).

#### Common mistakes

- No DataLoader, causing N+1 query explosions that overload the database.
- Sharing a DataLoader across requests, leaking data between users.
- Returning batch results in the wrong order, mismatching data to objects.
- Assuming batching alone makes GraphQL safe without query limits.

#### Interview questions

1. **What is the N+1 problem in GraphQL and why does it arise?** A query for N objects each needing related data triggers 1 + N queries, because resolvers run per field per object; it is GraphQL's default performance trap.
2. **How does DataLoader solve it?** It batches the per-field lookups made during one request into a single query and caches them within the request, turning N+1 into roughly 2.
3. **Why must a DataLoader be created per request?** Its cache is request-scoped; sharing it across requests would leak one user's data into another's request and serve stale data.
4. **Does batching bound the total work a query does?** No — it reduces query count but a deeply nested query can still fetch a huge amount; you also need depth and complexity limits.
5. **Where do you create DataLoaders in NestJS and why not as a request-scoped provider?** In the GraphQL context factory, once per request. Request-scoped providers make every provider that depends on them request-scoped too, so a large part of the dependency graph is re-instantiated per request, which costs CPU and latency at high RPS.
6. **Your loader returns the right rows but some orders show the wrong customer. What happened?** The batch function returned rows in database order instead of input-key order. DataLoader matches results to keys by position; always map by id and return `null` or an `Error` for missing keys.
7. **How does DataLoader batch calls that come from different resolvers?** It collects every `load()` called in the same tick of the event loop, then runs the batch function once on the next tick (via `process.nextTick` scheduling by default). Follow-up: what defeats batching? Awaiting each `load()` one by one in a loop instead of `loadMany()` or `Promise.all`.

#### Practical exercise

Add a `customer` field to the orders GraphQL API that, without batching, causes N+1 queries for a list of orders, confirm the explosion in the query log, then add a per-request DataLoader and confirm the query count drops to a handful. Acceptance criteria: a list query for 50 orders issues a constant small number of database queries regardless of list size, and loaders are created per request.
