# Outline — Parts 15, 25, 36–38, 51, 63–66 and 78–85 (Batch 1: Principal & Architect volume, Modern add-on, Interview additions)

> Part numbers in this file were updated on 2026-11-05 to the reading-order numbering (Volume 0 = Parts 1–6, the book runs 1–85). The file name keeps the original batch number.

This file is the assignment for every writer agent in batch 1. Read `_spec/STYLE.md` first, then this file, then only your own Part below.

## Overrides to STYLE.md for this batch

- **Write path:** ignore the `f:\learning\...` path in STYLE.md. Write chapter files to
  `/Users/maclapctp409/Downloads/files/hpStuff/learning/senior-backend-handbook/chapters/`.
- **Markdown only.** No slides, no deck JSON, no PDFs. Do not touch `slides/`, `dist/` or `build/`.
- **Only write files for your own Part number.** Never edit or rename existing files (Parts 7–14, 16–24, 26–35, 39–50 and 52–62 are finished).
- **Do not repeat existing Parts.** Each Part below lists what already exists elsewhere. Reference it ("see Part 61 — Architecture Decisions") and go deeper or wider, never re-teach it.
- File naming, heading levels, Mermaid rules, closing sections (Senior Checklist + Key Takeaways) and the 2,500–4,500 words-per-file split are unchanged from STYLE.md.
- Target per Part: **20,000–35,000 words**, which is the size of the existing Parts, not the older 7–12k figure in STYLE.md. That is typically 5–8 files.

## Adapted teaching template for Parts 78–84 (non-code leadership Parts)

Parts 78–84 are about how principal engineers and architects work, so most code blocks do not apply. Use this template instead of the one in STYLE.md §3, with the same `####` headings in this order:

```markdown
#### Concept
#### Why does it exist?
#### Mental model
#### How it works
#### Practical example
#### Artifact example
#### Real-world scenario
#### Failure scenario
#### Edge cases & failure modes
#### How a Principal Engineer thinks about this
#### Common mistakes
#### Interview questions
#### Practical exercise
```

- **Artifact example** replaces the NestJS/PostgreSQL/ORM blocks. It shows a real, filled-in artifact: an RFC section, a one-page strategy, a decision matrix, a migration tracker, an exec update email, an interview rubric. Use a `text` or `markdown`-style block or a table. Never a template full of blanks; fill it in for a realistic case.
- Keep examples in the same domain vocabulary as the rest of the book (orders, payments, inventory, notifications, e-commerce, food delivery, ride booking).
- Code is still welcome where it genuinely helps (for example an architecture fitness function as a Jest test in Part 80).
- Numbers still matter: team sizes, migration durations, costs, incident counts, hiring funnels.

Parts 15, 25, 36–38, 51, 63, 64 and 85 are technical and use the normal STYLE.md template.

---

# Volume 8 — Principal & Architect (Parts 78–85)

Part 56 already defines *what* staff and principal engineers are expected to do (56.4 senior to staff, 56.5 staff vs principal). Part 55 covers the senior mindset, Part 61 covers decision guides and ADRs. Volume 8 teaches *how* to do the principal and architect job.

## Part 78 — Writing as an Architect: RFCs, Design Docs and Decision Records

Exists already: ADR basics (Part 109.6), "write the document" advice (Part 104.4).

- Why writing is the architect's primary tool (one-to-many, persistent, forces clarity)
- Types of documents and when to use each: one-pager, RFC, design doc, ADR, tech spec, post-incident review, strategy memo
- Anatomy of a strong design doc: context, goals and non-goals, requirements with numbers, proposed design, alternatives considered, tradeoffs, risks, rollout and rollback, observability, cost, open questions
- Writing alternatives honestly (the strawman problem); writing non-goals
- The RFC process: drafting, pre-wiring key reviewers, async review, comment resolution, decision meeting, approval and status lifecycle
- Running a design review well as author and as reviewer; review checklists for reliability, security, data, cost
- Diagrams in docs: C4 model (context, container, component), sequence diagrams, data-flow diagrams
- Keeping docs alive: linking docs to code and tickets, superseding decisions, doc rot
- Worked example: a full RFC for moving order notifications from synchronous calls to an event-driven pipeline (Kafka + outbox), including alternatives and rollout
- Worked example: an ADR chain over two years for choosing and then replacing a search engine
- Common doc anti-patterns: solution looking for a problem, 40-page docs nobody reads, decision already made

## Part 79 — Technical Strategy, Vision and Roadmaps

