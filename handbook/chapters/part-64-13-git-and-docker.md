## 64.14 Git

### Q181. Merge or rebase?

- **Expected answer** — `merge` creates a commit with two parents, preserving exactly what happened; `rebase` replays your commits on top of the new base, producing a linear history but *rewriting* commit hashes. The rule that matters: never rebase commits that others have pulled, because everyone else's history diverges and the fix involves force-pushes and confusion. My practical policy: rebase your own feature branch onto `main` while you work (so you resolve conflicts incrementally and your branch stays reviewable), then merge into `main` — either a squash merge for small features, which gives one clean commit per unit of work and a readable `main`, or a merge commit for larger features where the individual commits carry meaning. The trade-off is honest: linear history makes `git log`, `bisect` and blame far easier to read, while merge commits preserve the true development record and make reverting a whole feature a single operation. What I care about more than the policy is that the team has *one* policy, enforced by branch protection settings, because mixed strategies produce the worst of both.

- **Why it matters** — It reveals whether someone has actually collaborated on a busy repository.

- **Follow-ups** — What is the danger of rebasing a shared branch and how do you recover? How does squash merging affect `git bisect`? When do you want a merge commit?

- **Senior signal** — States the shared-history rule, picks a policy for a reason, and cares about enforcement rather than preference.

### Q182. What branching strategy would you set up for a team of 12 deploying daily?

- **Expected answer** — Trunk-based development: everyone commits to short-lived branches off `main`, branches live hours to two days, pull requests are small, CI runs on every push, and `main` is always releasable. Long-lived branches are the enemy — a two-week feature branch guarantees a painful merge and hides work from CI. Incomplete features ship behind **feature flags** rather than being held back in a branch, which also decouples deploy from release and lets you turn something off without a rollback. GitFlow, with its `develop`, `release` and `hotfix` branches, was designed for versioned software with scheduled releases; for a service deployed daily it adds ceremony and merge overhead for no benefit. What supports this: branch protection requiring review and green CI, a fast pipeline (if CI takes 40 minutes people batch changes and branches grow), automated deploys from `main` to staging, and a documented rollback that is faster than a fix-forward. The one place I keep release branches is when you must support multiple customer versions simultaneously, which is a different problem.

- **Why it matters** — Branching strategy determines integration pain and deployment frequency.

- **Follow-ups** — How do you handle a database migration behind a feature flag? What CI duration is acceptable and why? When is GitFlow right?

- **Senior signal** — Ties branching to feature flags and CI speed, and separates deploy from release.

### Q183. How do you use `git bisect`?

- **Expected answer** — When you know a behaviour worked at commit A and is broken at commit B, `bisect` binary-searches the range: `git bisect start`, `git bisect bad`, `git bisect good <sha>`, then git checks out the midpoint and you test and mark `good`/`bad`. Over 1,000 commits that is about 10 steps. Better, automate it: `git bisect run npm test -- path/to/failing.test.ts` (or any script exiting 0 for good and non-zero for bad) and walk away — this is where bisect goes from a party trick to a real tool, especially for a performance regression where the script measures a threshold. Practical requirements: commits must be individually buildable and testable, which is an argument for atomic commits and against giant squashes; use `git bisect skip` for commits that will not build; and remember `git bisect reset` to return to where you were. I have used it most for regressions with no obvious cause — a subtle behaviour change from a dependency bump, or a query that got 10x slower — where reading diffs would have taken a day and bisect took twenty minutes.

- **Why it matters** — It shows a debugging toolkit beyond reading code and adding logs.

- **Follow-ups** — What makes a repository bisect-friendly? How would you bisect a flaky failure? What do you do if the bad commit is a merge of 40 changes?

- **Senior signal** — Uses `bisect run` with an automated predicate and connects it back to commit hygiene.

### Q184. A bad commit is on `main` and deployed. `revert`, `reset`, or something else?

