## 95.2 Tenant isolation in PostgreSQL: row-level security

#### Concept

In the pool model, tenant isolation depends on every query touching only the current tenant's rows. Relying on application code to always add `WHERE tenant_id = ...` is dangerous, because one forgotten filter is a cross-tenant breach. PostgreSQL **row-level security (RLS)** moves the enforcement into the database: you define policies that automatically restrict every query to the current tenant's rows, based on a session variable, so even a query that forgets the tenant filter returns only the right tenant's data. RLS is the single most important technical mechanism for safe pooled multi-tenancy, because it makes isolation a property of the database, not of application discipline.

#### Why does it exist?

Imagine a pooled multi-tenant application with hundreds of queries across dozens of developers over years. Isolation depends on every single one of those queries including the correct `tenant_id` filter. The probability that all of them, forever, always include it correctly is essentially zero — someone will write a query that forgets it, or a join that leaks, or a new developer who does not know the convention. And the failure mode is catastrophic: a query that forgets the filter returns *all tenants'* data, which is a breach. Application-enforced isolation is a single-point-of-failure-per-query that will eventually fail.

RLS exists to remove this risk by enforcing isolation at the database layer. Once an RLS policy is in place, the database itself restricts every query on the table to the current tenant's rows, regardless of what the application query says. A developer who forgets the `tenant_id` filter gets only their tenant's rows anyway, because the database adds the restriction. RLS turns tenant isolation from a fragile per-query discipline into a database-enforced invariant, which is exactly what a security boundary should be.

#### Mental model

Imagine a shared office building where each company rents space. Application-enforced isolation is asking everyone to only enter their own floor by politely checking the sign — it works until someone does not check, and then they are on the wrong floor seeing another company's work. RLS is a keycard system on every door: the building itself enforces that your card only opens your floor, so even if you try the wrong door (forget the filter), it does not open. The keycard system (RLS) makes isolation a property of the building (the database), not of everyone's diligence (the application code). You want the keycard, not the politeness, protecting your tenants' data.

#### How it works

RLS works through policies tied to a session variable that holds the current tenant:

1. **Enable RLS on the table.** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
2. **Set a session variable** holding the current tenant id, at the start of each request (from the tenant context, 95.3).
3. **Define a policy** that restricts rows to those matching the session's tenant id.
4. Now every query on the table — SELECT, UPDATE, DELETE, INSERT — is automatically restricted to the current tenant, by the database.

```sql
-- 1. The shared, pooled table with tenant_id.
CREATE TABLE orders (
  id          UUID PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  customer_id UUID NOT NULL,
  total_minor BIGINT NOT NULL,
  status      TEXT NOT NULL
);
CREATE INDEX orders_tenant_idx ON orders (tenant_id, id);

-- 2. Enable RLS. FORCE applies it even to the table owner.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

-- 3. Policy: a row is visible/modifiable only if its tenant_id matches the
--    session's current_tenant setting. Applies to all commands.
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
-- USING filters rows read/updated/deleted; WITH CHECK enforces inserts/updates
-- can only write rows for the current tenant.
```

With this in place, at the start of each request you set the session variable:

```sql
-- Set per request/connection, from the authenticated tenant context (95.3).
SET app.current_tenant = 'acme-tenant-uuid';

-- Now EVEN a query that forgets the tenant filter is safe:
SELECT * FROM orders;             -- returns ONLY acme's orders, enforced by RLS
SELECT * FROM orders WHERE status = 'shipped';  -- still only acme's
-- And a malicious attempt to write another tenant's row is blocked:
INSERT INTO orders (id, tenant_id, ...) VALUES (..., 'other-tenant', ...);
-- -> fails the WITH CHECK policy; cannot insert for a different tenant.
```

Key properties: use `FORCE ROW LEVEL SECURITY` so the policy applies even to the table owner (otherwise the owner bypasses it); include a `WITH CHECK` clause so inserts and updates cannot write to another tenant; and set the session variable reliably on every connection, which the tenant context (95.3) handles.

#### NestJS example

A middleware or interceptor sets the PostgreSQL session variable from the authenticated tenant at the start of each request, so RLS has the right tenant for every query in that request:

```ts
// An interceptor that sets app.current_tenant on the connection for the request,
// so RLS restricts every query to this tenant. Runs after auth (which puts the
// tenantId on the request) and before the handler's queries.
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { DataSource } from 'typeorm';

@Injectable()
export class TenantRlsInterceptor implements NestInterceptor {
  constructor(private readonly dataSource: DataSource) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const tenantId: string = req.tenantId;  // set by the auth guard (95.3)
    if (!tenantId) {
      throw new Error('No tenant context');  // fail closed: never run query-less
    }
    // Set the session variable on the request's connection so RLS applies.
    // set_config(..., true) scopes it to the current transaction.
    return from(
      this.dataSource.query(
        `SELECT set_config('app.current_tenant', $1, true)`, [tenantId],
      ),
    ).pipe(switchMap(() => next.handle()));
  }
}
```

