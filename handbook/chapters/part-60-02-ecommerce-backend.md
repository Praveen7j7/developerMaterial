## 60.2 Project 2 — E-commerce backend

### 60.2.1 Goal and what you will learn

You will build the backend of a real store as a **modular monolith**: one deployable, one database, but with module boundaries strict enough that Project 6 can later cut along them. Catalog, search, cart, inventory, orders, promotions, reviews and admin each live in their own module with their own tables, and they talk to each other through services and domain events, never by reaching into each other's tables.

This is the project where you stop writing CRUD and start writing systems. What you will learn:

- **Hierarchies in SQL** — a category tree queried with a recursive CTE, and why that beats both a `parent_id` loop in JavaScript and a "just store the full path" hack.
- **Search that is good enough** — PostgreSQL full-text search for words plus `pg_trgm` for typos, with ranking, before you reach for Elasticsearch. Most stores never need to.
- **Fast mutable state** — a cart in Redis for latency, persisted to PostgreSQL for durability, and the reconciliation rules when the two disagree.
- **Concurrency that costs money** — inventory reservations with atomic decrements. Overselling is the canonical "we lost the race" bug, and here you will fix it properly.
- **State machines** — orders with explicit legal transitions and an append-only `order_events` table, so "why is this order cancelled?" has an answer.
- **Pagination that survives page 400** — keyset pagination on every list endpoint, because `OFFSET 8000` is a scan.
- **Asynchronous work** — an outbox for domain events, BullMQ jobs for email and search reindexing.
- **Two ORMs in one codebase** — every module uses TypeORM except reviews, which uses Sequelize, so you can compare them honestly on the same schema, the same transactions and the same test suite.

### 60.2.2 Requirements

**Functional**

1. Catalog: categories in a tree of up to 6 levels; products with variants, prices in minor units, images, attributes as `jsonb`.
2. Browse a category including all descendants, with filters (price range, brand, in-stock) and sorting (relevance, price, newest).
3. Search products by free text with typo tolerance and prefix suggestions.
4. Cart: add, update quantity, remove, apply promotion, view totals; works for guests (cart token) and logged-in users; merge guest cart on login.
5. Inventory: per-variant `on_hand` and `reserved`; a reservation is created at checkout, held for 15 minutes, and released if the order is not paid.
6. Orders: created from a cart, follow a state machine, every transition appends to `order_events`.
7. Promotions: percentage and fixed-amount codes, minimum order value, per-user and global usage limits, validity window.
8. Reviews: one review per user per product, 1 to 5 stars, moderation queue, aggregate rating on the product.
9. Admin: create and update products, adjust stock, moderate reviews, list orders.
10. Every list endpoint uses keyset pagination and returns a `nextCursor`.
11. Domain events go through an outbox; email and search reindex run as background jobs.

**Non-functional**

| Property | Target | Consequence |
|---|---|---|
| Catalog size | 200,000 products, 600,000 variants, 4,000 categories | Category browse must not scan the product table |
| Traffic | 50,000 DAU, 800 req/s peak, 95 percent reads | Read caching pays; write path can stay simple |
| Product detail p99 | under 80 ms warm, under 250 ms cold | One cached read; no N+1 |
| Search p95 | under 150 ms for 200k products | GIN indexes, `websearch_to_tsquery`, limit 24 |
| Cart operations p99 | under 30 ms | Redis is the source of truth for the live cart |
| Checkout | 20 orders/s peak, 5 orders/s sustained | Reservation must not serialise the whole inventory table |
| Overselling | exactly zero | Atomic conditional update, not read-then-write |
| Reservation hold | 15 minutes, released within 60 s of expiry | A scheduled job with a bounded batch |
| List endpoints | p95 under 60 ms at any depth | Keyset pagination, never `OFFSET` |
| Availability | 99.9 percent | Single region, one database with a replica |

### 60.2.3 Architecture

```mermaid
flowchart TB
  cdn["CDN for images"] --> s3[("Object storage")]
  client["Web and mobile"] --> lb["Load balancer"]
  lb --> app["Modular monolith - NestJS"]
  app --> pg[("PostgreSQL")]
  app --> replica[("Read replica")]
  app --> redis[("Redis - cart, cache, locks")]
  app --> outbox["outbox table"]
  outbox --> relay["Outbox relay"]
  relay --> bull["BullMQ on Redis"]
  bull --> workers["Workers - email, reindex, reservation sweeper"]
  workers --> pg
  workers --> smtp["Email provider"]
```

```text
Modules inside the one process
+-----------+-----------+-----------+-----------+
|  catalog  |  search   |   cart    | inventory |
+-----------+-----------+-----------+-----------+
| promotions|  orders   |  reviews  |   admin   |
+-----------+-----------+-----------+-----------+
        shared: outbox, events, pagination, auth
```

The important design rule: **a module may import another module's service, never its entities or repositories.** `OrdersService` calls `InventoryService.reserve()`; it does not `SELECT` from `inventory`. Enforce it with an ESLint boundary rule (`eslint-plugin-boundaries` or a simple `no-restricted-imports` pattern per module). That single rule is what makes Project 6 possible: when you extract inventory into its own service, you replace one service call with one HTTP or Kafka call, and nothing else changes.

Reads that can tolerate 200 ms of lag (search, category browse, admin reports) go to the replica through a second TypeORM `DataSource`. Anything that reads its own write (cart totals after add-to-cart, order after create) goes to the primary. Get this wrong and you get the classic "I added an item and it disappeared" bug.

