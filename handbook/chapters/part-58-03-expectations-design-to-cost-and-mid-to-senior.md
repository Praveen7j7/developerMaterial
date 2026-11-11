### 58.2.20 System design

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Implements a design somebody else produced | Designs a feature within an existing system | Designs a system end to end, with capacity numbers, failure behaviour and a migration path | Designs across systems and teams; resolves conflicting constraints | Sets the target architecture and the sequence to get there |
| A component | A feature's design | A service and its contracts | A domain's architecture | The system landscape and its direction |
| Stopped starting to code before understanding the problem | Stopped designing only the happy path | Stopped designing for imagined scale instead of measured requirements | Stopped optimising one team's design at another team's expense | Stopped producing architecture that the organisation cannot actually build |

The senior design signature is arithmetic plus failure analysis. A design document that contains request rates, data volumes, growth projections, the resource that saturates first, and the behaviour when each dependency is unavailable, is a senior design. One that contains boxes and arrows is a picture.

The staff signature is a *sequence*. Anyone can draw the target state. The valuable artefact is the ordered set of steps that gets a live system from where it is to that target without a big-bang migration, where every intermediate state is shippable and each step is individually justified.

- **Junior**: implements the notification worker exactly as specified in the design doc.
- **Mid**: designs the coupon-validation flow within the existing order service, including the cache and the invalidation rule.
- **Senior**: designs the returns system: schema, API, state machine, saga with compensation, capacity estimate, alerts, and a four-step rollout plan.
- **Staff**: designs how orders, inventory and fulfilment interact across three teams, choosing where consistency boundaries sit and getting all three teams to agree.
- **Principal**: publishes the two-year target architecture with the migration sequence, and kills two proposed projects that do not fit it.

### 58.2.21 Incident response

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Follows a runbook; escalates promptly | Investigates and mitigates common failures independently | Commands an incident: mitigates first, communicates on a schedule, keeps a log, runs the postmortem | Improves the incident process; drives cross-team fixes to whole classes of failure | Owns the reliability culture and the organisation's learning from failure |
| A single alert | A service's incidents | An incident, end to end | The incident process and its outcomes | How the company learns |
| Stopped staying silent when stuck | Stopped diagnosing while customers are still affected | Stopped chasing root cause before mitigating | Stopped letting action items expire unowned | Stopped tolerating a blame culture wearing a blameless vocabulary |

The senior behaviour that matters most is structural, not technical: declare, mitigate, communicate on an interval, log with timestamps, hand over after ninety minutes. Debugging skill is useful, but a well-run incident with an average engineer beats a badly run one with a brilliant engineer almost every time, because the badly run one loses twenty minutes to duplicated work and a wrong public statement.

Above senior, the leverage moves to prevention by class. Not "add a timeout to this call" but "why do we have calls without timeouts at all, and what shared client would make that impossible?"

- **Junior**: follows the runbook, restarts the consumer, posts what they did in the channel.
- **Mid**: correlates a latency spike with a deploy, rolls back, confirms recovery on the dashboard.
- **Senior**: runs a 40-minute checkout outage as commander: rollback in six minutes, updates every fifteen, timeline captured, blameless postmortem with three owned actions.
- **Staff**: notices four incidents in a quarter share a cause class, and leads the shared HTTP client project that removes it.
- **Principal**: changes how the company runs postmortems, makes them public internally, and ties action items into planning so they actually get done.

### 58.2.22 Communication and documentation

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Asks clear questions; gives status updates | Writes readable pull requests and technical notes; explains their work to the team | Writes design docs and ADRs; explains trade-offs to non-engineers; says no with options | Writes documents that align multiple teams; influences without authority | Writes the documents that set direction for the organisation |
| Their own updates | Their feature's documentation | A system's documentation and its decisions | A domain's shared understanding | The organisation's technical narrative |
| Stopped going quiet when blocked | Stopped writing documents with no ask in them | Stopped explaining mechanisms when the audience needed consequences | Stopped assuming a document alone creates alignment | Stopped writing for peers when the audience is the executive team |

Writing is the highest-leverage senior skill and the one most engineers under-invest in. A design document read by twelve people that prevents one wrong architecture is worth more than any month of coding you will ever do. The specific skills: conclusion first, numbers not adjectives, non-goals stated explicitly, and an explicit ask at the end.

The staff-level addition is that documents do not create alignment on their own. Alignment comes from pre-reading with the two people most likely to object, adjusting, and then presenting a position that already survives the hardest questions. A document dropped into a channel with "thoughts?" produces silence and later ambushes.

