## 26.7 MongoDB in practice: indexes, transactions, aggregation and validation

26.2 decided *when* a document model fits and how to choose embedding versus referencing. This section is the day-two view: wiring MongoDB into NestJS properly, indexing it so queries do not scan, using transactions only where they belong, running reports with the aggregation pipeline, and putting a schema back on a "schemaless" store.

### 26.7.1 Connecting and indexing

#### Concept

A MongoDB query without a matching index performs a **collection scan** (`COLLSCAN`): it reads every document, exactly like a sequential scan in PostgreSQL (see Part 20 — Database Indexing). Indexes in MongoDB are B-trees over one or more fields, including fields inside embedded documents and arrays. The design rules are close to PostgreSQL's, with one memorable heuristic for compound indexes: **ESR — Equality, Sort, Range**.

#### Why does it exist?

Document stores are usually adopted for read-heavy, document-at-a-time access. That only stays fast if every common query is an index lookup. Teams that treat "flexible schema" as "no design needed" meet the collection scan at the first busy day.

#### Mental model

Imagine a library sorted by author, then title, then year. Asking "books by Rao, newest first" is instant: walk to Rao, read backwards. Asking "books from 2019 by Rao" is fast too. Asking "all books from 2019" means walking the whole library, because year is the last sort key. ESR is the rule for ordering the shelf: things you ask for exactly first, then the order you want results in, then the ranges.

#### How it works

1. The query planner looks for indexes whose prefix matches the query's equality fields.
2. If the index order also matches the `sort`, results stream in order (no in-memory `SORT` stage, which is capped at 100 MB of memory).
3. Range predicates (`$gte`, `$lt`, `$in` over many values) go last, because after a range the index order no longer helps sorting.
4. `explain('executionStats')` reports the winning plan and how many keys and documents were examined.

#### NestJS example

```ts
// app.module.ts -- connection from config; majority write and read concerns in the URI
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from './orders/order.schema';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // e.g. mongodb://.../shop?replicaSet=rs0&w=majority&readConcernLevel=majority
        uri: config.getOrThrow<string>('MONGO_URI'),
        maxPoolSize: 50,                  // per pod; 20 pods x 50 = 1,000 connections
        serverSelectionTimeoutMS: 5000,   // fail fast instead of hanging requests
        autoIndex: false,                 // build indexes in a migration, not on boot
      }),
    }),
    MongooseModule.forFeature([{ name: Order.name, schema: OrderSchema }]),
  ],
})
export class AppModule {}
```

```ts
// order.schema.ts (continued from 62.2) -- indexes declared next to the schema
OrderSchema.index({ customerId: 1, status: 1, createdAt: -1 });   // ESR: equality, equality, sort
OrderSchema.index(
  { createdAt: 1 },
  { partialFilterExpression: { status: 'pending' } },             // only pending orders are indexed
);
OrderSchema.index({ 'items.productId': 1 });                      // multikey index on an array field

// A separate collection for checkout sessions: documents expire automatically.
CheckoutSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });
```

```ts
// orders.service.ts -- the query the index was designed for, plus an explain in a test
@Injectable()
export class OrdersService {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>) {}

  recentForCustomer(customerId: string, status: string) {
    return this.orders
      .find({ customerId, status })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();                                   // plain objects, no hydration cost
  }

  explainRecent(customerId: string, status: string) {
    return this.orders.find({ customerId, status }).sort({ createdAt: -1 }).limit(20)
      .explain('executionStats');
  }
}
```

With `autoIndex: false`, indexes are created by a deploy step (`await this.orders.syncIndexes()` in a migration script, or `createIndexes` in mongosh), because building an index on a 50-million-document collection at application startup turns every deploy into a long index build.

#### Reading the explain output, and the PostgreSQL twin

The explain output reads much like `EXPLAIN ANALYZE`. Before the index:

```text
winningPlan: { stage: "SORT", inputStage: { stage: "COLLSCAN" } }
executionStats: { nReturned: 20, executionTimeMillis: 1840,
                  totalKeysExamined: 0, totalDocsExamined: 4210993 }
```

After the ESR index:

```text
winningPlan: { stage: "LIMIT", inputStage: { stage: "FETCH",
               inputStage: { stage: "IXSCAN", indexName: "customerId_1_status_1_createdAt_-1" } } }
executionStats: { nReturned: 20, executionTimeMillis: 1,
                  totalKeysExamined: 20, totalDocsExamined: 20 }
```

The healthy ratio is the same as in PostgreSQL: `totalDocsExamined` close to `nReturned`. The PostgreSQL twin is `CREATE INDEX ON orders (customer_id, status, created_at DESC);`, and the reasoning about column order is identical.

#### Failure scenario

