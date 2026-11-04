## 6.18 Observer pattern

#### Concept

Observer lets one object (the subject) notify many others (observers) when something happens, without knowing who they are. In backend code this appears as **domain events**: an order emits `OrderPaid`; inventory, notifications and analytics each have a handler; the order code does not import any of them.

Inside one NestJS process, `@nestjs/event-emitter` (built on the `eventemitter2` library) is the standard implementation. Across processes, the same idea becomes a message broker (Part 5.6).

#### Why does it exist?

It exists to decouple the cause from its effects. Every new reaction to "order paid" (a loyalty points award, a fraud check, a warehouse pick list) becomes a new handler instead of a new line in the checkout use case. It also lets side effects be turned on and off, tested in isolation, and moved out of the request path.

#### Mental model

Imagine a doorbell wired to several chimes: kitchen, garage, upstairs. Pressing the bell rings all of them. Add a chime in the garden by connecting it; the bell button does not change.

#### How it works with `@nestjs/event-emitter`

1. `EventEmitterModule.forRoot()` in `AppModule` registers a singleton `EventEmitter2`.
2. Providers with methods decorated `@OnEvent('order.paid')` are discovered at bootstrap and subscribed.
3. `emitter.emit('order.paid', payload)` calls every listener **synchronously, in registration order**, on the emitter's call stack. `emitAsync` awaits async listeners and returns their results as an array.
4. Options on `@OnEvent`: `{ async: true }` runs the listener via `setImmediate`, detached from the emitter's flow; `{ promisify: true }` makes `emitAsync` await it; wildcard patterns (`order.*`) require `wildcard: true` in `forRoot`.

```ts
// app.module.ts
EventEmitterModule.forRoot({ wildcard: true, maxListeners: 20, verboseMemoryLeak: true })

// contracts/events/order-paid.event.ts
export class OrderPaidEvent {
  static readonly name = 'order.paid';
  constructor(readonly payload: { id: string; orderId: string; paymentId: string; amountMinor: number; occurredAt: string }) {}
}

// modules/loyalty/application/on-order-paid.handler.ts
@Injectable()
export class AwardPointsOnOrderPaid {
  private readonly log = new Logger(AwardPointsOnOrderPaid.name);
  constructor(private readonly award: AwardPointsUseCase) {}

  @OnEvent(OrderPaidEvent.name, { async: true, promisify: true })
  async handle(event: OrderPaidEvent): Promise<void> {
    try {
      await this.award.execute({ orderId: event.payload.orderId, amountMinor: event.payload.amountMinor, eventId: event.payload.id });
    } catch (err) {
      // Listeners must never throw into the emitter; log with context and rely on reconciliation.
      this.log.error(`award points failed for order ${event.payload.orderId}: ${(err as Error).message}`);
    }
  }
}
```

#### Node `EventEmitter` pitfalls

`@nestjs/event-emitter` inherits the semantics of Node's `EventEmitter`, and those semantics surprise people in production.

1. **Listeners run synchronously by default.** `emit()` calls each listener on the current stack. A listener that does 200 ms of work adds 200 ms to the emitting request. A listener that throws synchronously throws *inside* `emit()`, into the emitter's code path, potentially after the emitter's database transaction has already committed. Use `{ async: true }` for anything with I/O.

2. **Unhandled errors in async listeners vanish.** An `async` listener that rejects produces an unhandled promise rejection: nothing in the emitter's flow sees it. In Node 15+, an unhandled rejection crashes the process by default (`--unhandled-rejections=throw`). Every listener needs a `try/catch` that logs and, ideally, records a failure for reconciliation.

3. **`error` event semantics.** On a plain Node `EventEmitter`, emitting `'error'` with no listener throws. Do not name a domain event `error`.

