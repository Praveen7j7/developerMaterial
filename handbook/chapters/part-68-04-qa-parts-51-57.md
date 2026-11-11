## 68.6 Interview Q&A for the new Parts (51-66)

This section provides interview questions and concise answers for the material in Parts 16, 26, 37–39, 52, 65, 66 and 81–88, in the style of Part 59 (which covers Parts 8–15, 17–25, 27–36, 40–51 and 54–64). Use them to self-test and to prepare. Each answer is the short version an interviewer wants to hear, followed by the follow-ups they are likely to ask next; the depth is in the referenced Part. This file covers the leadership and strategy Parts (51 to 57); the next file covers multi-tenant SaaS (58) and the modern technical Parts (59 to 64), and the one after that the system-design Parts (65 and 66).

The format is condensed from Part 59's four blocks (expected answer, why it matters, follow-ups, senior signal) to two: the answer, which carries the senior signal in its last sentence, and the follow-ups. Practise answering each one aloud in under a minute before reading the answer.

### 68.6.1 Leadership and strategy (Parts 81–87)

#### Part 81 — Writing as an Architect

**Q: Why is writing the architect's primary tool? (Part 81)** Because it is one-to-many, persistent and forces clarity: a written RFC or design doc reaches many people over time, survives the author, and the act of writing exposes gaps in thinking that a conversation hides. An architect's leverage comes from ideas that scale beyond a meeting, which writing provides. *Follow-ups:* When is a meeting better than a document? How do you keep documents from rotting?

**Q: What belongs in a strong design doc? (Part 81)** Context, goals and non-goals, requirements with numbers, the proposed design, alternatives considered honestly, tradeoffs, risks, rollout and rollback, observability, cost, and open questions. The honest alternatives and explicit non-goals are what distinguish a real design doc from a sales pitch for a decision already made. *Follow-ups:* Which section do you write first? How long should it be?

**Q: How do you choose between a one-pager, an ADR, a design doc and an RFC? (Part 81)** Match the document to the decision's size and reversibility: a one-pager for small reversible choices, an ADR to record one durable decision, a design doc to work out how something will be built, an RFC when several teams must agree, a strategy memo for direction. Over-documenting small decisions slows teams; under-documenting durable ones loses the why. *Follow-ups:* Who approves an RFC? When does a design doc become an RFC?

**Q: Which design-doc sections get skipped most, and why do they matter? (Part 81)** Non-goals, rollback and observability. Non-goals stop scope wars before they start, rollback is what the on-call engineer needs at 2am when the rollout goes wrong, and observability is how you will know whether the goals were met. They are skipped because they are not fun to write, which is exactly why reviewers look for them first. *Follow-ups:* What does a good rollback section contain? How do you write a non-goal without sounding negative?

**Q: Why must every goal have a number? (Part 81)** "Make checkout faster" cannot be checked; "checkout p99 under 300 ms at twice last year's peak" can. Numbers make success observable, drive design decisions (they decide whether you need a cache at all), and settle scope arguments. If you do not know the right number yet, state a hypothesis and how you will measure it. *Follow-ups:* Where do the numbers come from? What if the business will not commit to one?

**Q: How do you run an RFC so it actually reaches a decision? (Part 81)** Pre-wire the key reviewers one-on-one before opening it, collect comments asynchronously with a deadline, resolve every comment visibly (accepted, rejected with a reason, deferred), name the decider, and force a decision date. An RFC without a date drifts for months and the loudest late commenter wins. *Follow-ups:* What do you do when a reviewer blocks at the last minute? How do you handle 80 comments?

**Q: Why are ADRs immutable? (Part 81)** An ADR records what was decided and why, at that time, with the information then available. Editing it in place erases that history. When the decision changes, write a new ADR that supersedes the old one, so the chain explains how the system got to where it is. *Follow-ups:* Where should ADRs live? How does a new engineer find the current decision?

#### Part 82 — Technical Strategy, Vision and Roadmaps

**Q: What is a technical strategy, and what are its parts? (Part 82)** A diagnosis of the real problem, a guiding policy for addressing it, and a set of coherent actions that follow. Good strategy names the actual challenge and makes hard choices; bad strategy is a list of goals or wishes with no diagnosis or coherence. *Follow-ups:* Give an example of a guiding policy that refuses something. How do you test a diagnosis?

**Q: How do vision, strategy, roadmap and plan differ? (Part 82)** A vision says where we want to be, measurably and tied to business numbers. A strategy explains how we will get there and what we refuse. A roadmap sequences the actions over quarters. A plan says who does what this quarter. Conflating them produces documents that do none of their jobs, which is why most "strategies" are roadmaps with the reasoning removed. *Follow-ups:* Which one would you write first for a new area? Who owns each?

