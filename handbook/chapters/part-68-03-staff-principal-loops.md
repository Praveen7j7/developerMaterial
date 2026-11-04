## 68.5 Staff and principal loops

### 68.5.1 Past-project deep dive, architecture round, leadership signals, written exercises

#### Concept

Staff and principal loops (Part 44 defines the levels) differ from senior loops: they weight scope, judgment, influence and architectural depth far more than raw coding, and they add round types designed to surface those — a past-project deep dive, an architecture round, leadership and influence assessment, and sometimes a written exercise. The bar is about demonstrated impact at scale and the ability to drive technical direction across teams, not just to build well.

#### Why does it exist?

A staff or principal engineer's value is leverage — multiplying the effectiveness of many engineers through architecture, technical strategy, influence and mentorship (Parts 51 to 57) — so the loop must assess those, which a coding round cannot. These rounds exist to probe whether a candidate has operated at that scope: led a major migration (Part 54), set technical direction (Part 52), influenced without authority (Part 56), designed systems that held up (Parts 40 to 66), and grown other engineers (Part 57). The signals are judgment, scope, communication and influence, assessed through deep conversations about real past work and realistic scenarios.

#### How it works — the round types

- **Past-project deep dive**: a long conversation about a significant project you led, probing your decisions, tradeoffs, what went wrong, how you influenced others, and what you would do differently. This is the central staff/principal round. The interviewer digs for depth: why this choice, what alternatives, what was the hardest part, how did you handle disagreement, what was the measurable impact. Prepare two or three projects you can discuss in depth with the clarity of the write-ups from 68.1.
- **Architecture round**: like the system design round but broader and deeper — often an open-ended, organization-scale problem (design the architecture for this product area, or evaluate this existing architecture), probing judgment, tradeoffs, migration thinking (Part 54), and governance (Part 53). It assesses whether you can architect at scope, not just design one service.
- **Leadership and influence**: behavioural and scenario rounds probing how you influence without authority (Part 56), handle disagreement and conflict, mentor and grow engineers (Part 57), make decisions under ambiguity, and communicate with executives and stakeholders. The signal is leverage and judgment, demonstrated through concrete past examples (structured as situation, your action, the outcome).
- **Written exercise**: some loops ask for a written document (a design doc, a strategy memo, an architecture evaluation) because writing is the staff/principal engineer's primary tool (Part 51). It assesses whether you can structure a complex argument clearly in writing — the exact skill Part 51 teaches.

```text
Senior loop weight:   coding ███ | system design ███ | behavioural ██
Staff/principal shift: coding █   | architecture ████ | past-project deep dive ████
                       | leadership & influence ████ | written exercise ██
(coding still appears but weighs far less; scope, judgment and influence dominate)
```

#### How it works — strong vs weak answers

| Signal | Weak answer | Strong answer |
|---|---|---|
| Scope | "I built a feature" | "I led a cross-team migration affecting 40 services over 18 months" |
| Decisions | "We used Kafka" | "We chose Kafka over the outbox because volume hit 10k/s; here's the tradeoff we accepted" |
| Influence | "I told them to do it" | "I pre-wired the key reviewers, wrote an RFC, and built consensus before the decision meeting" (Part 56) |
| Failure | "It went fine" | "We lost 0.3% of refunds in a migration; reconciliation caught it; here's what I changed" (Part 54) |
| Impact | "It was faster" | "p99 dropped from 400ms to 90ms; the reliability program cut incidents by 60%" |

The pattern of strong staff/principal answers: concrete scope and measurable impact, tradeoffs reasoned explicitly (what you gave up and why), influence shown through the mechanisms of Part 56 (pre-wiring, writing, coalitions) rather than authority, and honesty about failures with what you learned and changed. Weak answers are vague, take sole credit or no responsibility, show no tradeoff reasoning, and lack numbers.

#### How a Senior Backend Engineer thinks about this

A senior preparing for a staff/principal loop prepares two or three significant projects they can discuss in deep detail — the decisions, the tradeoffs, the failures, the influence, the measurable impact — because the past-project deep dive is the heart of the loop and depth is what distinguishes real scope from narration. They practice articulating tradeoffs explicitly (the Part 49 and Part 51 discipline), demonstrating influence through the mechanisms of Part 56 rather than claiming authority, and being honest about failures with concrete lessons. They prepare for an organization-scale architecture round using the migration (Part 54), governance (Part 53) and strategy (Part 52) thinking, and they sharpen their writing (Part 51) for a possible written exercise. They know the loop assesses leverage and judgment, so they frame everything in terms of impact at scope, not individual output.

#### Common mistakes

- Thin past-project stories that cannot survive deep probing (no real depth of decisions, tradeoffs, failures).
- Claiming sole credit or taking no responsibility; staff/principal is about influence and collaboration.
- No tradeoff reasoning — "we used X" without why or what was given up.
- No numbers — unquantified impact reads as unsubstantiated.
- Demonstrating influence as authority ("I told them") rather than the mechanisms of Part 56.
- Treating it like a senior loop (over-indexing on coding) instead of scope, judgment and influence.

#### Interview questions (for your preparation)

1. **What is the staff/principal loop assessing versus the senior loop?** Scope, judgment, influence and architectural depth (leverage), through a past-project deep dive, architecture round, leadership/influence rounds and sometimes a written exercise — coding weighs far less.
2. **How do you prepare for the past-project deep dive?** Prepare two or three significant projects you can discuss in deep detail: decisions, tradeoffs, failures, how you influenced others, and measurable impact.
3. **What makes an influence answer strong?** Showing the mechanisms of influence without authority (pre-wiring reviewers, writing an RFC, building consensus — Part 56) and measurable outcomes, not "I told them to do it".
4. **Why might there be a written exercise?** Writing is the staff/principal engineer's primary tool (Part 51); the exercise assesses whether you can structure a complex technical argument clearly in writing.

#### Practical exercise

Prepare one significant past project for a deep-dive round: write out the problem and scope (with numbers), two key decisions with the tradeoffs you reasoned through and the alternatives you rejected, one thing that went wrong and what you changed, how you influenced others toward the decision (using Part 56 mechanisms), and the measurable impact. Then have someone probe it with "why?" five levels deep. Acceptance criteria: the story survives deep probing with real detail at every level, shows tradeoff reasoning and influence (not authority), and quantifies both scope and impact.
