## 52.6 Build vs buy at scale, the tech radar, and saying no

#### Concept

Three connected skills that round out strategy. **Build vs buy at company scale** extends the Part 49.5 decision table into the territory that only matters at scale: vendor risk, lock-in, contract terms, and what happens when a vendor is acquired or raises prices. The **tech radar** is the living artifact that records where every technology sits (adopt, trial, assess, hold) and keeps those decisions honest and visible. And **saying no to technology** is the discipline — often the single most valuable thing a principal does — of choosing the boring option and refusing the exciting one when the exciting one does not earn its cost.

#### Why does it exist?

Imagine a company that buys a critical SaaS tool on a great price, makes it load-bearing, and signs a one-year contract with auto-renewal. Two years in, the vendor is acquired, the price triples at renewal, the new owner deprecates the feature the company depends on, and there is no realistic alternative because the data is locked in a proprietary format. The build-vs-buy decision looked right at the time because it only considered today's price and today's features, not vendor risk, lock-in, and contract terms — the things that only bite at scale and over time.

The tech radar exists because technology decisions made once and never revisited silently rot: a tool adopted three years ago may now be the wrong choice, but without a radar nobody re-examines it. And saying no exists because the default pressure in engineering is always toward more technology, and someone senior has to be willing to be the one who says the boring choice wins, or the stack accretes complexity until it collapses under its own weight.

#### Mental model

For build vs buy at scale, imagine renting versus buying a house, but the landlord can change the rent at any renewal, can decide to sell the house out from under you, and has the only key to the furniture you put inside. Renting (buying SaaS) is cheaper and faster to start and someone else fixes the roof — but you are exposed to the landlord's decisions, and if they lock your furniture in, you cannot leave. Building is the mortgage: more upfront, slower, but nobody can change the terms on you or lock you out. At scale, the landlord's power (vendor risk and lock-in) matters as much as the rent (the price).

For saying no, imagine a chef with a pantry. A great chef is defined as much by the ingredients they refuse to add as by the ones they use. A dish with every ingredient in the pantry is inedible. Saying no to technology is curating the pantry so the dish stays coherent.

#### How it works

**Build vs buy at scale** adds dimensions beyond the Part 49.5 table:

| Dimension | Buy (SaaS/vendor) | Build | Open source |
|---|---|---|---|
| Time to value | Fast | Slow | Medium |
| Ongoing cost | Predictable until renewal | Engineer time forever | Engineer time (you operate it) |
| Vendor risk | HIGH: acquisition, price hikes, deprecation, shutdown | None | Project can die; community can fork |
| Lock-in | Often severe (proprietary formats, APIs) | None | Low to medium |
| Contract terms | Negotiable at scale: SLAs, price caps, data egress, exit clauses | N/A | Licence terms (watch for relicensing) |
| Control | Low | Total | High |
| Differentiation | Use for non-differentiating needs | Build only your actual edge | Either |

The governing rule: **buy or adopt open source for what does not differentiate you; build only what is your actual competitive edge.** You do not build your own email provider; you do build the pricing engine that is your business. And at scale, negotiate the contract terms that de-risk the buy decision: price caps on renewal, data-export rights (reducing lock-in), SLAs with teeth, and exit clauses.

**The tech radar** is a quadrant chart (or just a table) placing each technology in a ring:

```text
ADOPT   -> proven here; default choice for its problem
TRIAL   -> worth pursuing on a real low-risk project; not yet default
ASSESS  -> worth exploring; one person, no commitment
HOLD    -> stop new use; existing use being wound down or frozen
```

Keeping it honest means: everything is dated and owned, "hold" is used (a radar with no holds is a radar nobody is willing to retire anything on), and it is reviewed on a cadence so adopt-ring entries that have gone stale get demoted.

**Saying no** is a repeatable move: ask "what measured problem does this solve", "what does it cost over three years including exit", and "what is the boring alternative and why is it not enough". If the exciting technology cannot beat the boring one on a real problem, the answer is no, and you say it clearly, with the reasoning, so it does not get re-asked.

