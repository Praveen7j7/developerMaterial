## 91.7 Written exercises and take-home RFCs

#### Concept

Some staff and principal loops include a writing round: a design document or strategy memo written in 60 to 90 minutes during the loop, a take-home RFC with a stated time limit (often two to four hours), or a critique of an existing document. A few companies that run on written narratives make it central. The output is scored by people who were not in the room, which means the document must stand on its own. Part 83 — Writing as an Architect: RFCs, Design Docs and Decision Records teaches the craft; this section is about doing it under a clock, for graders.

#### Why does it exist?

At staff level, writing is the main way decisions get made across teams (83.1, 58.4.4). A candidate can speak well in a room and still produce documents that nobody can act on. The writing round sees that directly. It also strips away charisma: a grader reading your memo has only your structure, your reasoning and your honesty about trade-offs.

#### Mental model

Imagine leaving a note for the team that takes over a building site tomorrow, when you will not be there to answer questions. Every assumption has to be on the page, the first line has to say what matters most, and the reader has to be able to act without calling you. A timed design exercise is that note.

#### How it works

**Budget the time.** The most common failure is running out of time with half a document, so plan the clock before writing a word.

| Share of time | 90-minute in-loop exercise | 3-hour take-home | What you do |
|---|---|---|---|
| 15% | ~13 min | ~25 min | Read the prompt twice; list assumptions and open questions; choose the recommendation tentatively |
| 15% | ~13 min | ~25 min | Write the skeleton: all headings, one line under each |
| 50% | ~45 min | ~90 min | Fill the sections, most important first: problem, options, recommendation, risks |
| 10% | ~9 min | ~20 min | Write the summary at the top last, now that you know what you said |
| 10% | ~10 min | ~20 min | Cut, check numbers, read as the grader would |

Respect a take-home's limit. 70.4.1 makes the same point for code: a document that obviously took three times the stated time raises questions about judgment. Put what you did not cover in an "Open questions and next steps" section; graders read that as prioritisation.

**Use a skeleton.** This one adapts the anatomy in 83.3 for a timed exercise. Write all headings first, so a time crunch shortens sections instead of deleting them.

```markdown
# <Title: the decision, not the topic>
Status: proposal | Author | Date | Decision needed by: <date> from <who>

## Summary (5 lines, written last)
Recommendation, why, cost, main risk, the decision needed.

## Context and problem
What is happening, with numbers. Why now. What happens if we do nothing.
Assumptions I made because the prompt did not say (labelled as such).

## Goals and non-goals
3 goals with measures. 2-4 explicit non-goals.

## Options considered
| Option | How it works (2 lines) | Benefits | Costs and risks |
Include "do nothing or do less", and a buy option where one exists.

## Recommendation
The option, the reasons tied to the goals, and what we give up.

## Design outline
One diagram. The key components, data ownership, failure handling.

## Migration and rollout
Phases, first slice, stop conditions, rollback.

## Risks and mitigations
Top 3-5, each with a mitigation and an owner.

## Cost and effort
Engineer-time by phase; infrastructure; ongoing operations.

## How we will know it worked (and how we will know it was wrong)
Metrics, review date.

## Open questions and next steps
```

**Write the first paragraph so that a busy reader can stop there.** An example opening for a prompt asking whether checkout should become multi-region:

> We recommend not moving checkout to an active-active multi-region design this year. Instead, we propose a warm standby in a second region with a 30-minute recovery time objective, at about one third of the cost and a quarter of the engineering time. Our last regional outage cost an estimated four hours of checkout; warm standby would have cut that to under 30 minutes. Active-active becomes worth reconsidering if regional outages exceed two a year or if enterprise contracts require it. We need a decision from the VP of Engineering by the end of the month to fit the work into next quarter.

It gives the recommendation, the alternative, the cost difference, the evidence, the condition that would change the answer, and the ask, in five sentences.

**Know what graders look for.** A typical writing rubric, in the strong, mixed and weak style of 89.5:

| Dimension | Strong | Mixed | Weak |
|---|---|---|---|
| Clarity of recommendation | Stated in the first paragraph, specific, with the decision needed | Present but buried or hedged | No recommendation, or "it depends" |
| Problem framing | Problem and stakes with numbers; assumptions labelled | Problem stated without stakes | Jumps to solution |
| Alternatives | Two or three real options, fairly described, including do-less (83.4) | Options present but one is a straw man | One option only |
| Trade-offs and risks | Named costs of the chosen option, mitigations, exit criteria | Risks listed without mitigations | No downsides acknowledged |
| Feasibility | Migration path, effort, phases | Hand-wavy rollout | None |
| Economy | Short, scannable, every section earns its place | Some padding | Long, repetitive, unstructured |

**Critique exercises.** When you are given a document to review, use the review stance from 83.5: start with what the document gets right, then raise the most important problems first (missing alternatives, unstated assumptions, no rollback, no measures), suggest specific fixes, and end with whether you would approve it and under what conditions. A list of thirty small comments with the one fatal flaw buried at number nineteen reads as poor judgment.

