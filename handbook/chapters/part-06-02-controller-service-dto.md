## 6.2 The controller, service and DTO

### 6.2.1 Building the products endpoints

#### Concept

Now we build the real feature: a products resource with endpoints to list products, get one by id, and create one. We follow the REST conventions from Part 3 and the controller/service split from 6.1. The new piece is the **DTO** (Data Transfer Object) with **validation** — the object that describes and checks the shape of incoming request data.

#### Why does it exist?

Every request body from a client is untrusted (Part 3): it might be missing fields, have wrong types, or contain malicious values. Before any of that data reaches your business logic or your database, it must be validated. A DTO with validation decorators declares exactly what a valid request looks like, and NestJS automatically rejects anything that does not match with a `400` — so your service only ever receives well-formed data. This is the "parse, don't trust" principle from Part 1, built into the framework.

#### Mental model

The DTO and its validator are the security checkpoint at the entrance. Before a visitor (a request body) is allowed into the building (your logic), the checkpoint verifies their papers: are the required fields present? Are the types right? Are the values in allowed ranges? Anyone who fails is turned away at the door with a clear reason (`400 Bad Request`), and only verified visitors proceed. Your inner logic never has to wonder whether its input is valid, because nothing invalid gets past the door.

#### How it works — generate the module

The Nest CLI scaffolds a module, controller and service together:

```bash
nest generate resource products
# choose: REST API, and "yes" to generate CRUD entry points
# this creates src/products/ with a module, controller, service, DTOs and entity
```

#### The DTO with validation

```bash
npm install class-validator class-transformer
```

```ts
// src/products/dto/create-product.dto.ts
import { IsInt, IsString, Length, Min, IsOptional, Max } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @Length(1, 200)                       // name must be 1 to 200 characters
  name!: string;

  @IsInt()
  @Min(0)                               // price in cents, never negative (Part 1)
  @Max(100_000_00)                      // sanity cap: $100,000
  priceCents!: number;

  @IsString()
  @Length(3, 3)                          // ISO 4217 currency code: "USD", "INR", "EUR"
  @IsOptional()
  currency?: string;
}
```

Each decorator is a rule. `@IsString()` requires a string; `@Length(1, 200)` bounds its length; `@IsInt()` and `@Min(0)` require a non-negative integer. `@IsOptional()` marks a field as allowed to be absent. If a request violates any rule, NestJS returns a `400` with a message naming the failing field — you write zero validation code in your controller.

#### Turning validation on globally

Validation only runs if you enable the validation pipe. Do it once in `main.ts` so it applies to every endpoint:

```ts
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // strip properties not in the DTO
      forbidNonWhitelisted: true,   // reject requests with unknown properties
      transform: true,              // convert payloads to DTO class instances
    }),
  );
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
```

`whitelist: true` strips any field the client sends that is not in the DTO — so a client cannot sneak extra fields (like `isAdmin: true`) into your logic. `forbidNonWhitelisted` goes further and rejects such requests outright. These two settings are a meaningful security measure (Part 44 — Security, mass-assignment protection), and they are one line each.

#### The controller

```ts
// src/products/products.controller.ts
import { Controller, Get, Post, Body, Param, ParseUUIDPipe } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { Product } from './product.entity';   // the entity class, defined in 6.3.2

@Controller('products')                    // all routes start with /products
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()                                   // GET /products
  list(): Promise<Product[]> {
    return this.products.findAll();
  }

  @Get(':id')                              // GET /products/:id
  getOne(@Param('id', ParseUUIDPipe) id: string): Promise<Product> {
    return this.products.findOne(id);       // ParseUUIDPipe rejects non-UUID ids with 400
  }

  @Post()                                  // POST /products
  create(@Body() dto: CreateProductDto): Promise<Product> {
    return this.products.create(dto);       // dto is already validated by the pipe
  }
}
```

Notice how thin the controller is. Each method extracts input (`@Body`, `@Param`), calls the service, and returns the result. No business logic, no validation code (the DTO and pipes handle it), no database access. The `@Param('id', ParseUUIDPipe)` even validates that the id is a valid UUID before the method runs, returning `400` otherwise. This is a thin controller done right.

#### HTTP status codes, for free and on purpose

NestJS returns sensible status codes automatically: `200` for a successful `GET`, `201` for a successful `POST`. When your service throws a NestJS exception, it maps to the right code: `NotFoundException` becomes `404`, `ConflictException` becomes `409`, `BadRequestException` becomes `400` (Part 3 on status codes). You throw a meaningful exception; the framework returns the correct HTTP response.

#### Practical example — calling it

```bash
# create a product (POST with a JSON body)
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Dental Mirror","priceCents":1299}'
# 201 Created, returns the new product with its generated id

# validation in action: a negative price is rejected
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Bad","priceCents":-5}'
# 400 Bad Request: "priceCents must not be less than 0"

# an unknown field is rejected (whitelist)
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{"name":"X","priceCents":100,"isAdmin":true}'
# 400 Bad Request: "property isAdmin should not exist"

# list products
curl http://localhost:3000/products
```

You wrote no validation logic, yet bad input, negative prices and injected fields are all rejected with clear messages and the correct `400` status. That is the framework and the DTO working together.

#### Edge cases & failure modes

