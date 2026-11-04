## 45.20 Observability and SRE

### Q239. Metrics, logs and traces — what is each for?

- **Expected answer** — **Metrics** are cheap, aggregated numeric time series: they tell you *that* something is wrong and are what you alert on, because they are low cardinality, cheap to store for a long time and fast to query. **Logs** are discrete events with detail: they tell you *what happened* for a specific request, and they are where you look once metrics point you somewhere. **Traces** connect the spans of a single request across services: they tell you *where* the time went and which hop failed, which is the fastest path from "the API is slow" to a specific dependency. The three are complementary and the workflow between them is what matters: an alert fires on a metric, you open the dashboard to see the scope, you jump to exemplar traces for slow or failing requests, and then to the logs for that trace id. That linkage — trace id in every log line, exemplars linked from metrics — is what turns three tools into one investigation, and its absence is why teams with all three still take an hour to diagnose. Add profiles as a fourth signal when you can, since continuous profiling answers "which code" the way tracing answers "which service".

- **Why it matters** — Owning production means being able to answer questions quickly, not having tools installed.

- **Follow-ups** — What links your logs to your traces? Why not alert on logs? What would you add first to a service with none of these?

- **Senior signal** — Describes the investigation workflow and the linkage between signals, not a list of tools.

### Q240. What does good logging look like in a Node service?

- **Expected answer** — Structured JSON to stdout, one object per line, with the platform handling collection — never log files inside a container, and never `console.log` in production code. Every line carries a consistent set of fields: timestamp, level, service, version, environment, `trace_id`/`span_id`, `request_id`, `user_id` or `tenant_id` where applicable, and the message plus structured context (`{ orderId, durationMs, statusCode }`) rather than an interpolated sentence you cannot query. Levels used with discipline: `error` for things a human must act on, `warn` for recoverable anomalies, `info` for business-significant events (order created, payment captured), `debug` off in production but enablable per-request or per-service without a redeploy. Correlation is the essential part: generate or accept a request id at the edge, propagate it with `AsyncLocalStorage` so every log line and every downstream call carries it, and return it to clients in the error body so a support ticket maps to logs instantly. And redact: never log tokens, passwords, card numbers, full request bodies with PII, or connection strings — with a redaction list in the logger, not a rule in a wiki. Finally, treat volume as a cost: sample high-frequency success logs, keep errors unsampled.

- **Why it matters** — Logging is the tool used most during an incident and the one most often useless.

- **Follow-ups** — How does a log line get a trace id in NestJS? What would you sample and what never? How do you enable debug logging for one customer?

- **Senior signal** — `AsyncLocalStorage` correlation, structured context over interpolated strings, and redaction as code.

### Q241. Explain distributed tracing and how you would instrument a NestJS service.

- **Expected answer** — A trace is a tree of **spans**, each with a start time, duration, attributes and a parent; the root span is created at the entry point and context is propagated to downstream calls through headers (W3C `traceparent`). With OpenTelemetry, the Node SDK auto-instruments HTTP, `pg`, Redis, and common libraries, so you get a useful trace with very little code; you then add manual spans around meaningful business operations and attach attributes (`order.id`, `tenant.id`, `payment.provider`) so traces are searchable by things you care about. Propagation is the part that breaks: an async boundary that loses context — a queue message, a `setTimeout`, a worker thread — needs the trace context carried explicitly in the message envelope and re-attached in the consumer, or your trace stops at the producer. Sampling is the cost control: head-based sampling at 1–10% is cheap but misses rare slow requests; tail-based sampling decides after the fact and can keep all errors and all slow traces, which is what you actually want, at the cost of running a collector that buffers. Also emit exemplars linking metrics to traces, and always sample errors at 100%.

- **Why it matters** — Tracing is the highest-leverage observability investment in a multi-service system.

- **Follow-ups** — How do you propagate context through a Kafka message? What sampling strategy do you use and why? What attributes make traces searchable?

- **Senior signal** — Async-boundary context propagation and tail-based sampling with errors always kept.

