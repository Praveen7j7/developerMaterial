## 44.12 Docker Compose for local development

#### Concept

Docker Compose describes a multi-container application in one YAML file: services, their images or build instructions, networks, volumes, environment, health checks and start-up ordering. `docker compose up` creates everything; `docker compose down` removes it. For a backend team it replaces the "install PostgreSQL 16, Redis 7, Kafka, Jaeger, Prometheus and Grafana on your laptop" onboarding document with one command that works the same on every machine.

#### Why does it exist?

A NestJS API depends on at least a database and usually a cache, a broker and observability tools. Installing them natively means version drift between developers (PostgreSQL 14 on one laptop, 16 on another), port conflicts, forgotten background services, and "works for me" bugs. Compose pins every dependency's version, isolates them on a private network, gives them persistent volumes, and encodes the start-up order so the API does not try to connect before PostgreSQL accepts connections.

#### Mental model

Imagine a theatre production. Compose is the stage manager's call sheet: which actors (services) are in the show, what costume (image) each wears, where they stand (network), what props they keep between performances (volumes), who must be in position before the curtain rises (`depends_on` with health conditions), and how to check that they are ready (health checks). One call sheet, same show every night.

#### How it works

1. Compose reads `docker-compose.yml` (and any `-f` overrides, merged in order), substituting `${VARS}` from the shell and the `.env` file next to it.
2. It creates a project network (`<dir>_default`) and named volumes.
3. It resolves `depends_on`. With `condition: service_healthy`, a service starts only after its dependency's `healthcheck` passes; with `condition: service_completed_successfully`, only after a one-shot dependency exits `0`.
4. It builds images for services with `build:` (using BuildKit and the layer cache), pulls the rest.
5. It creates and starts containers, attaching them to the network with their service names as DNS names.
6. `docker compose logs -f` multiplexes stdout from every container with a colour per service. `docker compose ps` shows state and health.

Key features that matter for a backend stack:

| Feature | Syntax | Why you need it |
|---|---|---|
| Health check | `healthcheck: { test: [...], interval, timeout, retries, start_period }` | Ordering on real readiness, not on "container started" |
| Ordered start | `depends_on: { postgres: { condition: service_healthy } }` | No `ECONNREFUSED` storms at boot |
| One-shot job | `restart: "no"` plus `depends_on: ... condition: service_completed_successfully` on consumers | Migrations run once before the API starts |
| Hot reload | bind mount `./src:/app/src` plus `nest start --watch` | Edit on host, container reloads |
| Profiles | `profiles: ["observability"]` | Start heavy optional services only when needed |
| Override files | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up` | Same base, different environment |
| Resource hints | `deploy.resources.limits` (honoured by `docker compose` v2) | Reproduce memory limits locally |

#### Practical example

A full local stack for the orders API: PostgreSQL 16, Redis 7, Kafka (KRaft, no ZooKeeper), Jaeger for traces, Prometheus and Grafana, a migration runner, and the API with hot reload. Observability is behind a profile so the default `up` is fast.

```yaml
# docker-compose.yml
name: orders

