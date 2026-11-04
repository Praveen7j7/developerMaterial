# Part 62 — NoSQL Data Modelling

This book's default datastore is PostgreSQL, and that is a deliberate, defensible default: a relational database with transactions, constraints, joins and a mature ecosystem is the right choice for most backends most of the time. But "most" is not "all", and a senior engineer knows the honest cases where a different store fits better, and how to model data in it — because NoSQL databases are not "PostgreSQL without the annoying parts"; they are different tools with different data models that reward (and demand) a different way of thinking.

This Part covers the main NoSQL families and how to model for each: **document databases** (MongoDB), **key-value and wide-column at scale** (DynamoDB), **wide-column** (Cassandra), **time-series** (TimescaleDB), and **graph** (Neo4j concepts). It covers **polyglot persistence** (using more than one store and keeping them consistent), **migrating** between NoSQL and PostgreSQL in both directions, and a decision matrix across all of them. The running examples stay in the book's domain: orders, products, trips, metrics.

The honest throughline, consistent with the whole book: do not reach for NoSQL by default or by hype. Reach for it when a specific access pattern or scale requirement makes the relational model a poor fit, understanding what you give up (usually joins, transactions across entities, and flexible ad-hoc queries) for what you gain (usually horizontal scale, a particular access pattern, or a data shape that fits naturally). This Part builds on the SQL-vs-NoSQL decision (Part 49) and Redis (Part 16), going wider and deeper.

## 62.1 When PostgreSQL is not the right store

### 62.1.1 The honest cases for NoSQL

#### Concept

PostgreSQL is an excellent general-purpose database, but there are access patterns and scale points where a specialized store genuinely fits better. The honest cases are specific: extreme write scale beyond what one primary can handle, an access pattern that is always "fetch this one item by key" at massive volume, data whose natural shape is a self-contained document or a time series or a graph of relationships, or a need for a particular consistency/availability tradeoff PostgreSQL does not offer out of the box.

#### Why does it exist?

Relational databases make tradeoffs: strong consistency, rich queries and joins, and a single primary for writes. Those tradeoffs are perfect for transactional business data and awkward for some workloads — a global write-heavy system that must stay available during a network partition, a stream of billions of time-stamped metrics, a social graph where the interesting queries are "friends of friends". NoSQL databases exist because no single set of tradeoffs is right for every workload; each NoSQL family picks a different point on the tradeoff space to serve a specific shape of problem well.

#### Mental model

PostgreSQL is a superb all-purpose vehicle — comfortable, capable, handles almost any trip. But if you need to carry thousands of tons across an ocean you want a cargo ship, and if you need to reach a mountain peak you want a helicopter. They are not "better cars"; they are different vehicles for journeys the car is wrong for. NoSQL stores are those specialized vehicles: pick one only when your journey is the kind it is built for, and accept that it cannot do the everyday trips the car does so easily.

#### How it works — the honest triggers

```text
Consider a specialized store when:
  - Write scale exceeds one primary + sane sharding          -> wide-column (Cassandra), DynamoDB
  - Access is always "get item by key" at massive volume      -> key-value / DynamoDB
  - Data is naturally a self-contained document               -> document DB (MongoDB)
  - Data is high-volume time-stamped events                   -> time-series (TimescaleDB)
  - The query is the relationships ("friends of friends")     -> graph DB (Neo4j)
  - You need multi-region active-active writes                 -> DynamoDB global tables, Cassandra
  - You need sub-millisecond cache-like reads                  -> Redis (Part 16)

Stay with PostgreSQL when:
  - You need transactions across related entities
  - You need joins and flexible ad-hoc queries
  - Your scale fits one primary + read replicas + caching (most apps)
  - Data is relational (it usually is)
```

The key realization: most applications never cross these thresholds. A well-indexed PostgreSQL with read replicas (Part 14) and a cache (Part 16) handles very large workloads. The honest cases for NoSQL are real but less common than the hype suggests, and they are driven by a specific requirement, not a general preference.

