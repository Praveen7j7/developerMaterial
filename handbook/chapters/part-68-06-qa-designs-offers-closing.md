### 68.7.5 Modern system designs (Parts 65, 66)

#### Part 65 — More System Designs I

**Q: How do R/W quorums make a distributed KV store's consistency tunable? (Part 65)** A write waits for W replica acks, a read for R responses; R + W > N guarantees a read sees the latest write (strong consistency), while lower values trade consistency for availability and latency — the CAP tradeoff made operational per request. *Follow-ups:* Why does a sloppy quorum break R + W > N? What are R and W for a shopping cart?

**Q: What is consistent hashing, and why add virtual nodes? (Part 65)** Keys and nodes are placed on a hash ring and each key belongs to the next node clockwise, so adding or removing a node moves only about 1/N of the keys instead of nearly all of them. Virtual nodes give each physical node many points on the ring, which evens out load and spreads a failed node's keys across many survivors. *Follow-ups:* How many virtual nodes per server? What does a hot key do to this scheme?

**Q: How does a web crawler stay polite and avoid fetching duplicates? (Part 65)** It obeys robots.txt and per-host rate limits absolutely, enforced by a two-level frontier (priority queues feeding per-host queues) and an atomic per-host claim so two fetchers never hit the same host at once. Duplicates are filtered by a Bloom filter backed by an exact store, because a Bloom filter's "seen" can be a false positive. *Follow-ups:* How do you size the Bloom filter? How do you detect near-duplicate pages?

**Q: Why prefer UUIDv7 over UUIDv4 for IDs? (Part 65)** Both need no coordination, but UUIDv7 is time-ordered (a timestamp prefix), giving far better database index locality (sequential inserts) than random UUIDv4, at the same 128-bit size; it is the pragmatic modern default when a compact 64-bit Snowflake is not required. *Follow-ups:* What happens to a Snowflake generator when the clock jumps back? Why send 64-bit ids as strings in JSON?

**Q: Why can't you read new rows by remembering the highest id seen? (Part 65)** Ids are assigned before commit, so a transaction holding id 1001 can commit after one holding 1002; a poller that already moved past 1002 skips 1001 forever. Read changes from the write-ahead log (CDC), or only advance past ids older than every in-flight transaction. *Follow-ups:* Does a `created_at` column fix it? How would you prove a poller is skipping rows?

**Q: How do you guarantee no double-sell in a booking system? (Part 65)** An atomic conditional update (`UPDATE ... WHERE status = 'available'`): among racing transactions exactly one updates the row and claims the seat, the rest update zero rows and get a correct conflict; a waiting room tames the on-sale thundering herd without trading away this consistency. *Follow-ups:* How do you hold several seats at once without deadlocks? What happens if payment succeeds after the hold expired?

#### Part 66 — More System Designs II

**Q: How do you build a real-time leaderboard? (Part 66)** A Redis sorted set: `ZADD` with `GT` so a replayed or lower score never overwrites the best one, `ZREVRANK` for a player's rank and `ZREVRANGE` for the top N, all O(log N). Break ties with a composite score that stays inside 2⁵³, keep a durable copy in PostgreSQL to rebuild from, and run that Redis with `noeviction`. *Follow-ups:* How do you shard a leaderboard of 500 million players? How do you show "players near me"?

**Q: When is a count-min sketch acceptable? (Part 66)** When approximate counts are good enough and memory must be fixed: it only over-estimates, with an error bound proportional to the total count, so heavy hitters (trending products) are accurate while rare items are noisy. Never use it for billing or anything where a small count must be exact. *Follow-ups:* How do you size width and depth? How does it combine with a heap for top-K?

**Q: How do you find nearby drivers? (Part 66)** For entities that move every few seconds, Redis geo commands (`GEOADD`, `GEOSEARCH`) on geohash-encoded sorted sets make updates cheap; PostGIS fits query-rich, mostly static data such as restaurants joined to menus and hours. Partition by city or region, and remember the search can be approximate but the claim must be exact: an atomic `SET NX` per driver prevents double dispatch. *Follow-ups:* How do you expire drivers who stop sending locations? Why not one global index?

**Q: Operational transform versus CRDTs for collaborative editing? (Part 66)** Both guarantee all clients converge. OT transforms operations against concurrent ones (needs coordination, small ops, tricky transforms); CRDTs give elements stable identities so operations merge in any order with no central transform (offline/peer-friendly, more metadata). Use a proven library rather than implementing either from scratch. *Follow-ups:* Why does compaction need an upper bound on what it deletes? When is section locking enough?

