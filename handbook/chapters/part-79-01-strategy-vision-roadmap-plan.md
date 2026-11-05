# Part 79 — Technical Strategy, Vision and Roadmaps

Part 56 said that writing a technical strategy is one of the things that distinguishes staff from senior, and gave a one-paragraph definition. Part 109.5 gave you a build-versus-buy decision table. This Part is the full discipline of technical strategy: what it actually is (and what people wrongly call strategy), how to write one that survives contact with reality, how to connect a two-to-three-year vision to the business, how to sequence a multi-quarter roadmap, how to manage technical debt as a portfolio rather than a guilty backlog, and how to decide whether to adopt a new technology at all.

The word "strategy" is the most abused word in engineering. Most things called strategy are either a list of goals ("be more reliable"), a wish ("move to microservices"), or a roadmap with the reasoning removed. Real strategy is rarer and more useful than any of those, and this Part is about producing the real thing.

The reader this Part assumes is a senior or staff engineer who can design systems and is now being asked, explicitly or by the gap they can feel, to set direction for more than their own team — to answer "where are we going and why" for a group of teams or a whole engineering org.

## 79.1 Strategy versus vision versus roadmap versus plan

#### Concept

Four words get used interchangeably and mean four different things, and conflating them is the root of most bad "strategy" documents. A **strategy** is a way of overcoming a specific challenge: a diagnosis of the situation, a guiding policy for dealing with it, and a set of coherent actions. A **vision** is a description of a desirable future state, years out, that gives everyone a shared direction. A **roadmap** is a time-ordered sequence of what you will do to move toward the vision, respecting dependencies and capacity. A **plan** is the detailed, near-term breakdown of the next slice of the roadmap into tasks, owners and dates.

They nest: the vision sets the destination, the strategy explains how you will get there despite the obstacles, the roadmap sequences the moves, and the plan executes the next move.

#### Why does it exist?

Imagine a team that has a roadmap but no strategy. The roadmap says: Q1 split the monolith's payment module, Q2 adopt Kafka, Q3 move to Kubernetes. It looks organised. But ask "why these, in this order, and what are we trying to achieve" and nobody can answer, because the roadmap is a list of activities with the reasoning deleted. When priorities shift — and they always do — the team has no basis for deciding what to drop, because they never knew why anything was on the list. They cut the wrong thing, or they cling to all of it and burn out.

The distinction exists so that each artifact can do its job. A vision without a strategy is a daydream. A strategy without a roadmap never gets executed. A roadmap without a strategy is a to-do list that collapses under the first reprioritisation. A plan without a roadmap is busywork. You need all four, and you need to know which one you are writing.

#### Mental model

Imagine planning a journey across a continent.

```text
Vision:   "Reach the west coast" — the destination, inspiring, durable.
Strategy: "The mountains block the direct route, and winter is coming.
           So we go south around the range before the passes close, trading
           distance for safety." — the way past the specific obstacle.
Roadmap:  "Week 1 reach the river crossing; week 2 the southern pass;
           week 3 the plains." — the sequence, respecting terrain.
Plan:     "Tomorrow: pack, buy supplies, leave by 6am, make 40 miles."
          — the next concrete steps.
```

The vision never changes. The strategy changes if the obstacle changes (the pass is already closed — now what). The roadmap changes often as you learn the terrain. The plan changes daily. People who call a roadmap a strategy have a journey with a to-do list but no reasoning about the mountains, and they are the ones who walk straight into a closed pass.

#### How it works

The four artifacts differ along clear dimensions. This table is the one to internalise.

| Dimension | Vision | Strategy | Roadmap | Plan |
|---|---|---|---|---|
| Question it answers | Where are we going? | How do we get there despite the obstacle? | In what order do we move? | What do we do next? |
| Horizon | 2 to 5 years | 1 to 3 years | 2 to 6 quarters | This quarter / sprint |
| Changes | Rarely | When the obstacle or landscape changes | Every quarter as you learn | Constantly |
| Contains | A desirable future state | Diagnosis, guiding policy, coherent actions | Sequenced initiatives with dependencies | Tasks, owners, dates |
| Fails when | It is just a slogan | It is a list of goals with no diagnosis | It has no reasoning behind the order | It is disconnected from the roadmap |
| Audience | Everyone | Leadership and senior engineers | Teams and their leads | The executing team |

