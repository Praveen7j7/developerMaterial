## 62.6 Security questions

Security is not a phase at the end. It is four questions asked at design time, and they cost about ten minutes each. Part 44 — Security has the mechanisms; this section is the habit.

### 62.6.1 Who is allowed to call this?

#### Why the question matters

The most common serious vulnerability in real backend systems is not exotic. It is a missing authorisation check: an endpoint that verifies *who you are* and forgets to verify *whether this object is yours*. OWASP calls it broken access control, and it is number one on their list because it is everywhere.

#### How to actually answer it

For every endpoint, state two things: the authentication requirement, and the **object-level** authorisation rule. The second one is where bugs live.

```ts
// Authentication says "you are user 42". Authorisation says "order 918 is yours".
// The scoping must be in the query, not in an if-statement after the fetch,
// so that no future code path can skip it.
async findOne(orderId: string, actor: Actor): Promise<Order> {
  const order = await this.repo.findOne({
    where: actor.role === 'admin'
      ? { id: orderId }
      : { id: orderId, customerId: actor.userId },   // scoped in SQL
  });
  if (!order) throw new NotFoundException();          // 404, not 403: do not leak existence
  return order;
}
```

Then encode the rule where it cannot be forgotten: a guard, a repository that requires a tenant id, or PostgreSQL row-level security for multi-tenant systems.

#### Worked example

An invoicing endpoint was `GET /invoices/:id`, protected by a JWT guard. Any authenticated customer could read any invoice by incrementing the id, because the ids were sequential integers and the query was `findOne({ where: { id } })`. It was found by a customer who mistyped their own invoice number and saw someone else's company name. That is an IDOR, it is a reportable data incident in most jurisdictions, and it was one `where` clause.

The fix was the scoped query above plus a repository method that made the unscoped version unavailable. UUIDs would have made it harder to find but would not have fixed it: obscurity is not authorisation.

#### The mistake people make

Believing that "the frontend only shows the user their own invoices" is a control. The frontend is not a security boundary. Anything reachable with a token can be called with `curl`.

### 62.6.2 What if the input is hostile?

#### Why the question matters

Every input is attacker-controlled: body, query parameters, headers, file names, webhook payloads, message bodies from a queue, and data from a third-party API. If your code assumes shapes, sizes or contents, someone will eventually violate the assumption, deliberately or by accident.

#### How to actually answer it

Validate at the boundary with an allowlist, and set limits on everything that has a size.

```ts
// Validation is a contract, not decoration. Whitelist unknown fields away,
// bound every string and number, and never trust a client-supplied enum.
export class CreateOrderDto {
  @IsUUID('4') productId!: string;
  @IsInt() @Min(1) @Max(100) quantity!: number;
  @IsIn(['standard', 'express']) shipping!: 'standard' | 'express';
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}

// main.ts: forbidNonWhitelisted rejects extra fields instead of silently keeping them.
app.useGlobalPipes(new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, transform: true,
}));
```

Then the boundaries beyond the DTO: request body size limits, upload size and MIME validation, pagination `limit` capped server-side, rate limits per identity and per IP, `statement_timeout` so a pathological query cannot run forever, and parameterised SQL everywhere so no string concatenation touches a query.

The "hostile input" checklist I run mentally: empty, absent, wrong type, enormous, negative, zero, unicode with combining characters and right-to-left marks, deeply nested JSON, a valid value belonging to another tenant, and the same request sent 10,000 times per second.

#### Worked example

A product search endpoint accepted `?limit=`. Nobody capped it. A scraper sent `limit=1000000`, the query returned 400 MB of JSON, the Node process serialised it, heap went past the container limit, and the pod was OOMKilled. Three pods died in sequence as the scraper retried. The fix was `Math.min(limit ?? 20, 100)` and a rate limit, which is about as cheap as a fix gets.

#### The mistake people make

Validating only the fields the happy path reads. The attack is always in the field you did not think about: the `sort` parameter interpolated into an `ORDER BY`, the file name used to build a path, the webhook payload trusted because "it comes from Stripe" without verifying the signature.

### 62.6.3 What data does this expose?

#### Why the question matters

Data leaks more often through carelessness than through attacks: an entity serialised whole into a response, a debug log containing a full request body with a card token, an error message returning a stack trace with a connection string.

#### How to actually answer it

Classify the fields, then make exposure explicit. Return DTOs, never entities. Redact in the logger, not at each call site.

```ts
// Serialisation is an allowlist: the response contains what you listed, nothing more.
export class OrderResponseDto {
  @Expose() id!: string;
  @Expose() status!: string;
  @Expose() totalCents!: number;
  // internalNotes, costPrice, fraudScore and customerEmail are simply not here.
}

// One redaction config beats a hundred careful log calls.
pino({ redact: ['req.headers.authorization', 'req.body.password', '*.cardNumber', '*.token'] });
```

