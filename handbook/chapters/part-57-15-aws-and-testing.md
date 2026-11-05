### Q212. How do you run Postgres on RDS properly?

- **Expected answer** — **Multi-AZ** is availability, not scale: a synchronous standby in another AZ that takes over on failure with a DNS change, typically 60–120 seconds of write unavailability, and your application must reconnect cleanly (which means a connection pool that handles errors and retries idempotent work, and a DNS TTL you do not cache forever). **Read replicas** are asynchronous and are for scaling reads; they lag, so read-your-writes must be handled (see the distributed-systems section). Backups: automated snapshots plus continuous WAL archiving give point-in-time recovery to any second within the retention window; test a restore, because an untested backup is a hope. Parameter groups are where you set `work_mem`, `max_connections`, `statement_timeout`, `log_min_duration_statement` and autovacuum tuning — the defaults are conservative and generic. Use **RDS Proxy** or PgBouncer when many small compute units (Lambda, lots of pods) would otherwise exhaust connections. Monitoring: Performance Insights for wait events and top SQL, plus CloudWatch on CPU, `FreeableMemory`, `ReadIOPS`/`WriteIOPS`, burst balance on gp2, replica lag, and connection count. Upgrades need a plan: minor versions during a window with Multi-AZ to reduce impact, major versions rehearsed on a clone with `EXPLAIN` comparisons, because a planner change can regress a query.

- **Why it matters** — Most teams use managed Postgres and still need to operate it well.

- **Follow-ups** — What happens to in-flight transactions during a Multi-AZ failover? How do you test a restore? What is your major-version upgrade plan?

- **Senior signal** — Multi-AZ is availability not scale, tested restores, and rehearsing major upgrades for plan regressions.

### Q213. SQS, SNS, EventBridge or Kinesis?

- **Expected answer** — **SQS** is a queue: one consumer group, at-least-once delivery, visibility timeouts, dead-letter queues, and FIFO queues when you need ordering and deduplication within a message group (at much lower throughput). Use it for work queues and buffering. **SNS** is pub/sub fan-out: one publish, many subscribers, no retention — pair it with SQS (the fan-out-to-queues pattern) so each consumer gets its own durable queue. **EventBridge** is a routing bus with content-based rules, schemas, archives and replay, plus SaaS integrations; it is the better choice for a domain event backbone where consumers come and go, at higher per-event latency than SNS. **Kinesis** (or MSK for Kafka) is an ordered, partitioned, replayable stream for high-volume data where multiple consumers read at their own position — analytics pipelines, clickstreams, change data capture. Choosing: do you need replay and ordering (Kinesis/Kafka), fan-out to independently-failing consumers (SNS+SQS or EventBridge), or a simple durable work queue (SQS)? And the same caveat as always: everything here is at-least-once, so consumers must be idempotent, and every queue needs a DLQ with an alarm on depth.

- **Why it matters** — Picking the wrong primitive here is expensive to undo once producers exist.

- **Follow-ups** — Why SNS to SQS rather than SNS directly to a service? What does an SQS visibility timeout do when processing takes longer than expected? When do you need FIFO?

- **Senior signal** — The fan-out-to-queues pattern, visibility-timeout semantics, and DLQ alarms as non-negotiable.

### Q214. Explain the VPC pieces a backend engineer must understand.

- **Expected answer** — A VPC is a private network with subnets per availability zone. **Public subnets** have a route to an internet gateway; **private subnets** do not, and reach the internet through a **NAT gateway** in a public subnet. Your application and database belong in private subnets; only load balancers live in public ones. **Security groups** are stateful, instance-level allow-only rules (return traffic is automatically permitted) and can reference other security groups, which is the clean way to say "the database accepts traffic from the app tier". **NACLs** are stateless, subnet-level, and support deny rules; most teams use the defaults and rely on security groups. Two things that bite: NAT gateways charge per gigabyte processed, so heavy S3 or ECR traffic through NAT is a large and invisible bill — use **VPC endpoints** (a free gateway endpoint for S3 and DynamoDB, interface endpoints for other services) to keep that traffic off NAT and off the public internet; and cross-AZ data transfer is billed, so chatty services spread across zones cost money. Also plan CIDR ranges with room to grow and avoid overlaps if you will ever peer VPCs or connect on-premises networks.

