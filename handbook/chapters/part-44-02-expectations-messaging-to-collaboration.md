### 44.2.9 Messaging and async

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Publishes and consumes messages using existing wiring | Builds a consumer with retries, a dead-letter queue and idempotent handling | Designs topics, partitions, ordering guarantees, replay and poison-message handling | Owns the messaging platform, schema governance and consumer standards | Decides whether the company is event-driven, and where the boundaries are |
| A producer or consumer | A queue-backed feature | A service's async contracts and their failure behaviour | The broker fleet and the event catalogue | The company's integration model |
| Stopped assuming a message is delivered exactly once | Stopped acking before the work is durably done | Stopped ignoring consumer lag until it becomes an incident | Stopped letting teams publish events with no schema or compatibility rules | Stopped adding a broker where a synchronous call was correct |

The bar for senior is designing for at-least-once delivery as a fact of life. Every handler is idempotent, ordering is achieved by partition key rather than hope, retries have backoff and a limit, and there is a dead-letter path with a documented human procedure. "What happens to a message we cannot process?" has an answer that does not involve losing it.

The other senior skill is capacity thinking about queues. Partition count is chosen from the recovery requirement — how fast must a four-hour backlog drain — not from the steady-state rate. Consumer lag is alerted on in units of time, not messages, because "9 million messages behind" means nothing without a drain rate.

- **Junior**: adds a BullMQ job that sends a welcome email when a user registers.
- **Mid**: adds exponential backoff, a dead-letter queue, and a `processed_messages` table so a redelivery does not send a second email.
- **Senior**: keys the order events by `order_id` for per-order ordering, sizes partitions for a 30-minute recovery, and adds a lag alert measured in seconds.
- **Staff**: introduces a schema registry with backwards-compatibility checks in CI, ending a class of consumer breakages across five teams.
- **Principal**: decides which domains communicate by events and which stay synchronous, and writes the criteria so teams stop relitigating it.

### 44.2.10 Distributed systems

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Knows services call each other over a network that can fail | Handles timeouts and retries; understands eventual consistency | Reasons about partial failure, idempotency, ordering, consensus limits and sagas as a matter of routine | Designs consistency and failure models spanning teams | Sets the company's consistency, latency and availability posture |
| One call | One integration | A distributed workflow end to end | The interaction model between systems | The trade-offs the business is signing up for |
| Stopped assuming the network is reliable | Stopped retrying non-idempotent operations | Stopped treating a timeout as a failure rather than as unknown | Stopped letting each team invent its own saga pattern | Stopped promising strong consistency across systems that cannot provide it |

The mid-to-senior step is internalising that partial failure is the normal case, not the exception. Every design gets the interrogation: can it time out, duplicate, arrive late, arrive out of order, partially succeed; what is the source of truth; what happens when the dependency is down. Part 43 — The Senior Engineering Mindset is that question set in full.

The staff-and-above skill is choosing where consistency boundaries sit. Inside a boundary, a database transaction gives you correctness cheaply. Across a boundary, you are paying for eventual consistency with compensations, reconciliation and customer-visible intermediate states. Drawing that boundary in the right place is worth more than any amount of clever saga code.

- **Junior**: adds a `try/catch` around a service call after a review comment.
- **Mid**: adds a 2-second timeout and three retries with jitter to the shipping-provider client.
- **Senior**: replaces a two-phase-commit fantasy with an outbox plus a saga that has explicit compensation for a failed dispatch, and a reconciliation job.
- **Staff**: defines the standard saga and outbox implementation as a shared library so five teams stop writing subtly broken versions.
- **Principal**: writes the position that order state is eventually consistent with a 5-second target and payment state is strongly consistent, and gets product and finance to agree.

