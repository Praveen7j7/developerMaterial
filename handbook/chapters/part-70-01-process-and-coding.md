# Part 70 — The Interview Playbook

This Part is the strategic companion to the technical Parts: how the backend engineering hiring process actually works and how to navigate it. Part 60 already covers candidate-side Q&A for Parts 8–15, 17–25, 27–36, 40–51 and 55–65, behavioural questions and three mock loops, so we do not repeat those; this Part covers the process end to end (resume, screens, how loops differ across company types), the coding round as a pattern catalogue with a live-solving method, the system design round as a timed procedure, the other round types, the staff/principal loop, interview Q&A for the new Parts 16, 26, 37–39, 52, 66, 67 and 83–90, and offers and negotiation. Read it as the map of the whole journey, with the technical Parts as the territory.

The voice here is a hiring manager and interviewer who has sat on both sides of hundreds of loops. The advice is practical and honest: interviews are a skill separate from the job, learnable with preparation, and most strong engineers under-perform not from lack of knowledge but from lack of a method under pressure. This Part gives you the methods.

## 70.1 The hiring process and company types

### 70.1.1 Resumes, project write-ups, the recruiter screen, and how loops differ

#### Concept

The hiring process is a funnel: a resume and project write-up get you a recruiter screen, which gets you a technical screen, which gets you an onsite loop of several rounds, which gets you an offer. The shape differs by company type — big tech, product startups, services/consultancies, and remote-first companies each weight the stages differently and look for different signals. Knowing the funnel and tailoring to the company type is the strategic layer beneath the technical preparation.

#### Why does it exist?

Companies cannot deeply assess every applicant, so they filter progressively: cheap signals first (resume), then increasingly expensive assessments (screens, then a full loop). Each stage exists to decide whether the next, more expensive stage is worth it. Understanding this lets you optimize for the signal each stage actually wants, rather than treating every stage the same — a resume's job is to earn the screen, not to tell your life story; the screen's job is to earn the loop.

#### Mental model

Imagine a series of doors, each more expensive for the company to open than the last. A recruiter spends about 30 seconds on a resume, 30 minutes on a screen call, one engineer-hour on a technical screen, and 5 to 8 engineer-hours on an onsite loop plus a debrief. Each door asks one question: "Is it worth opening the next one?" You do not need to impress at every door with everything you know; you need to give each door the specific evidence it is looking for.

The funnel numbers, from typical hiring data for a senior backend role, make the point:

| Stage | Typical pass rate | What the company spends |
|---|---|---|
| Resume to recruiter screen | 5–15% | ~30 seconds of a recruiter |
| Recruiter screen to technical screen | 50–70% | 30 minutes |
| Technical screen to onsite | 30–50% | 1 engineer-hour |
| Onsite to offer | 20–40% | 5–8 engineer-hours plus debrief |

The biggest drop is at the very first door. A strong engineer with a weak resume never reaches the rounds they would pass.

#### How it works — the funnel and the artifacts

```text
Resume + project write-ups  ->  Recruiter screen  ->  Technical screen  ->  Onsite loop  ->  Offer
   (earn the screen)            (fit, logistics)      (one filter round)    (several rounds)   (decision)
```

- **Resume**: for a backend role, it should foreground impact and scope, not just technologies. "Reduced checkout p99 from 400ms to 90ms by adding cache-aside and fixing an N+1" beats "worked with Redis and PostgreSQL". Quantify (throughput, latency, scale, cost, team size), show ownership, and keep it concise (one page for most, two for very senior). The resume's only job is to earn the screen.
- **Project write-ups**: for senior/staff roles especially, a short write-up of a significant project — the problem, your design decisions and tradeoffs, the outcome with numbers, and what you would do differently — demonstrates the judgment the interview will probe. This is where you show the thinking Parts 16, 26, 37–39, 52, 55–67 and 83–90 teach.
- **Recruiter screen**: largely fit and logistics (role, level, compensation range, timeline, motivation). Be clear about what you want and ready to summarize your experience in two minutes. This is also your chance to learn the loop's structure so you can prepare for it.
- **Technical screen**: usually one coding or one design round as a filter before the full loop. Treat it as seriously as the onsite — it is the gate.