Also ask what the *aggregate* exposes. An endpoint returning one order is fine. The same endpoint with `?limit=1000` and no tenant scoping is a data export. Rate limits and pagination caps are privacy controls, not just performance controls.

#### Worked example

An internal admin API returned the full user entity, including the bcrypt password hash and a password reset token, because it did `return user`. The endpoint was internal-only, behind VPN, and low risk in theory. Then a frontend engineer cached the response in the browser to speed up a table, and the hashes ended up in local storage on every admin laptop. Nobody was malicious at any point. The response DTO would have made it impossible.

#### The mistake people make

Returning entities from controllers. It works, it is fast to write, and it means that every future column added to that table is automatically published to your API. Someone will add `internal_risk_score` in eight months and never think about the endpoint.

### 62.6.4 What happens if this token or key leaks?

#### Why the question matters

Credentials leak. They end up in Git history, in CI logs, in Slack messages, in a screenshot, in a browser extension, in a laptop that was stolen. The question is not prevention alone; it is **containment and recovery**.

#### How to actually answer it

For every credential, answer four things: what can it do, how long is it valid, how would we know it leaked, and how fast can we rotate it.

| Credential | Scope it should have | Lifetime | Rotation |
|---|---|---|---|
| User access token (JWT) | One user, minimal claims | 5–15 minutes | Refresh token rotation, revocation list in Redis |
| Refresh token | One user, one device | Days, one-time use | Rotate on every use; reuse detection revokes the family |
| Service-to-service credential | One service, specific actions | Short, issued by the platform | Automated; no human ever holds it |
| Database password | One role, least privilege | Long-lived if unavoidable | Secrets manager, rotation runbook tested twice a year |
| Third-party API key | Restricted by IP or scope where the provider allows | Long-lived | Two keys supported at once so rotation is not an outage |

The design rule that follows: **short lifetimes and small scopes make leaks survivable**. A 15-minute access token that leaks is a small incident. A never-expiring admin API key that leaks is a company incident.

#### Worked example

A junior engineer pasted a `.env` file into a public GitHub gist for a friend to help debug. The database credentials were in it. Automated scanners found it in under four minutes; we saw connection attempts from three countries within ten. What saved us was that the database was not publicly reachable, the credentials were for a role with `SELECT` only on two tables, and rotation was a documented 90-second procedure we had practised. It was a bad afternoon, not a catastrophe.

The lesson is not "train people not to paste secrets", though we did that too. It is that the blast radius of a leaked credential is a design decision you make months earlier.

#### The mistake people make

Treating rotation as theoretical. If you have never rotated a credential, you do not know that three services read it from a config file baked into an image at build time, and rotation will be a four-hour outage. Rotate something on a calm Tuesday and find out.

#### Interview questions

1. **"How would you prevent IDOR across an entire codebase, not one endpoint?"** Expected: repository-level tenant scoping, a guard that requires an explicit policy per route, row-level security, and tests that assert cross-tenant access returns 404.
2. **"A customer's JWT leaks. Walk me through the impact and the response."** Expected: token lifetime, what claims it carries, revocation mechanism, refresh token reuse detection, and how you would detect abuse.
3. **"Where does validation belong in a NestJS app, and why not in the service?"** Expected: at the boundary via `ValidationPipe` and DTOs so unvalidated data never enters the domain; services still assert invariants that DTOs cannot express.

## 62.7 Business questions

Engineers who ask only technical questions get overruled by people who ask business ones. Engineers who ask both get to decide the architecture. These four questions are how you make a technical argument in a language that survives contact with a budget.

### 62.7.1 What does this complexity actually cost?

#### Why the question matters

"It's just one more service" is never just one more service. Naming the cost in units the business understands converts an aesthetic argument into a decision.

#### How to actually answer it

Cost has four columns, and you should be able to fill them in for any proposal:

| Cost type | How to estimate it | Example for "add Kafka" |
|---|---|---|
| Engineer time to build | Person-weeks, honestly | 3 weeks for the first producer and consumer, done properly |
| Ongoing operations | Hours per month plus who is on call | ~4 h/month steady state, more during upgrades; a new alert class |
| Cloud spend | Monthly bill, with the growth curve | 3-broker managed cluster from ~$700/month, plus network |
| Onboarding | Days added to a new hire's ramp-up | +2 days per engineer, forever, plus a permanent skill dependency |

#### Worked example

A team proposed splitting a well-functioning modular monolith into six services. The technical argument was "independent deployability". Writing out the costs gave: 14 person-weeks of migration, six pipelines, six sets of dashboards and alerts, distributed tracing that they did not have yet, a jump from one database to four, and an estimated $1,900 per month extra infrastructure. Against that, the benefit was that the two teams could deploy without coordinating, which was currently costing them roughly one hour per week of friction.

