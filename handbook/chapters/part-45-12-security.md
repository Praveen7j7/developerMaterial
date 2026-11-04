## 45.13 Security

### Q167. Authentication versus authorization — where does each live in your architecture?

- **Expected answer** — Authentication answers "who is this?" and authorization answers "may they do this?". They belong in different places. Authentication happens once at the edge: a gateway or a `JwtAuthGuard` validates the credential (session cookie, bearer token, mTLS certificate) and attaches a principal to the request. Authorization is layered: coarse checks at the route (`@Roles('admin')` in a guard) and fine-grained, data-dependent checks in the service, because "can this user cancel *this* order" needs the order row. The mistake I look for is authorization done only at the route level, which leaves every service method callable with any id — the moment a second entry point exists (a queue consumer, an internal API, a GraphQL resolver), the check is bypassed. So the invariant is: the service method that loads an object also verifies ownership, and ideally the query itself is scoped (`WHERE id = $1 AND tenant_id = $2`) so a missing check returns nothing rather than someone else's data. Authentication failures are 401, authorization failures are 403 — or 404 when revealing existence is itself a leak.

- **Why it matters** — The most common serious API vulnerability is broken object-level authorization, and this is where it starts.

- **Follow-ups** — Where exactly do you check that this order belongs to this user? How do you stop a new endpoint from forgetting? What does a queue consumer use as its principal?

- **Senior signal** — Pushes the tenant/owner predicate into the query so that forgetting the check fails closed.

### Q168. Sessions or JWTs?

- **Expected answer** — Server-side sessions store state (a random session id in a cookie, the data in Redis or Postgres). Revocation is instant, the cookie is small, and you can change permissions immediately; the cost is a lookup per request (a sub-millisecond Redis hit) and shared session storage. JWTs are self-contained and signed, so they verify without a lookup, which suits stateless horizontal scaling and cross-service propagation; the cost is that they cannot be revoked before expiry without reintroducing state, and they are frequently implemented badly. My default for a first-party web application is sessions with a `HttpOnly; Secure; SameSite=Lax` cookie, because the operational simplicity and instant revocation are worth more than saving a Redis call. I use JWTs for service-to-service calls and for OAuth access tokens with short lifetimes (5–15 minutes) plus refresh tokens. The hybrid that works well: a short-lived JWT for fast verification plus a revocation list of `jti` values in Redis checked only for high-value operations, so you get speed with a bounded revocation window.

- **Why it matters** — This is one of the most commonly cargo-culted decisions in backend work.

- **Follow-ups** — How do you log a user out of all devices with JWTs? What is the revocation window you can live with? What breaks about sessions at 40 pods?

- **Senior signal** — Chooses sessions for first-party apps and can articulate why "stateless" is not automatically better.

### Q169. What are the common JWT mistakes, and how do refresh tokens work?

- **Expected answer** — The mistakes: accepting the `alg` header from the token (leading to `alg: none` or an RS256-to-HS256 confusion attack where the public key is used as an HMAC secret) — always pin the expected algorithm server-side; not validating `iss`, `aud` and `exp`; using a weak shared secret; putting sensitive data in the payload, which is base64, not encrypted; long expiry with no revocation path; and storing the token in `localStorage`, where any XSS steals it. The refresh flow: a short-lived access token (5–15 minutes) plus a long-lived refresh token stored server-side (or at least tracked by id) and sent as an `HttpOnly` cookie. On refresh, the server verifies the refresh token, issues a new access token and — importantly — **rotates** the refresh token, invalidating the old one. Rotation plus reuse detection is the key security property: if a rotated token is ever presented again, that means it was stolen, so you revoke the whole token family and force re-authentication. Also key rotation: publish a JWKS with `kid` so you can roll signing keys without downtime.

- **Why it matters** — JWT misconfiguration is a well-known and still-common source of authentication bypass.

- **Follow-ups** — Explain the RS256-to-HS256 confusion attack. What does reuse detection do on a legitimate race between two tabs? Where do you store the refresh token in a mobile app?

