## 74.3 Basic SQL and connecting to PostgreSQL

### 74.3.1 A little SQL first

#### Concept

PostgreSQL is a relational database: it stores data in **tables** of rows and columns, and you talk to it with **SQL** (Structured Query Language). Before we have NestJS talk to it, you should see the raw SQL, because the ORM we use later just generates SQL for you, and you cannot debug what you do not understand. Part 11 teaches SQL properly; this is the minimum to follow the rest of this Part.

#### Why does it exist?

Your products need to persist — survive a server restart, be shared across every copy of the server, be queried and filtered efficiently. An in-memory array does none of that. A relational database gives you durable, queryable, concurrent storage with guarantees (a row is either fully written or not at all) that are the foundation of correct backends. SQL is the universal language for working with it.

#### How it works — the four basic statements

Connect with `psql` (74.1) and run these. Every backend engineer knows these four cold:

```sql
-- CREATE a table: define the shape of the data.
CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- unique id, auto-generated
  name        text NOT NULL,                                -- required
  price_cents integer NOT NULL CHECK (price_cents >= 0),    -- required, non-negative
  currency    char(3) NOT NULL DEFAULT 'USD',
  created_at  timestamptz NOT NULL DEFAULT now()            -- when the row was created
);

-- INSERT: add a row.
INSERT INTO products (name, price_cents) VALUES ('Dental Mirror', 1299)
  RETURNING id, name, price_cents, created_at;   -- RETURNING gives back the new row

-- SELECT: read rows.
SELECT id, name, price_cents FROM products;                    -- all products
SELECT id, name, price_cents FROM products WHERE id = $1;      -- one by id ($1 is a parameter)
SELECT * FROM products WHERE price_cents < 2000 ORDER BY name; -- filtered and sorted

-- UPDATE and DELETE: change or remove rows.
UPDATE products SET price_cents = 1399 WHERE id = $1;
DELETE FROM products WHERE id = $1;
```

Key ideas visible here. A **primary key** (`id`) uniquely identifies each row. **Constraints** (`NOT NULL`, `CHECK (price_cents >= 0)`) make invalid rows impossible to insert — the database enforces "price is never negative" so even a buggy application cannot violate it, which is a stronger guarantee than application validation alone. **Parameters** (`$1`) are how you safely pass values into a query; never build SQL by gluing strings together with user input, which causes SQL injection (Part 23).

#### SQL injection: the one security rule to internalize now

```sql
-- NEVER do this (string concatenation with user input):
--   "SELECT * FROM products WHERE name = '" + userInput + "'"
-- A userInput of  '; DROP TABLE products; --  destroys your table.

-- ALWAYS do this (parameterized query): the value can never be treated as code.
SELECT * FROM products WHERE name = $1;   -- the driver sends $1 separately from the SQL
```

The ORM and the database driver parameterize for you, which is one of the main reasons to use them. But you must understand the rule, because the day you write a raw query, this is on you.

#### Practical example — do it by hand once

In `psql`, create the table, insert two products, select them back, update one price, and delete one. Seeing the raw rows and the `RETURNING` output demystifies what the ORM will do. When the ORM later behaves unexpectedly, you will reach for `psql` and the raw SQL to see the truth.

#### How a Senior Backend Engineer thinks about this

A senior always understands the SQL their ORM generates, because the ORM is a convenience over SQL, not a replacement for understanding it, and performance problems live at the SQL level (Part 12 on indexes and query plans). They push invariants into the database as constraints (`NOT NULL`, `CHECK`, unique indexes, foreign keys) rather than relying only on application checks, because the database is the last line of defense and enforces the rule for every writer, including future code and manual fixes. They treat parameterization as non-negotiable and would flag any string-concatenated query in review instantly.

#### Common mistakes

- Building SQL by concatenating user input (SQL injection).
- Relying only on application validation and leaving the database able to hold invalid rows (no `CHECK`, no `NOT NULL`).
- Using the ORM without ever understanding the SQL it generates, then being helpless when it is slow or wrong.

#### Interview questions

1. **What is SQL injection and how do you prevent it?** Treating user input as part of the SQL text, letting an attacker run their own SQL; prevent it with parameterized queries (`$1`), never string concatenation.
2. **Why put constraints like `NOT NULL` and `CHECK` in the database instead of only in the application?** The database enforces them for every writer and is the last line of defense; application checks can be bypassed or forgotten.
3. **What are the four basic SQL statements?** `INSERT` (create), `SELECT` (read), `UPDATE` (change), `DELETE` (remove).

