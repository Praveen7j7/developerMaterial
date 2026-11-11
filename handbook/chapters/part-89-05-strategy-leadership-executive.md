## 89.5 The strategy and vision round

#### Concept

The strategy round tests whether you can decide where a group of teams should go technically, why, and what they should stop doing. It comes in a few formats: "you join as principal; what do you do in your first 90 days?", "here is our current strategy; critique it", "here are six initiatives and capacity for three; choose", "how do you manage technical debt across an organisation?", or "what is your technical vision for this product area?". Part 82 — Technical Strategy, Vision and Roadmaps teaches the discipline; this round asks you to do a compressed version of it live.

#### Why does it exist?

At staff level and above, the most expensive mistakes are not bad designs but good designs for the wrong problem, and roadmaps that try to do everything. The round exists to find candidates who diagnose before they prescribe, who can hold a few priorities and drop the rest, and who know that a strategy nobody follows is a document, not a strategy.

#### Mental model

Imagine a new doctor taking over a ward. A poor one starts prescribing on day one, based on what worked at their last hospital. A good one reads the charts, talks to the nurses, examines the patients, decides which two conditions are killing people, treats those first, and explicitly stops a few treatments that do no good. The interviewer is checking which doctor you are.

#### How it works

**Use the kernel.** The structure from 82.2 works in every format: a **diagnosis** (what is really going on, with evidence), a **guiding policy** (the approach that deals with it, including what you will not do), and **coherent actions** (a few concrete steps that reinforce each other). Say the three words out loud; interviewers who know Part 82's source material will recognise it, and those who do not will still hear a structure.

**Ask before you answer.** In any strategy prompt, spend the first few minutes on questions: what the business is trying to achieve this year, where engineering time goes now, what has been tried, who decides. If the interviewer says "assume whatever you like", state your assumptions and tie the strategy to them.

**Treat technical debt as a portfolio.** The strong answer to "how do you handle tech debt?" is the 82.4 method: classify debt by type, quantify its cost in incidents, lead time and toil hours, decide which to pay down and which to carry deliberately, and fund paydown through an explicit mechanism (a fixed capacity share, or paydown attached to the features that touch the debt). The weak answer is "we keep a backlog and do it when we have time", or "20% for tech debt" with no way to choose what the 20% buys.

**Say no with reasons and alternatives.** Strategy is mostly choosing what not to do (82.6). In the "six initiatives, capacity for three" format, the interviewer is scoring how you drop three, not how you love the other three. Rank by business value, cost, risk of delay and dependency; say what happens to the dropped ones (stopped, deferred with a date, or handed to a team with a smaller version).

#### Practical example: the 30-minute exercise "you join as principal; what do you do in 90 days?"

The prompt: "You join us as a principal engineer. We are a marketplace with 150 engineers in 18 teams. You report to the VP of Engineering. What do you do in your first 90 days?" Below is a strong answer, compressed.

"First, three questions so I aim right. What does the VP want from this role in a year? What are the company's top two goals this year? And is there something on fire right now? I will assume: the goals are growth into two new cities and better margins; the VP wants someone to own technical direction for the platform; nothing is on fire, but incidents have been rising.

**Days 1–30: listen and map.** I would meet each team lead and the staff engineers, about 25 one-on-ones, with the same four questions: what slows you down, what scares you in production, what decision is stuck, and what you would stop if you could. I would read the last two quarters of postmortems, the roadmap and the architecture docs, take an on-call shadow shift, and ship one small change through the full pipeline myself. The output is a written current-state summary that I share back with the people I interviewed, to check that I heard them right. I would not propose anything in this month, except to fix something unsafe if I find it.

**Days 31–60: diagnose and test.** I would turn the notes into a diagnosis with evidence. For example: 60% of incidents trace to three shared services nobody fully owns; lead time is fine for new code but terrible for anything touching the order schema; and four teams are independently building their own city-configuration systems for the expansion. I would write a two-page strategy draft with a guiding policy, say: 'Ownership before new architecture; one city-configuration model; no new services in the order domain until the schema has an owner.' Then I would pre-wire it (86.1) with the team leads most affected and the VP, and change it based on what they say.