- **Senior signal** — Refresh rotation with reuse detection, algorithm pinning, and JWKS-based key rotation.

### Q170. How do you store passwords?

- **Expected answer** — With a slow, salted, memory-hard hash: **Argon2id** is the current recommendation (tune memory around 19–64 MB, iterations and parallelism to about 200–500 ms on your hardware), with **bcrypt** (cost 12+) as the widely-supported fallback and **scrypt** as another option. Never MD5, SHA-256 or any fast hash, even salted, because a GPU computes billions per second. The salt is per-user and stored with the hash (bcrypt and Argon2 encode it in the output string), and you should add a server-side **pepper** kept in a secret store or HSM so a database dump alone is not enough. Verify with a constant-time comparison, which the library does for you. Operationally: re-hash on successful login when the cost parameters have been raised, so the corpus upgrades gradually; never log the password or put it in an error message; enforce length (a 12-character minimum) rather than composition rules, and check against a breached-password list; rate-limit and lock out on repeated failures with a delay that does not reveal whether the account exists. And do the hash on a worker thread or accept that a 300 ms Argon2 call blocks the event loop.

- **Why it matters** — It is a solved problem, so getting it wrong signals a lack of security fundamentals.

- **Follow-ups** — Why does Argon2 cost matter more than salt length? What does a pepper protect against that a salt does not? How does password hashing interact with the Node event loop?

- **Senior signal** — Mentions re-hashing on login, the pepper, and the event-loop cost — the operational details, not just the algorithm name.

### Q171. Explain the OAuth2 flows you would use and why.

- **Expected answer** — **Authorization code with PKCE** for all interactive clients — web apps, SPAs and mobile — because the code is exchanged server-side (or with a proof key) so the token never appears in a URL. PKCE (a code verifier and its hash) protects against interception of the code on public clients, and it is now recommended even for confidential clients. **Client credentials** for machine-to-machine calls where there is no user. **Device code** for TVs and CLIs. The **implicit** flow is deprecated (tokens in the URL fragment, no refresh, leaks via history and referrers) and **resource owner password credentials** is deprecated too, because it requires the user to hand their password to a third-party app. OIDC sits on top of OAuth2 and adds the `id_token`, a JWT describing the user, plus a discovery document and JWKS. Things to get right regardless of flow: exact-match redirect URI registration (wildcards are how accounts get taken over), the `state` parameter to prevent CSRF on the callback, the `nonce` to bind an `id_token` to the request, and validating `aud` so a token minted for another client is rejected. And be clear about the distinction: OAuth2 is delegated authorization, OIDC is authentication; using a raw access token as proof of identity is a classic mistake.

- **Why it matters** — Almost every product integrates identity, and the failure modes are account takeover.

- **Follow-ups** — What attack does `state` prevent? Why is PKCE needed if you already have a client secret? What is wrong with treating an access token as a login?

- **Senior signal** — Names redirect-URI exact matching and the OAuth-versus-OIDC confusion, which is where real breaches come from.

### Q172. How do you design authorization for a multi-tenant system?

- **Expected answer** — Start with the model: **RBAC** (roles grant permissions) is simple and covers most products; **ABAC** (decisions from attributes of user, resource and context) handles rules like "a regional manager can view orders in their region during business hours"; **ReBAC** (relationship-based, Zanzibar-style) suits deeply nested sharing like documents and folders. Most systems need RBAC plus a few attribute rules, and I would resist building a policy engine before the rules justify it. For tenancy isolation, defence in depth: (1) the tenant id is derived from the authenticated principal, **never** from a request parameter or header a client can set; (2) every query is scoped by tenant, enforced structurally — a base repository that always adds the predicate, or Postgres **row-level security** with `SET LOCAL app.tenant_id` so even a forgotten predicate cannot leak; (3) tests that assert cross-tenant access returns 404; (4) audit logging of access to sensitive resources. For very sensitive domains, separate schemas or databases per tenant give stronger isolation at the cost of migration and connection complexity. The rule I state plainly: shared-table tenancy is fine, but the isolation must be enforced by something other than developer memory.

