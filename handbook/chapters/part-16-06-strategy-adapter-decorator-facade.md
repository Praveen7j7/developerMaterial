## 16.14 Strategy pattern

#### Concept

Strategy defines a family of interchangeable algorithms behind one interface, so the algorithm can be chosen at runtime without the caller knowing which one it got. Shipping cost calculation (flat, weight-based, distance-based, free over a threshold), pricing (list, tiered, negotiated), authentication (JWT, API key, OAuth) are all families of strategies.

Strategy and Factory are often used together: the factory picks the strategy; the strategy does the work.

#### Why does it exist?

Without it, the algorithm choice is a `switch` inside the calling code, and every new variant edits and re-tests the caller. Strategy moves each variant into its own class with its own tests, and the caller collapses to `strategy.calculate(input)`.

#### Mental model

Imagine navigation apps offering "fastest", "shortest", "avoid tolls". Same input (origin, destination), same output (a route), different algorithm. You pick one; the map does not care how it computes.

#### NestJS example: shipping cost strategies

```ts
// domain/shipping/shipping-strategy.ts
export interface ShippingContext { weightGrams: number; distanceKm: number; subtotal: Money; isPrime: boolean }
export interface ShippingStrategy {
  readonly code: string;
  applies(ctx: ShippingContext): boolean;
  cost(ctx: ShippingContext): Money;
}

export class FreeOverThresholdStrategy implements ShippingStrategy {
  readonly code = 'FREE_OVER_THRESHOLD';
  constructor(private readonly threshold: Money) {}
  applies(ctx: ShippingContext) { return ctx.subtotal.greaterThanOrEqual(this.threshold); }
  cost() { return Money.zero('INR'); }
}

export class WeightBandStrategy implements ShippingStrategy {
  readonly code = 'WEIGHT_BAND';
  constructor(private readonly bands: { upToGrams: number; priceMinor: number }[]) {}
  applies() { return true; } // default
  cost(ctx: ShippingContext) {
    const band = this.bands.find((b) => ctx.weightGrams <= b.upToGrams) ?? this.bands[this.bands.length - 1];
    return Money.of(band.priceMinor, 'INR');
  }
}

export class PrimeStrategy implements ShippingStrategy {
  readonly code = 'PRIME';
  applies(ctx: ShippingContext) { return ctx.isPrime; }
  cost() { return Money.zero('INR'); }
}

// application: strategies are ordered; the first that applies wins
@Injectable()
export class ShippingCalculator {
  constructor(@Inject(SHIPPING_STRATEGIES) private readonly strategies: ShippingStrategy[]) {}
  quote(ctx: ShippingContext): { code: string; cost: Money } {
    const s = this.strategies.find((x) => x.applies(ctx));
    if (!s) throw new DomainError('NO_SHIPPING_STRATEGY', 'no strategy applies');
    return { code: s.code, cost: s.cost(ctx) };
  }
}

// module: order matters and is explicit
{ provide: SHIPPING_STRATEGIES, useFactory: (cfg: ConfigService) => [
    new PrimeStrategy(),
    new FreeOverThresholdStrategy(Money.of(cfg.get('FREE_SHIP_MINOR', 99_900), 'INR')),
    new WeightBandStrategy([{ upToGrams: 500, priceMinor: 4_900 }, { upToGrams: 2_000, priceMinor: 9_900 }, { upToGrams: 10_000, priceMinor: 19_900 }]),
  ], inject: [ConfigService] },
```

Pricing strategies follow the same shape: `PricingStrategy.price(product, customer)` with `ListPrice`, `TieredVolumePrice`, `ContractPrice` implementations, selected by customer type.

#### Strategy in Passport authentication

`@nestjs/passport` is the Strategy pattern as a library. Each `PassportStrategy` subclass is one authentication algorithm; `AuthGuard('jwt')` or `AuthGuard('api-key')` picks it by name.

```ts
// JWT strategy for users
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: config.getOrThrow('JWT_PUBLIC_KEY'), algorithms: ['RS256'] });
  }
  async validate(payload: { sub: string; roles: string[] }) { return { id: payload.sub, roles: payload.roles }; }
}

// API key strategy for partner integrations
@Injectable()
export class ApiKeyStrategy extends PassportStrategy(HeaderAPIKeyStrategy, 'api-key') {
  constructor(private readonly partners: PartnerKeyReader) {
    super({ header: 'x-api-key', prefix: '' }, false);
  }
  async validate(key: string) {
    const partner = await this.partners.findByHashedKey(hashApiKey(key)); // never store raw keys
    if (!partner || partner.revokedAt) throw new UnauthorizedException();
    return { id: partner.id, roles: ['partner'] };
  }
}

// Controllers choose the strategy by name; the handler code is the same
@UseGuards(AuthGuard(['jwt', 'api-key'])) // tries jwt, then api-key
@Get('orders')
list(@Req() req) { return this.listOrders.execute(req.user.id); }
```