**Q: How do you manage technical debt as a portfolio? (Part 82)** Classify it, quantify its cost (incident cost, lead-time drag, toil hours), and fund it deliberately (a standing percentage, debt sprints, or attaching debt paydown to related feature work), prioritizing the debt with the highest ongoing cost rather than treating all debt equally. *Follow-ups:* How do you measure lead-time drag? What percentage of capacity would you reserve?

**Q: Why would you deliberately leave some technical debt unpaid? (Part 82)** Debt should be paid down by interest rate. An ugly module nobody touches costs almost nothing each month; a flaky deploy pipeline every team hits weekly costs hours per engineer. Paying the cheap debt spends capacity the expensive debt needs, so a senior carries cheap debt on purpose and says so. *Follow-ups:* How do you explain that to an engineer who wants to rewrite the ugly module? What turns cheap debt expensive?

**Q: How do you sequence a roadmap? (Part 82)** By dependency and risk: respect prerequisites, front-load the risks that could kill the plan, schedule an early visible win to earn trust, size to effective capacity (often 60 to 70 percent of nominal once on-call and support are counted), and make deferrals explicit with reasons so they stop being re-asked. *Follow-ups:* What is your early win in a platform migration? How do you handle a date set before the plan?

**Q: How do you evaluate a new technology? (Part 82)** On weighted criteria dominated by fit and exit cost, with a proof of concept designed to kill the candidate rather than to show it off, a three-year total cost of ownership that includes operations, training and migration, and adoption in stages. A single impressive benchmark is not evidence. *Follow-ups:* What did your last POC try to break? How do you estimate exit cost?

**Q: How do you say no to a technology a team is excited about? (Part 82)** Make the no reasoned, falsifiable and recorded: the criteria it failed, the evidence that would change the answer, written as an ADR so it is not re-litigated every quarter. A no with a path to yes keeps the team's trust; a bare no gets routed around. *Follow-ups:* When did you reverse a no? What if a director wants it anyway?

#### Part 83 — Architecture Governance, Standards and Paved Roads

**Q: Why does heavy architecture governance fail, and what works instead? (Part 83)** Heavy governance (a board that must approve everything) becomes a bottleneck teams route around. What works is paved roads (golden-path templates and default libraries that make the right way the easy way), standards enforced automatically (fitness functions, policy as code), and lightweight review (office hours, guilds) rather than gatekeeping. *Follow-ups:* Which decisions still need a human review? How do you retire an architecture board?

**Q: What makes a paved road succeed? (Part 83)** It is opinionated, complete for the common case (service template, CI pipeline, observability, auth, deployment), and owned and maintained as a product with its own roadmap. It wins on convenience, not mandate. An unmaintained paved road is worse than none, because it spreads outdated dependencies to every new service. *Follow-ups:* How do you measure adoption? What happens to services that leave the road?

**Q: What is an architecture fitness function? (Part 83)** An automated check of an architectural property that runs continuously: no service queries the payments schema directly, a dependency-direction lint rule, a p99 budget under a load test. It must test realistic conditions, be stable enough that nobody mutes it, and have an owner, or it enforces an illusion. *Follow-ups:* Give one you have written. What do you do when a fitness function is flaky?

**Q: What is the shared-library trap? (Part 83)** A reflexively shared, ownerless, unversioned library that every service imports; any change forces lockstep upgrades and one bug ships everywhere at once. Share deliberately: small surface, semantic versioning, a named owner, and accept duplication of small things. *Follow-ups:* When is a shared library the right call? How do you unwind one?

**Q: How should a waiver process work? (Part 83)** Explicit, time-boxed with an expiry date, reviewed, and revisited. Without an escape hatch, teams route around governance entirely; without expiry, waivers quietly become the real standard. *Follow-ups:* Who approves waivers? What happens at expiry?

**Q: How do you measure standards compliance without turning it into a stick? (Part 83)** Scorecards addressed to the owning team, trends over time, and help offered alongside the gap. Public leaderboards and penalties get gamed, and the metric stops measuring reality. *Follow-ups:* What do you put on a service scorecard? How do you handle a team that stays red?

#### Part 84 — Large-Scale Migrations and Legacy Modernization

**Q: Why do large migrations fail, and how do you run one well? (Part 84)** They fail from the "80% done forever" problem — the last callers never migrate and the old system never dies. Run it as a program: scope, milestones, owners, a tracking dashboard, incremental strategy (strangler, parallel run), data migration with reconciliation, and a disciplined push to turn the old system off, including deprecation and brownouts for the last stragglers. *Follow-ups:* What goes on the dashboard? Who owns the last 20 percent?

