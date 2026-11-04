## 55.3 Cognitive load and service ownership

#### Concept

Two linked ideas that determine whether teams can actually operate what they own. **Cognitive load** is the total amount of stuff a team has to hold in their heads to do their job — the systems they own, the domains they must understand, the tools they must operate. It is a finite resource, and a team loaded past its limit gets slow, error-prone, and burned out. Cognitive load should be an explicit *design constraint* for team and service boundaries: a team should own no more than it can comfortably hold. **Service ownership** is who is accountable for a service in production — the "you build it, you run it" model, ownership catalogs that make ownership explicit, and the problem of orphaned services that nobody owns.

#### Why does it exist?

Imagine a team that owns twelve services spanning four unrelated domains, built in three different languages, with four different databases. No individual on the team can hold all of it in their head. When an incident hits one of the twelve services, the person on call may never have touched it. Changes are slow because every change requires relearning a corner of the sprawl. The team is not incompetent; they are overloaded past the limit of what a team can cognitively hold, and the symptoms — slowness, incidents, burnout — are the predictable result of ignoring cognitive load as a constraint.

Cognitive load exists as an explicit concept because org designers routinely overload teams without noticing, treating team capacity as if it were only about person-hours when the real limit is often how much the team can *understand*. Service ownership exists because a service that nobody clearly owns gets no maintenance, no on-call, and no improvement — it rots until it causes an incident, at which point everyone discovers it was orphaned.

#### Mental model

Imagine a juggler. They can keep a certain number of balls in the air — say five. Give them a sixth and seventh and they do not juggle seven slightly worse; they drop everything, because they are past their cognitive limit and the whole pattern collapses. A team is a juggler, and the services and domains it owns are the balls. Loading a team past its cognitive limit does not make it a bit slower; it collapses the whole team's effectiveness, because attention and understanding are not infinitely divisible. Good org design keeps each team's ball count within what it can juggle, and when a team is dropping balls, the fix is fewer balls (less scope), not telling them to juggle harder.

#### How it works

**Cognitive load as a design constraint.** Three kinds of cognitive load (from the Team Topologies framing, originally cognitive-science):

- **Intrinsic:** the inherent difficulty of the domain and the skills (understanding distributed systems, the payment domain). Reduce by training and hiring, not by org design.
- **Extraneous:** the accidental overhead — clunky deploys, bad tooling, having to understand the infrastructure to ship a feature. Reduce by the platform/paved road (Part 53, 55.5), which removes this load from stream-aligned teams.
- **Germane:** the valuable thinking about the actual problem. You want teams spending their cognitive budget here.

The design move: size a team's ownership so that intrinsic load (the domain) fits, remove extraneous load (via the platform), and leave room for germane load (the real work). A team should own a coherent domain of a size it can hold — typically one bounded context, not twelve unrelated services.

```text
Team cognitive budget (finite)
  = intrinsic (the domain — keep it coherent and bounded)
  + extraneous (accidental overhead — REMOVE via platform/paved road)
  + germane (the real problem-solving — PROTECT this)
Overload one team's budget -> slow, error-prone, burned out (drops all balls)
```

**Service ownership models:**

- **You build it, you run it.** The team that builds a service also operates it in production — owns its on-call, its alerts, its runbooks, its reliability. This aligns incentives: the people who feel the 3 a.m. page are the people who can fix the design that caused it. The default model for stream-aligned teams.
- **Ownership catalog.** A single source of truth (a service registry / catalog like Backstage) recording, for every service: who owns it, its on-call, its dependencies, its runbooks, its tier. Makes ownership explicit and findable, so an incident on any service immediately routes to its owner.
- **Orphaned services.** Services that no team clearly owns — because the team was disbanded, because it was built by someone who left, because it fell between team boundaries. Orphans get no maintenance and no on-call, and they are time bombs: they rot until they cause an incident that nobody is prepared for. An ownership catalog's main job is to make orphans *visible* so they can be assigned or retired before they explode.

#### Practical example

