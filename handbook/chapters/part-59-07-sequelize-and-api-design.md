## 59.7 Sequelize

### Q91. How do you define models, and how do you manage schema changes?

- **Expected answer** — Either `sequelize.define('Order', attributes, options)` or the class form `class Order extends Model` with `Order.init(attributes, { sequelize, tableName, underscored, paranoid })`; with `@nestjs/sequelize` you use `sequelize-typescript` decorators (`@Table`, `@Column`, `@ForeignKey`, `@BelongsTo`). Options that matter: `underscored: true` to map camelCase attributes to snake_case columns, `paranoid: true` for soft deletes via `deletedAt`, `timestamps`, and `freezeTableName`. For schema management, `sequelize.sync()` and especially `sync({ alter: true })` are development-only for the same reasons as TypeORM's `synchronize` — they issue unreviewed DDL, can drop data, and race across replicas. Production uses `sequelize-cli` migrations checked into the repo and run as a discrete deploy step, with a separate seeders directory for reference data. One Sequelize-specific caution: model definitions and migrations are *independent*, so they drift silently; the model says a column is `allowNull: false` while the database never got the constraint. I add a CI check that runs migrations onto an empty database and compares the resulting schema against the models.

- **Why it matters** — Model/migration drift is a Sequelize-specific footgun that produces production-only failures.

- **Follow-ups** — How do you detect drift? What does `paranoid` do to your unique constraints? Where do enum changes bite?

- **Senior signal** — Names the drift problem and automates the check.

### Q92. How do transactions work in Sequelize, and what is CLS?

- **Expected answer** — `sequelize.transaction(async (t) => { ... })` is the managed form: it commits on resolve and rolls back on throw. Every query inside must receive `{ transaction: t }` or it runs on a different connection outside the transaction — the same trap as TypeORM. Sequelize's answer is CLS (continuation-local storage): set `Sequelize.useCLS(namespace)` at startup and the transaction is propagated automatically through the async context, so nested service calls join it without threading `t` through every signature. It is genuinely useful, but you must know its edges: it relies on async context propagation, so code that escapes the context (a callback into a native library, some worker pools, a promise created before the namespace was active) silently drops out of the transaction. Unmanaged transactions (`const t = await sequelize.transaction()` with explicit `t.commit()`/`t.rollback()`) require the same `finally` discipline as a TypeORM query runner. You can pass `isolationLevel` and, on Postgres, `lock: Transaction.LOCK.UPDATE` in a `findOne` to emit `FOR UPDATE`.

- **Why it matters** — Silent non-transactional writes are the highest-severity ORM bug class.

- **Follow-ups** — What happens if you forget `{ transaction: t }` on one query in a batch? How would you test that a rollback really rolls everything back? What are CLS's failure modes?

- **Senior signal** — Uses CLS but can name where it leaks, and writes a test that asserts rollback.

### Q93. Explain `include` and how you avoid N+1 and pagination bugs.

- **Expected answer** — `include` produces a join and Sequelize then hydrates nested instances. Without it, touching `order.getItems()` per row is an N+1. The pagination trap is specific and important: `findAll({ include, limit: 20 })` applies `LIMIT` to the *joined* rows, so an order with 10 items consumes 10 of your 20 slots and you get 4 orders instead of 20. Sequelize handles this when it can by using a subquery (`subQuery: true`, its default for `hasMany` with limit), but the subquery breaks when your `where` references an included model, and then you must set `subQuery: false` and handle duplication yourself. `findAndCountAll` with `include` counts joined rows unless you pass `distinct: true`, which is the classic "my total says 340 but there are 34 orders" bug. Practical approach for list endpoints: query the parent ids with the filter and pagination, then fetch children with a second `where: { orderId: ids }` query and stitch — two predictable queries beat one fragile join.

- **Why it matters** — These are wrong-data bugs that pass unit tests with one child row.

- **Follow-ups** — What does `distinct: true` change in the generated SQL? When is `separate: true` on a `hasMany` include the right tool? How do you order by a column on an included model with a limit?

- **Senior signal** — Knows the `subQuery` and `distinct` behaviours by name and prefers the two-query stitch for reliability.

### Q94. How do you lock rows and handle concurrency in Sequelize?

