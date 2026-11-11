## 13.23 Anti-patterns in NestJS code

Every principle and pattern in this part has an evil twin: the shortcut that looks reasonable in a pull request and costs a week six months later. This section names the ones that show up most often in NestJS codebases, with how to recognise each, why it hurts, and the fix. Treat it as a code-review checklist.

#### The God service

**What it looks like.** `OrdersService` with 1,800 lines, 25 constructor dependencies, and methods for creating orders, charging cards, sending emails, generating invoices, exporting CSV and syncing with the warehouse. Every feature touches it; every PR conflicts in it.

**Why it hurts.** It violates SRP by definition; its tests need 25 mocks; it cannot be split across teams; a bug in the CSV export deploys with the checkout code; its dependency list makes it the most-coupled thing in the system (highest efferent coupling), so it changes whenever anything changes.

**Fix.** Split by business operation into use cases (`PlaceOrderUseCase`, `CancelOrderUseCase`) and by concern into domain services, repositories and adapters. Move reactions to events. A service should fit on two screens.

#### The fat controller

**What it looks like.**

```ts
// ANTI-PATTERN
@Post()
async create(@Body() dto: CreateOrderDto, @Req() req) {
  const product = await this.productRepo.findOneBy({ id: dto.productId });
  if (!product) throw new NotFoundException();
  if (product.stock < dto.qty) throw new ConflictException('out of stock');
  product.stock -= dto.qty;
  await this.productRepo.save(product);
  const order = await this.orderRepo.save({ userId: req.user.id, ...dto, status: 'CREATED' });
  await this.stripe.paymentIntents.create({ amount: order.total, currency: 'inr' });
  return order;
}
```

**Why it hurts.** The business rule is trapped behind HTTP: a Kafka consumer or a cron job cannot reuse it; the test needs an HTTP context; there is no transaction; the controller returns a persistence entity. Controllers should translate protocol into a use-case call and translate the result back; nothing else.

**Fix.** One line of delegation: `return OrderResponse.from(await this.placeOrder.execute(toCommand(dto, req.user.id)))`.

#### Business logic in controllers, guards, pipes and interceptors

A close cousin. "Just a small check" in a guard (`if (order.total > 50000 && !user.isVip) return false`) is a business rule hidden in the HTTP layer where the domain tests never see it. Guards decide *who may call*; pipes validate *shape*; interceptors handle *cross-cutting HTTP concerns*. Business decisions belong in the domain and application layers.

#### Entities as DTOs

**What it looks like.** `@Entity() class User` with `@Column() passwordHash` used as the request body type, the response type and the domain model. `@Post() create(@Body() user: User)` and `return this.repo.find()`.

**Why it hurts.** Mass assignment: a client posts `{ "email": "...", "role": "admin" }` and the entity happily accepts it. Data leaks: the response includes `passwordHash`, `mfaSecret`, and every eager relation. Schema coupling: renaming a column changes the public API. Validation confusion: `class-validator` decorators on an entity apply to database rows too.

**Fix.** Separate `CreateUserDto` (validated, whitelisted with `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`), `User` domain object, `UserEntity` persistence, and `UserResponse`. Yes, four classes. The alternative is a security incident.

#### Service locator via `ModuleRef` everywhere

**What it looks like.** `constructor(private readonly moduleRef: ModuleRef)` and then `this.moduleRef.get(PaymentsService, { strict: false })` inside methods.

**Why it hurts.** Dependencies become invisible: the constructor says "I need `ModuleRef`", which means "I might need anything". Tests cannot see what to fake. Boot-time DI errors become runtime errors. Circular dependencies are hidden rather than fixed. `strict: false` bypasses module encapsulation entirely, so the modular monolith's walls disappear.

**Fix.** Constructor injection with explicit tokens. `ModuleRef` has legitimate uses (resolving request-scoped providers in a default-scoped context, dynamic plugin lookup by name in a registry), all rare and all at the composition edge, never inside business code.

#### Request-scoped everything

**What it looks like.** `@Injectable({ scope: Scope.REQUEST })` on services and repositories "so we can access the current user".

**Why it hurts.** Scope bubbles: every dependent provider becomes request-scoped; the container constructs the whole subtree per request; throughput drops 10 to 30% and p99 rises; some framework features (lifecycle hooks, `@Cron`, Kafka consumers) do not have a request to scope to and break in confusing ways.

