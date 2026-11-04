# Part 6 — Clean Code Principles and Design Patterns

Part 5 covered the shape of systems: which process runs what, who owns which data. This part goes one level down, to the shape of code inside a module. Principles like SOLID and DRY, and patterns like Repository, Strategy and Unit of Work, are the vocabulary senior engineers use to keep a NestJS codebase changeable after three years and thirty contributors.

Two warnings up front. First, every principle here can be over-applied; a codebase that follows all of them mechanically is often harder to read than one that follows none. Each section therefore includes a note on where juniors misapply the idea. Second, patterns are not features. You do not "add the Strategy pattern"; you notice a specific pain (a growing `switch` on payment provider) and reach for the pattern that removes it. Learn the pain first, then the pattern.

## 6.1 SOLID

SOLID is five principles collected by Robert C. Martin. They are about **managing dependencies between classes** so that change in one place does not ripple everywhere. We take them one at a time, each with a realistic NestJS before-and-after.

### 6.1.1 Single Responsibility Principle (SRP)

#### Concept

A class should have one reason to change. Not "one method" or "does one thing", but one *reason*: one group of stakeholders whose requirement changes would force you to edit it.

#### Why does it exist?

When one class serves several masters, every change for one master risks breaking the others, and the class accumulates dependencies from all of them. A service that handles order creation, payment, email and inventory has four teams' worth of change pressure and thirty injected dependencies. Every test needs thirty mocks.

#### Mental model

Imagine a restaurant employee who cooks, waits tables and does the accounting. When the menu changes, the accounts might break because the same person's routine changed. Give each job to a separate role and menu changes stay in the kitchen.

#### NestJS example

Before: the classic God service.

```ts
// BEFORE: one class, four reasons to change (orders, payments, email, inventory)
@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(Product) private products: Repository<Product>,
    private readonly stripe: Stripe,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  async checkout(userId: string, items: { productId: string; qty: number }[]) {
    // inventory logic
    for (const it of items) {
      const p = await this.products.findOneByOrFail({ id: it.productId });
      if (p.stock < it.qty) throw new ConflictException('out of stock');
      p.stock -= it.qty;
      await this.products.save(p);
    }
    // order logic
    const order = await this.orders.save(this.orders.create({ userId, items, status: 'CREATED' }));
    // payment logic
    const intent = await this.stripe.paymentIntents.create({ amount: order.totalMinor, currency: 'inr' });
    order.paymentIntentId = intent.id;
    await this.orders.save(order);
    // email logic
    await this.mailer.sendMail({
      to: await this.lookupEmail(userId),
      subject: 'Order confirmed',
      html: `<h1>Thanks!</h1><p>Order ${order.id}</p>`,
    });
    return order;
  }
}
```

After: each responsibility in its own provider, with the use case as a thin orchestrator.

```ts
// AFTER: PlaceOrderUseCase orchestrates; each collaborator has one reason to change
@Injectable()
export class PlaceOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly inventory: InventoryFacade,      // owns stock rules
    @Inject(PAYMENT_GATEWAY) private readonly payments: PaymentGateway, // owns provider calls
    private readonly events: EventEmitter2,           // notifications react to events
  ) {}

  async execute(cmd: PlaceOrderCommand): Promise<{ orderId: string }> {
    const reservation = await this.inventory.reserve({ orderId: cmd.orderId, lines: cmd.lines });
    const order = Order.create(cmd.orderId, cmd.customerId, toLines(cmd.lines), new Date());
    await this.orders.save(order);
    const { paymentId } = await this.payments.charge({ orderId: order.id, amount: order.total, idempotencyKey: `order:${order.id}` });
    order.markPaid();
    await this.orders.save(order);
    await this.events.emitAsync('order.paid', new OrderPaidEvent({ orderId: order.id, paymentId, reservationId: reservation.reservationId }));
    return { orderId: order.id };
  }
}
```

Email now lives in `NotificationsModule` as an `@OnEvent('order.paid')` handler. The marketing team can change the template without touching checkout, and the checkout test needs three small fakes instead of a Stripe mock and a mailer mock.

#### Where juniors misapply this

They read "one responsibility" as "one method per class" and produce `OrderCreator`, `OrderSaver`, `OrderValidator`, `OrderTotalCalculator`, each with four lines, and a checkout that is impossible to read because the logic is scattered across twelve files. The unit is *reason to change*, not *method*. A use case that orchestrates five steps of one business operation has one reason to change: that business operation.

#### Interview questions

