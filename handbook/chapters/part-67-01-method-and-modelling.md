# Part 67 — Low-Level Design and Machine Coding

The low-level design (LLD), or machine-coding, interview round is different from the system-design round (Parts 54 and 65, 66). There you draw boxes, estimate capacity and reason about distributed systems; here you write actual, working, well-structured code for a single self-contained problem — a parking lot, an elevator, a rate limiter — usually in 60 to 90 minutes, and the interviewer judges the quality of your object modelling, your use of design patterns with reason, your extensibility, your naming, and whether it runs and is tested. It is the round where SOLID principles (Part 13) and design patterns stop being theory and become the thing you are scored on.

This Part teaches the LLD round: what it is and how it is scored, a repeatable method for solving any LLD problem, how to model objects well in TypeScript, how to think about concurrency in a Node context, and then eight fully worked problems — parking lot, Splitwise, elevator, movie ticket booking, rate limiter library, food-order state machine, in-memory key-value store with TTL and transactions, and logger/pub-sub — each with requirements, a class diagram, TypeScript code, tests, and the "interviewer twist" (the extension the interviewer springs on you to test whether your design is actually extensible). It builds directly on SOLID and design patterns (Part 13) and the algorithms of Parts 8, 9.

Every worked problem follows the same shape: requirements, class diagram, the core code, Jest tests, the twist described, then the twist *implemented* with its own tests, and finally the edge cases, the production mapping (what the in-memory design becomes in a real NestJS service with PostgreSQL or Redis) and the follow-up questions interviewers ask. All code is TypeScript in strict mode and every test is a real Jest test; the snippets were compiled and run as written.

## 67.1 What the LLD round is and how to approach it

### 67.1.1 What it is and how it is scored

#### Concept

The LLD/machine-coding round asks you to design and implement the classes and logic for a bounded problem — not a distributed system, but the object model and behavior of one component — producing code that compiles, runs, is reasonably tested, and could plausibly be the start of a real implementation. You are judged on how you decompose the problem into classes with clear responsibilities, how cleanly they interact, whether you apply patterns where they genuinely help (and can justify why), how easy your design is to extend, and the basic craft of naming, structure and tests.

#### Why does it exist?

System design tests whether you can architect; coding (algorithms, Parts 8, 9) tests problem-solving; the LLD round tests the daily craft in between — can you take a fuzzy requirement and turn it into clean, extensible, correct object-oriented code under time pressure, the way you would when building a real feature. It reveals whether you actually apply SOLID and patterns in practice (not just define them), whether you write testable code, and whether your design survives a new requirement without a rewrite. It exists because this is most of what senior engineers actually do, and it is hard to fake.

#### Mental model

Imagine a carpentry trade test. Nobody asks you to design a city; they hand you timber and a drawing of a cabinet and watch you work for ninety minutes. They are not only checking that the cabinet stands up at the end. They watch whether you measure before you cut, whether the joints are clean, whether the doors are hung so they can be swapped later, and whether you test the hinges before you call it done. Then, just as you finish, the examiner says "the customer now wants a drawer here" — and watches whether you add a drawer or start again. The LLD round is that test for code: the cabinet is the working program, the joints are your interfaces, and the drawer is the twist.

#### How it is scored

| Dimension | What the interviewer looks for |
|---|---|
| Working code | It compiles and runs; the core scenario works |
| Decomposition | Classes with single, clear responsibilities (SRP, Part 13) |
| Extensibility | New requirements fit without rewriting (OCP; the "twist" tests this) |
| Patterns with reason | Patterns used where they help, and you can justify each (not pattern soup) |
| Naming and clarity | Names reveal intent; code is readable |
| Tests | Key behavior is tested; you think about edge cases |
| Communication | You narrate your decisions and tradeoffs as you go |

The two failure modes at the extremes: writing one giant procedural blob that "works" but is unstructured and unextensible (fails decomposition and the twist), and over-engineering with a dozen patterns and layers for a small problem (fails "patterns with reason" — pattern soup). The target is the middle: clean, well-named classes with the patterns the problem actually needs, tested, and ready to extend.

Many companies write the rubric down as points. A typical one, reconstructed from several real loops, looks like this; the exact weights vary, but the shape is stable:

| Signal | Weight | "Strong hire" looks like | "No hire" looks like |
|---|---|---|---|
| Requirements | 10% | Asks 3 to 5 sharp questions, writes the agreed scope down | Starts typing in minute two |
| Model and interfaces | 25% | Entities with one job each; interfaces exactly at the variation points | One `Manager` class, or an interface for every class |
| Working core | 25% | Happy path runs, with a demo or test | Code that has never been executed |
| Twist | 20% | Absorbed by adding a class or a config value | Rewrites the core under pressure |
| Tests | 10% | 4 to 8 focused tests including edge cases | No tests, or one that prints output |
| Communication | 10% | Narrates tradeoffs, invites correction | Silent for twenty minutes |

