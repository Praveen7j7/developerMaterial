### 74.6.2 Multi-tenant SaaS (Part 95)

**Q: What are the multi-tenancy models and their tradeoffs? (Part 95)** Silo (a database/infrastructure per tenant — strong isolation, higher cost and ops), pool (shared infrastructure with a tenant_id — efficient, requires careful isolation), and bridge (a middle ground, e.g. shared database, schema per tenant). The choice trades isolation and per-tenant customization against cost and operational simplicity. *Follow-ups:* How would you move one large tenant from pool to silo? What breaks with 10,000 schemas?

**Q: How do you enforce tenant isolation in PostgreSQL? (Part 95)** A tenant_id on every tenant-scoped table and in every query, ideally enforced by row-level security policies so a missing filter cannot leak data, plus connection/pool strategy per the model. The goal is that isolation is structural (enforced by the database), not dependent on every query remembering the filter. *Follow-ups:* How do you test isolation in CI? What about admin tools that need to see every tenant?

**Q: How do you make row-level security fail closed? (Part 95)** A policy such as `USING (tenant_id = current_setting('app.tenant_id')::uuid)`, with the setting applied per transaction (`SET LOCAL` or `set_config(..., true)`) so it cannot leak to the next request on a pooled connection. Without the setting, `current_setting` raises an error, so a forgotten context fails the query instead of returning every tenant. The application role must not own the table or have `BYPASSRLS`; owners skip RLS unless the table has `FORCE ROW LEVEL SECURITY`. *Follow-ups:* Why not `SET` without `LOCAL`? How does PgBouncer in transaction mode change this?

**Q: How do you handle tenant context in NestJS? (Part 95)** Extract the tenant from the authenticated request, carry it via a request-scoped provider or AsyncLocalStorage so it is available throughout the request without threading it manually, and enforce it in guards and the data layer so every query is tenant-scoped. *Follow-ups:* Why is AsyncLocalStorage usually preferred over request-scoped providers? Where is the tenant id taken from — token or header?

**Q: How does tenant context reach background jobs? (Part 95)** It does not, automatically: AsyncLocalStorage ends at the queue. Put the tenant id in the job payload, re-establish the context in the worker before any database access, and fail closed if it is missing. A job without a tenant is a bug, not a job for "all tenants". *Follow-ups:* How do you run a genuinely cross-tenant job safely? How do you audit it?

**Q: How do you handle noisy neighbours? (Part 95)** Per-tenant rate limits and quotas, fair queuing so one tenant cannot starve others, and tenant-level isolation or sharding for the largest tenants, so one tenant's heavy usage does not degrade others' experience. *Follow-ups:* How would fair queuing work in BullMQ or SQS? When do you move a tenant to its own database?

**Q: What does GDPR right-to-erasure require architecturally? (Part 95, Part 42)** That a deletion request removes the user's data from every store — the production database, the warehouse, the lake, derived tables, and per backup policy — not just the primary, propagated reliably (outbox/CDC). Deleting only from production is non-compliant because copies persist. *Follow-ups:* How do you handle backups you cannot edit? How do you prove the deletion happened?

**Q: What enterprise B2B features commonly drive architecture? (Part 95)** SSO (SAML/OIDC), SCIM user provisioning, customer-readable audit logs, IP allowlists, data residency, and compliance controls (SOC 2, PCI scope reduction, HIPAA concepts). Each imposes design requirements — audit logging, regional tenancy, access controls — that must be built in, not bolted on. *Follow-ups:* Why is data residency hard to retrofit? What goes in a customer-readable audit log?

**Q: How should plan-based feature entitlements be designed? (Part 95)** In one place: an entitlement service maps plans (and per-tenant overrides) to features and limits, and code asks `can(tenant, 'sso')` or `limit(tenant, 'seats')`, never `plan === 'enterprise'`. A plan change then becomes a data change instead of a code search. *Follow-ups:* How do you cache entitlements? What happens to data when a tenant downgrades?

### 74.6.3 How to use these answers

#### How a Senior Backend Engineer thinks about this

A senior uses these questions to self-test and to rehearse the concise, confident answer an interviewer wants — the short version that demonstrates understanding, with the depth ready if probed. For leadership and strategy questions (which dominate staff/principal loops), they anchor each answer in a concrete past example rather than reciting the concept, because the interviewer is assessing demonstrated judgment, not definitions. They prepare to go deeper on any of these (the referenced Part is the depth), and they connect the answers to real work they have done, because the strongest interview answers are concept plus lived example plus measurable outcome.

