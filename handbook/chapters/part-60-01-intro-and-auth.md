# Part 60 — Practical Projects: From Auth Service to Microservices Platform

## 60.0 How to use these projects

Reading about backpressure, saga compensation and `FOR UPDATE SKIP LOCKED` does not make you senior. Shipping something that keeps working at 3 a.m. does. This part gives you six projects that, built in order, take you from a single well-made service to a distributed platform you actually have to operate. Each one is a real system, not a tutorial: it has numbers, a schema, failure modes and a definition of done.

**Build them in order.** This is not a menu. Project 1 (authentication) teaches token state, expiry, replay and rate limiting — which Project 2 assumes when it puts a cart behind a logged-in user. Project 2 teaches the modular monolith, the outbox and inventory reservations — which Project 4 assumes when it runs a saga across those modules. Project 4 teaches idempotency keys, ledgers and webhooks — which Project 6 assumes when it splits them across the network. Project 5 (your own job processor) teaches you what BullMQ and Kafka are doing for you, so that in Project 6 you can argue about them instead of trusting them. If you skip ahead, you will build the microservices platform on top of concepts you never internalised, and you will produce exactly the thing this book keeps warning you about: distribution without competence.

**The definition of done matters more than the feature list.** Every project ends with a `### Definition of done` checklist. That checklist is the assignment. The feature list is only the excuse to build something worth operating. A cart that works but has no metric for "reservation expired without an order" is not done. A payment flow that works but cannot survive a duplicated webhook is not done. Nobody in an interview will ask whether you implemented wishlists. Several will ask what happens when the payment provider sends the same `charge.succeeded` twice, or what your p99 was and how you knew.

**Review your own work with the questions from Part 57.** When you think a project is finished, wait two days, then read your own pull request as if a stranger wrote it, using the review questions from Part 57. Ask them out loud: where is the transaction boundary, what happens on retry, what is unbounded, which index serves this query, what is the blast radius if this throws. You will find things. Write the findings down before you fix them — the list of what you missed is a better map of your weaknesses than any course syllabus.

**Keep an incident diary.** One markdown file per project, appended to every time something surprises you. Format: what you saw, what you thought it was, what it actually was, how you found out, what you changed. "Login latency jumped to 900 ms after I raised argon2 memory to 64 MiB; the container had a 512 MiB limit and four workers, so it OOMKilled under load; dropped to 19 MiB per OWASP and pinned parallelism to 1." Six months of that file is more valuable than six months of tutorials, and it is what you will actually talk about in senior interviews, because it is evidence rather than vocabulary.

**Deploy each one somewhere real.** Not `docker compose up` on your laptop — somewhere with a public hostname, TLS, a real domain, a health check, a rollout and a rollback. A three-node k3s cluster on the cheapest VMs you can rent, or a managed Kubernetes cluster you tear down at night, or even a single VM with Docker Compose behind Caddy for the first two projects. The point is that you meet certificate expiry, DNS propagation, image pull failures, a readiness probe you got wrong, and the moment when a migration locks a table on a machine you cannot attach a debugger to. Local development hides every operational lesson.

**Suggested time, working evenings.** Assume six to eight hours a week.

| Project | Evenings | Calendar time | The bar |
|---|---|---|---|
| 1. Authentication | 12 to 16 | 3 to 4 weeks | Refresh rotation with reuse detection provably works |
| 2. E-commerce backend | 20 to 28 | 6 to 8 weeks | Keyset pagination and inventory reservations under concurrency |
| 3. Notification system | 14 to 20 | 4 to 5 weeks | A poisoned message lands in the DLQ and you replay it |
| 4. Payment and orders | 20 to 28 | 6 to 8 weeks | The ledger balances after a partial refund and a duplicate webhook |
| 5. Job processing | 16 to 24 | 5 to 6 weeks | A worker is killed mid-job and another takes over the lease |
| 6. Microservices platform | 30 to 40 | 8 to 12 weeks | One trace spans six services and you can explain every span |

That is roughly nine months of evenings. Do not rush it, and do not build all six half-way. One finished project with a real definition of done beats six repositories with a README and a `TODO`.

## 60.1 Project 1 — Production-grade authentication system

### 60.1.1 Goal and what you will learn

You will build an authentication service that a real product could sit on: registration, login, short-lived access tokens, rotating refresh tokens with reuse detection, device and session management, email verification, password reset, TOTP multi-factor, role-based access control, rate limiting, brute-force lockouts, an audit log, "Login with Google" over OIDC, and JWKS key rotation.

Authentication is the ideal first project because the feature list is small and the engineering is not. Every hard backend theme shows up in a system you can hold in your head:

- **Cryptography you must not invent.** Argon2id parameters, constant-time comparison, hashing tokens at rest.
- **State with a lifetime.** Access tokens expire, refresh tokens rotate, email tokens are single-use, sessions end. Anything with a lifetime has a race at the boundary.
- **Replay and idempotency.** What happens when the same refresh token arrives twice, from two tabs, 40 ms apart on a flaky mobile network? That is not a hypothetical; it is the single most common bug in home-made auth.
- **Stateless versus stateful tradeoffs.** Access tokens are verified without a database hit, which is why revocation is hard, which is why the denylist exists, which is why TTLs are short.
- **Rate limiting and abuse.** Credential stuffing is real traffic, not a thought experiment.
- **Third-party dependency.** Google can be slow or down. Your login must degrade, not die.
- **Key rotation.** Signing keys must roll without logging anyone out. Doing that once teaches you more about deployment ordering than any blog post.