#### How it works — a 90-minute round, minute by minute

| Minutes | What you do | What you say out loud |
|---|---|---|
| 0–8 | Clarify, write requirements as a comment block | "Let me confirm scope before I design anything." |
| 8–18 | Entities, relationships, a quick class sketch | "These are the nouns; this one is the policy that will change." |
| 18–25 | Interfaces and the one or two patterns | "Pricing is a strategy, because that is the likely change." |
| 25–60 | Core code, run it early and often | "I will get the happy path running, then harden it." |
| 60–75 | The twist | "That lands on the strategy, so it is one new class." |
| 75–88 | Tests and edge cases | "Double unpark, no spot, zero duration." |
| 88–90 | Summary and production notes | "In production this map becomes a table with a conditional update." |

In a 60-minute round you compress the same shape: 5 minutes of requirements, 10 of design, 30 of code, 10 of twist and tests, 5 of wrap-up. Never skip the first and last rows; they are the cheapest points in the rubric.

#### Practical example

The opening five minutes for "design a parking lot", strong versus weak:

```text
Weak:  "OK, so I'll make a ParkingLot class..." (types for 25 minutes in silence)

Strong: "Before I design, a few questions.
         1. How many spot sizes, and can a small vehicle use a bigger spot?
         2. How is the fee computed: hourly, flat, by size?
         3. One entrance or several? Do I need concurrency across gates?
         4. Is payment in scope, or can I stub it?
         5. Do we need reservations or EV charging spots?
        Writing down: 3 sizes, smallest-fit, hourly by size, payment stubbed,
        reservations out of scope for now. I expect pricing and allocation
        to change, so I will put those behind interfaces."
```

The strong answer has not written a line of code, but it has already earned the requirements points, shown it knows where variation lives, and set up the twist.

#### Failure scenario

A candidate with eight years of experience was asked for the movie-booking problem. They produced 300 lines in 55 minutes: one `BookingSystem` class with a `Map` of everything, a 90-line `book()` method that checked seats, computed prices, applied coupons and printed a receipt. It worked for the happy path. Then the interviewer asked, "What if two users hold the same seat, and holds must expire after five minutes?" The hold logic was spread across four places in `book()`; adding expiry meant touching every one, and the candidate ran out of time with the code broken. The feedback was "strong coder, could not extend their own design" — a no-hire at senior level. The same person, with a `Seat` class owning its own state and a `tryHold` method, would have absorbed that twist in ten lines.

#### How a Senior Backend Engineer thinks about this

A senior treats the LLD round as a small version of real work and applies the same instincts: clarify the requirements first, model the core entities, define clean interfaces, pick patterns only where they earn their place, write the core logic, test it, and leave clear extension points. They narrate throughout — "I'm making this a strategy because the interviewer will likely want a different policy later" — because communication is scored and because it invites course-correction. They deliberately avoid both extremes (the procedural blob and the pattern soup), aiming for code a teammate could read and extend. They treat the interviewer's "twist" as the real test of their design: a good design absorbs the twist with a small, localized change; a bad one needs a rewrite.

#### Common mistakes

- A giant procedural function that works but has no structure or extension points.
- Pattern soup: applying many patterns to a small problem to look sophisticated.
- No tests, or not thinking about edge cases.
- Not clarifying requirements, then solving the wrong problem.
- Silence — not narrating decisions, so the interviewer cannot follow the reasoning.
- Never running the code. A program that has never executed has an unknown number of bugs; run it by minute 40 at the latest.
- Spending 30 minutes on a perfect class diagram and leaving no time to code.

#### Interview questions

1. **What is the LLD/machine-coding round testing?** The craft of turning a fuzzy requirement into clean, extensible, correct object-oriented code — decomposition, patterns-with-reason, naming, tests — the daily work of building features.
2. **What are the two extremes to avoid?** A structureless procedural blob (unextensible) and over-engineered pattern soup (needless complexity); aim for clean classes with the patterns the problem actually needs.
3. **Why does the interviewer spring a "twist"?** To test whether your design is genuinely extensible — a good design absorbs a new requirement with a small localized change; a poor one needs a rewrite.
4. **You are 50 minutes in and the core does not work yet. What do you do?** Say so, cut scope out loud ("I will drop the availability report and make parking and pricing work"), get one path running, and describe the rest. A running subset with a clear plan scores far better than a complete design that never ran.
5. **How do you choose what to test in ten minutes?** The invariant first (no double booking, balances sum to zero), then one test per business rule, then the nastiest edge case (expiry boundary, empty input). Inject the clock so time-based tests need no waiting.

#### Practical exercise