The crucial detail: this must run on the *same* connection that the request's queries use (hence transaction-scoped `set_config` with the `true` flag, within a transaction, or careful connection handling), because a connection pool otherwise might hand the query a different connection without the setting. Getting the connection/session alignment right is the subtle, critical part of RLS in a pooled application.

#### PostgreSQL example

Proving RLS works, and the connection-pool pitfall:

```sql
-- With RLS enabled and the policy from above:
SET app.current_tenant = 'acme';
SELECT count(*) FROM orders;          -- e.g. 1,200 (acme's orders only)

SET app.current_tenant = 'globex';
SELECT count(*) FROM orders;          -- e.g. 3,400 (globex's orders only)

-- Forgetting the setting entirely (the pool pitfall) with a strict policy:
RESET app.current_tenant;
SELECT count(*) FROM orders;
-- -> ERROR: unrecognized configuration parameter (if not set with a default)
--    OR returns 0 rows. EITHER WAY it fails CLOSED (no data leak), which is
--    the safe behaviour. Design the policy so missing tenant = no rows, never
--    all rows.
```

The design principle: the system must **fail closed** — if the tenant setting is missing, queries return no rows (or error), never all rows. A policy that defaults to showing everything when the tenant is unset is a breach waiting to happen; design it so the absence of a tenant context means no access.

#### TypeORM example

RLS is enforced by the database regardless of TypeORM, but you still set the session variable and should keep `tenant_id` on entities for clarity and for the `WITH CHECK` on inserts:

```ts
import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity('orders')
@Index(['tenantId', 'id'])            // tenant-first index for pooled queries
export class Order {
  @PrimaryColumn('uuid') id: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId: string;                    // still present; RLS uses it, inserts need it

  @Column('uuid', { name: 'customer_id' }) customerId: string;
  @Column('bigint', { name: 'total_minor' }) totalMinor: string;
  @Column('text') status: string;
}

// Set the session variable within a transaction so queries on the same
// connection are RLS-scoped (aligns with the interceptor above):
await dataSource.transaction(async (manager) => {
  await manager.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
  // Every query in this transaction is now RLS-restricted to tenantId.
  return manager.getRepository(Order).find();  // only this tenant's orders
});
```

#### Production scenario

A pooled SaaS with RLS on every tenant-scoped table runs with confidence that even a developer mistake cannot leak data across tenants. In one real incident-that-wasn't, a developer ships a new reporting query that forgets the `tenant_id` filter entirely — a query that, in an application-enforced system, would have returned every tenant's data and caused a serious breach. But because RLS is enabled and the tenant session variable is set per request, the query returns only the current tenant's rows, exactly as if the filter were there. The mistake is caught in review (the missing filter is noticed), but even if it had shipped, RLS would have made it harmless. This is the entire value of RLS: it converts a class of catastrophic breaches (forgotten tenant filters) into non-events, because isolation is enforced by the database, not by every query being perfect forever.

#### Failure scenario

A pooled SaaS relies on application-enforced tenant filtering with no RLS, trusting that every query includes `WHERE tenant_id = ...`. For two years it holds, through developer discipline and code review. Then a new developer, under deadline pressure, writes a query for an admin feature that builds a dynamic WHERE clause and, in one code path (an edge case where no other filters apply), omits the tenant filter. Code review misses it because the tenant filter is usually added by a helper the developer did not use in this path. The feature ships. A customer using the admin feature in that specific edge case sees a list that includes other tenants' records. The breach is reported, is severe (cross-tenant data exposure), requires customer notification and possibly regulatory disclosure, and damages trust irreparably with the affected customers. The root cause is that isolation depended on every query being perfect forever, which is impossible at scale over time — exactly the risk RLS eliminates. Had RLS been enabled, the query that forgot the filter would have returned only the current tenant's rows, and the breach would never have happened. Relying on application discipline for tenant isolation in a pooled model is a bet that no one ever makes a mistake, and that bet always eventually loses. RLS is the mitigation, and skipping it is one of the most dangerous decisions in multi-tenant architecture.

#### Edge cases & failure modes

