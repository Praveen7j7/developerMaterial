## 47.10 Smoke tests and post-deploy verification

#### Concept

A smoke test is a very small set of checks run immediately after a deploy against the real environment, answering one question: *is this thing actually working?* Not "is it correct in every detail" — that is what the test suite was for — but "is it up, connected, and serving the critical path".

The name comes from hardware: power it on and see if smoke comes out.

#### Why does it exist?

Because `kubectl rollout status` returning success means "the pods are running and their readiness probes passed". It does not mean the application can reach the database, that the new configuration is valid, that the certificate is trusted, or that an order can be placed. The gap between "deployment succeeded" and "the product works" is where a specific and painful class of incident lives: the deploy is green, the dashboards are green, and orders quietly stopped 20 minutes ago.

#### Mental model

Imagine a pilot's pre-taxi checklist. It is not a full inspection of the aircraft; that happened in the hangar. It is six things checked in ninety seconds: controls free, instruments alive, fuel sufficient, doors closed. Short enough to be done every single time, specific enough that failing one means you do not take off.

#### How it works

**The handful of checks that must pass.** Keep it under ten, keep it under 60 seconds, and make every one of them prove a dependency is genuinely working end to end:

| Check | Proves | Fails when |
|---|---|---|
| `GET /health/live` returns 200 | Process is up | Crash loop, bad image |
| `GET /health/ready` returns 200 on all pods | Dependencies reachable from *this* environment | Wrong DB URL, network policy, secret missing |
| `GET /version` returns the expected git SHA | The intended artifact is actually serving | Rollout stalled, old replica set still up, wrong tag |
| Authenticated `GET /orders?limit=1` returns 200 | Auth, database read path, serialisation | Migration missing, JWT secret rotated wrongly |
| `POST /orders` with a synthetic payload returns 201 | The full write path: validation, transaction, constraints | Broken migration, constraint violation, pool exhausted |
| Read back the synthetic order | Write actually persisted and is visible | Replica lag, wrong connection routing |
| A queue publish and consume round trip | Broker connectivity and consumer liveness | Broker credentials, topic missing, consumer not started |
| Outbound dependency ping (payments sandbox) | Egress and credentials | Egress firewall, expired API key |

**The synthetic checkout.** The single most valuable post-deploy check for an e-commerce system is a scripted end-to-end purchase against production, using a dedicated test account, a test payment method and a product flagged as synthetic:

1. Authenticate as `synthetic-monitor@internal`.
2. Add a specific SKU (`SYNTHETIC-TEST-001`, stock 999,999, price 1 minor unit) to a cart.
3. Check out with a sandbox card token that always succeeds.
4. Assert the order reaches `CONFIRMED` within 15 seconds.
5. Assert the confirmation event appears on the Kafka topic.
6. Cancel and refund the order, so it does not pollute reporting.

Every synthetic record must be tagged (`is_synthetic = true`) and excluded from analytics, revenue reporting and inventory. Getting that wrong produces a different and very awkward incident: a finance team reconciling 4,000 one-cent orders.

Run it after every production deploy *and* on a schedule (every 2 to 5 minutes) as an ongoing monitor. Then a deploy failure and a Tuesday-afternoon outage are found by the same mechanism, which means the mechanism is well tested.

**The alert watch window.** After the smoke tests pass, the deploy is not finished. Hold the pipeline for a defined window — 5 to 15 minutes is typical — and watch. Two reasons: some failures need traffic to appear (a memory leak, a slow query under real cardinality, a connection pool that exhausts after 8 minutes), and some need the next scheduled job to run.

During the window the pipeline should: keep the deploy job open so it is obvious a deploy is in progress, suppress unrelated deploys to the same service via a concurrency lock, and evaluate the automated rollback signals from 47.9. Annotate your dashboards with the deploy marker — a vertical line at the deploy time on every graph turns "when did this start?" from a 10-minute investigation into a glance.

```mermaid
flowchart TB
  d["kubectl rollout status: success"] --> v["Verify /version == deployed SHA on all pods"]
  v --> s["Run 8 smoke checks (under 60 s)"]
  s -->|"any fail"| rb["Automatic rollback + page"]
  s -->|"all pass"| w["Watch window: 10 min"]
  w --> a{"SLO signals within thresholds?"}
  a -->|"no"| rb
  a -->|"yes"| done["Mark deploy successful, notify channel"]
```