#### Practical exercise

Pick five questions from this file (mixing leadership, strategy and multi-tenant) and answer each aloud in under a minute, then for each attach a concrete example from your own experience. Acceptance criteria: each answer is concise and correct, and each has a real example you could expand on under probing.

## 74.7 Interview Q&A for the modern technical and system-design Parts

Continuing the Part 64-style Q&A, this section covers the modern technical Parts: LLM backends, RAG, GraphQL and gRPC, NoSQL, data engineering and infrastructure as code in this file, and the system-design Parts 70, 71 in the next. These answers are where interviewers probe for numbers and failure modes, so each one names at least one.

### 74.7.1 LLM backends and RAG (Parts 40, 41)

#### Part 40 — Building Backends with LLMs

**Q: How is an LLM API call different from a database query, operationally? (Part 40)** It is slow (seconds, scaling with output length), metered per token, non-deterministic, and fallible (hallucination, refusal, timeout, outage). So you stream interactive responses, cache aggressively, push non-interactive work to a queue, cap output tokens, validate output, and wrap it in timeouts, retries, a circuit breaker and a fallback like any external dependency. *Follow-ups:* What is your fallback when the provider is down? Why is the SDK timeout not enough?

**Q: How do you get trustworthy structured output from an LLM? (Part 40)** Use the provider's structured-output or tool-calling feature to constrain the shape, then independently parse and validate against your own schema, and validate meaning against reality (a model-supplied id is checked for existence/ownership), with a bounded retry or fallback on failure. Never trust unvalidated LLM output downstream. *Follow-ups:* What do you do on the second validation failure? Is a valid schema an authorization?

**Q: How do you estimate what an LLM feature will cost? (Part 40)** Cost per request is input tokens times the input price plus output tokens times the output price. At 1,500 input and 300 output tokens with prices of $3 and $15 per million, that is $0.0045 + $0.0045 = $0.009, or $9 per 1,000 requests. Little's law gives the concurrency: 50 requests per second at 4 seconds each is 200 calls in flight, which must fit the provider's rate limit. *Follow-ups:* Which lever cuts cost first? How do you stop one user spending the monthly budget?

**Q: Why stream responses, and what breaks streaming? (Part 40)** Time to first token is around half a second while a full answer takes several seconds, so streaming makes the feature feel fast. It breaks when any hop buffers: a proxy, compression middleware or a gateway that waits for the whole body. Also cancel the upstream call when the client disconnects, or you keep paying for tokens nobody reads. *Follow-ups:* SSE or WebSockets? How do you test that streaming survives your ingress?

**Q: How do you defend against prompt injection? (Part 40)** Treat user input, retrieved documents and tool results as untrusted data; never let the model hold authority (code decides what is permitted, the model only explains and ranks); give tools least privilege; validate outputs and escape anything rendered; keep secrets out of prompts. No prompt wording fully prevents injection, so you limit the blast radius instead. *Follow-ups:* Give an indirect injection example. What would an attacker gain from your feature?

**Q: How do you choose which model to call? (Part 40)** Route each task to the cheapest model that passes that task's evaluation set; send work nobody is waiting for to a batch API at roughly half price; structure prompts with a stable prefix first so prompt caching applies. Re-run the evaluation before every model or prompt change. *Follow-ups:* How big is your evaluation set? What happens when a provider deprecates the model?

**Q: What do you record for every LLM call? (Part 40)** Input and output tokens, cost, time to first token and total latency, model, prompt version hash and outcome type (ok, truncated, refused, invalid, unavailable). Per-user and per-tenant spend goes into a ledger table, not metric labels (high cardinality), and spend gets an alert like any other budget. *Follow-ups:* How do you debug one bad answer a week later? Which of these do you alert on?

#### Part 41 — Retrieval, Agents and Evaluation

**Q: What is RAG and why use it over fine-tuning? (Part 41)** Retrieval-Augmented Generation retrieves relevant data into the prompt so the model answers from your current, specific facts instead of its training. It is simpler and more current than fine-tuning: when data changes you update the store, not the model, and it avoids hallucination by grounding answers in retrieved, citable context. *Follow-ups:* When would fine-tuning still help? How do you verify citations?