Fourteen weeks to save one hour per week pays back in 14 years of hours. Stated that way, the team themselves chose a smaller change: fix the 50-minute pipeline, split the deployment into two services along the one boundary that was genuinely painful, and stop. That took three weeks and captured most of the benefit.

#### The mistake people make

Comparing only build cost. The ongoing costs dominate over a system's lifetime, and they are the ones that quietly consume a team's capacity until it can no longer ship features.

### 62.7.2 Does the business actually need it?

#### Why the question matters

Engineers build for imagined requirements more often than they admit: multi-region for a company with customers in one country, a plugin architecture for an integration nobody has requested, 99.99 percent availability for an internal tool used by 30 people during office hours.

#### How to actually answer it

Ask for the requirement in numbers, and ask what happens if it is not met. "We need high availability" becomes "how many minutes of downtime per month is acceptable, and what does an hour of downtime cost us?" 99.9 percent is 43 minutes per month and is achievable with a well-run single-region setup. 99.99 percent is 4 minutes and typically means multi-region, which is a different engineering budget entirely, often 3-5x.

If nobody can answer what an outage costs, the requirement is a feeling, and you should design for the feeling cheaply.

#### The mistake people make

Accepting a non-functional requirement without a number, then spending six months delivering an expensive interpretation of it. Ask for the number. It is usually smaller than you feared, and occasionally much bigger, which is equally important to know.

### 62.7.3 What is the cost of being wrong versus the cost of being slow?

#### Why the question matters

This is the deepest business question in engineering, and it decides how much rigour a project deserves. Both errors are real: shipping something wrong costs money and trust; shipping late costs opportunity and sometimes the whole business.

#### How to actually answer it

Put the two costs next to each other:

- **Cost of being wrong**: is it reversible? Does it corrupt data? Does it move money? Does it expose customer data? Is it visible to customers or to one internal team?
- **Cost of being slow**: is there a deadline tied to revenue, a competitor, a contract, a regulatory date, or a seasonal peak? What is the cost of a month?

High wrong-cost plus low slow-cost means take the extra week: payments, auth, migrations, anything with customer data. Low wrong-cost plus high slow-cost means ship it behind a flag and learn: a new UI feature, an experiment, an internal tool.

#### Worked example

Two projects in the same quarter. A new recommendation widget: wrong-cost low (worst case, poor recommendations, revert the flag), slow-cost moderate (it was tied to a campaign). We shipped it in nine days with thin tests and a kill switch. A change to how refunds are calculated: wrong-cost very high (money, finance reconciliation, regulatory reporting), slow-cost low (no deadline). We spent three weeks, wrote a design doc, had finance review the rules, ran a shadow calculation against 90 days of historical refunds before switching, and found four edge cases in the process.

Same team, same quarter, deliberately different levels of rigour. Applying the recommendation-widget process to refunds would have been negligent. Applying the refund process to the widget would have wasted a fortnight.

#### The mistake people make

Having one speed. Some engineers are careful about everything and are seen as slow; some are fast about everything and are seen as risky. The senior skill is varying deliberately and being able to explain why.

### 62.7.4 What would we build if we had half the time?

#### Why the question matters

It is the fastest way to find the actual core of a project. Under a hard constraint, people stop defending nice-to-haves and reveal what they think really matters. It works on your own designs too.

#### How to actually answer it

Ask it literally, in the design review: "if this had to ship in three weeks instead of six, what would we cut?" Write the answer down. Then ask the harder follow-up: "why are we building those things at all in the six-week version?" Sometimes there is a good reason. Often the six-week version was padded with speculative flexibility.

#### Worked example

A returns-management project was scoped at eight weeks: a rules engine for return eligibility, an admin UI, automated refund processing, a customer self-service portal, and integration with three carriers. The half-time answer was: eligibility rules hardcoded for the two policies that cover 96 percent of returns, no admin UI (a support tool already existed), automated refunds only under a threshold, one carrier.

We shipped the four-week version. Six months later we had added a second carrier and raised the refund threshold. The rules engine, the admin UI and the portal were never built, because usage data showed they were not the bottleneck. Four weeks saved, and a smaller system to maintain forever.

#### The mistake people make

Treating the half-time version as a lesser thing to be ashamed of. Often it is the correct product, and the full version was a plan built on assumptions nobody had tested.

#### Practical exercise

Take a design you are currently working on. Write the four-column cost table for its most complex component, get the actual monthly cloud number from your provider's calculator, and write the half-time version in one paragraph. Acceptance criteria: you can present both to a product manager in five minutes, and you have a defensible recommendation rather than a preference.