1. *Define SRP precisely.* Expected: one reason to change, one group of stakeholders; not "one method".
2. *How do you recognise an SRP violation in a NestJS service?* Expected: many constructor dependencies from unrelated areas, tests with many mocks, changes from different teams in the same file.

### 6.1.2 Open/Closed Principle (OCP)

#### Concept

Software entities should be open for extension but closed for modification. You should be able to add a new behaviour (a new payment provider, a new shipping method) by adding code, not by editing the existing, tested code.

#### Why does it exist?

Editing working code risks breaking it. If adding Razorpay means editing the Stripe code path's `switch`, every payment provider addition re-tests every provider. OCP is achieved through abstraction: the code depends on an interface, and new behaviour is a new implementation.

#### Mental model

Imagine a power strip. You add a new device by plugging it in; you do not rewire the strip. The socket standard is the abstraction.

#### NestJS example

Before: a `switch` that grows with every provider.

```ts
// BEFORE: every new provider edits this method and its tests
async charge(order: Order, method: 'card' | 'upi' | 'paypal') {
  switch (method) {
    case 'card': return this.stripe.paymentIntents.create({ amount: order.totalMinor, currency: 'inr' });
    case 'upi':  return this.razorpay.orders.create({ amount: order.totalMinor, currency: 'INR' });
    case 'paypal': return this.paypal.orders.create({ purchase_units: [{ amount: { value: order.totalMajor } }] });
  }
}
```

After: a `PaymentGateway` interface, one class per provider, and a registry that maps method to gateway. Adding PayPal is a new file plus one line in the module.

```ts
export interface PaymentGateway {
  readonly method: PaymentMethod;
  charge(input: ChargeInput): Promise<ChargeResult>;
}

@Injectable()
export class StripeGateway implements PaymentGateway {
  readonly method = 'card' as const;
  constructor(private readonly stripe: Stripe) {}
  async charge(input: ChargeInput): Promise<ChargeResult> {
    const intent = await this.stripe.paymentIntents.create(
      { amount: input.amount.minor, currency: input.amount.currency.toLowerCase(), metadata: { orderId: input.orderId } },
      { idempotencyKey: input.idempotencyKey },
    );
    return { paymentId: intent.id, status: intent.status === 'succeeded' ? 'CAPTURED' : 'PENDING' };
  }
}

export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');

@Injectable()
export class PaymentGatewayRegistry {
  private readonly byMethod = new Map<PaymentMethod, PaymentGateway>();
  constructor(@Inject(PAYMENT_GATEWAYS) gateways: PaymentGateway[]) {
    for (const g of gateways) this.byMethod.set(g.method, g);
  }
  for(method: PaymentMethod): PaymentGateway {
    const g = this.byMethod.get(method);
    if (!g) throw new DomainError('PAYMENT_METHOD_UNSUPPORTED', `no gateway for ${method}`);
    return g;
  }
}

// payments.module.ts: the only line that changes when adding a provider
{ provide: PAYMENT_GATEWAYS, useFactory: (s: StripeGateway, r: RazorpayGateway, p: PaypalGateway) => [s, r, p], inject: [StripeGateway, RazorpayGateway, PaypalGateway] },
```

#### Where juniors misapply this

They abstract before there is a second implementation. An interface with one implementation and a factory for it is speculation, not OCP. The rule of thumb: introduce the abstraction when the second concrete case arrives, or when you know with certainty it is coming this quarter. Until then, a `switch` with two cases is honest code.

#### Interview questions

1. *How does OCP relate to the Strategy pattern?* Expected: Strategy is the usual mechanism; interface plus implementations plus selection.
2. *When is a `switch` acceptable?* Expected: few stable cases, no second implementation on the horizon, or when the switch is the single selection point (a factory).

### 6.1.3 Liskov Substitution Principle (LSP)

#### Concept

If code works with an interface, it must work with every implementation of that interface without knowing which one it got. Subtypes must honour the contract of the supertype: same inputs accepted, same guarantees on outputs, no surprising exceptions, no strengthened preconditions, no weakened postconditions.

#### Why does it exist?

Abstractions are only useful if callers can trust them. If `PaymentGateway.charge()` returns a `paymentId` for Stripe but returns `null` for a bank transfer adapter "because bank transfers are async", every caller must now check for null and, in effect, know which adapter it has. The abstraction has leaked and OCP is gone.

#### Mental model

Imagine renting a car. Any car from the rental company should have a steering wheel, brakes, and an accelerator that do the same things. If one car's brake pedal accelerates, "it's still a car" is not a defence.

#### NestJS example

