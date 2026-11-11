## 20.10 Mapping the schema in TypeORM and Sequelize

### 20.10.1 TypeORM entities for the core schema

#### Concept

An ORM entity is a TypeScript class whose decorators describe a table. TypeORM reads the decorators to build SQL for `find`, `save`, and relations. The entity is a mapping, not a schema authority: the schema lives in migrations, and the entity must agree with it.

#### Why does it exist?

Mapping rows to typed objects removes boilerplate (`rows.map(r => new Order(r))`), gives you IDE completion, and lets the ORM manage simple relations. What it does not do is design your schema or optimize your queries. Treat the ORM as a convenience layer over SQL you already understand.

#### TypeORM example

The core entities, with the column types matching the DDL exactly:

```ts
// users/user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn, UpdateDateColumn, DeleteDateColumn, Index } from 'typeorm';
import { Order } from '../orders/order.entity';
import { Address } from './address.entity';

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column('text') email!: string;               // uniqueness enforced by the expression index in the migration
  @Column('text', { name: 'password_hash', select: false }) passwordHash!: string;  // never returned by default
  @Column('text', { name: 'full_name' }) fullName!: string;
  @Column('text', { nullable: true }) phone?: string | null;
  @Column('text', { default: 'active' }) status!: 'active' | 'suspended' | 'deleted';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt?: Date | null;

  @OneToMany(() => Address, (a) => a.user) addresses!: Address[];
  @OneToMany(() => Order, (o) => o.user) orders!: Order[];
}
```

```ts
// products/product.entity.ts
@Entity({ name: 'products' })
export class Product {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('text', { unique: true }) sku!: string;
  @Column('text') name!: string;
  @Column('text', { nullable: true }) description?: string | null;

  @Column('bigint', { name: 'category_id' }) categoryId!: string;
  @ManyToOne(() => Category, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'category_id' }) category!: Category;

  @Column('numeric', { precision: 12, scale: 2 }) price!: string;   // string: exact decimal
  @Column('char', { length: 3, default: 'INR' }) currency!: string;
  @Column('jsonb', { default: () => "'{}'::jsonb" }) attributes!: Record<string, unknown>;
  @Column('text', { array: true, default: () => "'{}'" }) tags!: string[];
  @Column('boolean', { name: 'is_active', default: true }) isActive!: boolean;

  @OneToOne(() => Inventory, (i) => i.product) inventory?: Inventory;
}
```

```ts
// orders/order.entity.ts
@Entity({ name: 'orders' })
@Index('orders_user_id_placed_at_idx', ['userId', 'placedAt'])
export class Order {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('bigint', { name: 'order_number', generated: 'identity', insert: false, update: false }) orderNumber!: string;

  @Column('uuid', { name: 'user_id' }) userId!: string;
  @ManyToOne(() => User, (u) => u.orders, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'user_id' }) user!: User;

  @Column('text', { default: 'pending' }) status!: OrderStatus;
  @Column('uuid', { name: 'shipping_address_id', nullable: true }) shippingAddressId?: string | null;
  @Column('numeric', { precision: 12, scale: 2, default: 0 }) subtotal!: string;
  @Column('numeric', { precision: 12, scale: 2, default: 0 }) discount!: string;
  @Column('numeric', { precision: 12, scale: 2, default: 0 }) total!: string;
  @Column('timestamptz', { name: 'placed_at', default: () => 'now()' }) placedAt!: Date;
  @Column('timestamptz', { name: 'cancelled_at', nullable: true }) cancelledAt?: Date | null;

  @VersionColumn() version!: number;   // optimistic locking: UPDATE ... WHERE version = ? (Part 24)

  @OneToMany(() => OrderItem, (i) => i.order, { cascade: ['insert'] }) items!: OrderItem[];
  @OneToMany(() => Payment, (p) => p.order) payments!: Payment[];
}
```

The `DataSource` configuration that goes with it:

```ts
// database/data-source.ts
import { DataSource } from 'typeorm';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [__dirname + '/../**/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,                  // ALWAYS false outside a throwaway local DB
  migrationsRun: false,                // run migrations as a deploy step, not at app boot
  logging: process.env.NODE_ENV !== 'production' ? ['query', 'error'] : ['error'],
  extra: { max: 20, statement_timeout: 10_000, options: '-c TimeZone=UTC' },
});
```

#### Pitfalls

