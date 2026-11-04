## 6.8 Composition over inheritance

#### Concept

Composition means building behaviour by combining objects that each do one thing: an `OrderPricer` that *has* a `TaxCalculator` and a `DiscountPolicy`. Inheritance means building behaviour by extending a parent class: `DiscountedTaxedOrderPricer extends TaxedOrderPricer extends OrderPricer`. "Composition over inheritance" says: prefer the first.

#### Why does it exist?

Inheritance creates the tightest coupling in object-oriented code. A subclass depends on the parent's implementation details, not just its interface: which methods call which, what state is set when, which methods are safe to override. Change the parent and every subclass may break in ways the compiler cannot see (the "fragile base class" problem). Inheritance is also single-axis: you get one parent. Real behaviour varies on several axes at once (tax rules, discount rules, rounding rules), and a class hierarchy explodes combinatorially trying to cover them.

#### Mental model

Imagine building a meal. Inheritance is a fixed set menu: "Meal A", "Meal A with extra cheese", "Meal A with extra cheese and no onions", each a separate item on the menu. Composition is choosing a base, a protein and toppings independently. Three axes with four options each is 64 meals from 12 ingredients, versus 64 menu items.

#### NestJS example

Before: a hierarchy of notification senders.

```ts
// BEFORE: behaviour variation via inheritance; every combination is a new class
abstract class BaseNotifier {
  async send(userId: string, template: string, data: object) {
    const user = await this.loadUser(userId);
    if (!this.shouldSend(user)) return;
    const body = this.render(template, data);
    await this.deliver(user, body);
    await this.audit(user, template);
  }
  protected abstract deliver(user: User, body: string): Promise<void>;
  protected shouldSend(user: User) { return true; }
  protected render(template: string, data: object) { return renderHandlebars(template, data); }
  // ...
}
class EmailNotifier extends BaseNotifier { protected async deliver(u: User, body: string) { /* SES */ } }
class MarketingEmailNotifier extends EmailNotifier { protected shouldSend(u: User) { return u.marketingOptIn; } }
class ThrottledMarketingEmailNotifier extends MarketingEmailNotifier { protected shouldSend(u: User) { return super.shouldSend(u) && this.underLimit(u); } }
class SmsNotifier extends BaseNotifier { /* ... and now we need ThrottledMarketingSmsNotifier too */ }
```

After: small collaborators composed in a service.

```ts
export interface Channel { deliver(user: User, body: string): Promise<void> }
export interface SendPolicy { allows(user: User, kind: NotificationKind): Promise<boolean> }
export interface Renderer { render(template: string, data: object): string }

@Injectable()
export class Notifier {
  constructor(
    @Inject(CHANNELS) private readonly channels: Map<ChannelName, Channel>,   // email, sms, push
    @Inject(SEND_POLICIES) private readonly policies: SendPolicy[],          // opt-in, throttle, quiet hours
    @Inject(RENDERER) private readonly renderer: Renderer,
    private readonly audit: AuditLog,
  ) {}

  async send(user: User, kind: NotificationKind, channel: ChannelName, template: string, data: object): Promise<void> {
    for (const p of this.policies) if (!(await p.allows(user, kind))) return;
    const body = this.renderer.render(template, data);
    await this.channels.get(channel)!.deliver(user, body);
    await this.audit.record(user.id, kind, channel);
  }
}

// Adding "quiet hours" is a new SendPolicy class and one line in the module. No hierarchy changes.
@Injectable()
export class QuietHoursPolicy implements SendPolicy {
  constructor(private readonly clock: Clock) {}
  async allows(user: User, kind: NotificationKind) {
    if (kind === 'TRANSACTIONAL') return true;
    const hour = this.clock.nowIn(user.timezone).getHours();
    return hour >= 8 && hour < 21;
  }
}
```

Each policy and channel is independently testable. New combinations cost zero new classes.

#### Where inheritance is still fine

- **Framework base classes** that exist to be extended: `PassportStrategy(Strategy)`, `AuthGuard('jwt')`, `ExceptionFilter` implementations, TypeORM entity base classes for `id`/`createdAt`/`updatedAt` columns.
- **Domain error hierarchies**: `class InsufficientStockError extends DomainError`. Shallow (one level), stable, and used for `instanceof` in filters.
- **DTO inheritance** with `PartialType`, `PickType`, `OmitType` from `@nestjs/mapped-types` or `@nestjs/swagger`; these are compile-time conveniences, not behaviour hierarchies.

The rule: inherit for *is-a* relationships that are shallow and stable; compose for *behaviour variation*.

#### Where juniors misapply this

They read "composition over inheritance" as "inheritance is banned" and replace a two-level error hierarchy with a tag field and a `switch`. They also build `BaseService<T>` / `BaseController<T>` / `BaseRepository<T>` hierarchies "to reduce boilerplate" and end up with the exact fragile-base-class problem the principle warns about; every real service overrides half the base.

#### Interview questions

