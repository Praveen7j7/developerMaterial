## 12.11 Repository pattern

#### Concept

A repository is an object that gives domain code the illusion of an in-memory collection of aggregates: `findById`, `save`, `findPendingOlderThan(date)`. Behind it sits the database and the ORM. The domain and application layers talk to the repository interface; they never see SQL, TypeORM entities, or a `QueryBuilder`.

#### Why does it exist?

The problem is the ORM leaking upward. When a use case holds a TypeORM `Repository<OrderEntity>`, it gets 40 methods (`createQueryBuilder`, `increment`, `query`, `manager`), it receives persistence entities with lazy relations and database columns, and its tests need the ORM. Every query written inline in a service is a hidden dependency on the schema. The Repository pattern draws a line: persistence knowledge lives in one place per aggregate, expressed in domain terms.

#### Mental model

Imagine a library. You ask the librarian for "the books by this author" or "this book by its number". You do not walk into the archive, learn the shelving system, and pull boxes. The librarian (repository) knows the shelving system (schema and ORM); you know books (domain objects).

#### The anti-pattern: leaking TypeORM into services

```ts
// ANTI-PATTERN: the "repository" is TypeORM's, and QueryBuilder is in the service
@Injectable()
export class OrdersService {
  constructor(@InjectRepository(OrderEntity) private readonly repo: Repository<OrderEntity>) {}

  async listForCustomer(customerId: string, status?: string) {
    const qb = this.repo.createQueryBuilder('o')
      .leftJoinAndSelect('o.lines', 'l')
      .where('o.customer_id = :customerId', { customerId });
    if (status) qb.andWhere('o.status = :status', { status });
    return qb.orderBy('o.created_at', 'DESC').take(50).getMany(); // returns OrderEntity[] with relations
  }
}
```

Why this hurts: the service knows column names (`customer_id`), knows the relation name (`lines`), returns persistence entities to the controller (which serialises whatever is loaded, including things you did not intend), cannot be tested without a database or a deep mock of `SelectQueryBuilder`, and the same query gets copy-pasted with small variations across the codebase until nobody knows which one is canonical.

#### How it works

1. Define a **repository interface** in `application/ports/` (or `domain/` in stricter setups), in domain terms, returning domain objects.
2. Implement it once per storage technology in `infrastructure/`. The implementation owns mapping between domain objects and persistence entities/models.
3. Bind with a token in the module.
4. Keep the interface **narrow and intention-revealing**: `findPendingPaymentOlderThan(cutoff)` rather than `find(options: FindManyOptions)`. If the interface accepts ORM query options, it is not a repository; it is the ORM with an extra step.
5. For complex, composable queries, pair the repository with the Specification pattern (section 12.21) rather than exposing a query builder.

#### NestJS example: interface with TypeORM and Sequelize implementations

The port:

```ts
// src/modules/orders/application/ports/order.repository.ts
import { Order } from '../../domain/order';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

export interface OrderRepository {
  findById(id: string): Promise<Order | null>;
  findForCustomer(customerId: string, opts: { status?: OrderStatus; limit: number }): Promise<Order[]>;
  findPendingPaymentOlderThan(cutoff: Date, limit: number): Promise<Order[]>;
  save(order: Order): Promise<void>;
}
```

The TypeORM implementation, with an explicit mapper:

```ts
// src/modules/orders/infrastructure/typeorm/typeorm-order.repository.ts
@Injectable()
export class TypeormOrderRepository implements OrderRepository {
  constructor(@InjectRepository(OrderEntity) private readonly repo: Repository<OrderEntity>) {}

  async findById(id: string): Promise<Order | null> {
    const row = await this.repo.findOne({ where: { id }, relations: { lines: true } });
    return row ? OrderMapper.toDomain(row) : null;
  }

  async findForCustomer(customerId: string, opts: { status?: OrderStatus; limit: number }): Promise<Order[]> {
    const rows = await this.repo.find({
      where: { customerId, ...(opts.status ? { status: opts.status } : {}) },
      relations: { lines: true },
      order: { createdAt: 'DESC' },
      take: Math.min(opts.limit, 100),
    });
    return rows.map(OrderMapper.toDomain);
  }

  async findPendingPaymentOlderThan(cutoff: Date, limit: number): Promise<Order[]> {
    const rows = await this.repo
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.lines', 'l')
      .where('o.status = :status AND o.created_at < :cutoff', { status: 'CREATED', cutoff })
      .orderBy('o.created_at', 'ASC')
      .take(limit)
      .getMany();
    return rows.map(OrderMapper.toDomain);
  }

  async save(order: Order): Promise<void> {
    await this.repo.save(OrderMapper.toPersistence(order)); // cascade saves lines
  }
}
```

