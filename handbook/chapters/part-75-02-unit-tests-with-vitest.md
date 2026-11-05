## 75.2 Unit tests with Vitest: utilities, reducers and hooks

#### Concept

A **unit test** runs one small piece of code with controlled inputs and checks its output. On the frontend the good candidates are **pure functions** (formatting, parsing, sorting, URL building), **reducers** (69.5), **custom hooks** with real logic (retry, debounce, idempotency keys), and **schema refinements** in the shared contracts.

**Vitest** is a test runner built on Vite (68.3). It reuses the app's Vite config, so TypeScript, JSX, path aliases and `import.meta.env` work in tests the same way they work in the app. Its API is deliberately close to Jest's: `describe`, `it`, `expect`, `vi.fn()`, `vi.mock()`, `vi.useFakeTimers()`. **Jest** (29 or 30) remains common, especially in older Create React App and Next.js projects; everything in this section applies to it with `jest.` in place of `vi.`.

#### Why does it exist?

Pure logic is where combinatorics live. A money formatter has currencies, negative amounts, zero, very large values and locale differences. A reducer has every pair of state and action. Checking those through rendered components would take 50 times longer and say less about which case failed. A unit test runs each case in a millisecond and names it.

#### Mental model

Imagine testing a calculator's keys one at a time on a bench, before it is built into the till. You learn quickly and exactly which key is broken. You do not learn whether the till's drawer opens.

#### How it works

1. **Vitest reads `vitest.config.ts`** (or the `test` block of `vite.config.ts`), transforms test files with the same plugins as the app (esbuild for TypeScript, the React plugin for JSX), and runs each test file in a worker (threads or forks; forks is the default since Vitest 2).
2. **The environment** decides which globals exist. `node` (default) has no DOM. `jsdom` or `happy-dom` provide `document`, `window`, `sessionStorage` and events. Pure functions should run in `node`; hooks and components need a DOM.
3. **Module mocking** (`vi.mock(path, factory)`) is hoisted to the top of the file and replaces a module for that file only.
4. **Fake timers** (`vi.useFakeTimers()`) replace `setTimeout`, `setInterval` and `Date`, so a hook that waits 1 s and then 2 s can be tested in milliseconds with `vi.advanceTimersByTimeAsync(1000)`, which also flushes promise callbacks between timers.
5. **`renderHook`** (from `@testing-library/react`, since v13.1) renders a hook inside a tiny test component and returns `result.current`; updates must happen inside `act()` so React applies state changes before you assert.

Vitest 3 versus Jest for a frontend repository:

| Question | Vitest 3 | Jest 29/30 |
|---|---|---|
| Uses the app's Vite config and aliases | Yes, same pipeline | Needs `moduleNameMapper`, a transformer (`ts-jest`, `@swc/jest`, `babel-jest`) |
| ESM support | Native | Experimental flags or transforms |
| Speed on 1,000 tests | Typically 1.5-3x faster cold, much faster in watch | Mature, slower start |
| Next.js | Official guide with `@vitejs/plugin-react` | Official `next/jest` preset (`nextJest()`) |
| Browser Mode (real browser instead of jsdom) | Experimental in 2 and 3, stable in Vitest 4 | No |
| Multiple configs in one run | `test.projects` (9.2+), replacing `vitest.workspace` | `projects` |

#### Practical example

Three unit-test targets from the checkout:

- `formatMoney(minor: string, currency: string, locale?)`: minor units arrive as strings (72.7); the formatter must not use floating point for large values.
- `checkoutReducer` (69.5): every legal transition and every illegal one ignored.
- `usePlaceOrder` (69.8): retries a timeout with the **same** idempotency key, backs off 1 s then 2 s, clears the key after a final answer, and refuses a second submit while one is in flight.

#### React / Next.js example

The configuration. The React plugin handles JSX; `vite-tsconfig-paths` reads the `@/` alias from `tsconfig.json`, exactly as the Next.js Vitest guide recommends:

```ts
// apps/web/vitest.config.ts  (Vitest 3)
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'jsdom',                        // per-file override: // @vitest-environment node
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/*.pact.test.ts', 'e2e/**'],     // Pact and Playwright have their own runners
    restoreMocks: true,                           // vi.spyOn restored after each test
    unstubGlobals: true,                          // vi.stubGlobal undone after each test
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], include: ['src/**/*.{ts,tsx}'] },
  },
});
```

```ts
// apps/web/src/test/setup.ts
import '@testing-library/jest-dom/vitest';       // toBeInTheDocument, toHaveAccessibleName, ...
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();                                     // unmount after every test; automatic only with globals: true
  sessionStorage.clear();                        // idempotency keys from 77.8 must not leak between tests
});
```

A table-driven unit test of the money formatter. It runs in the `node` environment, so it starts in a few milliseconds:

```ts
// packages/contracts/src/money.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatMoney } from './money';

describe('formatMoney', () => {
  it.each([
    ['129900', 'INR', 'en-IN', '₹1,299.00'],
    ['0', 'INR', 'en-IN', '₹0.00'],
    ['5', 'USD', 'en-US', '$0.05'],
    ['-2500', 'EUR', 'de-DE', '-25,00 €'],
    ['900719925474099312', 'INR', 'en-IN', '₹9,00,71,99,25,47,40,993.12'], // beyond Number.MAX_SAFE_INTEGER
  ])('formats %s %s in %s as %s', (minor, currency, locale, expected) => {
    // Intl may use a narrow no-break space in some locales; normalise for a readable expectation
    expect(formatMoney(minor, currency, locale).replace(/ | /g, ' ')).toBe(expected);
  });

  it('rejects a decimal string instead of guessing', () => {
    expect(() => formatMoney('12.99', 'INR')).toThrow(/minor units/);
  });
});
```

The last case of the table is the interesting one: if `formatMoney` did `Number(minor) / 100`, the value would round silently. The implementation must use `BigInt` and string slicing; this test proves it without reading the code.

A reducer test covers the transition table of 69.5 as data:

```ts
// apps/web/src/checkout/checkoutReducer.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkoutReducer, type CheckoutState } from './checkoutReducer';
import { aTotals, anAddress } from '../test/builders';     // builders parse through @shop/contracts (83.6)

const payment: CheckoutState = { step: 'payment', address: anAddress(), coupon: null, totals: aTotals(), error: null };

describe('checkoutReducer', () => {
  it('moves payment -> placing on PLACE_ORDER and clears the error', () => {
    const next = checkoutReducer({ ...payment, error: 'Declined' }, { type: 'PLACE_ORDER' });
    expect(next).toMatchObject({ step: 'placing', error: null });
  });

  it('ignores a second PLACE_ORDER while placing (double tap)', () => {
    const placing = checkoutReducer(payment, { type: 'PLACE_ORDER' });
    expect(checkoutReducer(placing, { type: 'PLACE_ORDER' })).toBe(placing);  // same object: no re-render
  });

  it.each(['address', 'coupon', 'payment'] as const)('ignores ORDER_PLACED from %s', (step) => {
    const state = step === 'payment' ? payment : ({ ...payment, step } as unknown as CheckoutState);
    expect(checkoutReducer(state, { type: 'ORDER_PLACED', orderId: 'A7K2Q9P' })).toBe(state);
  });

  it('returns to payment with the message on ORDER_FAILED', () => {
    const placing = checkoutReducer(payment, { type: 'PLACE_ORDER' });
    expect(checkoutReducer(placing, { type: 'ORDER_FAILED', message: 'Card declined' }))
      .toMatchObject({ step: 'payment', error: 'Card declined' });
  });
});
```

Asserting `toBe(state)` (same reference) for ignored actions is deliberate: React skips the re-render when a reducer returns the same object, so this is a performance property as well as a correctness one.

A hook test for `usePlaceOrder` with fake timers. Here mocking the API module is correct: the subject is the hook's retry policy, not the network, and the component tests of 75.3 cover the real client.