- `synchronize: true` in production. TypeORM diffs entities against the live schema and applies `ALTER TABLE` at boot, including `DROP COLUMN` for anything it does not recognize. A renamed property becomes a dropped column. There is no confirmation, no review, no rollback. It is fine for a local database you can recreate; it is never fine anywhere data matters. Use migrations (`typeorm migration:generate` to draft, then read and edit the SQL before committing).
- Bidirectional relations and eager loading. `@OneToMany(..., { eager: true })` on `User.orders` plus `@ManyToOne(..., { eager: true })` on `Order.user` creates a loop that TypeORM refuses at runtime, or, when only one side is eager, silently loads thousands of rows on every `findOne`. Keep `eager: false` (the default) and load relations explicitly per query with `relations: [...]` or `leftJoinAndSelect`.
- `cascade: true` on both sides. Saving an order with a loaded user that has loaded orders re-saves everything. Limit cascades to `['insert']` on true composition (order to items) and never on the many-to-one side.
- Numeric and bigint arrive as strings. Declaring them as `number` compiles and then silently produces `"1999.99" + 1 = "1999.991"`.
- `@Column({ type: 'enum' })` creates a PostgreSQL enum type per entity per column in migrations, with generated names like `orders_status_enum`. If you want CHECK constraints instead (section 20.4.7), declare the column as `text` and put the CHECK in the migration.
- `find()` with no `take` on an unbounded relation. Always paginate.
- Entity property renames. `@Column({ name: 'placed_at' })` decouples the TypeScript name from the column name. Without it, renaming `placedAt` to `createdAt` changes the column name in the generated migration.
- Two `DataSource`s in tests and production drifting. Generate the test schema from the same migrations, never from `synchronize`.

### 20.10.2 Sequelize models for the core schema

```ts
// models/order.model.ts
import { DataTypes, Model, Sequelize, InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';

export class Order extends Model<InferAttributes<Order>, InferCreationAttributes<Order>> {
  declare id: CreationOptional<string>;
  declare orderNumber: CreationOptional<string>;
  declare userId: string;
  declare status: CreationOptional<'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'refunded'>;
  declare subtotal: CreationOptional<string>;
  declare discount: CreationOptional<string>;
  declare total: CreationOptional<string>;
  declare placedAt: CreationOptional<Date>;
  declare version: CreationOptional<number>;
}

export function initOrder(sequelize: Sequelize): void {
  Order.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      orderNumber: { type: DataTypes.BIGINT, autoIncrement: true, unique: true, field: 'order_number' },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending',
        validate: { isIn: [['pending','paid','shipped','delivered','cancelled','refunded']] } },  // app-level; DB CHECK is the real guard
      subtotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      discount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      total: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      placedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'placed_at' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize, tableName: 'orders', underscored: true,
      createdAt: false, updatedAt: 'updated_at',   // placed_at plays the role of created_at
      version: true,                                // optimistic locking on the version column
      indexes: [{ fields: ['user_id', { name: 'placed_at', order: 'DESC' }] }],
    },
  );
}
```

```ts
// models/associations.ts
export function associate(): void {
  User.hasMany(Address, { foreignKey: 'userId', as: 'addresses', onDelete: 'CASCADE' });
  User.hasMany(Order, { foreignKey: 'userId', as: 'orders', onDelete: 'RESTRICT' });
  Order.belongsTo(User, { foreignKey: 'userId', as: 'user' });
  Order.hasMany(OrderItem, { foreignKey: 'orderId', as: 'items', onDelete: 'CASCADE' });
  Order.hasMany(Payment, { foreignKey: 'orderId', as: 'payments', onDelete: 'RESTRICT' });
  OrderItem.belongsTo(Product, { foreignKey: 'productId', as: 'product', onDelete: 'RESTRICT' });
  Product.hasOne(Inventory, { foreignKey: 'productId', as: 'inventory', onDelete: 'CASCADE' });
  Product.belongsTo(Category, { foreignKey: 'categoryId', as: 'category', onDelete: 'RESTRICT' });
  Category.hasMany(Category, { foreignKey: 'parentId', as: 'children' });
  Category.belongsTo(Category, { foreignKey: 'parentId', as: 'parent' });
}
```

#### Pitfalls

- `sequelize.sync({ alter: true })` is Sequelize's `synchronize: true`. Same danger, same rule: migrations only (`sequelize-cli` or Umzug), never `sync` outside local development.
- `DataTypes.DECIMAL` returns strings; `DataTypes.BIGINT` returns strings. Same handling as TypeORM.
- `include` with `hasMany` produces a joined result set that Sequelize deduplicates in memory; with `limit` it generates a subquery that is often slow, and with two `hasMany` includes it produces a Cartesian product (Part 21 covers row explosion). Use `separate: true` on `hasMany` includes to issue a second query instead.
- `paranoid: true` (soft delete) adds `deleted_at IS NULL` to model queries but not to `sequelize.query` raw SQL.
- Association aliases (`as`) must match in `include`, or you get "is not associated" at runtime, not compile time.
- Validators (`validate: { isIn }`) run only through the model; `bulkCreate` skips them unless `validate: true` is passed. The database `CHECK` is the real guard.