**Q: How do you keep a RAG index in sync and prevent cross-tenant leakage? (Part 41)** Sync via outbox/CDC so a source change re-chunks, re-embeds and updates the index (a stale index gives confidently wrong answers); prevent leakage by scoping every retrieval to the tenant (a mandatory filter, enforced structurally) and verifying retrieved chunks belong to the requesting tenant — a missing tenant filter is a data breach. *Follow-ups:* How are deletes propagated? What do you log so you can measure a leak's blast radius?

**Q: How do you make an agent's tool use safe? (Part 41)** Treat each tool call as an action: validate arguments, authorize against the acting user (the agent can do nothing the user could not), make write tools idempotent, require human approval for consequential actions, bound the loop, and log everything. The model's request is never authorization, and user input and tool results are untrusted (prompt injection). *Follow-ups:* How do you bound an agent loop? What makes a refund tool idempotent?

**Q: pgvector or a dedicated vector database? (Part 41)** pgvector first for most teams: vectors live next to the relational data, inside transactions and under row-level security, with one store to operate. A dedicated vector database earns its place at very large vector counts with tight latency targets, and it costs a second store plus a sync pipeline that can drift. *Follow-ups:* How much memory does an HNSW index over 10 million 1,536-dimension vectors need? How would you migrate later?

**Q: What is the filtered-HNSW trap? (Part 41)** An HNSW scan returns about `ef_search` candidates and then applies the `WHERE` filter, so with a selective filter (one small tenant) most candidates are discarded and the query silently returns fewer rows than its `LIMIT`. `Rows Removed by Filter` in `EXPLAIN ANALYZE` reveals it. Fixes: pgvector's iterative index scans (`hnsw.iterative_scan`, from 0.8), exact search for small tenants, or partitioning by tenant. *Follow-ups:* How do you measure recall? Why not just raise `ef_search`?

**Q: How do you evaluate a RAG system? (Part 41)** Separately for retrieval (recall@k and MRR against a labelled set) and for answers (groundedness and correctness), using an LLM judge that has been validated against human labels. The CI gate tolerates the measured noise of the judge, and adds zero-tolerance hard gates for things like cross-tenant leaks and invalid citations. *Follow-ups:* How many labelled examples are enough? What do you do when the judge disagrees with humans?

**Q: How do you change embedding models? (Part 41)** Like a schema migration: add a new column or table, backfill new embeddings, build the index concurrently, verify recall, switch reads behind a flag, then remove the old vectors. Vectors from different models are not comparable, so you never mix them in one index. *Follow-ups:* What does the backfill cost at 5 million chunks? How do you roll back?

### 74.7.2 GraphQL and gRPC (Part 19)

**Q: What problem does GraphQL solve and what does it cost? (Part 19)** It lets clients fetch exactly the fields they need, including nested data, in one request (solving over-fetching and multiple round trips for rich clients). It costs the N+1 problem (needs DataLoader batching), harder caching than REST, and an open query surface that needs depth/complexity limits. *Follow-ups:* When would you not use GraphQL? How do you cache GraphQL responses?

**Q: What is the N+1 problem in GraphQL and how do you fix it? (Part 19)** Per-field resolution means a query for N objects each needing related data issues 1 + N queries; fix it with a per-request DataLoader that batches the lookups into one query (turning N+1 into ~2), created per request so its cache does not leak across users. *Follow-ups:* Why per request and not a singleton? How do you detect N+1 in production?

**Q: How do you protect a GraphQL endpoint from expensive queries? (Part 19)** Depth limits, complexity (cost) limits, server-side timeouts, and for first-party apps a safelist of persisted queries so only known operations run. Automatic persisted queries alone are a caching feature, not a security control, because anyone can register a query. *Follow-ups:* How do you assign field costs? What about third-party clients?

**Q: Why paginate GraphQL lists with keyset connections from day one? (Part 19)** Turning a plain list into a connection later is a breaking change for every client, and offset pagination gets slower with depth and skips or repeats rows under concurrent inserts. Keyset cursors over an indexed `(created_at, id)` stay fast at any depth. *Follow-ups:* What goes inside the cursor? How do you verify the query uses the index?

