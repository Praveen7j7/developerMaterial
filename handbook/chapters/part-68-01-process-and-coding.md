# Part 68 — The Interview Playbook

This Part is the strategic companion to the technical Parts: how the backend engineering hiring process actually works and how to navigate it. Part 45 already covers candidate-side Q&A for Parts 1 to 50, behavioural questions and three mock loops, so we do not repeat those; this Part covers the process end to end (resume, screens, how loops differ across company types), the coding round as a pattern catalogue with a live-solving method, the system design round as a timed procedure, the other round types, the staff/principal loop, interview Q&A for the new Parts 51 to 66, and offers and negotiation. Read it as the map of the whole journey, with the technical Parts as the territory.

The voice here is a hiring manager and interviewer who has sat on both sides of hundreds of loops. The advice is practical and honest: interviews are a skill separate from the job, learnable with preparation, and most strong engineers under-perform not from lack of knowledge but from lack of a method under pressure. This Part gives you the methods.

## 68.1 The hiring process and company types

### 68.1.1 Resumes, project write-ups, the recruiter screen, and how loops differ

#### Concept

The hiring process is a funnel: a resume and project write-up get you a recruiter screen, which gets you a technical screen, which gets you an onsite loop of several rounds, which gets you an offer. The shape differs by company type — big tech, product startups, services/consultancies, and remote-first companies each weight the stages differently and look for different signals. Knowing the funnel and tailoring to the company type is the strategic layer beneath the technical preparation.

#### Why does it exist?

Companies cannot deeply assess every applicant, so they filter progressively: cheap signals first (resume), then increasingly expensive assessments (screens, then a full loop). Each stage exists to decide whether the next, more expensive stage is worth it. Understanding this lets you optimize for the signal each stage actually wants, rather than treating every stage the same — a resume's job is to earn the screen, not to tell your life story; the screen's job is to earn the loop.

#### How it works — the funnel and the artifacts

```text
Resume + project write-ups  ->  Recruiter screen  ->  Technical screen  ->  Onsite loop  ->  Offer
   (earn the screen)            (fit, logistics)      (one filter round)    (several rounds)   (decision)
```

- **Resume**: for a backend role, it should foreground impact and scope, not just technologies. "Reduced checkout p99 from 400ms to 90ms by adding cache-aside and fixing an N+1" beats "worked with Redis and PostgreSQL". Quantify (throughput, latency, scale, cost, team size), show ownership, and keep it concise (one page for most, two for very senior). The resume's only job is to earn the screen.
- **Project write-ups**: for senior/staff roles especially, a short write-up of a significant project — the problem, your design decisions and tradeoffs, the outcome with numbers, and what you would do differently — demonstrates the judgment the interview will probe. This is where you show the thinking Parts 40 to 66 teach.
- **Recruiter screen**: largely fit and logistics (role, level, compensation range, timeline, motivation). Be clear about what you want and ready to summarize your experience in two minutes. This is also your chance to learn the loop's structure so you can prepare for it.
- **Technical screen**: usually one coding or one design round as a filter before the full loop. Treat it as seriously as the onsite — it is the gate.

#### How loops differ by company type

| Company type | Emphasis | What to expect |
|---|---|---|
| Big tech | Standardized, rigorous; heavy on algorithms (coding) and system design; leveling matters | Multiple coding rounds, a design round, behavioural; a calibrated bar and committee |
| Product startup | Practical; can-you-build-and-ship; may favor take-homes or practical rounds | Fewer, more applied rounds; culture/fit weighs heavily; broad scope expected |
| Services / consultancy | Breadth across technologies, client-facing skills, delivery | Practical assessment, communication, sometimes domain-specific |
| Remote-first | Strong written communication, autonomy, async collaboration; often take-homes | Written exercises, practical rounds, emphasis on self-direction and clear writing |

