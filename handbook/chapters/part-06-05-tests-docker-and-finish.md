## 6.7 Step 3: Tests

### 6.7.1 A unit test for the service and an end-to-end test for the API

#### Concept

A **test** is code that runs your code and checks the result automatically. We write two kinds. A **unit test** checks one piece (the `ProductsService`) on its own, with the database replaced by a small fake, so it runs in milliseconds. An **end-to-end (e2e) test** starts the whole NestJS application, sends real HTTP requests to it with **supertest**, and lets it talk to a real PostgreSQL test database, so it checks that all the layers work together. NestJS projects come with **Jest** (the test runner) and supertest already set up by `nest new`.

#### Why does it exist?

Because every change can break something that used to work, and checking by hand with `curl` after every change is slow and gets skipped. With tests, `npm test` checks 30 behaviours in a few seconds, every time, and CI (Part 46) runs them on every pull request (Part 5). Tests are also the fastest way to know your validation and error work from 6.5 and 6.6 actually does what you think.

#### Mental model

Imagine a car factory. A unit test is the bench where a single brake pad is pressed against a gauge: fast, precise, but it says nothing about the whole car. The e2e test is the test track: the whole car, real road, real brakes. You need many bench tests and a few laps of the track.

#### How it works

**Unit test.** NestJS's `Test.createTestingModule` builds a small module for the test. We provide the real `ProductsService` and replace its repository with a fake object, using `getRepositoryToken(Product)`, the same token `@InjectRepository(Product)` asks for:

```ts
// src/products/products.service.spec.ts  (Jest 29, @nestjs/testing 10)
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Product } from './product.entity';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  let service: ProductsService;
  const repo = {
    findOne: jest.fn(),
    create: jest.fn((data: Partial<Product>) => data),     // returns what it was given
    save: jest.fn(async (p: Partial<Product>) => ({ id: 'p1', createdAt: new Date(), ...p })),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [ProductsService, { provide: getRepositoryToken(Product), useValue: repo }],
    }).compile();
    service = moduleRef.get(ProductsService);
  });

  it('throws NotFoundException with a code for a missing product', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.findOne('missing-id')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOne('missing-id')).rejects.toMatchObject({ response: { code: 'PRODUCT_NOT_FOUND' } });
  });

  it('defaults the currency to USD on create', async () => {
    const product = await service.create({ name: 'Dental Mirror', priceCents: 1299, sku: 'DM-001' });
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(product.currency).toBe('USD');
  });

  it('returns 404 semantics when deleting nothing', async () => {
    repo.delete.mockResolvedValue({ affected: 0, raw: [] });
    await expect(service.remove('missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

Run it with `npm test`. Jest finds files ending in `.spec.ts` under `src/`.

**E2E test.** The e2e test uses a separate database, `shop_test`, so tests can delete data freely. Create it once in the PostgreSQL container from 6.1:

```bash
docker exec -it shop-db psql -U shop -d shop -c 'CREATE DATABASE shop_test;'
```

The test database name must be set **before** `AppModule` is imported, because `TypeOrmModule.forRoot({...})` reads `process.env` when the module file loads. A Jest setup file does that; `dotenv` and `ConfigModule` never overwrite a variable that is already set:

```ts
// test/setup-env.ts  (listed in test/jest-e2e.json as "setupFiles": ["<rootDir>/setup-env.ts"])
process.env.DATABASE_NAME = 'shop_test';
```

The test builds the real `AppModule`, applies `configureApp` (6.6) so pipes and filters are exactly as in production, and empties the table before each test:

```ts
// test/products.e2e-spec.ts  (run with: npm run test:e2e)
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';                  // the form the Nest 10 template uses
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

