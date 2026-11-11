## 40.24 Broken Access Control

#### Concept

Broken access control is OWASP's number one category, and it is a family rather than a single bug: IDOR (40.12), missing function-level checks (an admin endpoint with no role guard), **mass assignment** (a request body that sets fields the user should not control), privilege escalation through a role in the request body, and metadata manipulation (editing a JWT claim, a hidden form field, or a cookie value). What they share: the server did the work it was asked to do without asking whether the caller was allowed to ask.

#### Why does it exist?

Authorization is per-endpoint logic written by many people over years. Every new field, endpoint, and role is a chance to forget. Frameworks cannot know your business rules, so they cannot enforce them by default. What they can do is make the safe path the default: global guards, whitelisted DTOs, and repositories that require a principal.

#### Mental model

Imagine a hotel where the reception desk is strict but housekeeping leaves every door propped open, the minibar restocking form lets guests write their own price, and the "upgrade to suite" form is on the website with no check of who submits it. Each door, form, and field is an access-control decision.

#### How it works

**Exploit examples against a NestJS app:**

1. **Missing function-level check**: `DELETE /admin/users/:id` exists in `AdminController` with `@UseGuards(JwtAuthGuard)` but the developer forgot `RolesGuard`. Any logged-in user can delete users.
2. **Mass assignment**: `PATCH /users/me` accepts `UpdateUserDto` but the service does `Object.assign(user, body)`. The attacker sends `{ "displayName": "x", "roles": ["admin"], "emailVerified": true, "balanceCents": 999999 }`. Without a DTO whitelist, every property lands on the entity.
3. **Privilege escalation via body**: `POST /auth/register` with `{ "email": ..., "password": ..., "role": "admin" }` and a DTO that has an optional `role` property "for the admin creation flow".
4. **Nested mass assignment**: `{ "address": { "id": "<someone else's address id>", "line1": "..." } }` where the service upserts the nested object by id, moving another user's address into this user's account.

**Fixes:**

1. Global guards with explicit `@Public()` (40.37); a test that walks every route.
2. `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` globally. Unknown properties are rejected, not silently dropped, so an attacker probing for hidden fields gets a 400 and you get a log line.
3. Separate DTOs per audience: `UpdateProfileDto` for users has no `roles`; `AdminUpdateUserDto` has `roles` and lives behind `@Roles('admin')`.
4. Never `Object.assign(entity, body)`; copy allowed fields explicitly, or use the DTO class as the only source.
5. Nested objects: validate with `@ValidateNested()` and `@Type(() => AddressDto)`, and never trust ids inside nested objects; look up by `(id, ownerId)`.

#### NestJS example

```ts
// main.ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,              // strip properties without decorators
  forbidNonWhitelisted: true,   // ...and reject the request instead of silently stripping
  transform: true,              // plain body -> DTO class instance (enables nested validation)
  forbidUnknownValues: true,
}));
```

```ts
// update-profile.dto.ts: what a USER may change about themselves. No roles, no email, no balance.
export class UpdateProfileDto {
  @IsOptional() @IsString() @Length(1, 80) displayName?: string;
  @IsOptional() @IsString() @Length(0, 500) bio?: string;
  @IsOptional() @ValidateNested() @Type(() => AddressInputDto) address?: AddressInputDto;
}
export class AddressInputDto {
  // Note: no `id`. The server decides which address row belongs to the caller.
  @IsString() @Length(1, 120) line1: string;
  @IsString() @Length(1, 60) city: string;
  @IsString() @Length(2, 2) country: string;
}

// users.service.ts
async updateProfile(userId: string, dto: UpdateProfileDto) {
  const user = await this.repo.findOneByOrFail({ id: userId });
  if (dto.displayName !== undefined) user.displayName = dto.displayName;   // explicit field copy
  if (dto.bio !== undefined) user.bio = dto.bio;
  if (dto.address) await this.addresses.upsertForUser(userId, dto.address); // owner-scoped upsert
  return this.repo.save(user);
}
```

#### PostgreSQL example

Column-level grants make certain escalations impossible even if the code is wrong:

```sql
-- The API role can update profile columns but not privilege columns; role changes go through a separate admin path/role.
GRANT SELECT ON users TO svc_api;
GRANT UPDATE (display_name, bio, password_hash, tokens_invalid_before, updated_at) ON users TO svc_api;
-- No UPDATE on users.status, no INSERT/DELETE on user_roles for svc_api.
GRANT INSERT, DELETE ON user_roles TO svc_admin;
```

An `Object.assign` bug that tries to write `status` now fails with a permission error and a log line instead of a silent escalation.