services:
  postgres:
    image: postgres:16.4-alpine
    environment:
      POSTGRES_USER: orders
      POSTGRES_PASSWORD: orders
      POSTGRES_DB: orders
    ports:
      - "5432:5432"                 # for a GUI on the laptop; the API uses the service name
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U orders -d orders"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"]
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 2s
      retries: 10

  kafka:
    image: apache/kafka:3.8.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:29092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,EXTERNAL://localhost:29092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
    ports:
      - "29092:29092"               # laptop clients use localhost:29092; containers use kafka:9092
    volumes:
      - kafkadata:/var/lib/kafka/data
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 > /dev/null 2>&1"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

  migrate:
    build:
      context: .
      target: build                 # has compiled dist and the TypeORM CLI
    command: ["node", "node_modules/typeorm/cli.js", "migration:run", "-d", "dist/database/data-source.js"]
    env_file: .env
    environment:
      DB_HOST: postgres
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      target: deps                  # full toolchain for nest start --watch
    command: ["npx", "nest", "start", "--watch", "--preserveWatchOutput"]
    env_file: .env
    environment:
      DB_HOST: postgres
      REDIS_URL: redis://redis:6379
      KAFKA_BROKERS: kafka:9092
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318
      CHOKIDAR_USEPOLLING: "true"
    ports:
      - "3000:3000"
      - "9229:9229"                 # node --inspect for the debugger
    volumes:
      - ./src:/app/src
      - ./tsconfig.json:/app/tsconfig.json:ro
      - /app/node_modules
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      kafka:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    deploy:
      resources:
        limits:
          memory: 512M              # feel the production limit locally

  jaeger:
    image: jaegertracing/all-in-one:1.60
    profiles: ["observability"]
    ports:
      - "16686:16686"               # UI
      - "4318:4318"                 # OTLP HTTP
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  prometheus:
    image: prom/prometheus:v2.54.1
    profiles: ["observability"]
    volumes:
      - ./observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:11.2.0
    profiles: ["observability"]
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafanadata:/var/lib/grafana
      - ./observability/grafana/provisioning:/etc/grafana/provisioning:ro
    ports:
      - "3001:3000"

volumes:
  pgdata:
  kafkadata:
  grafanadata:
```

Everyday commands:

```bash
docker compose up -d                              # core stack
docker compose --profile observability up -d      # plus Jaeger, Prometheus, Grafana
docker compose logs -f api migrate                # follow two services
docker compose exec postgres psql -U orders       # shell into the database
docker compose run --rm migrate node node_modules/typeorm/cli.js migration:revert -d dist/database/data-source.js
docker compose down                               # keep volumes
docker compose down -v                            # destroy data, fresh start
```

If you prefer RabbitMQ to Kafka locally, the service is simpler: `image: rabbitmq:3.13-management-alpine`, ports `5672:5672` and `15672:15672`, healthcheck `["CMD", "rabbitmq-diagnostics", "-q", "ping"]`, and the API's `RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672`.

#### NestJS example

The API should start cleanly against this stack and be debuggable. `nest start --watch --debug 0.0.0.0:9229` exposes the inspector on all interfaces inside the container so the published port works:

```json
{
  "scripts": {
    "start:dev": "nest start --watch --preserveWatchOutput",
    "start:debug": "nest start --watch --debug 0.0.0.0:9229 --preserveWatchOutput",
    "build": "nest build",
    "migration:run": "node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js",
    "migration:generate": "npm run build && node node_modules/typeorm/cli.js migration:generate -d dist/database/data-source.js"
  }
}
```

A VS Code `launch.json` attach configuration then points at `localhost:9229` with `remoteRoot: /app` and `localRoot: ${workspaceFolder}` so breakpoints in `src` map to the container's files.

#### PostgreSQL example

The health check `pg_isready` answers "is the server accepting connections", which is what the migration runner needs. The init script directory sets up extensions and, for local dev only, a second database for integration tests so that Jest does not truncate your manual test data:

```sql
-- db/init/02-test-db.sql (runs once, on an empty volume)
CREATE DATABASE orders_test OWNER orders;
\connect orders_test
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

#### TypeORM example

The migration runner in Compose is the same command CI runs before deploying, and the same command the Kubernetes Job runs in production (Part 45). One command, three places:

```bash
node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
```

Because `dist/database/data-source.js` reads the environment (44.9), `DB_HOST=postgres` locally and an RDS hostname in production need no code change.

#### Sequelize example

With `sequelize-cli`, the migration service becomes:

```yaml
  migrate:
    build: { context: ., target: build }
    command: ["npx", "sequelize-cli", "db:migrate", "--config", "dist/config/sequelize-cli.js", "--migrations-path", "dist/migrations"]
    env_file: .env
    environment: { DB_HOST: postgres }
    restart: "no"
    depends_on: { postgres: { condition: service_healthy } }
```