describe('Products API (e2e)', () => {
  let app: INestApplication;
  let db: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    db = app.get(DataSource);
  });

  beforeEach(() => db.query('TRUNCATE TABLE products'));   // every test starts with an empty table
  afterAll(() => app.close());

  const valid = { name: 'Dental Mirror', priceCents: 1299, sku: 'DM-001' };

  it('creates a product and reads it back', async () => {
    const created = await request(app.getHttpServer()).post('/products').send(valid).expect(201);
    expect(created.body).toMatchObject({ name: 'Dental Mirror', priceCents: 1299, currency: 'USD' });
    await request(app.getHttpServer()).get(`/products/${created.body.id}`).expect(200);
  });

  it('rejects a negative price with VALIDATION_FAILED and a field path', async () => {
    const res = await request(app.getHttpServer()).post('/products').send({ ...valid, priceCents: -5 }).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', issues: [{ path: 'priceCents' }] });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it('returns 409 PRODUCT_SKU_TAKEN for a duplicate SKU', async () => {
    await request(app.getHttpServer()).post('/products').send(valid).expect(201);
    const res = await request(app.getHttpServer()).post('/products').send({ ...valid, name: 'Copy' }).expect(409);
    expect(res.body.code).toBe('PRODUCT_SKU_TAKEN');
  });

  it('pages through products with a cursor, without repeats', async () => {
    for (let i = 1; i <= 5; i++) {
      await request(app.getHttpServer()).post('/products').send({ ...valid, sku: `DM-00${i}` }).expect(201);
    }
    const first = await request(app.getHttpServer()).get('/products?limit=3').expect(200);
    const second = await request(app.getHttpServer()).get(`/products?limit=3&cursor=${first.body.nextCursor}`).expect(200);
    const ids = [...first.body.items, ...second.body.items].map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(5);                 // all five, none twice
    expect(second.body.nextCursor).toBeNull();
  });
});
```

`TRUNCATE` here only works because `synchronize: true` created the table in the test database; 6.8 replaces that with a migration, and the test then runs migrations in `beforeAll`.

#### Practical example — a failing test finds a bug

You change `findOne` to use `this.repo.findOneBy({ id })` and accidentally drop the `if (!product)` line while refactoring. You run the tests:

```text
$ npm test
 FAIL  src/products/products.service.spec.ts
  ProductsService
    ✕ throws NotFoundException with a code for a missing product (6 ms)
    ✓ defaults the currency to USD on create (2 ms)
    ✓ returns 404 semantics when deleting nothing (1 ms)

  ● ProductsService › throws NotFoundException with a code for a missing product
    expect(received).rejects.toBeInstanceOf(expected)
    Received promise resolved instead of rejected
    Resolved to value: null
