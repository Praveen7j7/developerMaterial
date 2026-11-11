## 6.7 Step 3: Tests

### 6.7.1 A unit test for the service and an end-to-end test for the API

#### Concept

A **test** is code that runs your code and checks the result automatically. We write two kinds. A **unit test** checks one piece (the `ProductsService`) on its own, with the database replaced by a small fake, so it runs in milliseconds. An **end-to-end (e2e) test** starts the whole NestJS application, sends real HTTP requests to it with **supertest**, and lets it talk to a real PostgreSQL test database, so it checks that all the layers work together. NestJS projects come with **Jest** (the test runner) and supertest already set up by `nest new`.

#### Why does it exist?

Because every change can break something that used to work, and checking by hand with `curl` after every change is slow and gets skipped. With tests, `npm test` checks 30 behaviours in a few seconds, every time, and CI (Part 47) runs them on every pull request (Part 5). Tests are also the fastest way to know your validation and error work from 6.5 and 6.6 actually does what you think.

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
- **Different wiring in tests and production**: tests that skip `configureApp` pass with errors that look different in production; share one function (Part 76.10 makes the same point for contract tests).
- **Tests that depend on each other's data** fail randomly when run in another order; reset state in `beforeEach`.
- **Mocking too much**: a unit test with every method mocked tests the mocks; keep e2e tests for the real wiring (Part 41.5 discusses what to mock).
- **Slow e2e tests** from creating the app per test; create it once in `beforeAll`.
- **Forgetting `await`** on supertest calls: the test ends before the request does and passes without checking anything.

#### How a Senior Backend Engineer thinks about this

A senior writes a few fast unit tests for real logic and a handful of e2e tests for the important paths through the real stack, and makes the error contract part of what the tests assert: status, code, field path and request ID. They run tests against a real PostgreSQL rather than mocking the database for e2e, because constraints like the unique SKU only exist in the real thing (Part 41.7 uses Testcontainers for this). They make tests start from a known state and wire the app the same way as production. And they add a test for every bug they fix, so it cannot return.

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

#### Worked answer to the exercise

**Unit tests: three more, for six in total.** Add these inside the `describe('ProductsService', ...)` block above; they reuse its `repo` fake and `beforeEach`:

```ts
it('returns the product when it exists', async () => {
  const stored = { id: 'p1', name: 'Dental Mirror', priceCents: 1299, currency: 'USD', sku: 'DM-001' };
  repo.findOne.mockResolvedValue(stored);
  await expect(service.findOne('p1')).resolves.toEqual(stored);
  expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'p1' } });
});

it('update changes only the fields it was given', async () => {
  repo.findOne.mockResolvedValue({ id: 'p1', name: 'Dental Mirror', priceCents: 1299, currency: 'USD', sku: 'DM-001' });
  const updated = await service.update('p1', { priceCents: 1499 });
  expect(updated).toMatchObject({ name: 'Dental Mirror', priceCents: 1499, sku: 'DM-001' });
  expect(repo.save).toHaveBeenCalledTimes(1);
});

it('remove resolves when one row was deleted', async () => {
  repo.delete.mockResolvedValue({ affected: 1, raw: [] });
  await expect(service.remove('p1')).resolves.toBeUndefined();
});
```

**E2E tests: four more, for eight in total.** First a helper, so every error test asserts the contract the same way:

```ts
// test/products.e2e-spec.ts (inside the describe block)
const expectProblem = (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  expect(res.body.requestId).toMatch(/^[\w-]{8,64}$/);   // expect.any(String) would also accept ""
};

it('updates a product with PATCH', async () => {
  const { body } = await request(app.getHttpServer()).post('/products').send(valid).expect(201);
  const res = await request(app.getHttpServer()).patch(`/products/${body.id}`).send({ priceCents: 1499 }).expect(200);
  expect(res.body).toMatchObject({ id: body.id, name: 'Dental Mirror', priceCents: 1499 });
});

it('deletes with 204 and no body, then reads 404 PRODUCT_NOT_FOUND', async () => {
  const { body } = await request(app.getHttpServer()).post('/products').send(valid).expect(201);
  const del = await request(app.getHttpServer()).delete(`/products/${body.id}`).expect(204);
  expect(del.text).toBe('');
  expectProblem(await request(app.getHttpServer()).get(`/products/${body.id}`), 404, 'PRODUCT_NOT_FOUND');
});

it('rejects a malformed id with 400', async () => {
  expectProblem(await request(app.getHttpServer()).get('/products/not-a-uuid'), 400, 'BAD_REQUEST');
});

it('returns 404 PRODUCT_NOT_FOUND when deleting a missing product', async () => {
  const res = await request(app.getHttpServer()).delete('/products/9b1d5f8e-0000-4000-8000-000000000000');
  expectProblem(res, 404, 'PRODUCT_NOT_FOUND');
});
```