- **Junior**: posts "blocked on the sandbox credentials, asked in #platform, will pick up the tests meanwhile".
- **Mid**: writes a pull request description that explains the problem, the approach and what to watch after deploy.
- **Senior**: writes the keyset-pagination ADR and explains the trade-off to the product manager in three minutes using time, risk and usage numbers.
- **Staff**: writes the event-schema RFC, pre-socialises it with four team leads, and gets adoption without a mandate.
- **Principal**: writes the two-page memo that convinces the executive team to fund a year of platform work, in their language.

### 58.2.23 Mentoring and leadership

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Learns actively; asks for feedback | Helps peers; onboards new joiners; reviews thoughtfully | Mentors deliberately; raises the team's bar; leads projects without authority | Grows senior engineers; multiplies leadership across teams | Shapes the engineering culture, hiring bar and technical values |
| Their own growth | A peer's onboarding | The team's technical standard | The next generation of senior and staff engineers | The organisation's engineering identity |
| Stopped waiting to be told what to learn | Stopped answering only what was asked | Stopped solving problems that would have grown someone else | Stopped being the person who has to be in every design review | Stopped confusing personal excellence with organisational capability |

The transition into real technical leadership is when you start optimising for what happens without you. Delegating a whole problem rather than tasks, letting a mid-level engineer make a recoverable mistake, and reviewing their design instead of writing it.

There is a trap here worth naming: the indispensable engineer. If every hard problem routes to you, you feel valuable and are actually a bottleneck. The strongest evidence of staff-level leadership is a team that made three good decisions last month without you in the room.

- **Junior**: asks for a code-review buddy and acts on the feedback consistently.
- **Mid**: onboards a new joiner, pairs with them for a week, and writes the missing setup documentation they needed.
- **Senior**: gives a mid-level engineer the payment retry project end to end, reviews the design, and lets them present it.
- **Staff**: runs a design-review forum where four teams critique each other's proposals, raising the standard without approving anything personally.
- **Principal**: sets the interview bar and the promotion criteria, and personally coaches three staff engineers.

### 58.2.24 Business and product understanding

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Knows what the ticket asks for | Understands the feature's purpose and its users | Understands the business model; challenges requirements; proposes cheaper ways to reach the goal | Connects technical strategy to business strategy | Shapes what the business can do technically, and what it should not attempt |
| A ticket | A feature | A product area's technical direction | A business line's technical enablement | The company's technical possibilities |
| Stopped implementing without asking why | Stopped accepting requirements that contradict each other | Stopped building exactly what was asked when a cheaper option met the goal | Stopped presenting technical plans without business framing | Stopped treating business constraints as interference |

The behaviour that changes a career here is turning up with alternatives. "This will take five weeks" ends a conversation. "The full version is five weeks; there is a four-day version that covers the two cases your data says are 96 percent of usage; here is what we would give up" starts a decision. Product managers begin including engineers with that habit in planning, which is where architecture actually gets decided.

Understanding unit economics is the next step: what a customer is worth, what an order costs to process, what an hour of downtime costs. These numbers make technical arguments land instantly with people who control budgets.

- **Junior**: asks in refinement why the export needs to include cancelled orders.
- **Mid**: notices two requirements conflict on refund timing and gets it resolved before building.
- **Senior**: proposes the four-day version that covers 96 percent of the need, with data, and it ships instead of the five-week plan.
- **Staff**: shows that the marketplace expansion needs an inventory redesign, and sequences it so the first revenue lands in one quarter rather than three.
- **Principal**: tells the executive team that the proposed real-time personalisation product would need an 18-month data platform investment, and proposes a smaller product that ships in a quarter.

### 58.2.25 Cost awareness

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Unaware of what their code costs to run | Knows their service's rough monthly bill and the expensive parts | Designs with cost as a constraint; finds and removes waste; can justify spend | Owns cost visibility and efficiency programmes across teams | Owns the cost model, commitments and the efficiency-versus-velocity balance |
| Nothing | An awareness | A service's cost profile | A department's spend | The company's infrastructure economics |
| Stopped assuming infrastructure is free | Stopped ignoring data transfer and storage growth | Stopped over-provisioning "to be safe" without measuring | Stopped letting untagged spend hide ownership | Stopped optimising cost at the expense of the engineering velocity that earns more |

Cost is a design constraint like latency. The senior habits are unglamorous and effective: right-size from observed usage rather than fear, set retention on logs and backups, drop unused indexes and idle environments, put lifecycle policies on buckets, and know that cross-availability-zone traffic and NAT gateway data processing are the two line items that surprise everyone.

The counterweight, which principals hold: engineer time usually costs more than compute. Spending three weeks to save $200 a month is a bad trade. Spending three days to save $4,000 a month is an excellent one. Know which you are doing.