#### Production scenario

A SaaS with 400 endpoints. The route-walker test runs in CI and fails when a new controller lacks the expected guards. `forbidNonWhitelisted` rejections are logged with the property names; a spike of `roles`, `isAdmin`, `balance` in rejected properties is a reliable signal that someone is probing. The team sees one or two such probes a week from bug-bounty researchers and occasionally from real attackers.

#### Failure scenario

A "wallet" feature stored `balance_cents` on the `users` row. `PATCH /users/me` used `repo.merge(user, body)` before a DTO was added. A user set their own balance to ten million cents and bought a laptop. The investigation found the pattern in six other endpoints. The fix was the global `ValidationPipe` with whitelist and a rule that money never lives on a row the user can patch.

#### Edge cases & failure modes

- `@IsOptional()` on a sensitive field in a shared DTO.
- `transform: true` without `@Type()` on nested arrays, leaving nested objects unvalidated.
- Query DTOs (`@Query()`) forgotten; the pipe applies to them too if declared as classes.
- GraphQL or WebSocket handlers bypassing the HTTP pipe.
- Bulk endpoints that apply changes to ids from the body without ownership filtering.
- Admin impersonation features ("view as user") that do not downgrade permissions.

#### How a Senior Backend Engineer thinks about this

They make it structurally hard to be wrong: global validation with whitelist, per-audience DTOs, guards by default, column grants for privilege fields, and CI tests that enumerate routes and reject unknown properties. They keep money and privilege on rows and columns the user's role cannot write. They treat every "temporarily optional" field in a DTO as a future incident.

#### Common mistakes

- One DTO shared by users and admins.
- `whitelist: true` without `forbidNonWhitelisted`, hiding probes.
- Spreading request bodies into entities.
- Guards on controllers, not globally.

#### Interview questions

1. *What is mass assignment and how does NestJS prevent it?* Expected: `ValidationPipe` whitelist and per-audience DTOs.
2. *How do you guarantee every route is guarded?* Expected: global `APP_GUARD` with `@Public()`, route enumeration test.
3. *Give three forms of broken access control other than IDOR.*
4. *How can PostgreSQL grants back up application authorization?*

#### Practical exercise

Enable the global `ValidationPipe` with whitelist and forbid options. Send `{ "roles": ["admin"] }` to every `PATCH` and `POST` endpoint in a project. Acceptance criteria: every request returns 400 with the offending property named; the route-walker test passes; column grants prevent `svc_api` from updating `users.status`.

## 40.25 Authentication Failures

#### Concept

This category covers everything that lets an attacker become someone else without breaking cryptography: **credential stuffing** (replaying leaked email/password pairs), **brute force** (guessing passwords or codes), **weak password reset** (guessable tokens, tokens that never expire, reset links that leak), **user enumeration** (different messages or timings for "wrong password" and "no such user"), and missing lockouts and rate limits.

#### Why does it exist?

Login is the most-attacked endpoint on any site because it is public, standardised, and the prize is an account. Attackers run credential stuffing at internet scale using botnets and residential proxies; a success rate of 0.5 percent on a million attempts is 5,000 accounts.

#### Mental model

Imagine a building with one public door. The attacker has a bag of ten thousand keys stolen from other buildings and tries each one. A doorman who lets them try all day is the vulnerability. A doorman who pauses after five wrong keys, notices the same person trying at every door, and never says "that key is for the wrong door, try again" is the fix.

#### How it works

**Exploit examples:**

1. Credential stuffing: 2 million leaked pairs replayed at 200 requests per second from 5,000 IPs. No per-IP limit triggers because each IP sends a few requests. Detection needs per-account failure counts and global failure rate.
2. Enumeration: `POST /auth/login` returns `"No account with that email"` vs `"Wrong password"`; `POST /auth/register` returns `"Email already registered"`; `POST /auth/forgot` returns `"We sent an email"` only for existing accounts and responds 40 ms faster otherwise (no hashing). Each leaks which emails are customers.
3. Weak reset: the token is a 6-digit code with no rate limit; or the token is `base64(userId + timestamp)`; or the reset link is `GET` and the token ends up in the referrer of the analytics script loaded on the reset page.

**Fixes:**

