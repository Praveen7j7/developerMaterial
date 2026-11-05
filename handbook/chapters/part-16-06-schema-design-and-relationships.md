## 16.9 Designing schemas and modeling relationships

### 16.9.1 The schema design process for a new feature

#### Concept

Schema design is not "draw boxes for the nouns in the requirements". It is a sequence: requirements, entities, access patterns, schema, indexes, constraints, migration. The order matters. Access patterns before schema, because the queries you will run decide which columns live together. Constraints before migration, because adding them later means validating existing bad data.

#### Why does it exist?

Schemas designed from nouns alone produce tables that are correct and slow: every page needs six joins and there is no index for the one query that runs 2,000 times per second. Schemas designed from access patterns alone produce fast tables that cannot answer next quarter's question. The process balances both and, critically, makes the migration safe, because you thought about the 200-million-row table before writing `ALTER TABLE`.

#### How it works

Take a concrete feature: "Customers can save products to named wishlists and share a wishlist by link."

1. Requirements. A user has many wishlists. A wishlist has a name, is private by default, can be shared by an unguessable link. A product can be in many wishlists. Show "in your wishlist" on the product page. Notify the user when a wishlisted product drops in price.
2. Entities. `wishlists` (user, name, visibility, share token). `wishlist_items` (wishlist, product, added time). Nothing else; "price drop notification" reuses `notifications`.
3. Access patterns, with expected rates:
   - List a user's wishlists: `WHERE user_id = ?` — 50 per second.
   - Show a wishlist with products: `WHERE wishlist_id = ?` join products — 200 per second.
   - Open a shared link: `WHERE share_token = ?` — 20 per second.
   - "Is product X in any of this user's wishlists?" on every product page — 2,000 per second. This is the one that drives the index design.
   - Price-drop job: "all users who wishlisted product X" — batch, once per price change.
4. Schema. Because pattern four is hot, `wishlist_items` gets `user_id` denormalized onto it, so the check is a single index probe without a join through `wishlists`.
5. Indexes. `wishlists (user_id)`, `wishlists (share_token) UNIQUE`, `wishlist_items (user_id, product_id)` for the hot check, `wishlist_items (product_id)` for the price-drop job, and the PK `(wishlist_id, product_id)` for the detail page.
6. Constraints. `share_token` unique and generated; `UNIQUE (wishlist_id, product_id)`; `wishlist_items.user_id` must equal the wishlist's `user_id` (enforced by a composite FK, shown below); name length check.
7. Migration. Two new tables, no rewrite of existing tables, no locks beyond the trivial. Ship behind a feature flag.

```sql
CREATE TABLE wishlists (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  is_public   boolean     NOT NULL DEFAULT false,
  share_token text        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)    -- lets children reference the pair, enforcing same-owner
);
CREATE INDEX wishlists_user_id_idx ON wishlists (user_id);

CREATE TABLE wishlist_items (
  wishlist_id uuid        NOT NULL,
  user_id     uuid        NOT NULL,     -- denormalized for the hot "is in wishlist" check
  product_id  uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wishlist_id, product_id),
  -- Composite FK: the (wishlist_id, user_id) pair must exist, so user_id can never disagree with the wishlist's owner
  FOREIGN KEY (wishlist_id, user_id) REFERENCES wishlists (id, user_id) ON DELETE CASCADE
);
CREATE INDEX wishlist_items_user_product_idx ON wishlist_items (user_id, product_id);
CREATE INDEX wishlist_items_product_id_idx ON wishlist_items (product_id);
```

The composite foreign key is the senior touch: the denormalized `user_id` cannot drift, because the database refuses any row whose `(wishlist_id, user_id)` pair does not exist in `wishlists`.

#### How a Senior Backend Engineer thinks about this

They write the access patterns down with rates before they write DDL. They design for the top two or three queries and accept that the rest will be "fine". They ask "what is the biggest table this touches and what lock will the migration take?" before approving. They check the FK-index rule, the `NOT NULL` rule, and the naming convention in every review. And they ask the product manager the question that changes the schema most often: "Will this ever need to be per-tenant, per-region, or per-currency?"

#### Interview questions

1. Walk me through designing the schema for wishlists. Expected: entities, access patterns with rates, hot path drives the denormalized `user_id` and its index, composite FK to keep it honest.
2. Why access patterns before schema? Expected: the queries decide co-location and indexes; nouns alone give correct-but-slow schemas.