Exists already: build vs buy decision table (Part 109.5), tech debt mentions (Part 60).

- Strategy vs vision vs roadmap vs plan; what "technical strategy" means for a company
- Writing a strategy: diagnosis, guiding policy, coherent actions; examples of good and bad strategy
- Technical vision documents (2–3 year horizon) and how they connect to business goals
- Building a multi-quarter technical roadmap; sequencing, dependencies, capacity
- Managing technical debt as a portfolio: classifying, quantifying (incident cost, lead time, toil hours), and funding it (20% rule, debt sprints, attaching debt to features)
- Evaluating and adopting new technology: evaluation criteria, proof of concept design, total cost of ownership, exit cost, adoption stages (assess, trial, adopt, hold)
- Build vs buy vs open source vs partner, at company scale (vendor risk, lock-in, contract terms)
- Tech radar: running one, what goes on it, keeping it honest
- Saying no to technology: when the boring choice wins
- Worked example: a strategy for an e-commerce company moving from one monolith with 12 engineers to 80 engineers in 2 years
- Worked example: evaluating whether to adopt Kafka vs staying on RabbitMQ + Postgres outbox

## Part 80 — Architecture Governance, Standards and Paved Roads

Exists already: anti-patterns (Part 60), CI/CD pipelines (Part 46), API design (Part 14).

- Why governance exists and why heavy governance fails
- Paved roads / golden paths: service templates, default libraries, opinionated starters
- Standards that scale: API standards, event schema standards, logging and metrics conventions, error format, naming
- Architecture review boards: when they help, when they become a bottleneck, lightweight alternatives (office hours, review guilds)
- Architecture fitness functions: automated checks for layering, dependency rules, latency budgets, bundle sizes (show code, for example dependency-cruiser config or a Jest test)
- Dependency and version policy: upgrade cadence, support windows, end-of-life handling, Node and framework upgrades across 40 services
- Inner source and shared libraries: ownership, versioning, the shared-library trap
- Exceptions and waivers process
- Measuring compliance without policing
- Worked example: introducing a standard error format and OpenAPI-first contracts across 25 NestJS services

## Part 81 — Large-Scale Migrations and Legacy Modernization

Exists already: strangler pattern (Part 107.6), schema migrations (Part 23), compatibility (Part 24), monolith vs microservices (Part 11).

- Why large migrations fail (the 80% done forever problem)
- Migration as a program: scoping, milestones, owners, tracking dashboards, communication cadence
- Choosing the strategy: big bang, incremental, strangler at company scale, parallel run, branch by abstraction
- Monolith decomposition: finding seams, extracting the first service, data ownership split, shared database phase
- Data migrations at scale: dual writes vs CDC-based sync, backfills of billions of rows, reconciliation jobs, verification
- Parallel run and shadow traffic: comparing old vs new outputs, diffing responses
- Deprecating and turning things off: usage telemetry, deprecation notices, brownouts, the last 5 percent of callers
- Migrating platforms: database engine change, cloud migration, framework migration (Express to NestJS, Sequelize to TypeORM)
- Risk management: rollback points, kill switches, blast radius control
- Worked example: moving an order system from a PHP monolith on MySQL to NestJS services on PostgreSQL over 18 months
- Incident story: a migration that silently lost 0.3% of refunds and how reconciliation caught it

## Part 82 — Org Design, Conway's Law and Platform Engineering

Exists already: platform team mentions, DORA metrics (Part 89.8), on-call (Part 97.3).

- Conway's law and the inverse Conway maneuver, with real examples
- Team topologies: stream-aligned, platform, enabling, complicated-subsystem teams; interaction modes
- Cognitive load as a design constraint for team and service boundaries
- Service ownership models: you build it you run it, ownership catalogs, orphaned services
- Platform engineering: internal developer platform, platform as a product, self-service, thinnest viable platform
- Developer experience: measuring it (DORA, SPACE, lead time, build times, survey data) and improving it
- When to split a team, when to merge services, when a reorg is the right architecture change
- Architect's role in an org: embedded vs central architecture, architect as player-coach
- Worked example: redesigning team and service boundaries for a food delivery company at 60 engineers
- Failure story: a microservices split that followed the org chart and created a distributed monolith

## Part 83 — Influence, Communication and the Business Case

Exists already: incident communication (Part 103.6), writing at staff level (Part 104.4).