1. **Rate limiting** in layers: per IP (`@nestjs/throttler`, 20 per minute on `/auth/*`), per account (5 failures per 15 minutes, then a progressively longer delay or a captcha), and global (alert when the login failure rate exceeds 3x baseline).
2. **Account lockout that does not become a DoS**: never hard-lock on failures alone (an attacker can lock every user out). Use exponential delays, captcha after N failures, and notify the user; hard-lock only with a self-service unlock via email.
3. **Uniform responses**: `"Invalid email or password"` for every login failure; `"If that email exists, we sent a link"` for reset; on registration, send an email to the existing address ("someone tried to register with your email") and return the same success response.
4. **Uniform timing**: always run the password hash (dummy hash for unknown users, 40.14).
5. **Reset tokens**: 32 random bytes, stored hashed, 15-minute expiry, single use, bound to the user, invalidated when a new one is issued or on login; the reset page must not load third-party scripts, and the token is submitted via `POST`. Changing the password invalidates all sessions and refresh tokens and sends a notification.
6. **Breached-password check** at registration and password change (Have I Been Pwned range API with k-anonymity).
7. **Notifications**: new device login, password changed, MFA disabled. Users are your best intrusion detection.

#### NestJS example

Layered limits with `@nestjs/throttler` for IP and a Redis counter for accounts, plus a uniform-response password reset.

```ts
// app.module.ts: per-IP throttling with Redis storage so limits are shared across pods
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
    storage: new ThrottlerStorageRedisService(cfg.getOrThrow('REDIS_URL')), // from @nest-lab/throttler-storage-redis
  }),
}),
providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
```

```ts
// auth.controller.ts
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })   // stricter on auth routes
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, { ip: req.ip!, userAgent: req.headers['user-agent'] });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@Body() dto: ForgotPasswordDto) {
    await this.auth.requestPasswordReset(dto.email);     // does the same amount of visible work either way
    return { message: 'If that email exists, we sent a reset link.' };
  }
}
```

```ts
// auth.service.ts (account-level failure tracking)
async login(email: string, password: string, meta: { ip: string; userAgent?: string }) {
  const failKey = `login:fail:${email.toLowerCase()}`;
  const failures = Number((await this.redis.client.get(failKey)) ?? 0);
  if (failures >= 5) {
    // Progressive delay instead of hard lock; captcha required by the client above 5.
    throw new HttpException({ code: 'TOO_MANY_ATTEMPTS', retryAfterSeconds: 60 * 2 ** Math.min(failures - 5, 6) }, 429);
  }
  const user = await this.users.verifyCredentials(email, password);   // dummy-hash timing when unknown
  if (!user) {
    await this.redis.client.multi().incr(failKey).expire(failKey, 900).exec();
    throw new UnauthorizedException('Invalid email or password');       // identical for unknown email and wrong password
  }
  await this.redis.client.del(failKey);
  await this.audit.record('login.success', { userId: user.id, ip: meta.ip, ua: meta.userAgent });
  if (await this.devices.isNew(user.id, meta)) await this.mailer.newDeviceLogin(user.email, meta);
  return this.tokens.issuePair(user);
}
```

#### PostgreSQL example

```sql
CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  request_ip inet
);
-- Only one live reset per user: issuing a new one invalidates the old.
CREATE UNIQUE INDEX password_resets_one_live_idx ON password_resets (user_id) WHERE used_at IS NULL;

-- Consume atomically; the WHERE clause is the whole security check.
UPDATE password_resets SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING user_id;
```

The `UPDATE ... RETURNING` makes the reset race-free: two concurrent submissions of the same token cannot both succeed, because only one update matches `used_at IS NULL`.

#### Production scenario

A consumer app sees 15 million login attempts a month, of which about 2 million are credential stuffing. Per-IP limits catch almost none (residential proxies). Per-account limits plus a global "failure rate above 3x baseline" alert catch the campaigns within minutes; the response is to require a captcha on login for 24 hours and to force resets on accounts that had a successful login from a new country during the campaign. Reset tokens are consumed at about 3,000 per day; expired rows are purged nightly.

#### Failure scenario

At 03:40 the login failure rate went from 4 percent to 61 percent. A stuffing campaign was running at 300 requests per second. Per-IP throttling did nothing (12,000 IPs). The account-level counter blocked most accounts after 5 attempts, which was the intended defense, but the attacker then switched to one attempt per account across 2 million accounts, under the threshold. What finally stopped it was the global alert and a captcha switch. Post-incident, the team added device fingerprint scoring and a "new device requires email confirmation" step for accounts with no MFA.

#### Edge cases & failure modes

- Lockouts weaponised to deny service to real users; use delays and captchas, not hard locks.
- Rate limits keyed by IP behind a load balancer that hides the client IP; configure `trust proxy` and use `X-Forwarded-For` carefully (only trust your own proxies).
- Timing differences from cache hits (user row cached vs not); measure.
- Reset tokens in `GET` URLs leaking via `Referer`; use `Referrer-Policy: no-referrer` and `POST`.
- Reset email sent to an unverified new email address after an email change; require confirmation of the new address first.
- OAuth "login with" flows that bypass account lockout state.
- Race in password reset: two submissions of the same token; atomic consume.
- Registration enumeration through "email taken" errors; also through timing and through the `forgot` endpoint.