### 60.2.4 Database schema

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TABLE categories (
  id          bigserial PRIMARY KEY,
  parent_id   bigint REFERENCES categories(id) ON DELETE RESTRICT,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  position    int NOT NULL DEFAULT 0,
  depth       smallint NOT NULL DEFAULT 0,
  CONSTRAINT categories_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX categories_parent_idx ON categories (parent_id, position);

CREATE TABLE products (
  id           bigserial PRIMARY KEY,
  category_id  bigint NOT NULL REFERENCES categories(id),
  brand        text NOT NULL,
  slug         text NOT NULL UNIQUE,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  attributes   jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft',   -- draft | active | archived
  rating_avg   numeric(3,2) NOT NULL DEFAULT 0,
  rating_count int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  search_doc   tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
      setweight(to_tsvector('english', coalesce(brand,'')), 'B') ||
      setweight(to_tsvector('english', coalesce(description,'')), 'C')
  ) STORED
);
CREATE INDEX products_search_idx ON products USING GIN (search_doc);
CREATE INDEX products_title_trgm_idx ON products USING GIN (title gin_trgm_ops);
CREATE INDEX products_attributes_idx ON products USING GIN (attributes jsonb_path_ops);
-- Keyset pagination for "newest in category" and for the admin list.
CREATE INDEX products_category_keyset_idx
  ON products (category_id, created_at DESC, id DESC) WHERE status = 'active';

CREATE TABLE variants (
  id          bigserial PRIMARY KEY,
  product_id  bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku         text NOT NULL UNIQUE,
  options     jsonb NOT NULL DEFAULT '{}',      -- {"size":"M","color":"black"}
  price_cents int NOT NULL CHECK (price_cents >= 0),
  currency    char(3) NOT NULL DEFAULT 'EUR',
  active      boolean NOT NULL DEFAULT true
);
CREATE INDEX variants_product_idx ON variants (product_id) WHERE active;

CREATE TABLE inventory (
  variant_id  bigint PRIMARY KEY REFERENCES variants(id) ON DELETE CASCADE,
  on_hand     int NOT NULL CHECK (on_hand >= 0),
  reserved    int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version     int NOT NULL DEFAULT 0,
  CONSTRAINT inventory_reserved_le_on_hand CHECK (reserved <= on_hand)
);

CREATE TABLE inventory_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id  bigint NOT NULL REFERENCES variants(id),
  order_id    uuid,
  cart_id     uuid NOT NULL,
  quantity    int NOT NULL CHECK (quantity > 0),
  status      text NOT NULL DEFAULT 'held',     -- held | committed | released
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_expiry_idx ON inventory_reservations (expires_at)
  WHERE status = 'held';
CREATE UNIQUE INDEX reservations_cart_variant_idx
  ON inventory_reservations (cart_id, variant_id) WHERE status = 'held';

CREATE TABLE carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,
  status      text NOT NULL DEFAULT 'open',     -- open | ordered | abandoned
  currency    char(3) NOT NULL DEFAULT 'EUR',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX carts_one_open_per_user ON carts (user_id) WHERE status = 'open' AND user_id IS NOT NULL;

CREATE TABLE cart_items (
  cart_id     uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id  bigint NOT NULL REFERENCES variants(id),
  quantity    int NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_cents int NOT NULL,
  PRIMARY KEY (cart_id, variant_id)
);

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending_payment',
  currency      char(3) NOT NULL,
  subtotal_cents int NOT NULL,
  discount_cents int NOT NULL DEFAULT 0,
  total_cents   int NOT NULL,
  promotion_code text,
  placed_at     timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 0,
  CONSTRAINT orders_total_nonneg CHECK (total_cents >= 0)
);
CREATE INDEX orders_user_keyset_idx ON orders (user_id, placed_at DESC, id DESC);
CREATE INDEX orders_status_idx ON orders (status, placed_at) WHERE status IN ('pending_payment','paid');

CREATE TABLE order_items (
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id  bigint NOT NULL,
  sku         text NOT NULL,
  title_snapshot text NOT NULL,
  quantity    int NOT NULL CHECK (quantity > 0),
  unit_price_cents int NOT NULL,
  PRIMARY KEY (order_id, variant_id)
);

-- Append-only. No UPDATE, no DELETE grant for the app role.
CREATE TABLE order_events (
  id          bigserial,
  order_id    uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL,       -- 'customer:<id>' | 'system' | 'admin:<id>'
  reason      text,
  payload     jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE promotions (
  code         text PRIMARY KEY,
  kind         text NOT NULL,       -- percent | fixed
  value        int NOT NULL CHECK (value > 0),
  min_order_cents int NOT NULL DEFAULT 0,
  max_redemptions int,
  per_user_limit int NOT NULL DEFAULT 1,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  redeemed     int NOT NULL DEFAULT 0,
  CONSTRAINT promotions_window CHECK (ends_at > starts_at)
);

CREATE TABLE promotion_redemptions (
  code      text NOT NULL REFERENCES promotions(code),
  user_id   uuid NOT NULL,
  order_id  uuid NOT NULL,
  used_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, order_id)
);
CREATE INDEX promotion_redemptions_user_idx ON promotion_redemptions (code, user_id);

CREATE TABLE reviews (
  id          bigserial PRIMARY KEY,
  product_id  bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',  -- pending | published | rejected
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_one_per_user UNIQUE (product_id, user_id)
);
CREATE INDEX reviews_published_keyset_idx
  ON reviews (product_id, created_at DESC, id DESC) WHERE status = 'published';

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  aggregate     text NOT NULL,
  aggregate_id  text NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