- Influencing without authority: credibility, trust, pre-wiring, coalitions
- Stakeholder mapping: who decides, who is affected, who can block
- Communicating with executives: bottom line first, one-page updates, translating tech risk into business risk
- Building a business case: cost of delay, ROI, risk reduction value, opportunity cost; worked numbers
- Making tradeoffs visible: options papers with 2–3 options and a recommendation
- Disagreement: how to disagree well, escalation paths, disagree and commit
- Saying no and negotiating scope; protecting the team from thrash
- Presenting architecture to mixed audiences (engineers, product, finance)
- Running effective technical meetings and decision forums
- Worked example: getting funding for a 2-quarter reliability program after three payment outages
- Worked example: an exec update email for a slipping migration

## Part 84 — Growing Engineers: Mentoring, Hiring and Technical Interviewing

Exists already: candidate-side interview prep (Part 57), levels (Part 56).

- Mentoring vs coaching vs sponsorship; running mentoring sessions
- Code review and design review as teaching tools
- Growing seniors into staff: stretch projects, delegation, giving away the interesting work
- Onboarding programs that cut time to first meaningful change
- Designing an interview loop for backend roles: signals per stage, avoiding redundant stages
- Writing interview questions and rubrics (system design, coding, debugging, behavioural), with filled-in rubric examples
- Calibration, bar raising, avoiding bias, writing useful interview feedback
- Running a system design interview as the interviewer: steering, probing depth, scoring
- Building a technical culture: blameless reviews, learning sessions, internal tech talks, writing culture
- Worked example: an interview loop and rubrics for hiring a senior NestJS/PostgreSQL engineer

## Part 85 — Enterprise and Multi-Tenant SaaS Architecture

Uses the normal technical template (NestJS, PostgreSQL, TypeORM examples apply).

Exists already: multitenant write scaling (Part 67.5), data protection and audit (Part 74.11), regions (Part 109.6).

- Multi-tenancy models in depth: silo, pool, bridge; per-tenant database vs schema vs row-level
- Tenant isolation in PostgreSQL: row-level security policies, tenant_id everywhere, connection and pool strategy
- Tenant context in NestJS: request-scoped providers, AsyncLocalStorage, guards that enforce tenancy
- Noisy neighbours: per-tenant rate limits, quotas, fair queuing, tenant-level sharding
- Per-tenant configuration, feature entitlements, plans and billing hooks
- Enterprise B2B features: SSO (SAML, OIDC), SCIM user provisioning, audit logs customers can read, IP allowlists
- Data residency and regional tenancy
- Compliance-driven architecture: GDPR (right to erasure, data export), PCI DSS scope reduction, SOC 2 controls, HIPAA concepts; what each means for system design
- Enterprise integration patterns: webhooks for customers, connectors, batch import/export, idempotent bulk APIs
- Tenant lifecycle: onboarding, migration between tiers, offboarding and data deletion
- Worked example: turning a single-tenant inventory product into a multi-tenant SaaS

---

# Modern add-on (Parts 15, 25, 36–38, 51 and 63, 64)

These Parts slot into existing volumes by topic: 59, 60, 63 into Volume 4 (Distributed Systems); 61 into Volume 2 (Architecture and APIs); 62 into Volume 3 (Data); 64 into Volume 5 (Production Engineering); 65, 66 into Volume 6 (Mastery).

## Part 36 — Building Backends with LLMs: Foundations

Exists already: nothing dedicated.

- What an LLM API call is: tokens, context window, temperature, latency profile, pricing per token
- Calling LLM APIs from NestJS: client setup, timeouts, retries with backoff, streaming responses (SSE to the browser)
- Structured output: JSON schemas, tool/function calling, validating model output with class-validator or zod
- Prompt design for backend engineers: system prompts, templates, versioning prompts like code
- Cost and latency engineering: caching responses, prompt caching, model routing (small vs large model), batching, token budgets
- Rate limits and quotas: per-user limits, queueing LLM jobs (BullMQ), backpressure
- Failure modes: timeouts, malformed output, hallucination, refusal, provider outage, non-determinism
- Security: prompt injection, data leakage, PII handling, output sanitization
- Observability for LLM features: logging prompts and outputs safely, token metrics, cost dashboards
- Worked example: an order-support assistant endpoint that summarizes order history and suggests actions

## Part 37 — Retrieval, Agents and Evaluation

