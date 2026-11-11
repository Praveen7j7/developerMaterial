## 12.5 Level 2: the classic patterns

Level 2 is where the named patterns appear: complements in a hash map, fixed and variable sliding windows, sorting intervals, binary search, canonical keys, BFS and DFS. Each one is the simplest clean instance of its pattern. Learn these until you can write them without thinking, because Level 3 and 4 problems are built from them.

### 12.5.1 Two orders that use up a gift card

Pattern: hashing (complements) · Level 2

#### Practical exercise

A customer has a gift card with balance `B` cents and a list of past orders (id and amount). Support wants two **different** orders whose amounts add up to exactly `B`, to suggest a refund-to-card. Return the pair that is completed earliest while scanning in order, as `[firstId, secondId]`, or `null`. n is up to 10⁵.

```text
orders = [o1: 1500, o2: 2500, o3: 1000, o4: 3500], B = 5000  -> ["o1", "o4"]
  (o2 and o3 find no partner; o4 needs 1500, which o1 has)
orders = [a: 2500], B = 5000                                 -> null (cannot use a twice)
orders = [a: 2500, b: 2500], B = 5000                        -> ["a", "b"]
```

Hint: for each order you need "the amount I am missing"; how do you look that up in O(1)?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

interface PastOrder { id: string; cents: number }

function giftCardPair(orders: readonly PastOrder[], balance: number): [string, string] | null {
  const byAmount = new Map<number, string>();          // amount -> earliest order id with it
  for (const order of orders) {
    const partner = byAmount.get(balance - order.cents);
    if (partner !== undefined) return [partner, order.id];
    if (!byAmount.has(order.cents)) byAmount.set(order.cents, order.id); // add AFTER checking
  }
  return null;
}

const orders = [
  { id: 'o1', cents: 1500 }, { id: 'o2', cents: 2500 }, { id: 'o3', cents: 1000 }, { id: 'o4', cents: 3500 },
];
assert.deepEqual(giftCardPair(orders, 5000), ['o1', 'o4']);
assert.equal(giftCardPair([{ id: 'a', cents: 2500 }], 5000), null);
assert.deepEqual(giftCardPair([{ id: 'a', cents: 2500 }, { id: 'b', cents: 2500 }], 5000), ['a', 'b']);
assert.equal(giftCardPair([], 100), null);
```

Complexity: O(n) time, O(n) space.

The trap: inserting the current order into the map **before** looking up its partner, which pairs an order of 2,500 with itself when the balance is 5,000. Checking first, then inserting, makes "two different orders" automatic. The brute force (all pairs) is O(n²): fine for 50 orders, 10¹⁰ steps for 10⁵.

### 12.5.2 Busiest k minutes

Pattern: fixed sliding window · Level 2

#### Practical exercise

Given the number of requests in each minute of a day and a window size `k`, return the largest total over any `k` consecutive minutes, to size autoscaling. Return `null` if there are fewer than `k` minutes. n is up to 10⁶ and k can be large.

```text
perMinute = [5, 1, 3, 8, 2, 7], k = 3  -> 17  (minutes 3 to 5: 8 + 2 + 7)
perMinute = [4, 4], k = 3              -> null
```

Hint: when the window moves one minute right, what changes?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function busiestWindow(perMinute: readonly number[], k: number): number | null {
  if (k <= 0 || perMinute.length < k) return null;
  let sum = 0;
  for (let i = 0; i < k; i++) sum += perMinute[i];      // the first window
  let best = sum;
  for (let right = k; right < perMinute.length; right++) {
    sum += perMinute[right] - perMinute[right - k];     // add the new minute, drop the oldest
    best = Math.max(best, sum);
  }
  return best;
}

assert.equal(busiestWindow([5, 1, 3, 8, 2, 7], 3), 17);
assert.equal(busiestWindow([4, 4], 3), null);
assert.equal(busiestWindow([9], 1), 9);
assert.equal(busiestWindow([1, 2, 3], 3), 6);
```

Complexity: O(n) time, O(1) space. The brute force re-sums each window: O(n·k), which at n = 10⁶ and k = 60 is 6 × 10⁷ (survivable), but at k = 10⁵ is 10¹¹.

The trap: initialising `best` to `0`, which is wrong when all counts could be negative in a variant (net change rather than counts). Initialise from the first real window.

### 12.5.3 Shortest burst over an error budget

Pattern: variable sliding window · Level 2

