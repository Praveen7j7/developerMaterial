## 49.9 What happens if the PostgreSQL production database disappears

This is the walkthrough. One incident, minute by minute, with the decisions named. The setup: pilot light DR (49.5), RPO target 5 minutes, RTO target 1 hour for a primary loss.

**02:14 — The event.** A storage-level failure in `us-east-1` takes out the RDS primary *and* its Multi-AZ standby (rare, but this is a DR chapter). The instance is not reachable and AWS shows it as `failed`.

**02:14:30 — Detection.** Three alerts fire within 40 seconds: the synthetic checkout probe fails, the API error rate crosses 50 percent, and `pg_up` from the exporter goes to 0. Detection is fast because there is a synthetic transaction, not just infrastructure metrics. *Elapsed: 0.5 min.*

**02:16 — Declare the incident.** The on-call pages, opens an incident channel, and takes the incident commander role. First three messages, always the same three: what is broken, what the blast radius is, who is doing what. Someone else is assigned scribe. The customer-communication owner is named now, not later. *Elapsed: 2 min.*

**02:18 — Assess.** Is this a database problem or a wider region problem? The pods are healthy, Redis is healthy, S3 is reachable. It is the database. Attempting `aws rds describe-db-instances` shows `failed` with no automatic recovery in progress. AWS Health dashboard confirms a storage issue.

The commander makes the call: **do not wait for AWS.** The RTO clock is running and a "wait and see" of 30 minutes is 30 minutes of the budget. *Elapsed: 4 min.*

**02:20 — Choose the recovery target.** Three options are on the table, and the commander states them explicitly:

| Option | RTO | RPO | Chosen? |
|---|---|---|---|
| PITR restore in `us-east-1` to now-5min | ~90 min | ~5 min | No: too slow, and the region's storage is suspect |
| Promote the `eu-west-1` cross-region replica | ~20 min | replica lag, currently 6 s | **Yes** |
| Restore the newest snapshot in `eu-west-1` | ~70 min | ~11 h | Fallback if promotion fails |

Replica lag at 02:14 was 6 seconds, from the CloudWatch metric captured before the failure. That is the RPO for this event, and it is written in the channel immediately: *"expected data loss: approximately 6 seconds of writes, roughly 2 to 4 orders."* *Elapsed: 6 min.*

**02:21 — Fence the old primary.** Even though it appears dead, the runbook says fence first. The security group ingress rule allowing the application subnets is revoked. This takes 30 seconds and eliminates split brain entirely. *Elapsed: 7 min.*

**02:22 — Promote.** `aws rds promote-read-replica --db-instance-identifier shop-replica-euw1 --region eu-west-1`. *Elapsed: 8 min.*

**02:27 — Promotion complete.** The instance is writable. Immediately, in parallel:
- Enable Multi-AZ and automated backups on the new primary (it has neither; a promoted replica inherits nothing).
- Capture `SELECT max(id), max(created_at) FROM orders;` for the reconciliation record.
*Elapsed: 13 min.*

**02:28 — Repoint the application.** This is the step that is either 90 seconds or 40 minutes depending on preparation. Ours is 90 seconds because the endpoint is not hardcoded anywhere:

```bash
# One secret holds the connection string. Everything reads it.
aws secretsmanager update-secret \
  --secret-id prod/shop/database-url \
  --secret-string "postgresql://app:***@shop-replica-euw1.xyz.eu-west-1.rds.amazonaws.com:5432/shop" \
  --region eu-west-1

# The External Secrets Operator syncs it into the cluster; a rollout picks it up.
kubectl rollout restart deployment/api deployment/worker -n shop
```

If instead the endpoint had been in a ConfigMap in three namespaces, a Helm value, a Terraform variable and two Lambda environment variables, this step would have been the longest of the incident. *Elapsed: 14 min.*

**02:33 — Pods healthy in `eu-west-1`.** The ArgoCD-managed deployments scale from 0 to 12. Image pull is fast because ECR replication put the images in `eu-west-1`. Readiness probes pass. *Elapsed: 19 min.*

**02:35 — Shift traffic.** Route 53 weighted records move to the `eu-west-1` ALB. TTL is 60 seconds. Synthetic checkout succeeds at 02:36:40. *Elapsed: 22 min. Customers can check out again.*