- **Why it matters** — Networking mistakes here show up as both security exposure and surprising bills.

- **Follow-ups** — Why is a security group referencing another security group better than a CIDR? What is the cheapest fix for a large NAT bill? Where do you put an RDS instance?

- **Senior signal** — VPC endpoints for NAT cost, stateful-versus-stateless distinction, and CIDR planning.

### Q215. When is Lambda the wrong choice?

- **Expected answer** — When latency consistency matters and cold starts are unacceptable: a cold start for a Node function is typically 100–500 ms, worse inside a VPC historically and worse with a large bundle, and provisioned concurrency fixes it at a cost that erodes the economics. When the workload is steady and high volume — at sustained load, containers on Fargate or EC2 are usually cheaper than per-invocation pricing. When execution exceeds 15 minutes, or needs a lot of memory or local disk. When you need many long-lived connections: every concurrent Lambda holds its own database connection, so 500 concurrent executions is 500 connections, which is why RDS Proxy exists. When the workload needs a persistent in-process cache or a warm connection pool, both of which die with the execution environment. And when the team's debugging, testing and local development story would suffer — a monolith split into 40 Lambdas often produces a distributed system nobody can trace. Where Lambda is excellent: event-driven glue, S3 and DynamoDB triggers, scheduled tasks, image processing, and spiky low-volume APIs where scale-to-zero is real money saved.

- **Why it matters** — Serverless enthusiasm without cost and latency analysis produces expensive rewrites.

- **Follow-ups** — How do you estimate the crossover point between Lambda and Fargate cost? What does RDS Proxy actually solve? How do you keep a Lambda warm and is that a good idea?

- **Senior signal** — Concrete numbers for cold starts and the connection-per-execution problem, plus a fair list of where Lambda genuinely wins.

### Q216. ALB or NLB, and what do you configure?

- **Expected answer** — An **ALB** is layer 7: it understands HTTP, routes by host, path and header, terminates TLS, supports HTTP/2 and WebSockets, and integrates with WAF and Cognito. An **NLB** is layer 4: it forwards TCP/UDP with very low latency, preserves the client IP, handles millions of connections, and gives you a static IP — the right choice for non-HTTP protocols, extreme throughput or when a client needs to allow-list an IP. For a normal API, ALB. Configuration that matters: target group health checks (path, interval, healthy/unhealthy thresholds) determine how fast a bad instance is removed and how a slow start is treated; **deregistration delay** (default 300 seconds) is the drain window and must exceed your longest request; the ALB **idle timeout** (default 60 seconds) must be *shorter* than your Node server's `keepAliveTimeout`, or the ALB will reuse a connection the server is closing and you get intermittent 502s — this is a well-known Node-behind-ALB failure and the fix is setting `server.keepAliveTimeout` and `headersTimeout` above 60 seconds. Also enable access logs, use `X-Forwarded-For` correctly (trusting only the last hop from the ALB), and prefer target type `ip` with ECS/EKS for direct pod routing.

- **Why it matters** — The keep-alive mismatch causes recurring, hard-to-explain 502s in exactly this stack.

- **Follow-ups** — Why do you get 502s with the default Node keep-alive timeout? What does deregistration delay do during a deploy? When do you need an NLB?

- **Senior signal** — The `keepAliveTimeout` versus idle-timeout ordering, which only comes from having debugged it.

### Q217. Where does cloud spend actually go, and how would you cut it?