#### When NOT to use it

- Two stable variants that will never grow: a well-named `if` is clearer than two classes and a token.
- The variants differ in data, not algorithm (different thresholds): use one strategy with configuration.
- The "strategy" needs to be chosen by the caller every time with full knowledge of implementations; then it is just polymorphism, and a factory is the missing piece.

#### Common mistakes

- Strategies with side effects (a shipping strategy that also creates a shipment). Keep them pure.
- Implicit ordering of an injected array; document and test the order.
- Strategy interfaces that grow methods only some strategies implement (ISP violation).

#### Interview questions

1. *Strategy vs Factory: who does what?* Expected: factory selects; strategy executes; often combined.
2. *How is Passport an example of Strategy?* Expected: named strategies, guard selects by name, same downstream code.
3. *When would you replace a strategy family with configuration?* Expected: when variants differ only in parameters.

## 16.15 Adapter pattern

#### Concept

An adapter converts the interface of a third-party or legacy component into the interface your code expects. Your domain defines `SmsSender { send(to, body): Promise<SmsReceipt> }`; the Twilio adapter, the MSG91 adapter and the AWS SNS adapter each translate that call into their SDK's shape and translate the SDK's responses and errors back into yours.

Hexagonal architecture's "adapters" are this pattern applied systematically.

#### Why does it exist?

Third-party SDKs have their own types, error classes, retry semantics, pagination styles and naming. If those leak into your use cases, switching vendors (or adding a fallback vendor) touches every caller, and every test must mock the vendor SDK. An adapter confines vendor knowledge to one class.

#### Mental model

Imagine a travel plug adapter. Your laptop charger has one plug shape. The wall in another country has another. The adapter sits between; neither the charger nor the wall changes.

#### NestJS example: SMS provider adapter

```ts
// application/ports/sms.sender.ts  (your shape)
export const SMS_SENDER = Symbol('SMS_SENDER');
export interface SmsReceipt { providerMessageId: string; provider: string; acceptedAt: Date }
export class SmsDeliveryError extends Error {
  constructor(readonly code: 'INVALID_NUMBER' | 'RATE_LIMITED' | 'PROVIDER_DOWN' | 'UNKNOWN', message: string, readonly retryable: boolean) { super(message); }
}
export interface SmsSender {
  send(input: { toE164: string; body: string; idempotencyKey: string }): Promise<SmsReceipt>;
}

// infrastructure/sms/twilio-sms.adapter.ts  (the vendor's shape, translated)
import { Twilio } from 'twilio';

@Injectable()
export class TwilioSmsAdapter implements SmsSender {
  private readonly log = new Logger(TwilioSmsAdapter.name);
  constructor(@Inject(TWILIO_CLIENT) private readonly client: Twilio, private readonly config: ConfigService) {}

  async send(input: { toE164: string; body: string; idempotencyKey: string }): Promise<SmsReceipt> {
    try {
      const msg = await this.client.messages.create({
        to: input.toE164,
        from: this.config.getOrThrow('TWILIO_FROM'),
        body: input.body,
      });
      return { providerMessageId: msg.sid, provider: 'twilio', acceptedAt: new Date() };
    } catch (err: any) {
      // Translate vendor error codes into YOUR error vocabulary, including retryability.
      const code = Number(err?.code);
      if (code === 21211 || code === 21614) throw new SmsDeliveryError('INVALID_NUMBER', err.message, false);
      if (err?.status === 429) throw new SmsDeliveryError('RATE_LIMITED', err.message, true);
      if (err?.status >= 500) throw new SmsDeliveryError('PROVIDER_DOWN', err.message, true);
      this.log.error(`twilio unknown error ${err?.code}: ${err?.message}`);
      throw new SmsDeliveryError('UNKNOWN', err?.message ?? 'unknown', false);
    }
  }
}
```

A second adapter for MSG91 translates a completely different HTTP API into the same `SmsReceipt` and `SmsDeliveryError`. A `FailoverSmsSender` (itself implementing `SmsSender`) can wrap two adapters and try the second when the first throws a retryable error. Callers only ever see `SmsSender`.

The error translation is the part juniors skip and the part that matters most in production: your retry logic must decide "retry or not" from *your* error type, not from a vendor-specific status buried in an SDK exception.

#### When NOT to use it