- **Expected answer** — On a shared branch, `git revert` — it creates a new commit that undoes the change, so history is preserved and nobody has to force-pull. `git reset --hard` rewrites history and is only appropriate on a local, unpushed branch; doing it on `main` and force-pushing breaks everyone's clone and destroys the audit trail. If the bad commit is a merge, `git revert -m 1 <sha>` picks the mainline parent, and you must remember that re-merging that branch later will *not* reapply the reverted changes unless you revert the revert. Beyond the mechanics, the senior answer covers the deploy: the fastest safe action is usually to roll back the *deployment* to the previous image (seconds) rather than waiting for a revert commit to build and ship (minutes), and only then land the revert in `main` so the two do not diverge. If the commit included a database migration, a revert of the code does not undo the schema change, so you need the expand-and-contract discipline that makes the previous version compatible with the new schema — otherwise "roll back" is not actually available and you must fix forward.

- **Why it matters** — This is an incident-response question wearing Git clothes.

- **Follow-ups** — Why does re-merging a reverted branch lose changes? What if the commit leaked a secret? What makes rollback impossible?

- **Senior signal** — Separates rolling back the deployment from reverting the code, and raises migrations as the thing that blocks rollback.

### Q185. How do you ship an urgent hotfix while `main` has unreleased work?

- **Expected answer** — Branch from the *deployed* commit (the tag or SHA currently in production), not from `main`, because `main` contains untested work you do not want to ship under pressure. Make the minimal fix, get an expedited review — expedited, not skipped — run CI, deploy, verify with a specific metric or log line rather than "it looks fine", then `cherry-pick` the fix onto `main` (or merge the hotfix branch) so it is not lost in the next release. Tag the hotfix so the deployed artifact is identifiable. If a cherry-pick conflicts because `main` has moved, resolve it deliberately rather than reapplying the change by hand, and add a test that fails without the fix. Afterwards, the important part: a short write-up covering why the bug reached production and what would have caught it, because a hotfix that is not followed by a prevention step guarantees a repeat. If you find yourself hotfixing weekly, the real problem is the pipeline or the test suite, not the process.

- **Why it matters** — It tests judgement under time pressure, which is exactly when process gets abandoned.

- **Follow-ups** — What do you *not* skip under pressure? How do you verify the fix worked? What happens if the cherry-pick to `main` is forgotten?

- **Senior signal** — Branches from the deployed SHA, refuses to skip review and tests, and closes the loop with prevention.

### Q186. How do you recover work you think you have lost?

- **Expected answer** — `git reflog` first: it records where `HEAD` and branch tips have been for the last 90 days by default, including commits orphaned by a `reset --hard`, a bad rebase, a deleted branch or an amended commit. Find the SHA, then `git checkout -b recovery <sha>` or `git reset --hard <sha>`. For a rebase specifically, `ORIG_HEAD` points at where you were before it started. For content that was staged but never committed, `git fsck --lost-found` can surface dangling blobs. For uncommitted, unstaged changes there is genuinely nothing — which is the practical lesson: commit early and often, even messy commits, because you can always clean history later with an interactive rebase but you cannot recover what was never committed. `git stash` is also recoverable through the reflog of `refs/stash`. Worth knowing the boundary: objects unreachable for longer than the reflog expiry can be removed by `git gc`, so recovery is not indefinite.

- **Why it matters** — Everyone destroys work at some point; the recovery habit is the difference between a minute and a day.

- **Follow-ups** — How do you recover a branch deleted last week? What does `git gc` do to your safety net? What is `ORIG_HEAD`?

- **Senior signal** — Knows the reflog expiry boundary and turns the answer into a habit ("commit early, clean later").

### Q187. What does good commit and pull-request hygiene look like?

- **Expected answer** — Commits should be atomic: one logical change, buildable and testable on its own, which is what makes `bisect`, `revert` and code archaeology work. The message explains *why*, not what — the diff already shows what — with a short imperative subject, a blank line, and a body covering the reasoning, trade-offs and any ticket reference. Conventional Commits are worth adopting if you want automated changelogs and semantic versioning. Pull requests should be small: reviewers genuinely degrade past a few hundred lines, so a 2,000-line PR gets "LGTM" rather than review, which means large PRs are effectively unreviewed. Separate mechanical changes (a rename, a format run) into their own commits or PRs so the substantive diff is readable. In the description, say what changed, why, how you tested it, and what the risk and rollback are. As a reviewer, distinguish blocking concerns from preferences and say which is which; as an author, respond to every comment even if the answer is "good point, follow-up ticket". The measurable goal is a short review turnaround, because a PR sitting for two days is the largest hidden cost in most teams' delivery.

