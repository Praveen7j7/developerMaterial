## 72.11 Worked example: an order API, its generated client, and a breaking change caught in CI

#### Requirements

Put the Part together for one API and its consumers, then make a breaking change and watch the pipeline stop it.

- **The API**: `GET /v1/orders`, `GET /v1/orders/{id}`, `POST /v1/orders/{id}/cancel` in NestJS, validated with `@shop/contracts` zod schemas, errors as problem documents (72.6), wire encodings from 72.7.
- **Consumer 1, `web`**: the Next.js app in the same monorepo. It imports the zod schemas directly, and uses `openapi-fetch` typed by the generated `schema.d.ts` (72.2). Old builds live in open tabs for hours to days.
- **Consumer 2, `merchant-portal`**: a React app in another repository, owned by another team, using types generated from a released `openapi.json` artefact. It ships every two weeks.
- **Gates**: every API pull request must prove, in under 3 minutes of added CI time, that it does not break the published spec or any consumer version still in use. Every consumer deploy must prove it works with the API in production.
- **Numbers**: the orders API serves about 1,400 requests per second at peak; the web's 48-hour old-build tail is about 0.4 % of requests after the reload nudge (72.9).

#### The contract pipeline

```mermaid
flowchart TB
    zod["packages/contracts: zod schemas"] --> reg["generate-openapi: zod-to-openapi registry"]
    reg --> spec["apps/api/openapi.json, committed"]
    spec --> g1{"Regenerated spec equals committed?"}
    spec --> g2{"oasdiff breaking vs main"}
    spec --> gen["web: openapi-typescript to schema.d.ts"]
    gen --> g3{"Typecheck web and api"}
    spec --> art["Release artefact orders-api-openapi version"]
    art --> mp["merchant-portal: pinned generation"]
    broker["Pact Broker: web and merchant-portal pacts"] --> g4{"Provider verification, deployedOrReleased"}
    g1 --> merge["Merge"]
    g2 --> merge
    g3 --> merge
    g4 --> merge
    merge --> cid{"can-i-deploy orders-api to production"}
```

Four gates on every API pull request, each catching a different class of break:

| Gate | Catches | Time |
|---|---|---|
| G1 Spec regenerated equals committed | Hand-edited or stale `openapi.json` | 6 s |
| G2 `oasdiff breaking` against main | Breaks of the published promise, for every consumer including unknown ones | 3 s |
| G3 Web types regenerated and type-checked | Code in this commit that disagrees with the new contract | 26 s |
| G4 Pact provider verification | Breaks for consumer versions that are deployed or still released | 48 s |

#### The contract

`OrderSummarySchema` in `@shop/contracts`, as built up across the volume (68.12, 78.1, 80.7):

```ts
// packages/contracts/src/orders.ts (excerpt)
export const OrderSummarySchema = z.object({
  id: z.string().uuid(),
  displayId: z.string(),
  status: OrderStatusSchema,                              // closed for the server; web reads it through openEnum (80.7)
  totalMinor: MinorUnitsSchema,                           // '129900'
  currency: z.string().length(3),                         // 'INR'
  items: z.array(OrderItemSchema),
  placedAt: z.string().datetime({ offset: true }),
  deliveryDate: z.string().date().nullable(),
  deliveredAt: z.string().datetime({ offset: true }).nullable(),
  storeTimeZone: z.string(),
  version: z.number().int(),
  updatedAt: z.string().datetime({ offset: true }),
});
```

The spec script from 72.3 registers it as `components.schemas.OrderSummary`. The web's `schema.d.ts` is generated from the committed spec. The merchant portal pins `orders-api-openapi@2.14.0`. Both consumers have pacts in the broker; the web's include the two interactions from 72.10.

#### The change

A backend engineer is adding multi-currency marketplace orders. They decide money should be one object, and make the change in one tidy pull request:

```ts
// before
totalMinor: MinorUnitsSchema,
currency: z.string().length(3),
// after
total: z.object({ amountMinor: MinorUnitsSchema, currency: z.string().length(3) }),
```

They update the mapper, the API tests, and every web component that read `totalMinor` (`OrderRow`, `OrderHeader`, the cancel confirmation). Locally, `pnpm turbo run typecheck test` is green. In a world with only shared types, this merges.

#### What CI says

**G3, typecheck: green.** The web code in the pull request agrees with the new contract. That is all it can know.

**G2, spec diff: red.**

```bash
$ oasdiff breaking /base/openapi.json /rev/openapi.json --fail-on ERR
```

```text
3 changes: 3 error, 0 warning, 0 info
error   [response-required-property-removed] at /rev/openapi.json
        in API GET /v1/orders
                removed the required property 'items/items/totalMinor' from the response with the '200' status
error   [response-required-property-removed] at /rev/openapi.json
        in API GET /v1/orders/{id}
                removed the required property 'totalMinor' from the response with the '200' status
error   [response-required-property-removed] at /rev/openapi.json
        in API GET /v1/orders/{id}
                removed the required property 'currency' from the response with the '200' status
```

(Output abridged.) The published promise is broken for every consumer, known or not.