**Fix.** `AsyncLocalStorage` (or `nestjs-cls`) for per-request context; keep providers default-scoped.

#### Static helpers instead of providers

**What it looks like.** `export class DateUtils { static now() { return new Date(); } }`, `export const sendSlack = (msg) => axios.post(...)`, `PriceUtils.calculate(order)` with hidden reads from `process.env`.

**Why it hurts.** Static functions with side effects or hidden dependencies cannot be replaced in tests (you end up mocking modules with `jest.mock`, which is brittle and global). They read config from the environment at call time, so behaviour depends on where and when they run. They are invisible to the DI graph, so the dependency is real but undeclared.

**Fix.** Pure functions with no side effects and no hidden inputs can stay static (`Money.add`, `slugify`). Anything touching time, network, config, randomness or the database becomes a provider with an interface (`Clock`, `SlackNotifier`, `PricingService`).

#### Catching and swallowing errors

**What it looks like.**

```ts
// ANTI-PATTERN
try {
  await this.payments.charge(order);
} catch (e) {
  console.log('payment failed', e);
  // continues; order is saved as PAID anyway
}
```

**Why it hurts.** The system lies about its state. The order says PAID; the customer was not charged (or was charged and the exception was a timeout, so you do not know). Logs go to `console.log` without a request id. The next engineer cannot tell whether the catch was deliberate.

**Fix.** Catch only what you can handle, and handle it explicitly: translate (adapter turns vendor errors into domain errors), compensate (release the reservation), or record and retry (outbox, DLQ). Let everything else propagate to the exception filter, which maps it to a response and a structured log with the correlation id. Never `catch {}` with an empty body; never log-and-continue on a write path.

#### More anti-patterns worth naming

| Anti-pattern | Signal | Fix |
| --- | --- | --- |
| Anaemic domain | Entities with only fields and getters; all rules in services | Move behaviour onto aggregates; domain services for multi-entity rules |
| Leaky repository | `findAll(options: FindManyOptions)`, `getQueryBuilder()` on the interface | Intention-revealing methods; specifications |
| Global modules everywhere | `@Global()` on business modules | Explicit imports and exports |
| Barrel-file cycles | `index.ts` re-exporting everything; `forwardRef` sprouting | Import from concrete files; events instead of back-edges |
| Transactions in interceptors | `@Transactional()` on every controller method | Unit of Work at the use-case boundary |
| Boolean parameters | `send(user, true, false)` | Separate methods or an options object with named fields |
| Config read at call time | `process.env.X` inside services | `ConfigService` injected; validated at boot with a schema |
| Missing timeouts | `axios.get(url)` with defaults | Explicit timeout on every outbound call; deadline propagation |
| Fire-and-forget promises | `this.email.send(...)` without `await` in a request handler | Await, or hand off to a queue with persistence |
| Logic in database triggers | Business rules in `BEFORE UPDATE` triggers nobody remembers | Rules in the domain; triggers only for invariants and auditing |
| Copy-pasted validation | The same `@IsEmail()` rules in five DTOs with slight drift | Shared validator classes or composed DTOs with `PickType`/`IntersectionType` |

#### How a Senior Backend Engineer thinks about this

They know that every anti-pattern above was written by someone reasonable under time pressure, so they do not rely on willpower. They add lint rules (`no-restricted-imports` for `typeorm` in `domain/`, a rule against `ModuleRef` outside `platform/`), CI checks (`dependency-cruiser` for boundaries, `ValidationPipe` `whitelist` on by default in `main.ts`), and review templates ("Does the controller contain an `if` on business data? Does any method return an entity?"). They also keep a written list of these anti-patterns in the repository so code review comments can link to the rule rather than re-arguing it.

#### Interview questions

1. *A controller method is 80 lines. What do you look for and what do you do?* Expected: business logic, repository calls, vendor SDK calls, entities returned; delegate to a use case; response DTOs.
2. *Why is `ModuleRef.get` in business code a problem?* Expected: hidden dependencies, runtime DI errors, broken encapsulation.
3. *What is wrong with catching an error and logging it in a payment flow?* Expected: state lies; unknown outcome; must translate, compensate or retry explicitly.
4. *How does using entities as DTOs lead to a security incident?* Expected: mass assignment and data leaks.

## 13.24 Project layout reference: a production NestJS service

