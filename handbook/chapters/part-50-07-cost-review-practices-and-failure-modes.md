## 50.8 Cost review practices

#### Concept

Optimisation without operation decays. A team that spends a quarter cutting 50 percent will be back to the original number within a year unless the practice becomes routine. These are the routines.

#### How it works

**The monthly cost review.** Sixty minutes, a named owner, a fixed agenda:

1. **Total and unit economics.** Total spend, cost per order, both against last month and against six months ago. The unit number is the one that gets discussed.
2. **Top five movers.** Which line items changed by more than 10 percent, and why. Every one gets an explanation or an action item.
3. **Untagged percentage.** If it went up, find out what got created without tags.
4. **Top five by absolute size.** Not to cut, but to confirm someone still owns each.
5. **Waste register.** A standing list of known waste with owners and dates: idle environments, orphaned volumes, unused replicas, snapshots past their expiry.
6. **Upcoming changes.** Anything shipping next month with a cost impact, flagged in advance.

The output is action items with owners, not a document. Thirty minutes of preparation and thirty of discussion.

**Anomaly alerts.** AWS Cost Anomaly Detection (or the equivalent) learns your normal spend per service and alerts on statistically unusual changes. Configure it per service and per account, with a threshold low enough to catch a $200 a day surprise, because a $200 a day surprise is $6,000 a month.

```json
{
  "AnomalyDetectorName": "per-service-monitor",
  "MonitorType": "DIMENSIONAL",
  "MonitorDimension": "SERVICE",
  "Subscribers": [{ "Type": "SNS", "Address": "arn:aws:sns:us-east-1:123456789012:cost-alerts" }],
  "Threshold": 100,
  "Frequency": "DAILY"
}
```

Route it to a Slack channel the team actually reads, not to an inbox. The value of an anomaly alert is entirely in how fast someone sees it: a runaway log loop caught in 24 hours costs $200, and caught in 30 days costs $6,000.

**Budgets.** Set a budget per environment and per team, with alerts at 80, 100 and 120 percent of the forecast. Budgets are a *conversation trigger*, not a control. Resist the temptation to attach automated actions that stop resources — the failure mode where a budget action shuts down production is worse than any overspend.

The exception where hard controls are correct: developer sandboxes and ephemeral environments, where an automatic shutdown at a threshold is exactly right.

**Cost as an explicit line in design reviews.** Add one required section to the design document template:

```text
COST IMPACT
  Recurring monthly cost:      $____ (itemised)
  One-off cost:                $____
  Cost per order impact:       $____
  What we are buying with it:  ____
  Cheaper alternative considered and why rejected: ____
```

This changes behaviour more than any dashboard. It does not require anyone to say no; it requires the number to exist. Most over-engineering dies quietly at the moment someone has to write "$4,900 a month" in a box.

**Showback, not chargeback.** Showback means each team sees its own cost, attributed by tag, in a dashboard, monthly. Chargeback means the cost is billed to the team's budget.

Showback works. It creates awareness and mild social accountability without turning cost into a weapon. Chargeback tends to produce gaming: teams hide costs in shared accounts, refuse to adopt shared platforms, and argue about allocation methodology instead of reducing spend. Start with showback, and only consider chargeback if the organisation genuinely needs the financial rigour.

**The cost checklist.** Run this quarterly. Each row is a specific question with a specific fix.