**G4, provider verification: red, with names.**

```text
Verifying a pact between web and orders-api
  [Using consumer version selectors: mainBranch, deployedOrReleased]
  Pact for web version 7e21c0a (deployed in production, released)
    a request for one order
      returns a response which
        has status code 200 (OK)
        has a matching body (FAILED)
Failures:
1) Verifying a pact between web and orders-api - a request for one order
    1.1) body: $ Actual map is missing the following keys: currency, totalMinor
Verifying a pact between merchant-portal and orders-api
  Pact for merchant-portal version 2.14.0 (deployed in production)
    a request for todays orders ... (FAILED)
```

The important line is `web version 7e21c0a (deployed in production, released)`. The web on `main` in this pull request is fine. The web in users' tabs, and the merchant portal, are not. Had the pull request merged, `can-i-deploy --pacticipant orders-api --to-environment production` would have answered "Computer says no" with the same two failing pairs, and the deploy would have stopped there.

The CI job that produces these results:

```yaml
# .github/workflows/contracts.yml
name: contracts
on: pull_request
jobs:
  contracts:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: test }
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: G1 spec generated from contracts and committed
        run: pnpm --filter api openapi && git diff --exit-code apps/api/openapi.json
      - name: G2 breaking-change diff against main
        if: ${{ !contains(github.event.pull_request.labels.*.name, 'breaking-change-approved') }}
        run: |
          git show origin/main:apps/api/openapi.json > /tmp/base.json
          docker run --rm -v /tmp:/base -v "$PWD/apps/api:/rev" tufin/oasdiff breaking /base/base.json /rev/openapi.json --fail-on ERR
      - name: G3 web types regenerated and everything type-checked
        run: pnpm --filter web gen:api && git diff --exit-code apps/web/src/api/schema.d.ts && pnpm turbo run typecheck --affected
      - name: G4 provider verification against deployed and released consumers
        run: pnpm --filter api test:pact:provider
        env:
          DATABASE_URL: postgres://postgres:test@localhost:5432/postgres
          PACT_BROKER_BASE_URL: ${{ vars.PACT_BROKER_BASE_URL }}
          PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
          GIT_SHA: ${{ github.event.pull_request.head.sha }}
          GIT_BRANCH: ${{ github.head_ref }}
```

The `breaking-change-approved` label skips only G2, never G4: a human may decide the published promise should change, but cannot wave through a break for a consumer version the broker knows is in use.

#### The fix: expand, migrate, measure, contract

The engineer turns one pull request into four steps.

**Step 1, expand (API, day 0).** Add `total` next to the old fields, populate both, and mark the old ones deprecated:

```ts
// packages/contracts/src/orders.ts
export const MoneySchema = z.object({ amountMinor: MinorUnitsSchema, currency: z.string().length(3) });
export const OrderSummarySchema = z.object({
  // ...
  totalMinor: MinorUnitsSchema.describe('Deprecated: use total.amountMinor. Sunset 2026-12-15.'),
  currency: z.string().length(3).describe('Deprecated: use total.currency. Sunset 2026-12-15.'),
  total: MoneySchema,
  // ...
});
```

In the spec registry, the two old properties get `deprecated: true` through zod-to-openapi's `.openapi({ deprecated: true })` metadata, and `GET /v1/orders` responses carry a `Sunset: Tue, 15 Dec 2026 00:00:00 GMT` header (72.9). G2 is green (an added property is not breaking), G4 is green (every pact still finds `totalMinor` and `currency`), and the release artefact `orders-api-openapi@2.15.0` is published.

**Step 2, migrate consumers (web day 1, portal day 6).** The web pull request switches components to `order.total`, with its pacts updated to assert `total` instead of the old fields. Its `can-i-deploy` checks the new pact against the API in production, which already sends `total`: green. The merchant portal team regenerates from `2.15.0` in their next sprint, sees the deprecated fields struck through in their editor, migrates, publishes new pacts and deploys.

**Step 3, measure.** The API logs, per client version, which builds are still in use (72.9). For the web, the 48-hour tail of `7e21c0a` and older builds falls below 0.05 % by day 4; the pipeline runs `record-support-ended` for them on day 5. The merchant portal's old version stops being deployed on day 6. Now no deployed or released consumer version has a pact that reads `totalMinor`.

**Step 4, contract (API, day 14).** The removal pull request deletes `totalMinor` and `currency`. G2 is still red, correctly: the published promise does shrink. The pull request carries the `breaking-change-approved` label, with a link to the version dashboard and the broker matrix in its description, and approvals from the web and portal owners. G4 is green, because no consumer version in use reads the old fields. `can-i-deploy` is green. It ships.

```mermaid
gantt
    dateFormat  YYYY-MM-DD
    title Expand and contract for total
    section API
    Expand, send both            :a1, 2026-11-02, 1d
    Sunset header live           :a2, after a1, 13d
    Contract, remove old fields  :a3, 2026-11-16, 1d
    section Web
    Read total, deploy           :w1, 2026-11-03, 1d
    Old tabs drain               :w2, after w1, 4d
    section Portal
    Regenerate and migrate       :p1, 2026-11-06, 3d
```