#### Practical exercise

Given the number of errors in each minute (all values are zero or positive) and a budget `B`, return the length of the **shortest** run of consecutive minutes whose total errors reach at least `B`. This is how quickly an incident can burn the budget. Return `0` if no run reaches it.

```text
errors = [1, 4, 2, 0, 5, 3], B = 8  -> 2   (5 + 3)
errors = [1, 1, 1], B = 5           -> 0
errors = [10], B = 7                -> 1
```

Hint: grow the window to the right until it reaches the budget, then shrink it from the left while it still does.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function shortestBurst(errors: readonly number[], budget: number): number {
  let left = 0;
  let sum = 0;
  let best = Infinity;
  for (let right = 0; right < errors.length; right++) {
    sum += errors[right];                              // grow
    while (sum >= budget && left <= right) {           // shrink while still over budget
      best = Math.min(best, right - left + 1);
      sum -= errors[left++];
    }
  }
  return best === Infinity ? 0 : best;
}

assert.equal(shortestBurst([1, 4, 2, 0, 5, 3], 8), 2);
assert.equal(shortestBurst([1, 1, 1], 5), 0);
assert.equal(shortestBurst([10], 7), 1);
assert.equal(shortestBurst([], 1), 0);
```

Complexity: O(n) time (each index enters and leaves the window at most once), O(1) space.

The trap: using `if` instead of `while` for the shrink step, which shrinks only once per new minute and misses shorter windows. The deeper trap is applying this to data with **negative** values (for example net balance changes): shrinking is then no longer safe, because removing a negative value increases the sum. Negative values need prefix sums (12.6.4) or a monotonic deque.

### 12.5.4 Merge maintenance windows

Pattern: sorting, intervals · Level 2

#### Practical exercise

Several teams have booked maintenance windows as `[start, end)` minute ranges, in no particular order. Merge them into the smallest list of non-overlapping windows for the status page. Windows that overlap or touch (`[10, 20)` and `[20, 30)`) merge. Do not modify the input.

```text
[[60, 90], [10, 20], [15, 30], [30, 40]]  -> [[10, 40], [60, 90]]
[[5, 10]]                                -> [[5, 10]]
[[1, 10], [2, 3]]                        -> [[1, 10]]
```

Hint: after sorting by start, a window can only merge with the last merged one.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

type Window = [start: number, end: number];

function mergeWindows(windows: readonly Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);   // copy, then sort by start
  const merged: Window[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);                       // extend; a window may be contained
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

const input: Window[] = [[60, 90], [10, 20], [15, 30], [30, 40]];
assert.deepEqual(mergeWindows(input), [[10, 40], [60, 90]]);
assert.deepEqual(input[0], [60, 90]);                         // input untouched
assert.deepEqual(mergeWindows([[1, 10], [2, 3]]), [[1, 10]]);
assert.deepEqual(mergeWindows([]), []);
```

Complexity: O(n log n) for the sort, O(n) for the sweep, O(n) space for the copy.

The trap: `last[1] = end` instead of `Math.max(last[1], end)`. The third example shows why: `[2, 3]` lies inside `[1, 10]`, and plain assignment would shrink the merged window to `[1, 3]`. The second trap is `windows.sort(...)` on the input itself, which reorders the caller's array; in a service that is a bug someone else finds.

### 12.5.5 First bad build

Pattern: binary search · Level 2

#### Practical exercise

Builds are numbered `1` to `n` (n up to 10⁹ over the life of a monorepo). A test started failing at some build and has failed in every build since. You have `isBroken(build)`, which takes minutes to run, so call it as few times as possible. Return the first broken build, or `-1` if none is broken.

```text
n = 10, broken from 7  -> 7   (about 4 calls, not 7)
n = 5,  never broken   -> -1
n = 1,  broken from 1  -> 1
```

Hint: if build `mid` is broken, the answer is `mid` or earlier. Keep an invariant about where the answer can be.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function firstBadBuild(n: number, isBroken: (build: number) => boolean): number {
  // Invariant: the answer is in [lo, hi]; hi = n + 1 means "none broken".
  let lo = 1;
  let hi = n + 1;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (isBroken(mid)) hi = mid;      // mid might be the first; keep it
    else lo = mid + 1;                // mid is fine; the first is after it
  }
  return lo === n + 1 ? -1 : lo;
}