#### Practical example

A ride-booking company needs a feature-flag system. Build vs buy at scale: feature flags do not differentiate them (every company has them; customers do not choose them for their flag system), so the default is buy or open source, not build. Buying a SaaS flag product is fast but introduces vendor risk (every request checks flags; a vendor outage is their outage) and lock-in. They negotiate: an SLA with credits, a self-hosted relay so a vendor outage degrades gracefully, and data-export rights. An open-source flag system avoids vendor risk but costs operational effort. They choose the SaaS with the negotiated terms, because the operational cost of self-hosting exceeds the managed vendor risk once the risk is contracted down. The key move is that they did not build (it is not their edge) and did not buy naively (they negotiated the terms that de-risk the buy at scale).

#### Artifact example

A tech radar snapshot plus a "saying no" decision record — two artifacts that keep the stack honest.

```markdown
# Tech Radar — Backend (reviewed 2026-Q2, owner: principal eng)

## Data stores
- ADOPT: PostgreSQL 17 (default for all transactional data)
- ADOPT: Redis (caching, rate limits, sorted sets)
- TRIAL: pgvector (RAG search POC, 1 team, exit defined)
- ASSESS: ClickHouse (for analytics; assessing vs warehouse)
- HOLD: MongoDB (2 legacy services; no new use; migrating to PG)

## Messaging
- ADOPT: RabbitMQ + Postgres outbox (current default)
- ASSESS: Kafka (would adopt IF multi-consumer streaming need materialises)

## Explicitly rejected this quarter (the "no" log)
- NewBroker: solves throughput we don't have (RabbitMQ at 8%). REJECTED.
- Service mesh: our incidents aren't mesh-shaped. REJECTED (see reliability strategy).
- GraphQL for internal services: one client, no diversity problem. REJECTED (Part 49.3).

---

# Decision: we will NOT adopt Kafka yet (saying no)
**Proposal:** adopt Kafka as our event backbone.
**Measured problem it would solve:** multi-consumer event streaming. We
have ONE consumer today (notifications); RabbitMQ + outbox serves it.
**3-yr cost of adopting now:** a cluster to operate (+~0.5 eng), training,
migration of the outbox relay. Exit cost: medium.
**Boring alternative:** keep RabbitMQ + outbox. It meets today's need.
**Decision:** HOLD on Kafka at ASSESS. Adopt IF/WHEN a second and third
consumer materialise (platform roadmap suggests ~1 year). Falsifiable
trigger: 3+ independent consumers of order events planned. Until then, no.
```

The radar makes every position visible and dated, uses HOLD honestly (MongoDB is being retired), and keeps a "no" log so rejected technologies do not keep coming back. The Kafka decision is a model "no": it names the measured problem, admits the boring alternative suffices, and sets a falsifiable trigger for revisiting — so it is a disciplined "not yet", not a dogmatic "never".

#### Real-world scenario

A principal engineer is known in her org as the person who says no to technology, and she wears it as a compliment. Her value is not that she blocks things; it is that her "no" is always reasoned, falsifiable, and recorded, so it sticks and reduces thrash. When a team proposes the fashionable thing, they know she will ask "what measured problem, what three-year cost, why is the boring option not enough", so they either come prepared with real answers (and she says yes) or they realise themselves that the answer is no. Over three years, her discipline keeps the stack small enough that the org can actually operate it — a stack of six well-understood technologies instead of twenty half-understood ones. The things she said no to were individually plausible; saying no to all of them was what kept the system comprehensible.

#### Failure scenario

A company buys a critical analytics SaaS on an attractive two-year deal with no exit clause, no price cap, and data stored in the vendor's proprietary format with export available only through a slow, rate-limited API. It becomes load-bearing: dashboards, alerts and a customer-facing feature all depend on it. At renewal, the vendor — now acquired — quadruples the price and makes the new price conditional on a three-year commitment. The company has no leverage: migrating off would take six months because of the proprietary format and the painful export, and losing the tool would break a customer feature. They pay the 4x. The build-vs-buy decision was made on price and features alone; vendor risk, lock-in and contract terms were never evaluated, and at scale those are exactly the dimensions that determine whether a buy decision is a bargain or a trap.