```

Without the test, `GET /products/<missing>` would have returned `200` with an empty body, and a frontend would have shown a blank page. With it, the mistake was caught in 6 milliseconds, before a commit.

#### Edge cases & failure modes

- **Tests against the development database** delete your data with `TRUNCATE`; always use a separate test database.
- **Different wiring in tests and production**: tests that skip `configureApp` pass with errors that look different in production; share one function (Part 140.10 makes the same point for contract tests).
- **Tests that depend on each other's data** fail randomly when run in another order; reset state in `beforeEach`.
- **Mocking too much**: a unit test with every method mocked tests the mocks; keep e2e tests for the real wiring (Part 75.5 discusses what to mock).
- **Slow e2e tests** from creating the app per test; create it once in `beforeAll`.
- **Forgetting `await`** on supertest calls: the test ends before the request does and passes without checking anything.

#### How a Senior Backend Engineer thinks about this

A senior writes a few fast unit tests for real logic and a handful of e2e tests for the important paths through the real stack, and makes the error contract part of what the tests assert: status, code, field path and request ID. They run tests against a real PostgreSQL rather than mocking the database for e2e, because constraints like the unique SKU only exist in the real thing (Part 75.7 uses Testcontainers for this). They make tests start from a known state and wire the app the same way as production. And they add a test for every bug they fix, so it cannot return.

#### Common mistakes

- Testing only the happy path.
- E2E tests against the development database.
- Not using `configureApp` in tests.
- Writing tests after the feature ships, or never.

#### Interview questions

1. **What is the difference between a unit test and an e2e test here?** The unit test runs the service alone with a fake repository in milliseconds; the e2e test runs the whole app over HTTP against a real database.
2. **How do you replace a TypeORM repository in a NestJS unit test?** Provide `{ provide: getRepositoryToken(Product), useValue: fake }` in `Test.createTestingModule`.
3. **Why use a real database in e2e tests?** Constraints, SQL and the ORM's real behaviour only exist there; a duplicate SKU `409` cannot be tested with a fake.
4. **How do you keep e2e tests independent?** Reset the data before each test (`TRUNCATE`), never rely on another test's records.

#### Practical exercise

Write the unit and e2e tests above, then add your own.

Acceptance criteria:

- `npm test` runs at least 5 unit tests in under 2 seconds; `npm run test:e2e` runs at least 8 e2e tests against `shop_test`.
- E2E tests cover: create, get, update, delete, a validation error with a field path, a bad UUID, a duplicate SKU, and pagination without repeats.
- Every error test asserts `code` and `requestId`, not the English `title`.
- Deleting the unique constraint from the entity makes the duplicate-SKU test fail.

## 6.8 Step 4: Running everything with Docker

### 6.8.1 A Dockerfile, a first migration and Docker Compose

#### Concept

So far the API runs with `npm run start:dev` on your laptop, next to a PostgreSQL container started by hand. In this step we package the API itself as a **Docker image**, replace `synchronize: true` with a **migration**, and describe both containers in one **Docker Compose** file, so anyone can start the whole system with one command: `docker compose up`. Part 43 — Docker for Backend Engineers explains every piece in depth; here we build a first working version.

#### Why does it exist?

Because "it works on my machine" is not a deployment plan. A new teammate should not need the right Node version, the right PostgreSQL version and a page of setup steps; a CI server (Part 46) should run exactly what production runs. An image packages your built code with the exact Node runtime it needs. Compose describes how the API and the database start together. And a migration makes schema changes explicit, reviewed and repeatable, instead of letting the ORM guess (6.3).

#### Mental model

Imagine shipping a ready meal instead of a recipe. The recipe (your source code plus "install Node 22, run npm ci, build") can go wrong in every kitchen. The ready meal (the image) is cooked once and sealed; any oven that can heat it (any machine with Docker) gets the same dish. Compose is the menu card that says which dishes are served together and in what order.

#### How it works

**A first migration.** A migration is a versioned file with the SQL to change the schema (`up`) and to undo it (`down`). TypeORM's CLI generates one by comparing your entities with the database. It needs a `DataSource` file that describes the connection:

```ts
// src/data-source.ts: used by the TypeORM CLI and by the app
import 'dotenv/config';                                 // load .env when the CLI runs (npm i dotenv)
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Product } from './products/product.entity';