- **Why it matters** — Cross-tenant data leaks are company-ending bugs and they are usually one missing `WHERE` clause.

- **Follow-ups** — How does RLS interact with connection pooling? What test proves isolation? When would you move a tenant to its own database?

- **Senior signal** — Structural enforcement (RLS or a base repository) plus tests, rather than trusting code review.

### Q173. How does SQL injection happen in an ORM-based codebase, and how do you prevent it?

- **Expected answer** — Parameterised queries make injection structurally impossible because values are sent separately from the SQL text and can never be reinterpreted as syntax. Injection still appears in ORM codebases in specific places: raw queries built by string concatenation (`manager.query(\`SELECT * FROM users WHERE email = '${email}'\`)`), query-builder `where` clauses with interpolated strings, dynamic `ORDER BY` or column names taken from user input (which *cannot* be parameterised, so they must be validated against an allow-list of known columns), `LIKE` patterns assembled by concatenation, and dynamic table names in multi-tenant code. Also `IN` clauses built by joining an array into a string. Prevention: always use bound parameters (`$1`, `:name`), allow-list any identifier that must be interpolated, use a lint rule or CodeQL query that flags template literals inside query calls, run SAST in CI, and give the application database user the minimum privileges — no `DROP`, no access to other schemas, so even a successful injection has a bounded blast radius. Verify by testing: a test that sends `'; DROP TABLE users; --` and asserts a normal 404 is cheap insurance.

- **Why it matters** — It remains a top vulnerability class, and ORMs create false confidence.

- **Follow-ups** — How do you implement a user-selectable sort column safely? Why can't you parameterise a table name? What does least-privilege buy you here?

- **Senior signal** — The dynamic-identifier allow-list and least-privilege database user, which are the parts ORMs do not solve.

### Q174. Do REST APIs need CSRF protection, and how does CORS relate?

- **Expected answer** — It depends entirely on how the credential travels. If authentication uses a **cookie**, the browser attaches it automatically to cross-site requests, so yes, you need CSRF protection: `SameSite=Lax` or `Strict` on the cookie (which blocks most cases), plus a synchroniser token or the double-submit pattern for anything state-changing, and never rely on checking `Origin` alone. If authentication uses an **`Authorization: Bearer` header**, the browser does not attach it automatically, so classic CSRF does not apply — but then you must not also accept the token from a cookie, or you have reintroduced it. CORS is a *different* mechanism and is often confused with CSRF: it is a browser policy that restricts *reading* cross-origin responses, not a server-side authorization control. A permissive `Access-Control-Allow-Origin: *` does not create CSRF, and a strict CORS policy does not prevent it, because a form POST is a simple request that never triggers a preflight. Configure CORS with an explicit origin allow-list, and never reflect the `Origin` header combined with `Allow-Credentials: true`, which effectively disables the same-origin policy for every site.

- **Why it matters** — The CORS/CSRF confusion is extremely common and leads to both false confidence and broken configs.

- **Follow-ups** — Why does `SameSite=Lax` not cover everything? What is the double-submit pattern and its weakness? What is wrong with reflecting the Origin header?

- **Senior signal** — Separates the two mechanisms crisply and knows the origin-reflection-with-credentials anti-pattern.

### Q175. What are IDOR and mass assignment, and how do you prevent them?

- **Expected answer** — **IDOR** (insecure direct object reference, or broken object-level authorization) is when an endpoint uses a client-supplied id without checking ownership: `GET /invoices/1042` returns someone else's invoice because the handler only did `findOne(id)`. Prevention: scope every lookup by the principal (`WHERE id = $1 AND tenant_id = $2`), so the check cannot be forgotten; use non-sequential identifiers (UUIDv7 or ULIDs) so enumeration is impractical, though that is defence in depth, not a control; and return 404 rather than 403 where existence itself is sensitive. **Mass assignment** is when a request body is passed wholesale into an entity: `repo.save({ ...body, id })` lets a client set `role: 'admin'`, `isVerified: true`, `balance: 999999` or `tenantId`. Prevention: explicit DTOs with `whitelist: true` in the `ValidationPipe` so unknown properties are stripped, mapping DTO fields to entity fields explicitly rather than spreading, and marking sensitive fields as never-writable from the API. Both classes are best caught structurally — a repository that requires a tenant scope, and a mapping layer between DTO and entity — plus authorization tests as part of the standard test suite for every new endpoint.