By the end you should be able to draw the refresh rotation flow from memory, explain why the refresh token is hashed in the database, and say precisely what happens to the other five devices when one device's token is stolen.

### 60.1.2 Requirements

**Functional**

1. Register with email and password; password is checked against a minimum length of 12 and a breached-password list; account starts `pending_verification`.
2. Verify email with a single-use token valid for 24 hours.
3. Log in with email and password; if MFA is enabled, return an MFA challenge instead of tokens.
4. Issue an access token (JWT, 10 minutes) and a refresh token (opaque, 30 days) bound to a session.
5. Rotate the refresh token on every use; detect reuse of an already-rotated token and revoke the entire token family.
6. List active sessions with device, IP country, created and last-seen timestamps; revoke one session or all sessions ("logout everywhere").
7. Request a password reset; a single-use token valid for 30 minutes; changing the password revokes every session.
8. Enrol TOTP with a QR payload and 10 single-use recovery codes; require a TOTP code at login when enabled.
9. RBAC: roles with permissions, a `@Roles` decorator and a guard; `admin` can list users and force-logout.
10. Rate limit by IP and by account; lock an account after repeated failures with exponential backoff.
11. Write an append-only audit event for every security-relevant action.
12. "Login with Google" via OIDC authorization code with PKCE; link to an existing account when the email matches and is verified.
13. Publish JWKS at `/.well-known/jwks.json` with at least two keys during rotation.

**Non-functional (the numbers you design against)**

| Property | Target | Why it drives design |
|---|---|---|
| Login p99 | under 350 ms | Argon2id at OWASP settings costs about 100 to 150 ms of CPU; that budget forbids extra sequential queries |
| Token verification p99 | under 3 ms, no database call | The other services verify JWTs locally against cached JWKS |
| Refresh p99 | under 60 ms | One transaction, two indexed statements |
| Peak load | 500 logins/s, 2,000 refreshes/s, 20,000 verifications/s | Verification must never touch this service; refresh must not lock hot rows |
| Availability | 99.95 percent for verification-adjacent endpoints, 99.9 percent for login | If login is down, nothing new starts; if JWKS is down, everything breaks |
| Argon2id | `m=19456` KiB, `t=2`, `p=1` | OWASP minimum; fits a 512 MiB container with 4 workers |
| Access token TTL | 600 s | Bounds the damage from a stolen token to 10 minutes |
| Refresh token TTL | 30 days absolute, 14 days idle | Balance between security and users hating you |
| Rate limits | 10 login attempts per 5 min per IP+email; 100 per hour per IP | Slows credential stuffing without breaking offices behind one NAT |
| Lockout | 10 consecutive failures locks 15 min, doubling to 24 h | Attackers get expensive; real users get a reset link |
| Audit retention | 400 days, partitioned monthly | Compliance asks for a year; partitions make deletion free |

### 60.1.3 Architecture

```mermaid
flowchart TB
  client["Web and mobile clients"] --> edge["Load balancer and TLS"]
  edge --> api["Auth API - NestJS"]
  api --> pg[("PostgreSQL - primary")]
  api --> redis[("Redis - limits, lockouts, denylist")]
  api --> google["Google OIDC provider"]
  api --> outbox["Outbox table in PostgreSQL"]
  outbox --> relay["Outbox relay worker"]
  relay --> broker["Kafka topic auth.events"]
  broker --> mailer["Email worker"]
  mailer --> smtp["Email provider"]
  other["Other services"] --> jwks["GET /.well-known/jwks.json"]
  jwks --> api
```

Five things in that picture are deliberate.

**The access token never comes back to this service.** Other services fetch JWKS once, cache it for five minutes, and verify signatures locally. That is why 20,000 verifications per second do not appear in the auth service's load. The cost is revocation latency: a revoked token stays valid until it expires, which is why the TTL is 10 minutes and why a denylist exists for the rare "revoke now" case.

**Refresh tokens are opaque and stateful.** They are random 32-byte values, stored hashed, and every use rotates them inside one transaction. Stateless refresh tokens cannot be revoked, and revocation is the whole point of having them.

**Email is not sent inside the request.** Registration writes the user and an outbox row in the same transaction, and a relay publishes to Kafka. If the email provider is down, registration still succeeds. If we sent the email inline, a provider timeout would either roll back a created user or leave a user with no email — both are bugs you will meet in production.

**Redis holds only data we can lose.** Rate-limit counters, lockout counters, and the short-lived denylist. If Redis is empty after a restart, the worst outcome is that an attacker gets a few extra attempts. Nothing that must survive lives there.

**Google is on the critical path only for one endpoint.** The OIDC callback has a 3-second timeout and a circuit breaker; password login is unaffected when Google is slow.

### 60.1.4 Database schema

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('pending_verification', 'active', 'locked', 'disabled');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL,
  email_verified_at timestamptz,
  status         user_status NOT NULL DEFAULT 'pending_verification',
  display_name   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_shape CHECK (position('@' in email) > 1)
);