Take a small LLD prompt (a vending machine) and, without coding, list the core entities, their responsibilities, the one or two patterns you would use and why, and one likely interviewer twist and how your design would absorb it. Acceptance criteria: each class has a single clear responsibility, each pattern is justified, and the twist fits without a rewrite. Then set a timer for 60 minutes and run the timeline table above against the same prompt; note where you overran.

### 67.1.2 A repeatable method and object modelling in TypeScript

#### Concept

A repeatable method turns any LLD problem into a structured solution under time pressure: clarify requirements, identify entities, define interfaces, pick patterns, code the core, extend for the twist, test. Alongside it, good object modelling in TypeScript — classes versus interfaces, composition over inheritance, enums versus union types, immutability, and clear error types — is the raw material you shape with that method.

#### Why does it exist?

Under interview pressure, unstructured thinking produces unstructured code. A fixed sequence of steps means you never forget the cheap points (requirements, tests), and the modelling habits mean that the code you write in the "core" step already has the joints in the right places. Without a method, most candidates start with whichever class comes to mind first and discover the real shape of the problem at minute 50.

#### How it works — the method

```text
The LLD method, in order (narrate each step aloud):
  1. Clarify requirements  -> ask about scope, edge cases, what is in/out; write them down
  2. Identify entities     -> the nouns become classes (ParkingLot, Spot, Vehicle, Ticket)
  3. Define interfaces      -> the behaviors, especially where variation is likely (pricing, allocation)
  4. Pick patterns          -> only where variation/extension is expected; justify each
  5. Code the core          -> the main happy-path scenario working, cleanly
  6. Extend for the twist   -> the interviewer's new requirement; show it fits
  7. Test                   -> key behaviors and edge cases
```

Each step maps to a scoring dimension. Clarifying stops you solving the wrong problem. Identifying entities is decomposition. Defining interfaces where variation is likely sets up extensibility (and the patterns). Picking patterns with justification is "patterns with reason". Coding the core proves it works. Extending for the twist proves extensibility. Testing proves correctness. Narrate each step so the interviewer follows your reasoning.

A useful trick for step 2 and 3: underline the nouns in the prompt (they become classes or value objects), circle the verbs (they become methods), and mark every phrase with "different", "configurable", "depending on", "for now" or "later" — those phrases are where the twist will land, so they become interfaces.

#### How it works — object modelling in TypeScript

The TypeScript modelling choices that make LLD code clean:

- **Classes vs interfaces**: use an `interface` to define a contract (a `PricingStrategy`, a `Repository`) and `class` for things with state and behavior (a `ParkingLot`). Program to interfaces where variation is expected (Part 13, dependency inversion), so you can swap implementations.
- **Composition over inheritance**: prefer composing behaviors (a `ParkingLot` *has* a `PricingStrategy`) over deep inheritance hierarchies, which are rigid and the classic LLD mistake. Inheritance for genuine "is-a"; composition for "has-a" and for pluggable behavior.
- **Enums vs union types**: for a small fixed set of values, a TypeScript union of string literals (`type Size = 'small' | 'medium' | 'large'`) is often cleaner than an enum and gives exhaustiveness checking (Part 1); use whichever the team prefers consistently.
- **Immutability**: make value objects immutable (`readonly` fields) where it prevents bugs — a `Money` or a `Ticket`'s core fields should not mutate unexpectedly.
- **Error types**: define clear, specific error classes (`SpotUnavailableError`, `InvalidTransitionError`) rather than throwing generic `Error`, so callers can handle them and the code communicates what can go wrong.
- **Injected time**: never read `Date.now()` deep inside domain logic. Pass `now` as a parameter or inject a `Clock`, so expiry, pricing and rate limits can be tested in microseconds without real waiting.
- **Discriminated unions for outcomes**: when an operation has several legitimate results (paid, declined, timed out), a union with a `kind` field plus an exhaustive `switch` is clearer than a boolean and an exception.

```ts
// Modelling building blocks for LLD in TypeScript.
type VehicleSize = 'motorcycle' | 'car' | 'truck';   // union, exhaustiveness-checkable

interface PricingStrategy {                            // interface for a varying behavior
  price(durationMinutes: number, size: VehicleSize): number;
}

class SpotUnavailableError extends Error {}            // specific error type

class Money {                                           // immutable value object
  constructor(public readonly cents: number) {
    if (cents < 0) throw new Error('money cannot be negative');
  }
  add(other: Money): Money { return new Money(this.cents + other.cents); }  // returns new, not mutated
}
```

#### Practical example

The same habits applied to a coupon in an e-commerce checkout: the clock is injected, the error carries data, and payment outcomes are a discriminated union whose `switch` the compiler checks for completeness.