### 16.9.2 One-to-one, one-to-many, many-to-many

#### Concept

- 1:1 — each row in A has at most one row in B and vice versa. Modeled by putting B's primary key as a foreign key to A (or by merging the tables). `inventory.product_id` is both the PK and an FK to `products`.
- 1:N — one row in A has many rows in B. Modeled by an FK in B pointing at A. `orders.user_id`, `order_items.order_id`.
- M:N — rows in A relate to many rows in B and vice versa. Modeled by a join table with two FKs and, usually, extra columns. `order_items` is the join table between `orders` and `products`, and it carries `quantity` and `unit_price`.

#### Why does it exist?

Relational databases do not have pointers or lists. Every relationship is expressed as "these two rows share a value". The three shapes are the only three ways two tables can share values with cardinality constraints, and each has an idiomatic physical layout.

#### How it works

1:1 (`products` and `inventory`): use the parent's key as the child's PK. This enforces "at most one" for free, and the join is a PK-to-PK nested loop, effectively free. Why a separate table at all? When the child's columns are updated far more often than the parent's (stock levels change per order; product names change per year), splitting keeps the hot updates from rewriting the wide product row and bloating its indexes. When the child is optional for most rows (a `seller_profiles` table for the 2 percent of users who sell), splitting avoids nulls in 98 percent of rows.

1:N (`users` and `orders`): FK on the many side, indexed, usually with a sort column for the common "latest N for this parent" query: `orders (user_id, placed_at DESC)`.

M:N (`orders` and `products` via `order_items`): join table. Composite PK or surrogate plus unique pair. Index on the second FK column. Extra columns on the join table are normal and expected; a join table with no extra columns is a hint that an array might have been simpler, if the elements are simple.

#### TypeORM example

```ts
// 1:1 with shared primary key
@Entity({ name: 'inventory' })
export class Inventory {
  @PrimaryColumn('uuid', { name: 'product_id' })
  productId!: string;

  @OneToOne(() => Product, (p) => p.inventory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })       // JoinColumn goes on the owning side (the one with the FK)
  product!: Product;

  @Column('integer', { name: 'quantity_on_hand', default: 0 })
  quantityOnHand!: number;
}

// 1:N
@Entity({ name: 'orders' })
export class Order {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column('uuid', { name: 'user_id' }) userId!: string;
  @ManyToOne(() => User, (u) => u.orders, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' }) user!: User;

  @OneToMany(() => OrderItem, (i) => i.order, { cascade: ['insert'] })
  items!: OrderItem[];   // cascade insert: saving an order saves its items in one transaction
}

// M:N with extra columns: model the join table as its own entity. Do NOT use @ManyToMany,
// which cannot hold quantity/unit_price.
@Entity({ name: 'order_items' })
export class OrderItem {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id!: string;
  @ManyToOne(() => Order, (o) => o.items, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'order_id' }) order!: Order;
  @ManyToOne(() => Product, { onDelete: 'RESTRICT' }) @JoinColumn({ name: 'product_id' }) product!: Product;
  @Column('integer') quantity!: number;
  @Column('numeric', { precision: 12, scale: 2, name: 'unit_price' }) unitPrice!: string;
}
```

`@ManyToMany` with `@JoinTable` is fine for a pure join table with no attributes (`products <-> tags`). The moment the relationship has its own data, promote it to an entity.

#### Sequelize example

```ts
// 1:1
Product.hasOne(Inventory, { foreignKey: 'productId', as: 'inventory', onDelete: 'CASCADE' });
Inventory.belongsTo(Product, { foreignKey: 'productId', as: 'product' });

// 1:N
User.hasMany(Order, { foreignKey: 'userId', as: 'orders' });
Order.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// M:N with extra columns: `through` a real model
Order.belongsToMany(Product, { through: OrderItem, foreignKey: 'orderId', otherKey: 'productId', as: 'products' });
Product.belongsToMany(Order, { through: OrderItem, foreignKey: 'productId', otherKey: 'orderId', as: 'orders' });
// Also declare the direct associations so you can query OrderItem rows with their columns:
Order.hasMany(OrderItem, { foreignKey: 'orderId', as: 'items' });
OrderItem.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
```

#### Edge cases & failure modes