**Days 61–90: first coherent actions and one visible win.** Publish the strategy. Start two or three actions that reinforce each other: assign owners to the three shared services with the VP's help; lead the design of the shared city-configuration model with the four teams, because the expansion makes it urgent and it is a visible win; and set up a monthly architecture forum with written decisions (83.4). I would also say clearly what we are not doing this half: no rewrite of the order system, no new message broker, no multi-region.

**How I would measure it.** At day 90, the VP and team leads can repeat the diagnosis in their own words, the four teams are building on one configuration model, and incident ownership is clear. In two quarters: incident count from the three shared services down, and lead time for order-schema changes falling."

**What a principal-level answer adds.** It listens before it proposes and says so; it produces written artefacts at each step (current state, strategy, decisions); it ties technical priorities to the company's goals (expansion, margin); it includes one early, visible win so credibility is earned, not assumed; it names what will not be done; and it plans to make the strategy belong to others through pre-wiring. A staff-level answer often has the right technical diagnosis but proposes a solution in the first week; a senior-level answer usually lists technologies to introduce.

#### Failure scenario

A candidate answered the 90-day question with a technology plan: "migrate to Kubernetes, introduce an event bus, adopt GraphQL, and set up a platform team." The interviewer asked, "How do you know those are our problems?" The candidate said these were best practices at their previous company. Feedback: "Prescription before diagnosis; would impose their last company's architecture. Strong technically, wrong instinct for the level." Each item might even have been right, but there was no evidence, no sequence, and nothing about people.

#### Edge cases & failure modes

- **The interviewer gives a real company strategy to critique.** Start with what is good about it; then test it against the kernel: is there a diagnosis, does the policy rule anything out, do the actions reinforce each other (82.9)?
- **"What is your vision?" with no context.** Ask what horizon and audience; a vision is a picture of the future (82.1), short enough to repeat, and it must connect to a business outcome.
- **Strong disagreement from the interviewer.** It may be a test of how you handle pushback. Ask what they see that you do not, and adjust if the argument is good.

#### How a Principal Engineer thinks about this

A principal is suspicious of strategies that do not rule anything out, including their own. They spend more of the answer on diagnosis than candidates expect, because they know the action list is the easy part. They treat strategy as something that must be adopted by others, so they plan how it will be written, pre-wired, measured and repeated, not just what it says.

#### Common mistakes

- Solutions in the first sentence.
- A list of ten priorities, which is no priorities.
- Technology goals with no business link ("adopt microservices").
- Forgetting the people: who has to change, and why would they?
- "Tech debt time" with no method for choosing what it buys.

#### Interview questions

1. **"How do you decide what not to do?"** Expected: an explicit filter (business value, cost of delay, risk, dependency, 58.4.6), plus an example of something you stopped.
2. **"How do you manage technical debt across 15 teams?"** Expected: classify, quantify in incidents, lead time and toil, fund through an explicit mechanism, review quarterly (82.4).
3. **"Your strategy is six months old and teams are ignoring it. Why, and what do you do?"** Expected: find out whether it is wrong, unclear, unfunded or unknown; fix that one; embed it in templates and reviews (82.8).

#### Practical exercise

Do the 90-day exercise aloud for your current company as if you had just joined, in 30 minutes, recorded. Acceptance criteria: you asked or stated the business goals first; the first 30 days contain no proposals; the strategy has a diagnosis with at least two pieces of evidence, a guiding policy that rules out at least two things, and two or three reinforcing actions; and you said how you would measure success at day 90.

## 89.6 The leadership, influence and executive communication round

#### Concept

This round, sometimes split into a behavioural round and a conversation with a senior leader, tests how you get things done through people you do not manage, how you disagree and then commit, how you make a case in money terms, and how you explain trade-offs to executives briefly. Part 86 — Influence, Communication and the Business Case teaches the skills; the round asks for evidence that you have used them, plus a live demonstration of executive communication.

#### Why does it exist?

A staff engineer's scope is always larger than their authority, so the job runs on influence. And the people who fund and stop work speak in revenue, cost, risk and time, not in architecture. A candidate who cannot convert a technical position into a business decision, in two minutes, will be right and ignored, which is the plateau 58.7.1 describes.