function counter(firstBroken: number) {
  let calls = 0;
  const isBroken = (b: number) => { calls++; return b >= firstBroken; };
  return { isBroken, calls: () => calls };
}

const c = counter(7);
assert.equal(firstBadBuild(10, c.isBroken), 7);
assert.ok(c.calls() <= 4);
assert.equal(firstBadBuild(5, counter(99).isBroken), -1);
assert.equal(firstBadBuild(1, counter(1).isBroken), 1);
assert.equal(firstBadBuild(1_000_000_000, counter(123_456_789).isBroken), 123_456_789);
```

Complexity: O(log n) calls: about 30 for a billion builds. O(1) space.

The trap: the loop condition and the updates must match the invariant. Mixing styles (`while (lo <= hi)` with `hi = mid`) loops forever when `lo === hi`. Pick one template (`lo < hi`, `hi = mid`, `lo = mid + 1`) and use it everywhere; write the invariant as a comment. This is exactly `git bisect` (Part 52, 52.9.3).

### 12.5.6 Identical carts

Pattern: hashing with a canonical key · Level 2

#### Practical exercise

Marketing wants groups of customers whose carts contain exactly the same products in the same total quantities. Line order does not matter, and a product split across two lines counts as one (`A x1, A x1` equals `A x2`). Return only groups of two or more customers, each group's ids sorted, groups sorted by their first id.

```text
c1: [A x2, B x1]   c2: [B x1, A x1, A x1]   c3: [A x2]   c4: [A x2]   c5: [C x1]
-> [["c1", "c2"], ["c3", "c4"]]
```

Hint: turn each cart into a string that is equal for equal carts and different for different ones.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

interface Cart { customerId: string; lines: { sku: string; qty: number }[] }

function cartKey(lines: Cart['lines']): string {
  const qty = new Map<string, number>();
  for (const { sku, qty: q } of lines) qty.set(sku, (qty.get(sku) ?? 0) + q);   // merge split lines
  const entries = [...qty].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));   // stable order
  return JSON.stringify(entries);                       // unambiguous, whatever the SKU contains
}

function identicalCarts(carts: readonly Cart[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const cart of carts) {
    const key = cartKey(cart.lines);
    const list = groups.get(key) ?? [];
    list.push(cart.customerId);
    groups.set(key, list);
  }
  return [...groups.values()]
    .filter((ids) => ids.length >= 2)
    .map((ids) => ids.sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const carts: Cart[] = [
  { customerId: 'c1', lines: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] },
  { customerId: 'c2', lines: [{ sku: 'B', qty: 1 }, { sku: 'A', qty: 1 }, { sku: 'A', qty: 1 }] },
  { customerId: 'c3', lines: [{ sku: 'A', qty: 2 }] },
  { customerId: 'c4', lines: [{ sku: 'A', qty: 2 }] },
  { customerId: 'c5', lines: [{ sku: 'C', qty: 1 }] },
];
assert.deepEqual(identicalCarts(carts), [['c1', 'c2'], ['c3', 'c4']]);
assert.deepEqual(identicalCarts([]), []);
// Naive keys collide: "A1" + "1" and "A" + "11" both join to "A11"; JSON keeps them apart.
assert.notEqual(cartKey([{ sku: 'A1', qty: 1 }]), cartKey([{ sku: 'A', qty: 11 }]));
```

Complexity: O(L log L) for a cart with L distinct products (the sort), so O(total lines · log) overall; O(total lines) space.

The trap: building the key by plain concatenation (`sku + qty`), which makes different carts collide, as the last test shows. Use a separator that cannot appear in the data, or `JSON.stringify`. The canonical-key idea is everywhere in backends: cache keys built from sorted query parameters, deduplication of webhook payloads, idempotency keys from request bodies.

### 12.5.7 Shortest path for a warehouse robot

Pattern: BFS on a grid · Level 2

#### Practical exercise

A warehouse floor is a grid of strings: `.` is free floor, `#` is a shelf, `S` is the robot and `P` marks one or more packing stations. The robot moves one cell up, down, left or right per step. Return the fewest steps to reach **any** packing station, or `-1` if none is reachable. The grid can be 1,000 by 1,000.

```text
S . # P
. . # .
# . . .      -> 7   (down, right, down, right, right, up, up)
```

Hint: "fewest steps" on a grid where every step costs the same is breadth-first search.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

