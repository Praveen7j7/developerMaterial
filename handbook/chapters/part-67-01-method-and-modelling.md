# Part 67 — Low-Level Design and Machine Coding

The low-level design (LLD), or machine-coding, interview round is different from the system-design round (Parts 40, 65, 66). There you draw boxes, estimate capacity and reason about distributed systems; here you write actual, working, well-structured code for a single self-contained problem — a parking lot, an elevator, a rate limiter — usually in 60 to 90 minutes, and the interviewer judges the quality of your object modelling, your use of design patterns with reason, your extensibility, your naming, and whether it runs and is tested. It is the round where SOLID principles (Part 6) and design patterns stop being theory and become the thing you are scored on.

This Part teaches the LLD round: what it is and how it is scored, a repeatable method for solving any LLD problem, how to model objects well in TypeScript, how to think about concurrency in a Node context, and then eight fully worked problems — parking lot, Splitwise, elevator, movie ticket booking, rate limiter library, food-order state machine, in-memory key-value store with TTL and transactions, and logger/pub-sub — each with requirements, a class diagram, TypeScript code, tests, and the "interviewer twist" (the extension the interviewer springs on you to test whether your design is actually extensible). It builds directly on SOLID and design patterns (Part 6) and the algorithms of Parts 1 and 2.

## 67.1 What the LLD round is and how to approach it

### 67.1.1 What it is and how it is scored

#### Concept

The LLD/machine-coding round asks you to design and implement the classes and logic for a bounded problem — not a distributed system, but the object model and behavior of one component — producing code that compiles, runs, is reasonably tested, and could plausibly be the start of a real implementation. You are judged on how you decompose the problem into classes with clear responsibilities, how cleanly they interact, whether you apply patterns where they genuinely help (and can justify why), how easy your design is to extend, and the basic craft of naming, structure and tests.

#### Why does it exist?

System design tests whether you can architect; coding (algorithms, Parts 1-2) tests problem-solving; the LLD round tests the daily craft in between — can you take a fuzzy requirement and turn it into clean, extensible, correct object-oriented code under time pressure, the way you would when building a real feature. It reveals whether you actually apply SOLID and patterns in practice (not just define them), whether you write testable code, and whether your design survives a new requirement without a rewrite. It exists because this is most of what senior engineers actually do, and it is hard to fake.

#### How it is scored

| Dimension | What the interviewer looks for |
|---|---|
| Working code | It compiles and runs; the core scenario works |
| Decomposition | Classes with single, clear responsibilities (SRP, Part 6) |
| Extensibility | New requirements fit without rewriting (OCP; the "twist" tests this) |
| Patterns with reason | Patterns used where they help, and you can justify each (not pattern soup) |
| Naming and clarity | Names reveal intent; code is readable |
| Tests | Key behavior is tested; you think about edge cases |
| Communication | You narrate your decisions and tradeoffs as you go |

The two failure modes at the extremes: writing one giant procedural blob that "works" but is unstructured and unextensible (fails decomposition and the twist), and over-engineering with a dozen patterns and layers for a small problem (fails "patterns with reason" — pattern soup). The target is the middle: clean, well-named classes with the patterns the problem actually needs, tested, and ready to extend.

#### How a Senior Backend Engineer thinks about this

A senior treats the LLD round as a small version of real work and applies the same instincts: clarify the requirements first, model the core entities, define clean interfaces, pick patterns only where they earn their place, write the core logic, test it, and leave clear extension points. They narrate throughout — "I'm making this a strategy because the interviewer will likely want a different policy later" — because communication is scored and because it invites course-correction. They deliberately avoid both extremes (the procedural blob and the pattern soup), aiming for code a teammate could read and extend. They treat the interviewer's "twist" as the real test of their design: a good design absorbs the twist with a small, localized change; a bad one needs a rewrite.

#### Common mistakes

- A giant procedural function that works but has no structure or extension points.
- Pattern soup: applying many patterns to a small problem to look sophisticated.
- No tests, or not thinking about edge cases.
- Not clarifying requirements, then solving the wrong problem.
- Silence — not narrating decisions, so the interviewer cannot follow the reasoning.

#### Interview questions