The folder tree below is the reference layout this handbook assumes. It is a modular monolith (or a single service) with one module shown in full. It satisfies hexagonal, clean and onion vocabulary at once, and every folder has a one-sentence rule that says what may live there.

```text
repo/
  package.json
  nest-cli.json
  tsconfig.json
  tsconfig.build.json
  .dependency-cruiser.js
  .eslintrc.js
  docker-compose.yml
  Dockerfile
  .github/workflows/ci.yml
  db/
    migrations/
      orders/
        1725600000000-create-orders-schema.ts
      inventory/
      payments/
  test/
    e2e/
      orders.e2e-spec.ts
    contract/
      payment-gateway.contract.ts
  libs/
    shared-kernel/
      src/
        money.ts
        ids.ts
        domain-error.ts
        domain-event.ts
        result.ts
        clock.port.ts
    contracts/
      src/
        events/
          orders/order-paid.v1.ts
          orders/order-shipped.v1.ts
          inventory/stock-reserved.v1.ts
        inventory/reserve-stock.dto.ts
        payments/charge.dto.ts
    platform/
      src/
        config/
          config.schema.ts
          config.module.ts
        logging/
          logger.module.ts
          correlation-id.middleware.ts
        http/
          domain-error.filter.ts
          http-client.module.ts
          deadline.interceptor.ts
        persistence/
          typeorm.module.ts
          transaction-context.ts
          typeorm-unit-of-work.ts
          current-manager.ts
          outbox/
            outbox.entity.ts
            outbox.repository.ts
            outbox-relay.service.ts
        messaging/
          kafka.module.ts
          kafka-event.publisher.ts
          idempotent-consumer.ts
        observability/
          tracing.ts
          metrics.module.ts
          health.controller.ts
  apps/
    api/
      src/
        main.ts
        app.module.ts
    worker/
      src/
        main.ts
        worker.module.ts
  src/
    modules/
      orders/
        orders.module.ts
        public/
          orders.facade.ts
        application/
          ports/
            order.repository.ts
            payment.gateway.ts
            event.publisher.ts
          commands/
            place-order.command.ts
            cancel-order.command.ts
          use-cases/
            place-order.use-case.ts
            cancel-order.use-case.ts
            ship-order.use-case.ts
            expire-unpaid-orders.use-case.ts
          queries/
            get-order.query.ts
            list-orders-for-customer.query.ts
          event-handlers/
            on-payment-captured.handler.ts
          mappers/
            order-read.mapper.ts
        domain/
          order.ts
          order-line.ts
          order-status.ts
          events/
            order-paid.event.ts
            order-cancelled.event.ts
          services/
            pricing.service.ts
            shipping-eligibility.service.ts
          specifications/
            order.specs.ts
          errors.ts
        infrastructure/
          typeorm/
            order.entity.ts
            order-line.entity.ts
            order-transition.entity.ts
            order.mapper.ts
            typeorm-order.repository.ts
          in-memory/
            in-memory-order.repository.ts
          stripe/
            stripe-payment.gateway.ts
          kafka/
            kafka-order-event.publisher.ts
        presentation/
          http/
            orders.controller.ts
            dto/
              create-order.dto.ts
              cancel-order.dto.ts
              order.response.ts
            guards/
              order-owner.guard.ts
          kafka/
            payment-events.consumer.ts
          cron/
            expire-orders.job.ts
        __tests__/
          domain/order.spec.ts
          application/place-order.use-case.spec.ts
          infrastructure/typeorm-order.repository.int-spec.ts
      inventory/
        (same shape)
      payments/
        (same shape)
      notifications/
        (same shape)
```

#### `libs/shared-kernel/`

The smallest folder in the repository and the most carefully guarded. It holds domain primitives that every module needs and that almost never change: `Money` (integer minor units plus currency, with `add`, `subtract`, `multiply`, `percent`, comparison), branded id types, the base `DomainError` with a stable `code`, the `DomainEvent` base shape (`id`, `name`, `occurredAt`, `causationId`), a `Result` type if the team prefers results over exceptions, and the `Clock` port. It imports nothing from any module and nothing from any framework. Every addition is reviewed as if it were a public API change, because it is one: everything depends on it, so its afferent coupling is the highest in the codebase.

#### `libs/contracts/`

The published surface of each module: event schemas (versioned in the file name and the payload), the DTOs facades accept and return, and nothing else. No logic, no classes with behaviour, no ORM types. When a module is extracted into a service, this folder becomes the shared package both sides depend on, so it must already look like one: additive changes only, deprecation before removal. Consumers of an event import its type from here, never from the producing module's internals.