**02:36 — Warm the caches.** Redis in `eu-west-1` is empty. Without warming, 400 RPS of cache misses hits a database that is also serving the write path. The warming script loads the top 5,000 products and the category tree, then the site is opened to full traffic. p99 is 480 ms for the first 10 minutes, settling to 140 ms by 02:52. *Elapsed: 22 to 38 min.*

**02:40 — Replay the outbox and queues.** 1,240 unpublished outbox rows are republished. Kafka consumers in `eu-west-1` connect to the MirrorMaker-replicated cluster and start from their mirrored offsets; lag drains over 9 minutes. *Elapsed: 26 to 35 min.*

**02:50 — Reconcile payments for the gap.** The window is 02:13:50 to 02:36:40 (from just before the last replicated write to the moment writes resumed). Stripe shows 47 successful payment intents in that window. 44 have matching orders. **3 do not** — customers were charged, the order write never made it to the replica.

Those 3 are handled by hand within the hour: the payment intent metadata contains the cart, so the orders are recreated with their original ids and a note in the audit log. Two customers get an apology email; one had already emailed support. *Elapsed: 36 to 55 min.*

**03:05 — Communicate.** The status page was updated at 02:19 ("investigating checkout errors") and 02:37 ("service restored, monitoring"). Now a fuller note goes out. The rule the team follows: **update at declaration, at restoration, and every 30 minutes in between, even when there is nothing new.** Silence is what customers remember.

**03:30 — Stabilise.** Multi-AZ is enabling on the new primary. A new read replica is being created in `eu-west-1`. Backups are confirmed running. Only now does the commander stand down. Running without redundancy is not "recovered".

**Total: 22 minutes to customers checking out, 55 minutes to fully reconciled, against a 60 minute RTO and 5 minute RPO. Actual data loss: 6 seconds, 3 orders, all recovered manually.**

```mermaid
flowchart LR
  T0["02:14 primary fails"] --> T1["02:14:30 detected by synthetic probe"]
  T1 --> T2["02:16 incident declared"]
  T2 --> T3["02:20 target chosen: promote eu-west-1 replica"]
  T3 --> T4["02:21 fence old primary"]
  T4 --> T5["02:22 promote"]
  T5 --> T6["02:28 repoint via one secret"]
  T6 --> T7["02:35 traffic shifted"]
  T7 --> T8["02:36 checkout works"]
  T8 --> T9["02:50 payment reconciliation"]
  T9 --> T10["03:30 redundancy restored"]
```

#### The honest list: what would have made this four hours faster

This incident went well because of decisions made months earlier. The postmortem's most valuable output is the list of things that would have made a *worse* version of this incident better. Here it is honestly:

1. **One place for the database endpoint.** The single biggest lever. Teams with the endpoint scattered across ConfigMaps, Helm values, Lambda env vars and a hardcoded fallback in an old service spend 30 to 60 minutes hunting. One secret, read by everything, turns that into 90 seconds.
2. **A cross-region replica instead of only snapshots.** Promotion took 5 minutes; a snapshot restore would have taken 70. That single line item is worth roughly $900 a month and it saved an hour.
3. **A drilled runbook.** The team had run this exact procedure in a drill 7 weeks earlier. Nobody had to think about the order of steps, and nobody forgot to fence.
4. **A synthetic checkout probe.** Detection in 30 seconds instead of "when a customer complains", which is typically 8 to 15 minutes at 02:00.
5. **ECR image replication and manifests in Git.** No `ImagePullBackOff`, no hand-editing YAML at 02:30.
6. **`payment_intent_id` on the order row.** Reconciliation was a query. Without it, it would have been a spreadsheet exercise taking days.
7. **A scripted cache warmer.** Without it, the site comes back and immediately falls over from a cold-cache stampede, and you have a second outage inside the first.
8. **Raised service quotas in the DR region, checked quarterly.** A vCPU quota that only allows 4 pods would have capped capacity at exactly the wrong moment.
9. **The decision to not wait for AWS.** Twenty minutes of hoping is twenty minutes of RTO.
10. **A named incident commander and scribe.** Five engineers all typing commands is slower than one deciding and two executing.

And the honest gaps this incident revealed, which became action items:

- The promoted replica had no backups or Multi-AZ. Should be automated in the promotion script, not remembered.
- Kafka MirrorMaker offsets were mapped approximately; two consumer groups reprocessed about 15 minutes of events. Idempotency saved it, but the offset mapping needs work.
- The status page update at 02:19 was written from scratch under pressure. Pre-written templates now exist.
- Nobody checked the DR region's quotas in the last two drills.