### 44.2.11 Reliability

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Fixes bugs; follows the runbook when paged | Adds health checks, graceful shutdown, and sensible retries | Designs for blast radius: timeouts, bulkheads, circuit breakers, load shedding, degradation | Sets SLOs and error budgets; drives reliability programmes across teams | Sets the availability posture and what the company will pay for it |
| A bug fix | A service's basic resilience | A service's failure behaviour under stress | The reliability model of a product area | The company's risk appetite |
| Stopped assuming happy paths | Stopped retrying without backoff or a cap | Stopped adding redundancy without testing the failover | Stopped setting SLOs nobody uses to make decisions | Stopped chasing nines without a business case |

Senior reliability work is mostly about limiting damage rather than preventing failure. Timeouts stop a slow dependency from becoming your outage. Bulkheads stop one endpoint from consuming every connection. Circuit breakers stop retry storms from finishing off a struggling service. Graceful degradation keeps the core transaction alive while a peripheral feature is off.

Above senior, the work becomes economic: SLOs that reflect what users actually notice, an error budget that gives teams permission to ship when they are within it and forces reliability work when they are not, and honest conversations about what another nine costs.

- **Junior**: follows the runbook to restart a stuck consumer at 02:00 and writes what happened in the channel.
- **Mid**: adds `@nestjs/terminus` health checks and graceful shutdown so deploys stop dropping requests.
- **Senior**: adds a bulkhead of four concurrent payment calls per pod and a circuit breaker, converting a provider outage from a site-wide failure into slow checkouts.
- **Staff**: introduces SLOs for the five customer-facing journeys with error budgets, and gets the alerting rewritten to page only on budget burn.
- **Principal**: rejects a multi-region proposal with an analysis showing 99.95 percent single-region meets the contractual requirement at a third of the cost, and defines the conditions that would change the answer.

### 44.2.12 Security

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Follows auth patterns; does not commit secrets | Implements authn and authz correctly; validates input; understands common OWASP issues | Threat-models a design; owns authorisation architecture, secret lifecycle and data exposure | Sets security standards, review gates and the incident process for vulnerabilities | Owns the security posture and its trade-offs with delivery speed |
| A guarded endpoint | A feature's security controls | A service's threat model and its blast radius when credentials leak | The security baseline across teams | The company's risk position and compliance obligations |
| Stopped trusting client-side checks | Stopped forgetting object-level authorisation | Stopped treating security as a review step rather than a design input | Stopped relying on individual diligence instead of defaults that are safe | Stopped treating security as a blocker rather than a design constraint with a budget |

The single most valuable senior security habit is asking "who is allowed to call this, and how do I make the wrong answer impossible?" Object-level authorisation — verifying this order belongs to this caller — is the most common serious vulnerability in real systems, and the fix is structural: scope the query, not an `if` after the fetch.

The second is designing for leaks rather than only against them. Short-lived tokens, narrow scopes, tested rotation, and secrets that no human ever holds. A leaked credential should be an inconvenience, and whether it is one was decided months earlier.

- **Junior**: uses the existing `JwtAuthGuard` and puts the API key in the config rather than in the code.
- **Mid**: adds `ValidationPipe` with `forbidNonWhitelisted`, scopes queries by `customerId`, and fixes an IDOR found in review.
- **Senior**: threat-models the file-upload feature: signed URLs, MIME validation, size caps, virus scanning, and no user-controlled paths; then adds cross-tenant access tests.
- **Staff**: makes the safe path the default: a repository base class that requires a tenant scope, secret scanning in CI, and a dependency policy with an SLA on critical CVEs.
- **Principal**: decides the company holds no raw card data and integrates with a provider's hosted fields, removing an entire compliance scope permanently.

### 44.2.13 Testing

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Writes unit tests for their code | Writes integration tests with real dependencies in containers; keeps tests deterministic | Designs the test strategy: what to test where, concurrency tests, contract tests, and what not to test | Owns test infrastructure, speed and flakiness across teams | Sets the quality model and what confidence the company buys at what cost |
| A test file | A feature's test coverage | A service's test strategy and its CI feedback loop | The testing platform and its economics | The organisation's confidence strategy |
| Stopped writing tests that assert the mock was called | Stopped writing tests that pass whether or not the code is correct | Stopped chasing a coverage percentage instead of testing invariants | Stopped tolerating a flaky suite that everyone has learned to re-run | Stopped treating testing as a cost centre rather than as delivery speed |