The Sequelize implementation of the same port:

```ts
// src/modules/orders/infrastructure/sequelize/sequelize-order.repository.ts
@Injectable()
export class SequelizeOrderRepository implements OrderRepository {
  constructor(@InjectModel(OrderModel) private readonly orders: typeof OrderModel) {}

  async findById(id: string): Promise<Order | null> {
    const row = await this.orders.findByPk(id, { include: [OrderLineModel] });
    return row ? OrderMapper.fromModel(row) : null;
  }

  async findForCustomer(customerId: string, opts: { status?: OrderStatus; limit: number }): Promise<Order[]> {
    const rows = await this.orders.findAll({
      where: { customerId, ...(opts.status ? { status: opts.status } : {}) },
      include: [OrderLineModel],
      order: [['createdAt', 'DESC']],
      limit: Math.min(opts.limit, 100),
    });
    return rows.map(OrderMapper.fromModel);
  }

  async findPendingPaymentOlderThan(cutoff: Date, limit: number): Promise<Order[]> {
    const rows = await this.orders.findAll({
      where: { status: 'CREATED', createdAt: { [Op.lt]: cutoff } },
      include: [OrderLineModel],
      order: [['createdAt', 'ASC']],
      limit,
    });
    return rows.map(OrderMapper.fromModel);
  }

  async save(order: Order): Promise<void> {
    await this.orders.sequelize!.transaction(async (transaction) => {
      await this.orders.upsert(OrderMapper.toModelAttrs(order), { transaction });
      await OrderLineModel.destroy({ where: { orderId: order.id }, transaction });
      await OrderLineModel.bulkCreate(OrderMapper.toLineAttrs(order), { transaction });
    });
  }
}
```

The use case does not change between the two. The tests for the use case use an `InMemoryOrderRepository` (a `Map<string, Order>`), which is a third implementation of the same port and takes 20 lines.

#### PostgreSQL example

The `findPendingPaymentOlderThan` query needs an index that matches its shape, and the repository is the one place that knows this:

```sql
-- Partial index: only CREATED orders, ordered by created_at, small and hot
CREATE INDEX orders_pending_created_idx ON orders.orders (created_at)
WHERE status = 'CREATED';

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders.orders WHERE status = 'CREATED' AND created_at < now() - interval '15 minutes'
ORDER BY created_at ASC LIMIT 100;
--  Limit  (cost=0.29..12.41 rows=100 width=96) (actual time=0.031..0.188 rows=100 loops=1)
--    ->  Index Scan using orders_pending_created_idx on orders  (actual time=0.029..0.171 rows=100 loops=1)
--          Index Cond: (created_at < (now() - '00:15:00'::interval))
--  Buffers: shared hit=7
--  Planning Time: 0.140 ms
--  Execution Time: 0.221 ms
```

Because the query is encapsulated, the index and the query can be tuned together without touching application code.

#### When NOT to use it

- **Read-heavy reporting and admin screens.** A report that joins six tables and returns 40 columns does not want to be mapped into aggregates. Use a separate **query service** that returns read DTOs directly from SQL or a `QueryBuilder` (this is the "Q" in CQRS). Do not force reports through the repository.
- **Thin CRUD modules** with no domain model. `Repository<AddressEntity>` from TypeORM injected into a small service is fine; adding an interface and a mapper for `addresses` is ceremony.
- **When the "domain object" is the entity anyway** and you have consciously chosen that (small service, small team). Then the pattern's cost exceeds its value; just keep the queries in one class.

#### Common mistakes

- A generic `BaseRepository<T>` with `find(options)` that re-exposes the ORM.
- Repositories returning persistence entities (no mapping) so the "boundary" is cosmetic.
- Repositories that contain business logic (`save()` that also sends an email).
- One repository per table instead of per aggregate (an `OrderLineRepository` used by the order use case; lines belong to the order).
- Methods with boolean flags (`findById(id, withLines: boolean)`); make two methods or accept the cost of always loading.

#### Interview questions

1. *What is the difference between a domain repository and TypeORM's `Repository<T>`?* Expected: interface in domain terms returning domain objects vs ORM data-access API returning entities.
2. *Why should a repository be per aggregate rather than per table?* Expected: consistency boundary; the aggregate is saved as a whole.
3. *Where do complex reports go?* Expected: query services / read side; not the repository.
4. *How do you test a use case that depends on a repository?* Expected: in-memory implementation of the port.