**What to do when they fail.** The order matters, and it should be written down before you need it:

1. **Stop the rollout immediately.** For a canary or progressive rollout, abort. For a rolling update in progress, `kubectl rollout pause` to freeze the blast radius while you decide.
2. **Decide roll back or roll forward** using the schema question from 47.9. If the release was additive-only, roll back; the decision should take seconds because the answer was determined at merge time.
3. **Verify the rollback with the same smoke tests.** A rollback that has not been smoke tested is an assumption. This is the step people skip under pressure and regret.
4. **Preserve evidence before it disappears.** Grab logs from the failing pods (`kubectl logs --previous`), a heap snapshot if it is a memory issue, and the exact image digest. A rollback deletes the pods and, with them, the evidence.
5. **Communicate.** Post in the incident channel what failed, what you did, and current status. The smoke test failure message should already name the check and include the failing response body.
6. **Do not retry the same deploy hoping it was transient.** If a smoke test is flaky enough that re-running fixes it, that flakiness is itself a defect: it means you cannot distinguish a broken deploy from a broken test at the exact moment you most need to.

#### Practical example

A NestJS `/version` endpoint that makes step 1 of the checklist possible, populated at build time:

```ts
// src/version/version.controller.ts
import { Controller, Get } from '@nestjs/common';

@Controller('version')
export class VersionController {
  // GIT_SHA and BUILD_TIME are injected as env vars by the deploy manifest,
  // sourced from the CI workflow. They are not baked into the image, so the
  // same artifact is still promotable across environments.
  @Get()
  version() {
    return {
      sha: process.env.GIT_SHA ?? 'unknown',
      builtAt: process.env.BUILD_TIME ?? 'unknown',
      startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
      env: process.env.NODE_ENV,
    };
  }
}
```

The smoke script asserts that *every* pod reports the expected SHA, not just the one the load balancer happened to route to. A rollout that stalled at 60% will pass a single-request check and fail this one.

#### Failure scenario

At 15:20 a deploy of `checkout-api` completed. `kubectl rollout status` reported success in 2 minutes 10 seconds. The team's smoke test was `curl -f https://api.example.com/health/live`, which returned 200. The pipeline went green and everyone moved on.

At 16:05 support escalated: customers could not complete checkout. The new release had a typo in the Kafka topic name for order-confirmation events. The health endpoint did not touch Kafka. Orders were being created and then never confirmed, sitting in `PENDING`. 2,300 orders were affected over 45 minutes, and reconciling them took two engineers most of the next day.

The fix was the synthetic checkout: a single test that places a real order and asserts the confirmation event arrives would have failed in 15 seconds and rolled the deploy back automatically. The team's rule since: **a smoke test that only checks liveness is not a smoke test.** It must exercise the business-critical path through every dependency the service owns.

#### Edge cases & failure modes

- **Smoke tests hitting only one pod.** The load balancer routes to a healthy pod; the broken one is never sampled. Address pods directly, or run enough requests.
- **Health check that passes while the app is broken.** `return 'ok'` with no dependency check. The most common version of this failure.
- **Synthetic data polluting production.** Orders in revenue reports, inventory decremented, marketing emails sent to the test account.
- **Smoke test credentials expiring.** The monitor account's password rotates and every deploy fails for 40 minutes until someone realises the deploy was fine.
- **Smoke tests that are slow.** A 5-minute suite delays the rollback decision by 5 minutes.
- **Testing through a cache.** A CDN serves the previous version's response and the smoke test passes against code that is not running.
- **Watch window too short.** A memory leak OOMs at minute 14 of a 10-minute window and the pipeline has already reported success.
- **No deploy annotation on dashboards.** Nobody can correlate a metric change with the deploy.
- **Alerting suppressed during deploys.** Someone silenced alerts "because deploys are noisy", so the real breakage is invisible.

#### How a Senior Backend Engineer thinks about this