#### Production scenario

Compose is a development and single-host tool. Some teams run small internal services with `docker compose` on one VM plus `restart: unless-stopped`, and that is fine for a service with no availability requirement. For anything customer-facing with more than one replica, use ECS, Kubernetes or a managed platform (see Part 45 and the cloud deployment discussion in Part 63). The value Compose keeps delivering in production teams is the *parity*: the same images, migration command and environment variable names on a laptop, in CI, and in the cluster.

#### Failure scenario

A new hire runs `docker compose up` and the API crashes in a loop with `ECONNREFUSED postgres:5432`. The Compose file has `depends_on: [postgres]` in the old list form, which only orders container *start*, not readiness. PostgreSQL takes 6 seconds to initialise on first run; the API tries at second 1. The fix is the `healthcheck` plus `condition: service_healthy`. A related trap: the API itself should still retry database connections at startup (TypeORM `retryAttempts`/`retryDelay`), because in production a database failover can produce the same window.

#### Edge cases & failure modes

- **Old `depends_on` list form** orders start only; use the map form with conditions.
- **Health check commands must exist in the image.** `curl` is absent in Alpine and distroless; use `wget -qO-`, `pg_isready`, `redis-cli`, or `node -e`.
- **Hot reload across the Desktop VM** needs polling (`CHOKIDAR_USEPOLLING`) and can be slow with large trees; bind-mount `src` only.
- **Port collisions** between projects; use `name:` and different host ports, or no published ports.
- **`.env` precedence.** Shell variables override `.env`; a stale `DB_HOST` exported in your shell profile wins silently.
- **Kafka advertised listeners.** Clients inside the network must use `kafka:9092`, clients on the laptop `localhost:29092`; mixing them produces "connected then metadata failed" errors.
- **Migration service re-runs on every `up`.** Fine (migrations are idempotent by design) but slow; use `docker compose up api` to skip it when nothing changed.
- **Data left in volumes** makes "fresh clone works?" tests lie; run `down -v` before testing onboarding.

#### How a Senior Backend Engineer thinks about this

They see Compose as documentation that executes: the file *is* the list of dependencies and their versions. They keep it honest with health checks and one-shot migrations so that `up` either works or fails loudly. They keep it fast with profiles. And they make sure the images and commands in it are the same ones production uses, because parity is where the bugs are found early.

#### Common mistakes

- List-form `depends_on` and startup crash loops.
- Publishing every port and colliding across projects.
- Running migrations inside the API's startup (slow boots, races between replicas; see Part 24 and Part 25 on migrations and zero-downtime releases).
- Committing `.env` with real credentials.
- Bind-mounting `node_modules`.

#### Interview questions

1. *How do you make the API wait for PostgreSQL in Compose, and why is that not enough on its own?* Expected: `healthcheck` plus `condition: service_healthy`; the app still needs connection retries for production failovers.
2. *How do you run migrations exactly once before the API starts locally?* Expected: one-shot service with `restart: "no"` and `condition: service_completed_successfully`.
3. *Why should the Compose migration command match the production one?* Expected: parity; the same `dist/data-source.js` and environment contract; bugs surface locally.
4. *When is Compose appropriate in production?* Expected: single host, low availability needs, internal tools; otherwise an orchestrator.

#### Practical exercise

Build the Compose stack above for your service. Run `docker compose down -v && docker compose up -d` and time it until `curl localhost:3000/health/ready` returns 200. Break the migration (a bad SQL statement) and confirm the API does not start. Acceptance criteria: a clean start completes in under 90 seconds on a warm image cache, the API never logs `ECONNREFUSED` during boot, a failing migration blocks the API with a clear log line, and a colleague can run the stack from a fresh clone with only `cp .env.example .env && docker compose up`.

## 44.13 Containerizing a NestJS + PostgreSQL application

