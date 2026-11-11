## 12.4 Level 1: warm-ups

Level 1 problems need one idea and usually one loop. They exist to make the method automatic and to practise the boring parts that cost points later: edge cases, off-by-one errors and clean tests. Aim to finish each within ten to fifteen minutes, tests included.

### 12.4.1 First repeated idempotency key

Pattern: hashing · Level 1

#### Practical exercise

A payments API receives requests, each with an idempotency key, in arrival order. Return the first key whose **second** arrival happens earliest (that request is the first duplicate the server must reject), or `null` if there are no duplicates.

```text
keys = ["k1", "k2", "k2", "k1"]  -> "k2"   (k2 repeats at index 2, k1 only at index 3)
keys = ["a", "b", "c"]           -> null
keys = []                        -> null
```

Hint: what do you need to remember about the keys you have already passed?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function firstDuplicateKey(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;   // the first time any key is seen twice
    seen.add(key);
  }
  return null;
}

assert.equal(firstDuplicateKey(['k1', 'k2', 'k2', 'k1']), 'k2');
assert.equal(firstDuplicateKey(['a', 'b', 'c']), null);
assert.equal(firstDuplicateKey([]), null);
assert.equal(firstDuplicateKey(['x', 'x']), 'x');
```

Complexity: O(n) time, O(n) space for the set.

The trap: answering "the key whose first occurrence is earliest among the repeated ones", which returns `k1` for the first example. Read "first duplicate" as a moment in time: the earliest index at which a repeat happens. The second trap is the O(n²) version, `keys.indexOf(key) !== i` inside a loop; at 10⁵ keys that is 10¹⁰ steps. In production this is exactly what an idempotency store does, with Redis or a unique index instead of a `Set` (Part 33).

### 12.4.2 Most frequent error code

Pattern: counting · Level 1

#### Practical exercise

Each log line has the form `timestamp LEVEL CODE message...`. Return the most frequent `CODE` among lines whose level is `ERROR`. If two codes tie, return the alphabetically smaller one. If there are no error lines, return `null`.

```text
2026-11-03T10:00:01Z ERROR E_TIMEOUT payment provider slow
2026-11-03T10:00:02Z INFO  I_START worker started
2026-11-03T10:00:03Z ERROR E_DB_CONN pool exhausted
2026-11-03T10:00:04Z ERROR E_TIMEOUT payment provider slow
-> "E_TIMEOUT"
```

Hint: one pass to count, then one pass over the counts. Watch the double space after `INFO`.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function mostFrequentErrorCode(lines: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const [, level, code] = line.trim().split(/\s+/);   // split on any run of whitespace
    if (level !== 'ERROR' || !code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && code < best)) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

const logs = [
  '2026-11-03T10:00:01Z ERROR E_TIMEOUT payment provider slow',
  '2026-11-03T10:00:02Z INFO  I_START worker started',
  '2026-11-03T10:00:03Z ERROR E_DB_CONN pool exhausted',
  '2026-11-03T10:00:04Z ERROR E_TIMEOUT payment provider slow',
];
assert.equal(mostFrequentErrorCode(logs), 'E_TIMEOUT');
assert.equal(mostFrequentErrorCode(['t ERROR B x', 't ERROR A y']), 'A');   // tie -> alphabetical
assert.equal(mostFrequentErrorCode(['t INFO I_X ok']), null);
assert.equal(mostFrequentErrorCode([]), null);
```

Complexity: O(n) time for n lines (each split is bounded by the line length), O(c) space for c distinct codes.

The trap: the tie-break. Iterating a `Map` returns codes in insertion order, so without the explicit comparison the answer depends on which code happened to appear first. The second trap is `split(' ')`, which turns the double space after `INFO` into an empty field and shifts every column. Real log parsing has the same failure modes, which is why structured JSON logs exist (Part 47).

### 12.4.3 Balanced migration log

Pattern: stack · Level 1

#### Practical exercise

A migration runner writes `BEGIN name` when a step starts and `END name` when it finishes. Steps can be nested (a step may start sub-steps). The log is valid if every `END` closes the most recently opened step that is still open, with the same name, and nothing is left open at the end. Return whether the log is valid.

```text
["BEGIN add_orders", "BEGIN add_index", "END add_index", "END add_orders"]  -> true
["BEGIN a", "BEGIN b", "END a", "END b"]                                      -> false (wrong order)
["BEGIN a"]                                                                   -> false (left open)
["END a"]                                                                     -> false
```

Hint: "most recently opened" means last in, first out.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function isBalancedMigrationLog(lines: readonly string[]): boolean {
  const open: string[] = [];                          // stack of step names
  for (const line of lines) {
    const [kind, name] = line.split(' ');
    if (kind === 'BEGIN') {
      open.push(name);
    } else if (kind === 'END') {
      if (open.length === 0 || open[open.length - 1] !== name) return false;
      open.pop();
    } else {
      return false;                                   // unknown line: treat as invalid
    }
  }
  return open.length === 0;                           // nothing left open
}