**Q: When do you choose gRPC over REST? (Part 19)** For high-volume, performance-sensitive, internal service-to-service communication, where binary protobuf, a strict typed contract, HTTP/2 multiplexing, streaming and deadline propagation are advantages. Keep it internal — browsers need gRPC-Web or a gateway, and it has no HTTP caching. *Follow-ups:* How do deadlines propagate across three hops? Which gRPC calls are safe to retry?

**Q: How do you evolve a protobuf schema compatibly? (Part 19)** Never change or reuse field numbers, add fields with new numbers, reserve retired numbers and names, avoid incompatible type changes, and deprecate rather than remove — so independently deployed services stay compatible (the Part 28 discipline via field numbers). *Follow-ups:* How does `buf breaking` enforce this in CI? Is renaming a field safe?

**Q: Why does gRPC load balancing need special care? (Part 19)** HTTP/2 multiplexes many calls over one long-lived connection, so a connection-level (L4) load balancer pins each client to one pod and new pods receive nothing after a scale-out. Use client-side round robin over a headless service, a service mesh that balances per request, or a maximum connection age so clients reconnect. *Follow-ups:* How would you notice this in metrics? What does `MAX_CONNECTION_AGE` cost?

### 74.7.3 NoSQL data modelling (Part 29)

**Q: When is PostgreSQL not the right store? (Part 29)** Only for a specific, measured requirement it cannot meet: extreme write scale past one primary, a key-only access pattern at massive volume, a naturally non-relational shape (document, time-series, graph), or multi-region active-active writes. You usually give up transactions, joins and query flexibility for scale or shape fit. *Follow-ups:* Does `jsonb` cover the document case? What was the measured requirement last time you chose NoSQL?

**Q: How do you model data for DynamoDB? (Part 29)** Access-pattern-first: list every query the app needs, then design partition and sort keys and GSIs so each is a direct key lookup, using single-table design to co-locate related items. Use high-cardinality partition keys to avoid hot partitions; there are no joins or ad-hoc queries. *Follow-ups:* What happens when a new access pattern appears? What is a sparse GSI for?