#### Edge cases & failure modes

- **Building what does not differentiate you.** Writing your own email provider or auth system, burning engineering on a solved problem that is not your edge.
- **Buying naively at scale.** No price cap, no exit clause, no data-export rights, proprietary lock-in — turning a cheap buy into an inescapable trap.
- **A radar with no "hold" ring.** Nobody is willing to retire anything, so the stack only grows.
- **A radar nobody reviews.** Adopt-ring entries go stale; the radar describes the past, not the present.
- **Saying no dogmatically.** "Never Kafka" instead of "not until 3+ consumers"; a reasoned, falsifiable no is durable, a dogmatic one is brittle and gets overridden.
- **No "no" log.** Rejected technologies keep coming back every quarter because the reasoning was never recorded.

#### How a Principal Engineer thinks about this

They apply the differentiation rule rigorously: build only the thing that is the company's actual edge, buy or adopt open source for everything else, because engineering capacity spent re-solving solved problems is capacity stolen from the thing only you can build. At scale they treat the *contract* as part of the architecture — price caps, exit clauses and data-export rights are reliability features, because they determine whether you can leave a vendor who turns hostile.

They treat saying no as a core, high-value activity rather than an obstruction, and they make every no reasoned, falsifiable and recorded, because a no with a trigger ("adopt when X is true") is a disciplined decision that sticks, while a dogmatic no is brittle and a silent no gets re-asked forever. And they keep the radar honest by using the hold ring and reviewing on a cadence, because a stack that only grows eventually exceeds the org's ability to operate it.

#### Common mistakes

- **Building non-differentiating technology** instead of buying or adopting open source.
- **Buying without negotiating the terms that de-risk it** (caps, exit, export) at scale.
- **Treating the radar as a one-time artifact** instead of a reviewed, dated, owned living document.
- **Saying no dogmatically** instead of with a falsifiable trigger, so the no gets overridden.
- **Not recording the no,** so rejected ideas return every planning cycle.

#### Interview questions

1. **How does build vs buy change at company scale compared to for a small team?**
   *Expected answer:* at scale, vendor risk (acquisition, price hikes, deprecation), lock-in (proprietary formats), and contract terms (caps, exit clauses, data export) dominate, alongside the rule to build only what differentiates you. A cheap buy with no exit clause can become an inescapable trap. *Follow-up:* what contract terms would you insist on for a load-bearing SaaS.

2. **What makes a good "no" to a proposed technology?**
   *Expected answer:* it names the measured problem the technology would solve, shows the boring alternative suffices, states the three-year cost including exit, and — crucially — sets a falsifiable trigger for revisiting, so it is a disciplined "not yet" rather than a dogmatic "never", and it is recorded so it does not get re-asked. *Why it matters:* saying no well is a principal's highest-leverage habit.

3. **Why keep a tech radar, and what makes one honest?**
   *Expected answer:* it records where every technology sits (adopt/trial/assess/hold) so decisions stay visible and get revisited; it is honest when it uses the hold ring (willing to retire things), dates and owns entries, keeps a "no" log, and is reviewed on a cadence so stale adopt entries get demoted. *Follow-up:* what does an empty hold ring tell you.

#### Practical exercise

Build a one-page tech radar for your team's backend stack: place every significant technology in adopt, trial, assess or hold, with a date and owner, and make sure the hold ring is not empty. Then write one "saying no" decision record for a technology you are choosing not to adopt: name the measured problem it would solve, the boring alternative, the three-year cost, and a falsifiable trigger for revisiting.

**Acceptance criteria:** your radar uses all four rings (including at least one honest hold), every entry is dated; and your "no" record is falsifiable — it states a specific condition under which the answer would become yes, rather than rejecting the technology forever.