| Item | Typical waste | Fix | Expected saving |
|---|---|---|---|
| Over-provisioned pod requests | 40 to 60 percent of reserved CPU unused | Right-size from p95/p99 over 14 days | 20 to 40 percent of compute |
| x86 instances for Node.js | 20 to 30 percent premium | Migrate to Graviton with multi-arch images | 20 to 30 percent of compute |
| Non-production running 24/7 | 70 percent of hours idle | Scheduled scale-down nights and weekends | 60 to 70 percent of non-prod |
| Workers running continuously | 90 percent idle | KEDA scale-to-zero on queue depth | 70 to 90 percent of worker compute |
| On-demand database pricing | 35 to 60 percent premium | 1-year Reserved Instance or Savings Plan | 35 to 40 percent of database |
| Unused read replicas | A full instance each | Audit consumers, delete or downsize | $175 to $700 each |
| Unused indexes | Storage plus write amplification | `pg_stat_user_indexes.idx_scan = 0`, drop concurrently | Storage plus 10 to 30 percent write latency |
| Aurora Standard on write-heavy load | I/O charges exceeding the instance | Switch to I/O-Optimized above ~25 percent I/O share | 20 to 40 percent of Aurora spend |
| S3 without lifecycle rules | Everything in Standard forever | Tier to IA and Glacier; expire non-current versions and incomplete multiparts | 40 to 60 percent of S3 |
| Snapshot sprawl | Manual snapshots never deleted | `expires` tag plus a scheduled cleanup job | $100 to $500 |
| S3 traffic through NAT | $0.045 per GB avoidable | S3 gateway VPC endpoint (free) | $50 to $500 |
| Cross-AZ chatter | $0.02 per GB round trip | Topology-aware routing, rack-aware Kafka | 30 to 60 percent of transfer |
| Debug logging in production | 10x volume for no value | Runtime log levels, drop probe logs, redact bodies | 50 to 80 percent of log spend |
| Unbounded metric labels | Millions of series | Route patterns not URLs; ban id labels in review | 50 to 90 percent of custom metrics |
| 100 percent trace sampling | Vast span volume | 1 to 10 percent head sampling, 100 percent on errors | 80 to 95 percent of trace spend |
| Orphaned resources | Unattached EBS volumes, idle load balancers, old AMIs, unused EIPs | Monthly sweep by tag and last-used date | $100 to $1,000 |

#### How a Senior Backend Engineer thinks about this

They make the number visible and then get out of the way. Engineers are competitive and conscientious; a team that can see its own cost per order will optimise it without being told.

They run the review even in months when nothing changed, because the discipline is the point and the anomaly you catch is the one you were not looking for.

They put cost in the design template rather than in a policy document, because templates change behaviour and policies do not.

And they protect the practice from becoming a cost-cutting programme. The goal is efficiency, which means getting more per dollar, not spending fewer dollars. A team that doubles traffic on a flat bill has done outstanding work, and the review should say so.

## 50.9 Edge cases and failure modes

The specific ways cost goes wrong, each of which has happened to a real team.

- **A cost spike from a log loop.** A retry inside a `catch` block that logs the full error object, including the response body, on every attempt. One deploy, 40 GB an hour, $500 a day on ingestion and indexing. Fix: anomaly alerts with a daily threshold, log volume per service as a monitored metric with a budget, and a rule that error objects are logged once at the boundary, not at every layer.
- **Runaway autoscaling amplifying a retry storm.** A downstream dependency slows down; clients retry; request volume triples; the HPA scales from 8 to 24 pods; the extra pods open more connections to the struggling dependency and make it worse; the autoscaler keeps going. You pay 3x for compute *and* extend the outage. Fix: circuit breakers, bounded retries with jitter, load shedding, and a `maxReplicas` that reflects what the downstream can actually take (Part 30).
- **A forgotten load-test environment.** Someone clones production to run a capacity test before a launch. The launch happens. The environment stays. Eleven months and $18,000 later, an audit finds it. Fix: mandatory `expires` tags with a job that deletes or alerts on expiry, and ephemeral environments created by pipeline and destroyed on merge.
- **Cross-region replication egress.** S3 Cross-Region Replication charges per GB replicated *and* stores a second copy. A bucket receiving 30 TB a month of new objects, replicated, costs the transfer plus the duplicate storage indefinitely. Fix: replicate only the prefixes that need it, and check whether a cheaper DR posture (Part 49) meets the actual requirement.
- **S3 request charges from a polling loop.** A worker checks for a file's existence every second with `HeadObject`. That is 2.6 million requests a month per worker, which is small; but the same pattern applied per-tenant across 400 tenants is over a billion requests and thousands of dollars. Fix: S3 event notifications to SQS or EventBridge instead of polling. Push, do not poll.
- **A recursive Lambda.** A function writes to the S3 bucket that triggers it. Each invocation spawns another. Concurrency climbs to the account limit within minutes, and it can run for hours before anyone notices. Fix: never write into the triggering prefix, use separate buckets or prefixes for input and output, set a reserved concurrency limit on every function, and configure a billing alarm with a short evaluation period. AWS now has recursive-invocation detection, but do not rely on it as the only control.
- **Over-aggressive scale-down causing an outage.** Covered in 50.2's failure scenario, and worth repeating because it is the most common way a cost optimisation causes an incident: short scale-down windows and low `minReplicas` remove the capacity that absorbs the next burst.
- **Reserved capacity that no longer matches the workload.** A 3-year all-upfront reservation on `db.r6i` bought two months before the team migrates to Graviton, or a Savings Plan sized for a workload that then moves to Fargate. You keep paying. Fix: prefer 1-year no-upfront terms and Compute Savings Plans (which are flexible across instance family, size, region and Fargate/Lambda) over EC2 Instance Savings Plans; buy to 70 to 80 percent of your stable baseline, never to 100 percent; review coverage quarterly against the roadmap.
- **Unbounded queue retention.** A dead-letter queue with no retention limit and no consumer accumulates for years. Kafka topics with `retention.ms = -1` set "temporarily" during a migration. Both are storage bills that grow forever and, worse, mean a replay would process millions of messages nobody expects. Fix: explicit retention on every topic and queue, and a monitor for DLQ depth that alerts on growth rather than on an absolute number.
- **Developer database snapshots piling up.** Every engineer takes a manual snapshot before a risky change. Nobody deletes them. At $0.095 per GB-month against a 2 TB allocated database, forty of them is not free. Fix: `expires` tag enforced at creation, plus a weekly job that deletes expired manual snapshots and reports what it removed.
- **Cutting cost until resilience drops below the SLO.** The most important one on this list. Under a cost mandate, the easiest things to delete are the things that do nothing on a normal day: the standby instance, the extra replica, the backup retention, the staging environment, the distributed tracing, the over-provisioning headroom. Every one of them is insurance, and insurance looks like waste right up until the day it does not.

  The discipline that prevents it: **for every proposed cut, write down which SLO or recovery target it affects and by how much.** "Drop Multi-AZ: saves $880, changes database failover from 90 seconds to a 90 minute restore, which breaches our 30 minute RTO" is a decision the business can make. Silently dropping Multi-AZ is not a decision, it is an accident waiting for a date.

  A senior engineer's job in a cost-cutting exercise is to make the resilience trade-offs visible and to refuse the invisible ones. You will be right eventually, and being right after the incident is worth far less than being right before it.