- **Expected answer** — Inside a transaction, `Model.findOne({ where, lock: t.LOCK.UPDATE, transaction: t })` emits `SELECT ... FOR UPDATE`; `LOCK.SHARE` gives `FOR SHARE`, and `skipLocked: true` adds `SKIP LOCKED` for queue-style claiming. For counters, prefer atomic operators over read-modify-write: `Model.increment({ qty: -1 }, { where: { sku, qty: { [Op.gte]: 1 } }, transaction: t })` compiles to a single `UPDATE` with a guard, and you check the affected row count to know whether the decrement succeeded. Optimistic locking is available via `version: true` in the model options, which adds a version column and throws `OptimisticLockError` on a stale write. The failure modes are the same as everywhere: `FOR UPDATE` queues and can deadlock, so order your locks consistently and set `lock_timeout`; `increment` without the `Op.gte` guard will happily take stock negative; and a lock without a transaction is silently ignored, which is a quiet correctness hole.

- **Why it matters** — Inventory and balance bugs come straight from getting this wrong.

- **Follow-ups** — Show me a safe stock decrement including what the API returns when it fails. Why check affected rows? What does `skipLocked` enable you to build?

- **Senior signal** — Uses a guarded single-statement update rather than read-then-write, and checks the affected row count as the decision signal.

### Q95. What are hooks and scopes, and where do they hurt?

- **Expected answer** — Hooks are lifecycle callbacks (`beforeCreate`, `afterUpdate`, `beforeBulkDestroy`, ...) and scopes are named, reusable query fragments applied with `Model.scope('active').findAll()` or a `defaultScope`. They are useful for genuinely mechanical concerns: hashing a password before create, normalising an email, adding `tenantId` scoping. They hurt in three ways. First, bulk operations do not run individual hooks unless you pass `individualHooks: true`, so `Model.update(..., { where })` skips `beforeUpdate` per row — audit logs and cache invalidations silently stop working for bulk paths. Second, hooks that do I/O (send an email, publish to Kafka) inside a transaction fire even if the transaction later rolls back, producing notifications for orders that do not exist; side effects belong after commit, ideally via an outbox. Third, a `defaultScope` is invisible at the call site, so a developer wonders why rows are missing, and `Model.unscoped()` is easy to forget in one place and leak soft-deleted or other-tenant data. I keep hooks for pure data transformation only and put business side effects in explicit service code.

- **Why it matters** — Invisible behaviour is the enemy of a maintainable large codebase.

- **Follow-ups** — Where would you publish an `order.created` event and why not in `afterCreate`? How does `paranoid` interact with `defaultScope`? What breaks with `individualHooks` at 10,000 rows?

- **Senior signal** — The "no I/O in hooks, use an outbox after commit" rule, stated as a hard boundary.

### Q96. When do you drop to raw SQL in Sequelize, and how do you do it safely?

- **Expected answer** — When the query is analytical, uses window functions, CTEs, `ON CONFLICT`, `SKIP LOCKED`, or any Postgres feature the query interface does not model well; when the generated SQL is unpredictable and the query is hot; and for bulk operations where per-row instances would be wasteful. Use `sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction })` and always use `replacements` (`:name`) or `bind` (`$1`) rather than string interpolation — `bind` is stronger because values go to the server as parameters and cannot be reinterpreted as SQL, while `replacements` are escaped client-side. Return typed rows and map them explicitly rather than pretending they are model instances. Two operational notes: raw queries bypass hooks, scopes and soft-delete filters, so a raw query in a multi-tenant system must include the tenant predicate explicitly, and it is worth centralising these in a repository class so they are reviewable and testable. I also keep raw SQL in files or tagged template constants rather than inline strings, so it is greppable when a column is renamed.

- **Why it matters** — Injection and tenancy leaks both hide in raw SQL.

- **Follow-ups** — Difference between `replacements` and `bind`? How do you keep raw SQL in sync with model changes? How do you test it?

- **Senior signal** — Prefers `bind`, remembers that scopes and soft deletes do not apply, and treats tenancy as a security invariant.

## 59.8 API design

### Q97. Should your API resources mirror your database tables?