#### Practical exercise

In `psql`, create the `products` table with the constraints shown, insert two products (one via `RETURNING`), select them ordered by price, update one price, and try to insert a product with a negative price to see the `CHECK` constraint reject it. Acceptance criteria: the negative-price insert fails at the database level, proving the constraint protects you regardless of application code.

### 74.3.2 Connecting NestJS to PostgreSQL with a repository

#### Concept

Now we connect the API to the database so products persist. We use **TypeORM**, an ORM (Object-Relational Mapper) that lets you work with database rows as TypeScript objects. You define an **entity** (a class mapped to a table), and TypeORM gives you a **repository** with methods like `find`, `findOne` and `save` that generate the SQL for you. The service uses the repository instead of an in-memory array.

#### Why does it exist?

Writing raw SQL for every operation and manually mapping rows to objects is repetitive and error-prone. An ORM handles the common cases — insert this object, find by id, update these fields — generating correct, parameterized SQL and mapping rows to typed objects automatically. It lets you stay in TypeScript for straightforward data access while dropping to raw SQL for the complex queries where you need control (Part 15 covers TypeORM and Sequelize in depth, including when to use the query builder or raw SQL).

#### Mental model

The repository is a translator between your TypeScript world (objects) and the database world (rows and SQL). You hand it a product object and say "save this"; it writes the `INSERT`. You say "find the product with this id"; it writes the `SELECT` and hands you back a product object. You think in objects; it thinks in SQL; the entity is the dictionary that maps between the two.

#### How it works — install and configure

```bash
npm install @nestjs/typeorm typeorm pg
```

```ts
// src/app.module.ts -- wire TypeORM to PostgreSQL using config from .env
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './products/product.entity';
import { ProductsModule } from './products/products.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT ?? 5432),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      entities: [Product],
      synchronize: true,   // AUTO-CREATE tables from entities -- DEV ONLY, see below
    }),
    ProductsModule,
  ],
})
export class AppModule {}
```

A critical warning on `synchronize: true`: it makes TypeORM automatically change your database schema to match your entities, which is convenient in development but dangerous in production, where it can drop columns and lose data. In production you use **migrations** (versioned, reviewed schema change scripts, Part 31) and set `synchronize: false`. Learn it now so you never ship `synchronize: true`.

#### The entity

```ts
// src/products/product.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('products')                            // maps to the "products" table
export class Product {
  @PrimaryGeneratedColumn('uuid')              // id uuid PRIMARY KEY DEFAULT gen_random_uuid()
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'integer', name: 'price_cents' })  // maps to the price_cents column
  priceCents!: number;

  @Column({ type: 'char', length: 3, default: 'USD' })
  currency!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
```

The entity is the TypeScript mirror of the table. Each `@Column` maps a class property to a database column. Note `name: 'price_cents'` maps the camelCase TypeScript property to the snake_case database column — a common convention (Part 69 on mapping).

#### The repository in the service

```ts
// src/products/products.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product.entity';
import { CreateProductDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product) private readonly repo: Repository<Product>,
  ) {}

  async findAll(): Promise<Product[]> {
    // In a real API this is paginated (Part 71); kept simple here.
    return this.repo.find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.repo.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const product = this.repo.create({
      name: dto.name,
      priceCents: dto.priceCents,
      currency: dto.currency ?? 'USD',
    });
    return this.repo.save(product);   // generates the INSERT ... RETURNING
  }
}
```

```ts
// src/products/products.module.ts -- register the entity's repository
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './product.entity';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product])],  // makes the Product repository injectable
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
```

That is the whole vertical slice. The async code (Part 70), the typed objects (Part 69), the HTTP layer (Part 71), and now persistence are all connected. `this.repo.save(product)` generates a parameterized `INSERT` and returns the saved row with its generated id and timestamp; `this.repo.findOne({ where: { id } })` generates a parameterized `SELECT`. The SQL is safe (parameterized) and typed (returns `Product` objects).

#### Practical example — end to end with persistence

```bash
# create a product; it is now stored in PostgreSQL
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Dental Probe","priceCents":899}'
# 201 Created with a real id and createdAt

# restart the server (Ctrl+C, npm run start:dev) -- the product is still there:
curl http://localhost:3000/products
# the probe is returned, because it lives in the database, not memory

# fetch a missing product:
curl http://localhost:3000/products/00000000-0000-0000-0000-000000000000
# 404 Not Found: "Product ... not found"

# verify directly in the database:
docker exec -it shop-db psql -U shop -d shop -c "SELECT name, price_cents FROM products;"
```