The last test guards the "inconsistent codes" failure from 6.6. It passes because 6.6 gave `remove` the same coded exception as `findOne`. Prove that it would catch a regression: put back the plain-message line from 6.5 in `remove()`,

```ts
// src/products/products.service.ts, in remove() (temporarily, to watch the test fail)
if (result.affected === 0) throw new NotFoundException(`Product ${id} not found`);
```

and the test fails with `code` `NOT_FOUND` instead of `PRODUCT_NOT_FOUND`, because the exception carries no `code` and the filter falls back to the status name. Restore the coded line from 6.6 and it passes again.

Also switch the existing validation and duplicate-SKU tests to `expectProblem(res, 400, 'VALIDATION_FAILED')` and `expectProblem(res, 409, 'PRODUCT_SKU_TAKEN')`, keeping the `issues` path assertion, so every error test checks `code` and `requestId` and none checks the English `title`.

```text
$ npm test
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Time:        1.38 s
$ npm run test:e2e
 PASS  test/products.e2e-spec.ts
  Products API (e2e)
    ✓ creates a product and reads it back (61 ms)
    ✓ rejects a negative price with VALIDATION_FAILED and a field path (12 ms)
    ✓ returns 409 PRODUCT_SKU_TAKEN for a duplicate SKU (18 ms)
    ✓ pages through products with a cursor, without repeats (47 ms)
    ✓ updates a product with PATCH (15 ms)
    ✓ deletes with 204 and no body, then reads 404 PRODUCT_NOT_FOUND (16 ms)
    ✓ rejects a malformed id with 400 (5 ms)
    ✓ returns 404 PRODUCT_NOT_FOUND when deleting a missing product (7 ms)

Tests:       8 passed, 8 total
```

**Prove the duplicate test can fail.** Remove `unique: true` from `sku` in the entity and run `npm run test:e2e` again. `synchronize: true` drops the constraint in `shop_test`, the second insert succeeds, and supertest reports `expected 409 "Conflict", got 201 "Created"`. Put `unique: true` back and the test is green again. A test you have never seen fail has not yet proved anything.

**The trap.** `expect.any(String)` for the request ID. It matches the empty string, which is exactly what the filter returns when `RequestIdMiddleware` is not registered (`String(undefined ?? '')`). Matching the real format, as the helper does, catches a missing middleware; `expect.any(String)` does not.

## 6.8 Step 4: Running everything with Docker

### 6.8.1 A Dockerfile, a first migration and Docker Compose

#### Concept

So far the API runs with `npm run start:dev` on your laptop, next to a PostgreSQL container started by hand. In this step we package the API itself as a **Docker image**, replace `synchronize: true` with a **migration**, and describe both containers in one **Docker Compose** file, so anyone can start the whole system with one command: `docker compose up`. Part 44 — Docker for Backend Engineers explains every piece in depth; here we build a first working version.

#### Why does it exist?

Because "it works on my machine" is not a deployment plan. A new teammate should not need the right Node version, the right PostgreSQL version and a page of setup steps; a CI server (Part 47) should run exactly what production runs. An image packages your built code with the exact Node runtime it needs. Compose describes how the API and the database start together. And a migration makes schema changes explicit, reviewed and repeatable, instead of letting the ORM guess (6.3).

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
// Constraint names are shown readable for teaching; TypeORM generates hashed names (e.g. "UQ_3a5f...") unless you configure a naming strategy.
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

Running migrations at start-up is fine for one instance. With several instances starting at once, teams run migrations as a separate step before the new version starts (Part 24, and Part 79.11 shows it in a test stack).

**The Dockerfile.** A **multi-stage build** (Part 44.6) compiles TypeScript in a first stage that has all the build tools, then copies only the compiled code and production dependencies into a small final image:

```dockerfile
# Dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci                                  # exact versions from package-lock.json (4.6)
COPY . .
RUN npm run build && npm prune --omit=dev   # compile to dist/, then drop dev dependencies

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Do not run as root (4.2). Comments go on their own line: USER would read a trailing one as part of the user name.
USER node
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
      DATABASE_HOST: db                       # the service name: Compose's network resolves it (Part 44.7)
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
docker stop shop-db                            # the hand-started database from 6.1 would hold port 5432
docker compose up --build -d                   # build the API image, start db then api, in the background
docker compose ps
# NAME                 SERVICE  STATUS                   PORTS
# products-api-db-1    db       Up 12 seconds (healthy)  5432/tcp
# products-api-api-1   api      Up 6 seconds (healthy)   0.0.0.0:3000->3000/tcp

curl -s -X POST http://localhost:3000/products -H 'Content-Type: application/json' \
  -d '{"name":"Dental Mirror","priceCents":1299,"sku":"DM-001"}' | jq '{id, sku}'
docker compose logs api | tail -n 5            # the app's logs; with TypeORM logging on, they include "Migration CreateProducts... has been executed"
docker compose down                            # stop everything; the db-data volume keeps the products
```

`docker image ls` shows the API image at roughly 200 MB (the Node runtime is most of it); the source code, `.env` and dev dependencies are not in it.

#### Edge cases & failure modes

- **`localhost` inside a container** means that container; the API reaches the database at `db`, the Compose service name.
- **Starting before the database is ready**: without the health check and `condition: service_healthy`, the API crashes with "connection refused" on the first start.
- **Secrets in the image**: a missing `.dockerignore` copies `.env` into the image, where anyone with the image can read it.
- **`synchronize: true` left on** alongside migrations makes the ORM change the schema behind the migrations' back; set it to `false`.
- **`docker compose down -v`** deletes the volume and all its data; fine for development, never on a real database.
- **Apple Silicon versus x86 servers**: images built on an ARM laptop may not run on an x86 server; build in CI (Part 44.15) or use `--platform`.
- **Port 3000 or 5432 already used** by an old process or container (4.10): stop it first.

#### How a Senior Backend Engineer thinks about this

A senior wants the whole system to start from a clean machine with one command, because that is what makes onboarding, CI and production boring. They build small images with multi-stage builds, run as a non-root user, keep secrets out of images, and gate start-up on real health checks. They treat migrations as code: generated, read, completed by hand where needed, committed and reviewed. And they know this Compose file is a development and test setup; production adds managed databases, secrets from a secret manager and an orchestrator (Parts 45, 46).

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

#### Worked answer to the exercise

Use the `data-source.ts`, scripts, `Dockerfile`, `.dockerignore` and `docker-compose.yml` from this section, with three completions.

**1. The migration gets its `CHECK` constraint.** In the generated `CreateProducts` migration, add one statement to `up` after the `CREATE TABLE`:

```ts
await queryRunner.query(
  `ALTER TABLE "products" ADD CONSTRAINT "chk_price_non_negative" CHECK ("price_cents" >= 0)`,
);
```

`down` stays `DROP TABLE "products"`, which removes the constraint with the table. Also declare it on the entity with TypeORM's real `@Check` decorator, `@Check('chk_price_non_negative', '"price_cents" >= 0')` above `@Entity('products')`. TypeORM compares `CHECK` constraints too, so without the decorator the next `migration:generate` would propose dropping a constraint the entity does not know about.

**2. Publish the database port** for the e2e tests, under the `db` service:

```yaml
    ports:
      - "5432:5432"                  # only for running tests from the laptop
```

**3. Keep `/health`.** The API's health check calls `GET /health` with `wget`, so the route from 6.1.1 must exist; without it, the API stays `(unhealthy)`.

Now the checks, one per acceptance criterion:

```text
$ docker stop shop-db
$ docker compose up --build -d
$ docker compose ps --format 'table {{.Name}}\t{{.Service}}\t{{.Status}}\t{{.Ports}}'
NAME                 SERVICE   STATUS                    PORTS
products-api-db-1    db        Up 14 seconds (healthy)   0.0.0.0:5432->5432/tcp
products-api-api-1   api       Up 8 seconds (healthy)    0.0.0.0:3000->3000/tcp
$ docker compose exec api whoami
node
$ docker run --rm --entrypoint ls products-api-api -la /app
total 24
drwxr-xr-x    1 root     root          4096 Nov 11 05:51 .
drwxr-xr-x    1 root     root          4096 Nov 11 05:52 ..
drwxr-xr-x    4 root     root          4096 Nov 11 05:51 dist
drwxr-xr-x  212 root     root         12288 Nov 11 05:51 node_modules
-rw-r--r--    1 root     root          1563 Nov 11 05:51 package.json
```