#### `libs/platform/`

Cross-cutting infrastructure with no business knowledge: config loading and validation (a schema checked at boot so a missing variable fails fast), the logger and correlation-id middleware, the HTTP client factory with default timeouts and deadline propagation, the TypeORM root module and the Unit of Work, the outbox relay, the Kafka module and idempotent-consumer helper, tracing and metrics setup, and the health controller for `@nestjs/terminus`. The test for whether a file belongs here is whether it knows the words "order", "payment" or "customer"; if it does, it belongs in a module. Platform code is owned by whoever owns the platform (often the same team in a small company), and every module depends on it, so it changes rarely and carefully.

#### `apps/`

Entry points. `api/main.ts` boots `AppModule` with HTTP; `worker/main.ts` boots `WorkerModule` with Kafka consumers and cron jobs and no HTTP listener beyond health. Both import the same modules from `src/modules`; the difference is which presentation adapters are wired. A third entry point (`lambda.ts` for serverless, `cli.ts` for operational scripts using `nest-commander`) follows the same shape. Keeping entry points separate from modules is what allows the same code to run in different deployment shapes without forks.

#### `src/modules/<name>/`

One folder per bounded context. Each has its own NestJS module file, its own PostgreSQL schema and migrations folder, and the four inner folders below. A module may import `shared-kernel`, `contracts`, `platform`, and other modules' `public/` facades; nothing else. `dependency-cruiser` enforces this.

#### `public/`

The module's facade: the single exported provider other modules may inject. Its methods take and return contract DTOs, are all async, and never expose entities, domain objects or `EntityManager`. It is deliberately shaped like a network client so that extraction to a service means replacing this one class with an HTTP or gRPC implementation of the same interface.

#### `application/`

The use cases (one class, one `execute`), the ports they depend on (`ports/`, interfaces plus injection tokens, owned here because this is the consumer), commands and queries if `@nestjs/cqrs` is used, event handlers that react to other modules' events by invoking use cases, and read-side query services that return DTOs directly (allowed to use the ORM's query builder because they are read-only projections, not domain operations). This layer orchestrates: load, call domain, save, publish. It contains no business rules of its own and no framework imports beyond `@Inject`/`@Injectable`. Transactions begin and end here, through the Unit of Work.

#### `domain/`

The reason the module exists. Aggregates and entities with behaviour (`Order.pay()`, `Order.cancel()`), value objects, the state machine and its transition table, domain events the aggregates record, domain services for multi-entity rules, specifications, and the module's typed errors. No imports from `@nestjs/*`, `typeorm`, `sequelize`, `stripe`, `kafkajs` or any I/O library; only `shared-kernel` and itself. Tests here are pure unit tests that run in milliseconds and cover every rule exhaustively. If this folder is empty or contains only interfaces, the module is CRUD and probably does not need the full layout; use layered structure with response DTOs instead.

#### `infrastructure/`

Outbound adapters that implement the ports: the TypeORM (or Sequelize) entities, mappers between persistence and domain, the repository implementation, an in-memory repository for fast tests, the payment provider adapter, the Kafka publisher. This is the only place that knows column names, vendor SDK types and error codes. Each adapter translates errors into domain errors and configures timeouts. Integration tests here run against real infrastructure in Docker and are the slowest tests in the module, so they are few and focused on mapping and query correctness.

#### `presentation/`

Inbound adapters: HTTP controllers with their request DTOs (validated with `class-validator`), response DTOs, module-specific guards; Kafka consumers that translate messages into use-case calls with idempotency; cron jobs that invoke use cases on a schedule. Each adapter is thin: authenticate, validate, translate, call, translate back. Domain errors are converted to protocol responses by the platform's exception filter, not here. If a controller method contains an `if` about business data, it belongs one layer down.

#### `__tests__/` and `test/`

Module tests live beside the module, split by layer so their speed profiles are obvious: `domain/` (pure, milliseconds), `application/` (use cases with in-memory adapters, milliseconds), `infrastructure/` (integration, seconds). Repository-wide `test/e2e` boots the API against Docker services for a handful of golden-path scenarios, and `test/contract` holds the shared contract suites run against every implementation of a port (`describe.each` over adapters) and the consumer-driven contract tests for events.