This section is the whole part applied to one service, end to end: the orders API (NestJS 10, TypeORM, PostgreSQL 16, Redis for caching and BullMQ). The goal is a production image under 250 MB, non-root, signal-safe, with a health check, plus Compose files for development and for a single-host production-like run, an image tagging strategy, and the exact build and push commands.

### 44.13.1 The production Dockerfile

```dockerfile
# syntax=docker/dockerfile:1.7
# ---------- deps: full install (dev deps included) for build and test ----------
FROM node:20.18.1-alpine3.20@sha256:2d07db07a2df6830718ae2a47db6fedce6745f5bcd174c398f2acdda90a11c03 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Cache mount keeps the npm cache across builds so the second install below is fast
RUN --mount=type=cache,target=/root/.npm npm ci

# ---------- build: compile TypeScript to dist ----------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------- prod-deps: runtime dependencies only ----------
FROM node:20.18.1-alpine3.20@sha256:2d07db07a2df6830718ae2a47db6fedce6745f5bcd174c398f2acdda90a11c03 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
 && npm cache clean --force

# ---------- runtime: minimal, non-root, signal-safe ----------
FROM node:20.18.1-alpine3.20@sha256:2d07db07a2df6830718ae2a47db6fedce6745f5bcd174c398f2acdda90a11c03 AS runtime
RUN apk add --no-cache tini tzdata

ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=384 --enable-source-maps"

WORKDIR /app
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Used by Compose and standalone Docker; ignored by Kubernetes (kubelet probes replace it)
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ARG GIT_SHA=unknown
ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="orders-api" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/acme/orders-api"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
```

Why each choice was made:

- **Digest-pinned base** on all three `FROM` lines: reproducible; the `sha256` is the same string, so it is easy to bump with Renovate.
- **`tini`** so that `SIGTERM` is forwarded and zombies reaped; `CMD` in exec form so `node` is the direct child.
- **`--max-old-space-size=384`** assumes a 512 MB limit in production; if the deployment sets 1 GB, override `NODE_OPTIONS` there.
- **`--enable-source-maps`** so stack traces point at `src/orders/orders.service.ts:42`, not `dist/orders/orders.service.js:17`.
- **`USER node`** after all copies; files are already owned by `node` via `--chown`, so no extra layer.
- **Labels last** so the volatile `GIT_SHA` never invalidates the cache.
- **The `HEALTHCHECK`** uses `node -e` because Alpine's busybox `wget` works but `curl` does not exist, and a distroless variant would have neither.

### 44.13.2 `.dockerignore`

```text
node_modules
dist
coverage
.git
.github
.vscode
.idea
.env
.env.*
!.env.example
*.md
test
**/*.spec.ts
**/*.e2e-spec.ts
Dockerfile*
docker-compose*.yml
observability
db/init
npm-debug.log*
```

The build context for the orders API drops from 480 MB (with `node_modules`) to 1.9 MB.

### 44.13.3 The application side

Three things in the code make the image behave: shutdown hooks, health endpoints and a config schema. The `main.ts` from 44.1 (`enableShutdownHooks`, bind `0.0.0.0`), the `HealthController` from 44.5 (`/health/live` without the database, `/health/ready` with it) and the Joi schema from 44.9 are exactly what this image expects. The only addition is the TypeORM connection retry so that a database restart during boot does not crash the container:

```ts
// src/app.module.ts (excerpt)
TypeOrmModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    ...dataSourceOptions,
    host: config.getOrThrow<string>('DB_HOST'),
    // Retry for ~30 s at boot instead of exiting on the first ECONNREFUSED
    retryAttempts: 10,
    retryDelay: 3_000,
    autoLoadEntities: true,
  }),
}),
```

### 44.13.4 Development Compose

The development file is the one shown in 44.12: PostgreSQL 16 on a named volume, Redis, the migration runner as a one-shot service, and the API built to the `deps` target running `nest start --watch` with `src` bind-mounted. Nothing in it is repeated here; the point is that the same Dockerfile serves both (`target: deps` for dev, the default final stage for production).