The process runs as `node`, and `/app` has no `.env` (the files belong to `root`, so the app cannot rewrite its own code, which is a good thing). Compose names the built image `<project>-<service>`, here `products-api-api`. Check the constraint and persistence:

```text
$ docker compose exec -T db psql -U shop -d shop -c '\d products' | grep chk_
    "chk_price_non_negative" CHECK (price_cents >= 0)
$ curl -s -X POST http://localhost:3000/products -H 'Content-Type: application/json' \
    -d '{"name":"Dental Mirror","priceCents":1299,"sku":"DM-001"}' -o /dev/null -w '%{http_code}\n'
201
$ docker compose down && docker compose up -d
$ curl -s http://localhost:3000/products | jq -c '[.items[].sku]'
["DM-001"]
```

Finally the e2e tests from the laptop against the Compose database. Your `.env` still says `DATABASE_HOST=localhost`, which now reaches the published port:

```text
$ docker compose exec db psql -U shop -d shop -c 'CREATE DATABASE shop_test;'
CREATE DATABASE
$ npm run test:e2e
Tests:       8 passed, 8 total
```

No extra migration step is needed in the tests: `migrationsRun: true` in `AppModule` builds the schema in `shop_test` when the test app initialises, so `TRUNCATE` finds the table.

**Why it is right.** The image contains only compiled code and production dependencies and runs unprivileged; the schema comes from a reviewed file, not from `synchronize`; and the named volume, not the container, holds the data, which is why `down` and `up` keep the product.

**The trap.** `docker compose down -v` when you meant `down`. The `-v` deletes the `db-data` volume, and with it every product. The second trap is the API exiting with "connection refused" to `localhost:5432`: inside the container, the database is `db`, not `localhost`, which is why Compose sets `DATABASE_HOST: db`.

## 6.9 Putting it together: the finished project

### 6.9.1 One request through every layer, and what you have built

#### Concept

You started this Part with a hello endpoint. You now have a small but genuine backend: validated inputs on every door, cursor pagination, consistent errors with request IDs, a unique constraint enforced by the database, unit and e2e tests, a migration, and a Docker setup that starts everything with one command. This section follows one request through all of it and lists the finished project's files, so you can see the whole shape at once.

#### How it works — one request, end to end

`POST /products` with a duplicate SKU, inside Docker Compose:

```text
curl (your laptop)
  -> port 3000 published by Compose -> api container, node dist/main.js
  -> RequestIdMiddleware: X-Request-Id 5c2e... assigned            (6.6)
  -> ValidationPipe: body matches CreateProductDto, whitelisted      (6.2, 6.6)
  -> ProductsController.create: thin, calls the service             (6.2)
  -> ProductsService.create: repo.create + repo.save                 (6.3)
  -> TypeORM: INSERT INTO "products" (...) VALUES ($1, ...) RETURNING ...
  -> db container, PostgreSQL 17: unique constraint UQ_products_sku violated, error 23505
  -> ApiExceptionFilter: 409, code PRODUCT_SKU_TAKEN, issues[sku]   (6.6)
  -> logger: WARN request failed requestId=5c2e... code=PRODUCT_SKU_TAKEN
  <- 409 application/problem+json { status, code, issues, requestId }
```

Every layer has one job, and each job was added in one step of this Part. The e2e test "returns 409 PRODUCT_SKU_TAKEN for a duplicate SKU" (6.7) proves this whole path in about 30 milliseconds.

#### The finished project

```text
products-api/
├── Dockerfile, .dockerignore, docker-compose.yml          6.8
├── .env (gitignored), .env.example                         6.1
├── src/
│   ├── main.ts, configure-app.ts                           6.1, 6.6
│   ├── app.module.ts                                       6.1, 6.3, 6.6, 6.8
│   ├── data-source.ts, migrations/                         6.8
│   ├── config/env.validation.ts                            6.5
│   ├── common/request-id.middleware.ts                     6.6
│   ├── common/validation.ts, common/api-exception.filter.ts 6.6
│   └── products/
│       ├── products.module.ts, products.controller.ts      6.2, 6.5
│       ├── products.service.ts, products.service.spec.ts   6.3, 6.5, 6.7
│       ├── product.entity.ts, cursor.ts                    6.3, 6.5, 6.6
│       └── dto/ create-product.dto.ts, update-product.dto.ts, list-products.query.ts
└── test/products.e2e-spec.ts                               6.7
```