1. *What is the fragile base class problem?* Expected: subclasses depend on parent implementation details; parent changes break subclasses invisibly.
2. *Show how to replace a three-level inheritance chain with composition in NestJS.* Expected: extract axes into interfaces; inject implementations; iterate policies.
3. *Where is inheritance appropriate?* Expected: framework extension points, shallow error hierarchies, entity base columns.

#### Practical exercise

Find a `Base*Service` or `Base*Repository` in a codebase with at least two subclasses. List the methods each subclass overrides. Replace the hierarchy with composed collaborators.

Acceptance criteria: no `extends Base*` remains; each behaviour axis is an interface with at least one implementation; tests for each axis run without the others.

## 6.9 Coupling

#### Concept

Coupling is the degree to which one module depends on another. High coupling means a change in A forces changes in B. Low coupling means A and B can change independently. Coupling is not binary; it has kinds and directions, and knowing them tells you which dependencies are dangerous.

#### Why does it exist as a concept?

Because "reduce coupling" is useless advice without knowing what kind. A use case depending on a port is coupling, and it is fine. A service depending on the order in which another service's methods are called is also coupling, and it is a production incident waiting to happen. The vocabulary lets you name the problem.

#### Mental model

Imagine two dancers. Holding hands lightly (they can each move freely, adjusting) is loose coupling. Being tied together at the ankles (any step by one forces the other) is tight coupling. Being tied together *and* having to step in a specific order or fall over is temporal coupling.

#### Kinds of coupling, from best to worst

| Kind | Meaning | NestJS example | Verdict |
| --- | --- | --- | --- |
| Data coupling | Modules share only simple data through parameters | `inventory.reserve({ orderId, lines })` returning `{ reservationId }` | Ideal |
| Stamp (structure) coupling | A whole structure is passed when only part is used | Passing the entire `OrderEntity` to a function that needs `orderId` | Acceptable; watch for hidden dependencies |
| Control coupling | One module passes a flag telling the other what to do | `sendNotification(user, { asMarketing: true, skipThrottle: true })` | Smell; usually two functions in disguise |
| Temporal coupling | Correct behaviour depends on call order or timing | `repo.beginTx()` must be called before `repo.save()`; a `configure()` that must run before `charge()` | Dangerous; hard to see, easy to break |
| Common (global) coupling | Modules share global mutable state | A module-level `let currentTenant` set by middleware and read by services | Dangerous |
| Content coupling | One module reaches into another's internals | `OrdersService` querying `inventory.stock` directly; importing another module's `infrastructure/` | Worst; the modular monolith rules exist to prevent this |

Two more from a different axis:

- **Afferent coupling (Ca)**: how many modules depend *on* this one (incoming). A shared kernel has high Ca. High Ca means changes here are expensive and dangerous, so the module must be stable.
- **Efferent coupling (Ce)**: how many modules this one depends *on* (outgoing). A use case orchestrating five ports has Ce of 5. High Ce means this module changes whenever any dependency changes, so it should be the thing that is *allowed* to change (application layer, not domain).

Instability `I = Ce / (Ca + Ce)`. Domain code should be stable (`I` near 0): many things depend on it, it depends on nothing. Adapters and controllers should be unstable (`I` near 1): they depend on much, nothing depends on them. If your domain has high `Ce` (it imports TypeORM, NestJS, Stripe), the arrows are backwards.

#### Temporal coupling in practice

```ts
// Temporal coupling: works only if you call the methods in the right order
const report = new ReportBuilder();
report.setDateRange(from, to);   // forget this and generate() throws or returns everything
report.setCurrency('INR');       // forget this and amounts are unformatted
const csv = report.generate();

// Fix: make invalid states unrepresentable; require everything at construction
const csv = new ReportBuilder({ from, to, currency: 'INR' }).generate();
```

A more expensive example: a TypeORM `QueryRunner` that must be `connect()`ed, then `startTransaction()`ed, then used, then `commitTransaction()`ed or `rollbackTransaction()`ed, then `release()`d. Miss `release()` on one error path and the pool leaks a connection per error until the app stalls. The Unit of Work pattern (section 6.22) exists to wrap that temporal coupling in a single method that cannot be misused.

#### Measuring coupling in a NestJS codebase

`dependency-cruiser` produces the module graph and can report Ca/Ce per folder. A practical weekly check:

```bash
npx depcruise src --include-only "^src/modules" --output-type json > deps.json
echo "then count incoming/outgoing edges per module folder; alert when domain/ has outgoing edges to infrastructure/"
```

Configure a rule that forbids `src/modules/*/domain` from importing anything outside `domain/` and `shared-kernel/`, and a rule that forbids `src/modules/A/**` from importing `src/modules/B/{application,domain,infrastructure}/**`.

#### Where juniors misapply this

They reduce coupling by adding indirection everywhere (an interface, a factory and a token for each class), which increases the *number* of dependencies while claiming to reduce coupling. Coupling to a stable, well-designed abstraction is cheap. The goal is to couple to stable things and be decoupled from volatile things, not to minimise a number.

#### Interview questions