4. **Memory leaks from listeners added per request.** Code that calls `emitter.on(...)` inside a request handler adds a listener every request and never removes it. Node warns at 11 listeners (`MaxListenersExceededWarning`); with `verboseMemoryLeak: true` the warning includes the event name. Listeners belong on singleton providers registered once at boot, which `@OnEvent` guarantees.

5. **Ordering and partial failure.** With four listeners, if the second throws (sync) the third and fourth never run. With async listeners, all run but there is no transaction across them. An in-process event is a best-effort fan-out.

6. **No durability.** If the process dies after `emit()`, listeners that had not finished are gone. If you need durability, write an outbox row (Part 5.6) and let a relay publish to a broker; treat in-process events as a notification mechanism for recoverable work.

7. **Emitting inside a transaction.** If the use case emits before `COMMIT`, a listener may read the database and not see the change, or the transaction may roll back after the listener already acted. Emit after commit, or collect events on the aggregate and dispatch them from the unit of work after commit (section 6.22).

#### Practical example

An order use case emits after its transaction commits:

```ts
@Injectable()
export class MarkOrderPaidUseCase {
  constructor(private readonly uow: UnitOfWork, @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository, private readonly emitter: EventEmitter2) {}

  async execute(orderId: string, paymentId: string): Promise<void> {
    const event = await this.uow.run(async () => {
      const order = await this.orders.findById(orderId);
      if (!order) throw new DomainError('ORDER_NOT_FOUND', orderId);
      if (order.status === 'PAID') return null; // idempotent
      order.markPaid(paymentId);
      await this.orders.save(order);
      return new OrderPaidEvent({ id: randomUUID(), orderId, paymentId, amountMinor: order.total.minor, occurredAt: new Date().toISOString() });
    });
    if (event) await this.emitter.emitAsync(OrderPaidEvent.name, event); // AFTER commit
  }
}
```

#### Failure scenario

A team adds a `@OnEvent('order.paid')` listener without `async: true` that calls the loyalty provider's HTTP API. The provider's p99 climbs to 4 seconds during an incident. Now checkout's p99 is 4 seconds too, because the listener runs on the checkout request's stack. Then the provider starts returning 500s; the listener throws synchronously inside `emit()`, which is called after the commit, so checkout returns 500 to the customer *after* charging the card and saving the order. Support handles 300 tickets of "I was charged but got an error". Two flags (`async: true` and a `try/catch`) would have prevented all of it.

#### Edge cases & failure modes

- Listener throws synchronously and aborts remaining listeners.
- Async listener rejects with no catch; process crash on unhandled rejection.
- Listeners registered per request leak memory.
- Emit before commit; listener sees stale data or acts on rolled-back state.
- Lost events on process crash; use the outbox for anything that must happen.
- A listener that re-emits the same event type (loops); include causation ids.
- Test suites that forget `EventEmitterModule` and silently have zero listeners.

#### When NOT to use it

- When the "observer" must succeed for the operation to be correct (reserve stock before confirming). That is a command with a return value, not an event.
- When ordering across handlers matters. Observers are independent by design.
- Across processes. Use a broker.

#### Common mistakes

- Using events to avoid a direct call that should be direct (the caller needs the result).
- Listeners with business-critical side effects and no reconciliation.
- Naming events as commands (`SendEmailEvent`).
- Emitting from inside repositories or entities directly (they should *record* events; the use case or unit of work dispatches them).

#### Interview questions

1. *What happens if a synchronous `@OnEvent` listener throws?* Expected: it throws inside `emit()`, in the emitter's flow, and skips later listeners.
2. *How do you keep listeners from slowing the request?* Expected: `async: true`; move I/O-heavy reactions to a queue or broker.
3. *Why emit after commit?* Expected: listeners may read uncommitted data or act on a rolled-back change.
4. *When is `EventEmitter2` the wrong tool?* Expected: durability, cross-process, ordering guarantees, required outcomes.
5. *How does a listener leak memory?* Expected: `on()` in request scope; `MaxListenersExceededWarning`.

#### Practical exercise

