## 44.9 Attribute-Based Access Control (ABAC)

#### Concept

ABAC decides access by evaluating **policies** over **attributes** of the subject (the user: id, roles, region, department), the resource (the order: owner, region, status, amount), the action (`read`, `refund`), and the environment (time, IP, MFA freshness). A policy reads like a sentence: *"a user can view an order if they own it, or if they are support in the same region as the order."* RBAC is a special case of ABAC where the only attribute is the role.

#### Why does it exist?

Real rules have conditions. "Support can refund" is a role. "Support can refund up to 100, support leads up to 1,000, and nobody can refund an order older than 90 days" is not something roles express without an explosion of `support_under_100_recent` pseudo-roles. ABAC lets you write the condition once, in one place, and evaluate it wherever the decision is needed: in a guard, in a service, and in the query that lists what the user may see.

#### Mental model

Imagine a bouncer with a rule card instead of a guest list. The card says: "Admit if on the list, or if over 21 and with a member, or if staff and it is after closing time." The bouncer looks at the person (subject attributes), the door (resource), what they want (enter, or enter the VIP room), and the clock (environment), and applies the rules. Adding a rule is editing the card, not printing new badges.

#### How it works

1. Define **abilities** per subject: a function that takes the user and returns the set of `(action, subject type, conditions)` triples they are allowed. CASL (`@casl/ability`) is the standard TypeScript library for this and is what the NestJS documentation uses.
2. Check an ability against a **specific resource instance**: `ability.can('read', order)` evaluates the conditions (owner id, region) against the order's fields.
3. Convert the same conditions into a **database filter** for list endpoints so that users only see what they may see, without loading everything and filtering in memory. CASL provides `@casl/ability/extra` helpers for this; for SQL you typically translate conditions into a `where` object.
4. Use a **policy guard** for route-level checks that need only the user and the subject type ("may this user create refunds at all?") and keep instance-level checks in the service where the row is loaded.

#### Practical example

Food delivery. Rules:

- A customer can `read` an order if `order.customerId === user.id`.
- A restaurant staff member can `read` and `update` an order if `order.restaurantId` is in `user.restaurantIds` and `order.status` is not `delivered`.
- A support agent can `read` any order in `order.region === user.region`, and can `refund` if `order.total <= 100` or the agent has the `support_lead` role.
- Nobody can `refund` an order with `createdAt` older than 90 days.

Every one of these is a condition over attributes. All of them can be evaluated against a loaded order, and all except the date rule can be pushed down into a `WHERE` clause for listings.

#### NestJS example

Ability definition with CASL, then a service check and a list query derived from the same rules.

```ts
// ability.factory.ts
import { Injectable } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility, MongoAbility, InferSubjects } from '@casl/ability';
import { Order } from '../orders/order.entity';
import { AuthenticatedUser } from '../auth/authenticated-user';

export type Action = 'read' | 'update' | 'refund' | 'manage';
export type Subjects = InferSubjects<typeof Order> | 'all';
export type AppAbility = MongoAbility<[Action, Subjects]>;

@Injectable()
export class AbilityFactory {
  define(user: AuthenticatedUser): AppAbility {
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    can('read', Order, { customerId: user.id });                                   // owner
    if (user.restaurantIds?.length) {
      can(['read', 'update'], Order, { restaurantId: { $in: user.restaurantIds }, status: { $ne: 'delivered' } });
    }
    if (user.roles.includes('support')) {
      can('read', Order, { region: user.region });
      can('refund', Order, { region: user.region, total: { $lte: 100 } });
    }
    if (user.roles.includes('support_lead')) can('refund', Order, { region: user.region });
    if (user.roles.includes('admin')) can('manage', 'all');

    // Absolute rule: cannot() after can() wins.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    cannot('refund', Order, { createdAt: { $lt: ninetyDaysAgo } }).because('Order older than 90 days');

    return build({ detectSubjectType: (obj) => obj.constructor as typeof Order });
  }
}
```

