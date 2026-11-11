## 12.7 Level 4: hard variants

Level 4 problems are the hard end of a typical interview: two-dimensional dynamic programming, a trie, union-find, a greedy choice you must justify, a shortest path with an extra constraint, an O(n log n) trick, and a sliding window with bookkeeping. Interviewers rarely expect a perfect solution here in 45 minutes. They expect the method: a correct brute force, a clear explanation of what makes it slow, and real progress towards the better solution.

### 12.7.1 Diff two audit logs

Pattern: 2-D dynamic programming · Level 4

#### Practical exercise

Two services wrote audit logs for the same order, as lists of event names. Find the longest sequence of events that appears in **both** logs in the same order (not necessarily adjacent): the events they agree on. The rest is the diff. Each log has up to 2,000 events.

```text
a = [created, paid, packed, shipped, delivered]
b = [created, packed, paid, shipped, returned]
-> length 3, e.g. [created, packed, shipped]   ([created, paid, shipped] is equally long)
```

Hint: let `L[i][j]` be the answer for the first `i` events of `a` and the first `j` of `b`. What is `L[i][j]` when `a[i-1]` equals `b[j-1]`, and when it does not?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function commonEvents(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length, m = b.length, w = m + 1;
  const L = new Int32Array((n + 1) * w);                 // L[i * w + j], row 0 and column 0 are 0
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      L[i * w + j] = a[i - 1] === b[j - 1]
        ? L[(i - 1) * w + (j - 1)] + 1                   // match: extend the diagonal
        : Math.max(L[(i - 1) * w + j], L[i * w + (j - 1)]); // skip an event from a or from b
    }
  }
  const out: string[] = [];                               // walk back from the bottom-right corner
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.push(a[i - 1]); i--; j--; }
    else if (L[(i - 1) * w + j] >= L[i * w + (j - 1)]) i--;
    else j--;
  }
  return out.reverse();
}

const a = ['created', 'paid', 'packed', 'shipped', 'delivered'];
const b = ['created', 'packed', 'paid', 'shipped', 'returned'];
const common = commonEvents(a, b);
assert.equal(common.length, 3);
assert.equal(common[0], 'created');
assert.equal(common[2], 'shipped');
assert.deepEqual(commonEvents([], b), []);
assert.deepEqual(commonEvents(['x'], ['x']), ['x']);
```

Complexity: O(n · m) time and space: 4 million cells for two logs of 2,000, about 16 MB as an `Int32Array`. If only the length is needed, two rows are enough, O(m) space.

The trap: thinking greedily ("match each event of `a` with its next occurrence in `b`"), which fails as soon as an early match blocks a longer sequence later. The second trap is a nested `number[][]` built with `new Array(n).fill(new Array(m))`, which fills every row with the **same** array object. This longest common subsequence is the core of `diff` and of Git's line-level comparison (Part 52).

### 12.7.2 Product search autocomplete

Pattern: trie · Level 4

#### Practical exercise

Build an autocomplete index for product names. `add(name, popularity)` adds a product or updates its popularity. `suggest(prefix)` returns up to three product names that start with the prefix (ignoring case), most popular first, ties broken alphabetically. There are up to 10⁵ products and many more `suggest` calls than `add` calls.

```text
add("Sonic toothbrush", 900), add("Soap bar", 300), add("Sonic heads (4)", 900), add("Socks", 50)
suggest("so")  -> ["Sonic heads (4)", "Sonic toothbrush", "Soap bar"]
suggest("son") -> ["Sonic heads (4)", "Sonic toothbrush"]
suggest("x")   -> []
```

Hint: walking a trie to the prefix costs only the prefix length. Then you need the best three below that node.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

interface TrieNode { children: Map<string, TrieNode>; product?: { name: string; popularity: number } }

class Autocomplete {
  private root: TrieNode = { children: new Map() };

  add(name: string, popularity: number): void {
    let node = this.root;
    for (const ch of name.toLowerCase()) {
      let next = node.children.get(ch);
      if (!next) { next = { children: new Map() }; node.children.set(ch, next); }
      node = next;
    }
    node.product = { name, popularity };                 // re-adding updates popularity
  }

  suggest(prefix: string, limit = 3): string[] {
    let node: TrieNode | undefined = this.root;
    for (const ch of prefix.toLowerCase()) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    const found: Array<{ name: string; popularity: number }> = [];
    const stack: TrieNode[] = [node];                   // collect every product under the prefix
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.product) found.push(n.product);
      for (const child of n.children.values()) stack.push(child);
    }
    return found
      .sort((x, y) => y.popularity - x.popularity || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
      .slice(0, limit)
      .map((p) => p.name);
  }
}

const ac = new Autocomplete();
ac.add('Sonic toothbrush', 900); ac.add('Soap bar', 300); ac.add('Sonic heads (4)', 900); ac.add('Socks', 50);
assert.deepEqual(ac.suggest('so'), ['Sonic heads (4)', 'Sonic toothbrush', 'Soap bar']);
assert.deepEqual(ac.suggest('SON'), ['Sonic heads (4)', 'Sonic toothbrush']);
assert.deepEqual(ac.suggest('x'), []);
ac.add('Socks', 1000);                                   // popularity update
assert.equal(ac.suggest('so')[0], 'Socks');
```