#### Practical example — resume bullets and a write-up

Three bullets, before and after. Each "after" has the same shape: action, mechanism, number, scope.

| Before | After |
|---|---|
| Worked on payment service using NestJS and PostgreSQL | Made payment capture idempotent with request keys and an outbox, cutting duplicate charges from ~40/month to 0 across 1.2M payments/month |
| Responsible for Kafka consumers | Cut order-event consumer lag from 45 min peaks to under 30 s by batching DB writes and fixing a rebalance storm; 12 consumers, 8k events/s |
| Helped migrate to Kubernetes | Led migration of 14 services from VMs to EKS over 2 quarters with zero customer-facing incidents; added readiness probes and PDBs that later prevented 3 outages |

A project write-up for a senior or staff application fits on one page:

```text
Project: Order service split from the monolith (2024, 3 engineers, I led)
Problem:   Checkout deploys blocked by 40-minute monolith builds; 2 incidents/quarter from
           shared-table locks. Goal: independent deploys, p99 checkout < 300 ms.
Decision:  Strangler with CDC (Debezium) instead of dual writes. Gave up: 6 weeks of
           schedule. Gained: no divergence risk; reconciliation proved parity before cutover.
Went wrong: Backfill saturated the primary at 2am; added throttling and moved it to a replica.
Outcome:   Deploys 4x/day (from 2x/week); checkout p99 410 -> 180 ms; old tables deleted.
Again?     Start reconciliation on day one, not week six.
```

#### How it works — how loops differ by company type

| Company type | Emphasis | What to expect |
|---|---|---|
| Big tech | Standardized, rigorous; heavy on algorithms (coding) and system design; leveling matters | Multiple coding rounds, a design round, behavioural; a calibrated bar and committee |
| Product startup | Practical; can-you-build-and-ship; may favor take-homes or practical rounds | Fewer, more applied rounds; culture/fit weighs heavily; broad scope expected |
| Services / consultancy | Breadth across technologies, client-facing skills, delivery | Practical assessment, communication, sometimes domain-specific |
| Remote-first | Strong written communication, autonomy, async collaboration; often take-homes | Written exercises, practical rounds, emphasis on self-direction and clear writing |

Big tech loops reward deep algorithm and system-design preparation and clear leveling signals; startups reward demonstrated ability to build and ship broadly; services companies reward breadth and client skills; remote-first companies reward written communication and autonomy. Tailor your preparation and your framing to the type: lead with shipped impact and breadth for a startup, with rigorous algorithm and design preparation for big tech, with clear writing for remote-first.

A typical senior backend loop at each, so you know what to rehearse:

| Company type | Typical loop (after the screens) |
|---|---|
| Big tech | 2 coding (45 min each), 1 system design (45–60), 1 behavioural, sometimes 1 LLD; hiring committee decides |
| Product startup (Series B–D) | 1 practical coding or take-home review, 1 system design, 1 "how you work" with the CTO or a founder |
| Services / consultancy | 1 technical deep dive on your stack, 1 practical exercise, 1 client-scenario round |
| Remote-first | Take-home (4–6 hours) plus a review call, a written design exercise, async-collaboration questions |

#### Production scenario — the two-minute answer

Every recruiter screen and most rounds open with "tell me about yourself". Prepare it like a design: two minutes, four beats. Current role and scope ("senior backend engineer on payments, 1.2M transactions a month"), one or two achievements with numbers, what you are looking for and why this company, and a handoff ("happy to go deeper on any of that"). Rehearse it aloud until it is natural, not memorized. A rambling five-minute life story costs you the first impression and ten minutes of your own interview time.

#### Failure scenario

A backend engineer with nine years of experience applied to 40 companies over two months and got 3 screens. The resume listed 22 technologies and every job's duties ("responsible for APIs", "worked with Kafka"), with no numbers anywhere. A peer review rewrote the top six bullets in the action-mechanism-number-scope shape and added a two-line summary aimed at senior backend roles. The next 15 applications produced 7 screens. Nothing about the engineer had changed; only the evidence the first door could see.

