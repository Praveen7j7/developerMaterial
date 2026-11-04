# Part 61 — GraphQL and gRPC

REST (Part 8) is the default API style in this book, and for good reason: it is simple, universal and predictable. But it is not the only style, and a senior engineer chooses the right one for each situation. This Part covers the two most important alternatives: **GraphQL**, a query language that lets clients ask for exactly the data they need in one request, and **gRPC**, a fast binary protocol for service-to-service communication. We teach what each is, how to build it in NestJS, its specific performance and security traps, and — most importantly — when each wins over REST.

The running scenario ties them together: an order service that exposes **REST publicly** (simple, cacheable, universal), **GraphQL for the mobile app** (one round trip for a screen's worth of nested data), and **gRPC internally** between services (fast, typed, efficient). That is a realistic architecture, and the point of the Part is the judgment to choose each, not dogma that one is best.

This Part builds on REST (Part 8), API style decisions (Part 49), schema compatibility (Part 32), and microservices communication (Part 5). NestJS supports all three styles with real modules, which we use.

## 61.1 GraphQL

### 61.1.1 What GraphQL is

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

The `@Query` resolver handles the top-level `order` query; the `@ResolveField` resolver handles the nested `items` field. This per-field resolution is GraphQL's power and also the source of its biggest trap (the N+1 problem, 61.1.2).

#### Production scenario

A mobile app's order-detail screen needs the order, its items, each item's product name and image, and the shipping address. Over REST that was four sequential calls (order, items, products, address), about 400 ms of round trips on a mobile network. With GraphQL it is one query returning exactly those fields, about 120 ms. The app also stopped over-fetching the dozen order fields it did not display. For a data-rich mobile client over high latency, the single-round-trip, exact-shape fetch is a real, measurable improvement.

#### How a Senior Backend Engineer thinks about this

A senior sees GraphQL as the right tool when clients need flexible, nested, tailored data in few round trips — classically a mobile app or a complex frontend (a backend-for-frontend). They also see its costs clearly: the per-field resolver model makes the N+1 problem easy to introduce (61.1.2), caching is harder than REST (61.1.3), and the flexible query surface is an attack surface (a client can ask for an enormous nested query). They do not adopt GraphQL reflexively; they adopt it when the client's data-fetching pain justifies the added server complexity, and they keep REST for simple, public, cacheable APIs where its simplicity wins (61.3).

#### Common mistakes

- Adopting GraphQL for a simple public API where REST's simplicity and cacheability win.
- Ignoring the N+1 problem that the resolver model invites (61.1.2).
- Exposing an unbounded query surface with no depth/complexity limits (61.1.3).
- Treating GraphQL as "REST but better" rather than a different tool with different tradeoffs.

#### Interview questions

1. **What problems does GraphQL solve over REST?** Over-fetching (clients get only the fields they ask for) and under-fetching / multiple round trips (clients fetch nested related data in one request), which especially helps mobile and complex frontends.
2. **What are the three GraphQL operation types?** Query (read), Mutation (write), Subscription (real-time updates over a persistent connection).
3. **What is a resolver?** A server function that fetches the data for a field; GraphQL resolves fields individually, which is its power and the source of the N+1 problem.
4. **Code-first vs schema-first in NestJS?** Code-first writes TypeScript decorated classes and generates the schema (types stay in sync with code); schema-first writes the SDL and implements resolvers against it.

#### Practical exercise

Build a NestJS code-first GraphQL API for orders with an `order(id)` query that returns the order, its items, and each item's product, and write a single client query that fetches the whole order-detail screen's data in one request. Acceptance criteria: the response shape matches the query exactly, and the query returns nested items and products in one round trip.

### 61.1.2 The N+1 problem and DataLoader batching

#### Concept

GraphQL's per-field resolution creates the **N+1 problem**: a query for a list of N orders, each needing its customer, triggers 1 query for the orders plus N queries for the customers — N+1 database queries for one GraphQL request. **DataLoader** solves this by batching: it collects all the individual customer-id lookups made during one request and issues a single batched query, turning N+1 into 2.

#### Why does it exist?

Because resolvers run per field per object, a naive `customer` resolver runs once for each order in a list, each issuing its own database query. For 100 orders that is 101 queries, which hammers the database and makes the request slow (the same N+1 problem that plagues ORMs, Part 15, now at the GraphQL layer). DataLoader exists to batch these per-request lookups into one query and to cache them within the request, so a field resolved many times does not hit the database many times.

#### Mental model

Imagine a mail room where each of 100 employees separately walks to the post office to pick up their one letter — 100 trips. DataLoader is the mail clerk who collects everyone's requests, makes one trip, and distributes the letters. It batches many small lookups made during a single request into one trip to the data source, and remembers results so the same lookup within that request is not repeated.

#### How it works

```ts
// A DataLoader batches customer-id lookups made during one GraphQL request.
import DataLoader from 'dataloader';

function createCustomerLoader(customers: CustomersService) {
  return new DataLoader<string, Customer>(async (ids: readonly string[]) => {
    // Called ONCE with all the ids collected during this tick -> one batched query.
    const rows = await customers.findManyByIds(ids as string[]);  // WHERE id = ANY($1)
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)!);                        // return in the same order
  });
}
```

```ts
// In the resolver: use the loader instead of a direct per-order query.
@ResolveField(() => Customer)
customer(@Parent() order: Order, @Context() ctx: { customerLoader: DataLoader<string, Customer> }) {
  return ctx.customerLoader.load(order.customerId);   // batched + cached per request
}
```

Each `load(id)` call during the request is collected; DataLoader issues one `WHERE id = ANY(...)` query for all of them, so 100 orders produce 1 orders query plus 1 batched customers query — 2 total, not 101. Crucially, a DataLoader instance is created **per request** (not shared across requests), so its cache does not leak stale data between users; in NestJS you create the loaders in the GraphQL context for each request.

#### Production scenario

A GraphQL query for a list of 50 orders with their customers and item products ran 50 + 50 + 150 = 250 database queries without batching, taking 600 ms and loading the database heavily. With DataLoader on the customer and product fields, it dropped to a handful of batched queries and about 40 ms. On a busy endpoint, that is the difference between the database comfortably serving the traffic and the database falling over, and it is a one-time implementation of per-field loaders.

#### Edge cases & failure modes

- **No batching**: the default N+1 explosion; a list query can issue hundreds of database queries and overload the database.
- **Sharing a DataLoader across requests**: its per-request cache leaks one user's data into another's request; always create loaders per request.
- **Loader returns wrong order**: the batch function must return results in the same order as the input ids (or map by id), or fields get mismatched data.
- **Batching hides, not fixes, a huge query**: a deeply nested query can still fetch a vast amount; combine batching with depth/complexity limits (61.1.3).
- **Caching stale within a long request**: for mutations within a request, you may need to clear the loader cache.

#### How a Senior Backend Engineer thinks about this

A senior treats the N+1 problem as the default risk of GraphQL, not an edge case, and puts DataLoader (or an equivalent batching layer) on every field that fetches related data, created per request. They verify with query logs or `EXPLAIN` that a list query issues a handful of batched queries, not hundreds, because the resolver model makes it trivially easy to ship an N+1 explosion that passes functional tests and then overloads the database under load. They know batching improves efficiency but does not bound the total work, so they pair it with depth and complexity limits so a client cannot request an enormous nested result (61.1.3).

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

#### Practical exercise

Add a `customer` field to the orders GraphQL API that, without batching, causes N+1 queries for a list of orders, confirm the explosion in the query log, then add a per-request DataLoader and confirm the query count drops to a handful. Acceptance criteria: a list query for 50 orders issues a constant small number of database queries regardless of list size, and loaders are created per request.