```

```mermaid
erDiagram
  CATEGORIES ||--o{ CATEGORIES : parent_of
  CATEGORIES ||--o{ PRODUCTS : contains
  PRODUCTS ||--o{ VARIANTS : has
  VARIANTS ||--|| INVENTORY : stocked_as
  VARIANTS ||--o{ INVENTORY_RESERVATIONS : held_for
  CARTS ||--o{ CART_ITEMS : contains
  ORDERS ||--o{ ORDER_ITEMS : contains
  ORDERS ||--o{ ORDER_EVENTS : logs
  PRODUCTS ||--o{ REVIEWS : receives
  PROMOTIONS ||--o{ PROMOTION_REDEMPTIONS : redeemed_as
  PRODUCTS {
    bigint id PK
    bigint category_id FK
    text status
    tsvector search_doc
  }
  INVENTORY {
    bigint variant_id PK
    int on_hand
    int reserved
  }
```

### 60.2.5 APIs

| Method | Path | Auth | Request | Response | Codes | Idempotency |
|---|---|---|---|---|---|---|
| GET | `/categories/tree` | none | — | `200` nested tree | 200 | Yes, cached 300 s |
| GET | `/categories/:slug/products` | none | `?cursor&limit&minPrice&maxPrice&brand&sort` | `200 {items,nextCursor}` | 200, 404 | Yes |
| GET | `/products/:slug` | none | — | `200` product with variants and stock | 200, 404 | Yes |
| GET | `/search` | none | `?q&cursor&limit&filters` | `200 {items,nextCursor,took}` | 200, 422 bad query | Yes |
| GET | `/search/suggest` | none | `?q` | `200 [{text,productId}]` | 200 | Yes |
| POST | `/cart/items` | optional | `{variantId,quantity}` | `200` cart snapshot | 200, 404, 409 out of stock | No; use `PUT` for absolute quantity |
| PUT | `/cart/items/:variantId` | optional | `{quantity}` | `200` cart | 200, 404, 409 | Yes; sets absolute quantity |
| DELETE | `/cart/items/:variantId` | optional | — | `200` cart | 200 | Yes |
| POST | `/cart/promotion` | optional | `{code}` | `200` cart with discount | 200, 404, 409 not eligible | Yes |
| POST | `/cart/merge` | required | `{guestCartId}` | `200` cart | 200, 404 | Yes |
| POST | `/orders` | required | `{cartId,addressId}` + `Idempotency-Key` | `201 {orderId,status}` | 201, 409 stock, 409 cart empty, 422 | Yes via `Idempotency-Key` |
| GET | `/orders` | required | `?cursor&limit` | `200 {items,nextCursor}` | 200 | Yes |
| GET | `/orders/:id` | required | — | `200` order with events | 200, 403, 404 | Yes |
| POST | `/orders/:id/cancel` | required | `{reason}` | `200` order | 200, 409 illegal transition | Yes; cancelling a cancelled order returns 200 |
| POST | `/products/:id/reviews` | required | `{rating,body}` | `201` | 201, 409 already reviewed | Yes; second call returns 409 |
| GET | `/products/:id/reviews` | none | `?cursor&limit` | `200 {items,nextCursor}` | 200 | Yes |
| POST | `/admin/products` | admin | product body | `201` | 201, 422 | No |
| PATCH | `/admin/inventory/:variantId` | admin | `{onHandDelta,reason}` | `200` | 200, 409 would go negative | No; deltas are not idempotent, so require `Idempotency-Key` |
| POST | `/admin/reviews/:id/moderate` | admin | `{decision}` | `200` | 200, 409 | Yes |

Keyset cursors are opaque base64 of the sort tuple, for example `{"createdAt":"2026-09-01T10:00:00Z","id":81234}`, and the query is `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3`. Always include the primary key as the tiebreaker, or two products created in the same millisecond will make a row appear on two pages or on none.

### 60.2.6 NestJS modules

```text
src/
  app.module.ts
  shared/  pagination/ keyset.ts   events/ domain-event.ts   outbox/
  catalog/    catalog.module.ts  category.repository.ts  product.service.ts
  search/     search.module.ts   product-search.service.ts
  cart/       cart.module.ts     cart.service.ts  cart-redis.repository.ts
  inventory/  inventory.module.ts inventory.service.ts  reservation.sweeper.ts
  orders/     orders.module.ts   orders.service.ts  order-state-machine.ts
  promotions/ promotions.module.ts
  reviews/    reviews.module.ts  review.model.ts (Sequelize)  reviews.service.ts
  admin/      admin.module.ts
  jobs/       jobs.module.ts     email.processor.ts  reindex.processor.ts
```

```text
AppModule
 ├─ TypeOrmModule.forRoot        (name: 'default', primary)
 ├─ TypeOrmModule.forRoot        (name: 'replica', read-only)
 ├─ SequelizeModule.forRoot      (name: 'reviews-sequelize', same database)
 ├─ BullModule.forRoot           (Redis connection)
 ├─ CatalogModule -> SearchModule -> CartModule -> InventoryModule
 ├─ PromotionsModule, OrdersModule, ReviewsModule, AdminModule
 └─ JobsModule (processors) + OutboxModule (relay)
```

**`category.repository.ts` — the recursive CTE.**

```ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class CategoryRepository {
  constructor(private readonly ds: DataSource) {}

  /** All descendant ids of a category, including itself. Depth-capped to stop cycles. */
  async descendantIds(rootSlug: string): Promise<number[]> {
    const rows = await this.ds.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, parent_id, 0 AS lvl FROM categories WHERE slug = $1
         UNION ALL
         SELECT c.id, c.parent_id, s.lvl + 1
           FROM categories c JOIN subtree s ON c.parent_id = s.id
          WHERE s.lvl < 10
       )
       SELECT id FROM subtree`,
      [rootSlug],
    );
    return rows.map((r: { id: string }) => Number(r.id));
  }

  /** The full tree, built in one query and assembled in memory (4,000 rows). */
  async fullTree() {
    const rows = await this.ds.query(
      `SELECT id, parent_id, slug, name, position FROM categories ORDER BY parent_id NULLS FIRST, position`,
    );
    const byId = new Map<number, any>();
    const roots: any[] = [];
    for (const r of rows) byId.set(Number(r.id), { ...r, children: [] });
    for (const node of byId.values()) {
      if (node.parent_id) byId.get(Number(node.parent_id))?.children.push(node);
      else roots.push(node);
    }
    return roots;
  }
}
```

The `lvl < 10` guard matters: a category tree edited by humans through an admin UI *will* eventually contain a cycle, and without the cap the CTE runs until the connection dies. Add a `CHECK` and an application rule too, but keep the cap — defence in depth is cheaper than a 3 a.m. page.

**`product-search.service.ts` — full text plus trigram.**

```ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class ProductSearchService {
  constructor(private readonly replica: DataSource) {}

  async search(q: string, limit = 24, cursor?: { rank: number; id: number }) {
    // websearch_to_tsquery accepts user input safely: quotes, OR, and - all work.
    const rows = await this.replica.query(
      `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq, $1::text AS raw)
       SELECT p.id, p.slug, p.title, p.brand, p.rating_avg,
              GREATEST(
                ts_rank_cd(p.search_doc, q.tsq),
                similarity(p.title, q.raw) * 0.6
              ) AS rank
         FROM products p, q
        WHERE p.status = 'active'
          AND (p.search_doc @@ q.tsq OR p.title % q.raw)
          AND ($2::float IS NULL OR (GREATEST(
                ts_rank_cd(p.search_doc, q.tsq),
                similarity(p.title, q.raw) * 0.6), p.id) < ($2::float, $3::bigint))
        ORDER BY rank DESC, p.id DESC
        LIMIT $4`,
      [q, cursor?.rank ?? null, cursor?.id ?? null, limit],
    );
    return rows;
  }
}
```

`@@` handles "wireless headphones"; `%` (the `pg_trgm` similarity operator, tuned with `pg_trgm.similarity_threshold`) handles "wireles headfones". `websearch_to_tsquery` is the only tsquery function you should expose to users — `to_tsquery` throws on unbalanced input, which becomes a 500 the first time someone types `a & `.

**`inventory.service.ts` — reservations without overselling.**

```ts
import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

const HOLD_MINUTES = 15;

@Injectable()
export class InventoryService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Reserve stock for every line of a cart, or nothing at all.
   * Variants are sorted so that concurrent carts always lock in the same order:
   * that is what prevents deadlocks, not luck.
   */
  async reserveForCart(cartId: string, lines: { variantId: number; qty: number }[]) {
    const ordered = [...lines].sort((a, b) => a.variantId - b.variantId);
    return this.ds.transaction(async (em: EntityManager) => {
      for (const line of ordered) {
        // One atomic conditional update: no read-then-write, so no race.
        const res = await em.query(
          `UPDATE inventory
              SET reserved = reserved + $2, version = version + 1
            WHERE variant_id = $1 AND on_hand - reserved >= $2
            RETURNING on_hand - reserved AS available`,
          [line.variantId, line.qty],
        );
        if (res.length === 0) {
          throw new ConflictException({ code: 'out_of_stock', variantId: line.variantId });
        }
        await em.query(
          `INSERT INTO inventory_reservations (variant_id, cart_id, quantity, expires_at)
           VALUES ($1, $2, $3, now() + interval '${HOLD_MINUTES} minutes')
           ON CONFLICT (cart_id, variant_id) WHERE status = 'held'
           DO UPDATE SET quantity = inventory_reservations.quantity + EXCLUDED.quantity,
                         expires_at = EXCLUDED.expires_at`,
          [line.variantId, cartId, line.qty],
        );
      }
    });
  }

  /** Called by the sweeper every 30 s, in bounded batches. */
  async releaseExpired(batch = 500): Promise<number> {
    const rows = await this.ds.query(
      `WITH expired AS (
         SELECT id, variant_id, quantity FROM inventory_reservations
          WHERE status = 'held' AND expires_at < now()
          ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
       ), released AS (
         UPDATE inventory_reservations r SET status = 'released'
           FROM expired e WHERE r.id = e.id RETURNING e.variant_id, e.quantity
       )
       UPDATE inventory i SET reserved = i.reserved - r.quantity
         FROM released r WHERE i.variant_id = r.variant_id RETURNING i.variant_id`,
      [batch],
    );
    return rows.length;
  }
}
```

**`order-state-machine.ts` — legal transitions in one place.**

```ts
export type OrderStatus =
  | 'pending_payment' | 'paid' | 'fulfilling' | 'shipped'
  | 'delivered' | 'cancelled' | 'refunded';

const LEGAL: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid:            ['fulfilling', 'cancelled', 'refunded'],
  fulfilling:      ['shipped', 'cancelled'],
  shipped:         ['delivered', 'refunded'],
  delivered:       ['refunded'],
  cancelled:       [],
  refunded:        [],
};

export class IllegalTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`illegal order transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) return;                       // idempotent re-application
  if (!LEGAL[from].includes(to)) throw new IllegalTransitionError(from, to);
}
```

```mermaid
stateDiagram-v2
  [*] --> pending_payment
  pending_payment --> paid
  pending_payment --> cancelled
  paid --> fulfilling
  paid --> cancelled
  paid --> refunded
  fulfilling --> shipped
  fulfilling --> cancelled
  shipped --> delivered
  shipped --> refunded
  delivered --> refunded
  cancelled --> [*]
  refunded --> [*]
```

**The Sequelize module — reviews.** Everything else uses TypeORM; reviews uses Sequelize against the same database and the same transactions, so you can compare them without changing projects.

```ts
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, Sequelize, Transaction } from 'sequelize';

@Table({ tableName: 'reviews', timestamps: false })
export class Review extends Model {
  @Column({ type: DataType.BIGINT, primaryKey: true, autoIncrement: true }) id!: number;
  @Column({ type: DataType.BIGINT, allowNull: false }) product_id!: number;
  @Column({ type: DataType.UUID, allowNull: false }) user_id!: string;
  @Column({ type: DataType.SMALLINT, allowNull: false }) rating!: number;
  @Column({ type: DataType.TEXT, allowNull: false }) body!: string;
  @Column({ type: DataType.TEXT, defaultValue: 'pending' }) status!: string;
  @Column({ type: DataType.DATE, defaultValue: DataType.NOW }) created_at!: Date;
}

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel(Review) private readonly model: typeof Review,
    private readonly sequelize: Sequelize,
  ) {}

  /** Publishing a review recomputes the product aggregate in the same transaction. */
  async moderate(id: number, decision: 'published' | 'rejected') {
    return this.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (tx) => {
        const review = await this.model.findByPk(id, { transaction: tx, lock: tx.LOCK.UPDATE });
        if (!review) throw new Error('not_found');
        await review.update({ status: decision }, { transaction: tx });
        await this.sequelize.query(
          `UPDATE products p SET
             rating_avg = COALESCE(s.avg, 0), rating_count = COALESCE(s.cnt, 0)
           FROM (SELECT avg(rating)::numeric(3,2) AS avg, count(*) AS cnt
                   FROM reviews WHERE product_id = :pid AND status = 'published') s
           WHERE p.id = :pid`,
          { replacements: { pid: review.product_id }, transaction: tx },
        );
        return review;
      },
    );
  }

  async listPublished(productId: number, cursor?: { at: string; id: number }, limit = 20) {
    return this.model.findAll({
      where: {
        product_id: productId, status: 'published',
        ...(cursor ? { [Op.or]: [
          { created_at: { [Op.lt]: cursor.at } },
          { created_at: cursor.at, id: { [Op.lt]: cursor.id } },
        ] } : {}),
      },
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      limit,
    });
  }
}
```

**What you learn from having both.**

| Dimension | TypeORM | Sequelize |
|---|---|---|
| Schema definition | Decorators on entities, migrations generated from diffs | Decorators or `define()`; migrations written by hand with `umzug`/CLI |
| Transactions | `dataSource.transaction(cb)` or explicit `QueryRunner` | `sequelize.transaction(cb)`; CLS namespace optional for implicit propagation |
| Row locks | `setLock('pessimistic_write')` on the query builder | `lock: tx.LOCK.UPDATE` on the finder |
| Raw SQL | `query()` returns plain rows; parameter placeholders `$1` | `query()` with `replacements` named parameters |
| Keyset pagination | Query builder with `andWhere` tuple comparison | `Op.or` tuple emulation, more verbose |
| Typing | Strong with TS entities; relations sometimes `any` | `sequelize-typescript` decent; plain Sequelize weak |
| Surprises | Lazy relations, cascade defaults, `save()` doing a `SELECT` first | `findAll` with `include` builds huge joins; `paranoid` deletes hide rows |
| Where each wins | Complex relations, migration generation, `QueryRunner` control | Explicit SQL, hooks, scopes, teams already fluent in it |

The honest conclusion after building both: neither ORM saves you from knowing SQL, and both cost you an afternoon the first time you need a lock. Choose the one your team can debug at 3 a.m.

### 60.2.7 PostgreSQL design decisions

**Transactions.** Three boundaries matter. Reservation plus cart-to-order conversion is one transaction (all lines reserved or none). Review moderation plus aggregate recompute is one transaction (the rating on the product page is never inconsistent with the reviews below it). Order creation plus outbox insert is one transaction (no event without an order, no order without an event). Everything else is a single statement and therefore already atomic.

**Locks.** The reservation path deliberately uses no `SELECT ... FOR UPDATE`. `UPDATE inventory SET reserved = reserved + $2 WHERE on_hand - reserved >= $2` takes a row lock for the duration of the statement only and does the check and the write in one atomic step. Two carts fighting over the last unit produce exactly one winner and one `409`. Sorting the lines by `variant_id` before the loop means two carts containing the same two items lock them in the same order and cannot deadlock. Ordering locks is the cheapest deadlock fix in existence, and almost nobody does it.

**Indexes and the queries they serve.**

- `products_search_idx` (GIN on `tsvector`) — the `@@` search. The `search_doc` column is `GENERATED ALWAYS ... STORED`, so it can never drift from the title; a trigger would be one more thing to forget.
- `products_title_trgm_idx` (GIN `gin_trgm_ops`) — the `%` typo path and `ILIKE '%foo%'` in admin.
- `products_category_keyset_idx` — `WHERE category_id = ANY($1) AND status='active' ORDER BY created_at DESC, id DESC`. Partial on `status='active'` because archived products are 30 percent of the table and never listed.
- `reservations_expiry_idx` partial on `status='held'` — the sweeper scans only live holds; released rows are 99 percent of the table after a month.
- `orders_user_keyset_idx` — the order history endpoint, matching the exact sort tuple.
- `promotion_redemptions_user_idx` — the per-user limit check.

**Partitioning.** `order_events` by month. At 5 orders/s sustained with roughly 6 events each, that is 2.6 million rows a month; a year is fine unpartitioned, but the retention story is not, and partitions let you keep 90 days hot and archive the rest to object storage with `COPY ... TO PROGRAM`. Products and orders are not partitioned: 200k and a few million rows do not need it, and partitioning a table you query by many different keys makes every query worse.

**Migrations.** Adding `search_doc` as a generated stored column rewrites the table, so on a live system you add it nullable, backfill in batches, then add the index `CONCURRENTLY`, then switch reads. Practise the expand-contract dance here, where nothing is on fire, so that in Project 6 it is muscle memory. Every migration file sets `lock_timeout` and is tested against a database seeded with 200k products, because a migration that takes 3 ms on 100 rows can take 90 seconds on the real thing.

### 60.2.8 Redis usage

| Key | Structure | TTL | Purpose | Invalidation |
|---|---|---|---|---|
| `cart:{cartId}` | Hash `variantId -> qty` | 7 days sliding | The live cart; every mutation is `HINCRBY` or `HSET` | Deleted on order placement |
| `cart:{cartId}:meta` | Hash `{userId,currency,promo,updatedAt}` | 7 days | Cart metadata | With the cart |
| `cart:dirty` | Sorted set, score = timestamp | none | Carts changed since the last flush | Trimmed by the persister job |
| `product:{slug}` | String JSON | 300 s | Product detail page payload | Deleted on product update event |
| `category:tree` | String JSON | 300 s | Whole tree, 4,000 nodes, about 400 KB | Deleted on any category write |
| `stock:{variantId}` | String integer | 30 s | "In stock" badge, allowed to be slightly stale | Expiry, plus delete on reservation |
| `suggest:{prefix}` | Sorted set | 600 s | Top 10 autocomplete results | Refreshed by the reindex job |
| `lock:cache:{key}` | `SET NX PX 5000` | 5 s | Stampede protection on cold product pages | Released after fill |
| `promo:{code}:count` | Counter | until `ends_at` | Fast rejection when a promo is exhausted | Authoritative check still in PostgreSQL |
| `rl:search:{ip}` | Counter | 60 s | 60 searches/min per IP | Expiry |

The cart deserves the detail. Reads and writes hit Redis, so add-to-cart is a 0.3 ms round trip instead of a 4 ms transaction. Durability comes from a job that runs every 5 seconds, pops cart ids from `cart:dirty` with `ZRANGEBYSCORE`, and upserts `carts`/`cart_items` in one statement per cart. If Redis loses the last 5 seconds, a customer loses one add-to-cart, which is annoying but not money. If you cannot accept even that, write-through to PostgreSQL synchronously and accept the latency; say which one you chose and why. What you must never do is treat Redis as durable *and* have no reconciliation: on cart read, if Redis misses, rebuild from PostgreSQL and repopulate.

Cache invalidation is event-driven, not TTL-hopeful: the outbox emits `product.updated`, and the consumer deletes `product:{slug}` and enqueues a reindex. TTL is the safety net for the delete you forgot.

### 60.2.9 Messaging usage

Inside the monolith, domain events are published through the outbox and consumed by BullMQ workers in the same deployment. This is deliberate: you get asynchronous processing, retries and a DLQ without operating Kafka for 30 events per second. Project 6 replaces the transport, not the design.

**Events:** `product.created`, `product.updated`, `product.archived`, `inventory.low` (below reorder point), `cart.abandoned` (no activity for 60 minutes), `order.placed`, `order.cancelled`, `review.published`.

**Queues (BullMQ):**

| Queue | Job | Concurrency | Retry | On exhaustion |
|---|---|---|---|---|
| `email` | order confirmation, abandoned cart, review published | 10 | 5 attempts, exponential from 2 s | DLQ queue `email:dead`, alert |
| `reindex` | rebuild `search_doc` and suggest sets for one product | 4 | 3 attempts | DLQ, and a nightly full rebuild covers gaps |
| `sweeper` | release expired reservations, mark abandoned carts | 1 (repeatable, every 30 s) | 3 attempts | Alert only; next run retries anyway |
| `aggregates` | recompute product rating after review changes | 2 | 3 attempts | DLQ |

Every job payload carries an `eventId`, and every handler starts by inserting into `job_inbox(consumer, event_id)` with a primary key on both columns; a duplicate-key violation means "already handled" and the job returns success. This is what makes at-least-once delivery safe, and it is the same pattern you will use for Kafka in Project 3, so build it here where the blast radius is a duplicate email.

Use `removeOnComplete: { age: 3600, count: 1000 }` and `removeOnFail: false`. Completed jobs kept forever are the most common way a "Redis is out of memory" incident starts.

### 60.2.10 Testing strategy

Unit tests: the state machine (every legal and illegal transition), price and discount arithmetic in minor units, keyset cursor encode/decode round trip, promotion eligibility rules. Integration tests: Testcontainers with real PostgreSQL and Redis, every repository and service. E2E: Supertest against the booted app for the browse-search-cart-checkout journey.

The ten cases that matter:

1. **No oversell under concurrency** — one unit in stock, 50 parallel `POST /orders`; exactly one 201 and 49 409s; `inventory.reserved` equals 1.
2. **Reservation expiry** — reserve, advance time past 15 minutes, run the sweeper; `reserved` returns to 0 and the stock is buyable again.
3. **Deadlock freedom** — two carts with the same two variants in opposite input order, 200 iterations in parallel, zero deadlock errors (proves the sort).
4. **Recursive CTE depth and cycles** — build a 6-level tree, assert descendant counts; inject a cycle and assert the query still returns within the depth cap.
5. **Search quality** — a fixture of 5,000 products; "wireles headfones" returns the right product in the top 3; ranking is stable; an empty query returns 422 not 500.
6. **Keyset pagination correctness** — insert 1,000 products, page through with limit 25, assert 1,000 distinct ids and no duplicates while a concurrent insert happens.
7. **Cart merge on login** — guest cart with 3 items merges into a user cart with 2, quantities combine, prices refresh to current, the guest cart is closed.
8. **Promotion limits** — a code with `per_user_limit = 1` used twice by one user; the second returns 409 and `promotion_redemptions` has one row.
9. **Outbox exactly-once effect** — crash the relay between publish and mark-published; on restart the duplicate is absorbed by the inbox and only one email is sent.
10. **Review moderation consistency** — publish a review; `products.rating_avg` matches a recomputation from scratch; a rejected review does not count.

Add a seed script that generates 200k products and 600k variants, and run `EXPLAIN (ANALYZE, BUFFERS)` on the six main queries as part of the test suite, failing if any of them shows a sequential scan on `products`. A performance test that only checks wall-clock time is flaky; one that asserts the plan is not.

### 60.2.11 Docker

Same multi-stage Dockerfile shape as Project 1, plus a second image target for the worker (`CMD ["node","dist/worker.js"]`) built from the same layers so the code is identical.

```yaml
services:
  postgres:
    image: postgres:16
    command: ["postgres","-c","shared_preload_libraries=pg_stat_statements","-c","max_connections=200"]
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: shop }
    volumes: ["./db/init:/docker-entrypoint-initdb.d", "pgdata:/var/lib/postgresql/data"]
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U postgres -d shop"], interval: 5s, retries: 10 }
  redis:
    image: redis:7-alpine
    command: ["redis-server","--maxmemory","512mb","--maxmemory-policy","noeviction"]
    ports: ["6379:6379"]
  minio:
    image: minio/minio
    command: ["server","/data","--console-address",":9001"]
    environment: { MINIO_ROOT_USER: dev, MINIO_ROOT_PASSWORD: devdevdev }
    ports: ["9000:9000","9001:9001"]
  mailhog: { image: mailhog/mailhog, ports: ["8025:8025"] }
  api:
    build: { context: ., target: runtime }
    environment:
      DATABASE_URL: postgres://postgres:dev@postgres:5432/shop
      REPLICA_URL: postgres://postgres:dev@postgres:5432/shop
      REDIS_URL: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
    depends_on: { postgres: { condition: service_healthy } }
    ports: ["3000:3000"]
  worker:
    build: { context: ., target: runtime }
    command: ["node","dist/worker.js"]
    environment: { DATABASE_URL: postgres://postgres:dev@postgres:5432/shop, REDIS_URL: redis://redis:6379 }
    depends_on: { postgres: { condition: service_healthy } }
volumes: { pgdata: {} }
```

`maxmemory-policy noeviction` is deliberate. With `allkeys-lru`, Redis would silently evict carts under memory pressure and you would spend a week debugging "customers lose their carts on Fridays". With `noeviction`, writes fail loudly and you find out immediately. Choose eviction only for pure caches, and then run caches on a separate Redis from the carts.

### 60.2.12 CI/CD

The pipeline shape is Project 1's, with four additions worth calling out.

```yaml
  verify:
    steps:
      - run: npm ci && npm run lint && npx tsc --noEmit
      - run: npm run boundaries:check        # module import rules, fails the build
      - run: npm run migration:run
      - run: npm run seed:perf -- --products 20000
      - run: npm run test:unit && npm run test:integration && npm run test:e2e
      - run: npm run test:plans              # EXPLAIN assertions: no seq scan on products
  migrate-check:
    steps:
      - run: npm run migration:run && npm run migration:revert && npm run migration:run
```

The boundary check is what keeps a modular monolith modular; without it, in three months `OrdersService` will be selecting from `inventory` and Project 6 becomes impossible. The migration up-down-up job catches irreversible migrations before they reach production. Deployment runs migrations as a separate Job, then rolls out API and worker deployments independently, API first when the change is additive and worker first when the worker must understand a new event shape.

### 60.2.13 Observability

**Metrics:** `http_request_duration_seconds{route,method,status}`; `catalog_cache_hits_total{key_type}` and misses; `search_duration_seconds` with a `matched_zero` counter (zero-result searches are a product metric, not just a technical one); `cart_operations_total{op}`; `inventory_reserve_total{result="ok|out_of_stock"}`; `inventory_reserved_units` gauge; `reservations_expired_total`; `orders_placed_total{currency}`; `order_transition_total{from,to}`; `outbox_lag_seconds`; `bull_queue_depth{queue}` and `bull_job_duration_seconds{queue}`; `pg_pool_waiting`.

**Log fields:** `traceId, requestId, userId, cartId, orderId, variantId, route, status, durationMs, dbMs, redisMs, cacheHit, outcome`. Log the timing split (`dbMs`, `redisMs`) on every request; when p99 rises, that one field tells you which dependency to look at before you open a trace.

**Traces:** the checkout trace should show `cart.load` (Redis), `promotion.validate` (PG), `inventory.reserve` (PG, one span per variant), `order.insert`, `outbox.insert`, and their total. If `inventory.reserve` shows six sequential 3 ms spans, you have found your first optimisation: batch the lines into one statement with `unnest`.

**Dashboards:** a funnel row (product views, add-to-cart, checkout starts, orders, conversion), a latency row per endpoint, an inventory row (reserved units, expired reservations, out-of-stock rejections), and a queue row (depth, oldest job age, failure rate).

**Alerts:** `inventory_reserve_total{result="out_of_stock"}` rate above 5 percent of attempts for 10 minutes (usually a stock feed problem, pages); `outbox_lag_seconds > 120`; `bull_queue_depth{queue="email"} > 5000`; oldest `held` reservation older than 20 minutes (the sweeper is dead); search p95 above 400 ms; conversion drop of more than 30 percent versus the same hour last week (the best outage detector you will ever build).

### 60.2.14 Failure scenarios

| Failure | Expected behaviour | How you test it |
|---|---|---|
| Redis down | Cart endpoints return 503 with a clear code; browsing and search still work from PostgreSQL; no data lost beyond the last flush | Stop Redis mid-journey in e2e; assert catalog 200 and cart 503 |
| Replica lag of 5 s | Search and browse may be stale; product detail after an admin edit still correct because it reads the primary | Use `pg_sleep` on the replica connection; assert routing |
| Two customers buy the last unit | One 201, one 409 `out_of_stock`; no negative stock | Concurrency test 1 |
| Sweeper stops running | Reservations pile up, stock appears sold out, alert fires within 20 minutes | Disable the repeatable job; assert the alert rule |
| Order created but outbox relay down | Order exists; email delayed; `outbox_lag_seconds` climbs; nothing lost | Kill the relay; restart and assert the email arrives |
| Promotion code goes viral, 500 req/s on one row | Redis counter rejects most; PostgreSQL row is the final arbiter; `UPDATE ... WHERE redeemed < max` prevents over-redemption | k6 hammering one code; assert `redeemed <= max_redemptions` |
| Bad product import sets 200k rows `active` | Reindex queue depth alarms; search results degrade but stay available | Import fixture; assert queue backpressure, not a crash |
| Long admin query blocks a migration | Migration fails on `lock_timeout`; deploy aborts safely | Open a transaction on `products`, run the migration |
| Cart hash grows to 10,000 items | Rejected at 100 lines with 422; Redis memory bounded | Fuzz test adding items in a loop |
| Image storage unreachable | Product pages render with placeholder URLs; uploads return 503 | Stop MinIO; assert catalog reads unaffected |

### 60.2.15 Scaling strategy

**1x — 50k DAU, 800 req/s peak.** Two API pods, one worker pod, one PostgreSQL (4 vCPU, 16 GiB), one Redis (2 GiB). Almost everything is served from the primary; caching is a nice-to-have. Total infrastructure cost is a few hundred dollars a month, and the bottleneck is you, not the machines.

**10x — 500k DAU, 8,000 req/s peak.** Now the read/write split earns its keep: two replicas for search, browse and admin reports. API scales to 10 to 15 pods; they are I/O-bound, so watch the connection pool, not CPU — with 15 pods times 15 connections you are at 225 connections and PostgreSQL starts spending real time on context switching, so PgBouncer in transaction mode goes in front. Product detail and category tree come from Redis with a hit rate above 95 percent. Images move fully behind a CDN. Search still fits PostgreSQL: 200k products with a GIN index is a 30 ms query, and the GIN index is roughly 400 MB, which stays in cache.

**100x — 5M DAU, 80,000 req/s peak, 2M products.** The monolith splits (that is Project 6), but before that, several cheaper moves buy a year: move search to a dedicated replica or to OpenSearch fed by the outbox; put a caching layer at the edge for anonymous catalog traffic, which is 80 percent of it, and let the CDN serve product JSON with a 60 s TTL; shard nothing, but move `order_events` and `outbox` to their own database so the hot write path stops competing with the catalog. Inventory becomes the real bottleneck at flash-sale scale: 5,000 attempted reservations per second on one popular variant is a single-row hot spot no amount of hardware fixes. The fix is not a bigger database, it is a different algorithm — queue the demand, or partition the stock into N buckets per variant and let each request pick a bucket at random, falling back to a scan across buckets when its bucket is empty.

### 60.2.16 Security checklist

- [ ] Every DTO validated with `class-validator` and `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- [ ] Prices, discounts and totals are integers in minor units; never floats; the server recomputes totals and ignores client-supplied prices.
- [ ] Ownership checks on every `/orders/:id` and cart mutation; never trust an id in the URL.
- [ ] Guest cart tokens are 128-bit random values in an `HttpOnly` cookie, not sequential ids.
- [ ] Search input goes only through `websearch_to_tsquery` and parameterised queries; no string concatenation anywhere near SQL.
- [ ] `jsonb` attributes validated against an allow-list of keys; no unbounded user-controlled JSON.
- [ ] Admin endpoints behind the `@Roles('admin')` guard plus a separate rate limit; admin actions written to an audit table.
- [ ] Image uploads: presigned PUT with a content-type allow-list, a 10 MB cap, and server-side re-encoding before publishing.
- [ ] Promotion codes are rate-limited per IP and per user to stop code-guessing.
- [ ] Review bodies sanitised and length-capped; moderation required before publication.
- [ ] Reservation and order endpoints require idempotency keys; replays return the original result.
- [ ] Database roles split: the app role has no `DROP`, no `UPDATE`/`DELETE` on `order_events`, and migrations run as a separate role.
- [ ] PII (addresses) encrypted at rest or stored in a separate schema with restricted grants.

### 60.2.17 Stretch goals

Faceted search with counts per filter (a second aggregate query, or `GROUP BY` with `FILTER`) and the interesting problem of keeping counts consistent with the result set. Personalised ranking using a simple popularity signal from an events table. Multi-currency with a rates table and historical rate pinning on the order. Multi-warehouse inventory, which turns `reserve` into an allocation problem. A bulk product import with streaming CSV, `COPY`, and per-row error reporting. Read-your-writes routing implemented properly with a per-request "primary until timestamp X" hint. Finally, swap the search module for OpenSearch behind the same interface and measure honestly: latency, relevance, operational cost, and how often it drifts out of sync with PostgreSQL.

### 60.2.18 Definition of done

- [ ] All 11 functional requirements implemented, with e2e coverage of browse, search, cart, checkout and cancel.
- [ ] Zero oversell proven by the 50-way concurrency test, run 20 times in CI.
- [ ] Deadlock-freedom test green; lock ordering documented in a comment next to the code that relies on it.
- [ ] Every list endpoint uses keyset pagination; a test walks 1,000 rows without duplicates or gaps under concurrent writes.
- [ ] `EXPLAIN` assertions in CI prove no sequential scan on `products` for the six main queries at 200k rows.
- [ ] Reviews module implemented with Sequelize; the comparison table in your README is written from your own experience, not copied.
- [ ] Module boundary lint rule enabled and passing; no cross-module entity imports.
- [ ] Outbox relay with at-least-once delivery and consumer-side inbox dedupe, proven by the crash test.
- [ ] Reservation sweeper runs every 30 s with a bounded batch and its own alert.
- [ ] Cart survives a Redis restart by rebuilding from PostgreSQL; documented in the runbook.
- [ ] Dashboards for funnel, latency, inventory and queues; all alerts fire in a staging drill.
- [ ] Deployed to a real cluster with separate API and worker deployments, a migration Job, and a tested rollback.
- [ ] Load test: 800 req/s browse plus 20 checkouts/s for 10 minutes, p95 within targets, zero 5xx.