- **Expected answer** — Start with data, not intuition: Cost Explorer grouped by service and tag, and a tagging policy that makes per-team and per-environment attribution possible. The usual big items for a backend platform: over-provisioned compute (instances sized for a peak that never comes, or requests set to double actual usage across every pod), RDS instances sized for headroom and never revisited, **data transfer** — NAT gateway processing, cross-AZ traffic and internet egress, which is frequently the surprise line item — storage that never expires (old snapshots, unpartitioned logs in S3 Standard, CloudWatch log groups with infinite retention), and idle non-production environments running 24/7. The moves, roughly in order of effort-to-savings: right-size from observed metrics, set log and object retention policies, add VPC endpoints to bypass NAT, schedule non-production environments off outside working hours, buy Savings Plans or Reserved Instances for the steady baseline once usage is stable, use Graviton instances (usually 15–25% better price/performance for Node workloads), and use S3 lifecycle tiering. The discipline that makes it stick: a cost dashboard reviewed monthly, an alert on anomalous daily spend, and cost as a line item in design reviews — because the cheapest fix is not building the expensive thing.

- **Why it matters** — Cost ownership is an explicit part of senior scope in most companies now.

- **Follow-ups** — What is your largest line item and why? How would you attribute cost to teams? What is the risk of buying reservations too early?

- **Senior signal** — Measures before cutting, names data transfer as the hidden cost, and treats cost as a design-review input.

### Q218. Design a disaster recovery plan.

- **Expected answer** — Start with the business numbers: **RPO** (how much data can we lose) and **RTO** (how long can we be down), agreed with the business, per system — the payments database and the recommendations cache do not need the same answer. Then pick a strategy that meets them: **backup and restore** (cheapest, RTO of hours), **pilot light** (core data replicated, infrastructure defined as code but scaled to zero, RTO of tens of minutes), **warm standby** (a scaled-down running copy, RTO of minutes), **active-active** (near-zero RTO, highest cost and complexity). For a typical setup: Multi-AZ RDS covers zone failure automatically, cross-region automated snapshot copies plus PITR cover region loss with an RPO of minutes, infrastructure as code lets you rebuild the stack, and S3 cross-region replication protects object data. Then the part that distinguishes a real plan from a document: test it. Run a restore exercise on a schedule, measure the actual RTO rather than the hoped-for one, and record what was missing — DNS TTLs, secrets that only exist in one region, an unreplicated queue, a hard-coded endpoint. Also cover the non-infrastructure failures: accidental deletion (versioning, soft delete, delayed replication so a bad delete does not replicate instantly), and a compromised account (separate backup account with restricted access).

- **Why it matters** — Untested DR is the most common form of imaginary safety.

- **Follow-ups** — What is your measured RTO, not your target? How do you protect backups from a compromised admin? What breaks first in a region failover?

- **Senior signal** — Business-agreed RPO/RTO per system, tested restores with measured numbers, and protection against deletion as well as outage.

## 57.18 Testing

### Q219. What does your test suite look like for a NestJS service?

- **Expected answer** — Weighted toward fast, meaningful tests. A large base of **unit tests** for pure logic — pricing rules, state machines, validators, mappers — with no framework and no I/O, running in milliseconds. A substantial middle layer of **integration tests** that exercise a service with a real Postgres (via Testcontainers) and real repositories, mocking only third parties; this is where most of the value is for a backend, because the interesting bugs are in SQL, transactions and constraints, and those are precisely what mocks hide. A thin layer of **end-to-end tests** through the HTTP surface with `supertest` against a fully-bootstrapped app, covering the critical user journeys — checkout, login, payment — not every endpoint. Plus contract tests where multiple teams share an interface, and a handful of smoke tests that run against a deployed environment. The framing I use is the "test trophy" rather than a strict pyramid: for backend services, integration tests earn their weight, and a suite of 3,000 heavily-mocked unit tests can pass while the application is completely broken. The constraint is time: the whole suite should run in a few minutes, or people stop running it.

- **Why it matters** — Test strategy determines whether a codebase can be changed confidently.

- **Follow-ups** — Which layer catches your most common production bugs? How do you keep integration tests fast? What do you do when the suite takes 25 minutes?