- **Why it matters** — These are the top two entries on the OWASP API list and both are trivially exploitable.

- **Follow-ups** — Write the test that proves an endpoint is not vulnerable. Are UUIDs a security control? How do you prevent a new endpoint from missing the scope?

- **Senior signal** — Structural prevention plus a standard authorization test, and being clear that unguessable ids are not authorization.

### Q176. How do you manage secrets?

- **Expected answer** — Secrets never live in the repository, in a `.env` committed anywhere, in a Docker image, or in a Kubernetes ConfigMap. They come from a secret manager (AWS Secrets Manager or SSM Parameter Store, Vault, GCP Secret Manager) and reach the process as environment variables or mounted files, injected by the platform — for example External Secrets Operator syncing into Kubernetes secrets, or IRSA so the pod assumes an IAM role and fetches directly with no static credential at all. Prefer short-lived, automatically-rotated credentials over static ones: RDS IAM authentication or Vault dynamic database credentials mean a leaked credential expires in minutes. Rotation must be designed for: the application should support two valid credentials during a rotation window, or you must sequence "create new, deploy, revoke old". Other essentials: scan the repository history for leaked secrets (gitleaks or GitHub secret scanning) and treat any secret that has ever been committed as compromised — rotate it, do not just delete the commit; redact secrets in logs and in error messages, including in third-party SDK debug output; and audit access to the secret store so you know who read what.

- **Why it matters** — Leaked credentials are one of the most common initial access vectors in real breaches.

- **Follow-ups** — Walk me through rotating a database password with zero downtime. What do you do the moment a secret is found in Git history? How do you keep secrets out of logs?

- **Senior signal** — Dynamic short-lived credentials, dual-credential rotation windows, and treating any committed secret as burned.

### Q177. What do you need to know about TLS and mTLS in a backend?

- **Expected answer** — TLS gives confidentiality, integrity and server authentication via a certificate chain; TLS 1.3 is the target (fewer round trips, no legacy cipher suites) with 1.2 as the floor. Terminating TLS at a load balancer is normal, but then the hop to your service is plaintext — acceptable inside a private network, and worth encrypting (or using a service mesh) if you have compliance requirements or an untrusted network. **mTLS** adds client certificate verification, so both sides authenticate; it is the standard for service-to-service identity in a mesh (Istio, Linkerd) and for high-value partner integrations. The operational realities that bite: certificate expiry is a recurring outage cause, so automate renewal (ACME/cert-manager) and alert at 30 and 7 days out; certificate pinning in mobile clients makes rotation dangerous if you pin a leaf rather than an intermediate; internal CAs need their own rotation plan; and clock skew breaks validity checks. In Node specifically: keep the default certificate store rather than setting `rejectUnauthorized: false`, which people add "temporarily" to fix a self-signed certificate error and then ship — that single flag turns TLS into obfuscation.

- **Why it matters** — Expired certificates and disabled verification are both common and both severe.

- **Follow-ups** — What happens when your internal CA certificate expires? Why is `rejectUnauthorized: false` so dangerous? Where does mTLS not help?

- **Senior signal** — Treats certificate lifecycle as an operational risk with alerting, and calls out the `rejectUnauthorized` anti-pattern by name.

### Q178. What is SSRF and where does it appear in a backend?