### 20.10.3 Keeping entity, migration and database in agreement

The three artifacts must agree: the migration (source of truth for the schema), the entity/model (what the ORM believes), and the live database (what actually exists). Drift between any two causes "column does not exist" at 3 AM. The senior practices:

1. Migrations are hand-reviewed SQL, committed, run in CI against a fresh database, then run as a deploy step before the new application version starts.
2. A CI test boots the ORM against the migrated schema and asserts zero pending schema changes (`typeorm schema:log` prints nothing; for Sequelize, compare `queryInterface.describeTable` output against the model attributes).
3. Application startup fails fast if the migrations table shows unapplied migrations, rather than silently running with a mismatched schema.

## 20.11 Edge cases & failure modes: data modeling

A consolidated list, each with the mechanism and the fix. Most of these have already appeared in context; this is the checklist form.

- **NULL in unique columns.** `UNIQUE (order_id, coupon_code)` with nullable `coupon_code` allows unlimited null-coupon rows per order. Mechanism: nulls are distinct. Fix: `NOT NULL` with a sentinel, `UNIQUE NULLS NOT DISTINCT` (PG15+), or a partial index.
- **FK without index locks the parent delete.** `DELETE FROM users` scans every child table without an FK index, holding `ROW EXCLUSIVE` on each. Fix: index every FK column; CI check for FKs without indexes.
- **Cascading deletes wipe data.** `categories -> products -> inventory, reviews` chained `CASCADE` means deleting a category removes stock and reviews. Fix: `RESTRICT` by default; `CASCADE` only for true composition; review the cascade graph in every migration.
- **Enum `ALTER TYPE` and locking.** `ADD VALUE` is fast but the new value is unusable in the same transaction; removing a value requires recreating the type and rewriting the column under `ACCESS EXCLUSIVE`. Fix: `text` plus `CHECK` for evolving sets.
- **jsonb growing unbounded.** Appending to an array inside a document rewrites the whole document each time; dead tuples pile up; autovacuum falls behind. Fix: one row per event in a normal table; keep jsonb for bounded, read-whole documents.
- **Integer PK overflow at 2,147,483,647.** Inserts fail; the fix is a full table rewrite. Fix: `bigint` from day one; monitor `serial` columns above 50 percent with a query against `pg_sequences`.
- **Timezone bugs.** `timestamp` without zone stores wall-clock ambiguity; comparing `timestamptz` to a date literal depends on session zone; DST makes `+ interval '1 day'` not equal to 24 hours. Fix: `timestamptz` everywhere, session zone UTC, explicit `AT TIME ZONE` in reports.
- **Money rounding.** `float` drifts; `parseFloat` in JavaScript drifts; division without explicit rounding creates 1999.9982. Fix: `numeric(12,2)` or integer minor units, string handling in the app with a decimal library, `round(..., 2)` at every division.
- **Random UUID index bloat.** v4 keys land on random pages; index size doubles, cache hit rate drops. Fix: UUIDv7 or `bigint` identity for high-volume tables.
- **Soft delete breaks uniqueness.** A deleted user's email cannot be reused with a full unique index. Fix: partial unique index `WHERE deleted_at IS NULL`.
- **Polymorphic `(type, id)` columns.** No FK, orphans accumulate, joins require `CASE`. Fix: exclusive-arc FKs or a supertype table.
- **Hot counter row.** `UPDATE site_stats SET orders = orders + 1` at 500 per second serializes on one row lock. Fix: sharded counters, or Redis with periodic flush, or accept eventual counts from a materialized view.
- **`synchronize: true` or `sync({ alter: true })` in production.** A renamed property drops a column. Fix: migrations, reviewed and run as a deploy step.
- **Adding `NOT NULL` or a validated FK to a huge table.** Full scan under a heavy lock during business hours. Fix: `NOT VALID` then `VALIDATE`; `CHECK (col IS NOT NULL)` then `SET NOT NULL`.
- **Denormalized copy without reconciliation.** Totals drift through a new write path. Fix: triggers for in-DB derived values; nightly recompute-and-compare with alerting.
- **Unbounded 1:N without pagination.** `user.notifications` eager-loads 3 million rows and the pod is OOMKilled. Fix: never eager-load collections; keyset pagination with `(user_id, created_at)` index.
- **Multi-tenant leak through pooled `SET`.** A non-local `SET app.tenant_id` persists on the pooled connection into the next request. Fix: `SET LOCAL` or `set_config(..., true)` inside a transaction.
- **`serial` vs identity.** `serial` creates a loosely owned sequence and allows silent explicit ids. Fix: `GENERATED ALWAYS AS IDENTITY`.
- **Case-sensitive email uniqueness.** `Ravi@x.com` and `ravi@x.com` become two accounts. Fix: unique index on `lower(email)` or `citext`.
- **CHECK with `now()`.** Passes at insert, meaningless afterwards. Fix: enforce time-based validity in queries, not constraints.