A subtle LSP violation with payment provider adapters:

```ts
// The contract: charge() either captures funds and returns CAPTURED, or returns PENDING
// with a paymentId that a webhook will later resolve. It throws PaymentDeclinedError on decline.
export interface PaymentGateway {
  charge(input: ChargeInput): Promise<{ paymentId: string; status: 'CAPTURED' | 'PENDING' }>;
}

// VIOLATION: this adapter throws for a normal outcome and returns a different shape for "pending"
@Injectable()
export class BankTransferGateway implements PaymentGateway {
  async charge(input: ChargeInput) {
    if (input.amount.minor > 50_000_00) throw new Error('bank transfers over 50k need manual approval'); // new precondition
    return { paymentId: '', status: 'PENDING' as const }; // empty id breaks the "paymentId identifies the payment" guarantee
  }
}
```

Callers written against Stripe and Razorpay now break in two ways: the empty `paymentId` is stored and later fails a `NOT NULL`/unique constraint, and the manual-approval `Error` is not a `PaymentDeclinedError`, so the generic error handler returns a 500 and the order is left in limbo.

The fix keeps the contract honest:

```ts
@Injectable()
export class BankTransferGateway implements PaymentGateway {
  constructor(private readonly ids: IdGenerator, private readonly approvals: ManualApprovalQueue) {}

  async charge(input: ChargeInput) {
    const paymentId = this.ids.next('bt'); // a real identifier, always
    if (input.amount.minor > 50_000_00) {
      await this.approvals.enqueue({ paymentId, orderId: input.orderId, amount: input.amount });
    }
    // PENDING is a valid contract outcome; the webhook/approval flow resolves it later
    return { paymentId, status: 'PENDING' as const };
  }
}
```

If bank transfers genuinely cannot satisfy the contract, the right move is a different interface (`DeferredPaymentGateway`) and explicit handling, not a subtype that lies.

#### Where juniors misapply this

They think LSP is about class inheritance only. In TypeScript, it applies to every `implements` and every structural type. The most common violation is an adapter that throws a generic `Error` where the contract promises a typed domain error, or that returns `undefined` where the contract promises a value.

#### Interview questions

1. *Give an example of an LSP violation that does not involve inheritance.* Expected: an adapter implementing an interface but breaking its guarantees (null return, new exception, stronger precondition).
2. *How do you test LSP compliance across adapters?* Expected: a shared contract test suite run against every implementation (`describe.each` over adapters).

### 6.1.4 Interface Segregation Principle (ISP)

#### Concept

Clients should not be forced to depend on methods they do not use. Prefer several small, role-specific interfaces over one large general-purpose one.

#### Why does it exist?

A fat interface couples every client to every method. A `ProductRepository` with 25 methods must be fully mocked in every test, fully implemented by every adapter (including the in-memory one), and any change to any method touches every implementation. It also hides what a use case actually needs.

#### Mental model

Imagine a TV remote with 80 buttons when you only use 5. Now imagine you have to learn all 80 to be allowed to use the 5. That is a fat interface. A small remote per purpose is ISP.

#### NestJS example

Before: one repository interface for everything.

```ts
// BEFORE: every consumer sees, mocks and depends on all of this
export interface ProductRepository {
  findById(id: string): Promise<Product | null>;
  findBySku(sku: string): Promise<Product | null>;
  search(filter: ProductFilter, page: Page): Promise<Product[]>;
  save(p: Product): Promise<void>;
  delete(id: string): Promise<void>;
  decrementStock(id: string, qty: number): Promise<boolean>;
  bulkImport(rows: ProductRow[]): Promise<void>;
  countByCategory(): Promise<Record<string, number>>;
  // ... 17 more
}
```

After: narrow, role-based interfaces; a use case depends only on the one it needs.

```ts
export interface ProductReader {
  findById(id: string): Promise<Product | null>;
}
export interface ProductSearcher {
  search(filter: ProductFilter, page: Page): Promise<Product[]>;
}
export interface ProductWriter {
  save(p: Product): Promise<void>;
}
export interface StockAdjuster {
  decrementStock(id: string, qty: number): Promise<boolean>;
}

export const PRODUCT_READER = Symbol('PRODUCT_READER');
export const STOCK_ADJUSTER = Symbol('STOCK_ADJUSTER');

// The TypeORM class can implement several; each token maps to the same instance.
@Injectable()
export class TypeormProductRepository implements ProductReader, ProductSearcher, ProductWriter, StockAdjuster { /* ... */ }

// products.module.ts
providers: [
  TypeormProductRepository,
  { provide: PRODUCT_READER, useExisting: TypeormProductRepository },
  { provide: STOCK_ADJUSTER, useExisting: TypeormProductRepository },
],

// A use case now declares exactly what it needs; its test fakes one method.
@Injectable()
export class ReserveStockUseCase {
  constructor(@Inject(STOCK_ADJUSTER) private readonly stock: StockAdjuster) {}
}
```