Compare it with the tiny products API without a framework in Part 3.7: the same idea (receive, validate, store, respond), now with structure, guarantees and tests.

#### How a Senior Backend Engineer thinks about this

A senior would recognise this project as a sound starting point, and would also see exactly what is missing for production: authentication (Part 40), idempotency for retried creates (Part 15.12), structured JSON logs, metrics and traces (Part 43), a CI pipeline that runs the tests and builds the image (Part 47), and migrations run as a separate deploy step (Part 24). None of those require changing the shape you built. That is the point of getting the shape right first.

#### Practical exercise

The capstone for Volume 0: extend the project with one new resource, `categories`, and link products to it.

Acceptance criteria:

- A `categories` table created by a new migration, with a unique `slug`, and a `category_id` foreign key on `products` (Part 17.5 explains foreign keys).
- `POST /categories`, `GET /categories`, and `GET /products?category=<slug>` with the same cursor pagination as 6.5.
- Every error uses the shape from 6.6; creating a product with an unknown category returns `422` with `code: "CATEGORY_NOT_FOUND"` and `issues[0].path` equal to `categoryId`.
- Unit and e2e tests for the new endpoints pass, and the whole system starts with `docker compose up --build`.
- The work is done on a branch, in focused commits, merged through a pull request (Part 5.11).

#### Worked answer to the exercise

This is open-ended, so here is a model answer built only from the patterns of this Part, followed by what a strong answer includes.

**The entity and the link.** `categories` mirrors `products`. On `Product`, the foreign key column is nullable because existing products have no category, and adding a `NOT NULL` column to a table that already has rows would fail:

```ts
// src/categories/category.entity.ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', unique: true })          // UNIQUE: two categories cannot share a slug
  slug!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
```

```ts
// src/products/product.entity.ts (additions)
@Index('idx_products_category_id')                  // PostgreSQL does not index foreign keys by itself
@Column({ type: 'uuid', name: 'category_id', nullable: true })
categoryId!: string | null;

@ManyToOne(() => Category, { nullable: true, onDelete: 'RESTRICT' })
@JoinColumn({ name: 'category_id' })                // the FOREIGN KEY is on this column
category?: Category | null;
```

Add `Category` to `entities` in `data-source.ts` (otherwise TypeORM fails with `No metadata for "Category" was found`), run `npm run migration:generate -- src/migrations/AddCategories`, and read the result. Abridged, `up` must contain:

```sql
CREATE TABLE "categories" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" text NOT NULL, "slug" text NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_categories_slug" UNIQUE ("slug"), CONSTRAINT "PK_categories_id" PRIMARY KEY ("id"));
ALTER TABLE "products" ADD "category_id" uuid;
CREATE INDEX "idx_products_category_id" ON "products" ("category_id");
ALTER TABLE "products" ADD CONSTRAINT "FK_products_category" FOREIGN KEY ("category_id")
  REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
```

**Validation.** `CreateProductDto` gets `@IsOptional() @IsUUID() categoryId?: string;` (and `create()` passes `categoryId: dto.categoryId ?? null` to `repo.create`). `CreateCategoryDto` has `name` (`@IsString() @Length(1, 100)`) and `slug` (`@Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @Length(2, 64)`). `ListProductsQuery` gets an optional `category` with the same slug pattern. `CategoriesModule` follows `ProductsModule`: `TypeOrmModule.forFeature([Category])`, a thin controller with `@Post()` and `@Get()`, and a service whose `list()` copies the cursor logic of 6.5 onto the `categories` table.

**The filter.** In `list()`, join only when filtering, and change the cursor's `where` to `andWhere`, or it replaces the category condition:

```ts
if (q.category) qb.innerJoin('p.category', 'c').andWhere('c.slug = :slug', { slug: q.category });
if (q.cursor) {
  const c = decodeCursor(q.cursor);
  qb.andWhere('(p.createdAt, p.id) < (:createdAt, :id)', { createdAt: c.createdAt, id: c.id });
}
```

**Errors, decided by the database.** As with the SKU in 6.6, the foreign key, not a `SELECT` beforehand, decides whether the category exists. The filter's single `23505` branch becomes a small table keyed by PostgreSQL error code and table (node-postgres puts both on `driverError`):