#### How a Senior Backend Engineer thinks about this

They treat the auth endpoints as a product surface under permanent attack and instrument them first: failure rate, per-account failures, new-device logins, reset volume. They design lockouts that cannot be turned against users, uniform responses and timings, and a reset flow with hashed single-use tokens and atomic consumption. They push MFA and passkeys for the accounts that matter, because rate limiting is a delay, not a defense, against a patient attacker.

#### Common mistakes

- Different error messages per failure type.
- Hard lockout after 5 failures with no self-service unlock.
- Reset tokens that live for 24 hours and can be used twice.
- No notification on password change.
- Only IP-based limits.

#### Interview questions

1. *How do you stop credential stuffing when the attacker has 10,000 IPs?* Expected: per-account counters, global failure rate, captcha, device signals, MFA.
2. *Design a secure password reset flow end to end.* Expected: uniform response, random hashed token, short expiry, single use, atomic consume, session invalidation, notification, POST submit.
3. *How can user enumeration happen even with uniform messages?* Expected: timing, registration and reset endpoints, response size.
4. *Why is account lockout dangerous and what do you do instead?*

#### Practical exercise

Implement login and reset with the code above. Write tests for: same message and timing (within 10 percent over 50 samples) for unknown vs wrong password; sixth failed login returns 429 with `retryAfterSeconds`; a reset token used twice fails the second time even when the two requests are concurrent; a password change invalidates all refresh tokens. Acceptance criteria: all pass; the reset link is submitted by `POST`; the reset page sets `Referrer-Policy: no-referrer`.

## 40.26 Security Misconfiguration

#### Concept

Security misconfiguration is the category of "it worked in dev and nobody changed it": debug endpoints in production, `CORS: *` with credentials, default credentials on Redis or Grafana, verbose stack traces in error responses, Swagger UI open on the public API, TypeORM `synchronize: true` on production (which drops and recreates columns on a schema change), Prometheus `/metrics` exposed to the internet, security groups allowing `0.0.0.0/0` to port 5432.

#### Why does it exist?

Defaults are chosen for developer convenience. Production hardening is a checklist that competes with feature work, and nothing fails visibly when it is skipped. The fix is to make hardening the default in the templates and images every service starts from, and to scan for drift.

#### Mental model

Imagine a house where the builder leaves every window open and a spare key under the mat, because that made it easier for the trades to come and go. Moving in without a walk-through means living in a house with the doors the builder left open.

#### How it works

**Exploit examples and fixes:**

| Misconfiguration | Exploit | Fix |
|---|---|---|
| `CORS origin: '*'` with `credentials: true` (or origin reflected from the request) | Any site reads authenticated API responses in the victim's browser | Explicit origin allow-list; never reflect; `credentials` only with a specific origin |
| Verbose errors (`stack`, SQL text, file paths) | Attacker learns internals, ORM, table names | Global exception filter that logs details and returns a generic body with a correlation id |
| Swagger UI open in production | Complete API map, including admin routes, for anyone | Disable in production or protect behind auth and IP allow-list |
| `synchronize: true` in TypeORM | Schema changes on deploy drop columns and data; an entity rename deletes a table | Migrations only; `synchronize: false` enforced in config |
| `/metrics`, `/health` with details, `/debug` endpoints public | Internal topology, versions, dependency status | Separate management port or auth; expose only liveness publicly |
| Default credentials (Redis without `requirepass`, `postgres/postgres`, Grafana `admin/admin`) | Full access from anywhere that can reach the port | Unique credentials from the secrets manager; network policy |
| Security group `0.0.0.0/0` on 5432 or 6379 | Database on the internet | Private subnets; access only from app security group; bastion or SSM for humans |
| `NODE_ENV` not `production` | Slower, more verbose, some libraries enable debug features | Set explicitly in the image |
| Directory listing, `.git` folder, `.env` in the served directory | Source and secrets download | Do not serve static files from the repo root; multi-stage Docker builds |
| Container running as root | Container escape becomes host root | `USER node` in the Dockerfile; read-only filesystem; drop capabilities |

#### NestJS example

Hardened bootstrap: explicit CORS, a global exception filter that hides internals, Swagger only outside production, and a management port for metrics.

