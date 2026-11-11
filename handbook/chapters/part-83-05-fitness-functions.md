## 83.5 Architecture fitness functions

#### Concept

An architecture fitness function is an automated test that checks whether the system still has the architectural properties you want: that layers are respected, that dependency rules hold, that latency stays within budget, that bundle sizes do not balloon. It is the mechanism that turns a standard from a document into an enforced rule, because it runs on every change and fails the build when the architecture drifts. If standards and paved roads are how you establish good architecture, fitness functions are how you *keep* it — they are the automated immune system that catches architectural erosion the moment it happens, not two years later during an incident.

#### Why does it exist?

Imagine an architecture where the rule is "the controller layer may call the service layer, but the service layer must never import a controller". Everyone agrees. Then, over two years and a thousand pull requests, someone, under deadline pressure, imports a controller into a service "just this once". Nobody notices in review. Then it happens again. Slowly, the clean layering erodes into a tangle, and by the time anyone notices, unwinding it is a major project. The rule was real, everyone believed in it, and it decayed anyway, because nothing enforced it on every change.

Fitness functions exist because architectural rules enforced by human vigilance always decay — reviewers get tired, deadlines press, new people do not know the rule. An automated check never gets tired and runs on every single change, so the rule holds for years. It converts "we try to respect layering" into "the build fails if you violate layering".

#### Mental model

Imagine a bank vault with a rule: certain doors must never be open at the same time. You could post a guard to watch (human vigilance — tires, gets distracted, leaves at night). Or you could install an interlock that physically makes it impossible to open the second door while the first is open (automated enforcement — never tires, works at 3 a.m., no exceptions). A fitness function is the interlock. The architectural rule is enforced by a mechanism that cannot be forgotten or pressured, so the property holds continuously rather than depending on everyone remembering it on every change forever.

#### How it works

Fitness functions come in several kinds, enforcing different properties:

```text
- Dependency / layering rules: service layer must not import controllers;
  module A must not depend on module B's internals.
- Module boundary rules:       cross-module imports must go through public APIs.
- Latency budgets:             a critical endpoint's p99 must stay under N ms
  (checked in a perf test in CI, or as an alert in prod).
- Resource budgets:            bundle size, image size, dependency count.
- Convention checks:           every service uses the standard error filter;
  every endpoint is authenticated unless explicitly public.
- Schema / contract checks:    events match the registered schema; the API
  matches the OpenAPI contract (§53.6).
```

They run where changes happen — in CI, on every pull request — so a violation fails the build and is fixed before it merges, when it is a one-line change, rather than after it has spread.

A **dependency-cruiser** configuration enforces layering and module rules in a TypeScript/NestJS codebase:

```json
{
  "forbidden": [
    {
      "name": "no-service-to-controller",
      "comment": "Service layer must never import a controller",
      "severity": "error",
      "from": { "path": "\\.service\\.ts$" },
      "to": { "path": "\\.controller\\.ts$" }
    },
    {
      "name": "no-cross-module-internals",
      "comment": "Modules may only import another module's public index",
      "severity": "error",
      "from": { "path": "^src/modules/([^/]+)/" },
      "to": {
        "path": "^src/modules/(?!\\1)([^/]+)/(?!index\\.ts)",
        "pathNot": "^src/modules/[^/]+/index\\.ts$"
      }
    },
    {
      "name": "no-orphans",
      "comment": "No unreachable dead modules",
      "severity": "warn",
      "from": { "orphan": true },
      "to": {}
    }
  ]
}
```

A **latency-budget fitness function** as a Jest test, run in CI against a built service, keeps a critical path within its budget:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import * as request from 'supertest';

