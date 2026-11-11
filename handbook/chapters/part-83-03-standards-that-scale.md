## 83.3 Standards that scale

#### Concept

Standards are the shared conventions that let services across an org interoperate and be operated together: a standard API shape, a standard event schema format, a standard error format, standard logging and metrics conventions, standard naming. A standard that scales is one that is *enforced by infrastructure* (the paved road and automated checks) rather than by documents and goodwill, is *minimal* (covering only what genuinely benefits from being shared), and is *owned* (someone maintains and evolves it). A standard that lives only in a wiki page is not a standard; it is a suggestion that decays.

#### Why does it exist?

Imagine debugging an incident spanning six services where each logs differently — one logs plain text, one logs JSON with a `msg` field, one with a `message` field, none include a trace ID, and timestamps are in three different timezones. Correlating the incident across services is nearly impossible; you cannot grep for a request's journey because there is no common field to grep for. Now imagine the same six services all logging structured JSON with a `trace_id`, `level`, `service` and `msg`, all in UTC. You filter by `trace_id` and see the entire request's path across all six in one query. The standard is the difference between a debuggable system and an opaque one.

Standards exist to make a fleet of services behave like one coherent system for the purposes that matter: debugging, monitoring, client integration, and operation. Without them, every cross-service activity pays a translation tax forever.

#### Mental model

Imagine shipping containers. Before the standard shipping container, every cargo was loaded and unloaded by hand in a different shape, and moving goods between ship, train and truck was slow and manual. The standardised container — one size, one set of fittings — made the whole global logistics system interoperable: any crane, any ship, any truck handles any container. The container standard did not constrain what you put *inside* it (that is still your business); it standardised only the *interface* so everything could interoperate. Good software standards are the same: they standardise the interface (error format, log shape, API conventions) so the fleet interoperates, while leaving the internals (your domain logic) entirely up to you.

#### How it works

The standards worth having, and what each enables:

| Standard | What it fixes | What it enables |
|---|---|---|
| API conventions (REST shape, status codes, pagination) | Every service's API is subtly different | Clients and gateways handle all services uniformly |
| Error format | Forty error shapes | Uniform error handling, debuggable incidents |
| Event schema format | Events that can't be consumed generically | Any consumer can parse any event; schema registry |
| Logging conventions (structured, trace_id, fields) | Un-correlatable logs | Grep a trace across the whole fleet |
| Metrics conventions (naming, labels) | Dashboards that don't compose | One dashboard template works for every service |
| Naming (services, topics, resources) | Chaos in discovery and ownership | You can find and attribute anything |

Three principles make standards scale:

1. **Enforce by infrastructure, not documents.** The standard error format is produced by the paved road's error filter and checked by a fitness function, not by a wiki page asking nicely. A standard that depends on humans remembering decays.
2. **Keep it minimal.** Standardise only the interface that genuinely benefits from being shared. Over-standardising (mandating internal structure, forcing one way to do everything) is the heavy-governance failure in a new costume. Standardise the container, not the cargo.
3. **Own and evolve it.** A standard has an owner who maintains it, versions it, and sunsets parts that no longer make sense. Standards that nobody owns rot.

#### Practical example

An org standardises its error format. The standard: every error response is `{ "error": { "code": "ORDER_NOT_FOUND", "message": "...", "trace_id": "...", "details": {...} } }` with a specific HTTP status. It is enforced not by asking teams to produce it but by a shared NestJS exception filter in the paved road that every service uses by default, which turns thrown exceptions into this shape automatically. A fitness function in CI asserts that the service uses the standard filter. The result: every service's errors look the same, clients handle errors uniformly, and the `trace_id` in every error links straight to the trace and logs. No team had to read a document and remember to comply; the paved road made compliance the default and the fitness function caught drift. That is a standard that scales.

#### Artifact example

A standard definition done right — the error format standard, specifying the interface precisely, with its enforcement mechanism named.

```markdown
# Standard: HTTP error format (v2, owner: platform team)

## Scope
All HTTP APIs. Applies to error responses only. Does NOT constrain success
response shapes (those are each API's business).

## The format
Every error response body:
{
  "error": {
    "code": "SNAKE_CASE_STABLE_CODE",   // stable, documented, machine-readable
    "message": "Human-readable description",  // for developers, not end users
    "trace_id": "abc123...",             // always present, links to trace+logs
    "details": { }                       // optional, structured, error-specific
  }
}
Status codes: 400 validation, 401 unauthenticated, 403 unauthorized,
404 not found, 409 conflict, 422 unprocessable, 429 rate limited,
500 internal, 503 unavailable. No error returned with a 2xx status.

## Enforcement (this is what makes it a standard, not a suggestion)
- The paved-road exception filter produces this format automatically.
- Fitness function `error-format.spec` asserts the filter is wired and that
  a sample of error responses match the schema. Runs on every PR.
- The OpenAPI contract check (§53.6) verifies documented error schemas match.

## Evolution
- Breaking changes to this format require an RFC and a migration plan.
- v1 (bare {"message"}) is deprecated; services migrate via the template bump.
```

