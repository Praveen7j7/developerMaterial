## 79.4 Managing technical debt as a portfolio

#### Concept

Technical debt is usually treated as a guilty backlog — an undifferentiated pile of "stuff we should clean up someday" that always loses to features. Managing it as a *portfolio* means treating it the way a finance team treats debt and investments: classify it by type, quantify its ongoing cost in real units (incidents, lead-time, toil hours), decide which debt is worth paying down and which to carry deliberately, and fund the paydown through explicit mechanisms rather than hope. Part 60 catalogued the anti-patterns that create debt; this section is about managing the debt you have.

#### Why does it exist?

Imagine your personal finances as one undifferentiated pile labelled "money stuff". You could not decide whether to pay off the credit card (28% interest) or the mortgage (4%), because you never separated them or measured their cost. You would make random payments and stay poor. Technical debt treated as one pile behaves the same way: you cannot decide what to fix because you never classified it or measured what it costs you, so paydown is random and ineffective, and debt work always loses to features because it has no number to defend itself with.

The portfolio approach exists to give debt a cost you can measure and compare, so that paying it down becomes a rational investment decision ("this debt costs us 40 engineer-hours a month; fixing it costs 120 hours; it pays back in three months") rather than a guilt-driven, losing argument against features.

#### Mental model

Imagine a portfolio of loans. Some are high-interest (they cost you a lot every month you carry them). Some are low-interest (cheap to carry, no rush). Some you took on deliberately and plan to pay off at a specific time (a bridge loan). Some are predatory and compounding (they get worse fast). A good portfolio manager does not pay them all off equally; they attack the high-interest compounding debt first, carry the cheap debt happily, and plan the deliberate debt's payoff. Technical debt is identical: the skill is knowing the interest rate of each piece and attacking in the right order, not feeling guilty about all of it at once.

#### How it works

Three steps: classify, quantify, fund.

**Classify.** Not all debt is the same. A useful taxonomy:

| Type | What it is | Example | Treatment |
|---|---|---|---|
| Deliberate + prudent | Chosen shortcut with a plan to fix | "Ship with a manual process now, automate in Q2" | Track; pay off as planned |
| Deliberate + reckless | Shortcut with no plan | "No tests, no time" | Stop creating it; schedule paydown |
| Accidental + prudent | Learned a better way after the fact | "Now we know the right boundary" | Refactor opportunistically |
| Accidental + reckless | Didn't know what you were doing | Tangled module from a rushed junior | Prioritise by cost |
| Bit rot / decay | Debt from the world changing | EOL dependency, deprecated API | Treat as maintenance, schedule before EOL |

**Quantify.** Give each significant piece of debt a cost in real units, measured, not guessed:
- **Incident cost:** how many incidents (and hours of outage, and dollars) did this debt cause last quarter?
- **Lead-time cost:** how much longer does a typical change take because of this debt? (e.g. "touching the order module requires understanding 4,000 lines of tangled code, adding ~2 days per change").
- **Toil hours:** how many hours of manual work per week does this debt impose? (e.g. "the manual reconciliation this missing automation requires: 6 hours/week").

**Fund.** Debt paydown needs a funding mechanism, because it loses to features by default:

```text
1. The 20% rule:     a fixed fraction of every team's capacity goes to debt,
                     always, no negotiation. Simple, sustainable, invisible gains.
2. Debt sprints:     periodic sprints dedicated to paydown. Visible but easy to
                     cancel when features are hot.
3. Attach to features: pay down the debt in the area a feature touches, funded
                     by the feature. "Boy scout rule" at project scale.
4. Fund the top N:   quantify, rank by cost, and explicitly fund paying down the
                     highest-cost items as named projects with ROI.
```

Most mature orgs use a blend: a baseline 20% for small continuous paydown, plus explicitly-funded projects for the few high-cost items that need a concentrated effort.

#### Practical example

An order team's "order module" is their worst debt. Managed as a portfolio: they classify it as accidental+reckless (grew tangled over three years of rushed changes). They quantify it: it caused 4 of last quarter's 9 incidents (~6 hours outage, ~$30k), and every change to it takes ~2 extra days (measured across the last 20 changes), and it generates ~6 hours/week of manual order-correction toil. That is a concrete, defensible cost: roughly 2 engineer-days per change plus 6 hours/week plus a share of incident cost. They estimate the refactor at 6 engineer-weeks. The ROI argument writes itself: 6 weeks of investment against ~25 engineer-days/quarter of ongoing cost means payback in under a quarter. Funded as a named project, not as guilty backlog, it gets done — because it has a number.

#### Artifact example

A technical-debt register with the portfolio framing — the artifact that turns "we have a lot of debt" into fundable decisions.

```markdown
# Technical Debt Register — Order Platform (reviewed quarterly)

| Item | Type | Measured cost / quarter | Fix estimate | Interest | Decision |
|---|---|---|---|---|---|
| Tangled order module | Accidental/reckless | 4 incidents (~$30k), +2d per change (~25 eng-days), 6h/wk toil | 6 eng-weeks | HIGH | FUND NOW (project ORD-refactor, Q2) |
| No idempotency on refunds | Deliberate/reckless | 11 double-refund incidents, ~22h support | 1 eng-week | HIGH | FUND NOW (ADR-052) |
| Sequelize + TypeORM both used | Accidental/prudent | Confusion, ~0.5d onboarding/eng, no incidents | 4 eng-weeks | LOW | CARRY — cheap to hold, revisit 2027 |
| Manual tier-config deploy | Deliberate/prudent | 2h/wk toil, planned to automate | 1 eng-week | MEDIUM | PAY in 20% capacity, Q2-Q3 |
| EOL Node 18 | Bit rot | None yet; EOL in 8 months | 2 eng-weeks | MEDIUM (rising) | SCHEDULE before EOL (Q3) |

## Funding
- Baseline: 20% of order-team capacity to the MEDIUM items continuously.
- Named projects: the two HIGH items funded explicitly, with ROI above.
- Carry list: the LOW item is deliberately NOT funded; carrying it is cheaper
  than fixing it. We revisit if its cost rises.
```