## 49.10 The DR runbook and drill schedule

#### Concept

A runbook is an executable document: the steps, in order, with the commands, the decision points and the verification for each. A drill is a scheduled rehearsal of that document against real infrastructure. Together they convert DR from a design into a capability.

#### Why does it exist?

Because at 02:14 nobody reasons well. Cognitive load is the enemy. Every decision you can pre-make, pre-write and pre-test is a decision that does not have to be made badly under pressure.

Also because knowledge decays. The person who built the DR setup leaves. The endpoint changes. A new service is added that hardcodes the database host. Without a drill, you find all of this during the incident.

#### How it works

**The runbook template.** One file per scenario, in the application repository, in Git, reviewed like code.

```text
RUNBOOK: Primary database loss
==============================

APPLIES WHEN
  The RDS primary is unreachable and Multi-AZ failover has not restored
  service within 5 minutes.

TARGETS
  RTO 60 minutes. RPO 5 minutes.

ROLES
  Incident Commander - decides, does not type
  Operator           - runs commands
  Scribe             - records the timeline in the incident channel
  Comms              - status page and customer email

PRE-FLIGHT (2 minutes)
  [ ] Confirm scope: kubectl get pods -n shop, Redis PING, S3 HEAD
  [ ] Check the AWS Health dashboard for a regional event
  [ ] Record current replica lag from CloudWatch, post it in the channel

DECISION
  If replica lag < 60s and region B healthy -> promote the cross-region replica
  If the replica is unavailable             -> PITR restore from newest recovery point
  If a region-wide event affects both       -> escalate, use snapshots in the third region

STEPS
   1. FENCE the old primary (revoke SG ingress).       command: ...
   2. Promote the replica.                             command: ...
   3. Enable Multi-AZ and backups on the new primary.  command: ...
   4. Update the database secret.                      command: ...
   5. Restart deployments.                             command: ...
   6. Verify: the synthetic checkout must pass.        command: ...
   7. Shift DNS.                                       command: ...
   8. Warm caches.                                     command: ...
   9. Replay the outbox, reset consumer offsets.       command: ...
  10. Reconcile payments for the gap window.           command: ...

VERIFICATION
  [ ] Synthetic checkout passes
  [ ] Error rate below 1 percent for 5 minutes
  [ ] SELECT count(*) FROM outbox_events WHERE published_at IS NULL is draining
  [ ] Payment reconciliation reports zero unresolved discrepancies

ROLLBACK
  There is no rollback after promotion. If promotion fails, go to
  runbook-pitr-restore.md.

AFTER
  [ ] New read replica created
  [ ] Backups verified running on the new primary
  [ ] Postmortem scheduled within 48 hours
  [ ] Timeline exported from the incident channel
```

Two rules that make runbooks actually work: **every step is a copy-pasteable command**, and **every step has a verification**. A step that says "ensure the application is healthy" is not a step.

**The quarterly drill.** Four levels, escalating. Do not start at level 4.

| Level | What you do | Frequency | Disruption |
|---|---|---|---|
| 1. Tabletop | Walk the runbook aloud in a meeting; find the stale command | Monthly, 30 min | None |
| 2. Component | Restore a backup to a scratch instance and validate | Nightly, automated | None |
| 3. Non-production failover | Full failover in staging, timed, with the real runbook | Quarterly | Staging down for an hour |
| 4. Production game day | Real failover in production, announced, in a low-traffic window | Annually | Real, planned |

Level 4 frightens people, and it should be earned by passing level 3 twice. But a team that has never failed over production does not know whether it can.

**What to measure during a drill.** Record these every time, and graph them across drills:

- Time to detect (from the injected failure to the first alert).
- Time to declare (first alert to incident channel open).
- Time to decide (channel open to recovery target chosen).
- Time to first successful write on the new primary.
- Time to synthetic transaction passing (this is your real RTO).
- Time to full performance (caches warm, lag drained).
- Data loss measured, in seconds and in business records.
- Number of runbook steps that were wrong, missing or ambiguous. **This is the most valuable number.** A drill that finds seven broken steps was a great drill.
- Number of people needed.

Publish the trend. When time-to-synthetic-passing goes from 74 minutes to 38 minutes to 22 minutes across three drills, that is the DR programme visibly working.

