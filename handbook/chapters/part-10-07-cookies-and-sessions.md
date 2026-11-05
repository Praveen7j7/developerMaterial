## 10.8 Cookies and sessions

#### Concept

HTTP is stateless: the server does not remember the previous request. A **cookie** is a small piece of data the server asks the browser to store (`Set-Cookie` response header) and the browser sends back on every later request to that site (`Cookie` request header). A **session** is server-side state associated with a client, usually looked up by an opaque **session id** carried in a cookie. The alternative, a **JWT** (JSON Web Token), puts signed claims into the token itself so the server needs no lookup; it can travel in a cookie or in an `Authorization: Bearer` header.

Cookie attributes control where and when the browser sends the cookie:

| Attribute | Effect | Production setting for a session cookie |
|---|---|---|
| `HttpOnly` | JavaScript cannot read it (`document.cookie`) | always on; blocks token theft via XSS |
| `Secure` | sent only over HTTPS | always on |
| `SameSite=Strict / Lax / None` | whether the cookie is sent on cross-site requests | `Lax` for most apps; `Strict` for admin; `None` (with `Secure`) only for cross-site embeds |
| `Domain` | which hosts receive it; omitting it means only the exact host | omit, or `.shop.com` only if subdomains genuinely need it |
| `Path` | URL prefix that receives it | `/` or `/api` |
| `Max-Age` / `Expires` | lifetime; absent means "session cookie", deleted when the browser closes | `Max-Age=86400` and a server-side idle timeout |
| `__Host-` prefix | requires `Secure`, no `Domain`, `Path=/` | `__Host-sid` for the strongest binding |

#### Why does it exist?

Without cookies, a user would log in on every request. Without `HttpOnly`, a single XSS bug hands every session to an attacker. Without `SameSite`, any website could make the user's browser submit a `POST /transfer` to your bank with the user's cookie attached (CSRF). Server-side sessions exist so that logout, revocation and "sign out of all devices" are instant; JWTs exist so that a fleet of services can verify identity without a shared lookup on every call.

#### Mental model

Imagine a gym. A **session** is the front desk's register: you show a numbered wristband (the cookie holding a session id) and the receptionist looks you up. Losing the wristband or the gym cutting it off ends access immediately. A **JWT** is a laminated pass with your name, membership level and expiry date, signed by the manager. Any door can check it without calling the desk, but if you are expelled the pass keeps working until it expires, unless every door also keeps a blocklist.

#### How it works

**Cookie flow.**

1. `POST /auth/login` validates credentials.
2. The server creates a session record in Redis: `sess:9f2c...` with `{ userId, roles, createdAt, ip, userAgent }` and a TTL.
3. The server responds with `Set-Cookie: __Host-sid=9f2c...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`.
4. The browser stores it and attaches `Cookie: __Host-sid=9f2c...` to every request to that host, including images and API calls made by page scripts.
5. A NestJS guard reads the cookie, fetches the session from Redis (about 0.3 ms), attaches the user to the request, and refreshes the TTL (sliding expiration).
6. Logout deletes the Redis key and sends `Set-Cookie: __Host-sid=; Max-Age=0`.

