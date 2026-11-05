## 49.3 RPO and RTO

#### Concept

Two numbers describe every disaster recovery design. Learn them properly, because every architecture and cost decision in this part falls out of them.

**RPO — Recovery Point Objective — is how much data you can afford to lose, measured in time.** "RPO 5 minutes" means: after a disaster, it is acceptable that the last 5 minutes of writes are gone forever. RPO is about the *past*.

**RTO — Recovery Time Objective — is how long you can afford to be down, measured in time.** "RTO 1 hour" means: one hour after the disaster starts, customers must be able to use the system again. RTO is about the *future*.

They are objectives, which means they are business decisions, not engineering ones. Engineering's job is to say honestly what each target costs, and then to build and *demonstrate* whatever the business chooses.

#### Why does it exist?

Without these two numbers, DR conversations go in circles. Someone says "we need to be resilient", someone else says "we should go multi-region", a third person says "that's too expensive", and nothing is decided.

With them, the conversation is concrete and takes 20 minutes: "Losing 5 minutes of orders costs us about 90 orders and a support queue we can handle. Losing an hour costs us 1,000 orders and refund disputes. Being down for 4 hours on Black Friday costs us more than the entire year's DR budget." Now you can pick a mechanism.

The other thing they do is stop the *most expensive mistake in DR*, which is applying one target to the entire system. Not all data is equal.

#### Mental model

Imagine you are writing a novel.

**RPO** is how often you hit save. If you save every 5 minutes and the laptop dies, you lose at most 5 minutes of typing. Saving on every keystroke costs you nothing on a laptop, but if each save were a courier riding to another city, you would think harder about the interval.

**RTO** is how long it takes to get typing again after the laptop dies. If you have a second laptop already open with the file synced, that is minutes. If you have to buy a new laptop, install everything and download the file, that is a day. Both machines can have the same RPO and wildly different RTOs.

The pair is independent. You can have RPO 0 and RTO 8 hours (synchronous replication into a backup you have to restore manually). You can have RPO 24 hours and RTO 2 minutes (a warm standby fed by a nightly copy). Sensible designs move them together, but the mechanisms are separate.

#### How it works

```mermaid
flowchart LR
  A["Last good write"] -->|"RPO window: writes that may be lost"| B["Disaster at T0"]
  B -->|"RTO window: detect, decide, restore, validate, repoint"| C["Service restored at T1"]
```

The RPO window is bounded by how frequently your data leaves the primary in a durable, independent way:

| RPO mechanism | Achievable RPO | Why |
|---|---|---|
| Nightly logical dump | up to 24 hours | Everything since the dump is gone |
| Snapshots every 6 hours | up to 6 hours | Same, shorter window |
| Continuous WAL archiving, 60s `archive_timeout` | 1 to 5 minutes | Bounded by segment shipping |
| RDS PITR (transaction log capture) | ~5 minutes typically | AWS ships logs continuously |
| Asynchronous streaming replica | seconds (equals replication lag) | Lag is normally under 1s but spikes under load |
| Synchronous replica (`synchronous_commit = on`, `remote_apply`) | 0 | Commit does not return until the standby has it |

The RTO window is not one thing; it is a sum, and the human parts are usually the biggest:

```text
RTO = detect + alert + decide + provision + restore + validate + repoint + warm
        3m      2m      10m      15m        45m       10m       10m      20m   = ~115 min
```

Notice that if you optimise only the restore step you cut 45 minutes out of 115. The other 70 minutes are automation, runbooks and drills. This is why teams that automate detection and repointing beat teams that buy faster storage.

**Not all data has the same targets.** This is the most useful thing in this section. Classify your data, and let each class have its own numbers.

| Data | RPO | RTO | Rationale |
|---|---|---|---|
| Orders, payments, inventory ledger | 0 to 1 min | 30 min | Losing 5 minutes of orders means customers charged with no order record; unacceptable, and a regulatory problem |
| Customer accounts, addresses | 5 min | 1 hour | Re-enterable but painful; low write rate |
| Product catalog | 1 hour | 1 hour | Re-importable from the PIM system |
| Session data in Redis | Unlimited | 15 min | Users log in again; annoying, not damaging |
| Search index (OpenSearch) | Unlimited | 2 hours | Fully rebuildable from PostgreSQL |
| Derived analytics / warehouse | 24 hours | 24 hours | Recomputable; nobody checks out through a dashboard |
| Invoices in S3 | 0 | 4 hours | Legally required, but not needed for checkout |

Two consequences fall straight out of that table. First, your expensive DR mechanism only has to cover the top rows: orders and payments. Second, several rows are cheap because you *designed* them to be rebuildable — the search index has an unlimited RPO precisely because PostgreSQL is its source of truth. Designing for reproducibility is a DR strategy, and it is usually the cheapest one available.