Restarting the server and still seeing the product is the moment persistence becomes real: the data lives in PostgreSQL, independent of any one server process. That is the difference between a toy and a backend.

#### Edge cases & failure modes

- **`synchronize: true` in production** can drop columns and destroy data on a schema change; use migrations (Part 31) and `synchronize: false`.
- **No database connection** (wrong config, database down) makes the app fail to start or every request error; validate config and handle connection errors (Part 13).
- **Connection pool exhaustion** under load if too many queries run at once (Part 13); the pool has a limit and requests queue beyond it.
- **N+1 queries** when loading related data naively (Part 15) — a classic ORM performance trap.
- **Returning the raw entity** exposes every column; map to a response shape if any field is internal (Part 69).
- **Large `findAll` with no pagination** can try to load millions of rows; always paginate list endpoints (Part 71).

#### How a Senior Backend Engineer thinks about this

A senior uses the ORM for the common cases and keeps a clear line to raw SQL for complex or performance-critical queries, never treating the ORM as a black box. They never ship `synchronize: true`; schema changes go through reviewed migrations so production data is safe. They paginate every list, watch for N+1 query patterns, and are mindful of the connection pool under load. They push invariants into the database as constraints even when the ORM also validates, because the database is the last line of defense. And they keep the layering clean — controller to service to repository — so each layer is testable and the data access is isolated in one place.

#### Common mistakes

- Shipping `synchronize: true` to production and losing data on a schema change.
- Treating the ORM as magic and never understanding the SQL it runs.
- Unpaginated list endpoints that try to load huge tables.
- N+1 queries from naive related-data loading.
- Returning raw entities and leaking internal columns.

#### Interview questions

1. **What is an ORM and what does a repository give you?** An Object-Relational Mapper maps database rows to typed objects; the repository provides methods (`find`, `findOne`, `save`) that generate parameterized SQL so you work in objects for common cases.
2. **Why is `synchronize: true` dangerous in production?** It auto-alters the schema to match entities and can drop columns and lose data; production schema changes must go through reviewed migrations.
3. **How does using an ORM help prevent SQL injection?** It generates parameterized queries, sending values separately from the SQL text, so input cannot be executed as code.
4. **Why should list endpoints be paginated even with an ORM?** An unpaginated query can try to load an entire large table into memory, exhausting resources; pagination bounds the result.
5. **What is the N+1 query problem?** Loading a list and then issuing a separate query per item for related data, turning one logical read into many queries; it is a common ORM performance trap.

#### Practical exercise

Wire TypeORM to your PostgreSQL container, define the `Product` entity, implement the service with the repository, and verify end to end: create a product via `curl`, restart the server, and confirm the product persists. Then query the row directly in `psql` to confirm the ORM wrote what you expected. Finally, set `synchronize: false` and explain what you would need to do instead (a migration) to change the schema safely. Acceptance criteria: products persist across restarts, the database row matches the API response, and you can articulate why `synchronize: true` is unsafe for production.

## 74.4 Where to go next

### 74.4.1 You have built a backend — now deepen each layer

#### Concept

You now have a working, persistent, validated REST API with clean layering. That is a genuine backend, not a toy. Every system in the rest of this book is this same shape — controllers, services, repositories, a database — scaled up, hardened, and made reliable. This closing section maps what you built to the deep-dive Parts so you know where to go to make each piece production-grade.

#### How it works — the map

```text
What you built here          Where it goes deep
-------------------------    --------------------------------------------------
NestJS structure             Part 6 (architecture, dependency injection)
REST endpoints & status      Part 8 (API design), Part 71 (HTTP)
DTO validation & security    Part 23 (security, validation, injection, mass assignment)
PostgreSQL & SQL             Parts 11-14 (SQL, indexes, query plans, transactions)
TypeORM repository           Part 15 (TypeORM and Sequelize in depth)
Schema changes (migrations)  Part 31 (migrations), Part 32 (compatibility)
Testing this API             Part 24 (unit and integration testing)
Running it in production      Parts 26-29 (Docker, Kubernetes, cloud, CI/CD)
Making it reliable           Parts 36-38 (debugging, observability, resilience)
Scaling it                   Parts 16-20 (caching, queues, async processing)
```

#### A short list of what to add next, in order