#### Mental model

Imagine a diplomat. They have no army and no vote in the other country's parliament. What they have is trust built over years, an understanding of what the other side needs, the patience to talk privately before anything is public, and the ability to put a complex position in one sentence a minister can repeat. The interviewer is checking whether you work like a diplomat or like someone who expects to be obeyed.

#### How it works

**Influence without authority: the model answer shape.** Use a story from the bank (89.2) and make the mechanics visible: the problem framed in the other team's terms, the private conversations before the public proposal, the coalition, the concession you made, and the adoption numbers. 86.1 lists the mechanics: credibility, trust, pre-wiring and coalitions.

> "Four teams were building four incompatible event formats, and integration bugs were costing each of them about a day a sprint. I had no authority over any of them. I started with the lead who felt the most pain and asked what a shared format would need to do for her team. I wrote a two-page proposal using her team's integration bugs as the evidence, then met the other three leads one by one before any group meeting. One had a real constraint, a partner integration on the old format, so the proposal kept a translation layer for his team for two quarters. By the review meeting, three leads had already agreed, and the fourth came along. Eleven of fourteen producers moved within two quarters, and the integration bug count in those teams fell by about two thirds."

What a principal-level answer adds: it explains why the problem was worth their scarce time (a class of problem, not an instance), shows that the new path was made cheaper than the old one (a shared library, a schema registry, 83.8), and says what they did with the last three producers.

**Disagree and commit.** The interviewer wants three things: that you disagreed on the problem, not the person; that you escalated openly if you had to; and that, once the decision was made, you committed fully, including making the chosen option succeed.

> "I argued against moving our search to a hosted search service. I thought PostgreSQL full-text would meet our needs for another two years at a fraction of the cost (Part 34). I wrote a one-page comparison and the director chose the hosted service, because the product roadmap needed features PostgreSQL would struggle with. I said in the decision thread that I disagreed and that I was committed. Then I led the migration plan, and I added the one thing my comparison had worried about, a cost alert per index, which caught a runaway re-index cost in month two. In hindsight the director was right about the roadmap."

What a principal-level answer adds: the decision record (who decided, on what evidence, with a review date), and the honest hindsight in either direction.

**A business case in money terms.** Executives do not fund "observability"; they fund fewer lost orders. The 86.3 structure: the ask, the benefit as money or risk reduced, the cost, the payback, the cost of delay, and a sensitivity check. Example, with illustrative numbers:

```text
Ask:      4 engineers for 2 quarters to build automated failover between
          payment providers.
Problem:  Provider outages: 5 per year, average 50 minutes, at peak.
          Lost orders during an outage: ~70% of attempts.
Money:    Peak gross order value ~ $9,000 per minute (illustrative).
          5 x 50 min x $9,000 x 70% = ~$1.6M gross order value lost per year;
          at a 20% take rate, ~$315,000 of revenue, before churn effects.
Cost:     4 engineers x 2 quarters = 2 engineer-years at our fully loaded
          cost, plus a second provider's fixed fees.
Payback:  Months to recover = one-off cost / (~$315,000 per year / 12).
          Fill in the real engineer cost from finance; do not guess it.
Sensitivity: Halve the outage rate and the payback period doubles; the
          second provider also gives negotiating leverage on fees, which
          is upside not counted above.
Cost of delay: each quarter without it carries ~1.25 expected outages,
          about $79,000 of revenue at risk.
```

Use your company's own fully loaded engineer cost when you do this for real; do not quote numbers you do not have. What the interviewer is scoring is the shape: a clear ask, money on both sides, an honest range, and the cost of waiting.

**Explaining a trade-off to a CEO in two minutes.** Bottom line first, two options, the cost of each in the CEO's terms, your recommendation, and the decision you need (86.2). A model answer to "We want to launch in a new country in March. Engineering says May. Explain why, in two minutes":