The standard is precise (exact shape, exact status codes), scoped (errors only, not success shapes — minimal), and — critically — names its *enforcement* (the filter plus the fitness function). A standard document without an enforcement mechanism is a wish; this one is enforced by infrastructure, so it scales.

#### Real-world scenario

A company adopts standard logging conventions enforced through the paved road: structured JSON, mandatory `trace_id`, standard field names, UTC timestamps. The payoff shows up during a cross-service incident. An order is failing intermittently, touching six services. The on-call engineer takes the `trace_id` from the error response (which is standardised, so it is always there) and queries the log aggregator for that one ID. Because every service logs with the standard `trace_id` field, the query returns the complete journey of that request across all six services in chronological order, and the failing step is obvious within two minutes. In the pre-standard world, this same investigation took hours of manually correlating differently-shaped logs across six systems, if it was possible at all. One logging standard, enforced by the paved road, converted a multi-hour correlation nightmare into a two-minute query.

#### Failure scenario

An architect writes an excellent, comprehensive standards document: API conventions, error formats, logging, the works. It is thorough and correct. It is published on the wiki and announced in an all-hands. And then nothing enforces it. New services are not generated from a template that implements it; no CI check verifies it; compliance depends entirely on each engineer reading the document and choosing to follow it. Within a year, the standard describes a fantasy: new services drift because nobody remembers the wiki page, existing services were never retrofitted, and the gap between the documented standard and the actual estate grows until the document is actively misleading — an engineer who trusts it builds a client expecting an error format that half the services do not produce. The standard failed not because it was wrong but because it was enforced by goodwill and memory, which do not scale. A standard must be baked into infrastructure, or it is just a document slowly diverging from reality.

#### Edge cases & failure modes

- **Standard enforced by documents only.** Depends on memory and goodwill; drifts until it describes a fantasy.
- **Over-standardising.** Mandating internal structure and one-way-to-do-everything, which is heavy governance in disguise and breeds resentment.
- **Unowned standard.** Nobody maintains or evolves it, so it rots and stale parts stay enforced.
- **Standard with no migration path.** A new version lands with no way for existing services to adopt it, so the estate splits into old and new forever.
- **Standardising the cargo, not the container.** Constraining domain internals instead of just the interoperability interface.
- **No deprecation path.** Old standard versions are never sunset, so the fleet carries every version simultaneously.

#### How a Principal Engineer thinks about this

They judge a standard by its enforcement mechanism, not its prose: a beautifully written standard with no automated enforcement is a wish, and they will not call it a standard until it is baked into the paved road and checked in CI. They keep standards minimal — standardise the interoperability interface (error shape, log fields, API conventions) and nothing more — because over-standardising is the heavy-governance failure wearing new clothes, and it provokes the same resentment and routing-around.

They insist every standard has an owner and an evolution path, because an unowned standard rots and a standard with no migration path splits the estate permanently. And they think about standards in terms of the fleet-wide capabilities they unlock — a logging standard is worth it because it makes the whole fleet debuggable from one query, an error standard because it makes incidents correlatable and clients uniform. The standard is justified by the cross-service capability it enables, not by tidiness for its own sake.

#### Common mistakes

- **Publishing a standard as a document with no enforcement,** so it drifts into fiction.
- **Over-standardising internals** instead of just the interoperability interface.
- **Leaving a standard unowned,** so it rots and stale parts stay enforced.
- **Shipping a new standard version with no migration path,** splitting the estate.
- **Justifying standards by tidiness** instead of by the fleet-wide capability they unlock.

#### Interview questions

1. **What makes a standard actually scale across many teams?**
   *Expected answer:* it is enforced by infrastructure (paved road + automated checks) rather than by documents and goodwill, it is minimal (only the interoperability interface), and it is owned with an evolution and migration path. A wiki-only standard decays into fiction. *Follow-up:* give an example of a standard and its enforcement mechanism.

2. **Which things should be standardised across services, and which should not?**
   *Expected answer:* standardise the interoperability interface — error format, log shape and trace IDs, API conventions, event schema format, metrics naming — because they unlock fleet-wide debugging, monitoring and client uniformity. Do NOT standardise internal structure or domain logic; that is over-standardising (the container, not the cargo). *Why it matters:* tests the minimalism principle.

3. **A comprehensive standards document was published a year ago. How would you tell if it is real?**
   *Expected answer:* check whether it is enforced — is it baked into a paved-road template, is there a CI fitness function, were existing services retrofitted? If compliance depends on people reading the wiki, the estate has almost certainly drifted and the document is now misleading. *Why it matters:* tests whether they distinguish documented standards from enforced ones.

#### Practical exercise

Pick one standard your org needs or has (error format, logging, API conventions). Write its precise definition, scoped minimally to the interoperability interface. Then — the important part — specify its enforcement: which paved-road component produces it automatically, and which automated check verifies it on every change. If no enforcement exists, that is your finding.

**Acceptance criteria:** the standard is scoped to the interface only (it does not dictate domain internals); it names a specific infrastructure mechanism that produces compliance by default and a specific automated check that catches drift; and it has a named owner and a migration path for existing services. If any of these is missing, you have identified why the standard does not currently scale.
