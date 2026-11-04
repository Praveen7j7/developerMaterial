## 68.3 The system design round

### 68.3.1 A 45-minute procedure

#### Concept

The system design round asks you to design a system (a URL shortener, a notification system, a ride-booking backend) in about 45 minutes, judged on your method, your tradeoff reasoning, and the depth you show when probed. It is best run as a timed procedure with budgets for each phase, so you cover requirements, estimation, high-level design, a deep dive, and the cross-cutting concerns without running out of time. This is the interview application of the method taught in Parts 40, 41, 65 and 66.

#### Why does it exist?

Designing a system well under time pressure, communicating as you go, and defending your choices is exactly what senior engineers do in design reviews, so the round tests it directly. It exists to assess judgment — can you clarify a vague problem, reason with numbers, make and justify tradeoffs, go deep where it matters, and know the failure modes — rather than recall. Treating it as a timed procedure exists because the most common failure is poor time management: spending too long on the diagram and never reaching the tradeoffs and depth the interviewer is actually scoring.

#### How it works — the time-boxed procedure

```text
45-minute system design procedure (narrate constantly):
  0-5 min   Clarify requirements: functional, non-functional (latency, availability,
            consistency), constraints, scope. Write them down. Confirm scope.
  5-10 min  Capacity estimation: users, RPS avg/peak, read:write, storage, bandwidth.
            Do the arithmetic out loud; let the numbers drive the design.
  10-15 min API design + data model: endpoint table, entities, key indexes.
  15-25 min High-level design: components and data flow; narrate one request end to end.
  25-35 min Deep dive: go deep on the hot path the interviewer chooses (the exact mechanism).
  35-42 min Cross-cutting: failure modes (a table), scaling ladder (1x/10x/100x), security, cost.
  42-45 min Tradeoffs and alternatives: what you gave up, what else you considered, when it wins.
```

This is the Part 40 method (its section 40.0) compressed into a 45-minute budget. The key time-management rules: do not start with the diagram (clarify and estimate first — 10 minutes before any boxes); do not spend 30 minutes on the high-level diagram and skip the deep dive and tradeoffs (where seniority shows); and leave time for tradeoffs and alternatives at the end (a design with no stated weaknesses looks unconsidered). The interviewer will choose where to go deep (the deep-dive phase); follow their lead on which hot path to explore.

#### How it works — depth selection and handling pushback

- **Depth selection**: you cannot go deep on everything in 45 minutes, so keep most of the design at the box level and go deep on the two or three paths that carry the risk (the redirect path, the fan-out, the seat-hold logic — Part 40), or wherever the interviewer points. Signal that you know where the depth is ("the interesting part here is the hot path; let me go deep there").
- **Handling pushback**: the interviewer will challenge your choices ("why not use X?", "what happens at 100x?", "what if the cache is down?"). This is not an attack; it is the test. Respond by reasoning, not defending: acknowledge the tradeoff, state why you chose as you did, and name the condition under which the alternative wins. Being able to say "you're right, that would be better if Y" is a strength, not a weakness — rigidly defending a choice against a valid point scores poorly.

#### How a Senior Backend Engineer thinks about this

A senior runs the system design round as the time-boxed procedure, narrating constantly, because the most common failure is time mismanagement — never reaching the tradeoffs and depth that demonstrate seniority. They clarify and estimate before drawing, let the numbers drive the architecture, keep most of the design at the box level and go deep only on the risky hot paths (or where the interviewer points), and always leave time for failure modes, the scaling ladder, and honest tradeoffs with alternatives. They treat the interviewer's pushback as collaboration, reasoning about tradeoffs rather than defending rigidly, and they are comfortable saying when an alternative would be better under different constraints. They apply the exact method from Parts 40, 65 and 66, which is why those Parts are worked examples of this round.

#### Common mistakes

- Starting with the diagram instead of clarifying requirements and estimating.
- Spending too long on the high-level design and never reaching the deep dive and tradeoffs.
- Not doing the capacity estimation, so the design is ungrounded in numbers.
- Defending a choice rigidly against valid pushback instead of reasoning about the tradeoff.
- Going deep on everything (no time) or nowhere (no depth signal).
- No failure modes, scaling ladder or tradeoffs — the parts where seniority shows.

#### Interview questions (for your preparation)

1. **How do you budget 45 minutes for a system design round?** ~5 clarify, ~5 estimate, ~5 API/data model, ~10 high-level, ~10 deep dive, ~7 cross-cutting (failures/scaling/security/cost), ~3 tradeoffs/alternatives — narrating throughout.
2. **How do you handle an interviewer challenging your design?** Treat it as the test, not an attack: acknowledge the tradeoff, justify your choice, and name when the alternative would win; reason rather than defend rigidly.
3. **How do you decide where to go deep?** Keep most of the design at the box level; go deep on the two or three risky hot paths or wherever the interviewer points, and signal that you know where the depth is.
4. **Why estimate capacity before designing?** The numbers drive the architecture (whether you need a cache, a queue, sharding); designing without them is guessing.