> "Bottom line: we can launch in March with a manual workaround, or in May with the proper fix, and I recommend March with the workaround, with three limits.
>
> The issue is currency. Our payment ledger only handles one currency. Launching on it in a second currency means converting every order by hand in finance at month end.
>
> Option one, March: we launch with a finance workaround. Risk: the workaround handles roughly 2,000 orders a month before finance needs another person, and reporting errors are likely in the first months. Option two, May: we build multi-currency support first. Cost: two months of revenue in the new market, and the two-month delay lets the competitor who launched there in January keep building their lead.
>
> My recommendation is March, if we accept three limits: we cap launch marketing until May, finance gets one temporary hire, and the proper fix is funded now so it is live by May. If any of those is not acceptable, May is the safer choice.
>
> What I need from you today is a yes on the three limits."

What a principal-level answer adds: it gives the CEO a real choice, quantifies the risk they are accepting, makes the recommendation conditional on specific limits, and ends with a decision request. It never mentions the ledger's schema.

**What the round's rubric looks like.** Consistent with the rubric style of 87.5, a staff-level leadership rubric might read:

| Dimension | Strong | Mixed | Weak |
|---|---|---|---|
| Influence | Shows mechanisms (framing in their terms, pre-wiring, coalition, concession) with adoption numbers | Describes persuasion but with authority or a manager doing the hard part | "I told them"; no adoption evidence |
| Disagreement | On the problem; open escalation; full commitment after | Disagreed well but did not commit, or committed silently | Personal, or disagreement never voiced |
| Business framing | Money, risk and time, with honest ranges | Business words, no numbers | Purely technical framing |
| Executive communication | Bottom line first, options, recommendation, decision asked, under two minutes | Clear but long, or no recommendation | Technical detail, no decision |
| Multiplying others | Specific people grown, sponsored and now leading | Mentoring described generally | No evidence |

#### Failure scenario

Asked to explain a trade-off to the "CEO" played by a director, a candidate spent four minutes on database replication, consistency and failover, then said "so it depends on our risk appetite". The director asked, "So what should I do?" The candidate began again with the technical detail. Feedback: "Could not give a recommendation to an executive; no money, no decision request." In a real job that conversation would have ended with the CEO asking someone else.

#### Edge cases & failure modes

- **"Tell me about a time you failed to influence."** Have one. Strong answers explain what you misread (the stakeholder's real constraint, timing, your credibility) and what you now do first.
- **"Your manager is wrong and will not listen."** Say how you would escalate openly and what you would do if you lost: commit, record the decision, and set a review point.
- **Conflict where you were partly at fault.** Own your part first; interviewers trust candidates who can.
- **The executive interviewer is from another function.** Use their goals: a product leader cares about outcomes and speed, a finance leader about cost and predictability.

#### How a Principal Engineer thinks about this

A principal knows that being right is about a third of influence (86.1), and their stories show the other two thirds working. They make cases in the currency of the decider, give credit to the people who did the work, and treat disagreement as a normal part of reaching a better decision rather than a contest. In the executive conversation, they behave as they would with their own CEO: short, honest, with a recommendation and a clear ask.

#### Common mistakes

- Influence stories where the manager or a mandate did the real work.
- Disagree-and-commit stories with no commit.
- Business cases with costs but no benefit in money.
- Two-minute answers that take six minutes and end without a recommendation.
- Taking sole credit for team outcomes.

#### Interview questions

1. **"How do you get a team you do not manage to adopt your proposal?"** Expected: their pain first, pre-wiring, make the new path cheaper, a concession, adoption measured.
2. **"Tell me about a time you were overruled."** Expected: open disagreement, the decision, full commitment, and honest hindsight.
3. **"Explain to our CFO why we should spend two quarters on reliability."** Expected: the money at risk, the cost, payback, the cost of delay, a range.
4. **"How do you handle a senior leader who keeps changing priorities?"** Expected: make the cost of each change visible in scope or dates (86.5), agree a change rhythm, protect the team.

#### Practical exercise

Write and record three answers: one influence story with the mechanics visible, one disagree-and-commit story, and a two-minute CEO explanation of a real trade-off from your work. Then write a one-page business case for a project you want funded, with sensitivity. Acceptance criteria: the influence story has adoption numbers and a concession; the commit story includes what you did after the decision; the CEO answer is under two minutes, starts with the bottom line and ends with a decision request; the business case has money on both sides and a range.