Big tech loops reward deep algorithm and system-design preparation and clear leveling signals; startups reward demonstrated ability to build and ship broadly; services companies reward breadth and client skills; remote-first companies reward written communication and autonomy. Tailor your preparation and your framing to the type: lead with shipped impact and breadth for a startup, with rigorous algorithm and design preparation for big tech, with clear writing for remote-first.

#### How a Senior Backend Engineer thinks about this

A senior treats interviewing as a distinct skill and the process as a funnel to optimize stage by stage: a resume that leads with quantified impact and scope to earn the screen, project write-ups that showcase design judgment for senior roles, and preparation tailored to the company type's actual emphasis. They research each company's loop structure (often from the recruiter) and prepare accordingly rather than preparing generically. They are honest with themselves about level: applying and interviewing at the right level matters, because the bar and the expected signals differ sharply between senior, staff and principal (Part 44). They know strong engineers often under-perform in interviews from poor method under pressure, so they practice the methods (coding, design) deliberately, not just the knowledge.

#### Common mistakes

- A resume listing technologies instead of quantified impact and scope.
- Treating the technical screen as less important than the onsite (it is the gate).
- Preparing generically instead of for the specific company type's emphasis.
- Not researching the loop structure, so you are surprised by the rounds.
- Interviewing at the wrong level (over- or under-reaching), mismatching the bar.

#### Interview questions (for your own preparation)

1. **What is the job of a resume in this funnel?** To earn the recruiter screen by foregrounding quantified impact, scope and ownership — not to be a complete history.
2. **How do big-tech and startup loops differ, and how would you prepare for each?** Big tech is standardized and heavy on algorithms and system design with leveling; startups are practical and favor build-and-ship ability and breadth; prepare rigorously for algorithms/design for the former, lead with shipped impact and breadth for the latter.
3. **Why tailor project write-ups for senior roles?** They demonstrate design judgment and tradeoff thinking — exactly what senior/staff rounds probe — before the interview even starts.

#### Practical exercise

Rewrite three bullet points of your resume to lead with quantified impact and scope (latency, throughput, scale, cost, or team impact) instead of technologies, and draft a one-paragraph project write-up for your most significant project covering the problem, a key design decision with its tradeoff, and the measurable outcome. Acceptance criteria: each bullet has a number and an outcome, and the write-up shows a tradeoff you reasoned about.

## 68.2 The coding round

### 68.2.1 The pattern catalogue and recognition cues

#### Concept

The coding round tests problem-solving with data structures and algorithms (Parts 1 and 2). The practical key is that most problems are instances of a small set of **patterns** — two pointers, sliding window, BFS/DFS, heaps, dynamic programming, graphs, intervals, monotonic stack, union-find — and strong performance comes from recognizing which pattern a problem fits from its cues, then applying the known approach. This is a catalogue to internalize, each entry linked back to the structures and algorithms of Parts 1 and 2.

#### Why does it exist?

Interview coding problems are drawn from a finite set of techniques; the difficulty is usually recognizing which technique applies and executing it cleanly under time pressure, not inventing something novel. The pattern catalogue exists because recognition is learnable: once you have seen the cues for each pattern, you map a new problem to a known approach quickly, which is what separates candidates who solve smoothly from those who flail. It turns "solve this hard problem" into "recognize the pattern, apply the method".

#### How it works — the catalogue with recognition cues