```ts
// orders.service.ts (instance check + list filter from the same rules)
import { ForbiddenError, subject } from '@casl/ability';
import { rulesToQuery } from '@casl/ability/extra';

async refund(orderId: string, amount: number, user: AuthenticatedUser) {
  const order = await this.repo.findOneByOrFail({ id: orderId });
  const ability = this.abilities.define(user);
  ForbiddenError.from(ability).throwUnlessCan('refund', subject('Order', order)); // throws with the reason
  return this.refunds.execute(order, amount, user);
}

async listVisible(user: AuthenticatedUser) {
  const ability = this.abilities.define(user);
  const q = rulesToQuery(ability, 'read', 'Order', (rule) => rule.conditions ?? {}); // { $or: [...] } or null
  if (q === null) return [];                                   // no rule allows read at all
  const where = toTypeOrmWhere(q);                             // small translator: $in -> In(), $ne -> Not(), $or -> array
  return this.repo.find({ where, take: 50, order: { createdAt: 'DESC' } });
}
```

A route-level policy guard for checks that only need the subject *type*:

```ts
// policies.guard.ts
import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AbilityFactory, AppAbility } from './ability.factory';

type PolicyHandler = (ability: AppAbility) => boolean;
export const CheckPolicies = (...handlers: PolicyHandler[]) => SetMetadata('policies', handlers);

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(private reflector: Reflector, private abilities: AbilityFactory) {}
  canActivate(ctx: ExecutionContext): boolean {
    const handlers = this.reflector.get<PolicyHandler[]>('policies', ctx.getHandler()) ?? [];
    const user = ctx.switchToHttp().getRequest().user;
    const ability = this.abilities.define(user);
    return handlers.every((h) => h(ability));
  }
}
// @CheckPolicies((a) => a.can('refund', 'Order'))  -> "may refund some orders"; instance check still in service
```

#### PostgreSQL example

The same policy as a database view for reporting, and as an index that keeps the support listing fast:

```sql
-- Support agents list orders by region, newest first: index matches the filter and sort.
CREATE INDEX orders_region_created_idx ON orders (region, created_at DESC);

-- Owner listing:
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total, status FROM orders
WHERE region = 'eu-west' ORDER BY created_at DESC LIMIT 50;
```

```text
Limit  (cost=0.56..12.31 rows=50 width=44) (actual time=0.041..0.112 rows=50 loops=1)
  ->  Index Scan using orders_region_created_idx on orders
        (cost=0.56..48210.11 rows=205000 width=44) (actual time=0.039..0.101 rows=50 loops=1)
        Index Cond: (region = 'eu-west'::text)
        Buffers: shared hit=7
Execution Time: 0.140 ms
```

#### Production scenario

A marketplace support tool serving 1,200 agents across 6 regions, 40 million orders. Every order view runs `ability.can` on the loaded row (microseconds). Listings translate CASL conditions into indexed `WHERE` clauses; the p95 for a region listing is 8 ms. Policy changes (raise the refund limit to 150) are one line in the ability factory, reviewed by security and deployed like code. The team logs every `ForbiddenError` with the rule reason so product can see which policies are being hit.

#### Failure scenario

An agent in the EU region could refund orders in the US region. The listing was correctly filtered by region, but the refund endpoint took an order id and only checked `user.roles.includes('support')`. The ABAC rule existed in the ability factory; the refund service simply did not call it. The fix was to route every mutation through `throwUnlessCan` and to add a test that constructs a user from region A and an order from region B for each action.

#### Edge cases & failure modes

- Rules defined but not applied in a code path (the failure above). Centralise enforcement.
- Conditions that cannot be translated to SQL (computed fields), forcing in-memory filtering; keep policy attributes as stored columns.
- Time-based rules evaluated with the server clock; clock skew and time zones.
- Attribute staleness: `user.region` from the token is stale after a transfer; version the claims (44.8).
- Performance: an ability with hundreds of rules per request; cache the built ability per request, not per user across requests.
- `cannot` rules and rule ordering surprises; test the precedence explicitly.

#### How a Senior Backend Engineer thinks about this

They adopt ABAC when a rule cannot be said with roles alone, and they keep the policy in one file per domain so it can be reviewed like a contract. They insist that the same rules drive both the instance check and the list query, because two implementations of the same rule drift. They resist externalising policy to a general-purpose engine (OPA, Cedar) until multiple services need to share it, because a network call per authorization decision is a real cost and a new failure mode.

#### Common mistakes

- Evaluating policy only in listings and not in mutations.
- Encoding policy in scattered `if` statements across services.
- Loading all rows and filtering in memory.
- Putting mutable attributes in the token without versioning.

#### Interview questions