- A "1:1" that is really "1:0..1" needs the child to be optional; a "1:1" that is mandatory both ways is a circular dependency at insert time and usually means one table.
- 1:N where N is unbounded (a user with 5 million notifications): the `(user_id, created_at)` index and keyset pagination are mandatory; `OneToMany` eager loading is a memory bomb.
- M:N join tables with a surrogate `id` but no `UNIQUE (a, b)`: duplicates creep in.

#### Interview questions

1. How do you model 1:1 in PostgreSQL, and when is a separate table worth it? Expected: child PK = parent FK; worth it for hot-update columns or optional/sparse data.
2. Why not `@ManyToMany` for order items? Expected: the relationship has attributes; model the join table as an entity.

### 16.9.3 Self-referencing relationships: the category tree

#### Concept

A self-referencing (recursive) relationship is a table whose FK points at itself: `categories.parent_id -> categories.id`. It models trees and hierarchies: categories, org charts, comment threads, folder structures.

#### How it works: three models

| Model | Storage | Get children | Get all descendants | Move a subtree | Notes |
|---|---|---|---|---|---|
| Adjacency list (`parent_id`) | One FK | Index probe | Recursive CTE | One `UPDATE` | Simplest; recursion cost grows with depth |
| Materialized path (`path text` like `'1.4.17'` or `ltree`) | Path string per row | Prefix match | Prefix match (`path <@ '1.4'` with `ltree`) | Rewrite paths of all descendants | Fast reads; `ltree` extension has GiST index |
| Closure table (`ancestor_id, descendant_id, depth`) | One row per ancestor-descendant pair | `depth = 1` | All rows for ancestor | Delete and reinsert pairs | Fastest queries; most rows; most write logic |

The reference schema uses adjacency list because category trees are small (hundreds to low thousands of rows), shallow (three to five levels), and rarely restructured. The recursive CTE for "all products under Electronics" is in Part 17. For a comment system with millions of threads and deep nesting, `ltree` is usually the better choice.

#### PostgreSQL example

```sql
-- Adjacency list (reference schema) plus a guard against self-parenting
-- CHECK (parent_id IS DISTINCT FROM id) is already there. Cycles deeper than one level need a trigger or the CYCLE clause on read.

-- ltree alternative
CREATE EXTENSION IF NOT EXISTS ltree;
ALTER TABLE categories ADD COLUMN path ltree;
CREATE INDEX categories_path_gist ON categories USING gist (path);
-- Electronics = '1', Phones = '1.4', Accessories = '1.4.17'
SELECT * FROM categories WHERE path <@ '1.4';         -- Phones and everything under it
SELECT * FROM categories WHERE path ~ '1.*{1}';       -- direct children of Electronics
```

#### Edge cases & failure modes

- Cycles: `A.parent = B`, `B.parent = A`. An adjacency list cannot forbid this with a `CHECK`. Use a `BEFORE UPDATE` trigger that walks up from the new parent, or accept it and use `CYCLE` detection in the reading CTE (Part 17).
- Deleting a parent with `RESTRICT` (correct) means the application must re-parent or delete children first.
- Depth limits: put a `CHECK (nlevel(path) <= 6)` on `ltree` paths, or a trigger on adjacency lists, so a bug cannot create a 10,000-level chain that makes every recursive query crawl.

#### Interview questions

1. Adjacency list, materialized path or closure table for a product category tree? Expected: adjacency for small, shallow, stable trees; `ltree` when descendant queries dominate; closure for maximum read speed with heavy write logic.

### 16.9.4 Polymorphic associations: the trap and the alternatives

#### Concept

A polymorphic association is a column pair like `(commentable_type, commentable_id)` that points at "either a product or an order or a review". Rails popularized it; ORMs make it look easy. In a relational database it is a trap, because a foreign key cannot reference "one of several tables". You lose referential integrity, you cannot join without a `CASE`, and `commentable_id` must be a type wide enough for all targets (which breaks when one target uses `uuid` and another `bigint`).

#### The alternatives

1. Separate tables per target: `product_comments`, `order_comments`. Full integrity, boring, best when the targets have different attributes anyway.
2. Exclusive-arc FKs: one nullable FK per target with a `CHECK` that exactly one is set. Full integrity, one table, the planner can use each FK's index.
3. Supertype table: an `attachable` parent table with a PK that both `products` and `orders` reference 1:1 (each product row has a corresponding attachable row); comments reference `attachable.id`. Full integrity, general, extra join.