- **Junior**: does not know the service costs anything.
- **Mid**: notices the logging bill tripled after adding debug logging to a hot path, and reduces the level.
- **Senior**: cuts a service's bill by 40 percent by right-sizing pods from a month of usage data, adding S3 lifecycle rules, and deleting three unused indexes and two idle staging environments.
- **Staff**: introduces mandatory cost tags and per-team dashboards, making spend visible enough that teams self-correct.
- **Principal**: buys a three-year committed-use discount against a validated capacity model, saving 28 percent, and blocks a proposed multi-region rollout whose cost had no business justification.

## 58.3 Moving from mid to senior

This is the most common transition and the one most people get wrong, because they assume the answer is "write better code". It is not. Mid-level engineers are usually already good at code. The gap is elsewhere.

### 58.3.1 The behaviours that actually get you promoted

**You take problems, not tasks.** Being handed "improve checkout reliability" and returning with a plan, an owner list, a sequence and results is senior work. Being handed "add a retry to the payment call" and doing it well is mid work. Ask your lead for the problem behind the ticket, and then propose the plan.

**You finish things.** Not merged: finished. Deployed, verified in production, alerted, documented, and the follow-up work either done or in the backlog with an owner. A large fraction of engineers never get promoted because they leave a trail of 90-percent-complete work that somebody else has to close.

**You reduce other people's uncertainty.** You write the design down before building it. You send the status update before it is requested. You explain the trade-off to the product manager without being asked. People start to relax when you own something, and that feeling is exactly what a promotion is a formal recognition of.

**You think about production before you write code.** How will I know it broke, how will I roll it back, what happens at 10x, what happens when this dependency is down. Adding these to your design conversations is the fastest visible change you can make.

**You make other people better.** Your reviews teach. You pair on hard problems. You wrote the document that stopped three people asking the same question.

**You disagree well.** You can hold a position with evidence, change your mind when shown better data, and commit fully when overruled. Teams promote people they trust in a disagreement.

### 58.3.2 The kind of project to own

Look for a project with these properties, and volunteer for it:

- **It is ambiguous.** Nobody has fully specified it. That is the point: defining it is the senior work.
- **It touches production seriously.** Migrations, reliability, performance under load, a payment path. Work that can hurt is work that demonstrates judgment.
- **It crosses at least one boundary.** Another team, or product, or operations. You will have to communicate, not just code.
- **It is bounded.** Six to ten weeks. Long enough to matter, short enough to finish inside a review cycle.
- **Its success is measurable.** "p99 from 2.1 s to 400 ms", "double charges from 4 per week to zero", "deploys from weekly to daily". Numbers make your case for you.

Good candidates in most teams: fixing the flakiest critical journey, a zero-downtime migration of a big table, adding observability and alerting to an unloved but important service, cutting deploy time and adding rollback safety, or leading the response to a recurring class of incident.

### 58.3.3 The visible signals

Promotion decisions are made by people who mostly did not watch you work. They rely on artefacts and on what others say about you. So produce artefacts:

- Design documents and ADRs with your name on them, in the repository.
- Postmortems you wrote, with actions that were completed.
- Dashboards and alerts that other people now use.
- Runbooks that someone else successfully followed at 03:00.
- Review comments that visibly taught something.
- A measurable outcome you can state in one sentence with a number.

And make it legible without bragging. A short weekly update in the team channel — "the migration finished, 90 M rows, zero downtime, p99 on order history is now 8 ms, doc here" — is not self-promotion. It is how information reaches the people who make decisions.

### 58.3.4 A realistic six-month plan

| Month | Focus | Concrete output |
|---|---|---|
| 1 | Production literacy | Learn every dashboard for your service; join the on-call shadow rotation; write the missing runbook for the noisiest alert |
| 2 | Depth in the database | Audit indexes and top queries with `pg_stat_statements`; fix the two worst; write up before and after numbers |
| 3 | Design in writing | Write an ADR for a decision your team is about to make; write one design doc and get it reviewed by two people |
| 4 | Own an ambiguous project | Take a bounded, measurable, production-touching project; define it yourself; publish the plan |
| 5 | Deliver and communicate | Ship it in increments behind flags; give a 15-minute team talk on what you learned |
| 6 | Multiply | Mentor one engineer through their own project; improve the review culture with a checklist; ask your lead directly what is still missing |

Two notes on this plan. It assumes you keep delivering your normal work; senior behaviour is added on top, not instead. And month 6's "ask directly what is missing" is not optional — ask for the specific gap, in writing, and then close it. Vague answers are a signal to look elsewhere.