Add three `@OnEvent('order.paid')` listeners (loyalty, email, analytics) to a checkout flow. Make the email listener slow (2 s) and the analytics listener throw. Observe checkout latency and error behaviour. Then fix with `async: true`, `try/catch` with structured logging, and an outbox row for loyalty points (which must not be lost).

Acceptance criteria: checkout p99 is unaffected by the slow listener; the throwing listener never surfaces as a checkout error; killing the process mid-event does not lose loyalty points (the outbox relay replays them).

## 6.19 Command pattern

#### Concept

A command is an object that represents a request to do something: `PlaceOrderCommand { orderId, customerId, lines }`. A command handler executes it. Separating "the request" from "the execution" lets you validate, log, queue, retry, authorise and audit commands uniformly, and it makes each business operation a named, first-class thing.

In NestJS, `@nestjs/cqrs` provides `CommandBus`, `@CommandHandler`, `QueryBus`, `@QueryHandler`, `EventBus` and sagas. Commands mutate; queries read; the two are handled by different classes (CQRS: Command Query Responsibility Segregation).

#### Why does it exist?

Without it, an operation is a method call whose intent is scattered across parameters. With it, the operation is data: it can be serialised into a queue, replayed, inspected in logs, and given an idempotency key. Handlers become small, focused classes with one `execute` method, which lines up naturally with use cases.

#### Mental model

Imagine a restaurant order ticket. The waiter writes the order (the command) on a ticket and puts it on the rail. The kitchen (handler) takes tickets in order. The ticket can be checked, prioritised, or voided without talking to the waiter. Compare with the waiter shouting the order at the chef and hoping.

#### How it works with `@nestjs/cqrs`

1. `CqrsModule` in the module's imports registers the buses.
2. A command is a plain class (often `readonly` fields). A handler class decorated `@CommandHandler(PlaceOrderCommand)` implements `ICommandHandler<PlaceOrderCommand, Result>`.
3. `commandBus.execute(new PlaceOrderCommand(...))` finds the handler by the command's class and calls `execute`. Exactly one handler per command; two is a boot error.
4. Handlers can publish events on `EventBus`; `@EventsHandler` classes react; sagas (`@Saga`) turn event streams into new commands with RxJS.

```ts
// application/commands/place-order.command.ts
export class PlaceOrderCommand {
  constructor(
    readonly orderId: string,            // client-generated or idempotency-derived
    readonly customerId: string,
    readonly lines: { productId: string; qty: number }[],
    readonly idempotencyKey: string,
  ) {}
}

// application/commands/place-order.handler.ts
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, { orderId: string }> {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly inventory: InventoryFacade,
    private readonly idempotency: IdempotencyStore,
    private readonly eventBus: EventBus,
  ) {}

  async execute(cmd: PlaceOrderCommand): Promise<{ orderId: string }> {
    // Idempotent command: same key returns the stored result without redoing side effects.
    const previous = await this.idempotency.find<{ orderId: string }>(cmd.idempotencyKey);
    if (previous) return previous;

    const reservation = await this.inventory.reserve({ orderId: cmd.orderId, lines: cmd.lines });
    const order = Order.create(cmd.orderId, cmd.customerId, toLines(cmd.lines), new Date());
    await this.orders.save(order);
    const result = { orderId: order.id };
    await this.idempotency.store(cmd.idempotencyKey, result, { ttlSeconds: 24 * 3600 });
    this.eventBus.publish(new OrderPlacedEvent(order.id, reservation.reservationId));
    return result;
  }
}

// presentation/orders.controller.ts
@Post()
async create(@Body() dto: CreateOrderDto, @Headers('idempotency-key') key: string) {
  if (!key) throw new BadRequestException('Idempotency-Key header required');
  return this.commandBus.execute(new PlaceOrderCommand(deriveOrderId(key), dto.customerId, dto.lines, key));
}
```

#### Idempotent commands