The flow between them:

```mermaid
flowchart LR
    V["Vision - where we're going - 2-5 yrs"] --> S["Strategy - how, past the obstacle - 1-3 yrs"]
    S --> R["Roadmap - sequence - 2-6 quarters"]
    R --> P["Plan - next steps - this quarter"]
    P -->|"what we learn executing"| R
    R -->|"what we learn about the obstacle"| S
```

Note the feedback arrows. Execution teaches you about the terrain, which updates the roadmap; the roadmap sometimes teaches you the obstacle is different than you thought, which updates the strategy. The vision rarely moves. A team that never updates its roadmap from execution learnings is marching to a map it knows is wrong.

#### Practical example

An e-commerce company is slowing down. Features that took two weeks now take six. Here is each artifact for that situation, done right.

- **Vision:** "Any team can ship a customer-facing change end to end in under a day, independently, without waiting on another team." Durable, inspiring, measurable, years out.
- **Strategy:** "The slowdown is caused by a single shared monolith and a single shared database that every team deploys and migrates together, so every change is serialised behind every other change [diagnosis]. We will reduce coupling by giving teams ownership of bounded contexts with their own data and deploy pipelines, extracting services only where a team is genuinely blocked, and we will refuse to extract services that are not blocked because that trades one kind of coupling for a worse one [guiding policy + what we refuse]. Concretely: establish a modular monolith with enforced boundaries first, extract the two most-blocked contexts, and build the platform that makes independent deploys cheap [coherent actions]."
- **Roadmap:** "Q1 enforce module boundaries + CI per module. Q2 extract payments (most-blocked) with its own DB. Q3 build the service template + deploy platform. Q4 extract fulfilment."
- **Plan:** "This sprint: add the lint rule blocking cross-module imports, split the test suite per module, document the first module's public interface."

Notice the strategy is the only artifact with a *diagnosis* and a *refusal*. That is what makes it a strategy and not a roadmap.

#### Artifact example

The same situation, shown as the one-paragraph "strategy kernel" — the test of whether you have a strategy at all. If you cannot fill all three slots with specifics, you have a wish, not a strategy.

```markdown
## Strategy kernel: engineering velocity

DIAGNOSIS (the crux of the problem, honestly):
One monolith + one shared database means every team's deploys and schema
migrations are serialised. Lead time for a change has risen from ~10 to
~30 days as the team grew from 12 to 45. The problem is COUPLING, not
effort or skill.

GUIDING POLICY (the approach, including what we will NOT do):
Reduce coupling by giving teams ownership of bounded contexts with their
own data and independent deploys. Extract services ONLY where a team is
measurably blocked. We will NOT do a big-bang microservices rewrite, and
we will NOT extract a service just because a boundary exists — unblocking
is the only justification.

COHERENT ACTIONS (moves that reinforce each other):
1. Modular monolith with enforced boundaries (enables later extraction).
2. Extract the two most-blocked contexts, each with its own DB.
3. Build a service template + deploy platform (makes #2 cheap and repeatable).
These compound: #1 makes #2 safe, #3 makes #2 and all future extractions cheap.
```

This kernel is three paragraphs and it is worth more than a forty-slide deck, because it names the real problem, commits to an approach, says what it refuses to do, and shows that the actions reinforce each other rather than being a random list. If someone asks "should we extract the reporting service", you can answer from the kernel: is reporting blocked? No? Then no.

#### Real-world scenario

A VP asks a principal engineer for "a technical strategy" and gets handed, by three different teams, three documents: a list of goals ("improve reliability, reduce costs, increase velocity"), a roadmap ("Q1 Kafka, Q2 K8s"), and a vision slogan ("world-class engineering"). None of them is a strategy. The principal engineer's job is to produce the missing middle: the diagnosis of why the company is where it is, the guiding policy for getting out, and the coherent actions. When he does, the three existing documents suddenly have a spine — the goals become the vision's measures, the roadmap's order now has a reason, and the slogan has substance. The strategy did not replace the other artifacts; it connected them.