## Senior Checklist — Part 20

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can explain what PostgreSQL guarantees (durability, atomicity, isolation, constraints) that a file or in-memory store does not, and what `COMMIT` costs
- [ ] I can predict the result of any expression involving `NULL`, including `NOT IN`, `<>`, `COUNT(col)` and `UNIQUE`
- [ ] I choose `uuid` (v7) vs `bigint` identity per table with a reason, and never `serial` or `integer` for a PK
- [ ] I store money as `numeric(12,2)` or integer minor units, never float, and handle it as strings or a decimal library in TypeScript
- [ ] I use `timestamptz`, set the session zone to UTC, and can explain the DST and date-literal traps
- [ ] I can say when `jsonb` and arrays are appropriate and when they are schema avoidance
- [ ] I can compare enum, `text + CHECK` and lookup tables and pick one for a given column
- [ ] I index every foreign key column and can write the catalog query that finds unindexed FKs
- [ ] I choose `ON DELETE` actions deliberately, defaulting to `RESTRICT`
- [ ] I can add a constraint to a large table without blocking writes (`NOT VALID` then `VALIDATE`)
- [ ] I can express "one active X per Y" as a partial unique index and "no overlapping ranges" as an `EXCLUDE` constraint
- [ ] I write idempotent creates as `INSERT ... ON CONFLICT` and know how `xmax = 0` tells insert from update
- [ ] I can normalize a flat table to 3NF and explain each anomaly it removes
- [ ] I denormalize deliberately, choose trigger vs application vs async vs materialized view, and always add a reconciliation query
- [ ] I design new features from access patterns with rates before writing DDL
- [ ] I can model 1:1, 1:N, M:N with attributes, trees, and the alternatives to polymorphic associations
- [ ] I know what soft delete breaks and how to fix uniqueness, queries and privacy deletion
- [ ] I can implement row-level security for shared-table multi-tenancy without leaking through connection pools
- [ ] I never run `synchronize: true` or `sync({ alter: true })` outside a disposable local database

## Part 20 — Key Takeaways

- A database is a set of kept promises: durability, atomicity, isolation and constraints. A file or a Map keeps none of them, and rebuilding them yourself is rebuilding a database badly.
- `NULL` means unknown. Every comparison with it is unknown. `NOT IN` with a null, `<>` on a nullable column, and `COUNT(col)` are where production bugs hide.
- Types are constraints. `bigint` identity or UUIDv7 for keys, `numeric` for money, `timestamptz` for instants, `text` for strings, `jsonb` only for genuinely per-row-varying data.
- PostgreSQL does not index foreign keys. You do. The parent delete that scans a 50-million-row child table under lock is the most common self-inflicted outage in schema design.
- Constraints are the last line of defense against application bugs and races. Unique indexes serialize conflicting writes; partial unique indexes and `EXCLUDE` express real business rules; `ON CONFLICT` makes creates idempotent.
- Normalize to 3NF by default so every fact lives once. Snapshots of historical facts (the price charged) are not denormalization; cached copies of current facts (the product's price) are.
- Denormalize deliberately: trigger for in-database derived values, materialized view for reports, async read model across services. Every copy gets a reconciliation query.
- Design from access patterns with rates. The hottest query decides which columns live together and which index is mandatory.
- `RESTRICT` is the default delete action. `CASCADE` is a data-loss chain you must trace to the leaves.
- Polymorphic `(type, id)` columns throw away referential integrity; use exclusive-arc FKs or a supertype table.
- Soft delete changes uniqueness, every query and privacy deletion; plan the partial index, the view, and the anonymization procedure with it.
- The ORM maps the schema; it does not own it. Migrations are the source of truth, reviewed as SQL, run as a deploy step. `synchronize: true` in production is a dropped column waiting to happen.