```ts
// main.ts
const isProd = process.env.NODE_ENV === 'production';
app.enableCors({
  origin: cfg.getOrThrow<string>('WEB_ORIGINS').split(','),   // explicit list; a function can validate against a DB for multi-tenant domains
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key'],
  maxAge: 600,
});
app.useGlobalFilters(new SafeExceptionFilter());
if (!isProd) {
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('API').build());
  SwaggerModule.setup('docs', app, doc);
}
```

```ts
// safe-exception.filter.ts
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const correlationId = (req.headers['x-request-id'] as string) ?? randomUUID();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return res.status(status).json(typeof body === 'string' ? { message: body, correlationId } : { ...(body as object), correlationId });
    }
    // Unknown error: full details to the log, nothing to the client.
    this.logger.error({ correlationId, path: req.path, err: exception instanceof Error ? exception.stack : String(exception) });
    return res.status(500).json({ message: 'Internal server error', correlationId });
  }
}
```

```ts
// data-source config: make the dangerous option impossible in production
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: cfg.getOrThrow('DATABASE_URL'),
  synchronize: false,                                   // always; migrations are the only path
  migrationsRun: false,                                 // run migrations as a deploy step, not at app start
  ssl: isProd ? { rejectUnauthorized: true } : false,
  logging: isProd ? ['error'] : ['query', 'error'],
  extra: { max: 20, statement_timeout: 10_000 },
};
```

#### PostgreSQL example

```sql
-- pg_hba.conf: no `trust`, no `0.0.0.0/0`; scram-sha-256 only over TLS
-- hostssl  all  all  10.0.0.0/8  scram-sha-256
-- Find roles with dangerous attributes:
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolconnlimit
FROM pg_roles WHERE rolname NOT LIKE 'pg_%';
-- The application roles should show f, f, f, f and a connection limit.

-- Revoke the default PUBLIC privileges on the schema (PG15+ does this by default):
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE app FROM PUBLIC;
```

#### Production scenario

A platform runs a weekly configuration scan: CORS headers on every public host, presence of `/docs`, `/metrics`, `/.env`, `/.git/config`, response headers for stack traces, open ports via the cloud provider's security group API, and a TypeORM config lint for `synchronize`. Findings open tickets automatically. The service template repository ships with the hardened `main.ts`, so new services start correct.

#### Failure scenario

A staging deploy with `synchronize: true` was promoted to production by copying the config. An entity property had been renamed from `phone` to `phoneNumber`. TypeORM dropped `phone` and added `phone_number`, deleting 900,000 phone numbers on startup. Restore from backup took four hours and lost 20 minutes of writes. `synchronize` is now rejected by a config schema at boot when `NODE_ENV=production`.

#### Edge cases & failure modes

- CORS origin validated by `origin.endsWith('example.com')`, which matches `evilexample.com`.
- `Access-Control-Allow-Origin: null` accepted (sandboxed iframes send `null`).
- Health endpoints returning dependency versions and hostnames.
- Debug logging left at `query` level, writing every parameter (including passwords in `INSERT`) to logs.
- Kubernetes dashboards, Redis Commander, pgAdmin exposed through an ingress "for a demo".
- Image tags `latest` and base images never rebuilt.
- Error pages from the load balancer or a framework revealing versions.

#### How a Senior Backend Engineer thinks about this

They put hardening in the template, not in the checklist, and they scan for drift because templates get edited. They keep production, staging and dev configs in one typed schema validated at boot, with production-only assertions (`synchronize=false`, `docs=off`, `cors` explicit). They give management endpoints their own port and network policy. They treat "we will lock it down before launch" as a sentence that has never once been true.

#### Common mistakes

- `origin: true` (reflect) in CORS.
- Swagger with `Bearer` auth helper in production, doubling as an attack console.
- Returning `error.message` from ORM errors (leaks SQL and table names).
- Running migrations automatically at app start with several replicas racing.

#### Interview questions

1. *Why is `Access-Control-Allow-Origin: *` with credentials a critical bug?* Expected: any site can read authenticated responses; browsers actually forbid the literal `*` with credentials, so the real bug is reflection.
2. *What does `synchronize: true` do and why must it never reach production?*
3. *How would you design error responses to be safe and still debuggable?* Expected: correlation id, full details in logs, generic body.
4. *Name five things you would scan for weekly on a public API.*

#### Practical exercise

Write a boot-time config validator (`zod` or `class-validator` on the config object) that fails startup in production if `synchronize` is true, Swagger is enabled, CORS origins include `*`, or `NODE_ENV` is not `production`. Acceptance criteria: each condition is covered by a test that asserts startup fails with a clear message; a scan script checks the deployed API for `/docs`, `/metrics`, stack traces and CORS reflection and exits non-zero on any finding.