**Q: How do you choose a migration strategy? (Part 84)** Per component, by blast radius and reversibility: big bang only for low-risk reversible pieces, strangler for live traffic, parallel run for correctness-critical paths such as billing, branch-by-abstraction for shared internals. Most real migrations mix all four. *Follow-ups:* When is big bang actually right? How long do you parallel-run?

**Q: How do you migrate data without losing any? (Part 84)** A batched, idempotent backfill, CDC for changes made during the backfill, and reconciliation that compares values (checksums, sums of amounts per day) and not only row counts. Cut over only after reconciliation has been clean for an agreed period. Dual writes are the trap: they diverge silently on partial failure. *Follow-ups:* What do you do when reconciliation finds a mismatch? How do you throttle the backfill?

**Q: Why is decomposing a monolith a data problem rather than a code problem? (Part 84)** Code can be split in an afternoon; tables shared by five modules cannot. Each new service must own its data, with other services going through its API. A "temporary" shared-database phase that never ends produces a distributed monolith, worse than the original. *Follow-ups:* How do you split a table two services write to? What about reporting queries that join everything?

**Q: How do you actually turn the old system off? (Part 84)** Instrument usage from day one to find the real callers, send deprecation notices, run escalating brownouts (planned short outages) to flush out stragglers, escalate orphaned callers to their owners' management, and schedule the deletion date early. Done means the code is deleted, not that the endpoint returns 410. *Follow-ups:* How long is a brownout? What if the last caller is a critical partner?

**Q: What is a kill switch in a migration? (Part 84)** A flag that sends traffic back to the old path instantly, plus a rollback point for every step. Ramp gradually (1, 5, 25, 100 percent; per tenant or region) and never take a step you cannot undo. *Follow-ups:* What cannot be rolled back? How do you roll back after writes went to the new store?

#### Part 85 — Org Design, Conway's Law and Platform Engineering

**Q: What is Conway's law and the inverse Conway maneuver? (Part 85)** Conway's law: systems mirror the communication structure of the organization that builds them. The inverse Conway maneuver: deliberately shape teams to produce the architecture you want (team boundaries become service boundaries), rather than letting an accidental org chart dictate a distributed monolith. *Follow-ups:* Give an example from your work. What happens when you split services but not teams?

**Q: What is cognitive load as a design constraint? (Part 85)** A team can only hold so much in its head; service and team boundaries should be drawn so each team's cognitive load (the systems it must understand and operate) is manageable. Boundaries that overload a team cause poor operations and burnout; platform teams and good abstractions reduce the load. *Follow-ups:* How do you notice overload? How many services should one team own?

**Q: What are the Team Topologies team types and interaction modes? (Part 85)** Four types: stream-aligned (owns a slice of the product end to end), platform, enabling (coaches other teams for a period) and complicated-subsystem (deep specialists). Three interactions: collaboration (time-boxed), X-as-a-service and facilitating. Default to stream-aligned teams consuming platforms as a service. *Follow-ups:* When is collaboration the right mode? What does an enabling team leave behind?

**Q: How do you run a platform team? (Part 85)** As a product, with stream-aligned teams as customers, measured on their success (lead time, adoption, satisfaction), starting with the thinnest viable platform and making self-service the defining property. A platform pushed by mandate rather than value breeds shadow platforms. *Follow-ups:* How do you decide what the platform builds next? Should adoption be mandatory?

**Q: How do you measure developer experience without harming people? (Part 85)** DORA metrics (deployment frequency, lead time for changes, change failure rate, time to restore), SPACE dimensions, a breakdown of where lead time is spent, and regular surveys — all at team or system level to find friction. The moment metrics are used to rank individuals, people game them and stop telling the truth. *Follow-ups:* Which DORA metric moves first after a platform investment? How do you act on survey results?

**Q: What is a distributed monolith, and how does org design cause it? (Part 85)** Services that cannot be deployed independently because they share data, schemas or release trains. It appears when services are split but teams and data ownership are not. The fix is to align each service with one team and give it its own data. *Follow-ups:* How do you detect one from deploy data? What is the first thing you would change?

#### Part 86 — Influence, Communication and the Business Case

**Q: How do you influence without authority? (Part 86)** Through credibility and trust, pre-wiring (socializing an idea with key people before the decision forum so you arrive with support), building coalitions, and making the case in writing with clear tradeoffs. You win by bringing people along, not by position power, which a staff/principal engineer rarely has. *Follow-ups:* Tell me about a time pre-wiring changed an outcome. What if the decider will not meet you?