```sql
-- Exclusive-arc: a notification is about exactly one of an order, a shipment or a payment
ALTER TABLE notifications
  ADD COLUMN order_id    uuid REFERENCES orders(id)    ON DELETE CASCADE,
  ADD COLUMN shipment_id uuid REFERENCES shipments(id) ON DELETE CASCADE,
  ADD COLUMN payment_id  uuid REFERENCES payments(id)  ON DELETE CASCADE,
  ADD CONSTRAINT notifications_exactly_one_subject CHECK (
    (order_id IS NOT NULL)::int + (shipment_id IS NOT NULL)::int + (payment_id IS NOT NULL)::int = 1
  );
CREATE INDEX notifications_order_id_idx    ON notifications (order_id)    WHERE order_id IS NOT NULL;
CREATE INDEX notifications_shipment_id_idx ON notifications (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX notifications_payment_id_idx  ON notifications (payment_id)  WHERE payment_id IS NOT NULL;
```

#### How a Senior Backend Engineer thinks about this

If the number of target types is small and known, exclusive arcs. If the targets share a lot of behavior (all "attachable things"), a supertype table. Never `(type, id)` pairs in a database that supports foreign keys. When an ORM offers polymorphic relations, they read the generated DDL first; TypeORM has no first-class polymorphic relations, and Sequelize's scoped associations (`constraints: false`) explicitly disable the FK, which is the problem itself.

#### Interview questions

1. Why is `(commentable_type, commentable_id)` a problem in PostgreSQL? Expected: no FK possible, no integrity, mixed id types, awkward joins. Follow-up: give two alternatives.

### 16.9.5 Soft delete

#### Concept

Soft delete marks a row as deleted (`deleted_at timestamptz`) instead of removing it. The row stays for audit, undo, and referential integrity with historical data (orders keep pointing at "deleted" products).

#### Consequences you must handle

1. Every query must filter `deleted_at IS NULL`. Miss one and deleted users appear in reports. ORMs help: TypeORM `@DeleteDateColumn` makes `find` filter automatically and `softRemove` set it; Sequelize `paranoid: true` does the same. Raw SQL and views do not, so a `live_users` view is a common safety net.
2. Unique constraints break. A deleted user's email cannot be reused unless the unique index is partial: `WHERE deleted_at IS NULL` (the reference schema does this). `UNIQUE (email, deleted_at)` does not work because `NULL` values are distinct from each other.
3. Foreign keys still hold. A soft-deleted product with `ON DELETE RESTRICT` is not deleted at all, so nothing cascades; that is usually what you want, but "delete a user" then means soft-deleting their addresses in application code.
4. Indexes fill with dead-forever rows. Partial indexes `WHERE deleted_at IS NULL` on hot columns keep the live index small.
5. Privacy law: "delete my account" often requires actual removal or anonymization. Soft delete plus a scheduled purge or an `anonymize_user()` procedure that scrubs PII while keeping the row.

```sql
-- Live view for raw SQL safety
CREATE VIEW live_users AS SELECT * FROM users WHERE deleted_at IS NULL;

-- Anonymize instead of delete, keeping orders intact (RESTRICT FK on orders.user_id)
UPDATE users
   SET email = 'deleted+' || id || '@example.invalid',
       full_name = 'Deleted User', phone = NULL,
       status = 'deleted', deleted_at = now()
 WHERE id = $1;
```

#### TypeORM example

```ts
@Entity({ name: 'users' })
export class User {
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;
}
// userRepo.softRemove(user) sets deleted_at; userRepo.find() adds WHERE deleted_at IS NULL automatically;
// userRepo.find({ withDeleted: true }) includes them; createQueryBuilder().withDeleted() likewise.
```

#### Sequelize example

```ts
User.init({ /* ... */ }, { sequelize, tableName: 'users', paranoid: true, deletedAt: 'deleted_at', underscored: true });
// User.destroy({ where }) sets deleted_at; User.findAll() excludes them; { paranoid: false } includes them.
```

#### Interview questions

1. What breaks when you add soft delete to `users`? Expected: unique email, every raw query, FK cascade semantics, privacy deletion; fixes: partial unique index, view or ORM filter, explicit child handling, anonymization.

### 16.9.6 Audit columns and audit tables

#### Concept

Audit columns are `created_at`, `updated_at`, `created_by`, `updated_by` on every table. An audit table records every change as a row (`who`, `when`, `what changed`, old and new values).

`created_at` and `updated_at` are cheap and universally useful for debugging, incremental exports, and support. Keep `updated_at` correct with a trigger, not with application code, so bulk scripts cannot forget:

```sql
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

For a full audit trail, a generic trigger writing `jsonb` old/new rows into `audit_log (table_name, row_id, op, old_row jsonb, new_row jsonb, actor, at)` is the standard pattern. It costs one insert per write and a lot of storage; partition `audit_log` by month and drop old partitions (Part 22 — Database Scaling). TypeORM's `@CreateDateColumn`, `@UpdateDateColumn` and `@VersionColumn` and Sequelize's `timestamps: true` set the columns from the application, which is fine as a convenience but not as the source of truth.

### 16.9.7 Multi-tenancy

#### Concept

Multi-tenancy is one deployment serving many customers (tenants) whose data must never mix. Three PostgreSQL strategies:

| Strategy | Isolation | Cost per tenant | Cross-tenant queries | Migrations | Noisy neighbor | Best for |
|---|---|---|---|---|---|---|
| Shared tables with `tenant_id` column | Logical only; a missing `WHERE` leaks data | Near zero | Trivial | One migration | Shared everything | SaaS with thousands of small tenants |
| Schema per tenant | Strong; separate tables | Catalog bloat beyond a few thousand schemas | Awkward (`UNION` across schemas) | One migration per schema | Shared instance | Tens to hundreds of mid-size tenants |
| Database per tenant | Strongest; separate everything | Connection pools per DB; ops overhead | Impossible in SQL | One per database | Isolated if separate instances | Few large tenants, regulatory isolation |

#### Row-level security for the shared-table model

The shared-table model's risk is one forgotten `WHERE tenant_id = ?`. Row-level security (RLS) makes the database add it for you. The policy is enforced on every statement regardless of which application code issued it.

```sql
ALTER TABLE orders ADD COLUMN tenant_id uuid NOT NULL;
CREATE INDEX orders_tenant_id_placed_at_idx ON orders (tenant_id, placed_at DESC);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- applies to the table owner too

-- The app sets the tenant per transaction; the policy reads it.
CREATE POLICY orders_tenant_isolation ON orders
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)          -- rows visible for SELECT/UPDATE/DELETE
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);   -- rows allowed for INSERT/UPDATE

-- The application role must not be a superuser or BYPASSRLS
CREATE ROLE app_user LOGIN PASSWORD '...' NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO app_user;
```

```ts
// A NestJS interceptor or a repository wrapper sets the tenant for the transaction:
await this.dataSource.transaction(async (m) => {
  // SET LOCAL is scoped to this transaction; safe with connection pooling
  await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  return m.query(`SELECT id, total FROM orders ORDER BY placed_at DESC LIMIT 20`);  // RLS adds the tenant filter
});
```

Costs: every query gets an extra predicate (cheap with the `tenant_id`-leading index), `EXPLAIN` shows the filter, and the planner sometimes chooses worse plans because the policy expression is opaque. `current_setting(..., true)` returns `NULL` when unset, so with no tenant set the policy matches nothing, which is the safe failure.

#### Edge cases & failure modes

- Connection pooling with `SET` (not `SET LOCAL`): the tenant setting leaks to the next request that reuses the connection. Always `SET LOCAL` inside a transaction, or `set_config(..., true)`.
- Superuser or table owner without `FORCE` bypasses RLS. Migrations should run as a different role than the application.
- Shared-table unique constraints must include `tenant_id`: `UNIQUE (tenant_id, sku)`, not `UNIQUE (sku)`.
- Schema-per-tenant with 5,000 schemas: `pg_dump`, autovacuum and the catalog all slow down; connection pool per schema in PgBouncer becomes a problem.
- A tenant that is 80 percent of the data in a shared table skews planner statistics for everyone else; consider partitioning by tenant or moving that tenant out.

#### Interview questions

1. How do you guarantee tenant isolation in a shared-table model? Expected: RLS with a per-transaction setting, non-bypass role, `SET LOCAL`; tenant-leading indexes and tenant-including unique constraints.
2. When would you move from shared tables to schema-per-tenant? Expected: regulatory isolation, per-tenant backup/restore, or a tenant so large it hurts others.

#### Practical exercise

Add `tenant_id` and RLS to `orders` and `order_items`. Write an integration test that opens two connections with different tenant settings and asserts that neither can read or update the other's rows, and that an unset tenant sees nothing. Acceptance criteria: tests pass; `EXPLAIN` shows the tenant index used; a `SET` (non-local) variant of the test demonstrates the leak.