1. *When is ABAC needed over RBAC? Give a rule that RBAC cannot express.* Expected: any condition over resource attributes, like region or amount.
2. *How do you keep list filtering and instance checks consistent?* Expected: derive both from one rule set (CASL `rulesToQuery`).
3. *Where do policy decisions belong: gateway, guard, service, database?* Expected: type-level in guard, instance-level in service, tenant-level in DB as a backstop.
4. *What is the cost of an external policy engine per request?*

#### Practical exercise

Implement the food-delivery rules above with CASL. Acceptance criteria: unit tests cover each rule with positive and negative cases, including the 90-day `cannot`; the listing endpoint for a support agent returns only their region and uses an index (verify with `EXPLAIN`); the refund endpoint rejects a cross-region refund with the CASL reason in the 403 body.

## 44.10 Permissions, Scopes and Tenant Isolation

#### Concept

**Permissions** are fine-grained named capabilities (`orders.read`, `orders.refund`, `users.invite`) that roles bundle. **Scopes** are the same idea applied to third-party clients through OAuth (44.4): which capabilities *this app* was granted for *this user*. **Least privilege** is the principle behind both: grant only what is needed for the task, for as short a time as possible. **Tenant isolation** is the specific and unforgiving case of least privilege in multi-tenant SaaS: a query that forgets the tenant filter leaks another company's data.

#### Why does it exist?

Roles get coarse. Product wants a "billing-only" role, then a "billing read-only" role, then "billing read-only except invoices". A permissions table lets roles be composed from small capabilities without changing code. Scopes exist because third-party apps must be bounded independently of the user's own rights. Tenant isolation exists because the single most damaging class of SaaS bug is cross-tenant data exposure, and it is caused by an ordinary missing `WHERE`.

#### Mental model

Imagine an apartment building (the SaaS) with many tenants (customers). Each apartment has its own lock (tenant filter). A cleaner (support role) has a master key for their floor only (permission scoped by tenant). A delivery app (third-party client) is given a code that opens only the parcel locker (scope). And the building has a second safeguard: even with the wrong key, the doors on floor 7 will not open for a keycard registered to floor 3 (row-level security).

#### How it works

**Permissions:**

1. `permissions` table with stable string keys. `role_permissions` maps roles to permissions. Effective permissions of a user are the union over their roles.
2. Guards check permissions rather than roles: `@RequirePermission('orders.refund')`. Roles become configuration; code references permissions.
3. Effective permissions are computed at login and cached (Redis, 60 seconds) or placed in the token as a compact form (a `perm_v` version plus a role list; never 200 strings).

**Scopes:** enforced by the `ScopesGuard` from 44.4. The effective right is the *intersection* of the client's scopes and the user's permissions.

**Tenant isolation:**