### Q242. Which metrics do you export for a service?

- **Expected answer** — Use RED for request-driven services: **Rate** (requests per second), **Errors** (failed requests, split by 4xx and 5xx because they mean different things), **Duration** (a latency histogram), each labelled by route and method. Use USE for resources: **Utilisation**, **Saturation**, **Errors** — for a Node service that means CPU, memory and heap, event loop lag, database pool in-use and waiting counts, HTTP agent socket counts, and per-dependency call rate and latency. Then the business and pipeline metrics that actually tell you the system is doing its job: orders created per minute, payment success ratio, queue depth and consumer lag, job success and failure counts, and the age of the oldest unprocessed item. That last category is what catches the failures no infrastructure metric sees — every pod healthy, CPU fine, and zero orders for twenty minutes because a feature flag or an upstream broke. Keep labels low-cardinality (route templates like `/orders/:id`, never raw URLs with ids), export from every instance and aggregate centrally, and make sure the histogram buckets match your SLO thresholds so you can compute the SLI directly.

- **Why it matters** — The right metric set determines whether you detect incidents or hear about them from customers.

- **Follow-ups** — What business metric would have caught your last incident? Why split 4xx from 5xx? How do you choose histogram buckets?

- **Senior signal** — Insists on business-level metrics and matches histogram buckets to the SLO.

### Q243. Why do people compute percentiles wrong?

- **Expected answer** — Two classic mistakes. First, **averaging percentiles**: taking p99 from each of 20 pods and averaging them gives a number with no statistical meaning; the correct approach is to export a **histogram** (bucketed counts) from each instance, sum the buckets centrally, and compute the quantile from the merged histogram — which is what Prometheus `histogram_quantile` over `rate(..._bucket[5m])` does. Summaries, by contrast, compute quantiles client-side and therefore cannot be aggregated across instances, which is the main reason to prefer histograms in a distributed system. Second, **bucket resolution**: a histogram can only give you an answer within its bucket boundaries, so if your buckets jump from 1 s to 10 s, a p99 in that range is a linear interpolation and essentially a guess — choose buckets around your SLO thresholds (for a 300 ms target, have boundaries at 100, 250, 300, 500, 1000 ms). Related traps: computing a percentile over too short a window on low-traffic endpoints, where a handful of requests makes p99 meaningless; and forgetting that p99 over 5 minutes at 10 requests per second is the 30th-slowest request, so it moves a lot.

- **Why it matters** — Wrong percentile math silently invalidates dashboards and SLOs.

- **Follow-ups** — Histogram or summary, and why? Where would you put buckets for a 200 ms SLO? What is wrong with p99 on a low-traffic endpoint?

- **Senior signal** — Histograms for aggregatability plus bucket placement tied to the SLO — details that only come from building this.

### Q244. What is metric cardinality and why does it matter?

- **Expected answer** — Cardinality is the number of distinct label-value combinations, and each combination is a separate time series to store, index and query. Adding a `user_id` label to a metric with a million users creates a million series; adding a raw URL with ids does the same; combining `endpoint` x `status` x `region` x `customer` multiplies. The consequences are practical and expensive: the metrics backend's memory grows with active series, queries slow down, ingestion costs rise steeply, and in the worst case a single bad deploy that adds a high-cardinality label takes down the monitoring system — which is especially painful because it happens exactly when you need it. Rules: labels must be bounded and enumerable (route template, method, status class, service, environment, version); anything unbounded (ids, emails, full URLs, error messages, timestamps) belongs in logs or traces, not in metric labels. If you need per-customer visibility, either restrict it to your largest few tenants with an explicit allow-list, or answer that question with traces and logs. Set limits and alerts on series count per job so you find out before the bill or the outage.

- **Why it matters** — Cardinality explosions are a common self-inflicted observability outage.

- **Follow-ups** — How would you get per-tenant latency without exploding cardinality? What limits would you configure? What is the cost model of your metrics backend?

- **Senior signal** — Offers a concrete alternative for high-cardinality questions rather than just saying "do not do it".