#### How a Senior Backend Engineer thinks about this

A senior treats interviewing as a distinct skill and the process as a funnel to optimize stage by stage: a resume that leads with quantified impact and scope to earn the screen, project write-ups that showcase design judgment for senior roles, and preparation tailored to the company type's actual emphasis. They research each company's loop structure (often from the recruiter) and prepare accordingly rather than preparing generically. They are honest with themselves about level: applying and interviewing at the right level matters, because the bar and the expected signals differ sharply between senior, staff and principal (Part 59). They know strong engineers often under-perform in interviews from poor method under pressure, so they practice the methods (coding, design) deliberately, not just the knowledge.

#### Common mistakes

- A resume listing technologies instead of quantified impact and scope.
- Treating the technical screen as less important than the onsite (it is the gate).
- Preparing generically instead of for the specific company type's emphasis.
- Not researching the loop structure, so you are surprised by the rounds.
- Interviewing at the wrong level (over- or under-reaching), mismatching the bar.
- Naming a salary number in the first recruiter call before you know the level and the band; say you want to understand the role and level first (70.8).
- Scheduling your top-choice company first. Do two or three lower-stakes loops first so the method is warm when it matters.

#### Interview questions (for your own preparation)

1. **What is the job of a resume in this funnel?** To earn the recruiter screen by foregrounding quantified impact, scope and ownership — not to be a complete history.
2. **How do big-tech and startup loops differ, and how would you prepare for each?** Big tech is standardized and heavy on algorithms and system design with leveling; startups are practical and favor build-and-ship ability and breadth; prepare rigorously for algorithms/design for the former, lead with shipped impact and breadth for the latter.
3. **Why tailor project write-ups for senior roles?** They demonstrate design judgment and tradeoff thinking — exactly what senior/staff rounds probe — before the interview even starts.
4. **What should you ask the recruiter?** The number and type of rounds, the level being considered, who the interviewers are (team or pool), the language and environment for coding, and the timeline. Every answer changes how you prepare.
5. **How do you explain a gap or a short tenure?** In one honest sentence and a pivot to what you did or learned ("I took six months for family reasons and used part of it to build X"); interviewers care far more about the next five minutes than the gap.

#### Practical exercise

Rewrite three bullet points of your resume to lead with quantified impact and scope (latency, throughput, scale, cost, or team impact) instead of technologies, and draft a one-paragraph project write-up for your most significant project covering the problem, a key design decision with its tradeoff, and the measurable outcome. Acceptance criteria: each bullet has a number and an outcome, and the write-up shows a tradeoff you reasoned about. Then record your two-minute "tell me about yourself" and play it back: it should stay under 2:15 and contain at least two numbers.

## 70.2 The coding round

### 70.2.1 The pattern catalogue and recognition cues

#### Concept

The coding round tests problem-solving with data structures and algorithms (Parts 8, 9). The practical key is that most problems are instances of a small set of **patterns** — two pointers, sliding window, BFS/DFS, heaps, dynamic programming, graphs, intervals, monotonic stack, union-find — and strong performance comes from recognizing which pattern a problem fits from its cues, then applying the known approach. This is a catalogue to internalize, each entry linked back to the structures and algorithms of Parts 8, 9.

#### Why does it exist?

Interview coding problems are drawn from a finite set of techniques; the difficulty is usually recognizing which technique applies and executing it cleanly under time pressure, not inventing something novel. The pattern catalogue exists because recognition is learnable: once you have seen the cues for each pattern, you map a new problem to a known approach quickly, which is what separates candidates who solve smoothly from those who flail. It turns "solve this hard problem" into "recognize the pattern, apply the method".

#### Mental model

Imagine a doctor reading symptoms. A fever plus a rash plus recent travel narrows the field to a handful of diagnoses before any test is run. Coding problems have symptoms too: "contiguous", "at most K", "sorted", "nearest", "top K", "number of ways". Read the symptoms, name the likely diagnosis out loud, then confirm it with a small example before you commit to the treatment.