- Embeddings and vector search: what an embedding is, similarity metrics
- pgvector in PostgreSQL: schema, HNSW vs IVFFlat indexes, EXPLAIN output, filtering with metadata
- Dedicated vector databases vs pgvector: decision table
- Retrieval-augmented generation (RAG): chunking, indexing pipeline, retrieval, re-ranking, citations, keeping the index in sync (outbox/CDC)
- Hybrid search: combining PostgreSQL full-text search (Part 33) with vectors
- Agents and tool use: tool loops, giving the model safe tools (read-only vs write tools), idempotency for tool actions, human approval steps
- Evaluation: golden datasets, LLM-as-judge, regression tests in CI, online metrics
- Guardrails: input/output filtering, permission checks on retrieved data (tenant isolation in RAG)
- Worked example: a product-catalog RAG search for an e-commerce site using pgvector
- Incident story: a RAG system leaking another tenant's documents

## Part 15 — GraphQL and gRPC

Exists already: REST API design (Part 14), API style decision (Part 109.1).

- GraphQL: schema, queries, mutations, subscriptions, resolvers; NestJS GraphQL module (code-first and schema-first)
- The N+1 problem in GraphQL and DataLoader batching
- GraphQL performance and security: query depth and complexity limits, persisted queries, caching challenges
- Pagination (Relay connections), errors, versioning without versions
- Federation and supergraphs: when one graph across services makes sense
- gRPC: protobuf, service definitions, unary vs streaming, deadlines, status codes; NestJS microservices gRPC transport
- Schema evolution in protobuf (field numbers, reserved fields) and compatibility (link Part 24)
- gRPC load balancing, HTTP/2, gRPC-Web and gateways
- REST vs GraphQL vs gRPC decision matrix with real scenarios (public API, mobile BFF, internal service mesh)
- Worked example: an order service exposing REST publicly, GraphQL for the mobile app, gRPC internally

## Part 25 — NoSQL Data Modelling

Exists already: SQL vs NoSQL decision (Part 109.1), Redis (Part 26).

- When PostgreSQL is not the right store, honestly
- Document databases (MongoDB): document design, embedding vs referencing, indexes, transactions, aggregation pipeline; Mongoose/NestJS example
- Key-value and wide-column at scale (DynamoDB): partition and sort keys, single-table design, access-pattern-first modelling, GSIs, hot partitions, capacity modes
- Wide-column (Cassandra): partition keys, clustering columns, tunable consistency, write path (memtable, SSTables, compaction)
- Time-series data: TimescaleDB, partitioning by time, retention and downsampling
- Graph databases: when relationships are the query (Neo4j concepts)
- Polyglot persistence: keeping stores consistent (outbox, CDC), operational cost of each extra store
- Migrating from NoSQL to PostgreSQL and the reverse: real reasons and pitfalls
- Decision matrix across PostgreSQL, MongoDB, DynamoDB, Cassandra, Redis, TimescaleDB
- Worked example: modelling a ride-booking trip history in DynamoDB vs PostgreSQL

## Part 38 — Data Engineering for Backend Engineers

Exists already: outbox (Part 71.4), search index sync (Part 94.3), Kafka (Part 27).

- OLTP vs OLAP: why analytics queries hurt the production database
- Change data capture: logical replication, Debezium, Kafka Connect, handling schema changes
- ETL vs ELT; batch pipelines; orchestration concepts (Airflow-style DAGs)
- Data warehouses and lakes: columnar storage, BigQuery/Redshift/Snowflake concepts, Parquet, partitioning
- Stream processing: windows, watermarks, late events, stateful processing; Kafka Streams and Flink concepts
- Data contracts between backend teams and data teams; event schemas as data products
- Data quality: validation, reconciliation, freshness SLAs
- Privacy in data pipelines: PII masking, deletion propagation (GDPR erasure reaching the warehouse)
- Building analytics features in the product: pre-aggregated tables, materialized views, read models
- Worked example: CDC from the orders database into a warehouse for daily revenue dashboards

## Part 51 — Infrastructure as Code

Exists already: cloud services (Part 45), Kubernetes (Part 44), CI/CD (Part 46).

- Why infrastructure as code; clickops failure stories
- Terraform fundamentals: providers, resources, state, plan and apply, modules, variables and outputs
- State management: remote state, locking, state drift, importing existing resources
- Structuring Terraform for many environments and services; module design and versioning
- Alternatives: Pulumi (TypeScript), AWS CDK, CloudFormation; decision table
- IaC in CI/CD: plan on pull request, approvals, apply pipelines, preventing destructive changes
- Policy as code: OPA/Conftest, Sentinel concepts, guardrails for security and cost
- GitOps for Kubernetes: Argo CD / Flux concepts, Helm and Kustomize
- Secrets in IaC: never in state or code, secret managers
- Worked example: Terraform for a NestJS service on AWS (VPC, RDS PostgreSQL, ElastiCache Redis, ECS or EKS, IAM)
- Incident story: a `terraform apply` that deleted a production database and the guardrails that would have stopped it