- **Expected answer** — No. Tables are a storage model optimised for normalisation and write integrity; an API is a contract optimised for the consumer's use cases and for evolving independently of storage. If they are identical, every schema refactor becomes a breaking API change, and clients end up doing five round trips to assemble one screen. Design resources around domain concepts and client workflows: `POST /orders/{id}/refunds` rather than `POST /refund_rows`, `GET /orders/{id}` returning the order with its items and totals even though those live in three tables. Conversely, do not go so far that you build an RPC-over-HTTP mess of verbs; the resource shape is a good default because it gives you caching, idempotency semantics and predictable URLs for free. The test I apply: could I change the storage engine for this entity — split a table, add a cache, move it to another service — without changing the API? If not, the API is leaking storage details.

- **Why it matters** — API-storage coupling is a decade-long tax that shows up as "we cannot refactor that table".

- **Follow-ups** — How do you model a state transition like cancelling an order? What about a query that needs data from three services? Where do you draw the line before it becomes RPC?

- **Senior signal** — The "could I change the storage without changing the contract?" test, plus not over-rotating into pure REST purism.

### Q98. How do idempotency keys work and where do you store them?

- **Expected answer** — The client generates a unique key per logical operation (a UUID) and sends it as `Idempotency-Key`. The server, inside a transaction, tries to insert `(key, endpoint, request_hash)` into an idempotency table with a unique constraint. If the insert succeeds, this is the first attempt: perform the work and store the response body and status against the key. If it conflicts, look up the stored record — if it is complete, replay the saved response; if it is still in progress, return 409 or 425 so the client retries later. Comparing the request hash catches a client reusing a key with a different payload, which should be a 422 rather than silently replaying. Keys are scoped per API consumer and expire (24 hours to 7 days depending on how long clients retry), cleaned by a retention job.

  ```sql
  CREATE TABLE idempotency_keys (
    key text PRIMARY KEY, consumer_id uuid NOT NULL, endpoint text NOT NULL,
    request_hash text NOT NULL, status text NOT NULL,
    response_status int, response_body jsonb, created_at timestamptz DEFAULT now());
  ```

  The crucial part is that the key record and the business write commit in the *same* transaction, or a crash between them re-executes the charge.

- **Why it matters** — This is the standard defence against double charges, and the details are where people fail.

- **Follow-ups** — What happens on a concurrent duplicate that is still in flight? Why must it be one transaction? How does this interact with a downstream payment provider's own idempotency?

- **Senior signal** — Same-transaction commit, in-progress handling, request-hash mismatch, and expiry — the four details that make it actually work.

### Q99. `PUT` versus `PATCH` — how do you decide?

- **Expected answer** — `PUT` replaces the resource with the representation you send, and is idempotent: sending it twice leaves the same state. That means omitted fields should be cleared, which most APIs get wrong by treating `PUT` as a partial update and thereby breaking the contract. `PATCH` applies a partial modification; it is not required to be idempotent, though it usually is if the operations are absolute assignments (`{"status":"shipped"}`) rather than relative ones (`{"increment_by":1}`). For partial updates I use `PATCH` with a JSON merge-patch style body, and I define explicitly what `null` means (clear the field) versus an absent key (leave unchanged), because that ambiguity is the number one source of bugs. In practice, for state transitions I prefer a dedicated sub-resource or action (`POST /orders/{id}/cancel`) over patching a status field, because the transition has rules and side effects that a generic patch cannot express, and it gives you a clean place to apply idempotency and authorization.

- **Why it matters** — Semantics affect retry safety, caching and client expectations.

- **Follow-ups** — How do you express "clear this optional field" in JSON? Is `PATCH` safe to retry after a timeout? Why not just `PUT` everything?

- **Senior signal** — The null-versus-absent rule and preferring explicit action endpoints for state machines.

### Q100. Which status codes do you use, and where do people get them wrong?

- **Expected answer** — The set I actually use: 200 for a successful read or update with a body; 201 with a `Location` header for creation; 202 when the work is accepted and asynchronous; 204 for a successful delete or update with no body; 400 for malformed syntax; 401 for missing or invalid authentication; 403 for authenticated but not permitted; 404 for not found — and deliberately for "exists but you may not know it exists", to avoid leaking resource existence; 409 for a state conflict such as an optimistic-lock mismatch or duplicate creation; 422 for semantically invalid input that parsed fine; 429 for rate limiting with `Retry-After`; 500 for our bug; 503 for overload or a dependency being down, with `Retry-After`; 504 for an upstream timeout. Common mistakes: returning 200 with `{"error": ...}` in the body, which defeats every client library, proxy and metric; using 500 for validation failures, which pollutes your error budget and pages someone; and using 403 where 404 avoids an enumeration oracle. The other thing seniors care about is the *retryability contract*: 429, 502, 503 and 504 mean "retry with backoff", 4xx otherwise means "do not retry", and clients should be able to rely on that.