### Q245. Define SLI, SLO and error budget, and how you would set them.

- **Expected answer** — An **SLI** is a measured indicator of user-visible behaviour — for example the proportion of requests to the checkout API that succeed in under 300 ms, measured at the load balancer. An **SLO** is the target for that indicator over a window, such as 99.9% over 28 days. The **error budget** is the allowed shortfall: 99.9% over 28 days is about 40 minutes of full unavailability, or an equivalent amount of partial degradation. Setting them: start from what users actually feel — availability and latency of the critical journeys, not CPU — pick a small number (two or three per service), measure current performance for a few weeks before committing to a number, and choose a target you can actually meet, because an SLO nobody meets is ignored and an SLO always met is too loose to inform decisions. The point is the *decision rule* it creates: budget remaining means you can take deployment risk and ship features; budget exhausted means you stop feature work and spend on reliability. That makes reliability a negotiated, visible trade-off with the business rather than an argument between engineering and product. Alert on **burn rate** (a fast burn over an hour for pages, a slow burn over days for tickets), not on every individual error.

- **Why it matters** — SLOs are how senior engineers make reliability a decision instead of a debate.

- **Follow-ups** — What does 99.9% mean in minutes? What happens when the budget is exhausted? Why alert on burn rate rather than error count?

- **Senior signal** — Frames the error budget as a decision rule and knows multi-window burn-rate alerting.

### Q246. How do you design alerts people will not ignore?

- **Expected answer** — Alert on **symptoms**, not causes: page on "checkout error rate above threshold" or "SLO burn rate is high", not on "CPU above 80%", because high CPU may be harmless while a silent failure at low CPU is an outage. Every page must be **actionable** and **urgent** — if the responder's correct action is "acknowledge and look at it tomorrow", it is a ticket, not a page. Include context in the alert itself: what is broken, which service and environment, the current and threshold values, a link to the dashboard and the runbook, and recent deploys. Use multi-window burn-rate alerting so a brief blip does not page and a slow steady burn still does. Ruthlessly delete or fix alerts that fire repeatedly without action, because alert fatigue is the real failure mode — an on-call engineer receiving 30 pages a week stops reading them, and the one that mattered is lost. Track pages per on-call shift as a metric the team owns and treat a rising number as a defect. Also alert on *absence*: no orders in 15 minutes, a nightly job that did not report success, a queue that stopped being consumed — silent failures produce no errors at all.

- **Why it matters** — Alert quality determines whether on-call is sustainable and whether incidents are caught.

- **Follow-ups** — Give me an example of a cause-based alert you would delete. How do you detect a silent failure? What is an acceptable number of pages per week?

- **Senior signal** — Symptom-based alerting, alerting on absence, and treating alert volume as a tracked defect.

### Q247. What belongs on a service dashboard?

- **Expected answer** — One dashboard that answers "is this service healthy and, if not, where is the problem?" in about thirty seconds, arranged top to bottom from user-visible to internal. Top row: SLO status and error budget remaining, request rate, error rate split by class, and latency percentiles — the RED signals. Second row: dependencies — database query latency and connection pool usage, cache hit ratio, external API latency and error rate, queue depth and consumer lag. Third row: runtime and resources — CPU, memory and heap, event loop lag, GC time, pod count and restarts. Overlay **deploy and config-change annotations** on every graph, because "what changed" is the first question in every incident and a vertical line answers it instantly. Keep it to one screen; a dashboard with 60 panels is a dashboard nobody reads. Have a second, deeper dashboard for investigation, and keep the top-level one stable so people build muscle memory. The test I apply: hand it to someone who has never seen the service and ask them to tell you whether it is healthy — if they cannot, it is decoration.

- **Why it matters** — Dashboards are used under stress; design for that.

- **Follow-ups** — What is missing from most dashboards you have seen? Why annotate deploys? How do you keep dashboards from rotting?

- **Senior signal** — Deploy annotations, one-screen discipline, and the "can a stranger read it" test.

### Q248. Walk me through how you run an incident.