```ts
// src/common/api-exception.filter.ts (replaces the 23505 branch)
type DbRule = { status: HttpStatus; code: string; title: string; path: string };
const DB_RULES: Record<string, DbRule> = {
  '23505:products':   { status: HttpStatus.CONFLICT, code: 'PRODUCT_SKU_TAKEN', title: 'A product with this SKU already exists', path: 'sku' },
  '23505:categories': { status: HttpStatus.CONFLICT, code: 'CATEGORY_SLUG_TAKEN', title: 'A category with this slug already exists', path: 'slug' },
  '23503:products':   { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'CATEGORY_NOT_FOUND', title: 'The category does not exist', path: 'categoryId' },
};
const dbRule = (e: unknown): DbRule | undefined => {
  if (!(e instanceof QueryFailedError)) return undefined;
  const d = e.driverError as { code?: string; table?: string };
  return DB_RULES[`${d.code}:${d.table}`];
};

// in catch(): const rule = dbRule(exception); then, after the HttpException branch:
} else if (rule) {
  status = rule.status;
  code = rule.code;
  title = rule.title;
  issues = [{ path: rule.path, message: rule.title }];
} else {
```

**Tests.** `products` now references `categories`, so reset both in one statement: `TRUNCATE TABLE products, categories` (truncating `categories` alone fails, because a foreign key points at it). Two of the new e2e tests:

```ts
it('rejects an unknown category with 422 CATEGORY_NOT_FOUND on categoryId', async () => {
  const res = await request(app.getHttpServer()).post('/products')
    .send({ ...valid, categoryId: '9b1d5f8e-0000-4000-8000-000000000000' });
  expectProblem(res, 422, 'CATEGORY_NOT_FOUND');                    // the helper from 6.7
  expect(res.body.issues[0].path).toBe('categoryId');
});

it('filters products by category slug', async () => {
  const cat = await request(app.getHttpServer()).post('/categories').send({ name: 'Dental tools', slug: 'dental-tools' }).expect(201);
  await request(app.getHttpServer()).post('/products').send({ ...valid, categoryId: cat.body.id }).expect(201);
  await request(app.getHttpServer()).post('/products').send({ ...valid, sku: 'DM-002' }).expect(201);
  const res = await request(app.getHttpServer()).get('/products?category=dental-tools').expect(200);
  expect(res.body.items.map((p: { sku: string }) => p.sku)).toEqual(['DM-001']);
});
```

**The Git side** (Part 5.11): a branch such as `feat/TSB-4620-categories`, and commits like "Add Category entity, module and migration", "Link products to categories and filter by slug", "Map foreign key and slug violations to problem responses", "Test categories end to end", merged through a pull request.

**What a strong answer includes.** A migration that was read and completed, not trusted blindly; a nullable foreign key with an index; the database deciding both "slug taken" (`409`) and "category missing" (`422`), so there is no race; one error shape with `issues[0].path` equal to `categoryId`; cursor pagination reused rather than reinvented; an explicit decision on what `?category=unknown-slug` returns (an empty page is the simplest; say so in the pull request); tests for the error paths, not only the happy path; and `docker compose up --build` from a clean checkout as the final check. **The trap** most people hit: keeping `qb.where(...)` for the cursor after adding the category filter, so page 2 silently shows products from every category. The "filters by slug" test catches it only if it walks to a second page, so add one that does.

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
- Never ship `synchronize: true`; production schema changes go through reviewed migrations (Part 24).
- Persistence is what makes it a backend: data lives in the database, surviving restarts and shared across every server instance.
- Every input is a door: bodies, paths, query strings and configuration all need validation and bounds.
- Errors are part of the API: one shape, stable codes, field paths, a request ID, and no internals in responses.
- Tests turn "I checked it with curl once" into "it is checked on every change"; use a real database for e2e.
- One `docker compose up` that starts everything is the difference between a project and a recipe.
- Production systems are this same shape, hardened and scaled; add complexity (caching, queues, services) only when real pressure demands it.
- The discipline practiced here — thin controllers, validated input, clean layering, safe SQL and schema, secrets out of git — is the same discipline that keeps large systems maintainable.
- You can now build, test and run a small correct backend, which is the foundation every later Part builds on; Part 7 — Your First Frontend puts a browser screen in front of it and completes Volume 0.