At 11:20 on a sale day, writes to the `products` collection began failing with `BSONObjectTooLarge`. The product document embedded its reviews in an array, a reasonable choice when products had 20 reviews. The bestselling handpiece had 61,000 reviews and its document had reached the 16 MB document limit. Long before failing, it had been hurting: every product-page read fetched 14 MB, and every new review rewrote the whole document. p99 for the product page had crept from 40 ms to 900 ms over three months and nobody connected it to one document. The fix: move reviews to their own collection referenced by `productId`, indexed `{ productId: 1, createdAt: -1 }`, and keep only a summary (`reviewCount`, `avgRating`, the 3 latest reviews) embedded. The rule from 26.2 applies with a number attached: embed one-to-few, and "few" must have a hard upper bound.

#### Edge cases & failure modes

- **16 MB document limit** and growing arrays: cap embedded arrays (`$push` with `$slice`) or move them out.
- **Multikey index limits**: a compound index can include at most one array field.
- **Index build on a busy primary** consumes I/O; build off-peak and watch replication lag.
- **`$regex` without an anchored prefix** cannot use an index efficiently; use a text or search index.
- **Too many indexes**: every index slows every write; 5-8 per collection is plenty for most.
- **Connection pools**: `maxPoolSize` times pod count must stay under what the cluster tier allows.

#### How a Senior Backend Engineer thinks about this

A senior writes down the query shapes first, then designs compound indexes with ESR, verifies each with `explain('executionStats')`, and builds indexes in a deploy step rather than at boot. They put a hard number on every embedded array. They treat the document store with the same discipline as PostgreSQL: the store is schemaless, the application is not.

#### Common mistakes

- Relying on `autoIndex` in production, so deploys trigger index builds.
- Compound indexes in the wrong order (range before sort), producing an in-memory `SORT` stage.
- Embedding unbounded arrays.
- Never running `explain`, so a `COLLSCAN` ships unnoticed.

#### Interview questions

1. **What is the ESR rule?**
   - *Expected answer:* In a compound index put Equality fields first, then the Sort fields, then Range fields, so the index serves both filtering and ordering.
   - *Why it matters:* a wrong order forces an in-memory sort or scans far more keys.
   - *Follow-ups:* Where does `$in` go? How do you confirm the plan? What does `totalKeysExamined` versus `nReturned` tell you?
2. **Why turn off `autoIndex` in production?** Index builds at startup make deploys slow and unpredictable on large collections; indexes belong in a controlled migration.
3. **How would you find a missing index in MongoDB?** Profiler or slow query log, then `explain('executionStats')` looking for `COLLSCAN` and a high docs-examined to returned ratio.

#### Practical exercise

Load 1 million orders into a local replica set, run `recentForCustomer` with `explain('executionStats')` before and after creating the ESR index, then try the index with the fields in a different order. Acceptance criteria: the final plan is `IXSCAN` with no `SORT` stage and `totalDocsExamined` equals `nReturned`.

### 26.7.2 Transactions, write concern and read concern

#### Concept

In MongoDB a single-document write is always atomic. **Multi-document transactions** (on replica sets and sharded clusters) give all-or-nothing writes across documents and collections. **Write concern** says how many replicas must acknowledge a write; **read concern** says how durable the data you read must be.

#### Why does it exist?

Even well-modeled document data sometimes needs to change two documents together: an order and an inventory counter. Without a transaction, a crash between the two writes leaves them inconsistent. And with replication, a write acknowledged only by the primary can be lost when that primary fails over before replicating, which is why durable systems use `w: 'majority'`.

#### Mental model

Imagine signing a contract. Single-document atomicity is one signature on one page: it is either signed or not. A multi-document transaction is a notary collecting signatures on several pages and stamping them all at once. Write concern `majority` is filing copies in most branch offices before saying "done", so losing one office loses nothing.

#### How it works

1. The service starts a **session** and runs the callback inside `withTransaction`.
2. Every operation passes `{ session }`; MongoDB holds the changes in a snapshot.
3. On commit, all changes become visible at once. A thrown error aborts them.
4. `withTransaction` retries the whole callback on `TransientTransactionError` (for example a write conflict) and retries the commit on `UnknownTransactionCommitResult`, so the callback must be safe to re-run.
5. Transactions are limited to 60 seconds by default (`transactionLifetimeLimitSeconds`) and hold their changes in memory; keep them small.

#### NestJS example