1. The tenant id comes from the verified token (or from the API key's record), never from the URL or body.
2. Every repository method receives the tenant id and includes it in the `WHERE` clause. Composite indexes lead with `tenant_id`.
3. PostgreSQL row-level security (RLS) is enabled on tenant tables. Before running queries, the app sets `SET LOCAL app.tenant_id = '<uuid>'` inside the transaction, and the policy compares each row's `tenant_id` with that setting. A query that forgets the filter returns only the current tenant's rows. A query with *no* tenant set returns nothing.
4. The application's database user is not the table owner and has no `BYPASSRLS`, otherwise RLS is silently skipped.

#### Practical example

A B2B invoicing SaaS with 40,000 tenants in one PostgreSQL database. Every table with customer data has a `tenant_id uuid NOT NULL` column. The `JwtStrategy` puts `tenantId` on `request.user`. A request-scoped `TenantContext` carries it into repositories. A TypeORM subscriber or a wrapping `withTenant()` helper opens a transaction, runs `SET LOCAL app.tenant_id`, and executes the unit of work. RLS policies exist on every tenant table, and a CI test runs each repository method with RLS enabled for tenant A and asserts that tenant B's rows never appear.

#### NestJS example

A helper that binds the tenant to the transaction, so RLS applies to everything inside it, and a repository that also filters explicitly (belt and braces).

```ts
// tenant-db.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

@Injectable()
export class TenantDb {
  constructor(private ds: DataSource) {}

  // Everything inside `work` runs with RLS bound to the tenant.
  async withTenant<T>(tenantId: string, work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.ds.transaction(async (em) => {
      // SET LOCAL is transaction-scoped: safe with PgBouncer transaction pooling, resets on commit.
      // set_config with parameters avoids string interpolation of the tenant id.
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return work(em);
    });
  }
}
```

```ts
// invoices.repository.ts
@Injectable()
export class InvoicesRepository {
  constructor(private db: TenantDb) {}

  findForCustomer(tenantId: string, customerId: string) {
    return this.db.withTenant(tenantId, (em) =>
      em.getRepository(Invoice).find({
        where: { tenantId, customerId },          // explicit filter uses the composite index
        order: { issuedAt: 'DESC' }, take: 100,
      }),
    );
  }
}
```

```ts
// permission.guard.ts
export const RequirePermission = (...perms: string[]) => SetMetadata('permissions', perms);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector, private perms: PermissionsService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>('permissions', [ctx.getHandler(), ctx.getClass()]) ?? [];
    if (!required.length) return true;
    const user = ctx.switchToHttp().getRequest().user as AuthenticatedUser;
    const effective = await this.perms.effectiveFor(user.id, user.tenantId); // Redis-cached 60 s, invalidated on role change
    if (!required.every((p) => effective.has(p))) throw new ForbiddenException(`Missing permission ${required.join(', ')}`);
    return true;
  }
}
```

#### PostgreSQL example

Permissions tables, RLS policy, and the least-privilege database user.

```sql
CREATE TABLE permissions (
  key         text PRIMARY KEY,           -- 'orders.refund'
  description text NOT NULL
);
CREATE TABLE role_permissions (
  role_id        smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- Effective permissions of a user (cached by the app):
SELECT DISTINCT rp.permission_key
FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
WHERE ur.user_id = $1;
```

```sql
-- Tenant isolation with RLS.
CREATE TABLE invoices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  customer_id uuid NOT NULL,
  total_cents bigint NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_tenant_customer_idx ON invoices (tenant_id, customer_id, issued_at DESC);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;    -- apply even to the table owner

CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)         -- reads, updates, deletes
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);   -- inserts and updated rows

-- Least-privilege application role: no ownership, no BYPASSRLS, only needed grants.
CREATE ROLE app_api LOGIN PASSWORD '...' NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE ON invoices TO app_api;
REVOKE DELETE ON invoices FROM app_api;                                    -- soft delete only
GRANT USAGE ON SCHEMA public TO app_api;
```

`current_setting('app.tenant_id', true)` returns NULL (rather than erroring) when the setting is missing; `NULL = anything` is not true, so a query with no tenant bound returns zero rows. That is the fail-closed behaviour you want.

Check that the plan still uses the index with RLS on: the policy predicate becomes an extra filter, and because the query also filters on `tenant_id` explicitly, the index scan is unchanged.

```text
Index Scan using invoices_tenant_customer_idx on invoices
  Index Cond: ((tenant_id = '9a1f...'::uuid) AND (customer_id = '4c2e...'::uuid))
  Filter: (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)
```

#### Sequelize example

```ts
await sequelize.transaction(async (t) => {
  await sequelize.query(`SELECT set_config('app.tenant_id', :tenantId, true)`, {
    replacements: { tenantId }, transaction: t,
  });
  return Invoice.findAll({ where: { tenantId, customerId }, order: [['issuedAt', 'DESC']], limit: 100, transaction: t });
});
```

#### Production scenario

The invoicing SaaS runs 2,500 requests per second against a 1.8 TB database; RLS adds under 2 percent CPU because every query already filters on `tenant_id`. The team measured a synthetic "forgotten filter" query with RLS on: it returned the correct tenant's rows only, at a cost of a sequential scan; RLS saved the data, and the slow-query alert caught the bug. Permission caches are invalidated by publishing a Redis message on role change; propagation takes under a second.

#### Failure scenario

A reporting endpoint used a raw query written by a data engineer: `SELECT ... FROM invoices WHERE issued_at > $1`. No tenant filter. It ran through a separate "analytics" database user that had been created as the table owner for convenience, so RLS did not apply. The endpoint leaked revenue figures across tenants for 3 hours before a customer noticed unfamiliar customer names in an export. Two fixes: the analytics user was recreated without ownership and with `NOBYPASSRLS`, and `FORCE ROW LEVEL SECURITY` was set on every tenant table.

#### Edge cases & failure modes

- RLS bypassed by the table owner or a superuser connection; enforce `FORCE` and least-privilege roles.
- `SET` instead of `SET LOCAL` with a connection pool: the tenant setting leaks to the next request on the same connection. Always `SET LOCAL` inside a transaction, or `set_config(..., true)`.
- Background jobs with no tenant context querying tenant tables: bind the tenant explicitly per job.
- Cross-tenant admin tools that need to see everything: a separate role with a `BYPASSRLS` policy exception, heavily audited, never used by the API.
- Permission cache stale after a role change; invalidate on write.
- Scope and permission both required: checking only one of them is a bug.
- Tenant id taken from the URL for "convenience" and not compared to the token's tenant.

#### How a Senior Backend Engineer thinks about this

They treat tenant isolation as a property to be *proven*, not hoped for: token-derived tenant id, repository-level filtering, RLS, a least-privilege DB user, and a test suite that tries to cross tenants for every repository method. They accept the small RLS overhead as the cheapest insurance the company will ever buy. They grant permissions, not roles, in code, so that reorganising roles is a data change. And they ask, for every new database user or IAM role: *what is the minimum this needs?*

#### Common mistakes

- Trusting `tenantId` from the request.
- Creating the app's DB user as the table owner.
- Using `SET` without `LOCAL` on pooled connections.
- Not indexing with `tenant_id` first.
- Putting hundreds of permission strings in the token.

#### Interview questions

1. *How do you guarantee tenant isolation in a shared-database SaaS?* Expected: token-derived tenant, repository filter, RLS with `SET LOCAL`, least-privilege user, tests.
2. *Why does RLS silently not apply for some connections?* Expected: table owner, superuser, or `BYPASSRLS`; fix with `FORCE` and roles.
3. *What is the difference between a permission and a scope?* Expected: user capability vs client-app grant; both apply.
4. *What breaks if you use `SET` instead of `SET LOCAL` behind PgBouncer?*
5. *How do you keep a permission cache fresh?*

#### Practical exercise

Enable RLS on `orders` and `invoices`, create an `app_api` role without ownership, and implement `withTenant`. Write a test that inserts rows for two tenants and runs every repository method as tenant A. Acceptance criteria: no method returns tenant B rows; a deliberately unfiltered raw query inside `withTenant` still returns only tenant A rows; a query outside `withTenant` returns zero rows; `EXPLAIN` shows the composite index is used.

## 44.11 API Keys for Machine Clients

#### Concept

An API key is a long random secret that identifies and authenticates a machine client: a partner's server, a CI pipeline, an internal cron job. Unlike OAuth tokens, keys are long-lived and manually managed, which makes them convenient and dangerous in equal measure. The engineering job is to make a leaked key as harmless as possible: hashed at rest, scoped, expiring, revocable, and easy to rotate.

#### Why does it exist?

Not every client can run an OAuth flow. A partner's nightly batch job has no user to log in and often no ability to store and refresh tokens. A key in a config file is what they can do. API keys are the pragmatic answer, provided they are treated like passwords, not like identifiers.

#### Mental model

Imagine a hotel key card issued to a cleaning contractor. It has the contractor's name on it (prefix, so you know whose it is), it opens only the floors they clean (scopes), it stops working at the end of the contract (expiry), the front desk keeps only a fingerprint of the card, not a copy (hash at rest), and when the contractor loses it, a new one is issued and the old one dies after a short overlap (rotation).

#### How it works

1. **Generate**: 32 random bytes, base64url encoded, with a recognisable prefix: `sk_live_7Qm3...`. The prefix lets secret scanners (GitHub, gitleaks) recognise leaked keys, and lets you tell live from test keys at a glance.
2. **Store**: only `sha256(key)` in the database, plus a short `key_id` (the first 8 characters after the prefix) for lookup and display, and `last4` for the dashboard. SHA-256 is fine here, not bcrypt, because the key has 256 bits of entropy and cannot be brute-forced; bcrypt would just make every request cost 50 ms.
3. **Show once**: the full key is returned exactly once at creation. Afterwards only `sk_live_7Qm3...ab9f` is displayed.
4. **Authenticate**: read `Authorization: Bearer sk_live_...` or `X-API-Key`, hash it, look up by hash, check `revoked_at` and `expires_at`, load the owner, scopes and tenant, and set `request.user`.
5. **Scope and bound**: each key has scopes (`orders:read`), optional IP allow-list, optional rate-limit tier, and belongs to exactly one tenant.
6. **Rotate**: create a new key, keep both valid for an overlap window (say 7 days), then revoke the old one. Store `last_used_at` so you can see whether the old key is still in use before revoking.
7. **Detect leaks**: run secret scanning on your own repos and logs; subscribe to GitHub secret scanning partner program if you are big enough; revoke and notify automatically on a hit.

#### NestJS example

```ts
// api-key.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiKeysService } from './api-keys.service';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  constructor(private keys: ApiKeysService) { super(); }

  async validate(req: Request) {
    const raw = (req.headers['x-api-key'] as string | undefined)
      ?? (req.headers.authorization?.startsWith('Bearer sk_') ? req.headers.authorization.slice(7) : undefined);
    if (!raw || !/^sk_(live|test)_[A-Za-z0-9_-]{43}$/.test(raw)) throw new UnauthorizedException();

    const hash = createHash('sha256').update(raw).digest();
    const key = await this.keys.findActiveByHash(hash);           // indexed unique lookup
    if (!key) throw new UnauthorizedException();
    // Defensive constant-time compare even though the DB lookup already matched the hash.
    if (!timingSafeEqual(hash, key.keyHash)) throw new UnauthorizedException();
    if (key.ipAllowList?.length && !key.ipAllowList.includes(req.ip!)) throw new UnauthorizedException();

    await this.keys.touch(key.id, req.ip!);                       // last_used_at, throttled to once per minute
    return { id: `key:${key.id}`, tenantId: key.tenantId, scopes: key.scopes, roles: ['machine'], apiKeyId: key.id };
  }
}
```

The `AuthGuard(['jwt', 'api-key'])` form from `@nestjs/passport` tries strategies in order, so a route can accept either a user token or a machine key without duplication.

#### PostgreSQL example

```sql
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  name          text NOT NULL,                     -- "Warehouse sync (prod)"
  key_id        text NOT NULL,                     -- first 8 chars after prefix, for display and support
  key_hash      bytea NOT NULL UNIQUE,             -- sha256(raw key)
  last4         text NOT NULL,
  scopes        text[] NOT NULL,
  ip_allow_list inet[],
  rate_tier     text NOT NULL DEFAULT 'standard',
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,                       -- NULL = no expiry (discouraged)
  last_used_at  timestamptz,
  last_used_ip  inet,
  revoked_at    timestamptz,
  replaced_by   uuid REFERENCES api_keys(id)       -- rotation chain
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id) WHERE revoked_at IS NULL;

-- Lookup on every machine request: unique index probe on key_hash, ~0.05 ms.
```

#### Production scenario

A logistics API with 4,000 partner keys handling 900 requests per second. The key lookup is a unique index probe, cached in Redis for 60 seconds keyed by hash (with revocation publishing an invalidation), so PostgreSQL sees about 15 key lookups per second. `last_used_at` writes are throttled per key to once per minute. Keys expire after 12 months by policy; the dashboard warns 30 days before. Secret scanning on the company's GitHub organisation has caught three leaked test keys and one live key in two years; the live key was revoked automatically within 4 minutes of the commit.

#### Failure scenario

A partner pasted their live key into a support ticket. The support tool indexed tickets into a search system readable by every employee. The key was found by an internal red-team exercise five months later. Because it was scoped to `orders:read` for one tenant, the damage was limited, but the lesson was to add key-pattern redaction to the support ingestion pipeline and to the application logs (44.30).

#### Edge cases & failure modes

- Keys logged in request logs (`Authorization` header) or in URLs (query-string keys end up in access logs and browser history); never accept keys in the query string.
- Key lookup without an index: a sequential scan per request.
- Keys without expiry living for years across employee and partner turnover.
- Revocation not propagating through the cache.
- Rate tier per key not enforced, so one partner's bug becomes everyone's outage.
- Key belonging to a user rather than a tenant, so the key dies when the employee leaves.
- Timing leak in string comparison if you compare raw strings rather than looking up by hash.

#### How a Senior Backend Engineer thinks about this

They prefer OAuth client credentials for anything that can run it and offer API keys for everything else, built once, centrally, with hashing, prefixes, scopes, expiry, rotation and last-used tracking. They put keys through the same guard chain as users so that scopes and tenant isolation apply identically. They also assume every key will leak eventually and design the blast radius accordingly.

#### Common mistakes

- Storing raw keys.
- Comparing keys with `===` on the raw string against a stored raw key.
- Accepting keys in query strings.
- No prefix, so scanners cannot recognise them.
- No overlap window on rotation, which breaks partners at 03:00.

#### Interview questions

1. *Why SHA-256 for API keys but argon2 for passwords?* Expected: entropy; passwords are guessable, 256-bit keys are not.
2. *Design key rotation for a partner with zero downtime.*
3. *What does a key prefix buy you?* Expected: secret scanning, environment identification.
4. *How do you bound the damage of a leaked key?* Expected: scopes, tenant binding, expiry, IP allow-list, rate tier, revocation.

#### Practical exercise

Implement API keys with the schema above, a Passport custom strategy, `AuthGuard(['jwt','api-key'])` on a read endpoint, rotation with a 7-day overlap, and `last_used_at`. Acceptance criteria: the raw key appears only in the creation response; a revoked key fails within one second; a key with `orders:read` cannot call a write endpoint; request logs never contain the key.

## 44.12 Object-Level Authorization and IDOR

#### Concept

An Insecure Direct Object Reference (IDOR) is what happens when an endpoint takes an object id from the client and returns or modifies that object without checking that the caller may access it. `GET /orders/1042` returns order 1042 to anyone logged in. Change the number, get someone else's order. It is the most common serious vulnerability in real APIs, year after year, because it is not a framework bug or a crypto bug; it is a missing line of code in ordinary business logic.

#### Why does it exist?

Authentication is centralised and hard to forget. Object-level authorization must be written per endpoint, per object type, per action, and is easy to forget. Sequential integer ids make the attack trivial; UUIDs make guessing hard but do nothing about ids that appear in emails, shared links, or other users' responses.

#### Mental model

Imagine a parcel locker where you type a locker number and it opens. There is a login at the door (authentication), but once inside, every locker opens for every visitor. The fix is not a stronger door; it is a check at each locker that the code belongs to the person standing in front of it.

#### How it works

1. Every load or mutation of an object that has an owner or a tenant takes the **principal** from the verified token and the **object id** from the request.
2. The query includes the ownership predicate: `WHERE id = $1 AND customer_id = $2`. If no row comes back, respond 404. This is better than load-then-check because it cannot be forgotten in a later branch and it does one round trip.
3. For objects with more complex rules (support in the same region), load the object and evaluate the ABAC rule (44.9).
4. Protect *related* objects too: `PATCH /orders/:id/items/:itemId` must check that the item belongs to the order and the order to the user. Attackers move an item id from their order into a request for another order.
5. Make it hard to forget: an **ownership-scoped repository** whose methods all require a principal, and a lint rule or test that flags direct `repository.findOne({ where: { id } })` calls in controllers and services for owned entities.

#### Practical example

A ride-booking app exposes `GET /rides/:id/receipt`. Rides belong to a rider and a driver. The rule: the rider, the driver, or support in the region may view the receipt. The repository method is `findRideForPrincipal(rideId, principal)` and encodes exactly that predicate. There is no `findRideById` for use in request handlers.

#### NestJS example

Guard for the simple ownership case, plus a repository that makes the safe path the easy path.

```ts
// owned-orders.repository.ts
@Injectable()
export class OwnedOrdersRepository {
  constructor(@InjectRepository(Order) private repo: Repository<Order>) {}

  // The ONLY way to fetch a single order in request handling. The predicate cannot be forgotten.
  async findForPrincipal(id: string, p: AuthenticatedUser): Promise<Order> {
    const qb = this.repo.createQueryBuilder('o').where('o.id = :id', { id });
    if (p.roles.includes('support')) {
      qb.andWhere('o.region = :region', { region: p.region });
    } else {
      qb.andWhere('o.customer_id = :uid', { uid: p.id });
    }
    const order = await qb.getOne();
    if (!order) throw new NotFoundException();   // 404 for both missing and foreign
    return order;
  }

  // Nested object: the item must belong to the order AND the order to the principal.
  async findItemForPrincipal(orderId: string, itemId: string, p: AuthenticatedUser): Promise<OrderItem> {
    const order = await this.findForPrincipal(orderId, p);
    const item = await this.repo.manager.findOne(OrderItem, { where: { id: itemId, orderId: order.id } });
    if (!item) throw new NotFoundException();
    return item;
  }
}
```

```ts
// ownership.guard.ts: a route-level guard for the plain "owner only" case
@Injectable()
export class OrderOwnerGuard implements CanActivate {
  constructor(@InjectRepository(Order) private repo: Repository<Order>) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const exists = await this.repo.exist({ where: { id: req.params.id, customerId: req.user.id } });
    if (!exists) throw new NotFoundException();
    return true;
  }
}
// The guard is convenient for simple cases but the service must ALSO scope its queries:
// a guard checks the route parameter, not every id inside the body.
```

Mass assignment is IDOR's sibling: `PATCH /orders/:id` with `{ "customerId": "<other user>" }` reassigns the order if the DTO is not whitelisted. Enable `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` globally and never spread the raw body into an entity (44.24).

#### PostgreSQL example

Ownership predicates need indexes that include the owner column, and RLS can enforce ownership for customer-facing tables, not only tenants.

```sql
CREATE INDEX orders_customer_idx ON orders (customer_id, id);

-- Optional RLS for owner scoping in a B2C app; app sets app.user_id per transaction.
CREATE POLICY order_owner ON orders
  USING (customer_id = current_setting('app.user_id', true)::uuid
         OR current_setting('app.role', true) = 'support');
```

#### Production scenario

A bug-bounty programme for a 5-million-user marketplace paid out on 23 valid reports in a year; 14 were IDORs, all in endpoints added after the original auth design: exports, webhooks management, invoice PDFs, address book entries. The team added a repository convention, a lint rule flagging `findOneBy({ id })` on owned entities, and an integration test template ("user B cannot access user A's X") that every new owned resource must include.

#### Failure scenario

A "download invoice" endpoint accepted `?invoiceId=` and streamed the PDF from S3. The developer had checked ownership on the invoice *list* endpoint and assumed the ids were therefore safe. A researcher enumerated integer invoice ids and downloaded 1,200 invoices in ten minutes. The fix was the ownership predicate on the download query and a switch to signed, short-lived S3 URLs generated only after the check (44.32).

#### Edge cases & failure modes

- Nested ids: item ids, address ids, attachment ids inside an owned parent.
- Ids in bodies, not just in URLs: `{ "paymentMethodId": ... }` on checkout must belong to the caller.
- Bulk endpoints: `POST /orders/cancel` with `{ ids: [...] }` must filter the whole set by owner, and report which were skipped.
- Sequential ids leak counts and enable enumeration; prefer UUIDv4 or v7 for exposed ids, but do not rely on unguessability as the control.
- 403 vs 404 leaking existence.
- Support tooling that legitimately crosses ownership needing its own scoped rules and audit.
- Background jobs reusing request-handler repositories without a principal; give jobs an explicit system principal and log it.

#### How a Senior Backend Engineer thinks about this

They assume every id in a request is hostile. They make ownership part of the query, not a check after it. They design repositories so the unsafe method does not exist for request handling, and they require a negative test per owned resource. They know IDOR is the vulnerability most likely to appear in their next pentest report and they budget for it.

#### Common mistakes

- Checking ownership on the list and not on the item.
- Loading by id and forgetting the check in one of several branches.
- Trusting UUIDs as a security control.
- Returning 403 for foreign objects.
- Accepting `userId` or `customerId` in bodies.

#### Interview questions

1. *What is IDOR and why is it so common?* Expected: per-endpoint authorization forgotten; not a framework bug.
2. *Load-then-check or check-in-query?* Expected: in-query where possible; one round trip, cannot be forgotten in branches.
3. *How would you make IDOR structurally hard in a NestJS codebase?* Expected: scoped repositories, global whitelist validation, negative tests, lint rules.
4. *Do UUIDs solve IDOR?* Expected: no; they reduce enumeration, not authorization.

#### Practical exercise

Audit an existing orders module. For every endpoint that takes an id (path, query or body), write a test where user B uses user A's id. Acceptance criteria: every such test returns 404; nested item and address ids are covered; a `PATCH` with `customerId` in the body is rejected by the validation pipe; the repository exposes no unscoped `findById` for request handling.