`useExisting` is the NestJS provider type that aliases one token to another provider's instance; it is exactly what ISP needs.

#### Where juniors misapply this

They create an interface per method for everything, ending up with `FindProductByIdPort`, `FindProductBySkuPort`, and a module with 40 tokens. Group by *role* (reader, writer, searcher), not per method. A role is a coherent set of operations one kind of client needs.

#### Interview questions

1. *What is the cost of a fat repository interface in tests?* Expected: mocking every method; brittle tests; hidden dependencies.
2. *How does NestJS `useExisting` help with ISP?* Expected: one implementation exposed under several narrow tokens.

### 6.1.5 Dependency Inversion Principle (DIP)

#### Concept

High-level modules (business rules) should not depend on low-level modules (database, HTTP clients). Both should depend on abstractions. And the abstraction is owned by the high-level side: the use case defines the `PaymentGateway` interface it needs; the Stripe adapter conforms to it.

#### Why does it exist?

Without DIP, the direction of dependency follows the direction of the call: use case calls Stripe, so use case imports Stripe. Now the most important code depends on the most volatile. DIP flips the import direction while keeping the call direction, which is the entire trick behind hexagonal architecture.

#### Mental model

Imagine a wall socket again, but notice who defined the standard: the building (high level) defines the socket; appliance makers (low level) conform. The building does not adapt to each appliance.

#### NestJS example

DIP in NestJS is expressed with injection tokens and interfaces, because TypeScript interfaces do not exist at runtime and cannot be injected by type.

```ts
// application/ports/payment.gateway.ts   (owned by the high-level side)
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
export interface PaymentGateway {
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(paymentId: string, amount: Money, idempotencyKey: string): Promise<void>;
}

// application/refund-order.use-case.ts   (imports the port, never Stripe)
@Injectable()
export class RefundOrderUseCase {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly payments: PaymentGateway,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
  ) {}
  async execute(orderId: string, reason: string): Promise<void> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND', orderId);
    order.requestRefund(reason);                // domain rule: only PAID or SHIPPED orders
    await this.payments.refund(order.paymentId!, order.total, `refund:${orderId}`);
    order.markRefunded();
    await this.orders.save(order);
  }
}

// infrastructure/stripe/stripe-payment.gateway.ts   (imports Stripe AND the port)
@Injectable()
export class StripePaymentGateway implements PaymentGateway { /* ... */ }

// payments.module.ts   (the composition root: the only file that knows both)
providers: [{ provide: PAYMENT_GATEWAY, useClass: StripePaymentGateway }]
```

In tests:

```ts
const payments: PaymentGateway = { charge: jest.fn(), refund: jest.fn().mockResolvedValue(undefined) };
const useCase = new RefundOrderUseCase(payments, new InMemoryOrderRepository([paidOrder]));
```

No `Test.createTestingModule`, no Stripe SDK, no network.

#### Where juniors misapply this

They put the interface next to the implementation (`infrastructure/stripe/payment-gateway.interface.ts`), which means the use case still imports from `infrastructure`. The interface must live with the *consumer* (`application/ports/`). They also create interfaces for things that will never vary and have no test value, like `ConfigService`, adding indirection with no benefit.

#### Interview questions

1. *Why can you not inject a TypeScript interface directly in NestJS?* Expected: interfaces are erased at compile time; use a `Symbol`/string token with `@Inject`.
2. *Who owns the abstraction under DIP, and why does it matter?* Expected: the high-level consumer; otherwise the import direction still points at infrastructure.
3. *Show how DIP and hexagonal architecture relate.* Expected: ports are DIP abstractions; adapters are the low-level implementations; the module is the composition root.

#### Practical exercise (SOLID as a whole)

Take a `OrderService` of at least 300 lines from a real or sample project. Produce a refactoring plan that names, for each SOLID letter, one concrete violation and the fix. Implement the SRP and DIP fixes.

Acceptance criteria: the resulting use case has at most four constructor dependencies, all injected via tokens with interfaces owned by `application/ports/`; its unit tests run without NestJS's testing module or a database; a contract test suite runs against every `PaymentGateway` implementation with `describe.each`.