```ts
// place-order.service.ts -- order and stock decrement atomically
import { Injectable, ConflictException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

@Injectable()
export class PlaceOrderService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Stock.name) private readonly stock: Model<Stock>,
  ) {}

  async place(dto: PlaceOrderDto): Promise<string> {
    const session = await this.connection.startSession();
    try {
      let orderId = '';
      await session.withTransaction(async () => {          // may run more than once: no side effects inside
        for (const item of dto.items) {
          const res = await this.stock.updateOne(
            { sku: item.sku, available: { $gte: item.quantity } },   // guard: never go negative
            { $inc: { available: -item.quantity } },
            { session },
          );
          if (res.modifiedCount === 0) throw new ConflictException(`Out of stock: ${item.sku}`);
        }
        const [order] = await this.orders.create(
          [{ customerId: dto.customerId, status: 'pending', items: dto.items, idempotencyKey: dto.idempotencyKey }],
          { session },                                    // create() needs the array form with a session
        );
        orderId = String(order._id);
      }, { writeConcern: { w: 'majority' }, readConcern: { level: 'snapshot' } });
      return orderId;
    } finally {
      await session.endSession();
    }
  }
}
```

Two details matter. The emails, Kafka messages and HTTP calls happen **after** the transaction commits (or via an outbox collection written inside it), because the callback may run twice. And a unique index on `idempotencyKey` turns a client retry into a duplicate-key error you can map to "return the existing order" (see Part 30 — Distributed Transactions: Sagas, Outbox, Inbox and Idempotency).

#### Production scenario

A marketplace places about 150 orders per second at peak with this transaction. p50 is 12 ms and p99 35 ms with a 3-node replica set in one region and `w: 'majority'`. Write conflicts on a hot SKU during a flash sale cause about 2% of transactions to retry inside `withTransaction`, invisible to users. The same flow in PostgreSQL would be one `BEGIN ... COMMIT` with `SELECT ... FOR UPDATE` (see Part 21 — Database Transactions and Concurrency Control); the cost is comparable at this scale. The design question is not "can MongoDB do transactions" (it can) but whether most writes need them. If they do, the data is probably relational.

#### Failure scenario

After a primary failover at 03:05, customers complained that orders confirmed on screen had vanished. The service used the driver default `w: 1` for years: the primary acknowledged 37 orders that had not reached a secondary, then crashed; the new primary never had them, and when the old primary rejoined its unreplicated writes were rolled back. The fix was `w=majority` in the connection string and `readConcernLevel=majority` for reads that drive decisions. Since MongoDB 5.0 the default write concern is `majority`, but older clusters and explicit `w: 1` overrides are still common. Check what yours actually uses.

#### Edge cases & failure modes

- **Standalone servers** do not support transactions; local development needs a single-node replica set.
- **Long transactions** abort at 60 seconds and pressure the cache; batch large jobs instead.
- **Reading from secondaries** (`readPreference: 'secondaryPreferred'`) returns stale data; never for read-your-own-write flows.
- **Side effects inside `withTransaction`** run once per retry.
- **Sharded transactions** across shards cost a two-phase commit; keep transactional data on one shard key where possible.

#### How a Senior Backend Engineer thinks about this

A senior makes the single document the default transactional unit, uses multi-document transactions for the few flows that need them, and treats "most writes need a transaction" as evidence for PostgreSQL. They insist on `w: 'majority'` for anything with money, keep side effects out of retried callbacks, and pair transactions with idempotency keys.

#### Common mistakes

- Using `w: 1` for business data.
- Calling external services inside `withTransaction`.
- Forgetting to pass `{ session }` to one operation, which then runs outside the transaction.
- Long-running transactions over thousands of documents.

#### Interview questions

1. **What happens to a write acknowledged with `w: 1` when the primary fails before replicating?** It is rolled back when the old primary rejoins; the client was told "success" for data that no longer exists. Use `w: 'majority'`.
2. **Why must a `withTransaction` callback be idempotent?** The driver retries it on transient errors, so any side effect inside it can happen twice.
3. **When would you choose a single-document atomic update over a transaction?** Whenever the data that must change together can live in one document: `findOneAndUpdate` with a guard is atomic, faster and cannot partially fail.

#### Practical exercise

Run a single-node replica set, implement `place()` above, and fire 200 concurrent orders for a SKU with 50 units. Acceptance criteria: exactly 50 orders succeed, stock ends at 0 (never negative), and a repeated request with the same idempotency key does not create a second order.

### 26.7.3 The aggregation pipeline and schema validation

#### Concept

The **aggregation pipeline** is MongoDB's query language for reports: a list of stages (`$match`, `$group`, `$sort`, `$lookup`, `$project`) that each transform the stream of documents, the way `WHERE`, `GROUP BY`, `ORDER BY` and `JOIN` do in SQL. **Schema validation** (`$jsonSchema`) makes the server reject documents that do not match a declared shape.

#### Why does it exist?

Reports need grouping and totals, not single documents. And a flexible schema without any validation lets one buggy deploy write `totalCents: "42.99"` as a string into millions of documents. Validation at the database is the last line of defence, independent of any one service's code.