```ts
// apps/web/src/checkout/usePlaceOrder.test.ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaceOrder } from './usePlaceOrder';
import { placeOrder, ApiTimeoutError } from '../api/orders';
import { ApiError } from '../api/errors';

vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>();
  return { ...actual, placeOrder: vi.fn() };              // keep ApiTimeoutError real
});

describe('usePlaceOrder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a timeout with the same idempotency key after 1 s', async () => {
    vi.mocked(placeOrder)
      .mockRejectedValueOnce(new ApiTimeoutError())
      .mockResolvedValueOnce({ id: 'A7K2Q9P' } as Awaited<ReturnType<typeof placeOrder>>);
    const { result } = renderHook(() => usePlaceOrder('cart-1', 9));

    let outcome: unknown;
    await act(async () => {
      const pending = result.current.submit('upi');
      await vi.advanceTimersByTimeAsync(1000);            // the backoff before attempt 2
      outcome = await pending;
    });

    expect(outcome).toEqual({ ok: true, orderId: 'A7K2Q9P' });
    const [first, second] = vi.mocked(placeOrder).mock.calls;
    expect(second[1]).toBe(first[1]);                      // same key: the server replays, never duplicates
    expect(sessionStorage.getItem('idem:checkout:cart-1:v9')).toBeNull(); // final answer clears it
  });

  it('refuses a second submit while the first is in flight', async () => {
    vi.mocked(placeOrder).mockReturnValue(new Promise(() => {}));   // never settles
    const { result } = renderHook(() => usePlaceOrder('cart-1', 9));
    let second: unknown;
    await act(async () => { void result.current.submit('upi'); second = await result.current.submit('upi'); });
    expect(second).toEqual({ ok: false, message: 'Already placing your order' });
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('keeps the key when the outcome is unknown, so a retry replays', async () => {
    vi.mocked(placeOrder).mockRejectedValue(new ApiError(503, 'UPSTREAM_UNAVAILABLE'));
    const { result } = renderHook(() => usePlaceOrder('cart-1', 9));
    await act(async () => { await result.current.submit('upi'); });
    expect(sessionStorage.getItem('idem:checkout:cart-1:v9')).not.toBeNull();
  });
});
```

#### Backend side (NestJS)

Pure rules shared by both sides belong in `@shop/contracts` and get their unit tests there, run by both pipelines (68.9). The money formatter above is one; others are the order status lifecycle (`canCancel(status)`), cursor encoding, and postcode syntax. The API's Jest suite and the web's Vitest suite both import the same package; the package's own Vitest suite runs once per change. What the API must not do is reimplement a shared rule with subtly different behaviour: if the API decides cancellability with `status in ('PENDING','PAID')` and the web with `canCancel()`, the "Cancel" button and the server disagree for `PACKED`.

```ts
// packages/contracts/src/order-status.ts: one rule, imported by NestJS and React
export const CANCELLABLE = ['PENDING', 'PAID'] as const;
export const canCancel = (status: string): boolean => (CANCELLABLE as readonly string[]).includes(status);
```

```ts
// apps/api/src/orders/orders.service.ts (excerpt)
import { canCancel } from '@shop/contracts';
// ...
if (!canCancel(order.status)) throw new ConflictException({ code: 'ORDER_NOT_CANCELLABLE' }); // same rule as the button
```

#### Production scenario

A storefront's unit layer is 900 tests in 11 s on CI: 340 in `packages/contracts` (formatters, schemas with refinements, status rules), 410 reducers and pure helpers in the web app, and 150 hook tests. They run first in the pipeline (after `tsc`) so a broken formatter fails a pull request in under a minute, before the slower component and e2e jobs start. Watch mode reruns only the tests affected by a saved file, typically 5 to 30 tests in under a second.

#### Failure scenario

A developer changed `formatMoney` to use `Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(minor) / 100)`, because it was shorter. All component tests passed: their fixtures used amounts like `129900`. Two weeks later a B2B customer placed a bulk order of `1,234,567,890,123.45` in Indonesian rupiah, and the confirmation page showed a total that differed from the invoice by 3 rupiah. The table-driven test with a value beyond `Number.MAX_SAFE_INTEGER` existed in the API's repository but not in the web's. Moving the formatter and its tests into `@shop/contracts`, used by both, removed the duplicate and the gap.