export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  username: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  entities: [Product],
  // From source (CLI, tests) load .ts files; from dist/ load only .js, never the .d.ts files the build emits
  migrations: [join(__dirname, 'migrations', __filename.endsWith('.ts') ? '*.ts' : '*.js')],
  synchronize: false,                                   // from now on, only migrations change the schema
});
```

```json
{
  "scripts": {
    "typeorm": "typeorm-ts-node-commonjs -d src/data-source.ts",
    "migration:generate": "npm run typeorm -- migration:generate",
    "migration:run": "npm run typeorm -- migration:run"
  }
}
```

```bash
docker exec -it shop-db psql -U shop -d shop -c 'DROP TABLE IF EXISTS products;'   # start clean (dev data only!)
npm run migration:generate -- src/migrations/CreateProducts
# Migration .../src/migrations/1730800000000-CreateProducts.ts has been generated successfully.
```

The generated file contains the SQL TypeORM will run. Read it before committing, as you would read any code:

```ts
// src/migrations/1730800000000-CreateProducts.ts (generated, abridged)
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProducts1730800000000 implements MigrationInterface {
  name = 'CreateProducts1730800000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" text NOT NULL,
      "price_cents" integer NOT NULL, "currency" character(3) NOT NULL DEFAULT 'USD', "sku" text NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "UQ_products_sku" UNIQUE ("sku"), CONSTRAINT "PK_products_id" PRIMARY KEY ("id"))`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "products"`);
  }
}
```

The generator does not know about the `CHECK (price_cents >= 0)` constraint from 6.3, because the entity does not declare it. Add it yourself in `up`: `ALTER TABLE "products" ADD CONSTRAINT "chk_price_non_negative" CHECK ("price_cents" >= 0)`. Generated migrations are a starting point, not a finished product.

The app module now uses the same settings and runs pending migrations at start-up:

```ts
// src/app.module.ts (TypeORM part)
TypeOrmModule.forRoot({
  ...dataSource.options,                 // import dataSource from './data-source'
  migrationsRun: true,                   // apply pending migrations when the app starts
}),
```

Running migrations at start-up is fine for one instance. With several instances starting at once, teams run migrations as a separate step before the new version starts (Part 23, and Part 143.11 shows it in a test stack).

**The Dockerfile.** A **multi-stage build** (Part 86.6) compiles TypeScript in a first stage that has all the build tools, then copies only the compiled code and production dependencies into a small final image:

```dockerfile
# Dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci                                  # exact versions from package-lock.json (72.6)
COPY . .
RUN npm run build && npm prune --omit=dev   # compile to dist/, then drop dev dependencies

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node                                   # do not run as root (72.2)
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

```text
# .dockerignore: keep the build context small and secrets out of the image
node_modules
dist
.env
.git
coverage
```

**Docker Compose.** One file starts PostgreSQL, waits until it is ready, then starts the API:

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: shop_dev_password
      POSTGRES_DB: shop
    volumes:
      - db-data:/var/lib/postgresql/data      # data survives docker compose down (not down -v)
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shop -d shop"]
      interval: 2s
      retries: 30

  api:
    build: .
    environment:
      DATABASE_HOST: db                       # the service name: Compose's network resolves it (Part 86.7)
      DATABASE_PORT: "5432"
      DATABASE_USER: shop
      DATABASE_PASSWORD: shop_dev_password
      DATABASE_NAME: shop
      PORT: "3000"
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy            # start only when PostgreSQL accepts connections
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 5s
      retries: 12

volumes:
  db-data:
```

#### Practical example — the whole system in three commands

```bash
docker stop shop-db                            # the hand-started database from 74.1 would hold port 5432
docker compose up --build -d                   # build the API image, start db then api, in the background
docker compose ps
# NAME                 SERVICE  STATUS                   PORTS
# products-api-db-1    db       Up 12 seconds (healthy)  5432/tcp
# products-api-api-1   api      Up 6 seconds (healthy)   0.0.0.0:3000->3000/tcp

curl -s -X POST http://localhost:3000/products -H 'Content-Type: application/json' \
  -d '{"name":"Dental Mirror","priceCents":1299,"sku":"DM-001"}' | jq '{id, sku}'