- **Why it matters** — Status codes are the machine-readable half of your contract, and they drive retries and alerting.

- **Follow-ups** — What do you return when the request is valid but inventory is insufficient? Which codes count against your availability SLO? What does a client do with a 409?

- **Senior signal** — Frames codes as a retryability and alerting contract, not trivia.

### Q101. How do you version an API?

- **Expected answer** — Three mainstream options: URL path (`/v1/orders`) — obvious, cache-friendly, easy to route at the gateway, but it duplicates URLs and encourages whole-API version bumps; a custom header or `Accept` media type (`application/vnd.acme.v2+json`) — cleaner URLs and per-resource evolution, but harder to test with a browser and easy for proxies to ignore; and date-based versions pinned per consumer (the Stripe model), where the client's registered version selects a chain of request/response transformations. My default for a typical product API is URL versioning at the major level plus *additive* evolution within a version, because most changes should not need a version at all. The real work is not the scheme, it is the policy: what counts as breaking (removing a field, tightening validation, changing a status code, changing default ordering), how long you support version N-1 (announce, measure usage per consumer, then deprecate with `Sunset` and `Deprecation` headers), and how you know who is still calling it — which requires per-consumer, per-version request metrics.

- **Why it matters** — Versioning is a lifecycle and organisational problem more than a technical one.

- **Follow-ups** — Is adding a required request field breaking? How do you retire v1 when one large customer will not migrate? What is the Stripe approach's hidden cost?

- **Senior signal** — Focuses on the deprecation process and measurement, and lists what counts as breaking, including sneaky cases like changing default sort order.

### Q102. How should list endpoints paginate?

- **Expected answer** — Default to cursor (keyset) pagination for anything that grows: return an opaque `next_cursor` and a `has_more` flag, cap `limit` at something like 100 with a default of 20, and encode the cursor as a signed, base64-encoded tuple of the sort key plus id so clients cannot tamper with it or read into it. Offset pagination is acceptable only for small, bounded collections or admin tools where jumping to page 40 matters — and even then, put a hard cap on the offset. Do not return a total count by default: it forces a second expensive query on every page. Offer it behind an explicit `include_total=true` flag, or return an approximate count. Also fix the sort: pagination without a deterministic total order (a tiebreaker on the primary key) silently duplicates and skips rows, which is a bug people ship constantly. Document that cursors are opaque and may expire, and version their contents so you can change the sort later.

- **Why it matters** — This is the endpoint that breaks first as data grows and the one clients complain about most.

- **Follow-ups** — Why must the cursor be signed? How do you support sorting by five different columns? What happens if a row is deleted between pages?

- **Senior signal** — Deterministic tiebreaker, opaque signed cursors, and treating total count as opt-in.

### Q103. What does a good error response look like?

- **Expected answer** — One consistent envelope across the whole API, machine-readable first and human-readable second. I use a shape close to RFC 9457 (`application/problem+json`): a stable `type` or `code` string that clients can switch on and that never changes, a `title`/`message` for humans, the HTTP `status`, a `trace_id` that appears in our logs, and a structured `errors` array for field-level validation problems with `field`, `code` and `message`.

  ```json
  { "type": "https://api.acme.com/errors/insufficient_inventory",
    "title": "Not enough stock for SKU-1183", "status": 409,
    "trace_id": "4f3c...", "errors": [{ "field": "items[0].qty", "code": "max", "message": "only 2 left" }] }
  ```

  The rules that matter: codes are part of the contract and are versioned like anything else; never put stack traces, SQL, internal hostnames or upstream provider messages in the body; localise on the client using the code, not by translating `message` server-side; and make sure the same failure always produces the same code, because clients build retry and UX logic on it.