**SameSite mechanics.** `Strict` never sends the cookie on a request initiated from another site, so clicking a link from an email into your app arrives logged out. `Lax` sends it on top-level navigations with safe methods (`GET` from a link) but not on cross-site `POST`, iframes, or `fetch`; this blocks classic CSRF while keeping links working. `None` sends it everywhere and requires `Secure`; needed only when your API is embedded cross-site (a widget on a partner's page). Chrome defaults to `Lax` when the attribute is missing.

**Session store choices.**

| Store | Lookup latency | Revocation | Horizontal scaling | Notes |
|---|---|---|---|---|
| Redis | 0.2 to 1 ms | instant | yes, shared | the standard; TTLs built in |
| PostgreSQL | 1 to 5 ms | instant | yes, shared | fine at low scale; needs cleanup job |
| In-memory | microseconds | instant on that pod only | no; needs sticky sessions | never in production |
| Stateless JWT | 0 lookup, about 0.05 ms to verify | not without a blocklist | trivially | short TTL plus refresh token |

**JWT in a cookie versus session cookie.** A JWT in an `HttpOnly` cookie gets the XSS protection of cookies and the stateless verification of JWTs, but keeps the revocation weakness. The common senior pattern: a short-lived access JWT (5 to 15 minutes) in memory or a cookie, plus a long-lived opaque **refresh token** stored server-side (Redis or Postgres) and sent in an `HttpOnly` cookie scoped to `Path=/auth/refresh`. Revocation kills the refresh token; the access token dies within minutes. See Part on Authentication and Security for the full treatment; here we focus on the transport.

**Size and count limits.** Browsers allow about 4 KB per cookie and around 180 cookies per domain, and every cookie rides on every request to that host. A 3 KB JWT cookie on a page that loads 60 images adds 180 KB of upload per page load on a mobile uplink. Keep cookies small, and serve static assets from a cookieless domain or CDN.

#### Practical example

A food-delivery web app uses `__Host-sid` sessions in Redis with a 24-hour idle timeout and a 30-day absolute limit. The mobile apps use the same login endpoint but receive a JSON body with an access JWT and refresh token instead of a cookie, because native HTTP clients do not have a browser's cookie jar semantics or CSRF exposure. Both flows hit the same Redis-backed session table, so "log out everywhere" works across web and mobile.

#### NestJS example

Sessions in Redis with `express-session` and `connect-redis`, wired in `main.ts`, plus a guard that loads the user and a controller that sets and clears the cookie correctly.

```ts
// main.ts (excerpt)
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import Redis from 'ioredis';
import { NestExpressApplication } from '@nestjs/platform-express';

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.set('trust proxy', 1); // required so `secure: true` cookies work behind the ALB (X-Forwarded-Proto)

const redis = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: false, connectTimeout: 2_000 });
app.use(
  session({
    name: '__Host-sid',
    secret: process.env.SESSION_SECRET!,          // signs the cookie so a forged id is rejected before Redis
    store: new RedisStore({ client: redis, prefix: 'sess:', ttl: 86_400 }), // 24 h idle timeout
    resave: false,
    saveUninitialized: false,                      // do not create sessions for anonymous traffic
    rolling: true,                                 // sliding expiration on activity
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 86_400_000,                          // ms; keep in step with the store TTL
    },
  }),
);
```

```ts
// session-auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

interface SessionData { userId?: string; roles?: string[]; }

@Injectable()
export class SessionAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { session: SessionData; user?: unknown }>();
    if (!req.session?.userId) throw new UnauthorizedException(); // 401: not logged in
    req.user = { id: req.session.userId, roles: req.session.roles ?? [] };
    return true;
  }
}
```

```ts
// auth.controller.ts
import { Body, Controller, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request & { session: Record<string, unknown> }) {
    const user = await this.auth.validate(dto.email, dto.password);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    // Regenerate the session id on privilege change to defeat session fixation
    await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user.id;
    req.session.roles = user.roles;
    return { id: user.id, email: user.email };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request & { session: { destroy: (cb: (err?: unknown) => void) => void } }) {
    // destroy() deletes the Redis key and express-session clears the cookie
    await new Promise<void>((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
  }
}
```

The `regenerate()` on login is the detail juniors skip: without it, an attacker who plants a known session id in the victim's browser before login (session fixation) shares the authenticated session afterwards.

#### PostgreSQL example

Even with sessions in Redis, keep a durable record of refresh tokens or long-lived sessions in Postgres so that "sign out all devices" and audit work after a Redis flush.

```sql
CREATE TABLE user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL,                         -- sha256 of the refresh token; never store the token
  user_agent    text,
  client_ip     inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX user_sessions_token_hash_uidx ON user_sessions (token_hash);
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- Sign out everywhere
UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL;

-- Nightly cleanup (or pg_cron) so the table does not grow forever
DELETE FROM user_sessions WHERE expires_at < now() - interval '7 days';
```

#### TypeORM example

```ts
// user-session.entity.ts
import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity';

@Entity('user_sessions')
export class UserSession {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' }) user!: User;

  @Index({ unique: true })
  @Column({ type: 'bytea' }) tokenHash!: Buffer;

  @Column({ type: 'inet', nullable: true }) clientIp!: string | null;

  @Column({ type: 'timestamptz' }) expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true }) revokedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
```

#### Sequelize example

```ts
// user-session.model.ts
import { Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { User } from '../users/user.model';

@Table({ tableName: 'user_sessions', timestamps: false })
export class UserSession extends Model {
  @Column({ type: DataType.UUID, primaryKey: true, defaultValue: DataType.UUIDV4 }) id!: string;
  @ForeignKey(() => User) @Column(DataType.UUID) userId!: string;
  @Column({ type: DataType.BLOB, unique: true }) tokenHash!: Buffer;
  @Column(DataType.INET) clientIp!: string | null;
  @Column(DataType.DATE) expiresAt!: Date;
  @Column(DataType.DATE) revokedAt!: Date | null;
  @Column({ type: DataType.DATE, defaultValue: DataType.NOW }) createdAt!: Date;
}
```

#### Production scenario

A marketplace with 2 million monthly users keeps about 400,000 active sessions in Redis at roughly 300 bytes each, 120 MB. Session lookups run at 4,000 per second with a p99 of 1.1 ms. When Redis was migrated to a cluster with a 30-second failover, `enableOfflineQueue: false` meant login-required requests failed fast with `503` for 30 seconds rather than piling up 120,000 blocked requests; the rest of the site (anonymous browsing) was unaffected because `saveUninitialized: false` meant anonymous traffic never touched Redis.

#### Failure scenario

At 16:45, after a deploy that "just changed the cookie domain to `.shop.com` so the blog could show the username", every user was logged out, and then some users saw other users' names. The old cookie (`Domain` omitted, host-only for `www.shop.com`) and the new one (`Domain=.shop.com`) coexisted with the same name; browsers sent both, in an order that varies by path length and creation time, and the session middleware read whichever came first. A rollback plus an explicit cookie name change (`sid` to `sid2`) fixed it. Lesson: changing `Domain`, `Path` or `Name` creates a second cookie, not an updated one; plan the migration.

#### Edge cases & failure modes

- `Secure` cookies are never set over plain HTTP; behind an ALB without `trust proxy`, Express thinks the request is HTTP and silently skips `Set-Cookie`. Login "works" but no cookie appears.
- `SameSite=None` without `Secure` is rejected by browsers.
- Cookies are sent to every path by default; a cookie meant for `/api` also rides along with image requests.
- Session TTL sliding on every request means a bot that polls keeps a session alive forever; add an absolute lifetime.
- Redis down: sessions become unavailable; decide fast-fail versus degraded anonymous mode.
- Session data bloat: storing the cart in the session pushes Redis memory and serialisation cost; store ids, not objects.
- CSRF with `SameSite=Lax` still allows top-level `GET` navigations; never mutate state on `GET`.
- Subdomain takeover: a cookie with `Domain=.shop.com` is readable by any subdomain, including a forgotten `old.shop.com` pointing at an expired S3 bucket.
- Clock skew on JWT `exp` claims: a server 2 minutes behind accepts expired tokens; one ahead rejects fresh ones. Use NTP and a small leeway.
- Cookie jar limits: a 4 KB JWT with many claims can exceed the per-cookie limit and be dropped silently.

#### How a Senior Backend Engineer thinks about this

They pick sessions for browser apps by default (instant revocation, small cookies, mature tooling) and JWTs for service-to-service and mobile where a lookup per call is impractical, always with a short expiry and a refresh token. They set every cookie attribute deliberately and use the `__Host-` prefix. They plan cookie changes as migrations. To a product manager: "Log out everywhere works in one second because we kept the register at the front desk. If we had used only stamped passes, a stolen pass would work until it expired."

#### Common mistakes

- Storing the JWT in `localStorage` (readable by any XSS).
- Omitting `HttpOnly` "so the frontend can read the user id"; send the id in the body instead.
- Not regenerating the session id at login.
- Using in-memory sessions in a multi-pod deployment and wondering why users get logged out on every request.
- Sliding expiry with no absolute limit.

#### Interview questions

1. **Compare server-side sessions and JWTs on revocation, scaling and payload size.** Sessions: instant revocation, need a shared store, tiny cookie. JWT: no lookup, no revocation without a blocklist, larger cookie.
2. **What does `SameSite=Lax` block and what does it still allow?** Blocks cross-site `POST`, iframes and `fetch` with cookies; allows top-level `GET` navigations.
3. **Why does `Secure` break behind a load balancer without `trust proxy`?** Express sees HTTP, refuses to set the `Secure` cookie.
4. **Explain session fixation and its fix.** Attacker pre-sets a session id; regenerate on login.
5. **Where should a refresh token live in a browser app?** `HttpOnly`, `Secure`, `SameSite=Strict` cookie scoped to the refresh path, hashed in the database.
6. **What happens if you rename a cookie or change its `Domain`?** A second cookie coexists; plan a migration.

#### Practical exercise

Implement login, logout and "sign out all devices" with Redis sessions and a Postgres session table. Write e2e tests that assert the `Set-Cookie` attributes, that a fixed session id does not survive login, that a cross-site `POST` is rejected, and that revoking in Postgres invalidates the session on the next request. Acceptance criteria: tests pass behind an NGINX that sets `X-Forwarded-Proto`, and the cookie is under 200 bytes.