## Part 63 — More System Designs I

Use the exact walkthrough format of Part 52 (read `chapters/part-52-01-intro-and-url-shortener.md` first and copy its structure: requirements, estimation, API, data model, high-level design, deep dives, failure modes, tradeoffs, checklist).

- Web crawler (politeness, frontier, dedup, distributed fetching)
- Distributed key-value store (partitioning, consistent hashing, replication, quorum, hinted handoff, anti-entropy)
- Unique ID generator (Snowflake-style IDs, clock skew, UUIDv7, database sequences at scale)
- Ticket and seat booking system (seat holds, expiring reservations, contention on hot events, payment coupling)

## Part 64 — More System Designs II

Same format as Part 63.

- Leaderboard and top-K (Redis sorted sets, approximate top-K, count-min sketch, sharded leaderboards)
- Collaborative document editing (operational transform vs CRDTs, presence, offline sync)
- Proximity search / nearby drivers and restaurants (geohash, quadtrees, PostGIS, location update rates)
- Ad-click / metrics aggregation (high-volume ingestion, exactly-once counting, windowed aggregation, reconciliation)

---

# Interview additions (Parts 65, 66)

Both slot into Volume 6 (Mastery). Part 57 already holds candidate-side Q&A for Parts 7–14, 16–24, 26–35, 39–50 and 52–62, behavioural questions and three mock loops; do not repeat it.

## Part 65 — Low-Level Design and Machine Coding

Exists already: SOLID and design patterns (Part 12), LRU cache and rate limiter as algorithms (Parts 7, 8).

- What the low-level design (LLD) / machine-coding round is, how it is scored (working code, extensibility, naming, tests, patterns used with reason)
- A repeatable method: clarify requirements, identify entities, define interfaces, pick patterns, code the core, extend for a twist, test
- Object modelling in TypeScript: classes vs interfaces, composition, enums vs unions, immutability, error types
- Concurrency in LLD answers: what to say about thread safety and why Node changes the answer
- Fully worked problems in TypeScript, each with requirements, class diagram (`classDiagram`), code, tests and the "interviewer twist":
  - Parking lot
  - Splitwise (expense sharing and simplifying debts)
  - Elevator system
  - Movie ticket booking (BookMyShow-style seat locking)
  - In-memory rate limiter library (pluggable strategies)
  - Food delivery order state machine with notifications (state + observer)
  - In-memory key-value store with TTL and transactions
  - Logger / pub-sub library
- Common LLD mistakes: god classes, patterns for show, no extension point, untestable code
- Decision table: which pattern fits which LLD requirement

## Part 66 — The Interview Playbook

- The full hiring process: resume and project write-ups for backend roles, recruiter screen, how loops differ at big tech vs product startups vs services companies vs remote-first companies
- The coding round: the pattern catalogue (two pointers, sliding window, BFS/DFS, heaps, DP, graphs, intervals, monotonic stack, union-find) with recognition cues; method for live solving; communicating complexity; testing your own code; link each pattern back to Parts 7, 8
- The system design round as a 45-minute procedure: time boxes, what to draw when, depth selection, handling pushback; link to Parts 52, 53 and 63, 64
- Other round types: take-home assignments, debugging rounds, code-review rounds, pair programming, API design rounds
- Staff and principal loops: past-project deep dive, architecture round, leadership and influence signals, written exercises; worked examples of strong vs weak answers
- Interview Q&A for the new Parts 15, 25, 36–38, 51, 63, 64 and 78–85: leadership and strategy, multi-tenant SaaS, LLM backends, RAG, GraphQL and gRPC, NoSQL, data engineering, infrastructure as code (about 6–10 questions per Part, answered in Part 57's style)
- Offers: levels and titles across companies, negotiation basics, evaluating an offer

---

## Wave plan (one writer agent per Part, waves of at most 6)

| Wave | Parts |
|---|---|
| 1 | 51, 52, 53, 54, 55, 56 |
| 2 | 57, 58, 59, 60, 61, 62 |
| 3 | 63, 64, 65, 66, 67, 68 |

After each wave: run `node build/check-structure.js` and fix any reported problems before starting the next wave.

## Later batches (not part of this outline)

- Batch 2: Volume 0 — From Scratch.
- Batch 3: Volume 7 — Frontend and Full Stack.