-- Credentials are separate from users: a user may have a password, a Google
-- identity, both, or neither. One row per credential type per user.
CREATE TABLE credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,              -- 'password' | 'google'
  subject       text,                        -- provider subject id, null for password
  password_hash text,                        -- argon2id encoded string, null for oidc
  password_changed_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_user_provider_unique UNIQUE (user_id, provider),
  CONSTRAINT credentials_provider_subject_unique UNIQUE (provider, subject),
  CONSTRAINT credentials_shape CHECK (
    (provider = 'password' AND password_hash IS NOT NULL AND subject IS NULL)
    OR (provider <> 'password' AND subject IS NOT NULL AND password_hash IS NULL)
  )
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_label  text,
  user_agent    text,
  ip_country    char(2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_active_idx ON sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  family_id     uuid NOT NULL,              -- all descendants of one login
  token_hash    bytea NOT NULL,             -- sha256 of the opaque token
  parent_id     uuid REFERENCES refresh_tokens(id),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,                -- set when rotated
  revoked_at    timestamptz,
  CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_live_idx ON refresh_tokens (session_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE mfa_secrets (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc    bytea NOT NULL,             -- AES-GCM ciphertext of the TOTP secret
  secret_nonce  bytea NOT NULL,
  confirmed_at  timestamptz,
  recovery_hashes text[] NOT NULL DEFAULT '{}',  -- sha256 hex of unused codes
  last_used_step bigint,                    -- replay guard: last accepted 30 s step
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE email_token_kind AS ENUM ('verify_email', 'reset_password');

CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        email_token_kind NOT NULL,
  token_hash  bytea NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_tokens_hash_unique UNIQUE (token_hash)
);
-- One live token per user per kind: re-requesting invalidates the old one.
CREATE UNIQUE INDEX email_tokens_one_live_idx ON email_tokens (user_id, kind)
  WHERE consumed_at IS NULL;

CREATE TABLE roles (
  id          smallint PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  permissions text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     smallint NOT NULL REFERENCES roles(id),
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE audit_events (
  id          bigserial,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  actor_id    uuid,
  action      text NOT NULL,        -- 'login.success', 'token.reuse_detected', ...
  ip_hash     bytea,                -- HMAC of IP, never the raw IP
  user_agent  text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_events_2026_09 PARTITION OF audit_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE INDEX audit_events_2026_09_user_idx
  ON audit_events_2026_09 (user_id, occurred_at DESC);
```

```mermaid
erDiagram
  USERS ||--o{ CREDENTIALS : has
  USERS ||--o{ SESSIONS : owns
  USERS ||--o| MFA_SECRETS : enrols
  USERS ||--o{ EMAIL_TOKENS : receives
  USERS ||--o{ USER_ROLES : assigned
  ROLES ||--o{ USER_ROLES : grants
  SESSIONS ||--o{ REFRESH_TOKENS : issues
  REFRESH_TOKENS ||--o| REFRESH_TOKENS : rotates_into
  USERS {
    uuid id PK
    citext email
    user_status status
    timestamptz email_verified_at
  }
  REFRESH_TOKENS {
    uuid id PK
    uuid session_id FK
    uuid family_id
    bytea token_hash
    timestamptz used_at
  }
```

### 60.1.5 APIs

| Method | Path | Auth | Request | Success | Errors | Idempotent |
|---|---|---|---|---|---|---|
| POST | `/auth/register` | none | `{email,password,displayName}` | `201 {userId}` | 409 email taken, 422 weak password, 429 | No; duplicate email returns 409 |
| POST | `/auth/verify-email` | none | `{token}` | `204` | 400 invalid, 410 expired/consumed | Yes; second call returns 410 |
| POST | `/auth/login` | none | `{email,password,deviceLabel}` | `200 {accessToken,refreshToken,expiresIn}` or `200 {mfaRequired:true,challengeId}` | 401 bad credentials, 423 locked, 429 | No |
| POST | `/auth/mfa/verify` | challenge | `{challengeId,code}` | `200 {accessToken,refreshToken}` | 401 bad code, 410 challenge expired | No; code is single-use per step |
| POST | `/auth/refresh` | refresh token | `{refreshToken}` | `200 {accessToken,refreshToken}` | 401 unknown/expired, 401 + family revoked on reuse | No; rotation is by design single-use |
| POST | `/auth/logout` | access token | `{}` | `204` | 401 | Yes |
| POST | `/auth/logout-all` | access token | `{}` | `204` | 401 | Yes |
| GET | `/auth/sessions` | access token | — | `200 [{id,device,lastSeenAt,current}]` | 401 | Yes |
| DELETE | `/auth/sessions/:id` | access token | — | `204` | 401, 404 | Yes |
| POST | `/auth/password/forgot` | none | `{email}` | `202` always | 429 | Yes; always 202 to avoid user enumeration |
| POST | `/auth/password/reset` | none | `{token,newPassword}` | `204` | 400, 410 expired, 422 weak | Yes; second use returns 410 |
| POST | `/auth/mfa/enrol` | access token | `{}` | `200 {otpauthUri,recoveryCodes}` | 401, 409 already enrolled | No |
| POST | `/auth/mfa/confirm` | access token | `{code}` | `204` | 401 bad code | Yes |
| DELETE | `/auth/mfa` | access + password | `{password}` | `204` | 401 | Yes |
| GET | `/auth/oidc/google/start` | none | `?redirect=` | `302` to Google | 400 bad redirect | Yes |
| GET | `/auth/oidc/google/callback` | none | `?code&state` | `302` to app with tokens | 400 state mismatch, 502 provider down | No; `code` is single-use at Google |
| GET | `/auth/me` | access token | — | `200 {id,email,roles,permissions}` | 401 | Yes |
| GET | `/admin/users` | access + `admin` | `?cursor&limit` | `200 {items,nextCursor}` | 401, 403 | Yes |
| POST | `/admin/users/:id/force-logout` | access + `admin` | `{}` | `204` | 401, 403, 404 | Yes |
| GET | `/.well-known/jwks.json` | none | — | `200 {keys:[...]}` | — | Yes; cached 300 s |

Two rules run through that table. Everything that a client can retry after a network timeout is either idempotent or returns a specific, non-scary error on the second attempt. And `POST /auth/password/forgot` always returns `202`, whether or not the email exists, because anything else is a user-enumeration oracle.

### 60.1.6 NestJS modules

```text
src/
  main.ts
  app.module.ts
  common/
    guards/jwt-auth.guard.ts
    guards/roles.guard.ts
    decorators/roles.decorator.ts
    decorators/current-user.decorator.ts
    filters/http-exception.filter.ts
  auth/
    auth.module.ts
    auth.controller.ts
    auth.service.ts
    password.service.ts
    refresh-token.service.ts
    session.service.ts
    dto/
  tokens/
    tokens.module.ts
    jwt-key.service.ts        # signing keys + JWKS
    access-token.service.ts
  mfa/  mfa.module.ts  totp.service.ts
  oidc/ oidc.module.ts  google.provider.ts
  rbac/ rbac.module.ts  roles.service.ts
  audit/ audit.module.ts  audit.service.ts
  outbox/ outbox.module.ts  outbox.relay.ts
  users/ users.module.ts  users.service.ts  entities/
```

```text
AppModule
 ├─ ConfigModule.forRoot({ isGlobal: true, validate })
 ├─ TypeOrmModule.forRootAsync
 ├─ ThrottlerModule.forRootAsync  (ThrottlerStorageRedisService)
 ├─ TokensModule   -> JwtKeyService, AccessTokenService
 ├─ UsersModule
 ├─ AuthModule     -> AuthService, PasswordService, RefreshTokenService, SessionService
 ├─ MfaModule, OidcModule, RbacModule, AuditModule
 └─ OutboxModule   -> OutboxRelay (@Interval)
```

The four files that carry the real engineering.

**`password.service.ts`** — the only place argon2 is called, so parameters live in one place and can be re-tuned centrally.

```ts
import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { timingSafeEqual, createHash } from 'node:crypto';

const ARGON: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // KiB -> 19 MiB, OWASP minimum
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  private readonly log = new Logger(PasswordService.name);

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON);
  }

  /** Always does the same amount of work whether or not the user exists. */
  async verify(hash: string | null, plain: string): Promise<boolean> {
    if (!hash) {
      // Dummy verify so a missing account costs the same time as a wrong password.
      await argon2.verify(await this.dummyHash(), 'not-the-password').catch(() => false);
      return false;
    }
    const ok = await argon2.verify(hash, plain);
    if (ok && argon2.needsRehash(hash, ARGON)) {
      this.log.log('password hash below current parameters, rehash on next write');
    }
    return ok;
  }

  private dummyHashCache?: string;
  private async dummyHash(): Promise<string> {
    this.dummyHashCache ??= await argon2.hash('dummy-password-for-timing', ARGON);
    return this.dummyHashCache;
  }

  sha256(value: string): Buffer {
    return createHash('sha256').update(value).digest();
  }

  constantTimeEquals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
```

**`refresh-token.service.ts`** — rotation and reuse detection. This is the heart of the project.

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { PasswordService } from '../auth/password.service';
import { AuditService } from '../audit/audit.service';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly ds: DataSource,
    private readonly hasher: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async rotate(presented: string, ctx: { ip: string; ua: string }) {
    const hash = this.hasher.sha256(presented);

    return this.ds.transaction('READ COMMITTED', async (em) => {
      // Lock the presented row so two concurrent refreshes serialise here.
      const [row] = await em.query(
        `SELECT id, session_id, family_id, used_at, revoked_at, expires_at
           FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [hash],
      );
      if (!row) throw new UnauthorizedException('invalid_refresh_token');

      if (row.used_at || row.revoked_at) {
        // Reuse detected: this token was already rotated or revoked.
        await em.query(
          `UPDATE refresh_tokens SET revoked_at = now()
             WHERE family_id = $1 AND revoked_at IS NULL`,
          [row.family_id],
        );
        await em.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'token_reuse'
             WHERE id = $1 AND revoked_at IS NULL`,
          [row.session_id],
        );
        await this.audit.write(em, 'token.reuse_detected', {
          sessionId: row.session_id, familyId: row.family_id, ...ctx,
        });
        throw new UnauthorizedException('token_reuse_detected');
      }

      if (new Date(row.expires_at) <= new Date()) {
        throw new UnauthorizedException('refresh_token_expired');
      }

      const next = randomBytes(32).toString('base64url');
      const [child] = await em.query(
        `INSERT INTO refresh_tokens
           (session_id, family_id, token_hash, parent_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days') RETURNING id`,
        [row.session_id, row.family_id, this.hasher.sha256(next), row.id],
      );
      await em.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      await em.query(
        `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id],
      );
      return { refreshToken: next, sessionId: row.session_id, tokenId: child.id };
    });
  }
}
```

This is the flow that file implements, including the stolen-token case:

```mermaid
sequenceDiagram
  participant App as Client
  participant API as AuthAPI
  participant DB as Postgres
  App->>API: POST /auth/refresh RT1
  API->>DB: SELECT FOR UPDATE where hash = H1
  DB-->>API: row used_at = null
  API->>DB: INSERT RT2 child, UPDATE RT1 used_at
  API-->>App: 200 access + RT2
  Note over App,API: attacker replays the stolen RT1
  App->>API: POST /auth/refresh RT1
  API->>DB: SELECT FOR UPDATE where hash = H1
  DB-->>API: row used_at set
  API->>DB: revoke family, revoke session, audit
  API-->>App: 401 token_reuse_detected
```

**`roles.decorator.ts` and `roles.guard.ts`** — RBAC that reads permissions from the token, not the database.

```ts
// roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

// roles.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const req = ctx.switchToHttp().getRequest();
    const roles: string[] = req.user?.roles ?? [];
    if (!roles.some((r) => required.includes(r))) {
      throw new ForbiddenException({ code: 'insufficient_role', required });
    }
    return true;
  }
}
```

**`jwt-key.service.ts`** — key rotation and JWKS.

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { generateKeyPair, exportJWK, SignJWT, importPKCS8, JWK } from 'jose';
import { DataSource } from 'typeorm';

/** Keys live in signing_keys(kid, public_jwk, private_pem_enc, not_before, retire_at). */
@Injectable()
export class JwtKeyService implements OnModuleInit {
  private active!: { kid: string; key: CryptoKey };
  private jwks: JWK[] = [];

  constructor(private readonly ds: DataSource) {}

  async onModuleInit() { await this.reload(); }

  /** Called on boot and every 60 s by a scheduled task. */
  async reload() {
    const rows = await this.ds.query(
      `SELECT kid, public_jwk, private_pem_enc FROM signing_keys
        WHERE retire_at > now() ORDER BY not_before DESC`,
    );
    this.jwks = rows.map((r: any) => ({ ...r.public_jwk, kid: r.kid, use: 'sig', alg: 'EdDSA' }));
    const current = rows.find((r: any) => new Date(r.not_before) <= new Date());
    this.active = { kid: current.kid, key: await importPKCS8(decrypt(current.private_pem_enc), 'EdDSA') };
  }

  publicJwks() { return { keys: this.jwks }; }

  async sign(claims: Record<string, unknown>, ttlSeconds: number) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: this.active.kid })
      .setIssuedAt().setIssuer('https://auth.example.com')
      .setExpirationTime(`${ttlSeconds}s`).setJti(crypto.randomUUID())
      .sign(this.active.key);
  }
}
```

Rotation is a three-step deployment: insert the new key with `not_before = now() + 10 minutes` (it appears in JWKS immediately, so verifiers cache it before it is used), let it become active, then set `retire_at` on the old key once no token signed with it can still be alive. Get this wrong in the other order and every service rejects every token for five minutes.

### 60.1.7 PostgreSQL design decisions

**Transactions.** Refresh rotation is one `READ COMMITTED` transaction with `SELECT ... FOR UPDATE` on the presented token row. Two tabs refreshing simultaneously serialise on that row: the first rotates, the second blocks, then sees `used_at IS NOT NULL` and triggers reuse detection. That is correct behaviour, and it is also the classic false positive — mitigate it with a 10-second grace window if you want (return the same child token when `used_at` is younger than 10 s and the parent's child has not itself been used), but only after you have measured how often it happens.

**Locks.** Nothing else takes a row lock. Login only reads. `logout-all` updates many rows but always in a single statement ordered by primary key, which avoids deadlocks with the rotation path.

**Indexes, each justified by a query.**

- `users_email_unique` on `citext` — login lookup and duplicate-registration protection in one object. `citext` means `Alice@x.com` and `alice@x.com` are the same account, which is what users expect.
- `refresh_tokens_hash_unique` — the refresh lookup is `WHERE token_hash = $1`, so the unique constraint is also the access path.
- `refresh_tokens_family_idx` — the reuse-detection `UPDATE ... WHERE family_id = $1`.
- `sessions_active_idx` partial index on `revoked_at IS NULL` — the sessions list. Revoked sessions are the majority after a year; excluding them keeps the index small.
- `email_tokens_one_live_idx` — a *unique* partial index that enforces "one live token per user per kind" in the database rather than in application code. Requesting a second reset link must first consume or delete the first; the constraint makes forgetting that impossible.

**Partitioning.** `audit_events` is range-partitioned by month. At 500 logins/s peak and roughly 8 million security events a day, a year is 3 billion rows; deleting old data with `DELETE` would be an all-night vacuum problem, while `DROP TABLE audit_events_2025_08` is instant. Create next month's partition with a scheduled job that runs on the 25th, and alert if the next partition does not exist — a missing partition turns every write into an error.

**Migrations.** Every migration is expand-contract and reversible. Adding `mfa_secrets.last_used_step` is `ALTER TABLE ... ADD COLUMN ... NULL` (instant, no rewrite). Adding an index on a live table is `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction, so it lives in its own migration file with `transaction: false`. Set `lock_timeout = '3s'` and `statement_timeout = '30s'` in the migration session so a blocked DDL fails fast instead of queueing every query behind it.

### 60.1.8 Redis usage

| Key | Structure | TTL | Purpose | Invalidation |
|---|---|---|---|---|
| `rl:login:ip:{ipHash}` | counter via throttler | 300 s | 100 attempts/hour per IP | expiry only |
| `rl:login:acct:{userId}` | counter | 300 s | 10 attempts/5 min per account | deleted on successful login |
| `lockout:{userId}` | string `{failures,until}` | until + 60 s | Exponential lockout | deleted on successful login or password reset |
| `denylist:jti:{jti}` | string `1` | remaining access-token life, max 600 s | Immediate revocation of one token | expiry only |
| `denylist:user:{userId}` | string epoch ms | 600 s | "Logout everywhere" invalidates tokens issued before this instant | expiry only |
| `mfa:challenge:{id}` | hash `{userId,attempts}` | 300 s | Between password step and TOTP step | deleted on success |
| `mfa:step:{userId}:{step}` | string `1` | 90 s | TOTP replay guard within a 30 s window | expiry only |
| `oidc:state:{state}` | hash `{nonce,verifier,redirect}` | 600 s | PKCE and CSRF state for Google | deleted in the callback |
| `jwks:cache` (client side) | string JSON | 300 s | Other services cache the key set | refresh on unknown `kid` |
| `lock:keyrotate` | `SET NX PX 30000` | 30 s | Only one instance rotates signing keys | released after work |

The denylist deserves a note. A JWT cannot be un-issued, so the guard checks two cheap Redis keys per request only for endpoints marked sensitive, not for every request; otherwise you have reinvented session lookups and thrown away the reason you chose JWTs. For most endpoints, a 10-minute window of stale authority is the accepted tradeoff, and you should be able to say that sentence out loud to a security reviewer.

### 60.1.9 Messaging usage

One Kafka topic, `auth.events`, 6 partitions, keyed by `user_id` so all events for one user stay ordered. Events are `user.registered`, `user.email_verified`, `user.password_reset_requested`, `user.password_changed`, `user.mfa_enabled`, `session.revoked_all`, `security.token_reuse_detected`.

Producing goes through the **outbox**: the same transaction that inserts the user inserts a row into `outbox(id, aggregate_id, type, payload, created_at, published_at)`. A relay polls `WHERE published_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`, publishes, and marks published. This gives at-least-once delivery with no possibility of "email sent for a user that does not exist" or "user created but no welcome email".

Consumers (the email worker, the analytics sink) are in consumer group `auth-email` and `auth-analytics`. Each keeps an **inbox** table with `PRIMARY KEY (consumer, event_id)`; the handler inserts into the inbox and does its work in one transaction, so a redelivery after a crash hits a duplicate-key violation and is skipped. Retries are three immediate attempts with 1 s, 4 s, 16 s backoff plus jitter; after that the message goes to `auth.events.dlq` with headers carrying the original topic, partition, offset and the error. A small admin command republishes DLQ messages after the bug is fixed.

Send email via the worker, never the request. The worker rate-limits itself to the provider's quota with a Redis token bucket and treats a `429` from the provider as retryable, a `400` as permanent (straight to DLQ).

### 60.1.10 Testing strategy

Unit tests cover pure logic with no I/O: TOTP step calculation across a clock skew of plus or minus one step, password policy, lockout backoff arithmetic, JWT claim building. Integration tests run against real PostgreSQL and Redis via Testcontainers — never mocks, because every interesting bug in this project is a database bug. End-to-end tests drive the HTTP surface with Supertest against a fully booted Nest application.

The ten test cases that matter most:

1. **Refresh rotation happy path** — refresh returns a new token; the old hash is marked `used_at`; the new token works once.
2. **Reuse detection** — refresh twice with the same token; the second returns 401, every token in the family is revoked, the session is revoked, and an audit event exists.
3. **Concurrent refresh from two tabs** — fire two refreshes in parallel with `Promise.allSettled`; exactly one succeeds, the family state is consistent, no deadlock.
4. **Password change revokes everything** — log in on three devices, reset the password, all three refresh tokens are rejected.
5. **Email token single use** — verify twice; the second returns 410 and `consumed_at` is unchanged.
6. **Login timing does not leak existence** — 200 logins for a nonexistent user and 200 for a wrong password; the p50 difference is under 15 ms.
7. **Lockout** — 10 wrong passwords lock the account for 15 minutes; the correct password during lockout still returns 423; the lockout clears after the window.
8. **TOTP replay** — the same valid code twice within one 30 s step; the second is rejected.
9. **JWKS rotation** — sign with key A, rotate, verify the old token still validates while A is in JWKS, and fails after A is retired.
10. **Outbox at-least-once** — kill the relay after publish but before `published_at` is set; on restart the event is republished and the consumer's inbox dedupes it.

Add one load test: 500 logins/s for five minutes with k6, asserting p99 under 350 ms and zero 5xx. Argon2 is CPU-bound, so this test is really a capacity-planning tool — it tells you how many pods a login peak needs.

### 60.1.11 Docker

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: auth }
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d auth"]
      interval: 5s
      retries: 10
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "no"]
    ports: ["6379:6379"]
  redpanda:
    image: redpandadata/redpanda:latest
    command: ["redpanda","start","--overprovisioned","--smp","1","--memory","512M",
              "--kafka-addr","PLAINTEXT://0.0.0.0:9092",
              "--advertise-kafka-addr","PLAINTEXT://redpanda:9092"]
    ports: ["9092:9092"]
  mailhog:
    image: mailhog/mailhog
    ports: ["8025:8025"]
  api:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:dev@postgres:5432/auth
      REDIS_URL: redis://redis:6379
      KAFKA_BROKERS: redpanda:9092
      SMTP_URL: smtp://mailhog:1025
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_started }
    ports: ["3000:3000"]
```

Redpanda instead of a Kafka plus ZooKeeper pair keeps local startup under 10 seconds and speaks the same protocol. MailHog gives you a web inbox at `localhost:8025`, so you can click the verification link you just generated — which is also how you find out that you built the link with the wrong base URL.

### 60.1.12 CI/CD

```yaml
name: auth-service
on: { push: { branches: [main] }, pull_request: {} }

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: dev, POSTGRES_DB: auth_test }
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10
        ports: ["5432:5432"]
      redis:
        image: redis:7
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint && npx tsc --noEmit
      - run: npm run migration:run
      - run: npm run test:unit -- --coverage
      - run: npm run test:integration
      - run: npm run test:e2e

  build:
    needs: verify
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v6
        with: { push: true, tags: "ghcr.io/${{ github.repository }}:${{ github.sha }}" }
      - uses: aquasecurity/trivy-action@master
        with: { image-ref: "ghcr.io/${{ github.repository }}:${{ github.sha }}", exit-code: "1", severity: "CRITICAL,HIGH" }

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: kubectl apply -f k8s/ && kubectl set image deploy/auth api=ghcr.io/${{ github.repository }}:${{ github.sha }}
      - run: kubectl wait --for=condition=complete job/auth-migrate --timeout=300s
      - run: kubectl rollout status deploy/auth --timeout=300s
      - run: ./scripts/smoke.sh https://auth.example.com
```

Migrations run as a Kubernetes `Job` before the rollout, not in the container's entrypoint — otherwise ten replicas race to run the same migration. The smoke script registers a throwaway user, logs in, refreshes, and checks that JWKS contains at least one key; if any step fails, the pipeline runs `kubectl rollout undo`.

### 60.1.13 Observability

**Metrics** (Prometheus, exposed at `/metrics`): `auth_login_total{result="success|bad_password|locked|mfa_required"}`, `auth_login_duration_seconds` histogram, `auth_argon2_duration_seconds`, `auth_refresh_total{result}`, `auth_token_reuse_detected_total` (the one that pages you), `auth_active_sessions`, `auth_email_send_total{provider,result}`, `auth_outbox_lag_seconds` (age of the oldest unpublished row), `auth_jwks_keys` gauge, plus the standard Node.js event-loop lag and pool metrics.

**Log fields** on every line: `timestamp, level, service, version, traceId, spanId, requestId, userId (or null), sessionId, route, statusCode, durationMs, outcome`. Never log passwords, tokens, token hashes, TOTP secrets, recovery codes, or raw IP addresses — log an HMAC of the IP with a rotating key if you need to correlate abuse.

**Traces**: instrument with OpenTelemetry so a login is one trace with spans for `argon2.verify`, `pg.select users`, `pg.insert session`, `redis.get lockout`, `jwt.sign`. The first time you look at that waterfall you will discover a sequential query you did not need.

**Dashboards**: one operational panel row (RPS, error rate, p50/p95/p99 per endpoint, pod CPU, pool saturation) and one security row (failed logins per minute, distinct accounts per source IP, lockouts, reuse detections, password resets per hour).

**Alerts**: `auth_token_reuse_detected_total` increase over 5 in 10 minutes (page); login error rate above 20 percent for 5 minutes (page); `auth_outbox_lag_seconds > 300` (ticket); JWKS endpoint 5xx (page); database connection pool saturation above 90 percent for 3 minutes (page); certificate expiry under 14 days (ticket).

### 60.1.14 Failure scenarios

| Failure | Expected behaviour | How you test it |
|---|---|---|
| Redis down | Rate limiting fails open with a warning metric; lockouts fall back to a database counter; login still works | `docker compose stop redis`, run the login e2e suite |
| PostgreSQL primary failover | 5 to 30 s of 503s, pool reconnects, no duplicate sessions created | Kill the primary container; assert recovery under 60 s |
| Google OIDC times out | `/auth/oidc/google/callback` returns 502 in under 3 s; circuit opens after 5 failures; password login unaffected | Point the provider at a black-hole port with a toxiproxy latency rule |
| Email provider returns 500 | Job retries with backoff, then DLQ; user sees "check your inbox"; ops sees `auth_email_send_total{result="dlq"}` rise | Stub provider returning 500 in the integration test |
| Two devices refresh with the same token | One succeeds, one gets 401 and the family is revoked; audit event written | Parallel refresh test (case 3) |
| Clock skew of 90 s on a client | TOTP accepts plus or minus one step only; the third step is rejected | Fake timers at step-2 offsets |
| Signing key retired too early | Every token rejected; runbook says re-add the key to JWKS | Chaos drill in staging: retire a key and time the recovery |
| Container OOMKilled during a login spike | Kubernetes restarts the pod; in-flight requests get 502 at the ingress; no data loss | Set the memory limit to 256 MiB and run the load test |
| Migration blocked by a long query | Migration fails within `lock_timeout` of 3 s; deploy aborts; no table locked | Open `SELECT pg_sleep(60)` on the table, then run the migration |
| Credential-stuffing burst, 50k attempts/min | 429s from the IP limiter, accounts lock, error budget intact, alert fires | k6 script with 5,000 email/password pairs |

### 60.1.15 Scaling strategy

**1x — 10k users, 20 logins/min.** One Nest pod (2 vCPU), one PostgreSQL instance (2 vCPU, 8 GiB), one Redis. Argon2 at 19 MiB costs roughly 120 ms of one core, so a single pod handles about 15 logins/s. Everything else is noise.

**10x — 500k users, 200 logins/s peak.** Three to five pods behind the load balancer, sized by argon2 CPU, not by memory. Add a read replica for `/admin/users` and analytics queries only — never for login, because a replica lag of 200 ms makes a just-registered user "not exist". Move audit writes off the request path into the outbox consumer. Pool size per pod stays at 10 to 15 connections; add PgBouncer in transaction mode once total connections approach 200.

**100x — 5M users, 2,000 logins/s peak.** Now argon2 dominates: 2,000 logins/s at 120 ms of CPU each is 240 cores. Options, in the order a senior engineer considers them: (a) accept it and run 60 pods of 4 vCPU, which is about the cost of two engineers per year; (b) shift the peak by making sessions longer so logins are rarer; (c) put login behind a queue for the tail of a spike, which is honest backpressure, not a fix. Refresh at 8,000/s is a different problem: it is one row lock and two writes, so shard `refresh_tokens` by `family_id` or move it to its own database. JWKS goes behind a CDN with a 300 s TTL and becomes free. Audit events at 100 million a day go to Kafka and a columnar store, not to PostgreSQL.

The lesson that transfers: in authentication, the read path scales trivially because it never touches you, and the write path scales badly because it is deliberately expensive. That is by design.

### 60.1.16 Security checklist

- [ ] Argon2id with `m=19456, t=2, p=1` minimum; parameters in config and reviewed yearly.
- [ ] Passwords checked against a breached-password corpus, minimum 12 characters, no composition rules.
- [ ] Refresh tokens are 256 bits of CSPRNG output, stored only as SHA-256 hashes.
- [ ] Refresh rotation with reuse detection and family revocation, proven by test.
- [ ] Access tokens 10 minutes, `EdDSA` or `RS256`, `kid` in the header, `iss` and `aud` validated by consumers.
- [ ] JWKS served over TLS with a 300 s cache; two keys present during rotation.
- [ ] Email tokens are single-use, hashed, expiring, and one-live-per-kind enforced by a unique index.
- [ ] TOTP secrets encrypted at rest with a KMS-held key; replay guarded by `last_used_step`.
- [ ] Recovery codes hashed and single-use.
- [ ] `POST /auth/password/forgot` always returns 202; login timing is constant regardless of account existence.
- [ ] Rate limits per IP and per account; exponential lockout; CAPTCHA hook available for the abuse path.
- [ ] Cookies, if used, are `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict` for the refresh cookie path).
- [ ] OIDC uses PKCE, validates `state`, `nonce`, `iss`, `aud`, and the ID token signature against Google's JWKS.
- [ ] Account linking only when the provider asserts `email_verified` and the local email is verified.
- [ ] Audit log append-only; the application role has no `UPDATE` or `DELETE` grant on `audit_events`.
- [ ] Secrets from environment or a secret manager; nothing in the image; `.env` in `.gitignore`.
- [ ] Dependency and image scanning in CI, blocking on HIGH and CRITICAL.
- [ ] Security headers, request size limits, and strict DTO validation with `forbidNonWhitelisted: true`.

### 60.1.17 Stretch goals

WebAuthn and passkeys as a second credential type (the schema already allows it — add a `webauthn_credentials` table and a provider row). Step-up authentication: require a fresh MFA check for high-risk actions, expressed as an `amr` claim and a `auth_time` check. Risk-based login using an IP reputation feed and a "new device" heuristic that triggers an email challenge. SCIM provisioning for enterprise customers. Multi-tenancy with a `tenant_id` on every table and row-level security policies. A device-binding token using DPoP so a stolen access token is useless on another machine. Finally, publish an OpenAPI document and generate a typed client, then write a contract test that fails the build when the schema changes incompatibly.

### 60.1.18 Definition of done

- [ ] All 13 functional requirements implemented and covered by e2e tests.
- [ ] Reuse detection demonstrated by an automated test and by a manual replay with `curl`.
- [ ] Concurrent-refresh test green with no deadlocks over 200 iterations.
- [ ] Migrations run forward and backward on a copy of production-shaped data; `CREATE INDEX CONCURRENTLY` used for live indexes.
- [ ] `audit_events` partitioned, with a scheduled job creating next month's partition and an alert if it is missing.
- [ ] Redis outage tested: login still works, documented in the runbook.
- [ ] Load test at 500 logins/s holds p99 under 350 ms with zero 5xx; the pod count needed is written down.
- [ ] Dashboards exist for the operational and security rows; all six alerts fire in a staging drill.
- [ ] Trivy scan clean of HIGH and CRITICAL; `npm audit` triaged.
- [ ] Deployed to a real cluster with TLS, health probes, a migration Job, and a tested rollback.
- [ ] Runbook written: what to do on reuse-detection spikes, key rotation, lockout floods, provider outage.
- [ ] Incident diary has at least five entries; you can explain each one in two minutes.
