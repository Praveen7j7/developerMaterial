## 12.6 Level 3: combining ideas

Level 3 is the core of most interviews. Each problem combines two ideas: counting plus a heap, sorting plus a sweep, binary search plus a greedy check, prefix sums plus a hash map, a graph plus a queue. If you can solve these within 30 to 40 minutes while explaining your reasoning, you are ready for most backend coding rounds.

### 12.6.1 Top K failing endpoints

Pattern: heap, top-k · Level 3

#### Practical exercise

You receive a stream of failed requests, each tagged with its endpoint (`"POST /orders"`). Return the `k` endpoints with the most failures, most failures first; break ties by endpoint name, alphabetically. There can be 10⁶ failures across 10⁵ endpoints, and k is small (say 10).

```text
failures = [POST /orders, GET /cart, POST /orders, GET /cart, POST /pay], k = 2
-> ["GET /cart", "POST /orders"]   (both 2; tie broken alphabetically)
```

Hint: count first. Then you do not need to sort all 10⁵ endpoints to find the best 10.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

// A small binary min-heap. compare(a, b) < 0 means a comes out first.
export class MinHeap<T> {
  private items: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}
  get size(): number { return this.items.length; }
  peek(): T | undefined { return this.items[0]; }
  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {                                     // sift up
      const parent = (i - 1) >> 1;
      if (this.compare(a[i], a[parent]) >= 0) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {                                        // sift down
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.compare(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.compare(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

type Entry = [endpoint: string, count: number];

function topFailing(failures: readonly string[], k: number): string[] {
  const counts = new Map<string, number>();
  for (const e of failures) counts.set(e, (counts.get(e) ?? 0) + 1);

  // Keep the k best in a heap whose root is the WORST of them, so it is cheap to evict.
  const worse = (a: Entry, b: Entry) => a[1] - b[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0);
  const heap = new MinHeap<Entry>(worse);
  for (const entry of counts) {
    heap.push(entry);
    if (heap.size > k) heap.pop();                      // drop the worst; heap never exceeds k
  }
  const result: string[] = [];
  while (heap.size > 0) result.push(heap.pop()![0]);    // comes out worst first
  return result.reverse();
}

const f = ['POST /orders', 'GET /cart', 'POST /orders', 'GET /cart', 'POST /pay'];
assert.deepEqual(topFailing(f, 2), ['GET /cart', 'POST /orders']);
assert.deepEqual(topFailing(f, 5), ['GET /cart', 'POST /orders', 'POST /pay']);
assert.deepEqual(topFailing([], 3), []);
```

Complexity: O(n) to count n failures, O(m log k) for m endpoints through a heap of size k, O(m) space for the counts. Sorting all endpoints would be O(m log m); for m = 10⁵ and k = 10 the heap does a fraction of the work.

The trap: building a **max**-heap of everything and popping k times. It works, but it is O(m log m) and misses the point; the min-heap of size k is the pattern. The second trap is the tie-break: interviewers often add it to see whether your comparator handles equal counts consistently. Part 10 (10.12) explains the heap itself; in production, the same top-k query is usually a `GROUP BY ... ORDER BY count DESC LIMIT 10` or a Redis sorted set (Part 30).

### 12.6.2 Free slots in a technician's day

Pattern: sorting, intervals · Level 3

#### Practical exercise

A repair technician works from `dayStart` to `dayEnd` (minutes from midnight). Bookings are `[start, end)` ranges, unsorted, and may overlap each other or extend outside working hours. Return every free gap inside working hours that is at least `minLength` minutes long, in order, so the booking page can offer slots.

```text
day = [540, 1080] (09:00 to 18:00), minLength = 60
bookings = [[600, 660], [630, 720], [900, 960], [1050, 1200]]
-> [[540, 600], [720, 900], [960, 1050]]
```

Hint: sort by start, then walk through the day with a cursor that says "free from here".

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

type Range = [start: number, end: number];

function freeSlots(dayStart: number, dayEnd: number, bookings: readonly Range[], minLength: number): Range[] {
  const sorted = [...bookings].sort((a, b) => a[0] - b[0]);
  const gaps: Range[] = [];
  let cursor = dayStart;                                  // everything before cursor is accounted for
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;                          // ends before the free point: ignore
    if (start >= dayEnd) break;                           // starts after the working day
    if (start - cursor >= minLength) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);                       // overlapping bookings extend the busy run
  }
  if (dayEnd - cursor >= minLength) gaps.push([cursor, dayEnd]);
  return gaps;
}

assert.deepEqual(
  freeSlots(540, 1080, [[600, 660], [630, 720], [900, 960], [1050, 1200]], 60),
  [[540, 600], [720, 900], [960, 1050]],
);
assert.deepEqual(freeSlots(540, 1080, [], 60), [[540, 1080]]);
assert.deepEqual(freeSlots(540, 1080, [[500, 1100]], 30), []);
assert.deepEqual(freeSlots(540, 600, [[550, 560]], 30), [[560, 600]]);
```

Complexity: O(n log n) for the sort, O(n) for the sweep.

The trap: `cursor = end` instead of `Math.max(cursor, end)`. A short booking that lies inside a longer one would move the cursor backwards and report a gap that is actually busy. The second trap is ignoring bookings that start before the day, which the `end <= cursor` check handles by clipping. In production this computation usually runs in SQL with range types and the `-` operator on multiranges in PostgreSQL 14 and later, but the interview wants the sweep.

### 12.6.3 Smallest nightly export capacity

Pattern: binary search on the answer · Level 3

#### Practical exercise

A reporting system must run a list of export jobs **in order**. Job `i` processes `rows[i]` rows and cannot be split across nights. Each night the database can process at most `C` rows. Find the smallest `C` that finishes every job within `D` nights. Row counts go up to 10⁹ and there are up to 10⁵ jobs.

```text
rows = [300, 500, 200, 400, 100], D = 3  -> 700   ([300] [500, 200] [400, 100])
rows = [300, 500, 200, 400, 100], D = 5  -> 500   (one job per night)
```

Hint: if capacity `C` works, so does every larger capacity. That monotonic yes/no is what binary search needs.

#### Worked answer to the exercise

Check the first example by hand before coding: with `C = 700`, the nights are `[300]`, `[500, 200]`, `[400, 100]`: three nights. With `C = 600`: `[300]`, `[500]`, `[200, 400]`, `[100]`: four nights, too many. With `C = 650`: `[300]`, `[500]`, `[200, 400]`, `[100]`, still four. The answer is 700. Working an example by hand before coding, as here, is step 2 of the method and catches a wrong expected value before it becomes a wrong test.

```ts
import assert from 'node:assert/strict';

function nightsNeeded(rows: readonly number[], capacity: number): number {
  let nights = 1;
  let used = 0;
  for (const r of rows) {
    if (used + r > capacity) { nights++; used = 0; }    // start a new night
    used += r;
  }
  return nights;
}

function smallestCapacity(rows: readonly number[], days: number): number {
  if (rows.length === 0) return 0;
  let lo = Math.max(...rows);                           // must fit the biggest single job
  let hi = rows.reduce((a, b) => a + b, 0);             // everything in one night always works
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (nightsNeeded(rows, mid) <= days) hi = mid;      // works: try smaller
    else lo = mid + 1;                                  // too small
  }
  return lo;
}

assert.equal(smallestCapacity([300, 500, 200, 400, 100], 3), 700);
assert.equal(smallestCapacity([300, 500, 200, 400, 100], 5), 500);
assert.equal(smallestCapacity([300, 500, 200, 400, 100], 1), 1500);
assert.equal(smallestCapacity([1_000_000_000, 1_000_000_000], 1), 2_000_000_000);
```

Complexity: O(n log S), where S is the sum of rows: at most about 47 iterations for sums up to 10¹⁴, each an O(n) greedy check.

The trap: starting `lo` at 1. A capacity smaller than the largest job can never work, and the greedy check would count a new night for every job without detecting it. Starting at the largest job makes every candidate feasible in principle. (`Math.max(...rows)` is also a trap for very large arrays, because spreading 10⁵ or more arguments can exceed the engine's argument limit; use a loop or `reduce` there.) The pattern, "binary search the answer, check each candidate greedily", also sizes worker pools and rate limits.

### 12.6.4 Day ranges with a given net balance

Pattern: prefix sums with hashing · Level 3

#### Practical exercise

A wallet's daily net change is a list of integers (deposits positive, refunds and spending negative). Count how many runs of consecutive days have a net change of exactly `k`. n is up to 10⁵.

```text
change = [300, -100, 200, -200, 100, 300], k = 300  -> 4   (days 0, 0-4, 1-5 and 5)
change = [1, -1, 1, -1], k = 0                      -> 4
```

Hint: a run from day `i` to day `j` sums to `prefix[j + 1] - prefix[i]`. For each `j`, how many earlier prefixes equal `prefix[j + 1] - k`?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function countRunsWithNet(change: readonly number[], k: number): number {
  const seen = new Map<number, number>([[0, 1]]);   // prefix value -> how many times seen; empty prefix
  let prefix = 0;
  let count = 0;
  for (const c of change) {
    prefix += c;
    count += seen.get(prefix - k) ?? 0;             // every earlier prefix that leaves exactly k
    seen.set(prefix, (seen.get(prefix) ?? 0) + 1);
  }
  return count;
}

function bruteForce(change: readonly number[], k: number): number {
  let count = 0;
  for (let i = 0; i < change.length; i++) {
    let sum = 0;
    for (let j = i; j < change.length; j++) if ((sum += change[j]) === k) count++;
  }
  return count;
}

assert.equal(countRunsWithNet([300, -100, 200, -200, 100, 300], 300), 4);
assert.equal(countRunsWithNet([1, -1, 1, -1], 0), 4);
assert.equal(countRunsWithNet([], 0), 0);
for (let t = 0; t < 200; t++) {                      // the brute force as a test oracle
  const arr = Array.from({ length: 12 }, () => Math.floor(Math.random() * 11) - 5);
  assert.equal(countRunsWithNet(arr, 3), bruteForce(arr, 3));
}
```

Complexity: O(n) time, O(n) space.

The trap: reaching for a sliding window. With negative values, shrinking the window does not reliably reduce the sum (12.5.3), so the window approach gives wrong counts. The second trap is forgetting the `[0, 1]` seed, which misses every run that starts on day 0. Notice the random test: the slow brute force from step 3 of the method is the best test oracle you will ever have.

### 12.6.5 Deploy waves

Pattern: topological sort · Level 3

#### Practical exercise

A platform deploys services in **waves**: all services in a wave go out in parallel, and a service may only be in a wave after every service it depends on has gone out in an earlier wave. Given each service's dependencies, return the waves (each wave sorted alphabetically), using as few waves as possible. If the dependencies contain a cycle, throw an error naming the services involved.

```text
orders: [users, payments]   payments: [users]   users: []   notifications: [orders]   search: []
-> [["search", "users"], ["payments"], ["orders"], ["notifications"]]
```

Hint: a service is ready when its count of undeployed dependencies reaches zero. Process ready services level by level.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function deployWaves(deps: Readonly<Record<string, readonly string[]>>): string[][] {
  const services = Object.keys(deps);
  const pending = new Map<string, number>();            // service -> undeployed dependency count
  const dependents = new Map<string, string[]>();       // dependency -> services waiting on it
  for (const s of services) { pending.set(s, 0); dependents.set(s, []); }
  for (const s of services) {
    for (const d of deps[s]) {
      if (!pending.has(d)) throw new Error(`${s} depends on unknown service ${d}`);
      pending.set(s, pending.get(s)! + 1);
      dependents.get(d)!.push(s);
    }
  }

  const waves: string[][] = [];
  let ready = services.filter((s) => pending.get(s) === 0);
  let deployed = 0;
  while (ready.length > 0) {
    ready.sort();
    waves.push(ready);
    deployed += ready.length;
    const next: string[] = [];
    for (const s of ready) {
      for (const t of dependents.get(s)!) {
        const left = pending.get(t)! - 1;
        pending.set(t, left);
        if (left === 0) next.push(t);                   // all of t's dependencies are out
      }
    }
    ready = next;
  }
  if (deployed < services.length) {
    const stuck = services.filter((s) => pending.get(s)! > 0).sort();
    throw new Error(`dependency cycle among: ${stuck.join(', ')}`);
  }
  return waves;
}

assert.deepEqual(
  deployWaves({ orders: ['users', 'payments'], payments: ['users'], users: [], notifications: ['orders'], search: [] }),
  [['search', 'users'], ['payments'], ['orders'], ['notifications']],
);
assert.throws(() => deployWaves({ a: ['b'], b: ['c'], c: ['a'], d: [] }), /cycle among: a, b, c/);
assert.deepEqual(deployWaves({}), []);
```

Complexity: O(V + E) for V services and E dependency edges (plus sorting within waves).

The trap: detecting a cycle only by "the recursion never ends" in a DFS version, or not at all. Kahn's algorithm makes it simple: if some services never reach zero pending dependencies, they are in or behind a cycle. The "stuck" list can include services that merely depend on the cycle (they are blocked too); for a precise cycle, run a DFS on the stuck set. Part 11 (11.14 and 11.22) covers topological sorting and dependency resolution in production.

### 12.6.6 Lowest-latency route

Pattern: shortest path (Dijkstra) · Level 3

#### Practical exercise

Traffic between regions travels over directed links, each with a measured latency in milliseconds (all non-negative). Given the links, a source region and a target region, return the lowest total latency and the route, or `null` if the target is unreachable. Up to 10⁴ regions and 10⁵ links.

```text
links: gw->bom 30, gw->del 10, del->bom 15, bom->sin 40, del->sin 80
from gw to sin -> { latency: 65, route: ["gw", "del", "bom", "sin"] }
```

Hint: always extend the cheapest route found so far. Reuse the `MinHeap` from 12.6.1.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';
// MinHeap<T> is the class from 12.6.1.

type Link = [from: string, to: string, ms: number];

function lowestLatency(links: readonly Link[], source: string, target: string) {
  const adj = new Map<string, Array<[string, number]>>();
  for (const [a, b, ms] of links) {
    if (ms < 0) throw new Error('Dijkstra needs non-negative weights');
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push([b, ms]);
  }
  const best = new Map<string, number>([[source, 0]]);
  const prev = new Map<string, string>();
  const heap = new MinHeap<[string, number]>((x, y) => x[1] - y[1]);
  heap.push([source, 0]);

  while (heap.size > 0) {
    const [node, dist] = heap.pop()!;
    if (dist > (best.get(node) ?? Infinity)) continue;  // stale entry: a shorter route was found later
    if (node === target) break;                          // first time the target is popped, it is final
    for (const [next, ms] of adj.get(node) ?? []) {
      const candidate = dist + ms;
      if (candidate < (best.get(next) ?? Infinity)) {
        best.set(next, candidate);
        prev.set(next, node);
        heap.push([next, candidate]);
      }
    }
  }
  if (!best.has(target)) return null;
  const route = [target];
  while (route[0] !== source) route.unshift(prev.get(route[0])!);
  return { latency: best.get(target)!, route };
}

const links: Link[] = [['gw', 'bom', 30], ['gw', 'del', 10], ['del', 'bom', 15], ['bom', 'sin', 40], ['del', 'sin', 80]];
assert.deepEqual(lowestLatency(links, 'gw', 'sin'), { latency: 65, route: ['gw', 'del', 'bom', 'sin'] });
assert.equal(lowestLatency(links, 'sin', 'gw'), null);
assert.deepEqual(lowestLatency(links, 'gw', 'gw'), { latency: 0, route: ['gw'] });
```

Complexity: O((V + E) log V) with a binary heap; O(V + E) space.

The trap: marking a node "done" when it is **pushed** rather than when it is **popped**. A node can be pushed several times with decreasing distances; only the first pop is final, which is why stale entries are skipped. The second trap is negative weights: Dijkstra's greedy choice is wrong when a later edge can reduce a total, which is why the function refuses them. Part 11 (11.13) shows Dijkstra on delivery routing.

### 12.6.7 Coupon combinations for an exact total

Pattern: backtracking · Level 3

#### Practical exercise

A support agent can compensate a customer with promotional coupons. Given the available coupon values (there may be several coupons with the same value; each coupon can be used once) and a target amount, list every distinct combination of values that adds up exactly to the target. Each combination ascending, the list in ascending order. At most 20 coupons.

```text
coupons = [500, 200, 300, 200, 100], target = 500
-> [[100, 200, 200], [200, 300], [500]]
```

Hint: sort first. At each step choose the next coupon or stop; skip a value you already tried at the same position.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function couponCombinations(coupons: readonly number[], target: number): number[][] {
  const values = [...coupons].sort((a, b) => a - b);
  const results: number[][] = [];
  const chosen: number[] = [];

  function explore(start: number, remaining: number): void {
    if (remaining === 0) { results.push([...chosen]); return; }
    for (let i = start; i < values.length; i++) {
      if (i > start && values[i] === values[i - 1]) continue;  // same value at the same depth: duplicate
      if (values[i] > remaining) break;                         // sorted, so nothing later fits either
      chosen.push(values[i]);
      explore(i + 1, remaining - values[i]);                    // i + 1: each coupon used once
      chosen.pop();                                             // undo the choice (backtrack)
    }
  }
  explore(0, target);
  return results;
}

assert.deepEqual(couponCombinations([500, 200, 300, 200, 100], 500), [[100, 200, 200], [200, 300], [500]]);
assert.deepEqual(couponCombinations([300], 500), []);
assert.deepEqual(couponCombinations([100, 100, 100], 200), [[100, 100]]);
```

Complexity: O(2ⁿ) combinations in the worst case, which is why the limit is 20 coupons; sorting and the `break` prune heavily in practice. Recursion depth is at most n.

The trap: removing duplicates **after** generating, with a `Set` of joined strings. It produces the right answer, but explores the same combinations many times; with ten coupons of equal value it explores hundreds of identical branches. Skipping equal values at the same depth (`i > start`) prunes them at the source. The second trap is `explore(i, ...)` instead of `explore(i + 1, ...)`, which reuses the same coupon.

### 12.6.8 Fewest boxes for a shipment

Pattern: 1-D dynamic programming · Level 3

#### Practical exercise

A warehouse ships items in boxes of a few fixed capacities (for example 1, 4 and 5 items), and every box must be full. Given the capacities and an order of `n` items (n up to 10⁴), return the fewest boxes, or `-1` if no combination fits exactly.

```text
capacities = [1, 4, 5], n = 8   -> 2   (4 + 4; the greedy 5 + 1 + 1 + 1 needs 4)
capacities = [4, 6], n = 7      -> -1
capacities = [3], n = 0         -> 0
```

Hint: the best answer for `n` items is one box plus the best answer for `n - capacity`, for some capacity.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function fewestBoxes(capacities: readonly number[], n: number): number {
  // best[x] = fewest full boxes holding exactly x items (Infinity = impossible).
  const best = new Array<number>(n + 1).fill(Infinity);
  best[0] = 0;
  for (let x = 1; x <= n; x++) {
    for (const c of capacities) {
      if (c <= x && best[x - c] + 1 < best[x]) best[x] = best[x - c] + 1;
    }
  }
  return best[n] === Infinity ? -1 : best[n];
}

assert.equal(fewestBoxes([1, 4, 5], 8), 2);
assert.equal(fewestBoxes([4, 6], 7), -1);
assert.equal(fewestBoxes([3], 0), 0);
assert.equal(fewestBoxes([1, 4, 5], 13), 3);   // 4 + 4 + 5
```

Complexity: O(n · c) time for c capacities, O(n) space.

The trap: greedy. "Always use the biggest box that fits" gives 5 + 1 + 1 + 1 for 8 items: four boxes instead of two. Greedy works only for special capacity sets, and proving that is harder than writing the DP. When the interviewer says "fewest", "cheapest" or "number of ways" and a greedy counterexample exists, reach for DP. Part 11 (11.15 and 11.16) explains when greedy is safe.

### 12.6.9 Slowest request in every window

Pattern: monotonic deque · Level 3

#### Practical exercise

Given the response times of the last n requests (n up to 10⁶) and a window size `k`, return the slowest response time in every window of `k` consecutive requests, for a latency dashboard. There are `n - k + 1` windows.

```text
times = [120, 80, 300, 90, 95, 400, 60], k = 3  -> [300, 300, 300, 400, 400]
```

Hint: when a slower request arrives, every faster request before it in the window can never be the maximum again. Keep only candidates.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function slowestPerWindow(times: readonly number[], k: number): number[] {
  if (k <= 0 || times.length < k) return [];
  const dq = new Int32Array(times.length);   // indices, times decreasing from head to tail
  let head = 0;
  let tail = 0;                              // dq[head..tail) is the deque
  const out: number[] = [];
  for (let i = 0; i < times.length; i++) {
    while (tail > head && times[dq[tail - 1]] <= times[i]) tail--;  // drop candidates that lost
    dq[tail++] = i;
    if (dq[head] <= i - k) head++;           // the head slid out of the window
    if (i >= k - 1) out.push(times[dq[head]]);
  }
  return out;
}

assert.deepEqual(slowestPerWindow([120, 80, 300, 90, 95, 400, 60], 3), [300, 300, 300, 400, 400]);
assert.deepEqual(slowestPerWindow([5, 4, 3], 1), [5, 4, 3]);
assert.deepEqual(slowestPerWindow([1, 2], 3), []);
```

Complexity: O(n) time (each index is added and removed at most once), O(n) space for the index buffer (at most k live entries).

The trap: recomputing `Math.max` over each window, O(n·k): with n = 10⁶ and k = 1,000 that is 10⁹ comparisons. A heap gives O(n log k) and works, but the deque is the expected answer. The second trap is storing **values** rather than **indices** in the deque, which makes it impossible to tell when the head has slid out of the window. Part 74 (74.2.3) shows the related monotonic stack.

#### Interview questions

1. **Why does a size-k min-heap find the top k?** Its root is the weakest of the kept items, so each new item either replaces the root in O(log k) or is discarded; the heap never holds more than k.
2. **When can you binary search on the answer?** When feasibility is monotonic: if a value works, every larger (or smaller) value also works, and you can check a candidate efficiently.
3. **Why does Dijkstra fail with negative weights?** It finalises the closest unvisited node greedily; a negative edge found later could make an already-finalised distance shorter.
4. **How do you avoid duplicate results in backtracking?** Sort, then skip equal values at the same recursion depth, so each distinct choice is tried once.
5. **How do you decide between greedy and DP?** Look for a counterexample to the greedy rule on small inputs; if one exists, use DP or prove the greedy choice is safe.