The senior view: tests exist to let you change code confidently, and their value is measured by the bugs they would catch, not by coverage. That leads to a specific shape — a broad base of fast unit tests for logic, a solid middle of integration tests against a real PostgreSQL and Redis in Docker, and a thin top of end-to-end tests for the two or three journeys that must never break.

The tests that separate senior from mid are the ones for the things that are hard to test: 50 concurrent requests asserting stock never goes negative, a duplicate webhook producing one charge, a consumer crash between the database write and the offset commit. Those tests find real money bugs.

- **Junior**: writes unit tests for a price calculation with three cases including a zero-quantity edge case.
- **Mid**: sets up Testcontainers so the repository tests run against real PostgreSQL, and removes six brittle mocks.
- **Senior**: adds a concurrency test that fires 50 parallel reservations and asserts the invariant, catching a race that had been in production for months.
- **Staff**: cuts the CI suite from 22 minutes to 6 with parallelisation and a shared database template, and puts flaky tests on a quarantine list with owners.
- **Principal**: sets the standard that money-touching paths require property-based or contract tests, and that no service ships without a tested rollback path.

### 44.2.14 Performance

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Notices something is slow and reports it | Profiles a specific endpoint, fixes N+1 queries and obvious waste | Works from percentiles and evidence; finds the real constraint; knows when not to optimise | Sets performance budgets and capacity models across services | Decides where the company invests in performance and what it is worth |
| A slow function | An endpoint's latency | A service's latency profile and its saturation points | A product area's performance envelope | The performance/cost frontier |
| Stopped optimising based on a guess | Stopped using averages to reason about user experience | Stopped optimising code when the constraint was I/O or a lock | Stopped letting performance regress silently between releases | Stopped chasing latency where the business value was elsewhere |

The senior habit is refusing to touch anything until there is evidence: a flame graph, a query plan, a lock wait, a saturation metric. Most "slow application" problems are one query, one missing index, one serialised loop, one lock held too long. Rewriting the service is almost never the answer, and the engineers who reach for it are usually the ones who did not measure.

Percentiles are a professional requirement. Averages hide the experience of the users who are suffering. p99 is where the angry emails come from, and p99.9 is where your biggest customers live, because they make the most requests.

- **Junior**: reports that the orders page feels slow and shares a screenshot of the network tab.
- **Mid**: profiles the endpoint, finds an N+1 producing 340 queries, and fixes it with one join.
- **Senior**: shows that p99 latency is dominated by connection-pool queueing rather than query time, resizes the pool, adds a cache for the top queries, and proves the improvement on the graph.
- **Staff**: adds performance budgets to CI with a load test on the critical journeys, so regressions fail the build rather than surprising production.
- **Principal**: decides that the checkout journey gets a 300 ms p99 budget with the engineering investment to match, and the admin tools explicitly do not.

### 44.2.15 Observability

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Adds log lines; reads dashboards someone else built | Emits structured logs and metrics; builds a useful dashboard | Instruments for the 03:00 question; designs alerts on symptoms; owns correlation and tracing | Owns the observability platform, its cost and its conventions | Decides what the company must be able to see, and what that is worth |
| A log line | A service's dashboards and metrics | A service's full observability story, including alerts and runbooks | The telemetry pipeline and standards | The organisation's operational visibility |
| Stopped logging strings with no identifiers | Stopped logging at the wrong level and burying the signal | Stopped alerting on causes rather than on customer symptoms | Stopped paying for high-cardinality telemetry nobody queries | Stopped treating observability as a tool purchase rather than a practice |