**Q: How do you count ad clicks exactly on at-least-once delivery? (Part 66)** Give each event a unique id and count it once (dedup), with atomic aggregate-and-offset updates so crash reprocessing does not double-count, window by event time with late-event handling, and back it with reconciliation from raw events — achieving exactly-once counting without exactly-once delivery. *Follow-ups:* How long do you keep dedup keys? What do you do with events that arrive a day late?

**Q: A bug double-counted clicks for six hours. How do you fix the numbers? (Part 66)** Recompute the affected windows from the raw events and swap the results in atomically; never "fix" by adding negative deltas on top of wrong aggregates. Storing consumer offsets in the same transaction as the aggregates is what makes reprocessing safe. *Follow-ups:* How do you tell advertisers? How do you stop it happening again?

## 68.8 Offers and negotiation

### 68.8.1 Levels, titles, negotiation and evaluating an offer

#### Concept

The process ends with an offer, and navigating it — understanding levels and titles across companies, negotiating, and evaluating the whole package — is a distinct skill that materially affects the outcome. An offer is not just a number; it is a level, a compensation structure (base, bonus, equity), and a role, and evaluating and negotiating it well is part of the job search.

#### Mental model

Imagine buying a house rather than a phone. The sticker price matters, but so do the location (the team), the condition (the codebase and on-call load), the loan terms (vesting and refreshers) and what the house will be worth in five years (the level and growth). Nobody buys a house on the price tag alone, and a level set one step too low is like a mortgage at the wrong interest rate: small today, very large over a career.

#### How it works

- **Levels and titles**: titles are inconsistent across companies — one company's "senior" is another's "staff", and compensation bands differ widely. Understand the level you are being offered relative to the company's ladder and relative to your actual scope (Part 58), because the level, more than the title, drives compensation and expectations.
- **Compensation structure**: total compensation is typically base salary plus bonus plus equity (stock, with vesting). The mix varies enormously (a startup may offer more equity and less cash; big tech a large equity component). Evaluate the whole package and understand the equity (what kind, vesting schedule, and realistic value — be skeptical of headline equity numbers), not just the base.
- **Negotiation basics**: negotiation is expected and normal; the offer is usually not the ceiling. Negotiate respectfully and with information — competing offers, market data for the level, and the specific components you value. Negotiate the level if you believe it is mis-set, because level has the largest long-term impact. Be honest and professional; the goal is a fair outcome and a good start to the relationship, not to win.
- **Evaluating an offer**: beyond compensation, weigh the role and scope, the team and manager, growth opportunity, the technical environment, work-life factors, and the company's trajectory. The best offer is not always the highest number; a role that grows you and a team you learn from can be worth more over a career.

Levels map roughly across large companies, which is how recruiters and candidates compare offers. Treat this as approximate and check current public compensation data for the specific company:

| Common meaning | Google | Meta | Amazon | Typical scope |
|---|---|---|---|---|
| Senior | L5 | E5 | L6 (Senior SDE) | Owns a service or major feature end to end |
| Staff | L6 | E6 | L7 (Principal SDE) | Owns a cross-team technical area |
| Senior staff / principal | L7 and up | E7 and up | L8 (Senior Principal) | Sets direction for an organisation |

A "Senior" or even "Staff" title at a 40-person startup often carries the scope of a mid-level or senior role at a large company. That is not bad, but it matters when you later move back, because the next company levels you by scope, not by title.

#### Practical example — reading the equity

Two offers for the same senior role:

| | Offer A (public company) | Offer B (Series B startup) |
|---|---|---|
| Base | $185,000 | $170,000 |
| Bonus target | 15% ($27,750) | none |
| Equity | $400,000 in RSUs over 4 years, 1-year cliff | 0.15% in options, strike $2.10, last round valued the company at $300M |
| Year-1 cash plus vested equity | $185,000 + $27,750 + $100,000 = $312,750 | $170,000 + options you must pay to exercise |

Offer B's headline "0.15% of $300M = $450,000" is not $450,000. The options have a strike price you pay, preferred shareholders are repaid before common shareholders in a sale, later rounds dilute you (commonly 15 to 25 percent each), the shares are illiquid until an exit that may never come, and options usually must be exercised within a short window after you leave. For planning, value startup equity at a steep discount, often at zero, and take the offer only if the cash and the role are worth it on their own. Also ask about the vesting schedule (some companies back-load it), refreshers (annual new grants, which decide whether year five pays like year one), and whether the bonus is guaranteed.