## 40.27 Insecure Deserialization and Prototype Pollution

#### Concept

Deserialization turns bytes into objects. In Node the usual format is JSON, which is safe *as a parser* (`JSON.parse` does not execute code), but the object it produces can be dangerous to the code that consumes it. **Prototype pollution** is the JavaScript-specific hazard: a payload like `{"__proto__": {"isAdmin": true}}` merged into another object with a naive recursive merge sets `isAdmin` on `Object.prototype`, and suddenly every object in the process has `isAdmin === true`. Other formats are worse: YAML parsers with custom tags, `node-serialize`, and anything that revives functions can execute attacker code directly.

#### Why does it exist?

JavaScript objects have a prototype chain, and the keys `__proto__`, `constructor`, and `prototype` are reachable through ordinary property access. Utilities that copy properties from input into objects (`merge`, `extend`, `defaults`, `set` with a path) become gadgets. The class-transformer library that NestJS uses to build DTOs copies properties too, which is why `whitelist` matters beyond mass assignment.

#### Mental model

Imagine a company where every employee's badge is printed from a template. An attacker who can edit the *template* changes every badge at once. `Object.prototype` is the template for every object; polluting it changes every object in the process.

#### How it works

**Exploit example:**

1. The app has a "settings" endpoint that deep-merges the request body into the user's existing settings with `lodash.merge` (older versions) or a hand-written recursive merge.
2. The attacker sends `{"__proto__": {"role": "admin"}}`.
3. The merge walks into `__proto__` and sets `role` on `Object.prototype`.
4. Elsewhere, `if (user.role === 'admin')` on a user object with no `role` property now finds `'admin'` through the prototype chain. Or a template engine finds `outputFunctionName` on options and executes code. Or `class-validator` finds a polluted `forbidUnknownValues`.

**Fixes:**

1. `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` so bodies become DTO instances with only declared properties; `class-transformer`'s `plainToInstance` with `excludeExtraneousValues` is the stricter variant.
2. Never deep-merge request data into existing objects. If you must merge, use a merge that skips `__proto__`, `constructor` and `prototype`, or create objects with `Object.create(null)` for dictionaries.
3. Keep dependencies patched; `lodash.merge`, `minimist`, `qs`, `deep-extend` all had pollution CVEs.
4. Use `JSON.parse` only; never `eval`, `vm.runInNewContext` on input, `node-serialize`, or YAML with custom types (`js-yaml` `load` is safe by default since v4; `yaml` package is safe; avoid `DEFAULT_FULL_SCHEMA`).
5. Body size limits (`express.json({ limit: '1mb' })`) and a depth cap for nested JSON, because a 10 MB deeply nested body is a CPU denial of service.
6. Optionally freeze the prototype at startup: `Object.freeze(Object.prototype)`. It breaks some libraries; test before enabling.

#### NestJS example

```ts
// main.ts: size and depth limits, plus prototype pollution hardening
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
app.use(express.json({ limit: '1mb' }));                  // before NestJS body handling
app.use(express.urlencoded({ extended: false, limit: '200kb' })); // extended:false uses querystring, not qs (no nested objects)

// Middleware rejecting polluted keys anywhere in the body
app.use((req: Request, _res: Response, next: NextFunction) => {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 20) return false;                          // depth cap
    if (v && typeof v === 'object') {
      if (seen.has(v)) return true; seen.add(v);
      for (const k of Object.keys(v)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
        if (!walk((v as Record<string, unknown>)[k], depth + 1)) return false;
      }
    }
    return true;
  };
  if (req.body !== undefined && !walk(req.body, 0)) return next(new BadRequestException('Invalid payload'));
  next();
});
```

```ts
// settings.service.ts: explicit, shallow, typed merge instead of deep-merge
async update(userId: string, dto: UpdateSettingsDto) {
  const current = await this.repo.findOneByOrFail({ userId });
  current.theme = dto.theme ?? current.theme;
  current.notifications = { ...current.notifications, ...pick(dto.notifications ?? {}, ['email', 'sms', 'push']) }; // allow-listed keys only
  return this.repo.save(current);
}
```

#### PostgreSQL example

`jsonb` columns are a common landing place for merged settings. Validate the shape before storing and never store `__proto__` keys; PostgreSQL does not care, but the next `JSON.parse` in your app does.

```sql
-- Reject polluted keys at the database as a backstop:
ALTER TABLE user_settings ADD CONSTRAINT no_proto_keys
  CHECK (NOT (settings ? '__proto__' OR settings ? 'constructor' OR settings ? 'prototype'));
```