describe('architecture fitness: latency budget', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createApplication();
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('GET /products/:id p95 stays under the 50ms budget', async () => {
    const server = app.getHttpServer();
    const samples: number[] = [];
    // warm up, then measure 200 requests against a seeded test DB
    for (let i = 0; i < 20; i++) await request(server).get('/products/seed-1');
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await request(server).get('/products/seed-1').expect(200);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // The budget is the architectural property we refuse to lose
    expect(p95).toBeLessThan(50);
  });
});
```

If a change introduces an N+1 query or a slow dependency on this path, the test fails in CI and the regression never reaches production. The budget (50 ms) is an architectural commitment enforced automatically.

A **convention fitness function** asserting every service wires the standard error filter:

```ts
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { StandardErrorFilter } from '@org/paved-road';

it('architecture fitness: uses the standard error filter', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  // The paved-road standard is enforced, not merely hoped for
  const filters = moduleRef.get(APP_FILTER, { strict: false });
  const usesStandard = (Array.isArray(filters) ? filters : [filters])
    .some((f) => f instanceof StandardErrorFilter);
  expect(usesStandard).toBe(true);
});
```

#### Practical example

An org that enforces module boundaries with the dependency-cruiser rule above gets a concrete benefit when it later wants to extract a module into its own service (Part 84). Because the boundary rule has been enforced on every PR for a year, the module has *no* illegal cross-module imports — the fitness function made that impossible. Extraction, which is a nightmare when modules have tangled into each other, is a clean operation: the module already talks to others only through public interfaces, so replacing those interfaces with network calls is mechanical. The fitness function did not just keep the codebase tidy; it preserved the *optionality* to extract, which is worth far more. Architecture kept clean by automation stays extractable; architecture kept clean by hope does not.

#### Artifact example

A fitness-function catalogue — the artifact that documents which architectural properties are automatically enforced, so teams know the rules are real and checked.

```markdown
# Architecture fitness functions (run on every PR)

| Property enforced | Mechanism | Severity | Owner |
|---|---|---|---|
| Service layer never imports controllers | dependency-cruiser | error (blocks) | platform |
| Cross-module imports go through public index only | dependency-cruiser | error | platform |
| No orphaned / dead modules | dependency-cruiser | warn | platform |
| GET /products/:id p95 < 50ms | Jest perf test vs seeded DB | error | catalog team |
| Service wires the standard error filter | Jest unit test | error | platform |
| Every endpoint authenticated unless @Public() | custom lint rule | error | security |
| Bundle/image size within budget | CI size check | warn | platform |
| Events match registered schema | schema-registry check | error | data |