The senior standard is simple: when this breaks at 03:00, can someone who has never seen the code find the cause in ten minutes? That requires a correlation id flowing from the gateway through services and into queue messages, structured logs with identifiers, metrics for business outcomes and not only technical ones, and traces on the paths that cross services.

Alert design is where seniority shows most. Page on what the customer feels — error rate, latency, orders per minute dropping — and leave cause metrics for the dashboard you open once you are awake. Every page must be urgent, actionable and documented, or it trains people to ignore pages.

- **Junior**: adds a log line at the start of a handler with the user id.
- **Mid**: adds a Prometheus counter and histogram for a new endpoint and puts them on the team dashboard.
- **Senior**: propagates a correlation id through HTTP, Kafka and BullMQ, adds business-metric alerts, and writes the runbook page for each one.
- **Staff**: standardises OpenTelemetry across services with a sampling policy that keeps cost flat while retaining every error trace.
- **Principal**: sets the requirement that every customer-facing journey has an owned SLO dashboard, and funds the platform work to make that cheap.

### 44.2.16 Docker and Kubernetes

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Runs the app in Docker Compose locally | Writes a multi-stage Dockerfile; understands probes, limits and manifests | Sizes requests and limits from evidence; handles PID 1, graceful shutdown, rollouts and disruption budgets | Owns cluster standards, base images and the deployment platform | Decides whether the company runs Kubernetes at all, and who operates it |
| A local environment | A service's container and manifests | A service's runtime behaviour in the cluster | The platform every team deploys onto | The infrastructure strategy |
| Stopped building 1.2 GB images from a full base image | Stopped ignoring memory limits until an OOMKill | Stopped copying resource limits from another service without measuring | Stopped letting each team maintain its own divergent manifests | Stopped adopting a platform the organisation cannot staff |

The senior details in Kubernetes are unglamorous and decide whether deploys are boring: a readiness probe that flips false before shutdown starts, `terminationGracePeriodSeconds` longer than the longest in-flight request, `preStop` sleep to let the load balancer notice, a liveness probe that does not check external dependencies, requests set from observed usage, and memory limits set above the Node heap limit plus overhead.

The most common expensive mistake at mid level is putting the database in the readiness probe. When the database blips, every replica reports unready simultaneously, the load balancer removes them all, and a 20-second database hiccup becomes a full outage.

- **Junior**: gets the service running under Docker Compose with PostgreSQL and Redis for local development.
- **Mid**: writes a multi-stage Dockerfile that ships a 180 MB image running as a non-root user with a proper init process.
- **Senior**: fixes deploy-time 502s with correct readiness, `preStop` and grace-period settings, and right-sizes CPU requests from a month of usage data.
- **Staff**: builds the shared Helm chart and base image with security patching, cutting per-service manifest drift to zero.
- **Principal**: decides three low-traffic internal services move to a managed container platform because the Kubernetes operational overhead is not justified for them.

### 44.2.17 Cloud

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Uses cloud resources that exist; reads the console | Provisions resources with infrastructure as code; understands the main managed services | Chooses between managed and self-run with cost, lock-in and operational reasoning; designs for zones and failure | Owns the cloud account structure, networking, IAM model and cost controls | Sets the cloud strategy, vendor relationship and the exit cost the company accepts |
| A resource | A stack for one service | A service's cloud footprint and its failure behaviour | The landing zone and platform | The company's infrastructure position |
| Stopped clicking things into existence in the console | Stopped ignoring which availability zone things live in | Stopped assuming managed always means reliable and hands-off | Stopped tolerating IAM policies with wildcard permissions | Stopped choosing services with a lock-in cost nobody quantified |

Senior cloud thinking is mostly a build-versus-buy calculation done honestly. A managed database costs more per month and less per year once you price the engineer time for backups, patching, failover testing and the 03:00 recovery. A managed Kafka is worth its price for most teams. A managed service you use for a trivial workload may not be.

The other senior discipline is failure-domain awareness: which resources are single-zone, what happens when a zone goes away, whether your backups are in a different account, and whether you have actually tested a restore this quarter.