#### How it works — the catalogue with recognition cues

| Pattern | Recognition cues | Approach (link) |
|---|---|---|
| Two pointers | Sorted array/string; find a pair/triplet; converge from ends; in-place | Two indices moving toward/with each other (Part 9 — 9.7 Two pointers) |
| Sliding window | Contiguous subarray/substring; "longest/shortest/at most K"; running window | Expand/contract a window, track the window state (Part 9 — 9.8 Sliding window) |
| BFS | Shortest path in unweighted graph/grid; level-by-level; nearest | Queue, explore by levels (Part 8 — 8.6 Queue; Part 9 — 9.10 BFS) |
| DFS / backtracking | Explore all paths; permutations/combinations; tree traversal; "generate all" | Recursion/stack, backtrack (Part 9 — 9.9 Recursion, 2.11 DFS) |
| Heap / priority queue | "Top K", "K largest/smallest", "merge K", running median | A heap of size K or a min/max heap (Part 8 — 8.12 Heap, 1.13 Priority Queue) |
| Dynamic programming | Overlapping subproblems; "number of ways", "min/max cost", optimal substructure | Define state and recurrence; memoize or tabulate (Part 9 — 9.16 Dynamic programming) |
| Graphs | Nodes and edges; connectivity; cycles; dependencies; shortest path | BFS/DFS, Dijkstra, topological sort (Part 9 — 8.12 to 2.14) |
| Intervals | Ranges; "merge overlapping", "insert", "meeting rooms" | Sort by start, sweep, merge (Part 9 — 9.5 Sorting; 2.15 Greedy) |
| Monotonic stack | "Next greater/smaller element"; nearest boundary; histogram | A stack kept increasing/decreasing (Part 8 — 8.5 Stack) |
| Union-find | Connected components; "are these connected"; grouping; cycle detection in undirected | Disjoint-set with union by rank + path compression (Part 8 — 8.15 Graph) |
| Hashing | "Have I seen this"; counts; complements (two-sum); dedup | Hash map/set for O(1) lookup (Part 8 — 8.8 Hash Map, 1.9 Set) |
| Binary search | Sorted; "find the boundary"; "minimize the maximum"; monotonic predicate | Binary search on the value or index (Part 9 — 9.6 Binary search) |

The skill is reading a problem and matching its cues: "longest substring with at most K distinct" screams sliding window; "top K frequent" screams heap plus hashing; "shortest path in a grid" screams BFS; "number of ways to make change" screams DP; "next warmer temperature" screams monotonic stack; "are these accounts the same person" screams union-find. Each pattern maps to a structure or algorithm taught in Parts 8, 9 — this catalogue is the index into that knowledge for interview recognition.

#### How it works — reading complexity from the constraints

The input limits in the problem statement tell you which complexity the interviewer expects, because a typical judge or interviewer budget is around 10⁸ simple operations:

| Input size n | Feasible complexity | Usually means |
|---|---|---|
| ≤ 10 | O(n!) | Permutations, brute-force backtracking |
| ≤ 20 | O(2ⁿ) | Subsets, bitmask DP |
| ≤ 500 | O(n³) | Triple loops, interval DP |
| ≤ 5,000 | O(n²) | Pairwise comparisons, 2D DP |
| ≤ 10⁶ | O(n log n) or O(n) | Sorting, heaps, sliding window, hashing |
| > 10⁸ or "very large" | O(log n) or O(1) | Binary search, math |

If n is 10⁵ and your idea is O(n²), say so before coding: "that is 10¹⁰ operations, too slow; I need O(n log n), which suggests sorting or a heap." That one sentence is the complexity communication the senior bar expects (Part 9 — 9.25 The complexity cheat sheet).

#### How it works — a method for live solving

```text
Method for solving a coding problem live (narrate throughout):
  1. Clarify  -> restate the problem, ask about inputs, edge cases, constraints, examples
  2. Examples -> work a small example by hand to confirm understanding
  3. Approach -> name the pattern you recognize; state the approach and its complexity BEFORE coding
  4. Confirm  -> get the interviewer's buy-in on the approach before writing code
  5. Code     -> write clean code, narrating; handle edge cases
  6. Test     -> trace your code on the example and an edge case; fix bugs you find
  7. Complexity -> state the final time and space complexity and whether it can be improved
```