assert.equal(isBalancedMigrationLog(['BEGIN add_orders', 'BEGIN add_index', 'END add_index', 'END add_orders']), true);
assert.equal(isBalancedMigrationLog(['BEGIN a', 'BEGIN b', 'END a', 'END b']), false);
assert.equal(isBalancedMigrationLog(['BEGIN a']), false);
assert.equal(isBalancedMigrationLog(['END a']), false);
assert.equal(isBalancedMigrationLog([]), true);
```

Complexity: O(n) time, O(n) space in the worst case (everything nested).

The trap: counting instead of stacking. A counter that goes up on `BEGIN` and down on `END` accepts the second example, because it only checks how many steps are open, not which. The second trap is forgetting the final check, which accepts a log that ends with a step still open: in real life, a migration that crashed half-way (Part 27).

### 12.4.4 Merge two replica logs

Pattern: two pointers · Level 1

#### Practical exercise

Two replicas each export the timestamps (integers, milliseconds) of events they saw, sorted ascending. The same event can appear in both, and a replica can list the same timestamp twice. Return one ascending list with every distinct timestamp exactly once. Do it in a single pass over both lists.

```text
a = [100, 200, 200, 400], b = [150, 200, 500]  -> [100, 150, 200, 400, 500]
a = [], b = [7, 7]                              -> [7]
```

Hint: both inputs are already sorted; keep one index into each.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function mergeDistinct(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  const push = (v: number) => {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);  // skip repeats
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] <= b[j]) push(a[i++]);
    else push(b[j++]);
  }
  while (i < a.length) push(a[i++]);                   // leftovers from a
  while (j < b.length) push(b[j++]);                   // leftovers from b
  return out;
}

assert.deepEqual(mergeDistinct([100, 200, 200, 400], [150, 200, 500]), [100, 150, 200, 400, 500]);
assert.deepEqual(mergeDistinct([], [7, 7]), [7]);
assert.deepEqual(mergeDistinct([1, 2], []), [1, 2]);
assert.deepEqual(mergeDistinct([], []), []);
```

Complexity: O(n + m) time, O(1) extra space besides the output.

The trap: forgetting the two leftover loops, which silently drops the tail of the longer list. The second trap is solving it as `[...new Set([...a, ...b])].sort()`: it is correct only with a numeric comparator, it costs O((n + m) log(n + m)), and it ignores the fact that the inputs were sorted, which is the whole point. Merging sorted streams is how a database merge join and log aggregation work (Part 11, 11.7).

### 12.4.5 Revenue between two days

Pattern: prefix sums · Level 1

#### Practical exercise

You have the revenue in cents for each of n days (n up to 10⁵; refunds can make a day negative). A finance dashboard sends up to 10⁵ queries `[from, to]` (0-based, inclusive) and wants the total for each range. Answer all queries faster than O(n) each.

```text
revenue = [500, -100, 300, 700]
queries = [[0, 3], [1, 2], [2, 2]]   -> [1400, 200, 300]
```

Hint: if you knew the total of the first k days for every k, how would you get the total of days 1 to 2?

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function rangeTotals(revenue: readonly number[], queries: ReadonlyArray<[number, number]>): number[] {
  // prefix[k] = sum of the first k days, so prefix[0] = 0 and prefix has n + 1 entries.
  const prefix = new Array<number>(revenue.length + 1).fill(0);
  for (let i = 0; i < revenue.length; i++) prefix[i + 1] = prefix[i] + revenue[i];
  return queries.map(([from, to]) => prefix[to + 1] - prefix[from]);
}