#### Practical exercise

Run a full 45-minute system design on a prompt from Parts 40/65/66 (or a new one) against a timer, hitting each phase in its budget and narrating. Deliberately have a friend or yourself push back on two choices mid-way and practice reasoning about the tradeoff rather than defending. Acceptance criteria: you reach tradeoffs and alternatives within 45 minutes, you did estimation before drawing, and you handled pushback by reasoning about the tradeoff.

## 68.4 Other round types

### 68.4.1 Take-homes, debugging, code-review, pair programming, API design

#### Concept

Beyond coding and system design, loops include other round types, each testing a different facet: **take-home assignments** (build something on your own time), **debugging rounds** (find and fix a bug in given code), **code-review rounds** (review a PR), **pair programming** (collaborate on a problem live), and **API design rounds** (design an API's contract). Knowing what each is scoring lets you prepare for the specific signal.

#### How it works — what each round scores and how to approach it

| Round | What it scores | How to approach it |
|---|---|---|
| Take-home | Real-world code quality, structure, tests, docs, judgment on an open problem | Treat it like production code: clean structure, tests, a README explaining decisions and tradeoffs; respect the time box; do not gold-plate |
| Debugging | Systematic debugging, reading unfamiliar code, hypothesis-driven fixing (Part 36) | Reproduce first, form a hypothesis, isolate, verify the fix; narrate your reasoning; do not guess randomly |
| Code review | Judgment on correctness, security, performance, maintainability; communication (Part 25) | Check for real issues (bugs, N+1, injection, missing error handling, Part 23); prioritize; give constructive, specific feedback |
| Pair programming | Collaboration, communication, handling feedback, working with someone | Think aloud, involve the interviewer, accept suggestions, be the collaborator they would want as a teammate |
| API design | Contract design: resources, methods, status codes, versioning, errors (Parts 8, 61, 71) | Design clear resource-oriented endpoints, correct status codes, idempotency, pagination, versioning; justify choices |

The common thread: each round is a proxy for a slice of the real job, so the best preparation is to do that slice well. A take-home is judged like a code review of your production work — clean, tested, documented, right-sized (do not over-build, do not under-deliver). A debugging round rewards the systematic method from Part 36 (reproduce, hypothesize, isolate, verify), not random guessing. A code-review round rewards the judgment and communication from Part 25 — finding the issues that matter and giving constructive feedback. A pair-programming round rewards being a good collaborator. An API-design round rewards the contract craft from Parts 8 and 71.

#### How a Senior Backend Engineer thinks about this

A senior recognizes each round as a proxy for part of the job and brings the relevant discipline from the technical Parts: production-quality code with tests and a decision-explaining README for take-homes (right-sized to the time box), the systematic debugging method for debugging rounds, the code-review craft (real issues, prioritized, constructive) for review rounds, genuine collaboration for pair programming, and contract design for API rounds. They know take-homes are often where over-engineering sinks candidates (building far beyond the prompt) or under-delivering sinks them (no tests, no README), so they right-size and explain their tradeoffs. They narrate their reasoning in every round, because communication is scored across all of them, and they treat each as a chance to show how they actually work, which is exactly what these rounds are designed to reveal.

#### Common mistakes

- Take-home: over-engineering beyond the prompt, or under-delivering (no tests, no README, no explanation of decisions).
- Debugging: guessing randomly instead of reproducing and forming hypotheses (Part 36).
- Code review: nitpicking style while missing real bugs/security issues, or harsh non-constructive feedback (Part 25).
- Pair programming: coding silently, not collaborating or accepting input.
- API design: verbs in paths, wrong status codes, no idempotency/pagination/versioning (Parts 8, 71).

#### Interview questions (for your preparation)

1. **How should you treat a take-home assignment?** Like production code: clean structure, tests, a README explaining decisions and tradeoffs, right-sized to the time box — not over-engineered, not under-delivered.
2. **What method should a debugging round show?** Systematic debugging (Part 36): reproduce, hypothesize, isolate, verify the fix, narrating — not random guessing.
3. **What makes a strong code-review round performance?** Finding the issues that matter (correctness, security, performance, maintainability), prioritizing them, and giving specific constructive feedback (Part 25).
4. **What does a pair-programming round really test?** Collaboration and communication — thinking aloud, involving the interviewer, accepting feedback — being the teammate they would want.

#### Practical exercise

Pick two of the other round types and practice each: for a debugging round, take a piece of code with a planted bug and apply the reproduce-hypothesize-isolate-verify method aloud; for an API-design round, design the endpoints for a small service (resources, methods, status codes, idempotency, pagination, versioning) and justify each choice. Acceptance criteria: the debugging practice shows a systematic method (not guessing), and the API design follows the conventions of Parts 8 and 71 with justified choices.