#### Practical example — a negotiation, in words

```text
"Thank you, I'm excited about the team and the payments work. Before I decide, I'd
like to talk about two things. First, the level: the role description and my last
two years leading the migration across four teams match your L6 expectations more
than L5. Could the panel's feedback support L6? Second, if the level stays, I have
another offer at $312k total in year one; is there flexibility on the equity grant
to close part of that gap? I'd like to make this work."
```

It is specific, it is evidence-based (scope and a competing number), it asks about the level first because it matters most, and it signals intent to join. It never invents an offer, never issues an ultimatum, and never negotiates against yourself by naming a number before they have.

#### Failure scenario

An engineer accepted a "Staff Engineer" title at a fast-growing startup, at roughly the cash of their previous senior role, with options as the upside. Eighteen months later the company did a down round; the options were under water and the expected acquisition never happened. When they interviewed at a large company, the panel leveled them at senior, because the scope of the startup role (one team, one service) matched senior there. Nothing about the decision was foolish; the mistake was valuing the title and the headline equity instead of the cash, the scope and the learning, which were the parts that were real.

#### How a Senior Backend Engineer thinks about this

A senior treats the offer stage as professionally as the interview: understanding the level relative to their actual scope (Part 58) and the company's ladder, evaluating total compensation including a realistic view of equity (not the headline number), and negotiating respectfully with information because the offer is rarely the ceiling and level has the largest long-term impact. They weigh the whole picture — scope, team, manager, growth, technical environment, trajectory — not just the number, because the best career move is often not the highest offer. They are honest and professional throughout, because they are starting a relationship, and they know their worth from their demonstrated scope and impact rather than anchoring on a single number.

#### Common mistakes

- Accepting the first offer without negotiating (the offer is usually not the ceiling).
- Focusing only on base salary, ignoring equity structure and realistic value.
- Ignoring the level, which drives compensation and expectations more than the title.
- Chasing the highest number over the role, team, growth and trajectory.
- Negotiating adversarially rather than respectfully with information.
- Not asking to meet the actual manager and a future teammate before accepting. Ask; most companies agree, and the answer to "what is on-call like?" is worth more than a 5 percent raise.

#### Interview questions (for your preparation)

1. **Why does the level matter more than the title?** Titles are inconsistent across companies; the level drives compensation band and expectations, and has the largest long-term impact — negotiate it if it is mis-set.
2. **How do you evaluate an offer beyond the number?** Weigh total compensation (base, bonus, equity with a realistic equity view), plus role, scope, team, manager, growth, technical environment and company trajectory.
3. **How should you negotiate?** Respectfully and with information (competing offers, market data for the level, the components you value); it is expected and the offer is rarely the ceiling.
4. **The recruiter gives you an "exploding" offer that expires in 48 hours. What do you do?** Ask for a reasonable extension tied to a concrete reason ("I finish another loop on Friday"); most companies grant it. A company that will not wait a week for a senior hire is telling you something about how it will treat you later.

#### Practical exercise

For a hypothetical offer, write out: the level and how it maps to your actual scope (Part 58), the total compensation broken into base/bonus/equity with a realistic equity assessment, two points you would negotiate and the information supporting each, and three non-compensation factors you would weigh. Acceptance criteria: you evaluate the whole package (not just base), reason about the level, and base your negotiation on information.

## 68.9 Putting it together: an eight-week preparation plan

### 68.9.1 The plan

#### Concept

Preparation works when it is a plan with practice and feedback, not a pile of reading. Eight weeks of 8 to 10 hours a week is enough for a working senior engineer to be ready for a full loop, because the knowledge is mostly already there; what needs building is the method under pressure.

#### How it works

| Week | Coding (Parts 8, 9; 68.2) | Design (Parts 54, 55 and 65, 66; 68.3) | Other |
|---|---|---|---|
| 1 | Two problems per pattern for 4 patterns; method aloud | Read 54.0 and one Part 54 design | Resume bullets and project write-ups (68.1) |
| 2 | Four more patterns | Two timed 45-minute designs, recorded | Two-minute introduction, recorded |
| 3 | Last four patterns | Estimation drills (Part 55) | Six leadership stories (68.6.1) |
| 4 | Mixed problems, timed at 35 minutes | Two designs with a friend pushing back | One LLD problem from Part 67, 90 minutes |
| 5 | Redo the problems you failed | Deep-dive practice on hot paths | Q&A self-test on Parts 16, 26, 37–39, 52, 65, 66 and 81–88 (68.6, 68.7) |
| 6 | First mock coding interview with a peer | First mock design interview | Apply to lower-priority companies |
| 7 | Second mocks; fix the top two weaknesses | Second mocks | Take-home or debugging practice (68.4) |
| 8 | Light review only | Light review only | Top-choice loops; rest the day before |