Complexity: `add` is O(L) for a name of length L. `suggest` is O(P) to reach the prefix plus O(S log S) for the S products under it. For a one-letter prefix S can be most of the catalogue; the standard improvement for read-heavy autocomplete is to store the current top three at every node, updated on `add`, making `suggest` O(P).

The trap: storing the name only at the end node and recomputing case on every comparison, or lower-casing the stored name, which loses the display form. The second trap is not handling the update case, so re-adding a product creates a duplicate suggestion. Part 10 (10.14) covers tries; at production scale this becomes a search engine's completion suggester or PostgreSQL `pg_trgm` (Part 11, 11.21).

### 12.7.3 The link that created a loop

Pattern: union-find · Level 4

#### Practical exercise

Network links between `n` switches are added one at a time. A loop (a cycle) causes broadcast storms, so the provisioning tool must report the **first** link whose two ends were already connected through earlier links. Return that link, or `null`. Up to 10⁵ switches and links.

```text
n = 5, links = [[0, 1], [1, 2], [3, 4], [2, 0], [2, 3]]  -> [2, 0]
n = 3, links = [[0, 1], [1, 2]]                          -> null
```

Hint: you need to answer "are these two already connected?" and "connect them" quickly, many times, as links arrive.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

class DisjointSet {
  private parent: Int32Array;
  private size: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
    this.size = new Int32Array(n).fill(1);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {                    // path compression, iterative
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): boolean {
    let ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;                         // already connected
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;                                // attach the smaller tree under the larger
    this.size[ra] += this.size[rb];
    return true;
  }
}

function firstLoopLink(n: number, links: ReadonlyArray<[number, number]>): [number, number] | null {
  const ds = new DisjointSet(n);
  for (const link of links) if (!ds.union(link[0], link[1])) return link;
  return null;
}

assert.deepEqual(firstLoopLink(5, [[0, 1], [1, 2], [3, 4], [2, 0], [2, 3]]), [2, 0]);
assert.equal(firstLoopLink(3, [[0, 1], [1, 2]]), null);
assert.deepEqual(firstLoopLink(2, [[0, 1], [1, 0]]), [1, 0]);
const chain = Array.from({ length: 99_999 }, (_, i): [number, number] => [i, i + 1]);
assert.equal(firstLoopLink(100_000, chain), null);
```

Complexity: nearly O(1) amortised per link with path compression and union by size (the inverse Ackermann function, below 5 for any realistic n), so about O(n + e) overall; O(n) space.

The trap: running a fresh BFS or DFS after every new link to test connectivity: O(e · (n + e)) in total, 10¹⁰ steps at this size. The second trap is a recursive `find`, which can overflow the stack on a long chain before compression has flattened it. Part 74 (74.2.3) uses the same structure for identity resolution.

### 12.7.4 Most maintenance jobs in one night

Pattern: greedy · Level 4

#### Practical exercise

Teams request maintenance jobs on a shared database, each as `[start, end)` minutes within the maintenance night. Jobs cannot overlap. Choose the largest possible number of jobs and return their ids. Explain why your choice is optimal. Up to 10⁵ requests.

```text
j1 [0, 60)  j2 [30, 90)  j3 [60, 120)  j4 [90, 100)  j5 [100, 180)
-> 3 jobs, for example [j1, j4, j5]
```

Hint: which job should go first so that it leaves the most room for the others?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

interface Job { id: string; start: number; end: number }

function maxJobs(jobs: readonly Job[]): string[] {
  const byEnd = [...jobs].sort((a, b) => a.end - b.end || a.start - b.start);
  const chosen: string[] = [];
  let freeFrom = -Infinity;
  for (const job of byEnd) {
    if (job.start >= freeFrom) {                         // fits after the last chosen job
      chosen.push(job.id);
      freeFrom = job.end;
    }
  }
  return chosen;
}

const jobs: Job[] = [
  { id: 'j1', start: 0, end: 60 }, { id: 'j2', start: 30, end: 90 }, { id: 'j3', start: 60, end: 120 },
  { id: 'j4', start: 90, end: 100 }, { id: 'j5', start: 100, end: 180 },
];
assert.deepEqual(maxJobs(jobs), ['j1', 'j4', 'j5']);
assert.deepEqual(maxJobs([]), []);
// Earliest START fails here: one long job blocks two short ones.
assert.deepEqual(maxJobs([{ id: 'long', start: 0, end: 100 }, { id: 'a', start: 10, end: 20 }, { id: 'b', start: 30, end: 40 }]), ['a', 'b']);
```