**Backup verification automation.** Covered in 49.2, but it belongs in the drill schedule too: the nightly restore *is* your level-2 drill, running 365 times a year while the humans drill four times.

```mermaid
flowchart LR
  N["Nightly automated restore"] -->|"365 per year"| V["Backups proven restorable"]
  Q["Quarterly staging failover"] -->|"4 per year"| R["Runbook proven correct"]
  A["Annual production game day"] -->|"1 per year"| P["People proven capable"]
  V --> DR["Demonstrated RTO and RPO"]
  R --> DR
  P --> DR
```

#### Common mistakes

- A runbook in a wiki nobody can find at 02:00. Put it in the repository and link it from the alert.
- Runbook steps written as prose intentions rather than commands.
- Drills run by the person who wrote the runbook. Have someone else execute it; that is the test.
- Drilling only the happy path. Inject a failure mid-drill ("the replica will not promote") and see what happens.
- Treating a drill that found problems as a failure. That is a successful drill.
- Never drilling the *communication* path, so the status page password is unknown at 02:20.

#### Interview questions

1. **What is in a DR runbook?** Expected: applicability, targets, roles, decision table, copy-pasteable steps with verification, rollback, post-incident actions.
2. **How often should you drill, and at what levels?** Expected: automated nightly restores, monthly tabletop, quarterly non-production failover, annual production game day.
3. **What do you measure in a drill?** Expected: the time breakdown, data loss, and the count of broken runbook steps; graph them across drills.
4. **A drill found nine problems. Was it a good drill?** Expected: yes, emphatically; those nine would have been found during a real incident otherwise.

#### Practical exercise

Write the primary-database-loss runbook for your system using the template above. Then hand it to an engineer who did not write it and have them execute it in staging while you time each step and say nothing.

Acceptance criteria: they complete it without asking you a question; you record the six timing measurements; and you file at least three issues for steps that were wrong or ambiguous.

## 49.11 Edge cases and failure modes

The catalogue. Each of these has taken a real production system down or made a recovery far worse.

- **Backups never tested, and corrupt.** The `pg_dump` piped into `gzip` without `set -o pipefail`, producing a valid truncated archive every night for 90 days. Fix: nightly automated restore with business-invariant checks and a size-delta alert.
- **A backup taken from a lagging replica.** The dump ran against a replica 40 minutes behind, so the recorded recovery point is 40 minutes older than believed, and your RPO is silently wrong by that amount. Fix: check `pg_last_xact_replay_timestamp()` before dumping and fail the job if lag exceeds a threshold; record the actual replay timestamp as the backup's recovery point.
- **WAL archive gaps that silently break PITR.** `archive_command` fails (S3 permission changed, disk full, network policy) and PostgreSQL retries forever while the PITR window quietly ends at the gap. Nothing alerts, because the database is healthy. Fix: alert on `pg_stat_archiver.failed_count > 0` and on `now() - last_archived_time`; on RDS, alert on the age of `LatestRestorableTime`.
- **A nine-hour restore because of instance and IOPS limits.** Restored to a smaller class to save money; gp2 at 3 IOPS/GB throttled; EBS lazy loading hydrated blocks at a trickle under production read load. Fix: restore to production-equivalent class and storage, measure it nightly, and pre-warm hot tables.
- **Application secrets still pointing at the old host.** The database is healthy; the app is not, because a Helm value, a Lambda environment variable and an old service's hardcoded fallback still resolve the dead endpoint. Fix: one secret, referenced everywhere; grep the whole organisation for the hostname during the drill.
- **Caches inconsistent with the restored database.** Redis holds product prices and cart contents from *after* the recovery point. Customers see prices and carts that the database has never heard of; some of them check out. Fix: invalidate by prefix as part of the runbook, before traffic returns, and treat any cache holding authoritative-looking data as a liability.
- **Sequences reissuing ids and causing duplicate keys.** After restoring a table, `orders_id_seq` is behind `max(id)`, and the next insert throws `duplicate key value violates unique constraint`. Fix: `SELECT setval('orders_id_seq', (SELECT COALESCE(max(id), 1) FROM orders));` for every sequence, as a scripted step. Better: use UUIDv7 or ULID primary keys, which have no sequence to fix and no collision across regions.
- **Replayed events triggering duplicate side effects.** The worst one. Republishing `order.paid` events after a restore causes the payments consumer to capture the same authorisation twice, charging customers a second time. Fix: idempotency keys sent to the payment provider (they deduplicate server-side), a `processed_messages` table with a unique key on event id, and pausing money-moving consumers before any replay.
- **Retention shorter than the time to detect the problem.** A subtle data corruption introduced by a release is discovered 12 days later; backup retention is 7 days. There is no version of the data that is correct. Fix: retention must exceed your realistic detection time for *logical* problems, which is weeks, not days. 35 days is a reasonable floor; monthly archival snapshots kept for a year are cheap.
- **Cross-region replication lag at failover.** Lag is 3 seconds on a normal Tuesday and 4 minutes during the traffic spike that preceded the failure, because that is when replication falls behind. Your RPO is measured at the worst moment, not the average. Fix: alert on replica lag with a threshold tied to your RPO, and record lag at promotion.
- **DNS TTL delaying recovery.** A 300 second TTL on the application record means five minutes of traffic still arriving at a dead region after the switch, plus clients and resolvers that ignore TTLs entirely. Fix: 60 second TTLs on failover-relevant records maintained permanently (you cannot lower a TTL during an incident and have it take effect), health-check-based routing, and connection-level retry in clients.
- **One compromised credential deleting both the data and the backups.** The CI role has `rds:*` and `s3:*` because it was easier. A leaked token deletes the instance, the snapshots and the backup bucket in four API calls. Fix: separate backup account, vault lock in compliance mode, no cross-account trust from CI, alerts on destructive API calls, and least privilege that specifically excludes `Delete*` on backup resources.