#### Failure scenario

A candidate given 90 minutes for a design memo spent 70 minutes on a detailed component design with sequence diagrams for every flow, then wrote "Options: we could also have used X" and "Risks: TBD" in the last few minutes. The grader's feedback: "Technically detailed, but no recommendation summary, no alternatives, no risks, no rollout. Reads like a senior engineer's implementation plan, not a staff decision document." The candidate knew all the missing material; the clock simply ran out on the sections that carried the signal.

#### Edge cases & failure modes

- **The prompt is vague on purpose.** List your assumptions in the context section; graders reward explicit assumptions over guessed facts.
- **You disagree with the premise.** Say so in the summary, recommend what you believe, and still answer the question as asked in a section, so the grader can compare.
- **No diagram tool.** A small ASCII diagram in a text block is fine; clarity beats polish.
- **Very long take-home windows** ("a week, at your convenience"). Ask how much time they expect, and stick to it.

#### How a Principal Engineer thinks about this

A principal writes the summary last and puts it first. They treat the non-goals and the "how we will know it was wrong" section as the strongest signals in the document, because they show judgment and humility in a way that the design section cannot. Under time pressure they cut detail, never structure.

#### Common mistakes

- Design detail instead of decision content.
- Burying the recommendation on page three.
- Options that are not real alternatives.
- No numbers anywhere, or numbers with no source or assumption.
- Ignoring the stated time limit.

#### Interview questions

1. **"How do you structure a design document?"** Expected: summary and decision first, problem with stakes, goals and non-goals, real alternatives, recommendation with trade-offs, rollout, risks, measures (83.3).
2. **"What do you look for when you review someone's RFC?"** Expected: whether the problem is real, whether alternatives were honestly considered, whether rollback and measures exist; most important issues first (83.5).
3. **"How long should a design document be?"** Expected: as short as the decision allows; long documents need a one-page summary that can stand alone.

#### Practical exercise

Set a 90-minute timer and write a design memo for: "Our notification service sends 40 million messages a day across email, SMS and push; it fails during peak campaigns. Propose what to do." Use the skeleton. Acceptance criteria: the first paragraph alone states the recommendation, its cost, the main alternative and the decision needed; there are at least three options including do-less; non-goals and exit criteria are present; and you stopped at 90 minutes.

## 91.8 Reverse interviewing, evaluating the role, and levelling

#### Concept

At staff and principal level, the company is choosing you, and you are choosing the problems, the sponsor and the organisation you will spend the next several years on. **Reverse interviewing** is the deliberate questioning you do in every round to find out whether the role has real scope, whether someone senior will back you, what the real problems are, and how decisions are made. **Levelling** is the company's decision about which level you join at, and it shapes your scope more than your title does.

#### Why does it exist?

A staff engineer's impact depends heavily on the environment: an organisation that does not make room for staff work turns a staff engineer into an expensive senior engineer or a frustrated consultant. Most of the information you need to spot that is available in the loop, if you ask. And because level sets scope, expectations and compensation bands, getting it right at the offer stage matters more than any single number in the offer.

#### Mental model

Imagine a surgeon choosing a hospital. Salary matters, but what really decides whether they do good work is the operating theatres, the team, who backs them when a case goes wrong, and whether the hospital lets them operate on the cases they are good at. A surgeon who looks only at pay ends up somewhere they cannot practise well.

#### How it works

**Questions by area, and what to listen for.** Ask different interviewers the same core questions; inconsistent answers are themselves information.

| Area | Questions to ask | Good sign | Warning sign |
|---|---|---|---|
| Scope | "What would this person own or decide in their first year?" "Which teams would they work across?" | Specific problems and teams | "Help out where needed" |
| Success | "Twelve months in, what would make you say this hire was a success?" | Outcomes you can picture | Vague, or a list of everything |
| Sponsorship | "Who would this role work most closely with at director level or above, and what do they need?" | A named leader with a clear need | Nobody, or "the team will decide" |
| Real problems | "What are the two hardest technical problems here right now?" "What has been tried?" | Candid, specific answers | Only the public story |
| How decisions are made | "Tell me about a recent large technical decision. Who made it, how, and was it written down?" | A visible process; written records (83.2, 83.4) | "The CTO decides", or nobody knows |
| Staff ecosystem | "How many staff and principal engineers are there? What do they do differently from seniors?" "How is staff work evaluated?" | Clear expectations and examples | Title without defined expectations |
| Delivery and on-call | "How do staff engineers stay close to production?" | They ship and take part in incidents | Ivory tower, or pure firefighting |
| Health | "Why is this role open?" "What happened to the last person in it?" | Growth, or a clear and honest story | Repeated short tenures |

**Red flags at this level.**