Complexity: O(n log n) for the sort, O(n) for the scan.

Why the greedy choice is optimal (the argument an interviewer wants): take any optimal schedule and look at its first job. The job that ends earliest overall ends no later than that one, so swapping it in keeps the schedule valid and the same size. Repeat for the rest. So "always take the job that ends first among those that fit" can never do worse than optimal. This is called an **exchange argument**.

The trap: sorting by start time or by shortest duration. Earliest start fails on the last test; shortest duration fails when a short job straddles two longer compatible jobs. Greedy algorithms need a proof or at least a search for counterexamples (12.6.8 showed one that fails).

### 12.7.5 Cheapest courier route with few hand-offs

Pattern: graph, bounded relaxation · Level 4

#### Practical exercise

A parcel must travel from hub `src` to hub `dst`. Courier legs are directed, each with a cost in cents. Every intermediate hub is a hand-off, and each hand-off risks loss, so the route may use **at most `k` hand-offs** (at most `k + 1` legs). Return the cheapest cost, or `-1`. Up to 100 hubs and 5,000 legs.

```text
legs: A->B 100, B->C 100, A->C 500, C->D 100, B->D 600
src A, dst D, k = 1 -> 600   (A->C->D; the cheaper A->B->C->D at 300 needs 2 hand-offs)
src A, dst D, k = 2 -> 300
```

Hint: Dijkstra minimises cost but ignores the number of legs. What if you relax every leg exactly `k + 1` times, one round per allowed leg?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

type Leg = [from: string, to: string, cents: number];

function cheapestWithHandoffs(legs: readonly Leg[], src: string, dst: string, k: number): number {
  let cost = new Map<string, number>([[src, 0]]);   // best cost using at most r legs, after round r
  for (let round = 0; round <= k; round++) {
    const next = new Map(cost);                      // copy: this round may add only ONE more leg
    for (const [from, to, cents] of legs) {
      const base = cost.get(from);                   // read from the PREVIOUS round only
      if (base === undefined) continue;
      if (base + cents < (next.get(to) ?? Infinity)) next.set(to, base + cents);
    }
    cost = next;
  }
  return cost.get(dst) ?? -1;
}

const legs: Leg[] = [['A', 'B', 100], ['B', 'C', 100], ['A', 'C', 500], ['C', 'D', 100], ['B', 'D', 600]];
assert.equal(cheapestWithHandoffs(legs, 'A', 'D', 1), 600);
assert.equal(cheapestWithHandoffs(legs, 'A', 'D', 2), 300);
assert.equal(cheapestWithHandoffs(legs, 'A', 'D', 0), -1);
assert.equal(cheapestWithHandoffs(legs, 'A', 'A', 0), 0);
```

Complexity: O((k + 1) · E) time, O(V) space: at most 101 × 5,000 relaxations here.

The trap: updating costs in place within a round. Then a leg relaxed early in the round can feed another leg in the same round, so one round can add several legs and the hand-off limit is silently broken; the copy (`next`) and reading from `cost` prevent it. The second trap is plain Dijkstra by cost, which finds the 300 route and cannot honour `k`. Without the limit, and with non-negative costs, Dijkstra (12.6.6) is the faster choice. This bounded relaxation is the Bellman-Ford algorithm cut off after `k + 1` rounds.

### 12.7.6 Longest rising run of order values

Pattern: dynamic programming with binary search · Level 4

#### Practical exercise

For a loyalty analysis, find the length of the longest sequence of a customer's orders (in date order, not necessarily consecutive) whose values strictly increase. A customer can have up to 10⁵ orders.

```text
values = [500, 300, 700, 400, 800, 600, 900]  -> 4   (e.g. 300, 400, 600, 900)
values = [500, 500, 500]                       -> 1
```

Hint: the O(n²) DP compares each order with every earlier one, which is 10¹⁰ steps here. Instead, keep for each length the smallest possible last value of a rising sequence of that length.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function longestRising(values: readonly number[]): number {
  // tails[len - 1] = smallest last value of any strictly rising sequence of length len. Always sorted.
  const tails: number[] = [];
  for (const v of values) {
    let lo = 0, hi = tails.length;                   // first index with tails[i] >= v (lower bound)
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1; else hi = mid;
    }
    tails[lo] = v;                                   // extend (lo === length) or improve a tail
  }
  return tails.length;
}

function slowOracle(values: readonly number[]): number {   // the O(n^2) DP, for testing
  const best = values.map(() => 1);
  for (let i = 0; i < values.length; i++)
    for (let j = 0; j < i; j++) if (values[j] < values[i]) best[i] = Math.max(best[i], best[j] + 1);
  return values.length ? Math.max(...best) : 0;
}

assert.equal(longestRising([500, 300, 700, 400, 800, 600, 900]), 4);
assert.equal(longestRising([500, 500, 500]), 1);
assert.equal(longestRising([]), 0);
for (let t = 0; t < 300; t++) {
  const arr = Array.from({ length: 15 }, () => Math.floor(Math.random() * 10));
  assert.equal(longestRising(arr), slowOracle(arr));
}
```