**Q: How do you build a business case for a technical investment? (Part 86)** Translate technical risk into business terms: cost of delay, ROI, risk-reduction value, opportunity cost, with worked numbers. "Three payment outages cost us X in refunds and churn; a two-quarter reliability program costing Y prevents them" is a business case an executive can act on. *Follow-ups:* How do you estimate churn cost? What is a sensitivity analysis for?

**Q: How do you present a technical risk to an executive? (Part 86)** Bottom line up front, on one page, with the risk in business language: likelihood, impact in money or customers, the ask and the decision needed. "A checkout outage during the sale would cost about $1.2M; there is a real chance this quarter; four engineer-weeks remove most of it." A worse case in business language beats a better case in engineering language. *Follow-ups:* What do you cut from the technical detail? How do you handle "just make it not happen"?

**Q: What is an options paper and why use one? (Part 86)** Two or three real options with visible tradeoffs and a clear recommendation. It respects the decider's judgement and shows you considered alternatives; a single preordained answer invites suspicion, and a menu of ten invites paralysis. *Follow-ups:* What if they pick the option you did not recommend? How do you avoid a strawman option?

**Q: How do you disagree well with another senior engineer? (Part 86)** Disagree on the problem, not the person; first understand the constraint behind their view; pick your battles; escalate openly and together when stuck; and once a decision is made, commit fully. *Follow-ups:* Tell me about a disagreement you lost. When do you escalate?

**Q: How do you say no to a product request? (Part 86)** With alternatives, and by naming which of scope, time or quality moves: "We can ship search by the 15th without filters, or with filters two weeks later; cutting tests is not an option." It keeps the conversation on tradeoffs instead of willingness, and protects the team from thrash. *Follow-ups:* What if the date is fixed by a contract? How do you say no to your own manager?

#### Part 87 — Growing Engineers: Mentoring, Hiring and Technical Interviewing

**Q: How do you grow a senior engineer into a staff engineer? (Part 87)** Give them stretch projects with real scope and ambiguity, delegate the interesting and visible work (not just the grind), coach rather than direct, and create opportunities for cross-team influence and technical leadership. Growth comes from increasing scope and autonomy with support, not from doing more of the same. *Follow-ups:* What did you give away that you wanted to keep? How do you know they are ready?

**Q: What makes a good interview rubric? (Part 87)** Specific, observable signals per dimension (not vague "seemed strong"), calibrated across interviewers, with concrete examples of what a weak, mixed and strong answer looks like, so feedback is evidence-based and bias is reduced. A rubric turns "I liked them" into assessable signal. *Follow-ups:* Write one rubric line for system design. How do you keep a rubric current?

**Q: How do mentoring, coaching and sponsorship differ? (Part 87)** Mentoring gives advice from your experience; coaching asks questions that build the other person's judgement; sponsorship spends your own capital to create opportunities, such as recommending someone for a visible project or arguing their case in a promotion meeting. Sponsorship is the most powerful and the most neglected, because it costs you something. *Follow-ups:* Who have you sponsored? When does mentoring become a crutch?

**Q: How do you use code review to grow people? (Part 87)** Explain the why, ask questions instead of dictating, mark what is blocking versus personal preference, and praise good judgement when you see it. Code review is the most frequent teaching interaction a senior has; used well, it is continuous mentoring. *Follow-ups:* How do you review a junior's 2,000-line PR? What do you never comment on?

**Q: How do you design an interview loop? (Part 87)** Backward from the signals that predict success in the specific role: list them, give each stage distinct signals to cover, cut stages that repeat, and replace unstructured "culture fit" chats with structured questions and rubrics. *Follow-ups:* How many stages is too many? How do you validate a loop against later performance?

**Q: What does a bar raiser do, and why calibrate interviewers? (Part 87)** A bar raiser is a trained interviewer from outside the hiring team who holds the standard when the team is under pressure to fill a seat. Calibration sessions, where interviewers score the same recorded answer against the rubric, align everyone on one bar and reduce noise and bias. A bad hire costs far more than an empty seat. *Follow-ups:* Should a bar raiser have a veto? How often do you calibrate?

#### How to practise the leadership questions

Leadership questions are rarely asked as definitions. "What is an options paper?" arrives as "Tell me about a time you had to get a decision from leadership on a technical investment." Prepare one story per Part from your own work, in the situation, action, outcome shape, with the concept from the answer above as the spine of your "action" and a number in your "outcome". Six stories (writing, strategy, migration, influence, disagreement, growing someone) cover almost every staff-level behavioural round.