assert.deepEqual(rangeTotals([500, -100, 300, 700], [[0, 3], [1, 2], [2, 2]]), [1400, 200, 300]);
assert.deepEqual(rangeTotals([42], [[0, 0]]), [42]);
assert.deepEqual(rangeTotals([], []), []);
```

Complexity: O(n) to build the prefix array, then O(1) per query: O(n + q) in total, O(n) space.

The trap: the off-by-one. With a prefix array of length n + 1 where `prefix[k]` is the sum of the first k days, the range `[from, to]` is `prefix[to + 1] - prefix[from]`. A length-n prefix array works too but needs a special case for `from = 0`, which is where bugs hide. In production, the same idea is a running-total column or a materialised daily summary, so a dashboard never sums raw orders on every request (Part 21).

### 12.4.6 Compare release versions

Pattern: strings, two pointers · Level 1

#### Practical exercise

Release versions look like `1.10.0` or `2.0`. Write `compareVersions(a, b)` that returns `-1` if `a` is older, `1` if `a` is newer and `0` if they are the same release. Missing parts count as `0` (`2.0` equals `2.0.0`), and leading zeros do not matter (`1.01` equals `1.1`). Pre-release tags are out of scope.

```text
("1.10.0", "1.9.3") -> 1
("2.0", "2.0.0")    -> 0
("1.0.1", "1.1")    -> -1
```

Hint: compare part by part as numbers, not as strings.

#### Worked answer to the exercise

```ts
import assert from 'node:assert/strict';

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if ([...pa, ...pb].some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`invalid version: ${a} or ${b}`);
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;                               // a missing part counts as 0
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
assert.equal(compareVersions('2.0', '2.0.0'), 0);
assert.equal(compareVersions('1.0.1', '1.1'), -1);
assert.equal(compareVersions('1.01', '1.1'), 0);
assert.throws(() => compareVersions('1.x', '1.0'));
```

Complexity: O(n + m) time and space in the lengths of the strings.

The trap: comparing the strings directly. `'1.10.0' < '1.9.3'` is `true` as strings, because `'1'` sorts before `'9'`, so a string comparison would call 1.10 older than 1.9. This exact bug has shipped in real update checkers. Real projects use a semantic-versioning library for pre-release tags and ranges; the interview version tests whether you see that each part is a number.

### 12.4.7 Level 1 checkpoint: one problem, narrated

Pattern: hashing · Level 1

#### Practical example

Before moving to Level 2, watch the six steps of 12.1.1 applied out loud to one new problem. This is what an interviewer wants to hear, and what you should say to yourself when practising alone.

> Orders arrive sorted by time, each with a customer id and a timestamp in seconds. Fraud rules flag any customer who places two orders less than 600 seconds apart. Return the flagged customer ids in the order they were first flagged.

```text
1. Understand  "So for each customer I compare consecutive orders of THAT customer, not of everyone.
                Less than 600 means 599 counts and 600 does not? Input sorted by time, n up to 10^5?
                A customer flagged twice appears once?"   -> yes to all.
2. Examples    c1@0, c2@100, c1@500, c2@800, c3@900, c3@1500
                c1: 500 - 0 = 500 < 600, flagged.  c2: 700, no.  c3: 600, not less than 600, no.
                -> ["c1"].  Edge cases: empty list; one order; same timestamp twice (0 apart, flagged).
3. Brute force "For each order, scan all earlier orders of the same customer: O(n^2). 10^10 at 10^5."
4. Optimise    "Because input is sorted, only the customer's PREVIOUS order matters: if the latest
                one is 600 or more seconds back, every older one is even further. So I keep a map
                customer -> last timestamp. One pass, O(n) time, O(c) space for c customers."
5. Code        (below)
6. Test        "Trace the example: c1 stored at 0; c2 at 100; c1 at 500: 500 - 0 < 600, flag c1 ...
                then the edge cases as asserts."
```

```ts
import assert from 'node:assert/strict';

interface PlacedOrder { customerId: string; at: number }   // at: seconds, input sorted by at

function rapidReorders(orders: readonly PlacedOrder[], windowSeconds = 600): string[] {
  const lastAt = new Map<string, number>();
  const flagged = new Set<string>();                        // a Set keeps first-flagged order too
  for (const { customerId, at } of orders) {
    const prev = lastAt.get(customerId);
    if (prev !== undefined && at - prev < windowSeconds) flagged.add(customerId);
    lastAt.set(customerId, at);                             // only the latest order matters
  }
  return [...flagged];
}

const orders: PlacedOrder[] = [
  { customerId: 'c1', at: 0 }, { customerId: 'c2', at: 100 }, { customerId: 'c1', at: 500 },
  { customerId: 'c2', at: 800 }, { customerId: 'c3', at: 900 }, { customerId: 'c3', at: 1500 },
];
assert.deepEqual(rapidReorders(orders), ['c1']);
assert.deepEqual(rapidReorders([]), []);
assert.deepEqual(rapidReorders([{ customerId: 'c9', at: 50 }, { customerId: 'c9', at: 50 }]), ['c9']);
assert.deepEqual(rapidReorders([{ customerId: 'c1', at: 0 }, { customerId: 'c1', at: 300 }, { customerId: 'c1', at: 400 }]), ['c1']);
```

Complexity: O(n) time, O(c) space.

What to notice: the boundary question in step 1 ("less than 600: does 600 count?") decided one of the test cases, and step 4 found the optimisation by asking what the brute force repeats (re-checking older orders that can never be closer than the latest one). The trap is forgetting that the input is sorted only by time, not by customer, which tempts people into sorting by customer first and losing the time order. If the input were **not** sorted by time, you would sort it first and say so: O(n log n).

#### Interview questions

1. **Why is a `Set` the right tool for "have I seen this?"** Average O(1) insert and lookup, against O(n) for scanning an array; it trades memory for time.
2. **When does a counter fail where a stack works?** When order or identity matters, not just the number of open items, as in nested `BEGIN` and `END` steps.
3. **How does a prefix sum answer a range query in O(1)?** The total of a range is the difference of two running totals: `prefix[to + 1] - prefix[from]`.
4. **Why compare version parts as numbers?** String comparison is character by character, so `10` sorts before `9`.
5. **The input is sorted by time. How can that change your algorithm?** It often means only the previous item per key matters, or that two pointers or a single pass replace a sort or a nested loop; say out loud which property of the order you rely on.