- **Expected answer** — Server-Side Request Forgery is when an attacker makes your server issue a request to a destination of their choosing. Backends invite it whenever they fetch a user-supplied URL: webhook registration, "import from URL", avatar fetching by link, PDF or screenshot rendering, and URL preview generation. The impact is severe in cloud environments because your server can reach things the attacker cannot: the instance metadata service (`169.254.169.254`, which on IMDSv1 hands out IAM credentials), internal admin panels, databases on private IPs, and Kubernetes services. Defences, layered: validate the URL scheme (http/https only) and reject credentials in the URL; resolve the hostname and check the resulting IP against a deny-list of private, loopback, link-local and metadata ranges — then connect to *that resolved IP*, because otherwise a DNS-rebinding attack changes the answer between check and use; disable redirects or re-validate every hop; enforce timeouts and response size limits; and, most robustly, route all outbound user-driven fetches through an egress proxy with an allow-list, running in a network segment with no access to internal services. Also enforce IMDSv2 so the metadata service requires a PUT-obtained token.

- **Why it matters** — SSRF plus cloud metadata is one of the highest-impact bug chains in modern infrastructure.

- **Follow-ups** — What is DNS rebinding and why does IP validation alone fail? Which AWS setting mitigates the metadata risk? How do you let customers register arbitrary webhook URLs safely?

- **Senior signal** — The check-then-connect-to-the-same-IP detail and the egress proxy, which is what actually holds up.

### Q179. How do you handle dependency and supply-chain risk in a Node project?

- **Expected answer** — Concretely: commit the lockfile and install with `npm ci` so builds are reproducible; run `npm audit` or Snyk/Dependabot in CI with a policy that blocks on high and critical vulnerabilities in production dependencies (and does not block the world on a dev-dependency advisory nobody can exploit); pin base images by digest, not by tag; keep a dependency budget, because every package is code you did not review and `node_modules` transitively includes hundreds of maintainers. Beyond scanning: use `--ignore-scripts` where feasible, since post-install scripts are the classic attack vector; generate an SBOM (CycloneDX or SPDX) so that when the next widely-used package is compromised you can answer "are we affected?" in minutes rather than days; prefer packages with a recent release, multiple maintainers and a real test suite; and vendor or fork tiny one-function packages rather than depending on them. On the release side, sign your own artifacts and use provenance attestations. The judgement part: not every advisory is urgent — a prototype-pollution issue in a build-time tool is not the same as a remote-code-execution in your HTTP parser, and treating them identically causes alert fatigue and gets scanning switched off.

- **Why it matters** — Supply-chain attacks are increasing and the response depends on preparation, not heroics.

- **Follow-ups** — A popular package you depend on is compromised at 9 a.m. What do you do first? How do you decide which advisories block a release? What is an SBOM for?

- **Senior signal** — Has a triage policy rather than blanket blocking, and can answer the "are we affected?" question with tooling.

### Q180. How do you protect data at rest and handle PII?

- **Expected answer** — Layers. Disk-level encryption (RDS/EBS encryption, S3 SSE-KMS) is table stakes and protects against physical and snapshot exposure, but it does *not* protect against an application-level breach, because the application reads plaintext. So for genuinely sensitive fields — government identifiers, card data, health information — add application-level encryption with keys from KMS, ideally envelope encryption with a per-tenant or per-record data key, and accept that encrypted columns cannot be indexed or searched normally (use a deterministic hash for equality lookup, or a separate blind index). Beyond encryption, the higher-leverage controls are: minimise what you collect and how long you keep it (a retention policy with an actual deletion job), tokenise card data so it never touches your systems (use the payment provider's vault — PCI scope is the strongest argument for not storing something), mask PII in logs and in non-production environments (anonymised database copies, never a production dump on a laptop), restrict who can query production data and audit those queries, and implement deletion and export properly for GDPR/DPDP-style requests, including backups and downstream systems like search indexes and analytics warehouses — which is the part everyone forgets.

- **Why it matters** — Data protection is a design and process problem, and the "we encrypt the disk" answer is a mid-level tell.

- **Follow-ups** — How do you handle a right-to-erasure request when the data is in three systems and a backup? How do you search an encrypted column? What is in your non-production database?

- **Senior signal** — Knows disk encryption does not stop application-level breaches, and treats deletion across downstream systems as the hard part.
