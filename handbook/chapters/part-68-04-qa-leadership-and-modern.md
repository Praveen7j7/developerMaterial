## 68.6 Interview Q&A for the new Parts (51-66)

This section provides interview questions and concise answers for the material in Parts 51 to 66, in the style of Part 45 (which covers Parts 1 to 50). Use them to self-test and to prepare. Each answer is the short version an interviewer wants to hear; the depth is in the referenced Part. This file covers the leadership/strategy and multi-tenant Parts (51 to 58); the next file covers the modern technical Parts (59 to 66).

### 68.6.1 Leadership and strategy (Parts 51-57)

**Q: Why is writing the architect's primary tool? (Part 51)** Because it is one-to-many, persistent and forces clarity: a written RFC or design doc reaches many people over time, survives the author, and the act of writing exposes gaps in thinking that a conversation hides. An architect's leverage comes from ideas that scale beyond a meeting, which writing provides.

**Q: What belongs in a strong design doc? (Part 51)** Context, goals and non-goals, requirements with numbers, the proposed design, alternatives considered honestly, tradeoffs, risks, rollout and rollback, observability, cost, and open questions. The honest alternatives and explicit non-goals are what distinguish a real design doc from a sales pitch for a decision already made.

**Q: What is a technical strategy, and what are its parts? (Part 52)** A diagnosis of the real problem, a guiding policy for addressing it, and a set of coherent actions that follow. Good strategy names the actual challenge and makes hard choices; bad strategy is a list of goals or wishes with no diagnosis or coherence.

**Q: How do you manage technical debt as a portfolio? (Part 52)** Classify it, quantify its cost (incident cost, lead-time drag, toil hours), and fund it deliberately (a standing percentage, debt sprints, or attaching debt paydown to related feature work), prioritizing the debt with the highest ongoing cost rather than treating all debt equally.

**Q: Why does heavy architecture governance fail, and what works instead? (Part 53)** Heavy governance (a board that must approve everything) becomes a bottleneck teams route around. What works is paved roads (golden-path templates and default libraries that make the right way the easy way), standards enforced automatically (fitness functions, policy as code), and lightweight review (office hours, guilds) rather than gatekeeping.

**Q: Why do large migrations fail, and how do you run one well? (Part 54)** They fail from the "80% done forever" problem — the last callers never migrate and the old system never dies. Run it as a program: scope, milestones, owners, a tracking dashboard, incremental strategy (strangler, parallel run), data migration with reconciliation, and a disciplined push to turn the old system off, including deprecation and brownouts for the last stragglers.

**Q: What is Conway's law and the inverse Conway maneuver? (Part 55)** Conway's law: systems mirror the communication structure of the organization that builds them. The inverse Conway maneuver: deliberately shape teams to produce the architecture you want (team boundaries become service boundaries), rather than letting an accidental org chart dictate a distributed monolith.

**Q: What is cognitive load as a design constraint? (Part 55)** A team can only hold so much in its head; service and team boundaries should be drawn so each team's cognitive load (the systems it must understand and operate) is manageable. Boundaries that overload a team cause poor operations and burnout; platform teams and good abstractions reduce the load.

**Q: How do you influence without authority? (Part 56)** Through credibility and trust, pre-wiring (socializing an idea with key people before the decision forum so you arrive with support), building coalitions, and making the case in writing with clear tradeoffs. You win by bringing people along, not by position power, which a staff/principal engineer rarely has.

**Q: How do you build a business case for a technical investment? (Part 56)** Translate technical risk into business terms: cost of delay, ROI, risk-reduction value, opportunity cost, with worked numbers. "Three payment outages cost us X in refunds and churn; a two-quarter reliability program costing Y prevents them" is a business case an executive can act on.

**Q: How do you grow a senior engineer into a staff engineer? (Part 57)** Give them stretch projects with real scope and ambiguity, delegate the interesting and visible work (not just the grind), coach rather than direct, and create opportunities for cross-team influence and technical leadership. Growth comes from increasing scope and autonomy with support, not from doing more of the same.

**Q: What makes a good interview rubric? (Part 57)** Specific, observable signals per dimension (not vague "seemed strong"), calibrated across interviewers, with concrete examples of what a weak, mixed and strong answer looks like, so feedback is evidence-based and bias is reduced. A rubric turns "I liked them" into assessable signal.

### 68.6.2 Multi-tenant SaaS (Part 58)

**Q: What are the multi-tenancy models and their tradeoffs? (Part 58)** Silo (a database/infrastructure per tenant — strong isolation, higher cost and ops), pool (shared infrastructure with a tenant_id — efficient, requires careful isolation), and bridge (a middle ground, e.g. shared database, schema per tenant). The choice trades isolation and per-tenant customization against cost and operational simplicity.

**Q: How do you enforce tenant isolation in PostgreSQL? (Part 58)** A tenant_id on every tenant-scoped table and in every query, ideally enforced by row-level security policies so a missing filter cannot leak data, plus connection/pool strategy per the model. The goal is that isolation is structural (enforced by the database), not dependent on every query remembering the filter.

**Q: How do you handle tenant context in NestJS? (Part 58)** Extract the tenant from the authenticated request, carry it via a request-scoped provider or AsyncLocalStorage so it is available throughout the request without threading it manually, and enforce it in guards and the data layer so every query is tenant-scoped.

**Q: How do you handle noisy neighbours? (Part 58)** Per-tenant rate limits and quotas, fair queuing so one tenant cannot starve others, and tenant-level isolation or sharding for the largest tenants, so one tenant's heavy usage does not degrade others' experience.

**Q: What does GDPR right-to-erasure require architecturally? (Part 58, Part 63)** That a deletion request removes the user's data from every store — the production database, the warehouse, the lake, derived tables, and per backup policy — not just the primary, propagated reliably (outbox/CDC). Deleting only from production is non-compliant because copies persist.

**Q: What enterprise B2B features commonly drive architecture? (Part 58)** SSO (SAML/OIDC), SCIM user provisioning, customer-readable audit logs, IP allowlists, data residency, and compliance controls (SOC 2, PCI scope reduction, HIPAA concepts). Each imposes design requirements — audit logging, regional tenancy, access controls — that must be built in, not bolted on.

### 68.6.3 How to use these answers

#### How a Senior Backend Engineer thinks about this

A senior uses these questions to self-test and to rehearse the concise, confident answer an interviewer wants — the short version that demonstrates understanding, with the depth ready if probed. For leadership and strategy questions (which dominate staff/principal loops), they anchor each answer in a concrete past example rather than reciting the concept, because the interviewer is assessing demonstrated judgment, not definitions. They prepare to go deeper on any of these (the referenced Part is the depth), and they connect the answers to real work they have done, because the strongest interview answers are concept plus lived example plus measurable outcome.

#### Practical exercise

Pick five questions from this file (mixing leadership, strategy and multi-tenant) and answer each aloud in under a minute, then for each attach a concrete example from your own experience. Acceptance criteria: each answer is concise and correct, and each has a real example you could expand on under probing.