const DIRS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function stepsToPacking(grid: readonly string[]): number {
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  const dist = new Int32Array(rows * cols).fill(-1);   // -1 = not visited; flat array, row * cols + col
  const queue: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (grid[r][c] === 'S') { dist[r * cols + c] = 0; queue.push(r * cols + c); }

  for (let head = 0; head < queue.length; head++) {     // head index: no O(n) shift()
    const cell = queue[head];
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    if (grid[r][c] === 'P') return dist[cell];         // first station dequeued is the nearest
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || grid[nr][nc] === '#') continue;
      const next = nr * cols + nc;
      if (dist[next] !== -1) continue;
      dist[next] = dist[cell] + 1;                       // mark when ENQUEUED, not when dequeued
      queue.push(next);
    }
  }
  return -1;
}

assert.equal(stepsToPacking(['S.#P', '..#.', '#...']), 7);
assert.equal(stepsToPacking(['S#P']), -1);
assert.equal(stepsToPacking(['SP']), 1);
const big = Array.from({ length: 1000 }, () => '.'.repeat(1000));
big[0] = 'S' + big[0].slice(1);
big[999] = big[999].slice(0, 999) + 'P';
assert.equal(stepsToPacking(big), 1998);
```

Complexity: O(R·C) time and space: each cell is enqueued at most once.

The trap: marking cells visited when they are **dequeued** instead of when they are enqueued. The answer stays correct, but the same cell can be queued several times, and on a large open grid the queue grows far beyond R·C. The other trap is `queue.shift()`, which is O(n) per call and turns a one-million-cell BFS from milliseconds into minutes; the large test above would time out.

### 12.5.8 Count server clusters

Pattern: DFS, connected components · Level 2

#### Practical exercise

There are `n` servers numbered `0` to `n - 1` and a list of network links, each joining two servers in both directions. A cluster is a group of servers that can all reach each other through links. Return the number of clusters and the size of the largest. n is up to 10⁵, links up to 2 × 10⁵.

```text
n = 6, links = [[0, 1], [1, 2], [3, 4]]  -> { clusters: 3, largest: 3 }   ({0,1,2}, {3,4}, {5})
n = 3, links = []                        -> { clusters: 3, largest: 1 }
```

Hint: start a search from every server not yet visited; each new start is a new cluster.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function clusters(n: number, links: ReadonlyArray<[number, number]>): { clusters: number; largest: number } {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of links) { adj[a].push(b); adj[b].push(a); }

  const visited = new Uint8Array(n);
  let count = 0;
  let largest = 0;
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    count++;
    let size = 0;
    const stack = [start];                    // explicit stack: no recursion depth limit
    visited[start] = 1;
    while (stack.length > 0) {
      const node = stack.pop()!;
      size++;
      for (const next of adj[node]) {
        if (!visited[next]) { visited[next] = 1; stack.push(next); }
      }
    }
    largest = Math.max(largest, size);
  }
  return { clusters: count, largest };
}

assert.deepEqual(clusters(6, [[0, 1], [1, 2], [3, 4]]), { clusters: 3, largest: 3 });
assert.deepEqual(clusters(3, []), { clusters: 3, largest: 1 });
assert.deepEqual(clusters(0, []), { clusters: 0, largest: 0 });
// A 100,000-server chain: recursive DFS would overflow the call stack here.
const chain = Array.from({ length: 99_999 }, (_, i): [number, number] => [i, i + 1]);
assert.deepEqual(clusters(100_000, chain), { clusters: 1, largest: 100_000 });
```

Complexity: O(n + e) time and space for n servers and e links.

The trap: recursive DFS. It reads nicely and works on small tests, then overflows the call stack (`RangeError: Maximum call stack size exceeded`) on the long chain. The other trap is forgetting servers with no links at all, which are clusters of one; iterating over every server, not over the links, counts them. Union-find (12.7.3) solves the same problem when links arrive one at a time.

#### Interview questions

1. **When is a sliding window not valid?** When shrinking the window can increase the quantity you track, as with negative values in a sum; use prefix sums or a deque instead.
2. **Why mark BFS nodes as visited when enqueued?** So each node enters the queue once; marking on dequeue allows duplicates and a much larger queue.
3. **How do you avoid stack overflow in DFS on large inputs?** Use an explicit stack (or BFS), since JavaScript's recursion depth is limited.
4. **What makes a good canonical key?** It is equal exactly when the objects are equal: normalise (merge, sort) first, then serialise unambiguously.