#### Numbers

Over the following quarter, on this API and its two consumers: 212 API pull requests, 9 red on G2 (6 genuine, 3 approved as intentional after migration), 4 red on G4 (all genuine, all for a deployed consumer version), 2 red on G1 (hand edits). Median added CI time per pull request: 1 min 31 s. Contract violations reported by the web's runtime parser in production: 3, all from a single mapper bug in a new endpoint, detected 2 minutes after deploy and routed to the orders API team by endpoint ownership. Contract-caused incidents: zero, against five in the quarter before the gates.

#### Failure drills

| Drill | Expected result | Mechanism |
|---|---|---|
| API removes a field the production web build reads | G4 red, naming `web 7e21c0a` | `deployedOrReleased` selectors, recorded releases |
| API adds `status: 'RETURN_REQUESTED'` | G2 warning only; web renders the fallback badge and reports the value | Open enums on read (72.7) |
| Someone edits `openapi.json` by hand | G1 red | Regeneration diff |
| Web starts reading a field the API does not send | Web's `can-i-deploy` red until the API verifies the new pact | Pending pacts, consumer-side gate |
| API changes `409 ORDER_NOT_CANCELLABLE` to `422` | G2 red (documented response removed), G4 red (web error interaction) | Errors documented per operation, error pacts |
| Mapper bug returns `totalMinor` as a number on one endpoint | Web shows the error state on that screen; contract alert to the API team within 2 minutes | Runtime parse with telemetry (72.1) |
| Merchant portal regenerates from a staging spec | Not possible: generation reads only released artefacts | Pinned spec versions (72.2) |

#### How a Senior Full-Stack Engineer thinks about this

The type check was green, and it was right: the code in that commit agreed with itself. The senior's point is that a contract is between *versions*, not between files, so the gates must know which versions exist. The spec diff protects the published promise for everyone; consumer contracts protect the specific versions the broker knows are deployed or released; runtime validation catches what both missed, within minutes. None of the gates made the engineer's goal impossible. They turned a one-step break into a four-step migration that cost two weeks of calendar time and about an hour of work, instead of an incident, a rollback and a postmortem.

To a product manager: "The money change ships in two weeks instead of today, because the merchant portal and open browser tabs still use the old field. Nothing is blocked: new screens can use the new field from tomorrow."

#### Practical exercise

Reproduce this example in the volume's monorepo, with a second consumer in a separate repository.

Acceptance criteria:

- The four gates run on every API pull request in under 3 minutes in total.
- The one-step `total` change fails G2 and G4, and the G4 output names the deployed web version and the merchant portal version.
- The four-step migration passes every gate at every step, and the removal step merges only with the approval label and green G4.
- A dashboard shows requests by client version, and `record-support-ended` is run from it, not from a calendar.
- The web's runtime parser reports a deliberately injected contract violation on staging within one minute, routed to the API team.

## Senior Checklist — Part 72

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can list what a contract includes beyond field names: nullability, ordering, error codes, headers, timing and meaning
- [ ] I parse every response at one choke point and report violations with endpoint, build version and request ID
- [ ] I generate the OpenAPI spec from one source of truth, commit it, diff it, and generate clients from pinned versions only
- [ ] I can choose between shared zod schemas, generated OpenAPI clients, tRPC and GraphQL codegen for a given set of consumers
- [ ] I validate strictly on input and tolerantly on output, and I deploy request changes provider first
- [ ] I return every error as one problem document with `code`, `issues` and `requestId`, and classify it once on the client
- [ ] I encode instants, calendar dates, money, IDs and enums so that no time zone, float or `JSON.parse` can change them
- [ ] I keep upload bytes off the API, show real progress, and make every upload step retryable
- [ ] I measure client version populations and remove fields only when the numbers say they are unused
- [ ] I run consumer contract tests against deployed and released consumer versions and gate deploys with `can-i-deploy`

## Part 72 — Key Takeaways

- A contract is between versions, not files: production always runs more than one version of every client.
- Types prove one commit agrees; spec diffs protect the published promise; consumer contracts protect deployed versions; runtime validation catches the rest.
- Parse every response at one choke point, and route contract violation alerts to the team that owns the endpoint.
- Generate clients from a committed, versioned spec, never from a live server.
- Be strict on input and tolerant on output; new request fields ship provider first, removals ship consumer first.
- tRPC is a superb intercom and a poor public phone; end-to-end types still end at the deploy boundary.
- One error shape everywhere, `code` for machines, `issues` with field paths for forms, `requestId` for support.
- Instants are UTC strings, calendar dates are date strings, money is minor units in strings, IDs are opaque strings, and response enums are open.
- The server computes money and time rules; the client formats them.
- Uploads are a small protocol: initiate, upload direct to storage with progress, complete, wait for processing.
- Measure the tail of old tabs and app versions, shrink it with reload nudges, and remove things on evidence, not on a calendar.
- A red `can-i-deploy` is a conversation between two teams, and expand and contract is almost always the answer.