A team is drowning: it owns eight services across three unrelated domains (ordering, a legacy reporting system, and an internal admin tool), inherited through years of reorgs. Incidents are frequent and slow to resolve because on-call engineers face services they barely know. A principal engineer diagnoses it as a cognitive-load problem, not a staffing one, and acts: the legacy reporting system (a distinct domain) is moved to a team that owns reporting, the internal admin tool is deprecated (its value no longer justifies the cognitive load it imposes), and the team is left owning the four ordering services that form one coherent domain. Extraneous load is further reduced by moving the team onto the paved road so they no longer hand-roll deploys and observability. The team's effectiveness recovers not because they work harder but because their ball count dropped to what they can juggle. The fix for an overloaded team is less scope, delivered by moving ownership elsewhere and removing accidental overhead, not by exhortation.

#### Artifact example

A service ownership catalog entry and a team cognitive-load assessment — the artifacts that make ownership explicit and overload visible.

```markdown
# Service catalog entry (one per service, in Backstage/registry)
service: orders-api
owner_team: ordering
on_call: ordering-oncall (PagerDuty)
tier: 1 (customer-facing, revenue-critical)
runbook: link
dependencies: payments-api, inventory-api, order.events (Kafka)
dependents: checkout-web, mobile-bff, admin-panel
data_owned: orders, order_items, order_status_history
last_reviewed: 2026-10
status: healthy
# An ORPHAN would show owner_team: NONE -> flagged for assignment/retirement

---

# Team cognitive-load assessment: ordering team
## Owns
- orders-api, order-events-consumer, checkout-bff, refunds-service (4 services,
  ONE coherent domain — ordering). FITS.
## Load breakdown
- Intrinsic: ordering + payments-adjacent domain. Reasonable for the team's skills.
- Extraneous: LOW — on the paved road, deploys/observability self-service.
- Germane: healthy — team spends most of its time on actual ordering problems.
## Verdict: within capacity. Trend: stable.
## Contrast (before the fix 2 quarters ago):
- Owned 8 services across 3 domains (ordering + legacy reporting + admin tool).
  OVERLOADED. Reporting moved out, admin tool deprecated. Now within capacity.
```

The catalog entry makes ownership, on-call, dependencies, and data ownership explicit and findable — so an incident routes instantly to the owner and an orphan (owner: NONE) is immediately visible. The cognitive-load assessment treats a team's scope as a budget to be managed, breaks load into intrinsic/extraneous/germane, and shows the before/after of fixing an overload by reducing scope. Together they turn ownership and cognitive load from invisible, accidental properties into deliberately-managed design constraints.

#### Real-world scenario

A company adopts a service catalog (Backstage) and, for the first time, has a complete, queryable record of every service and its owner. The first query they run — "show all services with no owner" — returns a shocking list of forty orphaned services, built over years by people who had left or teams that had been reorganised away. Some of these orphans are tier-1, customer-facing services that had been running with no on-call and no maintenance, surviving only because they happened not to break. The company systematically assigns each orphan to a team or schedules it for retirement. Three months later, one of the previously-orphaned tier-1 services has an incident — but now it has an owner, an on-call rotation, and a runbook, so it is resolved in twenty minutes instead of being a prolonged scramble to figure out who even owns the thing. The catalog's main value was not the tidy records; it was making the forty invisible time bombs visible so they could be defused before they exploded. Orphaned services are the silent risk in every grown organisation, and an ownership catalog is how you find them.

#### Failure scenario

A reorg redistributes services among teams based purely on person-count balancing — "this team has capacity, give them these three services" — with no consideration of domain coherence or cognitive load. A team that owns ordering is handed three unrelated services (a notifications service, a legacy import tool, and a fraud-detection component) because they "had room". Each is a different domain requiring different knowledge. The team's cognitive load spikes: they now must understand four unrelated domains, their on-call rotation covers systems half of them have never seen, and their velocity on their actual domain (ordering) collapses because their attention is fragmented across four things. Incidents on the handed-over services are slow and scary because nobody on the team really understands them. The reorg optimised for person-hour balance and ignored cognitive load, treating teams as interchangeable capacity rather than as juggler with a finite ball count. The result is a team that is nominally "balanced" but actually overloaded past its cognitive limit, dropping balls across all four domains. Distributing services by headcount instead of by cognitive load and domain coherence is one of the most common and most damaging reorg mistakes.