- A library that already matches your needs well and will not be swapped (a UUID generator, a date library). Wrapping `date-fns` in a `DateAdapter` is ceremony.
- When the "adapter" adds no translation and no error mapping; then it is a pass-through and you have added a file for nothing.

#### Common mistakes

- Adapters that leak vendor types in their return values (returning Twilio's `MessageInstance`).
- Adapters without error translation, so callers catch vendor exceptions anyway.
- Putting business rules in the adapter ("don't send marketing SMS at night" belongs in a policy, not in Twilio's adapter).
- No timeouts on the SDK client; adapters must configure them.

#### Interview questions

1. *What belongs in an adapter and what does not?* Expected: shape and error translation, timeouts, vendor auth; no business rules.
2. *How does an adapter enable failover between two SMS vendors?* Expected: both implement the port; a composite implementation tries the second on retryable errors.
3. *Why translate vendor errors?* Expected: retry decisions and HTTP mapping should not depend on vendor codes.

## 16.16 Decorator pattern

#### Concept

The GoF Decorator pattern wraps an object with another object that has the **same interface** and adds behaviour before or after delegating: caching, logging, retries, metrics, authorisation. The caller cannot tell the difference. Decorators stack: `Metrics(Cache(Retry(TypeormOrderRepository)))`.

This is *not* the same thing as TypeScript/NestJS `@Decorators`. Those are compile-time annotations that attach metadata or modify class definitions (`@Injectable()`, `@Get()`, `@Column()`). The GoF pattern is a runtime composition of objects. They share a name and nothing else.

#### Why does it exist?

Cross-cutting behaviour (caching a repository's reads) should not be written inside the repository (which is about persistence), and should not be written in every caller. A decorator adds it in one place, transparently, and can be turned on or off by wiring.

#### Mental model

Imagine gift wrapping. The gift is the same; each layer of wrapping adds something (a box, paper, a ribbon) and can be added or removed without changing the gift.

#### NestJS example: caching decorator over a repository

```ts
// infrastructure/cache/cached-product.reader.ts
import { Cache } from 'cache-manager';

@Injectable()
export class CachedProductReader implements ProductReader {
  constructor(
    private readonly inner: ProductReader,          // the wrapped implementation
    private readonly cache: Cache,                  // from @nestjs/cache-manager (CACHE_MANAGER)
    private readonly ttlMs = 30_000,
  ) {}

  async findById(id: string): Promise<Product | null> {
    const key = `product:${id}`;
    const hit = await this.cache.get<SerializedProduct>(key);
    if (hit) return ProductMapper.deserialize(hit);
    const product = await this.inner.findById(id);           // delegate
    if (product) await this.cache.set(key, ProductMapper.serialize(product), this.ttlMs);
    return product;
  }
}

// products.module.ts: wiring the stack. Callers inject PRODUCT_READER and see only the interface.
providers: [
  TypeormProductRepository,
  {
    provide: PRODUCT_READER,
    useFactory: (repo: TypeormProductRepository, cache: Cache) => new CachedProductReader(repo, cache),
    inject: [TypeormProductRepository, CACHE_MANAGER],
  },
],
```

A metrics decorator with the same shape:

```ts
export class TimedProductReader implements ProductReader {
  constructor(private readonly inner: ProductReader, private readonly histogram: Histogram) {}
  async findById(id: string) {
    const end = this.histogram.startTimer({ op: 'product.findById' });
    try { return await this.inner.findById(id); } finally { end(); }
  }
}
// wiring: new TimedProductReader(new CachedProductReader(repo, cache), histogram)
```

#### NestJS interceptors as decorators

NestJS interceptors (`@UseInterceptors(CacheInterceptor)`) are the framework's built-in decorator mechanism for controller handlers: they wrap the handler with before/after behaviour. Use them for HTTP-level concerns (response caching, timing, response mapping). Use the GoF pattern for provider-level concerns (repository caching, gateway retries), where there is no request pipeline.

#### When NOT to use it

- When the behaviour is not truly cross-cutting and belongs inside the class (an order's total calculation is not a decorator).
- When stacking more than three or four decorators makes the wiring unreadable; consider a middleware pipeline abstraction or, for HTTP, interceptors.
- Cache decorators over *write* methods or over methods whose results depend on the caller (per-user data) unless the key includes that context.

#### Common mistakes

- Decorator that changes the contract (returns cached stale data where the interface promises fresh reads) without documenting it.
- Caching a method that returns mutable domain objects and then mutating the cached instance.
- Confusing `@Decorators` with the pattern in code review.
- Forgetting cache invalidation on write paths (see Part 30 — Caching for the strategies).

#### Interview questions

1. *Explain the difference between NestJS `@Decorators` and the GoF Decorator pattern.* Expected: metadata annotation vs runtime wrapping with same interface.
2. *How would you add caching to a repository without editing it?* Expected: decorator implementing the same port, wired via `useFactory`.
3. *What changes when you stack Retry outside Cache versus inside?* Expected: retry-outside retries cache misses' inner calls; retry-inside is retried per inner call; order determines semantics.

## 16.17 Facade pattern

#### Concept

A facade is a single, simplified entry point over a set of more complex subsystems. `CheckoutFacade.placeOrder(cmd)` hides that the operation involves inventory reservation, pricing, payment, order persistence and event publishing across three modules. The caller sees one method.

In the modular monolith (Part 15), each module's `public/*.facade.ts` is this pattern applied at the module boundary.

#### Why does it exist?

Callers should not need to know the choreography of five subsystems to do one business thing. Without a facade, that choreography is duplicated in every caller (HTTP controller, GraphQL resolver, admin CLI, Kafka consumer) and drifts. A facade also defines the module's public surface, which is what keeps the rest of the module private.

#### Mental model

Imagine a hotel concierge. You say "I want dinner and a show tonight". The concierge calls the restaurant, the theatre and the taxi company. You made one request.

#### NestJS example: checkout facade over inventory, payment, shipping

```ts
// src/modules/checkout/public/checkout.facade.ts
@Injectable()
export class CheckoutFacade {
  constructor(
    private readonly placeOrder: PlaceOrderUseCase,
    private readonly quoteShipping: ShippingCalculator,
    private readonly inventory: InventoryFacade,     // another module's facade
    private readonly pricing: PricingFacade,
  ) {}

  // One call for the client; the facade sequences the subsystems and shapes the result.
  async quote(cmd: QuoteCommand): Promise<QuoteResult> {
    const [availability, prices] = await Promise.all([
      this.inventory.availability(cmd.lines.map((l) => l.productId)),
      this.pricing.priceLines(cmd.customerId, cmd.lines),
    ]);
    const unavailable = cmd.lines.filter((l) => (availability.get(l.productId) ?? 0) < l.qty);
    const subtotal = prices.reduce((s, p) => s.add(p.lineTotal), Money.zero('INR'));
    const shipping = this.quoteShipping.quote({ weightGrams: prices.reduce((w, p) => w + p.weightGrams, 0), distanceKm: cmd.distanceKm, subtotal, isPrime: cmd.isPrime });
    return { subtotal, shipping: shipping.cost, shippingCode: shipping.code, unavailable: unavailable.map((l) => l.productId) };
  }

  async place(cmd: PlaceOrderCommand): Promise<{ orderId: string }> {
    return this.placeOrder.execute(cmd);
  }
}
```

The HTTP controller, the GraphQL resolver and a partner API controller all call `CheckoutFacade`. None of them knows that pricing and availability are fetched in parallel or which shipping strategy applied.

#### Facade vs use case

A use case is one operation. A facade is a module's public API, which may expose several use cases and some queries. Small modules often skip the facade and export use cases directly; that is fine as long as the export list stays deliberate. Use a facade when the module has many use cases, when you want one stable type for other modules to depend on, or when extraction to a service is on the horizon (the facade's interface becomes the client's interface).

#### When NOT to use it

- A module with one or two use cases; export them directly.
- As a place to put logic. A facade that contains business rules is a God service with a nicer name.
- To hide a design problem (a facade over a tangle of circular dependencies does not remove the tangle).

#### Common mistakes

- Facades that expose internal types (entities, ORM models) instead of DTOs.
- Facades that grow to 40 methods (that is a module boundary problem, not a facade problem).
- Calling one module's use cases directly from another module, bypassing the facade, "just this once".

#### Interview questions

1. *How does a facade support later extraction into a service?* Expected: async DTO-in/DTO-out interface identical to a network client; swap implementation via DI.
2. *What should never appear in a facade's signature?* Expected: entities, ORM types, `EntityManager`.
3. *Facade vs use case?* Expected: module API vs single operation.

#### Practical exercise (patterns 16.14 to 16.17 together)

Build a notifications module with: an `SmsSender` port with two adapters (one real or realistic, one fake) and a `FailoverSmsSender` decorator; a `SendPolicy` strategy list (opt-in, quiet hours, throttle); and a `NotificationsFacade` exposing `notify(userId, kind, payload)`. Consume it from an `@OnEvent('order.paid')` handler.

Acceptance criteria: the facade is the module's only export; the quiet-hours strategy is unit-tested with a fake clock; failover is tested by making the first adapter throw a retryable `SmsDeliveryError`; no vendor type appears outside `infrastructure/`.