Complexity: O(n log n) time, O(n) space.

The trap: believing `tails` is itself a valid rising sequence. It is not; it only has the right **length**. Reconstructing the actual orders needs an extra array of predecessor indices. The second trap is `<=` instead of `<` in the binary search, which counts equal values as rising (the second example would return 3). This "patience sorting" idea is hard to invent under pressure; that is exactly why it is worth having practised once.

### 12.7.7 Smallest log window with every required code

Pattern: variable sliding window with counts · Level 4

#### Practical exercise

During an incident you want the shortest stretch of consecutive log entries that contains every code on a checklist, with multiplicity (if the checklist has `E_DB` twice, the window needs two `E_DB` entries). Return the `[start, end]` indices (inclusive) of the shortest such window, the earliest if several tie, or `null`. Up to 10⁶ log entries.

```text
log = [E_AUTH, E_DB, E_TIMEOUT, E_AUTH, E_CACHE, E_DB, E_TIMEOUT]
required = [E_DB, E_TIMEOUT, E_CACHE]   -> [4, 6]   (E_CACHE, E_DB, E_TIMEOUT)
required = [E_DB, E_DB]                 -> [1, 5]
```

Hint: track how many required items are still missing. Grow on the right until none are missing, then shrink on the left as long as none are.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function smallestWindow(log: readonly string[], required: readonly string[]): [number, number] | null {
  if (required.length === 0) return null;
  const need = new Map<string, number>();
  for (const code of required) need.set(code, (need.get(code) ?? 0) + 1);
  let missing = required.length;                     // required items not yet covered by the window
  let best: [number, number] | null = null;
  let left = 0;
  for (let right = 0; right < log.length; right++) {
    const inCode = log[right];
    if (need.has(inCode)) {
      const n = need.get(inCode)!;
      if (n > 0) missing--;                          // this entry covers something still needed
      need.set(inCode, n - 1);                       // may go negative: surplus copies
    }
    while (missing === 0) {                          // valid window: record, then try to shrink
      if (!best || right - left < best[1] - best[0]) best = [left, right];
      const outCode = log[left++];
      if (need.has(outCode)) {
        const n = need.get(outCode)! + 1;
        need.set(outCode, n);
        if (n > 0) missing++;                        // removed a copy we actually needed
      }
    }
  }
  return best;
}

const log = ['E_AUTH', 'E_DB', 'E_TIMEOUT', 'E_AUTH', 'E_CACHE', 'E_DB', 'E_TIMEOUT'];
assert.deepEqual(smallestWindow(log, ['E_DB', 'E_TIMEOUT', 'E_CACHE']), [4, 6]);
assert.deepEqual(smallestWindow(log, ['E_DB', 'E_DB']), [1, 5]);
assert.equal(smallestWindow(log, ['E_DISK']), null);
assert.deepEqual(smallestWindow(['E_X'], ['E_X']), [0, 0]);
```

Complexity: O(n + r) time for n log entries and r required codes; O(r) space.

The trap: checking "is the window valid?" by comparing two whole maps on every step, which is O(r) per step and O(n · r) overall. The single `missing` counter makes the check O(1). The second trap is multiplicity: counting only distinct codes accepts a window with one `E_DB` when two are required. Compare 12.5.3: the same grow-then-shrink skeleton, with richer bookkeeping.

#### Interview questions

1. **How do you recognise a 2-D DP problem?** Two sequences or a grid, and a subproblem defined by a prefix of each (or a cell); the answer for `(i, j)` depends on a few neighbouring cells.
2. **What makes union-find nearly constant time?** Path compression and union by size or rank keep trees almost flat; the amortised cost is the inverse Ackermann function.
3. **How do you justify a greedy algorithm in an interview?** An exchange argument: show the greedy choice can replace the first choice of any optimal solution without making it worse.
4. **Why copy the cost table each round in the hand-off-limited route?** So each round extends routes by exactly one leg; updating in place lets one round add several legs.
5. **Is the `tails` array in the O(n log n) longest-rising algorithm an actual subsequence?** No; it only tracks, for each length, the smallest possible tail. Reconstruction needs predecessor links.