#### Edge cases & failure modes

- **Distributing services by headcount, ignoring cognitive load.** A "balanced" team that is actually overloaded across incoherent domains.
- **Overloading a team past its cognitive limit.** Does not make it a bit slower; collapses its effectiveness across everything (the juggler dropping all balls).
- **Orphaned services.** No owner, no on-call, no maintenance; time bombs that rot until they cause an unprepared incident.
- **Ownership that exists on paper but not in practice.** A team "owns" a service they never touch and could not operate; functionally an orphan.
- **Not removing extraneous load.** Teams spending cognitive budget on clunky deploys and infrastructure instead of the real problem, because there is no platform.
- **Confusing cognitive load with workload.** Adding people to an overloaded team does not help if the problem is too many unrelated domains, not too few hands.

#### How a Principal Engineer thinks about this

They treat cognitive load as a first-class, finite design constraint, sizing each team's ownership to a coherent domain it can actually hold rather than distributing services by headcount as if teams were interchangeable capacity. When a team is struggling, they diagnose cognitive overload before assuming a staffing or skill problem, because they know that a team juggling too many unrelated domains collapses across all of them, and the fix is fewer balls (less, more coherent scope) plus removing extraneous load via the platform — not exhortation or more people.

They insist on explicit service ownership with a catalog, because they have learned that orphaned services are the silent time bombs of every grown organisation, and that the only way to defuse them is to make them visible and assign or retire them before they cause an unprepared incident. They hold the "you build it, you run it" model as the default, because aligning the people who feel the page with the people who can fix the design is what produces reliable services. The principal designs teams around what humans can understand and operate, treating cognitive load with the same seriousness they treat latency budgets — as a hard constraint that, when violated, degrades everything.

#### Common mistakes

- **Distributing services by headcount** rather than by domain coherence and cognitive load.
- **Overloading a team** and expecting a proportional slowdown instead of a collapse.
- **Leaving services orphaned,** so they rot until they cause an unprepared incident.
- **Not removing extraneous load** via a platform, so teams waste cognitive budget on accidental overhead.
- **Adding people to fix cognitive overload** when the problem is too many unrelated domains, not too few hands.

#### Interview questions

1. **What is cognitive load and why should it constrain team and service boundaries?**
   *Expected answer:* the total amount a team must hold in their heads to do their job — domains, systems, tools; it is finite, and a team loaded past its limit collapses (slow, error-prone, burned out) rather than degrading gracefully. So a team should own a coherent, bounded domain it can actually hold, and the platform should remove extraneous load. *Follow-up:* how would you reduce an overloaded team's cognitive load.

2. **A reorg distributed services to teams by headcount balance. What's the risk?**
   *Expected answer:* teams get handed unrelated services across incoherent domains, spiking cognitive load; a nominally "balanced" team is actually overloaded, its on-call covers systems nobody understands, and its velocity on its real domain collapses. Distribute by domain coherence and cognitive load, not headcount. *Why it matters:* this is a common, damaging reorg mistake.

3. **Why are orphaned services dangerous, and how do you handle them?**
   *Expected answer:* they have no owner, on-call, or maintenance, so they rot and become time bombs that cause unprepared incidents; handle them with an ownership catalog that makes every service's owner explicit and findable, run a "services with no owner" query to surface orphans, and assign or retire each one. *Why it matters:* tests awareness of the silent risk in grown organisations.

#### Practical exercise

Assess one team's cognitive load. List everything it owns (services, domains, tools) and classify the load as intrinsic, extraneous, or germane. Judge whether the ownership is a coherent domain the team can hold, or a sprawl across unrelated domains. Then audit your org for orphaned services: is there a catalog, and if you queried for services with no clear owner, how many would you find.

**Acceptance criteria:** you can state whether the team's scope is a coherent domain within its cognitive capacity or an overloaded sprawl, and if overloaded, what you would move out or deprecate to bring it within capacity (plus what extraneous load the platform could remove); and you can identify whether your org has an ownership catalog and estimate how many orphaned services it would reveal.