```ts
export interface Clock { now(): number; }
export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  constructor(private current = 0) {}
  now() { return this.current; }
  advance(ms: number) { this.current += ms; }
}

export class CouponExpiredError extends Error {
  constructor(readonly code: string, readonly expiredAt: number) {
    super(`coupon ${code} expired at ${new Date(expiredAt).toISOString()}`);
    this.name = 'CouponExpiredError';
  }
}

export class Coupon {
  constructor(readonly code: string, readonly expiresAt: number, private readonly clock: Clock = systemClock) {}
  assertUsable(): void {
    if (this.clock.now() >= this.expiresAt) throw new CouponExpiredError(this.code, this.expiresAt);
  }
}

export type PaymentResult =
  | { kind: 'paid'; receiptId: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'timed_out' };

// Adding a new kind is a compile error here until it is handled.
export function describePayment(r: PaymentResult): string {
  switch (r.kind) {
    case 'paid': return `paid (${r.receiptId})`;
    case 'declined': return `declined: ${r.reason}`;
    case 'timed_out': return 'timed out, safe to retry with the same idempotency key';
    default: {
      const unreachable: never = r;
      throw new Error(`unhandled payment result ${JSON.stringify(unreachable)}`);
    }
  }
}
```

```ts
import { Coupon, CouponExpiredError, FakeClock, describePayment } from './coupon';

it('coupon expires exactly at its deadline, with no real waiting', () => {
  const clock = new FakeClock(1_000);
  const coupon = new Coupon('WELCOME10', 5_000, clock);
  expect(() => coupon.assertUsable()).not.toThrow();
  clock.advance(4_000);                                   // now === expiresAt
  expect(() => coupon.assertUsable()).toThrow(CouponExpiredError);
});

it('describes every payment outcome', () => {
  expect(describePayment({ kind: 'declined', reason: 'insufficient funds' })).toBe('declined: insufficient funds');
});
```

Notice the boundary test: "expires at" means the coupon is dead at exactly `expiresAt`, and the test pins that down. Off-by-one at time boundaries is the most common bug in LLD answers with expiry, and it is a one-line test once the clock is injected.

#### How a Senior Backend Engineer thinks about this

A senior runs the method explicitly and narrates it, because the structure both produces better code and shows the interviewer a clear thought process. They model with composition over inheritance by default (deep inheritance is the most common LLD design smell), program to interfaces exactly where the problem will vary (which is where the interviewer's twist will land), and use immutability and specific error types to make the code robust and self-documenting. They resist over-abstraction: an interface or pattern is introduced only where variation is genuinely expected, not speculatively. The method and these modelling habits together let them produce clean, extensible code quickly and absorb the twist gracefully, which is exactly what the round rewards.

#### Common mistakes

- Skipping requirement clarification and solving the wrong problem.
- Deep inheritance hierarchies instead of composition (rigid, hard to extend).
- Concrete dependencies everywhere instead of interfaces where variation is expected (hard to extend/test).
- Generic `Error` throwing instead of specific error types.
- Mutable value objects causing spooky bugs.
- Abstracting speculatively (interfaces/patterns where no variation is expected).
- Floating-point money. `0.1 + 0.2 !== 0.3`; store integer minor units (cents, paise) everywhere and format only at the edge.

#### Interview questions

1. **What is a repeatable method for an LLD problem?** Clarify requirements, identify entities (classes), define interfaces where variation is likely, pick patterns with justification, code the core, extend for the twist, test — narrating each step.
2. **Why prefer composition over inheritance in LLD?** Composition (has-a, pluggable behavior) is flexible and extensible; deep inheritance is rigid and the classic LLD smell. Use inheritance only for genuine is-a relationships.
3. **Where should you introduce interfaces and patterns?** Exactly where the problem is expected to vary (pricing, allocation, strategy) — which is where the interviewer's twist lands — not speculatively everywhere.
4. **Why use specific error types over generic `Error`?** They let callers handle specific failures and document what can go wrong, making the code more robust and readable.
5. **Exceptions or result types for expected failures?** Use exceptions for "this should not happen here" (invalid transition, unknown ticket) and a discriminated union when the caller must branch on the outcome every time (payment declined versus timed out). Follow-up: in NestJS, domain errors are usually mapped to HTTP status codes in an exception filter, so the domain stays free of HTTP.
6. **How do you make time-dependent code testable?** Inject a clock or pass `now` explicitly; tests then move time forward instantly and can hit exact boundaries.

#### Practical exercise

For the parking-lot problem, run the method's first four steps on paper: clarify three requirements, list the entities as classes with one-line responsibilities, identify the one or two behaviors that should be interfaces (because they will vary), and name the pattern you would use for each with a justification. Acceptance criteria: entities have single responsibilities, the varying behaviors are interfaces, and each pattern choice is justified by expected variation. Then model a `Money` value object with a currency, an `add` that refuses mixed currencies with a specific error, and three Jest tests.