Commands arrive more than once: client retries after a timeout, load balancer retries, a queue redelivers. An idempotent command produces the same effect and the same result no matter how many times it is executed. Techniques:

- **Idempotency key store.** Persist `(key) -> result` in PostgreSQL or Redis with a TTL. Check before executing; store after. Race: two concurrent requests with the same key both miss the check. Fix with `INSERT ... ON CONFLICT DO NOTHING` on the key *before* doing work, and have the loser wait or return 409.
- **Natural idempotency.** Use the command's identity as the aggregate's identity (`orderId` derived from the key) so a second insert conflicts on the primary key.
- **Conditional updates.** `UPDATE orders SET status='PAID' WHERE id=$1 AND status='CREATED'`; zero rows affected means already done.

```sql
CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  scope        text NOT NULL,             -- e.g. 'place-order'
  result       jsonb,
  status       text NOT NULL DEFAULT 'IN_PROGRESS',
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Claim the key first; the second concurrent request gets 0 rows and must wait or 409.
INSERT INTO idempotency_keys (key, scope) VALUES ($1, 'place-order') ON CONFLICT DO NOTHING;
```

#### Commands vs use cases vs events

| Thing | Shape | Handlers | Can fail? | Direction |
| --- | --- | --- | --- | --- |
| Command | Imperative object (`PlaceOrder`) | Exactly one | Yes, returns a result or error | Caller to handler |
| Use case | Class with `execute()` | It *is* the handler | Yes | Same as command handler |
| Event | Past-tense fact (`OrderPlaced`) | Zero or many | No; it happened | Handler to the world |
| Query | Read request (`GetOrderById`) | Exactly one | Yes | Caller to read side |

A use case without `@nestjs/cqrs` and a command handler with it are the same idea. The bus adds: uniform middleware (logging, validation, authorisation across all commands), decoupling of the caller from the handler class, and a place to plug in a queue later. It costs indirection and a bus that hides the call graph from IDE navigation.

#### When NOT to use it

- Small modules where `useCase.execute()` is already clear; the bus adds nothing.
- When you need the handler's *type* for compile-time safety; `commandBus.execute` is loosely typed unless you wrap it.
- As a substitute for a message queue. `CommandBus` is in-process and synchronous; it is not durable or distributed.
- Full CQRS with separate read models and eventual consistency for a CRUD app. The "S" in CQRS is a big architectural step; the command pattern alone is not.

#### Common mistakes

- Commands that carry entities or ORM models instead of plain data.
- Handlers that call other handlers through the bus in chains, building an invisible call graph.
- Non-idempotent handlers behind retrying callers.
- Sagas that issue commands without correlation ids, so failures cannot be traced.
- Using `EventBus` from `@nestjs/cqrs` as a durable event system (it has the same in-memory semantics as `EventEmitter2`).

#### Interview questions

1. *What does the command pattern give you over a direct method call?* Expected: request as data; uniform middleware; queueability; audit; idempotency handling in one place.
2. *How do you make a command idempotent under concurrent duplicate requests?* Expected: claim the key with an insert-on-conflict before work; conditional updates; aggregate id derived from the key.
3. *Command vs event: differences in handlers, failure and naming.* Expected: one vs many; can fail vs cannot; imperative vs past tense.
4. *What does CQRS add beyond the command pattern, and when is it justified?* Expected: separate read models; justified by very different read and write shapes or scale; not for CRUD.

#### Practical exercise

Implement `PlaceOrderCommand` with `@nestjs/cqrs`, an `IdempotencyStore` backed by PostgreSQL using `INSERT ... ON CONFLICT DO NOTHING` to claim keys, and a controller requiring an `Idempotency-Key` header. Fire 50 concurrent identical requests.

Acceptance criteria: exactly one order row and one inventory reservation exist; 49 requests return the same `orderId` (or 409 while in progress, then the same result on retry); the handler's unit tests cover "key already stored" and "key claimed by another in-flight request".