#### What you give up

Moving to NoSQL almost always means giving up some of: cross-entity transactions (most NoSQL stores offer limited or single-item transactions), joins (you denormalize or query multiple times instead), flexible ad-hoc queries (NoSQL is modeled around known access patterns, so a new query pattern can require remodeling or a new index), and strong consistency (many offer eventual consistency for availability and scale). You gain horizontal write scale, a natural fit for a particular data shape, or a specific availability guarantee. The tradeoff must be worth it for your specific requirement.

#### How a Senior Backend Engineer thinks about this

A senior defaults to PostgreSQL and treats the decision to add or move to a NoSQL store as a significant architectural choice requiring a specific, measured justification (an ADR, Part 49), not a preference or a resume item. They ask: what exact requirement does PostgreSQL fail to meet — write scale past one primary, a specific access pattern at massive volume, a data shape that is genuinely non-relational? They are clear-eyed about what they give up (transactions, joins, query flexibility) and whether the application can tolerate it. They know that most applications never need NoSQL and that premature NoSQL adoption is a common, costly mistake — teams model orders in a document database, then discover they need a transaction across two documents, which the store makes painful. The anti-hype principle of the whole book applies: the simplest store that meets the requirement wins, and that is usually PostgreSQL.

#### Common mistakes

- Choosing NoSQL by default or for a resume, without a specific requirement.
- Underestimating how far PostgreSQL scales with replicas and caching.
- Not accounting for what you give up (transactions, joins, query flexibility).
- Picking a NoSQL store before understanding the access patterns it must serve.
- Modeling inherently relational, transactional data in a document store and then fighting the lack of cross-entity transactions.

#### Interview questions

1. **When is PostgreSQL not the right store?** When a specific requirement — extreme write scale past one primary, a key-only access pattern at massive volume, a naturally non-relational data shape (document, time series, graph), or multi-region active-active writes — exceeds what PostgreSQL plus replicas and caching provides.
2. **What do you typically give up when moving to NoSQL?** Cross-entity transactions, joins, flexible ad-hoc queries, and often strong consistency; you gain horizontal scale, a natural data-shape fit, or a specific availability guarantee.
3. **Why is premature NoSQL adoption a common mistake?** Most apps never cross the thresholds that justify it; teams lose transactions, joins and query flexibility they later need, for scale they do not have.
4. **How should the decision to adopt NoSQL be made?** As a deliberate architectural decision (ADR) justified by a specific, measured requirement PostgreSQL cannot meet, with the tradeoffs explicitly accepted.

#### Practical exercise

For three scenarios — a transactional order system at moderate scale, a global IoT system ingesting billions of sensor readings, and a social network whose key queries are relationship traversals — decide for each whether PostgreSQL or a specific NoSQL family fits, and justify with the specific requirement and the tradeoff accepted. Acceptance criteria: you keep the order system on PostgreSQL, choose appropriate specialized stores for the other two, and name what each gives up.

## 62.2 Document databases (MongoDB)

### 62.2.1 Document modelling, embedding vs referencing

#### Concept

A **document database** like MongoDB stores data as documents — JSON-like objects (BSON) — grouped into collections. Instead of rows across normalized tables joined at query time, a document can hold nested structure, so a related cluster of data lives in one document. The central modeling decision is **embedding** (nesting related data inside a document) versus **referencing** (storing a reference to another document, like a foreign key), and it is driven by how the data is accessed.

#### Why does it exist?

Some data is naturally a self-contained document that is read and written as a whole — a product with its variants and attributes, an event with its payload, a user profile with its settings. Storing and fetching that as one document avoids joins and matches the application's object shape directly. Document databases also have flexible schemas (documents in a collection need not be identical), which suits evolving or heterogeneous data. They exist for data whose natural unit is a document and whose access is document-at-a-time.