- **Junior**: finds the log group in CloudWatch and reads the error.
- **Mid**: writes the Terraform for a service's queue, bucket and task definition instead of clicking it together.
- **Senior**: designs the S3 upload flow with presigned URLs, lifecycle rules to cheaper storage, and cross-region replication for the documents that legally require it.
- **Staff**: builds the multi-account landing zone with per-environment isolation, least-privilege roles, and budget alarms by team tag.
- **Principal**: negotiates the committed-use agreement based on a two-year capacity model, and defines which proprietary services are acceptable and which are not.

### 44.2.18 CI/CD

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Pushes branches; fixes their own red builds | Writes pipeline steps; keeps the build green; understands the deployment flow | Designs the pipeline: gates, artefacts, environments, migrations, canaries and rollback | Owns the delivery platform and the deployment standard across teams | Sets how the company ships: frequency, safety, and what is automated versus approved |
| A commit | A pipeline job | A service's path to production | The delivery platform | The engineering delivery model |
| Stopped leaving the build broken for others | Stopped skipping tests to get a release out | Stopped coupling schema migrations to application deploys | Stopped letting each team invent its own pipeline | Stopped adding approval gates that create risk by batching changes |

The senior insight is that deployment safety comes from small, frequent, reversible changes rather than from heavyweight approval processes. A team deploying ten times a day with automated tests, canaries and instant rollback is dramatically safer than one deploying monthly behind a change board, because every monthly release contains a hundred changes and nobody knows which one broke it.

Migrations are the usual weak point. They must be independently deployable, backwards compatible, and separate from long backfills. Getting this right is what turns "release night" into a Tuesday afternoon.

- **Junior**: fixes the lint failure that broke the pipeline and learns to run it locally first.
- **Mid**: adds the integration-test stage with a PostgreSQL service container and caching that halves build time.
- **Senior**: separates migrations from deploys, adds a canary stage with automatic rollback on error-rate breach, and documents the rollback-safety rule.
- **Staff**: builds the reusable workflow every service uses, with security scanning, SBOM generation and standard environments.
- **Principal**: sets the target of deploying on demand with no manual approvals for standard changes, and drives the controls that make an auditor comfortable with it.

### 44.2.19 Git and collaboration

| Junior | Mid | Senior | Staff | Principal |
|---|---|---|---|---|
| Commits, branches, opens pull requests | Writes clean history; rebases confidently; reviews peers usefully | Keeps changes small and reviewable; sets branching and review norms; unblocks others | Aligns workflow across teams; owns monorepo or multi-repo strategy | Sets collaboration norms and how the company handles code ownership |
| Their branch | Their feature's history | A repository's conventions and review culture | The source-control strategy | How the organisation collaborates on code |
| Stopped committing `node_modules` and secrets | Stopped opening 2,000-line pull requests | Stopped letting reviews sit for two days | Stopped tolerating repositories with no owner | Stopped letting tooling choices fragment the engineering organisation |

The single highest-leverage collaboration habit at senior level is making changes small. A 200-line pull request gets a real review in twenty minutes; a 2,000-line one gets an approval and a hope. Splitting work into reviewable increments behind a feature flag is a skill, and it is the one that most improves a team's defect rate.

The second is review latency. Reviews are a queue, and queue time dominates delivery time far more than review depth does. A senior who reviews within two hours makes the whole team faster than one who writes brilliant reviews on Thursdays.

- **Junior**: learns to write a commit message that explains why, not "fix".
- **Mid**: splits a large change into three reviewable pull requests and rebases cleanly on conflicts.
- **Senior**: introduces trunk-based development with feature flags, cutting the average branch age from nine days to one.
- **Staff**: sets the code-ownership map and review requirements so that shared libraries always get a knowledgeable reviewer.
- **Principal**: decides the company consolidates twelve repositories into a monorepo with shared tooling, and sponsors the migration.