**Mapping targets to mechanisms and cost.** These are approximate `us-east-1` list prices for our 2 TB, `db.r6g.4xlarge`-class workload, and they move; use the *shape*, not the digits.

| RPO / RTO target | Mechanism | Approx. extra cost/month | Complexity |
|---|---|---|---|
| RPO 24h / RTO 24h | Nightly `pg_dump` to S3, restore manually | $20 to $50 | Trivial |
| RPO 5m / RTO 4h | RDS automated backups + PITR, single region, manual restore | $80 to $200 (snapshot storage) | Low |
| RPO 5m / RTO 1h | Above + cross-region snapshot copies + automated restore runbook + nightly verification | $300 to $600 | Low to medium |
| RPO <1m / RTO 5m (AZ failure only) | Multi-AZ RDS: synchronous standby in another AZ | ~2x instance cost, about +$900 | Low, AWS-managed |
| RPO 1 to 5m / RTO 15 to 30m (region failure) | Pilot light: cross-region read replica, minimal infra in region B, scale up on failover | +$900 (replica) + ~$150 baseline infra | Medium |
| RPO seconds / RTO 5 to 10m (region failure) | Warm standby: cross-region replica plus running-but-small app tier | +$900 replica, +$600 to $1,500 app/infra | High |
| RPO ~0 / RTO ~0 | Multi-site active-active, both regions serving writes | 2x everything plus conflict resolution engineering | Very high |

The interesting jumps are between rows. Going from RTO 4 hours to 1 hour is mostly *automation and drilling*, and costs a few hundred dollars. Going from 1 hour to 15 minutes requires a warm replica in another region and roughly doubles your database bill. Going from 15 minutes to near-zero requires active-active and roughly doubles everything else too — plus a permanent engineering tax of conflict resolution, which is the real cost.

Draw that curve for your business and the decision usually makes itself.

#### Practical example

The e-commerce leadership team is asked for targets. The first answer is "zero and zero, obviously". The engineering answer is a table showing that RPO 0 with region-level RTO near zero means active-active, roughly $8,000 a month more, one extra full-time engineer, and a two-quarter project — plus the honest note that active-active makes some failure modes *worse*, because now a bad deploy can corrupt data in two regions at once.

The team then asks the right question: what does an outage actually cost? At 25,000 orders a day and $60 average basket, a full checkout outage costs about $2,500 per hour of gross merchandise value, some of which is recovered later when customers return. Reputational damage on Black Friday is worth several times that.

The agreed targets: **RPO 5 minutes, RTO 1 hour for normal operations; RPO 15 minutes, RTO 4 hours for a full region loss.** That maps to RDS Multi-AZ plus PITR plus cross-region snapshot copies plus a rehearsed, automated runbook — roughly $1,200 a month all in, no new headcount. Everyone can defend that in a board meeting.

Six months later they revisit it before peak season and buy a cross-region read replica for November and December only, temporarily moving region RTO to 30 minutes. That is a good decision precisely because the targets were explicit enough to shop for.

#### NestJS example

Targets that live only in a document drift. Encode the RPO budget in the application so that a breach is a page.

```ts
// rpo-budget.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { DataSource } from 'typeorm';

/**
 * Measures the real RPO exposure of the primary: how far behind the durable
 * copy is. On a self-managed primary this is (current LSN - last archived LSN)
 * translated to time; here we approximate with archiver stats, which is the
 * number that actually bounds data loss.
 */
@Injectable()
export class RpoBudgetHealthIndicator extends HealthIndicator {
  constructor(private readonly ds: DataSource) { super(); }

  async isHealthy(key: string, budgetSeconds = 300): Promise<HealthIndicatorResult> {
    const [row] = await this.ds.query<{ lag: string; failed: string }[]>(`
      SELECT COALESCE(EXTRACT(EPOCH FROM (now() - last_archived_time)), 1e9) AS lag,
             failed_count AS failed
      FROM pg_stat_archiver
    `);
    const lagSeconds = Number(row.lag);
    const failed = Number(row.failed);
    const healthy = lagSeconds <= budgetSeconds && failed === 0;

    const result = this.getStatus(key, healthy, {
      archiveLagSeconds: Math.round(lagSeconds),
      budgetSeconds,
      archiveFailures: failed,
    });
    if (healthy) return result;
    // A broken archive means our RPO is silently the age of the last snapshot.
    throw new HealthCheckError('RPO budget breached: WAL archiving is behind or failing', result);
  }
}
```

Wire it into a `/health/dr` endpoint that is scraped but *not* used as the Kubernetes readiness probe. A broken archive must not take your pods out of the load balancer; it must wake a human.

#### Production scenario

A useful discipline: publish the two numbers on the service dashboard next to latency and error rate, as *measured* values, not targets.