#### Edge cases & failure modes

- **Fake timers and promises.** `vi.advanceTimersByTime` (sync) does not flush promise callbacks between timers; a retry loop with `await` stalls. Use `vi.advanceTimersByTimeAsync`.
- **Fake timers and Testing Library.** `user-event` waits with real timers by default; with fake timers create it with `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`.
- **`Intl` differences between Node versions** (ICU data, narrow no-break spaces in some locales) make formatter snapshots fail after a Node upgrade; normalise spaces or pin the CI Node version.
- **Module mocks leak** between tests in the same file if return values are set with `mockReturnValue` and not reset; `restoreMocks: true` resets spies, `vi.mocked(fn).mockReset()` resets `vi.fn()` mocks created in factories.
- **Time zone dependence.** A date-bucketing test passes in Bengaluru and fails on a UTC runner; set `process.env.TZ` in the config or pass the zone explicitly (72.7).
- **jsdom is not a browser.** It has no layout (`getBoundingClientRect` returns zeros), no `IntersectionObserver`, no `matchMedia` by default. Hooks that depend on them need small fakes or a real browser (Vitest Browser Mode, or Playwright component tests).

#### How a Senior Full-Stack Engineer thinks about this

The senior writes unit tests where the logic is dense and the inputs are many, and keeps them in the package that owns the rule, so the backend and frontend share both the code and its tests. They prefer table-driven tests because a table is reviewable: a reviewer can spot the missing case (zero, negative, very large) without reading code. They mock a module only when the subject of the test is the code that calls it (a retry policy), never when the subject is the module itself. And they do not unit-test components by mocking their children: that is a component test's job, done without the mocks.

#### Common mistakes

- **Testing implementation details of hooks**: asserting how many times an internal `useState` setter was called.
- **Forgetting `act()`** around hook updates and silencing the warning instead of fixing it.
- **Using real timers** in retry tests and waiting 3 real seconds per test.
- **Running pure-function tests in jsdom**, paying 100-300 ms of environment start-up per file for nothing.
- **Duplicating shared rules** in web and API code, each with its own tests that agree with themselves.

#### Interview questions

1. **When would you mock a module in a frontend unit test?** Expected answer: when the subject is the caller's policy (retry, caching, sequencing) and the module's own behaviour is tested elsewhere; never your API client in a test about screen behaviour.
2. **How do you test a hook that retries with backoff?** Expected answer: `renderHook`, fake timers, `vi.advanceTimersByTimeAsync` inside `act`, assert calls and arguments (same idempotency key).
   Follow-up: why not the sync `advanceTimersByTime`? (It does not flush promise callbacks between timers.)
3. **Vitest or Jest for a new Vite or Next.js project?** Expected answer: Vitest for shared Vite config, native ESM and speed; Jest remains fine where it is established, with `next/jest` for Next.js.
4. **Why test a money formatter with a value above `Number.MAX_SAFE_INTEGER`?** Expected answer: it proves no floating-point conversion happens; minor units travel as strings (72.7).
5. **What is jsdom missing, and what do you do about it?** Expected answer: layout, observers, media queries and real rendering; fake the API minimally or move the test to a real browser.

#### Practical exercise

Write the unit layer for the order status rules and the checkout hook.

Acceptance criteria:

- `canCancel`, `formatMoney` and `encodeCursor`/`decodeCursor` live in `@shop/contracts` with table-driven tests, including a value above `Number.MAX_SAFE_INTEGER` and an unknown status string.
- The NestJS cancel endpoint and the web "Cancel" button both import `canCancel`; a test in each proves it.
- `usePlaceOrder` tests cover: timeout then success with the same key, `409 IDEMPOTENCY_IN_PROGRESS` retried, a `422` clearing the key, an unknown outcome keeping it, and a second submit refused, all in under 200 ms total with fake timers.
- Pure-function test files run in the `node` environment.