- **Senior signal** — Argues for integration weight with a reason, and treats suite duration as a first-class constraint.

### Q220. What do you mock and what do you refuse to mock?

- **Expected answer** — Mock at boundaries you do not own and cannot run: payment gateways, email and SMS providers, third-party HTTP APIs, and time. Do not mock your own database — a mocked repository asserts that you called a method, not that the query is correct, so it cannot catch a wrong join, a missing index-backed constraint, a transaction that does not roll back, or a `NOT NULL` violation, which are exactly the failures that reach production. Do not mock the framework's own machinery in a way that means your pipes, guards and filters never run in tests. And avoid mocking internal collaborators just to isolate a class: over-mocking couples the test to the implementation, so every refactor breaks tests without any behaviour changing, which trains the team to distrust the suite. For third-party HTTP I prefer a recorded/faked server (nock, MSW, or a WireMock container) over hand-written mocks, because it exercises the real client, serialisation and error handling. And for external providers, add a small number of contract or sandbox tests that run against the real thing on a schedule, so a provider's breaking change is discovered by you rather than by customers.

- **Why it matters** — The mocking line determines whether tests give real confidence or theatre.

- **Follow-ups** — How do you test that a transaction rolls back? What is wrong with `expect(repo.save).toHaveBeenCalled()`? How do you catch a provider changing their API?

- **Senior signal** — Refuses to mock the database and can name the specific bug classes mocks miss.

### Q221. How do you test database code without the suite becoming slow and flaky?

- **Expected answer** — Use a real Postgres — Testcontainers spins one up per suite, or a shared local instance with per-worker databases. Run migrations once at startup rather than per test. Then isolate tests: the fastest reliable approach is to wrap each test in a transaction and roll back at the end, which is very quick but breaks if the code under test manages its own transactions or if you need to test commit behaviour; the alternative is truncating the affected tables between tests (`TRUNCATE ... RESTART IDENTITY CASCADE`), which is slower but always correct. Never share mutable fixture data across tests, and never rely on test ordering. Parallelism: give each Jest worker its own database (`test_db_1`, `test_db_2`) so tests do not fight over rows, which is the single biggest speed win. Seed with factories that create only what a test needs rather than a giant shared fixture, so a test's preconditions are visible in the test itself. And test the things only a real database can show: unique-violation handling, cascade behaviour, concurrent updates with two connections, and that a failing step actually rolls back the whole unit of work.

- **Why it matters** — Database tests are where most backend confidence comes from, and where most suite slowness comes from too.

- **Follow-ups** — How do you test a deadlock or a concurrent update? Transaction rollback or truncate, and when does each fail? How long should 500 integration tests take?

- **Senior signal** — Per-worker databases for parallelism and a clear-eyed comparison of the isolation strategies.

### Q222. Why are tests flaky, and how do you deal with flakiness?

- **Expected answer** — Causes, in the order I usually find them: shared mutable state between tests (a database row, a module-level cache, a mocked singleton not reset); time — tests that depend on `Date.now()`, timezones, or a sleep that is usually long enough; async leaks where a promise is not awaited so an assertion runs before the effect; ordering dependence, exposed the moment you shuffle or parallelise; real network calls to a flaky third party; and genuine race conditions in the code, which are the valuable ones. The policy matters as much as the fixes: a flaky test is a broken test, because a suite people re-run until it goes green provides no signal. So quarantine it immediately (skip it with a ticket and an owner), fix it within a bounded time, and track flake rate as a metric. Never add a blanket retry to hide it — retries turn a real intermittent bug into an invisible one. Practical prevention: fake timers and an injected clock instead of `Date.now()`, deterministic seeded random, no `sleep` in tests (wait on a condition instead), reset all state in `beforeEach`, and run the suite in random order in CI so ordering dependence is found early.

- **Why it matters** — Flakiness silently destroys the value of an entire test suite.