- `rpo_exposure_seconds` — how much data would be lost if the primary died this second. Sourced from archiver lag or `LatestRestorableTime`.
- `rto_last_demonstrated_seconds` — the duration of the most recent successful full restore drill.

When someone asks "what is our RTO?", the answer is a graph, not a claim. When `rto_last_demonstrated_seconds` is 90 days stale, that is itself an alert: your RTO is now unknown.

#### Failure scenario

A SaaS company published "RPO 15 minutes, RTO 2 hours" in its enterprise contracts. It had RDS automated backups with PITR, which comfortably meets RPO 15 minutes. Nobody had measured RTO.

A failed migration corrupted a foreign key relationship at 09:12. The team decided to PITR to 09:05. The restore of their 4 TB database took 2 hours 10 minutes to reach "available", then 3 more hours of catastrophic performance while EBS lazily hydrated blocks under full production traffic. Total customer-visible impact: 6 hours 40 minutes against a contractual 2 hours, triggering SLA credits in six-figure territory.

The RPO was met exactly. The RTO was off by a factor of three, because it had never been measured, and because nobody had accounted for the post-restore performance cliff. The fix was not technical at first: it was to change the published number to the demonstrated one, then start a project to bring the demonstrated number down.

#### Edge cases & failure modes

- RPO and RTO published from a document that has never been demonstrated. This is the norm, and it is a promise you cannot keep.
- Targets applied uniformly, so you pay for RPO 0 on the analytics warehouse.
- RPO measured against snapshot age rather than archive lag, understating exposure by hours.
- Detection time excluded from RTO. If your monitoring takes 20 minutes to notice, your customer-visible RTO includes those 20 minutes.
- RTO measured to "database available" rather than "customers can check out". Cache warming, queue drain and reconciliation are inside the customer-visible window.
- Targets that ignore dependencies: your RTO cannot be better than your payment provider's, your identity provider's, or your DNS TTL.
- Peak-season targets equal to off-peak targets, when the cost of downtime differs by 10x.

#### How a Senior Backend Engineer thinks about this

They never accept "as fast as possible" as a target. They come to the meeting with the cost table above and force a choice, because an unmade choice defaults to the cheapest mechanism and the most expensive incident.

They separate the numbers per data class, and they look hard for data that can be made *rebuildable*, because rebuildable data has a free RPO. Moving the search index from "needs backups" to "rebuilt from PostgreSQL in 40 minutes" is a better engineering outcome than backing it up.

They treat the human portion of RTO as the main target. Detection, decision authority and repointing are cheaper to improve than storage.

And they know a target that has not been drilled is not a target. The sentence they use in reviews: *"What is the last date we demonstrated this number, and what was it?"*

#### Common mistakes

- Confusing the two: "our RPO is 4 hours" when they mean RTO.
- Treating Multi-AZ as a region-level DR answer. It is an AZ-level answer.
- Assuming an asynchronous replica gives RPO 0. It gives RPO equal to lag, which spikes exactly when you need it most.
- Forgetting that RTO includes the time to reconcile payments and replay queues, not just to boot a database.
- Setting a target once and never revisiting it as the database grows from 200 GB to 2 TB; restore time grows with it.

#### Interview questions

1. **Define RPO and RTO with an example.** Expected: RPO is acceptable data loss in time, RTO is acceptable downtime; e-commerce example where 5 minutes of lost orders is unacceptable but 24 hours of lost analytics is fine.
2. **How do RPO and RTO drive architecture?** Expected: RPO drives replication and archiving frequency; RTO drives standby posture and automation. Walk the ladder from nightly dumps to active-active with cost at each rung.
3. **What is your real RPO if you take hourly snapshots and WAL archiving is broken?** Expected: up to one hour, and you will not know until you restore. Follow-up: how do you detect it? `pg_stat_archiver`, `LatestRestorableTime` age, alerting.
4. **Does a synchronous standby give you RPO 0 for all failures?** Expected: for the loss of the primary, yes; not for logical corruption, which replicates instantly. Follow-up: what covers that? PITR.
5. **Your RTO is 1 hour and your last drill took 3 hours. What do you do?** Expected: change the published number to the truth, then attack the biggest term in the sum, usually human decision time and repointing, before buying faster infrastructure.
6. **How would you set different targets for different data?** Expected: classify by business impact and rebuildability; pay only for the top class.

#### Practical exercise

Write the RPO/RTO table for a system you work on. Every row must name the data, the target, the mechanism that achieves it, the approximate monthly cost, and the date the target was last demonstrated. Then measure one row for real.

Acceptance criteria: at least one row has a demonstrated RTO with a timestamp; at least one row is downgraded because the data turns out to be rebuildable; and at least one row is discovered to have no mechanism at all.