#### Mental model

A relational database is a set of filing cabinets where one entity's data is split across several drawers (tables) and you assemble it by pulling from each (joins). A document database is a set of folders where everything about one entity is in its own folder (document) — the order, its line items, its shipping details, all together — so you grab the whole folder at once. The modeling question is how much to put in each folder: embed related things in the folder (fast to read together, but the folder grows and duplicated data can drift), or keep separate folders with cross-references (no duplication, but you fetch several folders).

#### How it works — embedding vs referencing

The decision rests on access pattern, cardinality and update behavior:

| | Embed (nest inside the document) | Reference (store an id to another document) |
|---|---|---|
| Read together always | Yes — one read gets everything | No — multiple reads or a lookup |
| Relationship cardinality | One-to-few (an order's line items) | One-to-many/large or many-to-many |
| Updated independently | No (embedded data updates with the parent) | Yes (referenced doc updates on its own) |
| Duplication | Possible (same data embedded in many docs) | None (single source) |
| Document size | Grows with embedded data (size limits apply) | Stays bounded |

```text
Order document with EMBEDDED items (read the whole order at once):
{
  "_id": "ord_1001",
  "status": "paid",
  "totalCents": 4299,
  "items": [                          // embedded: fetched with the order, one read
    { "productId": "p1", "name": "Dental Mirror", "quantity": 2, "unitCents": 1000 },
    { "productId": "p2", "name": "Probe", "quantity": 1, "unitCents": 2299 }
  ],
  "shippingAddress": { "line1": "...", "city": "...", "postcode": "..." }  // embedded
}

Product REFERENCED from order items by productId (product updated independently):
{ "_id": "p1", "name": "Dental Mirror", "priceCents": 1000, "category": "tools" }
```

The rule of thumb: **embed** data that is read with its parent, has bounded size (one-to-few), and is owned by the parent (line items belong to the order). **Reference** data that is large, shared, or updated independently (the product catalog, which many orders reference and which changes on its own). Note the deliberate denormalization above: the order item embeds the product `name` and `unitCents` as they were at order time, which is correct (an order should record the price paid, not the current price) — a case where duplication is a feature, capturing a point-in-time snapshot.

#### NestJS example

NestJS integrates with MongoDB via Mongoose (`@nestjs/mongoose`).

```ts
// order.schema.ts -- Mongoose schema with an embedded sub-document
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
class OrderItem {
  @Prop({ required: true }) productId: string;
  @Prop({ required: true }) name: string;          // snapshot at order time (embed)
  @Prop({ required: true }) quantity: number;
  @Prop({ required: true }) unitCents: number;
}

@Schema({ timestamps: true })
export class Order {
  @Prop({ required: true, enum: ['pending', 'paid', 'cancelled'] })
  status: string;
  @Prop({ required: true }) totalCents: number;
  @Prop({ type: [OrderItem], default: [] }) items: OrderItem[];  // embedded array
}
export const OrderSchema = SchemaFactory.createForClass(Order);
```

```ts
// orders.service.ts -- one read returns the order with its embedded items
async findOne(id: string): Promise<Order> {
  const order = await this.orderModel.findById(id).lean();   // no join needed
  if (!order) throw new NotFoundException(`Order ${id} not found`);
  return order;
}
```

#### Indexes, transactions and the aggregation pipeline

- **Indexes**: document databases index fields (including fields inside embedded documents and arrays) to make queries fast, the same principle as PostgreSQL indexes (Part 12) — a query on an unindexed field scans the collection.
- **Transactions**: MongoDB supports multi-document transactions, but they are heavier and more limited than PostgreSQL's; the document model's intent is that a single document is the transactional unit (embedding related data means updating it together is a single-document, atomic operation). Needing frequent multi-document transactions is a sign the data might be relational and belong in PostgreSQL.
- **Aggregation pipeline**: MongoDB's way to do analytics-style transformations (grouping, filtering, computing) as a pipeline of stages, analogous to a SQL `GROUP BY`/aggregate query, for reports and summaries.

#### Production scenario

An event-logging feature stores each event as a self-contained document with its heterogeneous payload — different event types have different fields, which the flexible schema handles naturally. Events are written once and read individually or queried by indexed fields (type, timestamp, user). Because each event is a complete document read and written as a whole, with no cross-entity transactions needed, a document database fits well and the flexible schema avoids the wide, sparse table a relational model would require for many event types. This is a genuine fit, not a default choice.

#### Failure scenario

A team modeled orders and products in MongoDB, embedding nothing and referencing heavily, then built a feature that had to atomically decrement inventory and create an order across two documents. MongoDB's multi-document transactions worked but were heavier than expected, and the access pattern (frequent cross-document transactions and ad-hoc joins between orders, products and customers) was exactly what the relational model does best. The data was relational; it had been put in a document store by default. The eventual migration to PostgreSQL (62.6) restored transactions and joins. The lesson: a document database fits document-shaped, document-at-a-time data; relational, transactional data belongs in a relational database.

#### Edge cases & failure modes

- **Unbounded embedded arrays**: an order with a few items is fine; a document with an ever-growing embedded array hits the document size limit and gets slow; reference instead when the "many" is large.
- **Duplicated embedded data drifting**: embedding shared data that changes (the current product price) means updates must touch every copy; embed only snapshots or data owned by the parent.
- **Needing cross-document transactions frequently**: a sign the data is relational.
- **Ad-hoc queries the model was not designed for**: document models are tuned to known access patterns; a new query may need a new index or a remodel.
- **No schema validation**: flexible schema can let bad-shaped documents in; use schema validation to keep data consistent.

#### How a Senior Backend Engineer thinks about this

A senior models document data around access patterns: embed one-to-few, read-together, parent-owned data (and point-in-time snapshots) so it is fetched and updated as one atomic document, and reference large, shared, independently-updated data. They treat the single document as the transactional unit and read frequent multi-document transactions as a signal the data may be relational. They index the fields queries use (including inside embedded documents), use schema validation despite the flexible schema, and watch for unbounded embedded arrays. Above all they choose a document database for genuinely document-shaped data, not for relational data by default, because the lack of easy cross-entity transactions and joins punishes relational data put in the wrong store.

#### Common mistakes

- Putting relational, transactional data in a document store by default, then fighting for transactions and joins.
- Embedding large or shared, independently-updated data, causing size limits or drift.
- Unbounded embedded arrays hitting document size limits.
- No indexes on queried fields; no schema validation.
- Modeling without first knowing the access patterns.

#### Interview questions

1. **Embed vs reference — how do you decide?** Embed one-to-few, read-together, parent-owned data (and snapshots) so it is one atomic document; reference large, shared, or independently-updated data to avoid duplication and size limits.
2. **What is the transactional unit in a document database, and what does that imply?** The single document; embedding related data makes updating it atomic, and frequent multi-document transactions suggest the data is relational and belongs in PostgreSQL.
3. **When is a document database a genuine fit?** For document-shaped, document-at-a-time data with flexible or heterogeneous schema (events, profiles, self-contained entities), accessed as whole documents.
4. **Why is embedding a product's price in an order item sometimes correct?** It snapshots the price paid at order time, which is the correct business record; this is deliberate, useful denormalization, not accidental duplication.

#### Practical exercise

Model an order in MongoDB with embedded line items (snapshotting product name and price at order time) and a referenced customer, implement it with Mongoose in NestJS, index the fields you query, and add schema validation. Then identify an operation that would require a multi-document transaction and reason about whether this data is better suited to MongoDB or PostgreSQL. Acceptance criteria: reads fetch the whole order in one query, items snapshot price correctly, and you can justify the embed/reference choices and the store choice by access pattern.