- **Follow-ups** — Would you ever retry a test in CI? How do you test code that uses `Date.now()`? How do you find an ordering dependency?

- **Senior signal** — Treats flakiness as a broken-signal problem with a policy, and rejects blanket retries.

### Q223. How do you test event-driven and queue-based code?

- **Expected answer** — Split it into layers. The handler itself is a plain function that takes a message and does work — test it directly, including the duplicate case (call it twice with the same message and assert the effect happened once) and the malformed-message case. The wiring — that the consumer subscribes to the right topic, deserialises correctly, acks and dead-letters — is an integration test with a real broker container or the framework's testing support, asserting on observable effects rather than internal calls. For the producer side, assert that the outbox row is written in the same transaction as the business change, and separately that the relay publishes it. Avoid the common trap of tests that `await sleep(2000)` and hope: poll for the expected condition with a timeout instead, so the test is both faster and less flaky. Also test the ordering and failure behaviour explicitly: what happens when messages arrive out of order, when a handler throws, when the same message arrives after a redelivery. And keep a contract test on the message schema so a producer change that breaks consumers is caught in CI rather than at 2 a.m.

- **Why it matters** — Async code is where teams' test coverage is weakest and production surprises are highest.

- **Follow-ups** — How do you assert "exactly one email was sent" for a duplicated message? How do you avoid sleeps? Where do you test the DLQ path?

- **Senior signal** — Tests idempotency and out-of-order arrival explicitly, and polls conditions instead of sleeping.

### Q224. How do you test time-dependent behaviour and scheduled jobs?

- **Expected answer** — Inject the clock. A `Clock` provider with a `now()` method (or a `DateProvider` token in Nest) means tests can set the time explicitly, and production code never calls `Date.now()` directly. Use fake timers (`jest.useFakeTimers()` with `advanceTimersByTime`) for code that uses `setTimeout`/`setInterval`, remembering to restore real timers afterwards or every later test inherits a frozen clock. Test the edges deliberately, because that is where the bugs are: daylight-saving transitions, month and year boundaries, leap days, timezone conversion for a user in a different zone from the server, and expiry exactly at the boundary. Store and compute in UTC (`timestamptz` in Postgres) and convert only at the presentation edge. For scheduled jobs, separate the schedule from the work: test the work as an ordinary function, and test the schedule wiring lightly. Add the operational test too — a job that silently stops running produces no failures, so assert on a "last successful run" record and alert on staleness rather than assuming the cron fired.

- **Why it matters** — Time bugs are subtle, seasonal, and often only reproduce in production.

- **Follow-ups** — Your billing job double-charged on the DST change. How would a test have caught it? Why is `timestamptz` important? How do you know a nightly job ran?

- **Senior signal** — Injected clock plus explicit edge cases, and monitoring for jobs that stop firing.

### Q225. How do you manage test data?

- **Expected answer** — Factories, not fixtures. A factory function creates a valid entity with sensible defaults and lets the test override only the fields it cares about (`createOrder({ status: 'pending', total: 5000 })`), so the test reads as a statement about behaviour rather than a wall of unrelated setup, and adding a required column means changing one factory rather than 300 tests. Each test creates the data it needs and does not depend on anything left behind. Avoid a giant shared seed file: it becomes load-bearing, nobody dares change it, and tests start depending on incidental values. For end-to-end and staging environments, generate data with the same factories rather than restoring a production dump — production data in a test environment is a compliance incident waiting to happen, and if you must use it, it has to be anonymised properly (not just masked names, since ids and relationships re-identify people). Keep test data creation fast: bulk-insert where possible, and do not create 500 rows when 3 prove the point, except in the specific tests that exist to check behaviour at scale.

- **Why it matters** — Test data design decides whether a suite stays maintainable at 2,000 tests.

- **Follow-ups** — What breaks when tests share a seeded user? How do you build data for a pagination test? What is your policy on production data in lower environments?

- **Senior signal** — Factories with overrides, no shared seed, and a clear compliance line on production data.