- **Why it matters** — Review quality and history quality compound over years.

- **Follow-ups** — How do you handle a 3,000-line PR you are asked to review? What belongs in a commit body? How do you speed up review turnaround?

- **Senior signal** — Explains *why* small PRs matter (review degrades with size) and treats review latency as a delivery metric.

### Q188. What do you know about monorepos, submodules and rewriting history?

- **Expected answer** — A monorepo puts multiple services or packages in one repository, giving atomic cross-project changes, one dependency graph and one CI configuration, at the cost of needing tooling (Nx, Turborepo, Bazel) for affected-only builds, and eventually of repository size. Polyrepos are simpler per project but make cross-cutting changes a coordination exercise across several PRs and deploys. Submodules are the option I avoid: they pin a specific commit of another repository, which sounds right and in practice means detached heads, forgotten updates and confused clones; a package registry or a monorepo solves the same problem better. Git LFS is for large binaries — put them there or, better, in object storage, because a 500 MB asset committed once is in every clone forever. On rewriting history (`filter-repo`, or `filter-branch`): it is the only way to purge a leaked secret or a huge accidental file, it rewrites every downstream hash so everyone must re-clone, and it must be paired with rotating the leaked credential, because anyone who cloned before the rewrite still has it. Coordinate it, announce it, and do it once.

- **Why it matters** — These are the decisions that make a repository pleasant or painful for years.

- **Follow-ups** — When is a monorepo the wrong call? Why is rewriting history not enough after a secret leak? How do you keep CI fast in a monorepo?

- **Senior signal** — Rejects submodules with a reason, and pairs history rewriting with credential rotation.

## 64.15 Docker

### Q189. How does Docker layer caching work and how do you exploit it?

- **Expected answer** — Each instruction in a Dockerfile creates a layer, and a layer is reused if the instruction and all its inputs are unchanged; the moment one layer's cache is invalidated, every layer after it rebuilds. That gives a clear ordering rule: put the things that change least at the top. For a Node service that means copying `package.json` and the lockfile, running `npm ci`, and only *then* copying the source — because copying source first means every code change reinstalls hundreds of megabytes of dependencies, turning a 20-second build into three minutes.

  ```dockerfile
  COPY package*.json ./
  RUN npm ci --omit=dev
  COPY . .
  RUN npm run build
  ```

  Also: use a `.dockerignore` (excluding `node_modules`, `.git`, test fixtures) or the build context alone will be hundreds of megabytes and invalidate caches unpredictably; combine `apt-get update` and `install` in one `RUN` so you never get a stale package index from cache; and in CI enable BuildKit with a registry cache (`--cache-from`) since CI runners start with an empty local cache. Measure it — build time directly affects how often people deploy.

- **Why it matters** — Build time is a developer-productivity multiplier and it is almost always fixable.

- **Follow-ups** — Why does `RUN apt-get update` on its own line cause problems? How do you get cache reuse on ephemeral CI runners? What belongs in `.dockerignore`?

- **Senior signal** — Orders layers by change frequency deliberately and knows the CI cache problem.

### Q190. Explain multi-stage builds and what your production image should contain.

- **Expected answer** — A multi-stage build uses several `FROM` stages and copies only the artifacts you need into the final one, so build tools never ship. For a NestJS service: a `builder` stage on `node:22` that installs all dependencies and runs `tsc`, then a runtime stage that installs only production dependencies and copies `dist`.

  ```dockerfile
  FROM node:22-alpine AS builder
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  FROM node:22-alpine
  WORKDIR /app
  ENV NODE_ENV=production
  COPY package*.json ./
  RUN npm ci --omit=dev && npm cache clean --force
  COPY --from=builder /app/dist ./dist
  USER node
  CMD ["node", "dist/main.js"]
  ```

  The result drops from roughly 1.2 GB to 150–200 MB. Smaller images pull faster (which matters on every scale-up and node replacement), and they have a smaller attack surface — no compilers, no `git`, no shell utilities for an attacker to use. Consider `distroless` or Alpine, with the caveat that Alpine uses musl instead of glibc, which occasionally breaks native modules and can change DNS resolution behaviour, so test rather than assume.