To take this products API from "works on my laptop" toward production, the natural next steps, each covered in a later Part:

1. **Pagination** on the list endpoint (Part 71, Part 8) — never return an unbounded list.
2. **Tests** (Part 24) — unit-test the service, integration-test the endpoints against a test database.
3. **Migrations** (Part 31) — replace `synchronize` with versioned schema changes.
4. **Error handling and logging** (Part 36) — structured logs, a consistent error format, a request id.
5. **Authentication** (Part 21) — who can create products?
6. **Caching** (Part 16) — cache hot reads in Redis.
7. **Containerization and deployment** (Parts 26 to 29) — Docker image, CI/CD pipeline, run it on real infrastructure.
8. **Observability** (Part 35) — metrics, traces and dashboards so you can see how it behaves in production.

#### How a Senior Backend Engineer thinks about this

A senior sees this small API and the largest system they have ever built as the same thing at different scales: requests come in, are validated, are processed by logic that is kept separate from the HTTP layer, and are persisted to a store with real guarantees. The additions — caching, queues, multiple services, replication, observability — are responses to specific pressures (load, reliability, team size), added when the pressure is real, not by default. The discipline you practiced here — thin controllers, validated input, clean layering, understanding the SQL, keeping secrets and schema changes safe — is the same discipline that keeps a system with a thousand engineers maintainable. Master the small version and the large version is familiar.

#### Common mistakes

- Thinking production systems are a different kind of thing; they are this, hardened and scaled.
- Adding complexity (microservices, queues, caches) before there is a real need for it (Part 5 on choosing an architecture).
- Skipping the fundamentals (tests, migrations, observability) because the happy path works.

#### Interview questions

1. **What is the basic shape of a backend request, from HTTP to storage?** Request arrives, is validated at the boundary, is handled by a service (business logic, no HTTP knowledge), which uses a repository to persist to or read from the database, and a response is returned with an appropriate status code.
2. **What would you add to a working CRUD API to make it production-ready, and in what order?** Pagination, tests, migrations, structured logging and error handling, authentication, then caching, deployment and observability as load and reliability needs grow.
3. **Why not start with microservices, queues and caching?** They add operational complexity that should be justified by real pressure (load, team size, reliability); the simplest architecture that meets the requirement wins (Part 5).

#### Practical exercise

Take your products API and add one production step from the list: implement cursor-based pagination on the list endpoint (Part 71), returning a bounded page and a `nextCursor`. Then write one unit test for the service's `findOne` that asserts it throws `NotFoundException` for a missing id. Acceptance criteria: the list endpoint never returns more than the page size, and the test passes, giving you a first taste of the hardening steps the rest of the book covers.

## Senior Checklist — Part 74

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
- [ ] I can scaffold a NestJS app and keep controllers thin, logic in services
- [ ] I validate all input with DTOs and a global ValidationPipe (whitelist on)
- [ ] I can write the four basic SQL statements and know why parameterization matters
- [ ] I can connect NestJS to PostgreSQL via a TypeORM entity and repository
- [ ] I know why synchronize:true is unsafe in production and what migrations are for
- [ ] I can trace a request from HTTP through validation, service and repository to the database
- [ ] I know which later Parts harden each layer for production

## Part 74 — Key Takeaways

- A backend is a loop: receive a request, validate it, run logic (kept separate from HTTP), persist to a store with real guarantees, return a response with the right status code.
- NestJS organizes this into thin controllers (HTTP), services (logic), and repositories (data); keeping them separate makes everything testable and uniform.
- Validate every incoming request with a DTO and a global `ValidationPipe`; `whitelist` and `forbidNonWhitelisted` block injected fields for free.
- Understand the SQL even when an ORM writes it; parameterize always (never concatenate user input), and push invariants into the database as constraints.
- Connect NestJS to PostgreSQL with a TypeORM entity and repository; you work in typed objects while the ORM generates safe, parameterized SQL.
- Never ship `synchronize: true`; production schema changes go through reviewed migrations (Part 31).
- Persistence is what makes it a backend: data lives in the database, surviving restarts and shared across every server instance.
- Production systems are this same shape, hardened and scaled; add complexity (caching, queues, services) only when real pressure demands it.
- The discipline practiced here — thin controllers, validated input, clean layering, safe SQL and schema, secrets out of git — is the same discipline that keeps large systems maintainable.
- Volume 0 is complete: you can now build and run a small correct backend, which is the foundation every later Part builds on.