- **Why it matters** — Error contracts determine whether client teams can build good UX or have to string-match your messages.

- **Follow-ups** — How do you avoid clients parsing `message`? What do you log versus return? How do you handle a partial failure in a bulk request?

- **Senior signal** — Stable machine codes as a versioned contract plus a trace id bridging client reports to logs.

### Q104. Where does validation belong, and what should it cover?

- **Expected answer** — In layers, because they catch different things. At the edge: schema validation of shape, types, required fields, string lengths, enum membership and numeric bounds — in NestJS, DTOs with `class-validator` and a global `ValidationPipe` with `whitelist: true`. In the domain: business rules that need context, such as "this coupon is valid for this customer" or "you cannot cancel a shipped order" — these belong in the service, not in a DTO decorator, because they need database state. In the database: the invariants that must hold no matter what code runs — `NOT NULL`, `CHECK (amount_minor > 0)`, unique indexes, foreign keys. The database layer is the one people skip, and it is the only one that survives a bad migration script, a rogue admin query or a second service writing to the same table. Also validate *outputs* at boundaries you do not control: a third-party webhook payload gets parsed into a validated type, never trusted. And validate sizes explicitly — max array lengths, max body size — because "500,000 items in one request" is a denial-of-service vector that type validation alone does not stop.

- **Why it matters** — Validation strategy is a security question and an architecture question at once.

- **Follow-ups** — Give me a rule that must live in the database and say why. How do you keep the DTO and the database constraint in sync? What is the max body size on your API and where is it enforced?

- **Senior signal** — Insists on database-level invariants and mentions size limits as a DoS control.

### Q105. How would you design rate limiting for a public API?

- **Expected answer** — Decide the dimension first: per API key, per user, per IP, or per tenant — usually a combination, with the key as primary and IP as a fallback for unauthenticated endpoints. Then the algorithm: fixed window is cheap but allows a 2x burst across the boundary; sliding window log is exact but memory-heavy; sliding window counter is a good approximation; token bucket is my default because it expresses "sustained rate plus burst" naturally, which is what product people actually want. Implement centrally in Redis so all pods share state — a Lua script doing the read-modify-write atomically, keyed by `rl:{key}:{window}` with a TTL. Return `429` with `Retry-After` and the `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset` headers so clients can behave well. Differentiate limits by cost: a search endpoint that hits Elasticsearch should cost 10 tokens, a simple `GET` one. Failure mode to state explicitly: if Redis is down, do you fail open (allow traffic, risk overload) or fail closed (reject everything)? For a public API I fail open with a local in-process fallback limiter, because rejecting all traffic because a cache is down converts a degradation into an outage — but for an expensive or abusable endpoint I fail closed.

- **Why it matters** — Rate limiting is one of the few places where the "what if the limiter itself fails" question is unavoidable.

- **Follow-ups** — Write the token-bucket Lua sketch. How do you handle a customer who legitimately needs a higher limit? Where do you put the limiter, gateway or app?

- **Senior signal** — The fail-open versus fail-closed decision with different answers per endpoint class, and cost-weighted limits.

### Q106. How do you design bulk endpoints?

- **Expected answer** — First ask whether you need one; often the client is doing an N+1 because the read API is missing a filter. If you do need it, the key decision is failure semantics, and it must be explicit in the contract: all-or-nothing (one transaction, any failure rolls everything back, simple to reason about, but one bad row blocks 999 good ones) or per-item results (207-style response with a per-item status array, more useful for imports, but the client must handle partial success and you must make each item independently idempotent). I usually offer per-item results for imports and all-or-nothing for anything financial. Other essentials: a hard cap on batch size (say 1,000 items) enforced with a 413 or 422, an idempotency key covering the whole batch, per-item client-supplied reference ids echoed back so the client can correlate results, and a size-based body limit. For genuinely large volumes, do not make it synchronous at all — accept the payload, return `202` with a job id, and expose a status endpoint, which is the long-running-operation pattern.

- **Why it matters** — Bulk endpoints are where timeouts, partial failure and idempotency all collide.

- **Follow-ups** — What does the response look like for 3 failures out of 500? How do you make a retry of a partially-failed batch safe? What is your batch size cap and why?

- **Senior signal** — Makes partial-failure semantics an explicit contract decision and links large batches to async processing.

