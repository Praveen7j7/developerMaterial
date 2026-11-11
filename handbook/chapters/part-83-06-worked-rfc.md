## 83.6 Worked example: a full RFC for event-driven order notifications

We have referred to this RFC throughout the Part. Here it is in full, as a single artifact you can read end to end and use as a template. It is written at the length a real RFC of this size would be — long enough to decide on, short enough to read in one sitting. Read it as a reader would, then read the annotations after it.

#### Artifact example

```markdown
# RFC-114: Move order notifications to an event-driven pipeline

**Status:** Proposed
**Author:** [you]
**Reviewers:** order team, notifications team, mobile, platform, director
**Created:** 2026-02-20
**Decision meeting:** 2026-03-12
**Supersedes:** none

## Summary and ask

Today the order service calls the notification service synchronously on
every order event. This couples order placement to notification health:
when notifications degrade, orders degrade. We propose writing
notification intents to an outbox table in the order transaction, relaying
them to a Kafka topic, and consuming them asynchronously.

**Ask:** approve this design and the allocation of 2 engineers for ~5 weeks.

## 1. Context

POST /orders currently does, synchronously:
1. Validate and persist the order (PostgreSQL).
2. Call POST notification-service/send (HTTP) for the "order placed"
   notification, awaiting the response.

Measured, last 30 days:
- POST /orders p50 = 190 ms, p99 = 820 ms.
- Of the p99, ~340 ms is the notification call.
- 2 partial order outages caused by notification degradation:
  INC-3391 (notification DB slow, 22 min, ~4,100 orders delayed),
  INC-3407 (notification deploy, 11 min, ~1,900 orders failed outright).

The coupling is the problem. Notifications are not order-critical, but
today they can fail an order.

## 2. Goals

- Remove the notification call from the order hot path. Target POST
  /orders p99 < 480 ms.
- No order should ever fail because notifications are degraded.
- No notification intent lost if the order transaction committed.

## 3. Non-goals

- NOT changing notification content or templates.
- NOT building a company-wide event bus.
- NOT guaranteeing exactly-once (at-least-once + idempotent consumer).
- NOT migrating SMS in this phase (different provider; stays sync).

## 4. Requirements

- Throughput: 1,200 order events/sec peak (measured peak 1,050 + 15%).
- End-to-end notification delivery p95 < 10 s (relaxed from sync; fine).
- Delivery: at-least-once. Lost "order shipped" unacceptable; rare
  duplicate acceptable.
- Ordering: per order (placed -> shipped -> delivered). None across orders.
- Durability: intent must survive if the order committed.

## 5. Proposed design

In the order-placement transaction, write the order AND a row to an
`outbox` table. A separate Outbox Relay worker polls unsent rows,
publishes them to Kafka topic `order.events.v1` (partitioned by
order_id), and only after Kafka acknowledges, marks the row sent. A daily
sweep deletes sent rows older than 7 days. The notification service
consumes the topic and sends notifications, deduplicating on
(order_id, event_type) so a redelivery does not double-send.

[container diagram — see §51.5]

outbox table:
  id BIGSERIAL PK, aggregate_id UUID, event_type TEXT,
  payload JSONB, created_at TIMESTAMPTZ, sent_at TIMESTAMPTZ NULL
  INDEX on (sent_at) WHERE sent_at IS NULL   -- find unsent fast

## 6. Alternatives considered

A. Sync + circuit breaker — drops notifications when open; no durability.
B. Fire-and-forget async HTTP — dual-write, loses intent on crash.
C. RabbitMQ instead of Kafka — genuinely close; chosen Kafka because
   platform is standardising on it and 2 more consumers are likely in a
   year. If that slips, RabbitMQ wins. Confirmed with platform (see log).
(Full write-up in §51.4.)

## 7. Tradeoffs

- We gain decoupling and durability; we accept eventual consistency
  (notification up to ~10 s after order, vs synchronous today).
- We add an outbox relay and a Kafka consumer to our operational surface.
- Duplicate notifications become possible (idempotent consumer makes
  them rare and harmless).

## 8. Risks and mitigations

- Relay crash -> notifications delayed. Mitigation: alert on oldest
  unsent-row age > 60 s.
- Relay deletes before Kafka ack -> lost intent. Mitigation: ack THEN
  mark sent; sweep deletes only sent rows.
- Consumer lag under peak. Mitigation: alert on consumer lag; topic
  partitioned so we can scale consumers.

## 9. Rollout

1. Ship outbox write behind flag `notifications.transport=outbox`, but
   KEEP the sync call too (dual-run). Compare.
2. Shadow: relay publishes, notification service consumes and logs but
   does NOT send (sync still sends). Verify events match.
3. Ramp: flip consumers to send, sync call to no-op, at 1% -> 10% ->
   50% -> 100% over a week.

## 10. Rollback

Flip `notifications.transport` back to `sync`. Under 5 min. Outbox rows
are retained; un-relayed rows are swept, not re-sent, so no double-send
on rollback (see comment #5 resolution).

## 11. Observability

- Metric: POST /orders p99 (goal < 480 ms).
- Metric: oldest unsent outbox row age (alert > 60 s).
- Metric: Kafka consumer lag on order.events.v1 (alert > 30 s).
- Metric: notification send success rate per event_type.
- Log: every relay publish and consumer dedupe-skip, with order_id.

## 12. Cost

Negligible marginal Kafka cost (existing cluster, ~1,200 msg/s). One new
worker (shares existing node pool). Net: lower infra pressure on the
order service primary, which was absorbing notification-call connection
load.

## 13. Open questions

- Do we backfill the outbox for in-flight orders at cutover, or accept a
  brief window where old orders use sync? Leaning: accept the window.
- Retention of 7 days for sent outbox rows — enough for replay/debug?
  Confirm with notifications team.
```