#### Production scenario

A product with a rich "preferences" JSON document per user. All writes go through a DTO with `@ValidateNested()` and known keys; the pollution-scanning middleware costs about 20 microseconds per request. Body limit is 1 MB; the largest legitimate payload is 60 KB. Dependabot keeps `lodash`, `qs` and friends current.

#### Failure scenario

A template-rendering service used a popular engine with a known prototype-pollution-to-RCE gadget. A "custom fields" endpoint deep-merged input into a settings object. An attacker set `__proto__.outputFunctionName` to a shell payload; the next email render executed it and the pod ran a crypto miner for two days before CPU alerts fired. Fixes: whitelist DTOs, no deep merge, engine upgrade, egress restrictions so the pod could not download payloads.

#### Edge cases & failure modes

- `qs` (used by `extended: true` URL encoding) creates nested objects from `a[b][c]=1`; older versions allowed `__proto__` paths.
- `JSON.parse` reviver functions that assign into objects.
- `class-transformer` `@Transform` handlers that copy arbitrary keys.
- `Object.freeze(Object.prototype)` breaking polyfills.
- YAML config loaded from user-supplied files (CI pipelines, import features).
- Deeply nested JSON exhausting the stack or CPU; depth and size caps.
- `structuredClone` and `JSON.parse(JSON.stringify(x))` are safe copies, unlike `merge`.

#### How a Senior Backend Engineer thinks about this

They accept only DTO-shaped input, they never merge input into state, and they treat any library that "recursively assigns" as suspect. They keep the JSON body limit small and enforced before the framework sees the body. They know the gadget chains exist in template engines and ORMs and keep those patched with priority.

#### Common mistakes

- `Object.assign` or spread of `req.body` into an entity (also mass assignment).
- `lodash.merge(existing, req.body)`.
- Unbounded body size.
- `extended: true` URL encoding on public endpoints.

#### Interview questions

1. *What is prototype pollution and why is it uniquely a JavaScript problem?* Expected: prototype chain reachable through `__proto__`; global effect.
2. *Is `JSON.parse` safe? Where does the danger begin?* Expected: parser is safe; consumers that merge are not.
3. *What controls stop a pollution payload before it reaches business logic in NestJS?*
4. *How can pollution become remote code execution?* Expected: gadgets in template engines and libraries reading options from polluted prototypes.

#### Practical exercise

Add the pollution-scanning middleware and body limits. Send `{"__proto__":{"polluted":true}}` and `{"constructor":{"prototype":{"polluted":true}}}` to every `POST`/`PATCH` route and then check `({}).polluted` inside a health endpoint. Acceptance criteria: both payloads are rejected with 400; `({}).polluted` is `undefined`; a 2 MB body is rejected before reaching any controller; the jsonb constraint rejects a direct insert with a `__proto__` key.

## 40.28 Dependency Vulnerabilities and Supply Chain

#### Concept

Your NestJS app is a few thousand lines of your code on top of a few hundred thousand lines of other people's code, pulled from npm. A vulnerability in `express`, `jsonwebtoken`, `axios`, `lodash`, or a transitive dependency five levels down is a vulnerability in your app. **Supply-chain attacks** go further: an attacker publishes a malicious version of a real package (compromised maintainer account), a typo-squatted package (`lodahs`), or a package that runs a `postinstall` script stealing environment variables from CI.

#### Why does it exist?

npm's model is "trust the registry and every maintainer of every transitive dependency". Automatic semver ranges (`^1.2.3`) pull new versions silently. Install scripts run arbitrary code. CI systems hold secrets in environment variables. Each of these is convenient and each is an attack path.

#### Mental model

Imagine building a house from parts made by 800 suppliers you have never met, delivered daily, some of which include instructions that your builders follow blindly on delivery. Lockfiles are the bill of materials; audits are the inspections; pinned versions and no install scripts are the rule that nothing gets used until inspected.

#### How it works

**Controls, in order of value:**