| Pattern | Recognition cues | Approach (link) |
|---|---|---|
| Two pointers | Sorted array/string; find a pair/triplet; converge from ends; in-place | Two indices moving toward/with each other (Part 2) |
| Sliding window | Contiguous subarray/substring; "longest/shortest/at most K"; running window | Expand/contract a window, track the window state (Part 2) |
| BFS | Shortest path in unweighted graph/grid; level-by-level; nearest | Queue, explore by levels (Part 1 graph, Part 2) |
| DFS / backtracking | Explore all paths; permutations/combinations; tree traversal; "generate all" | Recursion/stack, backtrack (Part 2) |
| Heap / priority queue | "Top K", "K largest/smallest", "merge K", running median | A heap of size K or a min/max heap (Part 1) |
| Dynamic programming | Overlapping subproblems; "number of ways", "min/max cost", optimal substructure | Define state and recurrence; memoize or tabulate (Part 2) |
| Graphs | Nodes and edges; connectivity; cycles; dependencies; shortest path | BFS/DFS, Dijkstra, topological sort (Part 2) |
| Intervals | Ranges; "merge overlapping", "insert", "meeting rooms" | Sort by start, sweep, merge (Part 2) |
| Monotonic stack | "Next greater/smaller element"; nearest boundary; histogram | A stack kept increasing/decreasing (Part 1) |
| Union-find | Connected components; "are these connected"; grouping; cycle detection in undirected | Disjoint-set with union by rank + path compression (Part 1) |
| Hashing | "Have I seen this"; counts; complements (two-sum); dedup | Hash map/set for O(1) lookup (Part 1) |
| Binary search | Sorted; "find the boundary"; "minimize the maximum"; monotonic predicate | Binary search on the value or index (Part 2) |

The skill is reading a problem and matching its cues: "longest substring with at most K distinct" screams sliding window; "top K frequent" screams heap plus hashing; "shortest path in a grid" screams BFS; "number of ways to make change" screams DP; "next warmer temperature" screams monotonic stack; "are these accounts the same person" screams union-find. Each pattern maps to a structure or algorithm taught in Parts 1 and 2 — this catalogue is the index into that knowledge for interview recognition.

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

The two highest-value habits: state the approach and its complexity *before* coding (so the interviewer can redirect you if it is wrong, saving you from coding a dead end), and test your own code by tracing it (finding your own bugs is a strong signal). **Communicating complexity** correctly (Big-O, Part 2) at the start and end is expected at senior level — know the complexity of your approach and whether a better one exists.

#### How a Senior Backend Engineer thinks about this

A senior prepares the coding round by internalizing the pattern catalogue until recognition is fast, practicing the live-solving method until it is automatic, and drilling enough problems per pattern to execute cleanly under pressure — because the round rewards recognition plus clean execution plus communication, not raw cleverness. They always state the approach and complexity before coding and get buy-in, because coding the wrong approach silently is the most common way strong candidates fail. They test their own code by tracing it, communicate complexity precisely, and narrate throughout so the interviewer can follow and help. They treat the coding round as a learnable skill (recognition, method, execution) layered on the Part 1 and 2 fundamentals, not as a measure of their worth as an engineer.

#### Common mistakes

- Jumping to code before clarifying and before stating the approach, then coding a dead end.
- Not recognizing the pattern, trying to invent an approach from scratch.
- Silent coding, so the interviewer cannot follow or redirect.
- Not testing your own code or stating complexity.
- Preparing by reading solutions instead of solving problems (recognition and execution need practice).

#### Interview questions (for your preparation)

1. **What cues indicate a sliding-window problem versus a two-pointer problem?** Sliding window: contiguous subarray/substring with "longest/shortest/at most K". Two pointers: sorted data, finding a pair/triplet, converging from the ends.
2. **Why state your approach and complexity before coding?** So the interviewer can redirect a wrong approach before you waste time coding it, and to demonstrate you reason about efficiency up front.
3. **What does "top K" or "merge K" suggest?** A heap (priority queue) of size K, often combined with a hash map for counts.
4. **How do you test your code in an interview?** Trace it on the given example and an edge case, find and fix bugs yourself — a strong signal of rigor.

#### Practical exercise

For ten varied coding problems (without solving them fully), practice only the recognition step: for each, name the pattern(s) from the catalogue and the cue that triggered it, and state the expected time/space complexity of that approach. Then fully solve three of them with the live-solving method, narrating and testing. Acceptance criteria: you correctly identify the pattern for at least eight of ten, and for the three you solve you state the approach and complexity before coding and test your own code.