- **Expected answer** — Declare it early — under-declaring costs far more than over-declaring. Assign roles even in a small team: an **incident commander** who coordinates and decides (and does not debug), one or two people investigating, and a **communications** role posting updates on a cadence, say every 15–30 minutes, to a single channel so stakeholders stop interrupting the responders. **Mitigate before diagnosing**: roll back the recent deploy, disable the feature flag, scale up, shed load, fail over — restoring service is the goal, and root cause can wait. Form explicit hypotheses and test them one at a time rather than several people changing things simultaneously; record every action with a timestamp in the channel, which becomes the timeline for the postmortem and prevents "did anyone already restart that?". Keep a bias toward reversible actions, and if a change does not help, revert it before trying the next. When the symptom is resolved, say so explicitly, keep monitoring for a defined period, and only then stand down. Then schedule the postmortem while it is fresh. The two most common failures are not declaring soon enough and debugging in a group with no coordination.

- **Why it matters** — Incident handling is a directly observable senior behaviour.

- **Follow-ups** — Who makes the call to roll back? What do you tell stakeholders at 20 minutes with no diagnosis? How do you avoid three people changing things at once?

- **Senior signal** — Mitigate-first, explicit roles, and a written timeline as you go.

### Q249. What makes a good postmortem?

- **Expected answer** — Blameless, factual and actionable. Blameless means the analysis targets the system, not the person: "the deploy pipeline allowed a migration with no lock timeout to reach production" rather than "X ran a bad migration" — because in a blaming culture people hide information and you lose the ability to learn. Contents: a plain-language summary, customer impact quantified (how many users, how long, what they experienced, revenue where relevant), a detailed timeline from first symptom to resolution including detection and mitigation times, contributing factors (plural — real incidents have several, and "human error" is never a root cause but a prompt to ask why the system permitted it), what went well, and action items. The action items are where most postmortems fail: each needs an owner, a due date and a ticket, they should be prioritised by whether they prevent, detect faster, or mitigate faster, and someone must track completion — a document full of unowned "we should" items is theatre. Two metrics worth tracking across incidents: time to detect and time to mitigate, since improving detection often has a bigger effect than preventing the specific cause, which rarely recurs identically.

- **Why it matters** — Whether an organisation learns from failure is largely decided by this document.

- **Follow-ups** — What do you do when the action items are never completed? How do you handle a postmortem where someone clearly made a mistake? What do you measure across incidents?

- **Senior signal** — Multiple contributing factors, owned and tracked actions, and detect/mitigate time as improvement targets.

### Q250. What does "production ready" mean to you?

- **Expected answer** — A checklist I would actually apply before a service takes real traffic. **Correctness and safety**: input validation, authorization on every endpoint including object-level checks, idempotency on anything that creates or charges, database constraints for the real invariants. **Resilience**: timeouts on every outbound call, bounded retries with jitter, circuit breakers on critical dependencies, graceful shutdown with readiness-first draining, and known behaviour when each dependency is down. **Operability**: structured logs with correlation ids, RED metrics plus business metrics, tracing, a dashboard, symptom-based alerts tied to an SLO, and a runbook for each alert. **Deployability**: automated CI with tests, reversible migrations using expand-and-contract, a rolling deploy, and a rollback that has been executed at least once rather than assumed. **Capacity and cost**: a load test establishing per-instance capacity, resource requests and limits set from measurements, autoscaling configured, and a cost estimate. **Security**: no secrets in the image or repository, least-privilege credentials, dependency scanning, TLS everywhere. **Data**: backups with a tested restore and a retention policy. Nothing on that list is exotic, and shipping without it is how a team ends up owning a service they cannot operate.

- **Why it matters** — It is the single best summary of whether someone has actually run systems in production.

- **Follow-ups** — Which item is most often missing in your experience? What would you cut for an internal tool? How do you enforce this without it becoming bureaucracy?

- **Senior signal** — Answers as a concrete checklist with scars behind each item, and can say which parts are negotiable for which risk level.