1. **Lockfile committed and honoured**: `package-lock.json` or `pnpm-lock.yaml` in git; `npm ci` (never `npm install`) in CI and Docker so builds are reproducible and cannot silently pick a newer version.
2. **Automated scanning**: `npm audit` in CI (with a policy: fail on high and critical, allow-list known non-exploitable findings with expiry dates), plus Dependabot or Snyk for pull requests with fixes. Renovate is the common alternative.
3. **Pinning and slow-rolling**: exact versions for critical packages (`jsonwebtoken`, `passport-jwt`, `pg`, `typeorm`); a policy to wait a few days after a new release before adopting (many malicious versions are pulled within 48 hours).
4. **No install scripts**: `npm ci --ignore-scripts` where possible, with an explicit allow-list for packages that legitimately need them (`bcrypt`, `argon2`, `sharp` build native code; prefer prebuilt binaries).
5. **Minimal base images**: `node:20-alpine` or distroless, multi-stage builds that copy only `dist/` and production dependencies, run as non-root, and are rebuilt weekly to pick up OS patches. Scan images with Trivy or Grype in CI.
6. **Provenance**: prefer packages with npm provenance attestations; use a private registry proxy (Artifactory, Verdaccio) that caches and can block packages.
7. **SBOM**: generate a software bill of materials (CycloneDX) per build so that when the next `log4j`-style event happens you can answer "are we affected" in minutes, not days.
8. **CI hygiene**: secrets scoped per job, no long-lived cloud keys in CI (OIDC federation instead), `postinstall` cannot reach production secrets because production secrets are not in CI.

#### NestJS example

A Dockerfile and a CI policy that implement the controls.

```dockerfile
# Dockerfile: reproducible, minimal, non-root
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts                      # exact versions from the lockfile; no install scripts
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
USER app
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
```

```yaml
# .github/workflows/security.yml (excerpt)
- run: npm ci --ignore-scripts
- run: npm audit --audit-level=high            # fails the job on high/critical
- run: npx @cyclonedx/cyclonedx-npm --output-file sbom.json
- uses: aquasecurity/trivy-action@0.28.0
  with: { image-ref: "ghcr.io/example/api:${{ github.sha }}", severity: "HIGH,CRITICAL", exit-code: "1" }
```

#### Production scenario

A company with 30 Node services runs Renovate with a 3-day minimum release age, `npm audit` gating, Trivy on images, and a private registry proxy. When a widely used package was compromised, the proxy's block-list stopped the malicious version within an hour of the advisory; the SBOM query showed 4 services with the package and none had built in the affected window. Base images are rebuilt every Monday; the median time from an OS CVE to patched images in production is 3 days.

#### Failure scenario

A CI pipeline ran `npm install` (not `ci`) with a floating range on a small utility package. The maintainer's account was hijacked and a version with a `postinstall` script that read `process.env` and posted it to a remote server was published. The pipeline's environment contained an AWS key with broad permissions. The attacker created EC2 instances for mining within 20 minutes. Fixes: `npm ci --ignore-scripts`, OIDC-federated short-lived cloud credentials in CI, a 3-day release-age policy, and secret scanning on outbound CI traffic.

#### Edge cases & failure modes

- `npm audit` noise: hundreds of findings in dev dependencies that never ship; scope the policy to production dependencies and triage with expiry dates.
- Native modules that need install scripts; use prebuilt binaries or allow-list them.
- Docker builds pulling `latest` base images and drifting.
- Vulnerable code in vendored or copy-pasted snippets that no scanner sees.
- Transitive dependency pinned by a lockfile but a security fix only available through a major upgrade of the parent.
- Abandoned packages with no maintainer to fix anything; plan replacements.

#### How a Senior Backend Engineer thinks about this

They accept that they cannot review every dependency and therefore build controls that limit what a bad dependency can do: no install scripts, no secrets in CI beyond short-lived federated ones, minimal images, network egress rules in production. They keep the dependency count low by preferring the standard library and a few well-maintained packages. They keep an SBOM so the next "are we affected" takes minutes.

#### Common mistakes

- `npm install` in CI.
- Ignoring `npm audit` because it is noisy, instead of tuning the policy.
- Long-lived cloud keys in CI environment variables.
- Root user in containers.
- Never rebuilding images.

#### Interview questions

1. *`npm install` vs `npm ci`: why does it matter for security?* Expected: lockfile honoured; reproducibility.
2. *How do you limit the blast radius of a malicious `postinstall`?* Expected: ignore scripts, no secrets in CI, federated credentials, egress limits.
3. *What is an SBOM and when did you last need one?*
4. *How would you respond to a critical CVE in a transitive dependency with no upstream fix?* Expected: overrides/resolutions, patch-package, vendoring, WAF mitigation, compensating controls.

#### Practical exercise

Convert a project to `npm ci --ignore-scripts`, add `npm audit --audit-level=high` and Trivy to CI, produce an SBOM, and switch the Dockerfile to a multi-stage non-root build. Acceptance criteria: CI fails on an injected vulnerable version of a dependency; the image runs as a non-root user; the SBOM lists every production package with its version; the build is reproducible (two builds from the same commit produce the same dependency tree).