- **Why it matters** — Image size affects deploy speed, cost and security posture.

- **Follow-ups** — What is the Alpine/musl risk for Node? Why does image size affect autoscaling? What is left in your image that should not be?

- **Senior signal** — Connects image size to scale-up latency, and knows the Alpine trade-off concretely.

### Q191. `CMD` versus `ENTRYPOINT`, and why does PID 1 matter for Node?

- **Expected answer** — `ENTRYPOINT` defines the executable; `CMD` provides default arguments (and is fully replaced by anything you pass on `docker run`). Use exec form (`CMD ["node", "dist/main.js"]`), never shell form (`CMD node dist/main.js`), because shell form runs your process as a child of `/bin/sh` — and then the shell is PID 1, `SIGTERM` goes to the shell, and your Node process never receives it. That is exactly why "my graceful shutdown never runs" and why pods take the full termination grace period before being `SIGKILL`ed, producing dropped connections on every deploy. PID 1 also has a special role: it must reap zombie processes, which Node does not do, so if your app spawns child processes you want an init (`--init` on `docker run`, or `tini`) as PID 1. The other classic mistake is wrapping the app in `npm start`: npm becomes PID 1, does not forward signals reliably, and adds a process for no benefit. Run `node` directly.

- **Why it matters** — Signal handling is the difference between clean rolling deploys and 502s.

- **Follow-ups** — How would you prove your container receives `SIGTERM`? Why is `npm start` a problem in a container? When do you need `tini`?

- **Senior signal** — Connects exec form and PID 1 directly to failed graceful shutdown, which is a scar, not theory.

### Q192. Volumes, bind mounts and container storage — what do you use where?

- **Expected answer** — The container filesystem is a writable layer that disappears when the container is removed, and writing to it is slower than writing to a volume because of the copy-on-write layer. **Named volumes** are Docker-managed storage that survives the container and is the right choice for local development databases. **Bind mounts** map a host path into the container, used for mounting source code during development for hot reload, and for configuration; on macOS and Windows bind mounts are notably slow because of the file-sharing layer, which is why large `node_modules` should live in a volume rather than being bind-mounted. **tmpfs** mounts keep data in memory, useful for secrets or scratch space you do not want on disk. In production under Kubernetes, none of this is how you do it: persistent data lives in a `PersistentVolumeClaim` backed by network storage, or more often not in the pod at all — the container is stateless and the state is in Postgres or S3. The senior framing: containers should be immutable and disposable, so anything written locally must be either cache or logs, and both must be safe to lose.

- **Why it matters** — Storage confusion produces both slow development and lost data.

- **Follow-ups** — Why is a bind-mounted `node_modules` slow on macOS? What breaks when two replicas share a volume? Where do your logs go?

- **Senior signal** — States the immutable-disposable-container principle and knows local development performance realities.

### Q193. How do you run a realistic local environment with Compose?

- **Expected answer** — A `docker-compose.yml` with the application plus its real dependencies — Postgres, Redis, maybe LocalStack for S3 and a broker — on a user-defined network so services resolve each other by service name. Key details that make it actually work: `depends_on` with `condition: service_healthy` plus real `healthcheck` definitions, because `depends_on` alone only waits for the container to start, not for Postgres to accept connections, which is the source of flaky first-run failures; pinned image versions matching production (`postgres:16.4`, not `postgres:latest`) so you do not debug a version difference; named volumes for database data so restarts do not wipe your test data, with a documented `down -v` to reset; environment variables from a `.env` that is git-ignored, with a committed `.env.example`; and a separate compose file or profile for the test dependencies used in CI. The judgement point: Compose is for local development and integration tests, not production. If someone proposes running Compose on an EC2 instance as the production deployment, the honest answer is that it works for a very small system but gives you no rolling deploy, no health-based restarts and no horizontal scaling.

- **Why it matters** — Local/production parity determines how many bugs are found before deploy.

- **Follow-ups** — Why is `depends_on` insufficient? How do you seed test data reproducibly? Would you run Compose in production, and when?

- **Senior signal** — Healthcheck-gated dependencies and version pinning, plus a clear boundary on production use.