docker compose logs api | tail -n 5            # the app's logs, including "Migration CreateProducts... has been executed"
docker compose down                            # stop everything; the db-data volume keeps the products
```

`docker image ls` shows the API image at roughly 200 MB (the Node runtime is most of it); the source code, `.env` and dev dependencies are not in it.

#### Edge cases & failure modes

- **`localhost` inside a container** means that container; the API reaches the database at `db`, the Compose service name.
- **Starting before the database is ready**: without the health check and `condition: service_healthy`, the API crashes with "connection refused" on the first start.
- **Secrets in the image**: a missing `.dockerignore` copies `.env` into the image, where anyone with the image can read it.
- **`synchronize: true` left on** alongside migrations makes the ORM change the schema behind the migrations' back; set it to `false`.
- **`docker compose down -v`** deletes the volume and all its data; fine for development, never on a real database.
- **Apple Silicon versus x86 servers**: images built on an ARM laptop may not run on an x86 server; build in CI (Part 86.15) or use `--platform`.
- **Port 3000 or 5432 already used** by an old process or container (4.10): stop it first.

#### How a Senior Backend Engineer thinks about this

A senior wants the whole system to start from a clean machine with one command, because that is what makes onboarding, CI and production boring. They build small images with multi-stage builds, run as a non-root user, keep secrets out of images, and gate start-up on real health checks. They treat migrations as code: generated, read, completed by hand where needed, committed and reviewed. And they know this Compose file is a development and test setup; production adds managed databases, secrets from a secret manager and an orchestrator (Parts 44, 45).

#### Common mistakes

- No `.dockerignore`, so `node_modules` and `.env` end up in the image.
- Running the container as root.
- No health checks, so start-up order is luck.
- Trusting generated migrations without reading them.

#### Interview questions

1. **Why a multi-stage Dockerfile for a NestJS app?** The build stage has compilers and dev dependencies; the final image has only compiled code and production dependencies, so it is smaller and safer.
2. **How does the API container find the database in Compose?** By the service name (`db`) on the network Compose creates.
3. **Why replace `synchronize: true` with migrations before running in containers?** Migrations are explicit, reviewed, versioned schema changes that run the same way everywhere; synchronize can drop data.
4. **What does `depends_on` with `condition: service_healthy` add?** The API starts only after PostgreSQL's health check passes, not merely after its container starts.

#### Practical exercise

Containerise your API.

Acceptance criteria:

- `docker compose up --build` on a machine with only Docker installed starts both services, and both show `(healthy)`.
- `synchronize` is `false`; the schema comes from a committed migration that includes the price `CHECK` constraint.
- The final image runs as the `node` user and contains no `.env` file (check with `docker run --rm --entrypoint ls <image> -la /app`).
- After `docker compose down` and `up` again, previously created products are still there.
- The e2e tests from 6.7 pass against the database in Compose (port 5432 published, `DATABASE_NAME=shop_test`).

## 6.9 Putting it together: the finished project

### 6.9.1 One request through every layer, and what you have built

#### Concept

You started this Part with a hello endpoint. You now have a small but genuine backend: validated inputs on every door, cursor pagination, consistent errors with request IDs, a unique constraint enforced by the database, unit and e2e tests, a migration, and a Docker setup that starts everything with one command. This section follows one request through all of it and lists the finished project's files, so you can see the whole shape at once.

#### How it works — one request, end to end

`POST /products` with a duplicate SKU, inside Docker Compose:

```text
curl (your laptop)
  -> port 3000 published by Compose -> api container, node dist/main.js
  -> RequestIdMiddleware: X-Request-Id 5c2e... assigned            (74.6)
  -> ValidationPipe: body matches CreateProductDto, whitelisted      (74.2, 74.6)
  -> ProductsController.create: thin, calls the service             (74.2)
  -> ProductsService.create: repo.create + repo.save                 (74.3)
  -> TypeORM: INSERT INTO "products" (...) VALUES ($1, ...) RETURNING ...
  -> db container, PostgreSQL 17: unique constraint UQ_products_sku violated, error 23505
  -> ApiExceptionFilter: 409, code PRODUCT_SKU_TAKEN, issues[sku]   (74.6)
  -> logger: WARN request failed requestId=5c2e... code=PRODUCT_SKU_TAKEN
  <- 409 application/problem+json { status, code, issues, requestId }