What makes this work: every item has a *measured* cost (not "it feels bad"), an "interest" rating that drives order, and an explicit decision including the deliberate choice to *carry* the cheap debt. The carry decision is as important as the fund decision — paying down low-interest debt is wasting money you could spend on high-interest debt. A register that funds everything equally is as wrong as one that funds nothing.

#### Real-world scenario

A principal engineer inherits an org where "tech debt" is a constant losing argument: every retro, engineers plead for debt time, and every planning cycle, features win. She changes the argument's shape, not its volume. She builds the register above, with measured costs, and reframes each high-cost item as an ROI proposition to the product and finance partners: "the order module costs us roughly 25 engineer-days a quarter in slowed changes and a share of our incident bill; six weeks fixes it; it pays back in under a quarter". Suddenly the debt work wins, not because she argued harder but because it stopped being a feelings-based plea and became an investment with a return. The quantification did what three years of pleading could not.

#### Failure scenario

A team runs quarterly "debt sprints" — a full sprint every quarter dedicated to paydown. It sounds disciplined. But debt sprints are the easiest thing to cancel: every quarter a feature is hot, the debt sprint is "just this once" deferred, and after a year it has run twice out of four times. Worse, because all debt work is concentrated into these sprints, no paydown happens the rest of the time, so debt accumulates for ten weeks and gets a partial cleanup for two. The team feels like they are managing debt because the sprints exist on the calendar; the debt grows anyway. The mechanism was too cancellable and too lumpy. A continuous 20% baseline — invisible, non-negotiable, always running — would have paid down more debt with less drama, precisely because it is never a discrete thing anyone can cancel.

#### Edge cases & failure modes

- **Treating all debt as one pile.** No classification, no measurement, so paydown is random and always loses to features.
- **Paying down cheap debt.** Fixing low-interest items feels productive but wastes capacity that high-interest debt needs.
- **Debt sprints that get cancelled.** Too easy to defer when features are hot; paydown becomes lumpy and incomplete.
- **Unmeasured debt.** "It feels bad" cannot win against a feature with a revenue number. Without a measured cost, debt loses every argument.
- **Never carrying debt deliberately.** Trying to fix everything; some debt is genuinely cheaper to carry than to fix, and refusing to carry it wastes effort.
- **Deliberate/reckless debt created silently.** Shortcuts taken with no record, so they are never scheduled for paydown and compound invisibly.

#### How a Principal Engineer thinks about this

They refuse to argue about debt in the language of guilt and instead force it into the language of cost and return, because they know an unmeasured plea loses to a measured feature every time. They classify debt so that they can attack the high-interest, compounding items first and happily *carry* the cheap items — they treat "we will deliberately not fix this, it is cheaper to hold" as a legitimate, even wise, decision rather than a failure.

They favour a continuous baseline (the 20% rule) over lumpy debt sprints, because the baseline is non-negotiable and therefore survives hot-feature quarters, while sprints are the first thing cut. And they make the deliberate debt the org takes on *visible* — recorded in the register with a payoff plan — so that today's prudent shortcut does not quietly become tomorrow's reckless compounding liability that nobody remembers choosing.

#### Common mistakes

- **No classification or measurement,** so debt is one guilty pile that always loses.
- **Spending paydown capacity on low-interest debt** because it is easy and feels productive.
- **Relying on debt sprints** that get cancelled whenever features are hot.
- **Arguing for debt work with feelings instead of numbers,** guaranteeing it loses to features.
- **Never deliberately carrying cheap debt,** wasting effort fixing things that did not need fixing.

#### Interview questions

1. **How do you decide which technical debt to pay down?**
   *Expected answer:* classify it, quantify each item's ongoing cost in real units (incidents/dollars, lead-time, toil hours), rank by "interest rate", and fund the highest-cost compounding items first while deliberately carrying cheap debt. *Follow-up:* give an example of debt you would deliberately NOT fix.

2. **Debt work always loses to features at your company. How do you change that?**
   *Expected answer:* stop arguing in the language of guilt and start measuring debt's cost, then frame paydown as ROI — "this debt costs X engineer-days/quarter, the fix costs Y, payback in Z". A number can compete with a feature's number; a feeling cannot. *Why it matters:* this is the core skill — making debt fundable.

3. **Why prefer a continuous 20% baseline over quarterly debt sprints?**
   *Expected answer:* the baseline is non-negotiable and continuous, so it survives hot-feature quarters and pays down debt steadily; debt sprints are lumpy and the easiest thing to cancel when features are urgent, so they often do not happen and debt accumulates between them. *Follow-up:* when might an explicitly-funded project beat both.

#### Practical exercise

Build a technical-debt register for a system you work on. List the five worst pieces of debt. For each: classify it (type), measure its cost per quarter in at least one real unit (incidents/dollars, extra lead-time days, or toil hours — measure, do not guess), estimate the fix, rate its "interest", and make an explicit decision (fund now / pay in baseline / carry / schedule before EOL). Make sure at least one item is a deliberate "carry" decision.

**Acceptance criteria:** every item has a measured (not guessed) cost in a real unit; the items are ranked by interest rate, not by how annoying they feel; at least one high-interest item has a defensible ROI argument (cost per quarter versus fix estimate); and you have deliberately chosen to carry at least one low-interest item rather than fix it.