### Q194. How do you harden a container image?

- **Expected answer** — Run as a non-root user (`USER node`, or a created user with a fixed UID) so a container escape or a write vulnerability is less useful, and set `readOnlyRootFilesystem` with an explicit writable `emptyDir` for anything that must be written. Use a minimal base — `distroless` or Alpine — so there is no shell, no `curl`, no package manager for an attacker to pivot with. Pin the base image by digest so a rebuilt tag cannot silently change what you ship. Never put secrets in the image: `ENV API_KEY=...` and `COPY .env .` are visible to anyone with the image, and deleting a file in a later layer does not remove it from the earlier one — use BuildKit secret mounts for build-time credentials and runtime injection for the rest. Scan images in CI (Trivy, Grype) and again in the registry, since new CVEs appear for images you already shipped. Drop Linux capabilities and disallow privilege escalation in the runtime security context, and sign images with cosign plus an admission policy if your environment supports it. Finally, rebuild regularly: an image built six months ago has six months of unpatched base-layer CVEs even if your code has not changed.

- **Why it matters** — Container security is mostly a small set of defaults that are easy to get right and commonly skipped.

- **Follow-ups** — Why does deleting a secret in a later layer not help? What is the practical benefit of a read-only root filesystem? How often do you rebuild?

- **Senior signal** — The layer-history point about secrets, and periodic rebuilds for base-image CVEs.

### Q195. How do you set memory and CPU limits for a Node container?

- **Expected answer** — Two separate systems must agree: the container limit and V8's heap limit. If the container is limited to 512 MB and Node's old-space limit is higher, the kernel OOM-kills the process (exit 137, `OOMKilled`) with no JavaScript-level error, and you see a restart with no stack trace. So set `--max-old-space-size` to roughly 75–80% of the container memory limit, leaving room for Buffers, native memory, thread stacks and the runtime itself — for a 1 GB limit, around 768 MB. On CPU: Node is mostly single-threaded for JavaScript, so a CPU limit below 1 core means the process is throttled by cgroup quota, which shows up as bursty latency and unexplained event-loop lag rather than steady slowness; give at least 1 core for a latency-sensitive service and prefer more replicas over more CPU per replica. Also be aware that `os.cpus()` reports host cores, not your quota, so any library sizing pools by CPU count will over-provision — set `UV_THREADPOOL_SIZE` and any worker pool size explicitly. Verify by loading the service and watching RSS versus the limit, GC time, and throttling metrics.

- **Why it matters** — Silent `OOMKilled` restarts and CPU throttling are two of the most common and most misdiagnosed container problems.

- **Follow-ups** — How do you tell an `OOMKilled` from a V8 heap OOM? What does CPU throttling look like in your metrics? Why is `os.cpus()` misleading?

- **Senior signal** — The 75–80% heap rule with a reason, and the cgroup-awareness gap in `os.cpus()`.

### Q196. What is the difference between a Docker `HEALTHCHECK` and what you need in production?

- **Expected answer** — A Dockerfile `HEALTHCHECK` runs a command inside the container and marks it healthy or unhealthy; standalone Docker or Compose can restart on that, but Kubernetes ignores it entirely and uses its own probes. That matters because the semantics differ and you need both concepts distinctly: a **liveness** check answers "is this process wedged and in need of a restart?" and must be cheap and dependency-free — checking the database in a liveness probe means a database blip restarts every pod simultaneously, converting a degradation into an outage. A **readiness** check answers "should traffic come to me right now?" and *should* check critical dependencies, so a pod with a broken database connection is removed from the load balancer without being killed. A **startup** probe covers slow boots so liveness does not kill a pod that is still warming. Logs are the other half: containers should log JSON to stdout and let the platform collect it, never write log files inside the container, and include a request/trace id in every line. The senior point is that health endpoints are an interface with the orchestrator, and getting the liveness/readiness distinction wrong is a self-inflicted outage waiting for its trigger.

- **Why it matters** — Probe design is one of the highest-consequence, least-considered pieces of configuration.

- **Follow-ups** — What exactly does your liveness endpoint check? What happens when the database is slow and readiness times out on every pod? Where do logs go?

- **Senior signal** — The dependency-free liveness rule with the cascading-restart failure story.