1. *Name three kinds of coupling from best to worst and give a code example of each.* Expected: data, control, content (or temporal).
2. *What are afferent and efferent coupling and how should they differ between domain and adapters?* Expected: domain high Ca low Ce; adapters low Ca high Ce.
3. *Give a real example of temporal coupling in a NestJS app and how you removed it.* Expected: `QueryRunner` lifecycle wrapped in a unit of work; builder requiring all inputs at construction.

## 6.10 Cohesion

#### Concept

Cohesion is how strongly the elements inside one module belong together. High cohesion: everything in `modules/inventory` is about stock, reservations and allocation. Low cohesion: a `utils` module with date formatting, a retry helper, a CSV parser and a Stripe webhook verifier.

Coupling is about relationships *between* modules; cohesion is about relationships *within* one. You want high cohesion and low coupling, and they reinforce each other: a highly cohesive module has a small, focused public interface, which makes it easy for others to depend on loosely.

#### Why does it exist?

Low cohesion means a module changes for unrelated reasons, its tests cover unrelated things, and its name stops meaning anything ("common", "shared", "core", "utils", "helpers", "misc"). Those names are a reliable sign of low cohesion. A change to date formatting re-runs the Stripe webhook tests because they share a module.

#### Mental model

Imagine a toolbox where each drawer holds one kind of tool: screwdrivers together, wrenches together. High cohesion. Now imagine a drawer labelled "stuff" with a screwdriver, a stapler, three batteries and a takeout menu. Every time you need anything you open "stuff" and dig. That drawer is your `utils` folder.

#### Levels of cohesion, from worst to best

| Level | Elements are grouped because... | Example | Verdict |
| --- | --- | --- | --- |
| Coincidental | no reason | `utils.ts` | Worst |
| Logical | they are the same *kind* of thing | `validators/` for every validator in the app | Weak |
| Temporal | they run at the same time | `startup.ts` doing DB connect, cache warm, feature flag fetch | Weak |
| Procedural | they follow one procedure | `checkoutSteps.ts` with unrelated helpers used by checkout | Moderate |
| Communicational | they operate on the same data | everything that touches `orders` rows | Good |
| Sequential | output of one is input to the next | pricing pipeline: base price then discounts then tax | Good |
| Functional | they all contribute to one well-defined task | `InventoryModule`: reserve, release, commit, expire reservations | Best |

#### NestJS example

Before: a "shared" module that is really a junk drawer.

```text
src/shared/
  utils/date.ts, money.ts, retry.ts, slugify.ts, csv.ts
  services/email.service.ts, sms.service.ts, stripe-webhook.service.ts, s3.service.ts
  guards/jwt.guard.ts, roles.guard.ts, order-owner.guard.ts
  interceptors/logging.interceptor.ts, cache.interceptor.ts
```

`OrderOwnerGuard` belongs to orders; `stripe-webhook.service.ts` belongs to payments; `email`/`sms` belong to notifications. `retry.ts` and `date.ts` are genuinely cross-cutting and can live in `libs/platform`.

After: cohesive modules and a small, honest platform library.

```text
src/modules/orders/presentation/guards/order-owner.guard.ts
src/modules/payments/presentation/webhooks/stripe-webhook.controller.ts
src/modules/notifications/infrastructure/channels/{email,sms}.channel.ts
libs/platform/src/{retry,clock,logging,http-client}/       <- cross-cutting, no business knowledge
libs/shared-kernel/src/{money,ids,domain-error}.ts          <- domain primitives, tiny
```

The test for whether something belongs in `platform`: *does it know anything about orders, users, payments, or any business concept?* If yes, it belongs in a business module.

#### Cohesion inside a class

The same idea applies to a single class. A class where every method uses every field is cohesive. A class where half the methods use fields A and B and the other half use C and D is two classes wearing one name. `OrdersService` with `createOrder()`, `cancelOrder()` (using the repository and the domain) and `exportOrdersCsv()`, `emailMonthlyReport()` (using a CSV writer and a mailer) is two classes: an order use-case group and a reporting job.

#### Where juniors misapply this

They confuse cohesion with size and split a cohesive 300-line inventory allocation algorithm into 12 files "for cohesion". Size is not the metric; *belonging together* is. A cohesive module can be large. A 20-line `utils.ts` is still incoherent.

#### Interview questions

1. *Define cohesion and its relation to coupling.* Expected: within-module belonging vs between-module dependency; high cohesion enables low coupling.
2. *What do folder names like `common`, `shared`, `utils` tell you?* Expected: likely coincidental cohesion; audit and redistribute.
3. *How do you decide whether something belongs in a platform library or a business module?* Expected: business knowledge test.

#### Practical exercise

Audit a `shared/` or `common/` folder in a NestJS project. For each file, classify its cohesion level and decide its correct home (a business module, `platform`, or `shared-kernel`). Move at least five files.

Acceptance criteria: the `shared/` folder is either gone or contains only files with no business knowledge; `dependency-cruiser` shows no business module importing another's internals; all tests pass.