### 44.13.5 Production-like Compose

For a staging box or a single-host deployment, an override file changes only what must differ: the final image from the registry instead of a local build, no bind mounts, no published database port, resource limits, restart policies, log rotation and file-mounted secrets.

```yaml
# docker-compose.prod.yml  (use with: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d)
services:
  postgres:
    ports: !reset []                     # not reachable from outside the host
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    restart: unless-stopped
    deploy:
      resources:
        limits: { memory: 2G }

  redis:
    ports: !reset []
    restart: unless-stopped

  migrate:
    image: registry.internal/orders-api:${IMAGE_TAG}
    build: !reset null
    command: ["node", "node_modules/typeorm/cli.js", "migration:run", "-d", "dist/database/data-source.js"]
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]

  api:
    image: registry.internal/orders-api:${IMAGE_TAG}
    build: !reset null
    command: !reset []                   # fall back to the image CMD: tini + node dist/main.js
    volumes: !reset []                   # no bind mounts; the image is the code
    ports:
      - "3000:3000"
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password
      CHOKIDAR_USEPOLLING: !reset null
    secrets: [db_password]
    read_only: true
    tmpfs: ["/tmp:size=64m"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    restart: unless-stopped
    deploy:
      resources:
        limits: { memory: 512M, cpus: "1.0" }
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "5" }

secrets:
  db_password:
    file: ./secrets/db_password.txt      # outside Git; on a real host, from a secret store
```

The `!reset` tag is Compose's way to remove a key inherited from the base file. The `DB_PASSWORD_FILE` variable requires a tiny addition to the config loader: if `DB_PASSWORD` is unset and `DB_PASSWORD_FILE` is set, read the file. Do that once in `database.config.ts` and both Compose and Kubernetes secret volumes work.

### 44.13.6 Build, tag and push

```bash
# Local build of the production image
docker build \
  --build-arg GIT_SHA=$(git rev-parse --short HEAD) \
  --build-arg VERSION=$(node -p "require('./package.json').version") \
  -t orders-api:local .

# Verify the essentials before pushing anything
docker run --rm orders-api:local id -u                              # 1000
docker run --rm orders-api:local node -e "console.log(process.version)"
docker inspect orders-api:local --format '{{.Config.Entrypoint}} {{.Config.Cmd}}'
docker history --format "table {{.Size}}\t{{.CreatedBy}}" orders-api:local | head -20

# Tag and push (CI does this; see 26.15 for the buildx version with cache)
SHA=$(git rev-parse --short HEAD)
VERSION=1.4.2
REG=123456789012.dkr.ecr.eu-west-1.amazonaws.com/orders-api
aws ecr get-login-password | docker login --username AWS --password-stdin ${REG%%/*}
docker tag orders-api:local $REG:sha-$SHA
docker tag orders-api:local $REG:$VERSION
docker tag orders-api:local $REG:1.4
docker push $REG:sha-$SHA && docker push $REG:$VERSION && docker push $REG:1.4
docker inspect --format '{{index .RepoDigests 0}}' $REG:sha-$SHA   # the digest to deploy
```

### 44.13.7 Tagging strategy

| Tag | Example | Who moves it | Used by |
|---|---|---|---|
| Git SHA | `sha-3f9a1c2` | Never (immutable) | Deployments; every rollout references one |
| Semver | `1.4.2` | Never after release | Changelogs, support, customers of an internal library |
| Floating minor | `1.4` | Each patch release | Humans browsing the registry; never deployments |
| Digest | `@sha256:9f3c...` | Never | Signed, verified production references |
| `latest` | | Every push | Nothing; do not push it from CI at all |

CI produces `sha-*` on every main-branch build and adds `x.y.z` and `x.y` on a tagged release. The Kubernetes manifest (or Helm value) is updated with the `sha-*` tag or the digest by the pipeline. A rollback is a change of that one string back to the previous SHA.

### 44.13.8 Size before and after