They ask: *if this deploy were subtly broken, which single request would tell me?* That request is the smoke test. Everything else is padding.

They insist that smoke tests exercise real dependencies, because the entire class of bug they exist to catch is environmental — configuration, credentials, network policy, migration state — and none of those are visible to a mocked check.

They also treat the post-deploy watch window as part of the deploy, not as an afterthought. A deploy is not finished when the pipeline is green; it is finished when the service has served real traffic on the new version for long enough to trust it. In practice that means the engineer who merged the change is still around and paying attention.

Explained to a product manager: "After every release we automatically place a test order end to end. If it does not go through, we put the previous version back before customers notice."

#### Common mistakes

- Smoke tests that only check `/health`.
- Running smoke tests through a cache or CDN.
- Synthetic orders that reach real reports and real inventory.
- No `/version` endpoint, so you cannot prove what is running.
- Declaring the deploy done the moment the rollout completes.
- Retrying a failed smoke test instead of investigating it.

#### Interview questions

1. *What is the difference between `rollout status: success` and "the deploy worked"?* Expected: rollout status proves pods are running and ready; it proves nothing about configuration, downstream connectivity, migrations or the business path.
2. *Design a smoke test suite for an orders service.* Expected: under 10 checks, under 60 seconds, version assertion across all pods, an authenticated read, a synthetic write, a queue round trip, an egress check; synthetic data tagged and cleaned up.
3. *Your smoke test passed but customers are broken. What was missing?* Expected: the check did not exercise the failing dependency; add a synthetic transaction covering the critical path.
4. *How long should the post-deploy watch window be, and what happens during it?* Expected: 5–15 minutes; automated SLO evaluation, deploy concurrency lock, dashboard annotation, human attention; long enough for load-dependent failures to surface.
5. *A smoke test fails. Walk me through the next five minutes.* Expected: pause or abort the rollout, decide roll back vs forward from the schema question, verify with the same smoke tests, preserve logs and digest, communicate; do not blindly retry.

#### Practical exercise

Write a smoke test script for one service containing at most eight checks, including a `/version` assertion against every pod and one synthetic write that is tagged and cleaned up. Wire it into the deploy workflow so a failure triggers `kubectl rollout undo` and a notification naming the failed check. Then prove it works: deploy a version with an intentionally wrong database password and confirm the pipeline rolls back automatically. Acceptance criteria: total smoke duration under 60 seconds, automatic rollback triggered within 90 seconds of the bad deploy, synthetic records excluded from reporting queries, and the notification message identifying which check failed and why.

## 47.11 A complete GitHub Actions setup

Everything so far has been principles. This section is the implementation: three workflows that together take a commit from a pull request to production, with an explanation of every step that does real work. They are written for a NestJS service called `orders-api` deployed to Amazon EKS, with images in ECR and credentials obtained through OIDC. Nothing here is pseudocode; the mechanics are the ones you will actually type.

### 47.11.1 `ci.yml` — the gate on every pull request

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

# Only one CI run per branch. A new push cancels the previous run, which on a
# busy repo saves a large share of runner minutes and stops stale red checks
# from confusing reviewers.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

# Least privilege by default. Any job needing more must ask for it explicitly.
permissions:
  contents: read