#### Practical exercise

Extract every TypeORM `createQueryBuilder` and `find*` call from a service into an interface-based repository with a mapper. Add an in-memory implementation and a Sequelize implementation.

Acceptance criteria: the service has no `typeorm` import; the same use-case test suite passes against in-memory, TypeORM (Docker PostgreSQL) and Sequelize implementations via `describe.each`; no method on the interface accepts ORM option types.

## 12.12 Service pattern: application service vs domain service

#### Concept

"Service" is the most overloaded word in backend code. Two distinct things hide behind it:

- An **application service** (use case) orchestrates one business operation: load aggregates through repositories, call domain behaviour, save, publish events, manage the transaction. It is thin and procedural. It knows about ports. It contains no business rules of its own.
- A **domain service** holds business logic that does not naturally belong to one entity because it involves several, or needs a policy that is not state: `PricingService.price(order, customer, promotions)`, `StockAllocationService.allocate(reservationRequests, warehouses)`. It is pure: no I/O, no ports, no framework.

The NestJS-generated `OrdersService` is usually neither; it is both, plus persistence, plus HTTP concerns. That is the God service anti-pattern (section 12.23).

#### Why does it exist?

Without the distinction, business rules leak into orchestration code where they are hard to test, and orchestration leaks into domain code where it drags I/O in. Naming the two kinds gives every line of code an obvious home.

#### Mental model

Imagine a wedding. The wedding planner (application service) calls the caterer, the florist and the venue in the right order, handles payments, and deals with the timeline. The chef (domain service) decides how to cook for 200 people with three dietary constraints; the chef does not call the venue.

#### NestJS example

```ts
// Domain service: pure, no injection needed beyond other pure things
export class ShippingEligibilityService {
  constructor(private readonly clock: Clock) {}

  canShip(order: Order, stock: StockLevel[], warehouseCutoff: Date): ShipDecision {
    if (order.status !== 'PAID') return ShipDecision.reject('ORDER_NOT_PAID');
    const short = order.lines.filter((l) => (stock.find((s) => s.productId === l.productId)?.available ?? 0) < l.qty);
    if (short.length) return ShipDecision.reject('INSUFFICIENT_STOCK', short.map((l) => l.productId));
    const sameDay = this.clock.now() < warehouseCutoff;
    return ShipDecision.accept(sameDay ? 'SAME_DAY' : 'NEXT_DAY');
  }
}

// Application service (use case): orchestrates I/O around the domain decision
@Injectable()
export class ShipOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly inventory: InventoryFacade,
    private readonly eligibility: ShippingEligibilityService,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(orderId: string): Promise<void> {
    await this.uow.run(async () => {
      const order = await this.orders.findById(orderId);
      if (!order) throw new DomainError('ORDER_NOT_FOUND', orderId);
      const stock = await this.inventory.levelsFor(order.lines.map((l) => l.productId));
      const decision = this.eligibility.canShip(order, stock, await this.inventory.todayCutoff());
      if (!decision.ok) throw new DomainError(decision.reason, decision.details?.join(','));
      order.markShipped(decision.speed);
      await this.orders.save(order);
      await this.events.publish(new OrderShippedEvent({ orderId, speed: decision.speed }));
    });
  }
}
```

`ShippingEligibilityService` has a full unit test suite with no mocks except a fake clock. `ShipOrderUseCase` has a few tests that check orchestration (calls save, publishes event, rolls back on failure) with fakes.

#### Where juniors misapply this

They create a domain service for everything, including logic that belongs on the entity (`OrderStatusService.canCancel(order)` instead of `order.canCancel()`). Rule: if the logic needs only one entity's state, it belongs on that entity. Domain services are for logic spanning entities or requiring external policy objects.

They also let application services grow rules: `if (order.total > 50000) requireReview = true` inside the use case. That is a domain policy; move it.

#### Interview questions

1. *Distinguish application service, domain service and entity behaviour with one example each.* Expected: as above.
2. *Which of the three may perform I/O?* Expected: only the application service, through ports.
3. *How do you keep an application service thin?* Expected: rules go to entities/domain services; persistence to repositories; side effects to events.

## 12.13 Factory pattern

#### Concept

A factory is an object or function whose job is to create other objects, hiding the decision of *which* concrete class to create and *how* to construct it. The caller asks for "a payment gateway for UPI" and receives something that satisfies `PaymentGateway`.

#### Why does it exist?