## Principles
- Fitness functions enforce architecture so humans don't have to remember.
- "error" blocks merge; "warn" surfaces drift without blocking (for trends).
- Each has an owner who maintains it and handles false positives.
- A new standard isn't "done" until it has a fitness function (§53.3).
```

The catalogue makes the enforced architecture visible and owned, distinguishes blocking from advisory checks, and ties back to the standards principle: a standard is not real until a fitness function enforces it. It is the proof that the architecture is kept by automation, not hope.

#### Real-world scenario

A team adds a latency-budget fitness function to its checkout endpoint after an incident where a well-meaning refactor introduced an N+1 query that only showed up under production load, causing a slow checkout during a sale. The fitness function runs 200 requests against a seeded database on every PR and fails if p95 exceeds the budget. Three months later, a different engineer makes a change that re-introduces an N+1 pattern — and the build fails, in CI, before the change merges, with a clear message that the latency budget was exceeded. The engineer finds and fixes the N+1 in twenty minutes, and it never reaches production. The same class of bug that previously caused a customer-facing incident during a sale is now a routine failed check caught in review. The fitness function converted a recurring production incident into a caught-in-CI non-event.

#### Failure scenario

A team writes a latency fitness function but runs it against an empty, unseeded test database. With no data, every query is instant, so the test always passes regardless of the actual query efficiency — it would pass even for a query that does a full table scan, because there is nothing to scan. For a year the team believes their latency is protected. Then a change ships an O(n) query that is instant on the empty test DB and catastrophic on the production table with ten million rows. The incident happens exactly as if there were no fitness function at all, because the fitness function tested a fiction. A fitness function is only as good as the realism of what it tests; a performance check against unrealistic data is false assurance, which is worse than no check because the team stops watching the thing they believe is guarded. Fitness functions must test against realistic conditions, or they enforce an illusion.

#### Edge cases & failure modes

- **Testing against unrealistic data.** A latency check against an empty DB passes for any query; it enforces an illusion.
- **Flaky fitness functions.** A perf test with high variance fails randomly, so people add retries or disable it, and the enforcement evaporates.
- **No owner for false positives.** When a fitness function blocks a legitimate change wrongly, someone must own fixing it fast, or teams will route around all of them.
- **Fitness functions as warn-only forever.** A check that only warns and never blocks is advisory; drift accumulates because nothing is forced.
- **Checking the wrong property.** A fitness function that enforces a rule nobody actually cares about adds friction without value.
- **No fitness function for a critical standard.** The standard exists on paper but nothing enforces it, so it decays (the 83.3 failure).

#### How a Principal Engineer thinks about this

They treat fitness functions as the enforcement arm of every standard: a standard without a fitness function is a wish, so they consider a standard "done" only when an automated check guards it. They insist fitness functions test *realistic* conditions — seeded data for latency, real module graphs for dependency rules — because they know a check against a fiction is false assurance that is worse than no check, since it stops people watching the thing they believe is guarded.

They distinguish blocking (error) from advisory (warn) checks deliberately: block the properties you refuse to lose (layering, auth, critical latency), warn on the ones you want to watch as trends (bundle size creep). And they assign every fitness function an owner responsible for keeping it green and handling false positives quickly, because a flaky or wrongly-blocking check teaches teams to disable checks, which destroys the whole enforcement regime. The goal is architecture that stays correct for years without human vigilance — and that only works if the automated checks are realistic, stable, and owned.

#### Common mistakes

- **Latency/perf checks against empty or unrealistic data,** enforcing an illusion.
- **Flaky fitness functions** that get retried or disabled, evaporating the enforcement.
- **Leaving every check as warn-only,** so drift accumulates with nothing forced.
- **Writing a standard without the fitness function that enforces it,** so it decays.
- **No owner for false positives,** so a wrongly-blocking check teaches teams to bypass all checks.

#### Interview questions

1. **What is an architecture fitness function and why is it necessary?**
   *Expected answer:* an automated test (in CI, on every change) that checks the system still has a desired architectural property — layering, dependency rules, latency budget, conventions. It is necessary because rules enforced by human vigilance always decay under deadline pressure and turnover, while an automated check never tires and runs on every change. *Follow-up:* give a concrete example and how you'd implement it.

2. **Your latency fitness function always passes, but production latency regressed anyway. What likely went wrong?**
   *Expected answer:* the check probably runs against unrealistic data (empty or tiny test DB), so inefficient queries are instant in the test and catastrophic in production; the fitness function enforced a fiction. Fix by testing against seeded, realistic data. *Why it matters:* tests whether they understand that a check is only as good as the realism of what it tests.

3. **How do fitness functions relate to standards and paved roads?**
   *Expected answer:* the paved road establishes good architecture by default, standards define the rules, and fitness functions enforce them automatically on every change — turning a documented standard into an enforced one. A standard is not real until a fitness function guards it. *Why it matters:* ties the whole governance model together.

#### Practical exercise

Write one real fitness function for a system you work on. Options: a dependency-cruiser rule enforcing a layering or module boundary, a Jest latency-budget test against a *seeded* database for a critical endpoint, or a convention check that a standard (error filter, auth guard) is wired. Add it to CI so it runs on every change.

**Acceptance criteria:** the fitness function enforces a property you genuinely care about; if it is a performance check, it runs against realistic seeded data (not an empty DB); it is stable (not flaky) so it will not get disabled; and it actually fails when you deliberately introduce a violation, proving it enforces the rule rather than passing vacuously.