#### Mental model

Imagine an assembly line: the first station throws away parts you do not need (`$match`), the next sorts parts into bins (`$group`), the next orders the bins (`$sort`). Put the filtering station first, or every later station handles the whole warehouse.

#### How it works

1. Put `$match` (and `$sort` on indexed fields) at the start, where it can use indexes.
2. `$unwind` turns one document with an array into one document per array element.
3. Each stage is limited to 100 MB of memory unless it may spill to disk (`allowDiskUse`, on by default since MongoDB 6.0).
4. `$lookup` is a left outer join to another collection; it is fine for small enrichment, slow as a general join.

#### NestJS example

```ts
// sales-report.service.ts -- top 10 products by revenue in a period
async topProducts(from: Date, to: Date) {
  return this.orders.aggregate<{ productId: string; name: string; units: number; revenueCents: number }>([
    { $match: { status: 'paid', createdAt: { $gte: from, $lt: to } } },   // uses an index on status+createdAt
    { $unwind: '$items' },
    { $group: {
        _id: '$items.productId',
        units: { $sum: '$items.quantity' },
        revenueCents: { $sum: { $multiply: ['$items.quantity', '$items.unitCents'] } },
    } },
    { $sort: { revenueCents: -1 } },
    { $limit: 10 },
    { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } }, // only 10 lookups
    { $unwind: '$product' },
    { $project: { _id: 0, productId: '$_id', name: '$product.name', units: 1, revenueCents: 1 } },
  ]);
}
```

```text
[ { productId: "p_88", name: "LED Curing Light", units: 1840, revenueCents: 91908000 },
  { productId: "p_12", name: "Ultrasonic Scaler", units: 702,  revenueCents: 63180000 }, ... ]
```

```ts
// migrations/2026-11-05-orders-validator.ts -- enforce the shape at the server
export async function up(connection: Connection) {
  await connection.db!.command({
    collMod: 'orders',
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['customerId', 'status', 'totalCents', 'items'],
      properties: {
        status: { enum: ['pending', 'paid', 'cancelled'] },
        totalCents: { bsonType: ['int', 'long'], minimum: 0 },
        items: { bsonType: 'array', maxItems: 200 },               // a hard bound on the embedded array
      },
    } },
    validationLevel: 'moderate',   // existing invalid docs can still be updated; new writes are checked
    validationAction: 'error',
  });
}
```

#### Production scenario

The monthly sales report over 9 million paid orders ran in 4.2 seconds once `$match` used a `{ status: 1, createdAt: 1 }` index, against 41 seconds when `$match` came after an `$unwind`. Reports run against a hidden analytics secondary so they never compete with checkout. At larger scale the same report moves to a warehouse fed by CDC (see Part 39 — Data Engineering for Backend Engineers).

#### Failure scenario

A release changed the price serializer and wrote `totalCents` as a decimal string for 6 hours: 310,000 orders. Revenue dashboards built with `$sum` silently ignored strings and under-reported the day by 18%. Finance found it two days later. The validator above would have rejected the first bad write with a clear error in the deploy's smoke test. After the cleanup the team added validators to every collection that carries money.

#### Edge cases & failure modes

- **`$match` late in the pipeline** cannot use indexes.
- **`$lookup` against large collections** behaves like a nested loop; denormalize or precompute.
- **`$sum` over mixed types** ignores non-numeric values silently.
- **`validationLevel: 'strict'`** on an old collection can block updates to legacy documents; start with `moderate`.

#### How a Senior Backend Engineer thinks about this

A senior uses the pipeline for operational reports, moves heavy analytics to a warehouse, puts filtering first, and validates every collection that matters at the server, because "schemaless" only moves the schema into every reader's assumptions.

#### Common mistakes

- Using `$lookup` as a general join and recreating a relational model badly.
- No server-side validation on money fields.
- Running heavy reports on the primary.

#### Interview questions

1. **How do you make an aggregation fast?** Filter and sort early on indexed fields, reduce documents before `$unwind` and `$lookup`, project only needed fields, and run heavy reports on a secondary or warehouse.
2. **Why add `$jsonSchema` validation to a schemaless database?** Application code changes and has bugs; the server-side validator protects every writer at once, especially for money and status fields.
3. **When does a growing number of `$lookup` stages suggest a different store?** When most reports need joins across many collections, the data is relational and PostgreSQL would serve it with less effort.

#### Practical exercise

Write the top-products report, measure it with `$match` first and last, then add the validator and try to insert an order with `totalCents: "10.00"`. Acceptance criteria: the first version is at least 5x faster on 1 million orders, and the invalid insert is rejected with a validation error.