Construction logic is a concern. When the choice of implementation depends on runtime data (payment method, tenant, country, feature flag), scattering that `if` across callers means every caller knows every implementation. Centralising it in a factory keeps callers OCP-compliant and makes the selection rule testable on its own.

#### Mental model

Imagine a car rental desk. You say "I need something for five people and a mountain road". The desk hands you keys. You did not pick the model, and you did not learn the fleet's inventory system.

#### How it works

1. Define the product interface (`PaymentGateway`).
2. Implement each concrete product (Stripe, Razorpay, PayPal).
3. The factory receives the selection input and returns the right product. In NestJS the factory is a provider that has all concrete products injected (so their own dependencies are resolved by the container), and it selects among them.
4. Callers depend on the factory and the interface, never on concrete products.

#### NestJS example: payment provider factory

```ts
// src/modules/payments/application/ports/payment.gateway.ts
export type PaymentMethod = 'card' | 'upi' | 'paypal' | 'netbanking';
export interface PaymentGateway {
  readonly provider: 'stripe' | 'razorpay' | 'paypal';
  supports(method: PaymentMethod, currency: string): boolean;
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(paymentId: string, amount: Money, idempotencyKey: string): Promise<void>;
}

// src/modules/payments/application/payment-gateway.factory.ts
@Injectable()
export class PaymentGatewayFactory {
  constructor(
    private readonly stripe: StripeGateway,
    private readonly razorpay: RazorpayGateway,
    private readonly paypal: PaypalGateway,
    private readonly flags: FeatureFlags,
  ) {}

  for(method: PaymentMethod, currency: string): PaymentGateway {
    // Selection rules live here and only here. They are testable without any SDK.
    if (method === 'upi' || method === 'netbanking') return this.razorpay;
    if (method === 'paypal') return this.paypal;
    if (currency === 'INR' && this.flags.isOn('cards-via-razorpay')) return this.razorpay;
    return this.stripe;
  }

  byProvider(provider: PaymentGateway['provider']): PaymentGateway {
    const g = [this.stripe, this.razorpay, this.paypal].find((x) => x.provider === provider);
    if (!g) throw new DomainError('PAYMENT_PROVIDER_UNKNOWN', provider);
    return g; // used by webhook handlers and refunds, which know the original provider
  }
}

// Caller
const gateway = this.gateways.for(cmd.method, order.total.currency);
const result = await gateway.charge({ orderId: order.id, amount: order.total, idempotencyKey: `order:${order.id}` });
await this.orders.recordPayment(order.id, gateway.provider, result.paymentId); // persist provider for later refunds
```

Storing `gateway.provider` alongside the payment is essential: a refund six months later must go to the provider that took the money, regardless of what the selection rule says today.

#### Factory vs `useFactory`

NestJS's `useFactory` provider option is a *construction-time* factory: it runs once at bootstrap to build a provider (an SDK client, a connection). The Factory *pattern* above is a *runtime* factory: it selects per call based on data. They complement each other: `useFactory` builds the Stripe client once; `PaymentGatewayFactory.for()` picks among gateways per order.

#### When NOT to use it

- One implementation exists and none is planned. A factory over one product is noise.
- The selection is static per deployment (always Stripe in the EU deployment). Use `useClass` bound by environment in the module instead.
- The "factory" would just call `new` with no decision. A constructor is already a factory.

#### Common mistakes

- Abstract factory hierarchies (`AbstractPaymentGatewayFactory`, `PaymentGatewayFactoryImpl`) for a three-way selection.
- Factories that also perform the operation ("create and charge"), mixing selection with behaviour.
- Selection rules duplicated in callers because the factory's API was awkward.
- Forgetting to persist which product was chosen, so later operations (refund, webhook) cannot find their way back.

#### Interview questions

1. *Why put provider selection in a factory rather than in the use case?* Expected: OCP; single place for rules; testable selection; callers unaware of concrete types.
2. *How does the NestJS container help implement a factory?* Expected: inject all concrete products, each with its own resolved dependencies; the factory only selects.
3. *What must you persist when a factory picks a provider at runtime?* Expected: the chosen provider id, for refunds and webhooks.

#### Practical exercise

Implement `PaymentGatewayFactory` with three gateway classes (two can be fakes) and a feature flag. Write unit tests for every selection rule with no SDKs. Add a refund use case that uses `byProvider` from the persisted provider id.

Acceptance criteria: selection tests cover each branch and run in under 50 ms; adding a fourth gateway requires no change to any use case; refunds route to the provider recorded at charge time even when the selection rule has changed.