| Red flag | Why it matters |
|---|---|
| Nobody can describe the problems you would work on | You will spend a year finding scope, and be evaluated as if you had it |
| Staff engineers are assigned to a single team's backlog | The role is senior with a staff title |
| Decisions are made in private and never written down | Influence through writing will not work; politics will |
| The hiring manager cannot name your sponsor | Cross-team work needs air cover; without it, it stalls |
| Interviewers describe the architecture as finished | Either they do not want change, or they do not see the problems |
| Reorganisations every few months | Multi-year work will be reset repeatedly (87.6) |
| The loop itself is chaotic and unprepared | It often reflects how the organisation runs |

**Levelling.** You can and should ask about level before the onsite: "Which level is this loop calibrated for? If the panel sees evidence between two levels, how is that decided?" Companies level by demonstrated scope, so describe yours in teams, horizon, systems and money (91.1), and make sure the story bank contains the evidence for the level you want. If the offer comes in a level lower than you expected, ask what evidence was missing. Sometimes it is a genuine gap; sometimes it is evidence you have but did not present, and some companies will run an extra conversation to check.

**Scope and title versus compensation.** At this level the choice is rarely just money. A decision table:

| Situation | Usually the better choice | Why |
|---|---|---|
| Higher title at a much smaller company, similar pay | Judge by scope, not title | Future employers level by scope; a title without scope does not carry over (70.8.1) |
| Lower level at a larger company, higher pay | Acceptable if the path to the next level is concrete | Ask what promotion would require and how long it usually takes |
| Same level, one role has a named sponsor and clear problems | The sponsored role, even at somewhat lower pay | Sponsorship and scope are what produce staff-level impact and the next promotion |
| A "right hand" role with high access but vague scope | Ask for a written first-year charter | High-leverage roles without a charter can leave you invisible to everyone but one leader (59.5.2) |
| Pay gap you cannot accept | Negotiate the level first, then the package | Level drives band, scope and long-term earnings |

**Negotiation basics at this level.** 70.8.1 covers the mechanics: understand the whole package, negotiate with evidence, never invent a competing offer, and negotiate the level before the numbers. Two staff-specific additions. First, scope is negotiable too: the problems you will own, the teams you will work with, and the sponsor can be agreed in writing before you start, and those agreements are often worth more than a compensation increase. Second, be specific about the evidence for your level: "My last two years were spent leading the payments migration across four teams and setting the idempotency standard for nine services; that matches your staff expectations of cross-team scope. Can the panel's feedback support that level?" This book deliberately gives no salary figures; they vary too much by company, country and year. Use current public compensation data for the specific company and level.

#### Failure scenario

An engineer accepted a principal title at a growing company after a loop in which nobody could name the problems the role would own, on the reasoning that the title and the pay were both a step up. In the first six months they were pulled into four teams' design reviews, owned none of the outcomes, and had no sponsor to arbitrate when teams disagreed with them. At their first review, the feedback was "unclear impact". Every warning sign had been visible in the loop; the engineer had asked only about the technology stack and the compensation.

#### Edge cases & failure modes

- **The hiring manager is leaving soon.** Your sponsor is leaving; ask who replaces them and meet that person if you can.
- **Interviewers give conflicting descriptions of the role.** Ask the hiring manager to reconcile them before you accept.
- **An exploding offer with a very short deadline.** Ask for the time you need; pressure tactics at offer stage often predict pressure later.
- **Internal transfer instead of external move.** The same questions apply; you can also talk to people already doing staff work there.

#### How a Principal Engineer thinks about this

A principal treats the decision to join as a technical bet with a multi-year horizon: they gather evidence about scope, sponsorship and decision-making as carefully as they would evaluate a vendor. They prefer a real problem and a strong sponsor over a bigger title. And they negotiate scope and level with the same calm, evidence-based approach they would use for a business case.

#### Common mistakes

- Using the "do you have questions?" slot for perks instead of scope and decisions.
- Asking only the hiring manager; peers and skip-level leaders give a different picture.
- Accepting a level without understanding how it was decided.
- Optimising for title over scope.
- Negotiating compensation before level.

#### Interview questions

1. **"Do you have any questions for me?"** Expected at this level: two or three questions about the hardest problems, how decisions are made, and what success looks like, tailored to the interviewer's role.
2. **"What level do you see yourself at, and why?"** Expected: a level with evidence of scope from your story bank, and openness to how they calibrate.
3. **"Why do you want to leave your current role?"** Expected: honest, forward-looking, and never disparaging your current employer.

#### Practical exercise

Write your reverse-interview plan for one target company: eight questions mapped to interviewers (hiring manager, peer staff engineer, skip-level leader, cross-functional partner), what a good and a worrying answer would sound like for each, and your own walk-away conditions on scope and sponsorship. Acceptance criteria: at least one question each on scope, sponsorship, real problems and decision-making; walk-away conditions written before the loop; a level target with the evidence you will cite.