The two highest-value habits: state the approach and its complexity *before* coding (so the interviewer can redirect you if it is wrong, saving you from coding a dead end), and test your own code by tracing it (finding your own bugs is a strong signal). **Communicating complexity** correctly (Big-O, Part 9) at the start and end is expected at senior level — know the complexity of your approach and whether a better one exists.

#### How it works — TypeScript traps in a coding round

Most backend candidates code in TypeScript or JavaScript. The language has a few traps that cost people rounds:

- `[10, 9, 1].sort()` returns `[1, 10, 9]`: the default sort compares strings. Always pass a comparator, `(a, b) => a - b`.
- There is no built-in heap. Say so, then either write a 25-line binary heap, or (if the interviewer agrees) sort for O(n log n), or use bucket counting when values are bounded.
- `array.shift()` is O(n). A BFS queue built on `shift()` turns O(V + E) into O(V²) on big inputs; keep a head index instead.
- Recursion depth is limited to roughly 10,000 frames by default, so a DFS on a 100,000-node linked chain overflows; convert to an explicit stack.
- `Map` keeps insertion order and accepts any key type; plain objects coerce keys to strings, so `obj[1]` and `obj['1']` are the same key.
- Numbers are doubles: integers are exact only up to 2⁵³ − 1. Use `BigInt` for problems that multiply large values or ask for results modulo 10⁹ + 7 after big products.

#### How a Senior Backend Engineer thinks about this

A senior prepares the coding round by internalizing the pattern catalogue until recognition is fast, practicing the live-solving method until it is automatic, and drilling enough problems per pattern to execute cleanly under pressure — because the round rewards recognition plus clean execution plus communication, not raw cleverness. They always state the approach and complexity before coding and get buy-in, because coding the wrong approach silently is the most common way strong candidates fail. They test their own code by tracing it, communicate complexity precisely, and narrate throughout so the interviewer can follow and help. They treat the coding round as a learnable skill (recognition, method, execution) layered on the Parts 8, 9 fundamentals, not as a measure of their worth as an engineer.

#### Common mistakes

- Jumping to code before clarifying and before stating the approach, then coding a dead end.
- Not recognizing the pattern, trying to invent an approach from scratch.
- Silent coding, so the interviewer cannot follow or redirect.
- Not testing your own code or stating complexity.
- Preparing by reading solutions instead of solving problems (recognition and execution need practice).
- Grinding 500 random problems. Forty to sixty problems spread across the twelve patterns, each solved twice a week apart, builds more recognition than hundreds solved once.

#### Interview questions (for your preparation)

1. **What cues indicate a sliding-window problem versus a two-pointer problem?** Sliding window: contiguous subarray/substring with "longest/shortest/at most K". Two pointers: sorted data, finding a pair/triplet, converging from the ends.
2. **Why state your approach and complexity before coding?** So the interviewer can redirect a wrong approach before you waste time coding it, and to demonstrate you reason about efficiency up front.
3. **What does "top K" or "merge K" suggest?** A heap (priority queue) of size K, often combined with a hash map for counts.
4. **How do you test your code in an interview?** Trace it on the given example and an edge case, find and fix bugs yourself — a strong signal of rigor.
5. **You recognise no pattern at all. What now?** Say so, solve a tiny example by hand and watch what you do, write the brute force with its complexity, then ask which work is repeated. The repeated work usually reveals the pattern (a running count suggests a window, a repeated subproblem suggests DP).

#### Practical exercise

For ten varied coding problems (without solving them fully), practice only the recognition step: for each, name the pattern(s) from the catalogue and the cue that triggered it, and state the expected time/space complexity of that approach. Then fully solve three of them with the live-solving method, narrating and testing. Acceptance criteria: you correctly identify the pattern for at least eight of ten, and for the three you solve you state the approach and complexity before coding and test your own code.