#### How to adopt this without stalling

Do not convert a whole codebase to this layout in one PR. Start with the DTO boundary in every module (that is the security-critical part and the cheap part). Then, when a module gains its first real rule, create its `domain/` and move the rule there with a test. Then add ports and an in-memory adapter when the use-case tests get slow. Layered CRUD modules can stay layered indefinitely; the layout above is for modules that earn it.

## Senior Checklist — Part 13

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
- [ ] I can identify a concrete SOLID violation in a real NestJS service for each of the five letters and refactor it, and I can say where each principle is commonly over-applied
- [ ] I can explain DRY as "one representation of knowledge" and recognise the wrong abstraction (flag-parameter helpers) when I see it
- [ ] I can describe how the NestJS DI container resolves a provider, what `useClass`/`useValue`/`useFactory`/`useExisting` do, and why request scope bubbling costs throughput
- [ ] I can replace request-scoped providers with `AsyncLocalStorage` and I treat `forwardRef` as a design smell
- [ ] I can write a `forRootAsync` dynamic module
- [ ] I can classify coupling (data, control, temporal, content; afferent vs efferent) and cohesion levels, and measure them with `dependency-cruiser`
- [ ] I can implement an interface-based repository with TypeORM, Sequelize and in-memory adapters, and I know when a query service should bypass it
- [ ] I can implement Factory, Strategy, Adapter, Decorator and Facade in NestJS with injection tokens, and name the situation where each is not worth it
- [ ] I can list the Node `EventEmitter` pitfalls (sync listeners, unhandled rejections, leaks, no durability, emit-before-commit) and mitigate each
- [ ] I can make a command idempotent under concurrent duplicates with a claimed key and conditional updates
- [ ] I can implement an order state machine with a transition table, exhaustive tests, persisted history and optimistic locking
- [ ] I can compose specifications that evaluate both in memory and as SQL, with unique parameter names and index-aware shapes
- [ ] I can implement a Unit of Work with `AsyncLocalStorage`, dispatch events after commit, always release the runner, and keep external I/O outside the transaction
- [ ] I can spot the NestJS anti-patterns (God service, fat controller, entities as DTOs, `ModuleRef` locator, request-scoped everything, static helpers, swallowed errors) in review and point to the fix
- [ ] I can lay out a production NestJS module as `public / application / domain / infrastructure / presentation` and explain the import rules for each folder

## Part 13 — Key Takeaways

- Principles manage change: SRP limits reasons to change, OCP adds behaviour without editing, LSP keeps abstractions trustworthy, ISP keeps interfaces narrow, DIP points imports at abstractions the consumer owns.
- DRY is about knowledge, not code; the rule of three applies, and duplication is cheaper than the wrong abstraction. KISS and YAGNI cut speculative structure, but never cut idempotency, timeouts, validation or the DTO boundary.
- The NestJS container builds singletons from constructor metadata and tokens; interfaces need `@Inject(TOKEN)`; keep everything `Scope.DEFAULT` and carry request context in `AsyncLocalStorage`.
- Compose behaviour from small collaborators; reserve inheritance for framework extension points and shallow error hierarchies.
- Couple to stable abstractions, not volatile implementations; the domain should have high afferent and near-zero efferent coupling. Folders named `utils`, `common` or `shared` are a cohesion smell.
- A repository speaks domain language and returns domain objects; the moment its interface accepts ORM options it has stopped being a boundary. Reports go to query services.
- Factory selects, Strategy executes, Adapter translates vendor shapes and errors, Decorator wraps with the same interface, Facade is a module's public API shaped like a future network client.
- In-process events are synchronous, non-durable and error-prone by default: use `async: true`, catch inside listeners, emit after commit, and write an outbox for anything that must happen.
- Commands are requests with one handler and an idempotency key; events are facts with many handlers. `@nestjs/cqrs` adds a bus, not durability.
- Model lifecycles as explicit state machines with a transition table, exhaustive tests, persisted transitions and optimistic locking; illegal transitions are errors and a metric.
- A Unit of Work is the transaction boundary of one business operation: all repositories share it through context, events dispatch after commit, the runner is always released, and no network call lives inside it.
- Encode the rules in tooling (lint, `dependency-cruiser`, `ValidationPipe` whitelist, boot smoke tests) rather than in wiki pages; anti-patterns are written by reasonable people under deadline pressure.