## Senior Checklist — Part 50

- [ ] I understand the concept of cost as a non-functional requirement
- [ ] I can explain unit economics simply and compute cost per order for my system
- [ ] I can implement tagging, showback and a cost dashboard
- [ ] I understand the failure modes of cost optimisation, especially resilience loss
- [ ] I understand the scaling implications: which costs are baseline and which are marginal
- [ ] I understand the security implications of cost decisions, such as reduced backup retention
- [ ] I understand the operational implications: reviews, budgets, anomaly alerts
- [ ] I can choose between Lambda, Fargate, EC2 and Kubernetes on cost grounds
- [ ] I can explain the trade-offs of managed versus self-hosted with engineer time priced in
- [ ] I can answer senior-level interview questions on cloud cost
- [ ] I know the difference between Kubernetes requests and limits and which one I pay for
- [ ] I can find cross-AZ transfer, NAT per-GB and log ingestion as separate line items on my bill
- [ ] I know the Aurora I/O break-even and can check it for my workload
- [ ] I can identify unused indexes and idle read replicas in my database
- [ ] I put a monthly cost figure in every design document I write
- [ ] I can name what each proposed cost cut does to an SLO or a recovery target

## Part 50 — Key Takeaways

- Cost is a non-functional requirement decided by engineers at design time; the bill is a printout of your architecture.
- Track cost per order, per request or per user, not the total bill. The total moves with traffic and tells you nothing.
- Tag first, optimise second. Optimising without visibility deletes load-bearing things.
- In Kubernetes you pay for requests, not limits. Over-requested pods are the largest source of structural compute waste.
- Graviton, spot for interruptible work, scale-to-zero workers and shutting down non-production out of hours routinely cut compute by half with no resilience loss.
- Lambda is cheaper below roughly 30 to 50 RPS sustained and roughly an order of magnitude more expensive above it.
- Reserve your database capacity first: it is the most stable workload and the discount is the biggest zero-risk lever you have.
- Unused indexes and idle read replicas charge you twice, in storage and in write throughput; on Aurora Standard a bad query is billed per I/O.
- The three invisible line items are cross-AZ transfer, NAT gateway per-GB charges and log volume. The S3 gateway endpoint is free and removes a whole category of the second one.
- Caches and CDNs are arbitrage: cheap capacity replacing expensive capacity, and faster as well. Size the database for a cold cache, not a warm one.
- Microservices multiply the baseline: every service costs $90 to $1,000 a month before serving a request, and needs an on-call owner.
- The best architecture is the simplest one that meets the requirement. Complexity is paid for in attention, and attention is scarcer than money.
- Never cut cost without naming which SLO or recovery target it affects. Insurance looks like waste until the day it does not.