jobs:
  static:
    name: Lint and typecheck
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
      # npm ci, never npm install: deterministic, and it fails if
      # package.json and package-lock.json disagree.
      - run: npm ci --prefer-offline --no-audit --fund=false
      - run: npm run lint
      - run: npm run typecheck

  unit:
    name: Unit tests (shard ${{ matrix.shard }} of 4)
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    strategy:
      # Without fail-fast: false, one failing shard cancels the other three
      # and you only learn about one failure per run.
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
      - run: npm ci --prefer-offline --no-audit --fund=false
      - name: Jest shard
        run: npm run test:unit -- --shard=${{ matrix.shard }}/4 --coverage --coverageReporters=json
      - uses: actions/upload-artifact@v4
        with:
          name: coverage-unit-${{ matrix.shard }}
          path: coverage/coverage-final.json
          retention-days: 1

  integration:
    name: Integration tests
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    services:
      postgres:
        image: postgres:16.4-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: orders_test
        ports: ['5432:5432']
        # Without the health check the job starts running tests while
        # PostgreSQL is still initialising and fails roughly 1 run in 8
        # with ECONNREFUSED, which reads exactly like a flaky test.
        options: >-
          --health-cmd "pg_isready -U test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7.4-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      NODE_ENV: test
      # localhost works because this job runs directly on the runner. If the
      # job itself ran in a container, these would be postgres:5432 and
      # redis:6379 on the job's Docker network instead.
      DATABASE_URL: postgres://test:test@localhost:5432/orders_test
      REDIS_URL: redis://localhost:6379
      JWT_SECRET: ci-only-secret-at-least-32-characters
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
      - run: npm ci --prefer-offline --no-audit --fund=false
      # Migrations run first so the test schema is the migrated schema, not
      # one produced by synchronize: true. Those two drift apart silently.
      - name: Run migrations
        run: npm run migration:run
      - name: Integration tests
        run: npm run test:int -- --coverage --coverageReporters=json
      - uses: actions/upload-artifact@v4
        with:
          name: coverage-int
          path: coverage/coverage-final.json
          retention-days: 1

  coverage:
    name: Coverage gate
    needs: [unit, integration]
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
      - run: npm ci --prefer-offline --no-audit --fund=false
      - uses: actions/download-artifact@v4
        with:
          pattern: coverage-*
          path: coverage-parts
          merge-multiple: false
      # Shards each produce partial coverage. Merged, they are the real number;
      # judged separately, every shard looks catastrophically low.
      - name: Merge coverage from all shards
        run: npx nyc merge coverage-parts coverage/merged.json
      - name: Enforce thresholds
        run: npx nyc report --temp-dir coverage --check-coverage --lines 70 --branches 60

  security:
    name: Security checks
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          # Gitleaks needs history to scan commits added by this PR.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
      - run: npm ci --prefer-offline --no-audit --fund=false
      # Production dependencies only, high and above: this is the gate.
      - name: Audit production dependencies
        run: npm audit --omit=dev --audit-level=high
      # Dev dependencies are reported but never block a merge.
      - name: Audit dev dependencies (report only)
        run: npm audit --audit-level=moderate || true
      - name: Secret scan
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: License allowlist
        run: npx license-checker --production --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;Unlicense"

  ci-complete:
    # A single required status check. Branch protection points at this job
    # only, so adding or renaming a job never means editing branch protection
    # (and never leaves a required check that no longer runs, which blocks
    # every PR forever).
    name: CI complete
    if: always()
    needs: [static, unit, integration, coverage, security]
    runs-on: ubuntu-24.04
    steps:
      - name: Fail if any dependency failed
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
      - run: echo "All CI checks passed"
```

The design decisions worth calling out. `concurrency` with `cancel-in-progress: true` is right for CI and wrong for deploys (47.13). `fail-fast: false` on the matrix means one broken shard does not hide the other three. Coverage is merged across shards before it is judged, because a shard on its own covers a quarter of the code. Migrations run before integration tests so the schema under test is the migrated schema. And `ci-complete` exists so branch protection has exactly one required check to name, which removes an entire category of "the required check never ran and now nothing can merge" incidents.

Note what is *not* here: no Docker build, no deploy, no E2E. A pull request does not need an image, and E2E belongs after a deploy to staging.

### 47.11.2 `build-and-push.yml` — build once, scan, push, attest

```yaml
name: Build and push

on:
  push:
    branches: [main]

concurrency:
  # Deliberately NOT cancel-in-progress. Cancelling a build mid-push can leave
  # a partially uploaded manifest, and we want every commit on main to produce
  # an artifact so every commit is a rollback target.
  group: build-main
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write        # required to request the OIDC token
  attestations: write    # required to publish build provenance
  packages: read

env:
  AWS_REGION: eu-west-1
  ECR_REPOSITORY: orders-api

jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    outputs:
      tag: ${{ steps.meta.outputs.tag }}
      image: ${{ steps.meta.outputs.image }}
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v4

      # An image tagged sha-abc1234 must contain exactly the code at abc1234.
      # A dirty tree produces an artifact whose name is a lie, and that lie is
      # discovered during an incident when the rollback behaves unexpectedly.
      - name: Refuse to build from a dirty tree
        run: |
          if [ -n "$(git status --porcelain)" ]; then
            echo "::error::Working tree is dirty; refusing to build a mislabelled artifact"
            exit 1
          fi

      # No access keys anywhere. The runner proves its identity with a signed
      # OIDC token; AWS returns credentials valid for one hour.
      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-orders-api-build
          aws-region: ${{ env.AWS_REGION }}

      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - uses: docker/setup-buildx-action@v3

      - id: meta
        name: Compute tags
        run: |
          SHORT_SHA=$(git rev-parse --short=7 HEAD)
          echo "tag=sha-${SHORT_SHA}" >> "$GITHUB_OUTPUT"
          echo "image=${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}" >> "$GITHUB_OUTPUT"

      # Build and load locally so we can scan the real image before it is
      # published. cache-from/cache-to against a registry cache tag turns a
      # 7-minute cold build into roughly 70 seconds when only src/ changed.
      - name: Build image
        uses: docker/build-push-action@v6
        with:
          context: .
          load: true
          push: false
          tags: ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
          cache-from: type=registry,ref=${{ steps.meta.outputs.image }}:buildcache
          cache-to: type=registry,ref=${{ steps.meta.outputs.image }}:buildcache,mode=max
          build-args: |
            GIT_SHA=${{ github.sha }}

      # Scan BEFORE the push. Scanning afterwards means a vulnerable image is
      # already pullable by anything with registry access.
      - name: Trivy image scan
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
          severity: 'CRITICAL,HIGH'
          ignore-unfixed: true      # do not block on findings with no patch
          exit-code: '1'
          format: 'table'

      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          image: ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
          format: cyclonedx-json
          artifact-name: sbom-${{ steps.meta.outputs.tag }}.json

      # Second build call. Every layer is a cache hit, so this takes seconds.
      # It runs with the OCI exporter, which is what makes provenance and SBOM
      # attestations possible; the local docker exporter cannot carry them.
      - id: push
        name: Push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
            ${{ steps.meta.outputs.image }}:main
          cache-from: type=registry,ref=${{ steps.meta.outputs.image }}:buildcache
          provenance: mode=max
          sbom: true
          build-args: |
            GIT_SHA=${{ github.sha }}

      # A signed statement binding this digest to this commit, this workflow
      # and this runner. An admission policy in the cluster verifies it, which
      # is what stops an image pushed from a laptop from ever running.
      - name: Attest build provenance
        uses: actions/attest-build-provenance@v1
        with:
          subject-name: ${{ steps.meta.outputs.image }}
          subject-digest: ${{ steps.push.outputs.digest }}
          push-to-registry: true

  deploy-staging:
    needs: build
    uses: ./.github/workflows/deploy.yml
    with:
      image_tag: ${{ needs.build.outputs.tag }}
      environment: staging
    secrets: inherit

  deploy-production:
    needs: [build, deploy-staging]
    uses: ./.github/workflows/deploy.yml
    with:
      image_tag: ${{ needs.build.outputs.tag }}
      environment: production
    secrets: inherit
```

The two-call build pattern deserves a note because it looks wasteful and is not. The first call loads the image into the runner's local Docker daemon so Trivy can scan the exact bytes that will be published. The second call pushes with the OCI exporter, which supports provenance and SBOM attestations that the local exporter does not. Because the first call populated the cache, the second is entirely cache hits and takes a few seconds.

Also note `:main` as a secondary tag. It is a convenience pointer for humans and for the BuildKit cache; nothing in a deployment manifest ever references it.

### 47.11.3 `deploy.yml` — approve, migrate, roll out, verify, roll back

```yaml
name: Deploy

on:
  workflow_call:
    inputs:
      image_tag: { required: true, type: string }
      environment: { required: true, type: string }
  workflow_dispatch:
    inputs:
      image_tag:
        description: 'Image tag, e.g. sha-3f9a1c2'
        required: true
        type: string
      environment:
        required: true
        type: choice
        options: [staging, production]