**Q: What is a hot partition in DynamoDB, and how do you fix it? (Part 29)** Each partition serves roughly 1,000 write units and 3,000 read units per second, so a low-cardinality or global key (today's date, a global counter) throttles no matter how much table capacity you buy. Fix it with high-cardinality keys, write sharding with a suffix spread across N keys, or by aggregating somewhere else. *Follow-ups:* How do you read a sharded counter? How do you spot a hot key?

**Q: Explain Cassandra's write path. (Part 29)** Writes go to an in-memory memtable and an append-only commit log (fast ack), flush to immutable SSTables, and background compaction merges SSTables and removes superseded data — the append-first design gives very high write throughput; consistency is tunable per operation via quorum. *Follow-ups:* What does a read have to merge? Why `LOCAL_QUORUM` in multi-region?

**Q: What are tombstones in Cassandra, and why do they hurt? (Part 29)** A delete writes a marker that must be kept until `gc_grace_seconds` (10 days by default) so replicas cannot resurrect the data. Reads must scan past every tombstone, so delete-heavy or queue-like tables grow slow reads and eventually tombstone-threshold failures. Avoid queue patterns; for time-series, use TTLs with time-window compaction. *Follow-ups:* What happens if a node rejoins after `gc_grace_seconds`? How do you find tombstone-heavy tables?

**Q: What is ESR in MongoDB index design? (Part 29)** Order compound index fields as Equality, then Sort, then Range. Verify with `explain('executionStats')`: keys examined should be close to documents returned and there should be no in-memory sort stage. *Follow-ups:* What breaks if range comes before sort? When does an index not help at all?

**Q: What is polyglot persistence's main cost? (Part 29)** Operating each additional store and keeping derived stores consistent with one source of truth (via outbox/CDC), with eventual consistency the application must tolerate. Keep one source of truth, make others derived, and add a store only for a specific requirement. *Follow-ups:* How do you reconcile a derived store? Who is on call for it?

### 74.7.4 Data engineering and IaC (Parts 42 and 56)

#### Part 42 — Data Engineering for Backend Engineers

**Q: Why must analytics stay off the production database? (Part 42)** OLTP (row-oriented, many small transactions) and OLAP (large scans/aggregations) need opposite optimizations; running analytics queries on the production database saturates its CPU and I/O and degrades or crashes the application. Analytics belongs in a columnar warehouse fed by the pipeline. *Follow-ups:* Is a read replica enough? What does `EXPLAIN (ANALYZE, BUFFERS)` show for such a query?

**Q: What is CDC and why prefer it over polling or dual writes? (Part 42)** Change Data Capture streams database changes by reading the write-ahead log (via Debezium/Kafka), capturing every change in order with minimal load. It beats polling (which burdens the database and can miss changes) and dual writes (which diverge if one write fails) because it derives everything from the single committed log. *Follow-ups:* Which columns do you publish? How do you handle a schema change?

**Q: What happens if nobody reads a replication slot? (Part 42)** PostgreSQL keeps all WAL the slot has not confirmed, so an abandoned slot fills the disk and eventually takes the primary down. Cap it with `max_slot_wal_keep_size` and alert on retained WAL per slot from `pg_replication_slots`. *Follow-ups:* What happens to the consumer when the cap is hit? How do you clean up a dead slot?

**Q: What is reconciliation and why does it matter? (Part 42)** Periodically comparing a derived figure (warehouse revenue) against the source of truth (production revenue) and alerting on mismatch; it is the essential backstop that catches silent pipeline failures (dropped events, double-counting) that otherwise produce confidently wrong dashboards. *Follow-ups:* What tolerance do you allow? What does a completeness gate check?

**Q: What is a watermark in stream processing? (Part 42)** The processor's estimate of how far event time has progressed; when it passes the end of a window plus the allowed lateness, the window closes and emits. One idle partition can hold the watermark back and stall every window, and events arriving after closure go to a side output for reconciliation. *Follow-ups:* Event time or processing time for billing? How do you handle idle partitions?

**Q: How do you make a batch load idempotent? (Part 42)** Each run owns one data interval and replaces it (delete and insert in one transaction, or a partition overwrite), recomputing a trailing window to absorb late facts. Re-running the same interval gives the same result, so retries and backfills are safe. *Follow-ups:* How long a trailing window? What breaks with append-only loads?

#### Part 56 — Infrastructure as Code

**Q: Why is infrastructure as code better than clickops? (Part 56)** It brings version control, review, repeatability, consistency across environments and auditability to infrastructure; clickops leaves infrastructure undocumented, unrepeatable, drifting and unreviewable — conditions under which dangerous misconfigurations hide until an incident. *Follow-ups:* How do you detect drift? How do you bring existing clickops resources under Terraform?

**Q: What guardrails prevent a terraform apply from deleting a production database? (Part 56)** Plan-on-pull-request with review, `prevent_destroy` on stateful resources, policy-as-code blocking production data-store destruction, pipeline-only apply against fixed environments (no laptop apply), and backups as the last line of defense — layered so a casual destructive apply is impossible. *Follow-ups:* Why is `deletion_protection` stronger than `prevent_destroy`? When did you last test a restore?

**Q: What does `-/+` mean in a plan, and why does it matter? (Part 56)** Destroy and then create: the resource will be replaced. For a database, that is data loss unless a snapshot is restored. It is caused by arguments that force replacement, or by an address change. Read the summary line ("1 to add, 0 to change, 1 to destroy") against what you expected before approving. *Follow-ups:* Which RDS arguments force replacement? How do you change one safely?

**Q: What is Terraform state, and how do you protect it? (Part 56)** The mapping from resource addresses to real resource ids. Keep it in a remote backend with versioning, encryption, locking (the S3 backend's `use_lockfile`) and tight access control, because it is critical and may contain sensitive values. Treat a lock error as a question ("who else is applying?"), not an obstacle. *Follow-ups:* What happens if two applies run at once? How do you recover a corrupted state?

**Q: How do you rename a resource without destroying it? (Part 56)** Add a `moved` block from the old address to the new one. Use `for_each` with stable keys instead of `count`, so removing one element does not shift every index; use `import` blocks to adopt existing resources and `removed` blocks to stop managing one without destroying it. *Follow-ups:* Why is `count` dangerous for a list of buckets? How do modules ship `moved` blocks?

**Q: How should a CI pipeline authenticate to AWS for Terraform? (Part 56)** Through OIDC federation from the CI system to an IAM role scoped to a protected environment, so there are no long-lived keys to leak. Plan on the pull request, run policy checks, require approval, then apply exactly the saved plan, serialized per root module. *Follow-ups:* How do you scope the role's trust policy? Why apply the saved plan rather than re-planning?