- **Forgetting to enable the `ValidationPipe`** means DTO decorators do nothing and invalid data flows straight through — a silent, dangerous gap. Enable it globally in `main.ts`.
- **Not setting `whitelist`** lets clients send extra fields that may reach your logic or ORM (mass assignment, Part 44).
- **Business logic creeping into the controller** makes it untestable and tangles concerns; keep it in the service.
- **Returning raw entities** can leak internal fields; map to a response shape for anything sensitive (Part 16.23).
- **Missing `Content-Type: application/json`** on the request means the body is not parsed as JSON (Part 3).

#### How a Senior Backend Engineer thinks about this

A senior treats the DTO as the contract and the validation boundary: everything crossing into the application is validated there, so no unvalidated data ever reaches business logic or the database. They enable `whitelist` and `forbidNonWhitelisted` as a default security posture. They keep controllers thin and let the framework map exceptions to status codes, which keeps error handling uniform across the whole API. They map entities to explicit response shapes when any field should not be exposed. The result is an API where input validation, status codes and field exposure are handled consistently by design, not sprinkled ad hoc through handlers.

#### Common mistakes

- Not enabling the validation pipe, so DTO rules silently do nothing.
- Validating by hand inside controllers instead of using DTOs.
- Omitting `whitelist`, allowing extra/injected fields.
- Fat controllers with business logic.
- Returning raw database entities and leaking internal fields.

#### Interview questions

1. **What is a DTO and why validate it?** A Data Transfer Object describing the expected shape of request data; validating it rejects malformed or malicious input at the boundary before it reaches business logic.
2. **What do `whitelist` and `forbidNonWhitelisted` do and why do they matter?** `whitelist` strips unknown properties; `forbidNonWhitelisted` rejects requests containing them — together they prevent clients from injecting unexpected fields (mass assignment).
3. **How does a service signal a `404` to the client in NestJS?** By throwing `NotFoundException`, which the framework maps to a `404` response.
4. **Why keep the controller thin?** So logic is testable without HTTP and error handling stays uniform; the controller only translates between HTTP and the service.

#### Practical exercise

Build the products controller, service (stubbed to return in-memory data for now) and `CreateProductDto`, enable the global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`, and verify with `curl` that a valid create returns `201`, a negative price returns `400`, and an unknown field returns `400`. Acceptance criteria: no validation code appears in the controller, and all three cases behave correctly.

#### Worked answer to the exercise

Keep the controller, `CreateProductDto` and `main.ts` exactly as shown above. Until 6.3 adds TypeORM, `Product` is a plain class in the file the controller already imports:

```ts
// src/products/product.entity.ts (plain class for now; 6.3 adds the TypeORM decorators)
export class Product {
  id!: string;
  name!: string;
  priceCents!: number;
  currency!: string;
  createdAt!: Date;
}
```

The stubbed service keeps the same `async` method signatures the repository version will have, so the controller does not change in 6.3:

```ts
// src/products/products.service.ts (in-memory stub)
import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreateProductDto } from './dto/create-product.dto';
import { Product } from './product.entity';

@Injectable()
export class ProductsService {
  private readonly products: Product[] = [];        // lost on restart: 6.3 fixes that

  async findAll(): Promise<Product[]> {
    return [...this.products];
  }

  async findOne(id: string): Promise<Product> {
    const product = this.products.find((p) => p.id === id);
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const product: Product = {
      id: randomUUID(),
      name: dto.name,
      priceCents: dto.priceCents,
      currency: dto.currency ?? 'USD',
      createdAt: new Date(),
    };
    this.products.push(product);
    return product;
  }
}
```

The three checks, with the status code printed on its own line:

```text
$ curl -s -w '\n%{http_code}\n' -X POST http://localhost:3000/products \
    -H 'Content-Type: application/json' -d '{"name":"Dental Mirror","priceCents":1299}'
{"id":"c0a8e5d2-4b7f-4e1a-9c3d-2f6b8a1e7d40","name":"Dental Mirror","priceCents":1299,"currency":"USD","createdAt":"2026-11-11T04:45:10.123Z"}
201

$ curl -s -w '\n%{http_code}\n' -X POST http://localhost:3000/products \
    -H 'Content-Type: application/json' -d '{"name":"Bad","priceCents":-5}'
{"message":["priceCents must not be less than 0"],"error":"Bad Request","statusCode":400}
400

$ curl -s -w '\n%{http_code}\n' -X POST http://localhost:3000/products \
    -H 'Content-Type: application/json' -d '{"name":"X","priceCents":100,"isAdmin":true}'
{"message":["property isAdmin should not exist"],"error":"Bad Request","statusCode":400}
400
```

For the first acceptance check, `grep -nE 'if \(|throw' src/products/products.controller.ts` prints nothing: every rule lives in the DTO, the pipe and `ParseUUIDPipe`.

**Why it is right.** The global `ValidationPipe` checks the body against `CreateProductDto` before `create()` runs, so the service only ever sees valid data. `whitelist` plus `forbidNonWhitelisted` turns an unknown field into a `400` instead of silently passing it along.

**The trap.** Keeping what `nest generate resource` wrote. Its controller uses `@Param('id') id: string` with `+id`, which turns a UUID into `NaN`, and it adds `update` and `remove` routes that call service methods you have not written yet. Replace the generated controller with the one above (6.5 adds update and delete properly). The second trap: if the negative price returns `201`, the `ValidationPipe` is not registered; check `main.ts`.