- **Forgotten tenant filter (no RLS).** A single query without the filter leaks all tenants' data — the catastrophic breach RLS prevents.
- **RLS not forced for the table owner.** Without `FORCE ROW LEVEL SECURITY`, the owner (often the app's role) bypasses the policy, defeating it.
- **Connection-pool misalignment.** The session variable set on one connection but the query runs on another from the pool, so RLS has the wrong or no tenant — must align session-setting and query on the same connection/transaction.
- **Failing open.** A policy that returns all rows when the tenant is unset, instead of none — design to fail closed (no access without a tenant).
- **Missing `WITH CHECK`.** Without it, a tenant could insert or update rows with another tenant's `tenant_id`, writing into another tenant's data.
- **Superuser / BYPASSRLS roles.** Roles with `BYPASSRLS` (like superusers) ignore policies; the application must connect as a non-bypassing role.
- **Forgetting RLS on a new table.** A new tenant-scoped table added without RLS is an isolation hole; enforce via a fitness function / migration check (Part 90.5).

#### How a Senior Backend Engineer thinks about this

They treat tenant isolation in a pooled model as a security boundary that must be enforced by the database, not by application discipline, because they know that relying on every query to include the tenant filter forever is a bet that eventually loses — someone will forget, and the failure mode is a catastrophic breach. So they reach for row-level security as the primary mechanism, making isolation a database-enforced invariant that holds even when application code is wrong.

They design RLS to fail closed — no tenant context means no access, never all access — because they understand that the dangerous failure is a policy that leaks everything when the tenant is unset. They are meticulous about the connection-pool alignment (setting the session variable on the same connection the queries use, scoped to a transaction), because they know this subtle detail is where RLS silently breaks in a pooled application. They use `FORCE ROW LEVEL SECURITY` and `WITH CHECK`, connect as a non-BYPASSRLS role, and enforce (via a migration check or fitness function) that every new tenant-scoped table gets RLS, because a single table without a policy is an isolation hole. The senior engineer's defining instinct here is defence in depth with the database as the backstop: application code should filter correctly, but the database must enforce isolation regardless, because tenant data isolation is the one thing a SaaS absolutely cannot get wrong.

#### Common mistakes

- **Relying on application-enforced tenant filtering** with no RLS, betting every query is perfect forever.
- **Not using `FORCE ROW LEVEL SECURITY`,** so the app's own role bypasses the policy.
- **Connection-pool misalignment,** setting the tenant variable on a different connection than the query runs on.
- **Failing open** (all rows when tenant unset) instead of failing closed (no rows).
- **Omitting `WITH CHECK`,** allowing writes into another tenant's data.
- **Adding a new tenant-scoped table without RLS,** leaving an isolation hole.

#### Interview questions

1. **Why is application-enforced tenant filtering dangerous in a pooled model, and what's the fix?**
   *Expected answer:* isolation depends on every query including the correct tenant filter forever, which at scale over time is impossible — someone eventually forgets, and the failure mode is a catastrophic cross-tenant breach. The fix is PostgreSQL row-level security: policies tied to a session variable restrict every query to the current tenant at the database layer, so even a query that forgets the filter returns only the right tenant's rows. *Why it matters:* this is the central isolation mechanism of pooled multi-tenancy.

2. **What are the critical details to get RLS right in a pooled, connection-pooled application?**
   *Expected answer:* set the tenant session variable on the same connection the queries run on (scoped to a transaction, aligned with the pool), use `FORCE ROW LEVEL SECURITY` so the app's role doesn't bypass it, include `WITH CHECK` so writes can't target another tenant, connect as a non-BYPASSRLS role, design the policy to fail closed (no tenant = no rows), and enforce RLS on every new tenant-scoped table. *Why it matters:* tests whether they know where RLS silently breaks.

3. **What does "fail closed" mean for tenant isolation and why does it matter?**
   *Expected answer:* if the tenant context is missing or unset, queries should return no rows (or error), never all rows — so an absent tenant context means no access, not full access. It matters because a policy that fails open (shows everything when the tenant is unset) turns a missing-context bug into a full cross-tenant breach, whereas failing closed turns the same bug into a harmless no-data result. *Why it matters:* tests security-by-default thinking for the highest-stakes SaaS invariant.

#### Practical exercise

Take a tenant-scoped table in a pooled design and implement row-level security for it: write the DDL to enable and force RLS, create the policy with both USING and WITH CHECK tied to a session variable, and write the NestJS interceptor (or equivalent) that sets the session variable per request on the correct connection. Then test it: prove that switching the session variable switches which tenant's rows are visible, and that an unset tenant fails closed (no rows), and that an attempt to insert a row for a different tenant is rejected.

**Acceptance criteria:** RLS is enabled and forced; the policy has both USING (restricts reads/updates/deletes) and WITH CHECK (restricts writes to the current tenant); the session variable is set on the same connection the queries use (transaction-scoped); the system fails closed when the tenant is unset (no rows, not all rows); and you demonstrate that a forgotten tenant filter in a query still returns only the current tenant's data, proving isolation is enforced by the database rather than the application.