#### Failure scenario

A company publishes a "technical strategy" that is really a list of aspirations: be more scalable, be more reliable, adopt modern technology, reduce technical debt. Everyone nods; it sounds right. But because there is no diagnosis and no guiding policy, it provides no basis for any actual decision. When two teams want the same engineers, the strategy cannot adjudicate, because "be more scalable" and "be more reliable" both sound strategic and point in different directions. When a tempting new technology appears, the strategy cannot say no, because "adopt modern technology" says yes to everything. The document exists, it was expensive to produce, and it changes nothing — because a list of good things is not a strategy. Strategy is choice, and a document that chooses nothing is not one.

#### Edge cases & failure modes

- **Roadmap called strategy.** A sequence of activities with the reasoning removed. Collapses under the first reprioritisation because nobody knows why anything is on it.
- **Goals called strategy.** "Be more reliable, be faster." Sounds strategic, adjudicates nothing, says no to nothing.
- **Vision with no strategy.** An inspiring destination and no account of the obstacle in the way. A daydream.
- **Strategy with no diagnosis.** Jumps straight to actions without naming the real problem, so the actions often address a symptom, not the cause.
- **Strategy that refuses nothing.** If it does not say what you will *not* do, it is not making choices, so it is not a strategy.
- **Never updating from execution.** Treating the roadmap as fixed and ignoring what building teaches you about the terrain.

#### How a Principal Engineer thinks about this

They know which of the four they are writing and never confuse them, because each has a different job and conflating them produces documents that do none of the jobs. They treat the diagnosis as the hard, valuable part — most people skip straight to actions, and most bad strategy is an action list addressing a misdiagnosed problem. They insist that a real strategy says what it refuses to do, because a strategy that says yes to everything has made no choices and will not survive the first resource conflict.

They also keep the vision stable and the roadmap fluid, and they are suspicious of anyone whose roadmap never changes — it means execution is teaching them nothing, or they are not listening. And they write the strategy kernel first, in three paragraphs, before any deck, because if it cannot be said in three paragraphs the thinking is not done.

#### Common mistakes

- **Calling a roadmap a strategy,** so the plan collapses the moment priorities shift.
- **Writing a list of goals and believing it is strategy,** because it adjudicates nothing.
- **Skipping the diagnosis** and jumping to actions that treat symptoms.
- **Refusing to refuse anything,** which means no real choices were made.
- **Freezing the roadmap** and ignoring what execution reveals about the terrain.

#### Interview questions

1. **What is the difference between a strategy and a roadmap, and why does it matter?**
   *Expected answer:* a strategy is a diagnosis, guiding policy and coherent actions for overcoming a specific obstacle; a roadmap is a time-ordered sequence of initiatives. It matters because a roadmap without a strategy has no reasoning behind the order, so it collapses under reprioritisation and cannot tell you what to cut. *Why it matters:* this is the central confusion in the whole topic.

2. **I give you a "strategy" that says: be more scalable, reliable, and modern. What is wrong with it?**
   *Expected answer:* it is a list of goals, not a strategy — no diagnosis of the real problem, no guiding policy, and crucially it refuses nothing, so it cannot adjudicate a resource conflict or say no to a tempting technology. *Follow-up:* turn it into a real strategy for a specific situation.

3. **Why must a strategy say what you will not do?**
   *Expected answer:* because strategy is choice; finite resources mean choosing some things is refusing others, and a document that commits to everything has made no choices and provides no basis for decisions. *Why it matters:* tests whether they understand the essence of strategy versus aspiration.

#### Practical exercise

Pick a real challenge your engineering org faces (velocity, reliability, cost, a platform gap). Write its strategy kernel: three paragraphs — diagnosis (the honest crux of the problem, with a number), guiding policy (the approach plus at least one explicit "we will NOT"), and coherent actions (three moves that reinforce each other). Then separately write the one-sentence vision it serves.

**Acceptance criteria:** the diagnosis names a cause, not a symptom, and includes a number; the guiding policy contains at least one concrete refusal; the three actions can be shown to reinforce one another (each makes the next cheaper or safer); and a colleague reading the kernel can use it to say no to a plausible-but-off-strategy proposal you give them.
