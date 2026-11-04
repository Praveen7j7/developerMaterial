## 67.11 Common LLD mistakes and the pattern decision table

### 67.11.1 Common mistakes

#### Concept

Across the eight problems, the same mistakes recur, and avoiding them is most of what separates a strong LLD answer from a weak one. Knowing them explicitly lets you check your own design as you go.

#### The mistakes

- **God classes**: one class that does everything (a `ParkingLotManager` that allocates, prices, ticket-issues and reports). It violates single responsibility (Part 6), is hard to test, and fails the extensibility test. Decompose into classes with one responsibility each.
- **Patterns for show**: applying patterns to look sophisticated rather than because the problem needs them (a factory, a visitor and a decorator on a problem that needed none). It is "pattern soup" and scores poorly on patterns-with-reason. Use a pattern only where its variation point genuinely exists.
- **No extension point**: hardcoding the behavior the interviewer will want to vary (pricing inside `unpark`, the algorithm inside the rate limiter) so the twist forces a rewrite. Anticipate the variation point and put it behind an interface.
- **Untestable code**: tangling logic with I/O, time, or global state so it cannot be unit-tested (reading `Date.now()` directly everywhere, hidden singletons). Inject dependencies (the clock, the store) so the code is testable, and write the tests — the round scores them.
- **Deep inheritance**: a tall class hierarchy (an abstract `Vehicle` with many subclasses overriding behavior) that is rigid and hard to extend. Prefer composition and strategy.
- **Mutable shared state without thought**: mutating shared objects carelessly; in Node, reason about the event loop (67.1.3), and isolate transactional/staging state.
- **Not clarifying or not narrating**: solving the wrong problem, or solving it silently so the interviewer cannot follow or course-correct.

#### How a Senior Backend Engineer thinks about this

A senior runs a mental checklist against these mistakes as they design: does any class do more than one thing (god class)? Is any pattern here not justified by a real variation (pattern soup)? Where will the twist land, and is that behavior behind an interface (extension point)? Can I unit-test this without real I/O or time (testability)? Am I using composition over deep inheritance? They narrate this reasoning, which both improves the design and shows the interviewer a disciplined thought process. The goal throughout is the middle path: clean, single-responsibility classes, the few patterns the problem genuinely needs, testable, with the variation points behind interfaces so the twist is a small change.

### 67.11.2 Decision table: which pattern fits which requirement

#### Concept

A compact map from a kind of LLD requirement to the pattern that usually fits, so you can reach for the right tool quickly. The patterns are from Part 6; here is where each earns its place in an LLD answer.

| Requirement signal | Pattern | Example in this Part |
|---|---|---|
| "The X policy should be swappable / we might want a different X" | Strategy | Pricing, split type, scheduling, rate-limit algorithm, allocation |
| "The thing moves through states with only valid transitions" | State machine | Elevator states, seat states, order lifecycle |
| "Several parties react when something happens" | Observer / Pub-Sub | Order notifications, logger sinks, pub-sub library |
| "Create objects without the caller knowing the concrete class" | Factory | Creating the right strategy/handler from config |
| "Add behavior to an object without changing it" | Decorator | Wrapping a rate-limit strategy with logging/metrics |
| "A group of operations must apply atomically or not at all" | (Staging/Memento-like) transaction layer | KV store transactions |
| "Many implementations behind one contract" | Interface + dependency inversion | Repositories, sinks, strategies everywhere |
| "A single shared instance" | Singleton (use sparingly; prefer DI) | A shared logger (but inject it) |

#### How a Senior Backend Engineer thinks about this

A senior uses this mapping as a starting instinct, not a rulebook: the requirement signal suggests a pattern, but they confirm the variation or decoupling is real before applying it, because a pattern applied where there is no variation is just complexity (pattern soup). The two patterns that appear most in LLD rounds are strategy (for any swappable policy — the single most common) and state machine (for anything with a lifecycle), with observer/pub-sub close behind (for decoupled reactions). They lean on interfaces and dependency injection throughout (the foundation under most patterns, Part 6) because that is what makes designs both extensible and testable. The skill is matching the pattern to the real requirement and justifying it, which is exactly what "patterns with reason" scores.

#### Interview questions

1. **What pattern fits a swappable policy (pricing, scheduling, algorithm)?** Strategy — put the varying behavior behind an interface so implementations are interchangeable and the twist is a new class.
2. **What pattern fits a lifecycle with valid transitions?** A state machine (data-driven transition table or state objects), rejecting illegal transitions centrally.
3. **What pattern fits decoupled reactions to events?** Observer / pub-sub — publishers emit, subscribers react, with no coupling between them.
4. **How do you avoid pattern soup?** Apply a pattern only where a real variation or decoupling need exists, and be able to justify each; otherwise prefer simple, direct code.

#### Practical exercise

Take a new LLD prompt (a vending machine, or an online chess game) and, without full coding, produce: the core classes with single responsibilities, the one or two variation points and the pattern for each (justified), one lifecycle modeled as a state machine if present, and one likely interviewer twist with how your design absorbs it. Acceptance criteria: no god class, every pattern justified by a real variation, the twist is a localized change.

## Senior Checklist — Part 67

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
- [ ] I can run the LLD method (clarify, entities, interfaces, patterns, core, twist, test) while narrating
- [ ] I model with composition over inheritance, interfaces at variation points, and specific error types
- [ ] I give the Node-aware concurrency answer (event-loop atomicity, await races, cross-instance coordination)
- [ ] I can solve the eight worked problems with clean classes, patterns-with-reason, and tests
- [ ] I anticipate the interviewer's twist and place it behind an interface so it is a one-class change
- [ ] I avoid god classes, pattern soup, missing extension points and untestable code
- [ ] I can map a requirement signal to the right pattern and justify it

## Part 67 — Key Takeaways

- The LLD/machine-coding round scores the daily craft: decomposition into single-responsibility classes, patterns used with justification, extensibility, naming, and tests — clean working code, not a distributed design.
- Use a repeatable method and narrate it: clarify requirements, identify entities, define interfaces at variation points, pick patterns with reason, code the core, extend for the twist, test.
- Model with composition over inheritance, program to interfaces exactly where variation is expected, use union types and immutability, and define specific error types.
- Give the Node-aware concurrency answer: synchronous in-memory state is atomic within a process (no locks needed), state spanning an `await` can race, and cross-instance state needs database/Redis coordination (the seat-booking pattern).
- The strategy pattern is the most common LLD tool: put the behavior the interviewer will vary (pricing, split, scheduling, algorithm, allocation) behind an interface so the twist is a new implementation.
- State machines model lifecycles with valid transitions (elevator, seats, orders), ideally as a data-driven transition table; observer/pub-sub decouples reactions (notifications, sinks) from the thing that changes.
- Anticipate the interviewer's twist: it lands on the variation point, and a good design absorbs it with a small localized change while a bad one needs a rewrite — this is the real test of extensibility.
- Isolate transactional/staging state (the KV store) rather than mutating core state directly, so commit, rollback and nesting stay simple.
- Avoid the recurring mistakes: god classes, pattern soup, missing extension points, untestable code (inject the clock and dependencies), and deep inheritance.
- Match the pattern to a real requirement signal and justify it; a pattern applied without a genuine variation or decoupling need is just complexity, and the round rewards the middle path between a structureless blob and over-engineered pattern soup.