Two more that deserve naming because they are structural rather than technical:

- **The DR plan assumes a person who has left.** Every runbook step that begins "ask Priya" is a single point of failure. Fix: drills executed by someone who did not write the runbook.
- **The DR region has never had a deploy.** Manifest drift, missing CRDs, an outdated cluster version, expired certificates, un-raised quotas. Fix: deploy to region B on every release, even at zero replicas.

## Senior Checklist — Part 49

- [ ] I understand the concept of backup, restore, RPO, RTO and the four DR strategies
- [ ] I can explain simply why a read replica is not a backup
- [ ] I can implement logical and physical backups, and configure PITR
- [ ] I understand the failure modes of each backup and restore mechanism
- [ ] I understand the scaling limitations: restore time grows with data size and instance class
- [ ] I understand the security implications: backups need a separate custody boundary
- [ ] I understand the operational implications: drills, runbooks, and measured RTO
- [ ] I can choose between backup-and-restore, pilot light, warm standby and active-active
- [ ] I can explain the cost tradeoffs of each rung of the DR ladder
- [ ] I can answer senior-level interview questions on recovery
- [ ] I can estimate restore time for a 2 TB database and defend the estimate stage by stage
- [ ] I can execute a point-in-time recovery and extract only the affected rows
- [ ] I can reconcile a restored database with a payment provider for a gap window
- [ ] I know to fence the old primary before promoting a replica
- [ ] I know what `pg_stat_archiver` tells me and why a WAL gap silently breaks PITR
- [ ] I have a runbook in the repository and I know the date of the last drill

## Part 49 — Key Takeaways

- The restore is the product; the backup is only the input. An untested backup is a hypothesis.
- Replication protects against machines failing. Backups protect against decisions being wrong. You need both.
- RPO is acceptable data loss in time; RTO is acceptable downtime. Both are business decisions, and both must be *demonstrated*, not asserted.
- Classify data by RPO and RTO. Most of your data is rebuildable, and rebuildable data is free to protect.
- Your real RPO is bounded by continuous log archiving, not by snapshot frequency, and a broken archive makes it silently worse.
- For scoped logical damage, repair in place from a side instance. Never fail over to a recovery point just to fix a few tables.
- Round the recovery target backwards and reconcile forwards. You can replay; you cannot un-restore.
- Fence the old primary before promoting a replica, or you will have two databases and a much worse day.
- Failback is a fresh migration, not the reverse of failover. Often the right answer is not to fail back today.
- The database being back is not the system being back: payments, outbox, queues, caches, search and DLQs all need ordered recovery, and money comes first.
- Backups need a second custody boundary. Ask which single credential can delete both the data and the backups.
- Automate the nightly restore verification and graph `restore_duration_seconds`. It turns RTO from a promise into a measurement.
- A drill that finds nine broken runbook steps is a successful drill.