#### Why this RFC works

Read it again with the craft in mind and notice the moves.

The **summary and ask** are first, and they stand alone. A director who reads only the summary knows what is being proposed, why, and what it costs (2 engineers, 5 weeks). Everything else is for people who need more.

The **context** proves there is a problem before proposing anything. It names two real incidents with durations and order counts. A reviewer finishes section 1 already agreeing something must change, which means the rest of the document is answering "which fix" rather than "is there a problem".

The **goals** are numbers (p99 < 480 ms), so success is checkable. The **non-goals** pre-empt four entire branches of review argument — SMS, exactly-once, company event bus, template changes — before anyone raises them.

The **requirements** do design work: the ordering requirement forces partitioning by order_id, which then appears in the design. The reader can trace each design choice back to a requirement.

The **alternatives** are honest, and option C openly admits the deciding factor is an organisational bet, not technical superiority. That honesty makes the whole document trustworthy.

The **rollout** is staged with a shadow phase, so the new path is proven to match the old before it takes over. The **rollback** is specific, fast, and — crucially — addresses the double-send edge case a reviewer raised, showing the review changed the design. The **observability** section names the exact metrics and alert thresholds, so the system ships with its monitoring rather than bolting it on after the first incident.

And the **open questions** are honest. The author does not pretend to have resolved the backfill question; naming it makes the document more credible, and it gives the decision meeting something concrete to settle.

#### Real-world scenario

This RFC, in a real company, would go through the process from 83.4. The author pre-wires the platform lead (to confirm the Kafka bet), the notifications lead (to confirm the consumer design and retention), and the order lead (to confirm the outbox cleanup). By the time it opens for review, those three are supporters. The public review surfaces the three blocking items from the 83.5 checklist — oldest-unsent alert, relay-delete ordering, rollback double-send — all of which the author fixes, visibly, in the comment-resolution log. The decision meeting is twenty minutes and ends in acceptance. Total elapsed time: about three weeks from draft to accepted, most of it waiting for async review, almost none of it in meetings.

#### Practical exercise

Take a change you want to make that affects at least one team other than your own. Write it up as an RFC using the exact thirteen-numbered-section structure above. Enforce three rules on yourself: the summary and ask must stand alone and fit on one screen; every goal must have a number; and the alternatives section must contain at least one option you can imagine a reasonable colleague preferring.

**Acceptance criteria:** a reviewer from another team can read only your summary and know what you want and what it costs; every design choice in section 5 can be traced to a requirement in section 4; and your rollback in section 10 is specific enough that an on-call engineer could execute it at 2 a.m. without asking you anything.