# One deploy per service per environment at a time, and queued rather than
# cancelled: two concurrent kubectl set image calls are how you get a rollout
# that reverts itself halfway through (29.13).
concurrency:
  group: deploy-orders-api-${{ inputs.environment }}
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    # This is where approvals live. The production environment requires two
    # reviewers from a team and is restricted to the main branch. It also
    # scopes the OIDC subject claim, so the deploy role can only be assumed
    # by an approved production job.
    environment:
      name: ${{ inputs.environment }}
      url: https://${{ inputs.environment == 'production' && 'api' || 'staging-api' }}.example.com
    env:
      NAMESPACE: orders
      DEPLOYMENT: orders-api
      CLUSTER: ${{ inputs.environment }}-eks
    steps:
      - uses: actions/checkout@v4

      - name: Assume deploy role via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-orders-api-deploy-${{ inputs.environment }}
          aws-region: eu-west-1

      - name: Configure kubectl
        run: aws eks update-kubeconfig --name "$CLUSTER" --region eu-west-1

      - name: Resolve image digest
        id: img
        run: |
          # Deploy by digest, not by tag. Even an immutable tag is a name;
          # the digest is the artifact.
          DIGEST=$(aws ecr describe-images \
            --repository-name orders-api \
            --image-ids imageTag=${{ inputs.image_tag }} \
            --query 'imageDetails[0].imageDigest' --output text)
          REGISTRY=123456789012.dkr.ecr.eu-west-1.amazonaws.com
          echo "ref=${REGISTRY}/orders-api@${DIGEST}" >> "$GITHUB_OUTPUT"

      # The migration runs as a one-shot Job: exactly once, before any new
      # code is live, with its own logs and its own timing in the timeline.
      # Never as an init container (once per replica) and never on app boot.
      - name: Run database migration
        env:
          IMAGE: ${{ steps.img.outputs.ref }}
        run: |
          export JOB_NAME="migrate-${{ inputs.image_tag }}-${{ github.run_id }}"
          envsubst < k8s/migration-job.yaml | kubectl apply -n "$NAMESPACE" -f -
          if ! kubectl wait -n "$NAMESPACE" --for=condition=complete \
                 "job/$JOB_NAME" --timeout=600s; then
            echo "::error::Migration failed or timed out"
            kubectl logs -n "$NAMESPACE" "job/$JOB_NAME" --tail=300
            exit 1
          fi
          kubectl logs -n "$NAMESPACE" "job/$JOB_NAME" --tail=100

      - name: Roll out
        env:
          IMAGE: ${{ steps.img.outputs.ref }}
        run: |
          # Helm keeps release history, which makes `helm rollback` possible.
          helm upgrade --install "$DEPLOYMENT" ./charts/orders-api \
            --namespace "$NAMESPACE" \
            --set image.repository="${IMAGE%@*}" \
            --set image.digest="${IMAGE#*@}" \
            --set gitSha="${{ github.sha }}" \
            --values "charts/orders-api/values.${{ inputs.environment }}.yaml" \
            --wait --timeout 10m
          # The plain-kubectl equivalent, if you are not using Helm:
          #   kubectl set image -n "$NAMESPACE" \
          #     deployment/"$DEPLOYMENT" api="$IMAGE" --record=false

      - name: Wait for rollout
        run: kubectl rollout status -n "$NAMESPACE" "deployment/$DEPLOYMENT" --timeout=600s

      # rollout status only proves pods are ready. Smoke tests prove the
      # product works: version on every pod, an authenticated read, a
      # synthetic write, and a queue round trip. Under 60 seconds.
      - name: Smoke tests
        env:
          BASE_URL: https://${{ inputs.environment == 'production' && 'api' || 'staging-api' }}.example.com
          EXPECTED_SHA: ${{ github.sha }}
          SMOKE_TOKEN: ${{ secrets.SMOKE_TOKEN }}
        run: ./scripts/smoke.sh

      # Any failure above this point rolls back automatically. `if: failure()`
      # runs even when an earlier step aborted the job.
      - name: Automatic rollback
        if: failure()
        run: |
          echo "::warning::Deploy failed, rolling back"
          helm rollback "$DEPLOYMENT" -n "$NAMESPACE" --wait --timeout 5m
          kubectl rollout status -n "$NAMESPACE" "deployment/$DEPLOYMENT" --timeout=300s
          # Verify the rollback with the same checks. An unverified rollback
          # is an assumption, and this is the step people skip under pressure.
          ./scripts/smoke.sh || echo "::error::Rollback did not pass smoke tests. Escalate."

      - name: Notify
        if: always()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "orders-api ${{ inputs.image_tag }} -> ${{ inputs.environment }}: ${{ job.status }} (${{ github.actor }})"
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_DEPLOY_WEBHOOK }}
```

Read the order of operations once more, because it is the whole point: **migrate, roll out, wait, verify, roll back on any failure, always notify.** The migration is separate and first because it must run once and because its failure must stop the deploy before new code is live. The rollback step verifies itself. And the notification runs `if: always()` so a failed deploy is as visible as a successful one — a silent failure is worse than a loud one.

Two things this workflow deliberately does not do. It does not roll back the migration, because as 47.9 explained, that is usually impossible and often destructive; the migration was additive, so the old code still works. And it does not retry the smoke tests, because a smoke test that passes on the second attempt has told you nothing.

### 47.11.4 The GitLab CI equivalents

The concepts map one to one; only the syntax differs. If your organisation uses GitLab, this is the translation table:

| GitHub Actions | GitLab CI | Notes |
|---|---|---|
| `jobs:` in a workflow file | `stages:` plus jobs in `.gitlab-ci.yml` | GitLab orders by stage; use `needs:` for a DAG |
| `needs: [build]` | `needs: [build]` | Same semantics, same DAG behaviour |
| `strategy.matrix` | `parallel.matrix` | Same purpose |
| `strategy.matrix` for sharding | `parallel: 4` with `CI_NODE_INDEX` / `CI_NODE_TOTAL` | GitLab injects the shard index as variables |
| `services:` containers | `services:` | Nearly identical; GitLab addresses them by service alias |
| `actions/cache` | `cache:` with `key: files: [package-lock.json]` | Built into the job definition |
| `environment: production` with reviewers | `environment: name: production` plus `when: manual` and protected environments | Approvals come from protected environments |
| `permissions: id-token: write` | `id_tokens:` with an `aud` | GitLab issues OIDC JWTs the same way |
| OIDC to AWS | Same IAM trust policy, issuer `gitlab.com` (or your instance) | The `sub` claim format differs: `project_path:group/repo:ref_type:branch:ref:main` |
| `concurrency` group | `resource_group:` | Serialises deploys to one environment |
| `if: failure()` | `when: on_failure` | Rollback jobs use this |
| GitHub Packages / ECR login action | `docker login $CI_REGISTRY` or the same AWS ECR login | GitLab has a built-in container registry |
| `actions/upload-artifact` | `artifacts: paths:` | Plus `reports:` for native coverage and JUnit integration |

A compact GitLab equivalent of the integration job:

```yaml
integration:
  stage: test
  image: node:20.18.1
  services:
    - name: postgres:16.4-alpine
      alias: postgres
    - name: redis:7.4-alpine
      alias: redis
  variables:
    POSTGRES_USER: test
    POSTGRES_PASSWORD: test
    POSTGRES_DB: orders_test
    # The job runs in a container here, so services are addressed by alias,
    # not localhost. This is the single most common GitLab CI mistake.
    DATABASE_URL: postgres://test:test@postgres:5432/orders_test
    REDIS_URL: redis://redis:6379
  cache:
    key:
      files: [package-lock.json]
    paths: [.npm/]
  script:
    - npm ci --cache .npm --prefer-offline
    - npm run migration:run
    - npm run test:int
  artifacts:
    when: always
    reports:
      junit: junit.xml
```

The one real behavioural difference to remember: in GitLab the job itself normally runs inside a container, so `services:` are reachable by alias and never on `localhost`. In GitHub Actions the job usually runs directly on the runner, so `services:` are reachable on `localhost` through published ports — unless you set `container:`, in which case the rule flips. Getting this backwards produces intermittent `ECONNREFUSED` that people spend days blaming on the application.