1. **What is the LLD/machine-coding round testing?** The craft of turning a fuzzy requirement into clean, extensible, correct object-oriented code — decomposition, patterns-with-reason, naming, tests — the daily work of building features.
2. **What are the two extremes to avoid?** A structureless procedural blob (unextensible) and over-engineered pattern soup (needless complexity); aim for clean classes with the patterns the problem actually needs.
3. **Why does the interviewer spring a "twist"?** To test whether your design is genuinely extensible — a good design absorbs a new requirement with a small localized change; a poor one needs a rewrite.

#### Practical exercise

Take a small LLD prompt (a vending machine) and, without coding, list the core entities, their responsibilities, the one or two patterns you would use and why, and one likely interviewer twist and how your design would absorb it. Acceptance criteria: each class has a single clear responsibility, each pattern is justified, and the twist fits without a rewrite.

### 67.1.2 A repeatable method and object modelling in TypeScript

#### Concept

A repeatable method turns any LLD problem into a structured solution under time pressure: clarify requirements, identify entities, define interfaces, pick patterns, code the core, extend for the twist, test. Alongside it, good object modelling in TypeScript — classes versus interfaces, composition over inheritance, enums versus union types, immutability, and clear error types — is the raw material you shape with that method.

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

#### How it works — object modelling in TypeScript

The TypeScript modelling choices that make LLD code clean:

- **Classes vs interfaces**: use an `interface` to define a contract (a `PricingStrategy`, a `Repository`) and `class` for things with state and behavior (a `ParkingLot`). Program to interfaces where variation is expected (Part 6, dependency inversion), so you can swap implementations.
- **Composition over inheritance**: prefer composing behaviors (a `ParkingLot` *has* a `PricingStrategy`) over deep inheritance hierarchies, which are rigid and the classic LLD mistake. Inheritance for genuine "is-a"; composition for "has-a" and for pluggable behavior.
- **Enums vs union types**: for a small fixed set of values, a TypeScript union of string literals (`type Size = 'small' | 'medium' | 'large'`) is often cleaner than an enum and gives exhaustiveness checking (Part 69); use whichever the team prefers consistently.
- **Immutability**: make value objects immutable (`readonly` fields) where it prevents bugs — a `Money` or a `Ticket`'s core fields should not mutate unexpectedly.
- **Error types**: define clear, specific error classes (`SpotUnavailableError`, `InvalidTransitionError`) rather than throwing generic `Error`, so callers can handle them and the code communicates what can go wrong.

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

#### How a Senior Backend Engineer thinks about this

A senior runs the method explicitly and narrates it, because the structure both produces better code and shows the interviewer a clear thought process. They model with composition over inheritance by default (deep inheritance is the most common LLD design smell), program to interfaces exactly where the problem will vary (which is where the interviewer's twist will land), and use immutability and specific error types to make the code robust and self-documenting. They resist over-abstraction: an interface or pattern is introduced only where variation is genuinely expected, not speculatively. The method and these modelling habits together let them produce clean, extensible code quickly and absorb the twist gracefully, which is exactly what the round rewards.

#### Common mistakes

- Skipping requirement clarification and solving the wrong problem.
- Deep inheritance hierarchies instead of composition (rigid, hard to extend).
- Concrete dependencies everywhere instead of interfaces where variation is expected (hard to extend/test).
- Generic `Error` throwing instead of specific error types.
- Mutable value objects causing spooky bugs.
- Abstracting speculatively (interfaces/patterns where no variation is expected).

#### Interview questions

1. **What is a repeatable method for an LLD problem?** Clarify requirements, identify entities (classes), define interfaces where variation is likely, pick patterns with justification, code the core, extend for the twist, test — narrating each step.
2. **Why prefer composition over inheritance in LLD?** Composition (has-a, pluggable behavior) is flexible and extensible; deep inheritance is rigid and the classic LLD smell. Use inheritance only for genuine is-a relationships.
3. **Where should you introduce interfaces and patterns?** Exactly where the problem is expected to vary (pricing, allocation, strategy) — which is where the interviewer's twist lands — not speculatively everywhere.
4. **Why use specific error types over generic `Error`?** They let callers handle specific failures and document what can go wrong, making the code more robust and readable.

#### Practical exercise

For the parking-lot problem, run the method's first four steps on paper: clarify three requirements, list the entities as classes with one-line responsibilities, identify the one or two behaviors that should be interfaces (because they will vary), and name the pattern you would use for each with a justification. Acceptance criteria: entities have single responsibilities, the varying behaviors are interfaces, and each pattern choice is justified by expected variation.