```

Every layer has one job, and each job was added in one step of this Part. The e2e test "returns 409 PRODUCT_SKU_TAKEN for a duplicate SKU" (6.7) proves this whole path in about 30 milliseconds.

#### The finished project

```text
products-api/
├── Dockerfile, .dockerignore, docker-compose.yml          74.8
├── .env (gitignored), .env.example                         74.1
├── src/
│   ├── main.ts, configure-app.ts                           74.1, 74.6
│   ├── app.module.ts                                       74.1, 74.3, 74.6, 74.8
│   ├── data-source.ts, migrations/                         74.8
│   ├── config/env.validation.ts                            74.5
│   ├── common/request-id.middleware.ts                     74.6
│   ├── common/validation.ts, common/api-exception.filter.ts 74.6
│   └── products/
│       ├── products.module.ts, products.controller.ts      74.2, 74.5
│       ├── products.service.ts, products.service.spec.ts   74.3, 74.5, 74.7
│       ├── product.entity.ts, cursor.ts                    74.3, 74.5, 74.6
│       └── dto/ create-product.dto.ts, update-product.dto.ts, list-products.query.ts
└── test/products.e2e-spec.ts                               74.7
```

Compare it with the tiny products API without a framework in Part 131.7: the same idea (receive, validate, store, respond), now with structure, guarantees and tests.

#### How a Senior Backend Engineer thinks about this

A senior would recognise this project as a sound starting point, and would also see exactly what is missing for production: authentication (Part 39), idempotency for retried creates (Part 14.12), structured JSON logs, metrics and traces (Part 42), a CI pipeline that runs the tests and builds the image (Part 46), and migrations run as a separate deploy step (Part 23). None of those require changing the shape you built. That is the point of getting the shape right first.

#### Practical exercise

The capstone for Volume 0: extend the project with one new resource, `categories`, and link products to it.

Acceptance criteria:

- A `categories` table created by a new migration, with a unique `slug`, and a `category_id` foreign key on `products` (Part 16.5 explains foreign keys).
- `POST /categories`, `GET /categories`, and `GET /products?category=<slug>` with the same cursor pagination as 6.5.
- Every error uses the shape from 6.6; creating a product with an unknown category returns `422` with `code: "CATEGORY_NOT_FOUND"` and `issues[0].path` equal to `categoryId`.
- Unit and e2e tests for the new endpoints pass, and the whole system starts with `docker compose up --build`.
- The work is done on a branch, in focused commits, merged through a pull request (Part 133.11).

## Senior Checklist — Part 6

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
- [ ] I validate query strings, path parameters and configuration, not only bodies, and bound every limit
- [ ] I can implement cursor pagination with a unique tie-breaker
- [ ] I return one error shape with stable codes, field paths and a request ID, and never leak internals
- [ ] I let the database enforce uniqueness and map its error to a clear 409
- [ ] I can write a NestJS unit test with a fake repository and an e2e test with supertest against a real test database
- [ ] I can generate, read and complete a TypeORM migration
- [ ] I can run the API and PostgreSQL with a multi-stage Dockerfile and Docker Compose with health checks

## Part 6 — Key Takeaways

- A backend is a loop: receive a request, validate it, run logic (kept separate from HTTP), persist to a store with real guarantees, return a response with the right status code.
- NestJS organizes this into thin controllers (HTTP), services (logic), and repositories (data); keeping them separate makes everything testable and uniform.
- Validate every incoming request with a DTO and a global `ValidationPipe`; `whitelist` and `forbidNonWhitelisted` block injected fields for free.
- Understand the SQL even when an ORM writes it; parameterize always (never concatenate user input), and push invariants into the database as constraints.
- Connect NestJS to PostgreSQL with a TypeORM entity and repository; you work in typed objects while the ORM generates safe, parameterized SQL.
- Never ship `synchronize: true`; production schema changes go through reviewed migrations (Part 23).
- Persistence is what makes it a backend: data lives in the database, surviving restarts and shared across every server instance.
- Every input is a door: bodies, paths, query strings and configuration all need validation and bounds.
- Errors are part of the API: one shape, stable codes, field paths, a request ID, and no internals in responses.
- Tests turn "I checked it with curl once" into "it is checked on every change"; use a real database for e2e.
- One `docker compose up` that starts everything is the difference between a project and a recipe.
- Production systems are this same shape, hardened and scaled; add complexity (caching, queues, services) only when real pressure demands it.
- The discipline practiced here — thin controllers, validated input, clean layering, safe SQL and schema, secrets out of git — is the same discipline that keeps large systems maintainable.
- Volume 0 is complete: you can now build, test and run a small correct backend, which is the foundation every later Part builds on.