Keep a simple log: problem or prompt, date, pattern, time taken, what went wrong. Patterns that show up twice in the "went wrong" column get extra problems the next week. The log is the feedback loop that turns hours into improvement.

#### Common mistakes

- Reading solutions instead of attempting problems first for at least 20 minutes.
- No mock interviews. Practising alone never trains the part that fails: talking while thinking with someone watching.
- Scheduling the top-choice company in week two.
- Studying until midnight the night before. Sleep moves more interview performance than one more problem.

#### Practical exercise

Fill in the eight-week table with your own calendar, book two mock interviews for week 6 now, and start the log. Acceptance criteria: every week has dated sessions, the mocks are booked with real people, and after week 4 the log shows your two weakest patterns and what you did about them.

## Senior Checklist — Part 68

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can write a resume and project write-ups that lead with quantified impact and scope
- [ ] I can give a two-minute introduction with numbers, and I know what to ask the recruiter
- [ ] I can recognize the coding pattern from its cues and solve live with a clear method
- [ ] I read the expected complexity from the input constraints and say it before coding
- [ ] I avoid the TypeScript traps (default sort, `shift()` queues, recursion depth, missing heap)
- [ ] I can run a 45-minute system design as a timed procedure and handle pushback by reasoning
- [ ] I know what each other round type (take-home, debugging, review, pairing, API design) scores
- [ ] I can find planted bugs with reproduce-hypothesize-isolate-verify and rank code-review findings by severity
- [ ] I can prepare for a staff/principal loop (past-project deep dive, architecture, influence, writing)
- [ ] I can answer interview questions on Parts 16, 26, 37–39, 52, 65, 66 and 81–88 concisely with examples
- [ ] I can evaluate and negotiate an offer by level and total package, not just the number
- [ ] I can value startup equity realistically (strike, preferences, dilution, liquidity)
- [ ] I have a dated preparation plan with mock interviews and a log of my weak patterns

## Part 68 — Key Takeaways

- The hiring process is a funnel; optimize each stage for its signal — a resume leads with quantified impact and scope to earn the screen, and preparation is tailored to the company type's emphasis.
- Most coding problems are instances of a small pattern catalogue (two pointers, sliding window, BFS/DFS, heaps, DP, graphs, intervals, monotonic stack, union-find); recognition from cues plus clean execution plus communication wins.
- In the coding round, state the approach and complexity before coding and get buy-in, then test your own code by tracing it — coding a wrong approach silently is the most common failure.
- Run the system design round as a timed procedure (clarify, estimate, API/data, high-level, deep dive, cross-cutting, tradeoffs), narrate constantly, and handle pushback by reasoning about the tradeoff, not defending rigidly.
- Each other round type is a proxy for part of the job: production-quality right-sized take-homes, systematic debugging, constructive code review, genuine collaboration in pairing, and contract craft in API design.
- Staff/principal loops weight scope, judgment and influence over coding, centered on a past-project deep dive; prepare two or three projects you can discuss in deep detail with tradeoffs, failures, influence and measurable impact.
- Strong staff/principal answers show concrete scope and numbers, explicit tradeoff reasoning, influence through mechanisms (not authority), and honesty about failures with lessons.
- The strongest technical answer is the concept, one number and one failure mode; the strongest leadership answer is the concept as the spine of a real story with a measured outcome.
- Interviews are a learnable skill separate from the job; strong engineers under-perform from poor method under pressure, so practice the methods (recognition, live-solving, the design procedure), not just the knowledge.
- The offer is a level plus a total package, not just a number; the level drives compensation and expectations, equity needs a realistic (not headline) assessment, and negotiation is expected and informed.
- Evaluate an offer on the whole picture — scope, team, manager, growth, trajectory — because the best career move is often not the highest number, and know your worth from demonstrated scope and impact.
- Preparation is a dated plan with mock interviews and a log of what went wrong; the log, not the hours, is what makes you better.