Measured on the orders API (52 runtime dependencies including `typeorm`, `pg`, `ioredis`, `bullmq`, `kafkajs`, `@nestjs/swagger`, `@opentelemetry/sdk-node`):

| Stage of improvement | Image size | Build (warm cache, source change) | Pull on a fresh node | Trivy high/critical |
|---|---|---|---|---|
| Original: `node:20`, single stage, `COPY . .`, `npm install` | 1.38 GB | 6 min 40 s | 48 s | 61 |
| Layer order fixed, `.dockerignore`, `npm ci` | 1.31 GB | 58 s | 46 s | 61 |
| Multi-stage on `node:20-slim` | 296 MB | 62 s | 9 s | 7 |
| Multi-stage on `node:20-alpine` with `tini` and `tzdata` | 221 MB | 61 s | 6 s | 2 |
| Same, base digest bumped after the scan | 221 MB | 61 s | 6 s | 0 |

The 6-second pull is what makes autoscaling useful: a new replica is serving traffic 12 seconds after the scheduler places it, instead of a minute.

### 44.13.9 Verifying the contract

Before the image is allowed into production, run the checks a senior engineer runs by hand the first time and CI runs forever after:

```bash
# 1. Starts, becomes healthy, serves
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
until [ "$(docker inspect --format '{{.State.Health.Status}}' orders-api-1)" = "healthy" ]; do sleep 1; done
curl -fsS localhost:3000/health/ready

# 2. Stops cleanly under load
autocannon -c 20 -d 15 localhost:3000/orders &  sleep 5
time docker compose stop -t 30 api                 # should be ~3 s, exit code 0
docker inspect --format '{{.State.ExitCode}}' orders-api-1

# 3. Runs as non-root on a read-only filesystem with no capabilities
docker compose exec api sh -c 'id -u; touch /app/x 2>&1; touch /tmp/x && echo tmp-ok'

# 4. No secrets in the image
docker history --no-trunc registry.internal/orders-api:sha-3f9a1c2 | grep -i -E 'password|token|secret' || echo clean
trivy image --scanners secret registry.internal/orders-api:sha-3f9a1c2
```

Expected results: healthy within 20 seconds, stop in about 3 seconds with exit code 0 and zero failed requests during the drain, uid 1000, `touch /app/x` denied, `/tmp` writable, no secrets found.

#### How a Senior Backend Engineer thinks about this

They treat the Dockerfile, `.dockerignore`, Compose files and the `main.ts` bootstrap as one unit with one contract: bind `0.0.0.0`, read config from the environment, log to stdout, expose `/health/live` and `/health/ready`, exit cleanly on `SIGTERM`, run as uid 1000 on a read-only filesystem, fit in 512 MB. Every service in the company follows the same contract, which is what allows a platform team to operate 60 services with a single deployment template. When a new service is created, the contract is copied, not reinvented.

#### Interview questions

1. *Walk me through a production Dockerfile for a NestJS API and justify each stage and flag.* Expected: the four stages, digest pins, `tini`, `USER node`, `NODE_OPTIONS`, labels last, exec-form `CMD`.
2. *How do you run database migrations in a containerised deployment locally and in production?* Expected: one-shot container using the same image and command; Compose `service_completed_successfully`; Kubernetes Job; never at API startup.
3. *What is your image tagging strategy and how does rollback work?* Expected: immutable `sha-*`, semver on releases, deploy by SHA or digest, rollback by changing one reference.
4. *What would you check before trusting an image in production?* Expected: non-root, clean stop under load, read-only filesystem works, no secrets in layers, scanner pass, size and pull time.

#### Practical exercise

Containerise one of your own NestJS services using the Dockerfile, `.dockerignore`, development Compose and production override from this section. Fill in the size-before-and-after table with your own numbers. Acceptance criteria: the production image is under 260 MB on Alpine, runs as uid 1000 with `read_only: true`, stops within 5 seconds under load with zero failed requests, the migration runner gates the API start, and `docker history` contains no secrets.
