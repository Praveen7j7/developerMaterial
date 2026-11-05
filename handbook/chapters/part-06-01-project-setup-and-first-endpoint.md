# Part 6 — Your First Backend

This is the Part where everything in Volume 0 comes together. You know TypeScript (Part 1), asynchronous code (Part 2), how the web works (Part 3), the command line (Part 4), and Git (Part 5). Now you build a real backend: a small NestJS API that stores products in PostgreSQL, with a controller, a service, a DTO with validation, and a repository that talks to the database. By the end you will have an API you can run, call with `curl`, and extend.

We build a **products API** for an e-commerce store — list products, get one, create one — because it is the simplest thing that still exercises every layer: an HTTP endpoint, input validation, business logic, and database persistence. The code here is deliberately production-shaped, not a toy: real validation, real error handling, real SQL. It is small enough to hold in your head and real enough that the habits transfer directly to the systems the rest of the book describes.

This Part is a guided build. Later Parts go deep on each piece: NestJS dependency injection in Part 12 (12.7), API design in Part 14, PostgreSQL in Parts 16–20, TypeORM and Sequelize in Part 21, security in Part 39, testing in Part 40. Sections 6.5 to 6.9 then grow the project step by step: better validation, consistent errors, tests, and running everything with Docker. Here we assemble a working whole so those deep dives have something concrete to attach to.

## 6.1 Project setup

### 6.1.1 What NestJS is and creating the project

#### Concept

NestJS is a framework for building backend applications in Node.js and TypeScript. A framework gives you structure and ready-made pieces (routing, validation, dependency injection, database integration) so you do not reinvent them. NestJS organizes an application into **modules**, **controllers** (which handle HTTP requests) and **services** (which hold business logic), with a system that wires them together for you called dependency injection.

#### Why does it exist?

You could build an HTTP server with raw Node, but you would hand-write routing, request parsing, validation, error handling, and the plumbing to connect everything — and every project would do it differently. NestJS provides a consistent, well-trodden structure so a team can build and a new engineer can navigate any NestJS codebase. It is opinionated in a way that pays off: the conventions mean less bikeshedding and more shared understanding. Part 12 covers its architecture and dependency injection in depth; here we use it.

#### Mental model

Think of NestJS as a pre-built office building with the plumbing, wiring and room layout already in place. You do not lay pipes or run cables; you move into rooms designed for specific purposes — the controller is the reception desk that receives visitors (requests), the service is the back office that does the actual work, the repository is the records department that talks to the filing system (the database). The building (the framework) handles how they connect; you furnish each room with your logic.

#### How it works — creating the project

NestJS has a command-line tool that scaffolds a project. Using Node 22 and NestJS 10:

```bash
npm i -g @nestjs/cli          # install the Nest CLI globally
nest new products-api          # scaffold a new project (choose npm when prompted)
cd products-api
npm run start:dev              # run in watch mode: restarts on file changes
# the API is now running on http://localhost:3000
```

The generated project structure (the parts that matter):

```text
products-api/
├── src/
│   ├── main.ts                 # the entry point: creates and starts the app
│   ├── app.module.ts           # the root module: wires everything together
│   ├── app.controller.ts       # a sample controller (we will replace it)
│   └── app.service.ts          # a sample service
├── test/                       # end-to-end tests
├── package.json                # dependencies and scripts
├── tsconfig.json               # TypeScript configuration
└── .env                        # our config (we add this; it is gitignored)
```

The entry point, `main.ts`, is where the application starts. The generated version is minimal; we will enhance it shortly with validation and configuration.

```ts
// src/main.ts (generated)
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
```

`NestFactory.create(AppModule)` builds the whole application from the root module, wiring together every controller and service. `app.listen(3000)` starts the HTTP server on port 3000. The `async`/`await` here is exactly what you learned in Part 2 — starting a server is asynchronous.

#### The three building blocks

```text
Controller   receives HTTP requests, returns responses. Thin: no business logic.
Service      holds business logic. Called by controllers. Knows nothing about HTTP.
Module       groups related controllers and services and declares their wiring.
```

This separation is the single most important convention in NestJS and in good backend design generally (Part 11, Part 12). The controller's job is to translate between HTTP and your logic — parse the request, call a service, shape the response. The service's job is the actual work, with no knowledge of HTTP. Keeping them separate means your logic is testable without a web server and your HTTP handling is thin and uniform.

#### Practical example — the generated hello endpoint

The scaffold comes with a working endpoint you can call right now:

```ts
// src/app.controller.ts (generated)
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()                             // this class handles requests
export class AppController {
  constructor(private readonly appService: AppService) {}  // service injected

  @Get()                                  // handles GET /
  getHello(): string {
    return this.appService.getHello();    // delegates to the service
  }
}
```

```bash
curl http://localhost:3000
# Hello World!
```

Notice the pattern already: the `@Get()` decorator maps a method to an HTTP route, the controller delegates to an injected service, and the service (not the controller) does the work. Every endpoint you build follows this shape.

#### Decorators

Those `@Controller()`, `@Get()` annotations are **decorators** — special markers starting with `@` that attach metadata to classes and methods. NestJS reads them to know "this class handles requests" and "this method handles `GET /`". You do not need to understand how decorators work internally yet; treat them as labels that tell NestJS what each piece is for. We will use `@Controller`, `@Get`, `@Post`, `@Body`, `@Param`, `@Injectable` and a few others.

#### How a Senior Backend Engineer thinks about this

A senior values the controller/service separation from the first file, keeping controllers thin (translate HTTP, delegate, shape the response) and putting all real logic in services that know nothing about HTTP. This is not ceremony; it is what makes the logic testable in isolation and keeps the HTTP layer uniform and swappable. They let the framework's conventions do their job rather than fighting them, because a codebase that follows NestJS conventions is one any NestJS engineer can read. They run in watch mode (`start:dev`) during development for the fast feedback loop.

#### Common mistakes

- Putting business logic in the controller, making it untestable without a web server and tangling HTTP concerns with domain logic.
- Fighting the framework's conventions and inventing a bespoke structure nobody else can follow.
- Not separating configuration from code (we fix this with `@nestjs/config` next).

#### Interview questions

1. **What are the roles of a controller and a service in NestJS?** The controller handles HTTP (routing, parsing requests, shaping responses) and stays thin; the service holds business logic and knows nothing about HTTP.
2. **Why keep controllers thin?** So business logic is testable without a web server and the HTTP layer stays uniform; it separates concerns cleanly.
3. **What is a module in NestJS?** A unit that groups related controllers and services and declares how they are wired together.

#### Practical exercise

Scaffold a new NestJS project, run it in watch mode, and call the default endpoint with `curl`. Then add a second `@Get('health')` endpoint that returns `{ status: 'ok' }`, delegating to a service method. Acceptance criteria: `curl http://localhost:3000/health` returns the JSON, and the logic lives in a service, not the controller.

### 6.1.2 Configuration and starting PostgreSQL

#### Concept

Before touching the database, we set up two things properly: configuration from environment variables (Part 4) and a running PostgreSQL instance. We use `@nestjs/config` to load a `.env` file and Docker to run PostgreSQL without installing it on your machine.

#### How it works — configuration

```bash
npm install @nestjs/config
```

```ts
// src/app.module.ts -- register config so process.env and ConfigService work
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,          // available everywhere without re-importing
    }),
  ],
})
export class AppModule {}
```

```text
# .env  -- gitignored (Part 4); holds our config
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=shop
DATABASE_PASSWORD=shop_dev_password
DATABASE_NAME=shop
PORT=3000
```

#### How it works — running PostgreSQL with Docker

Docker runs PostgreSQL in a container so you do not install it directly (Part 43 covers containers properly). One command starts a PostgreSQL 17 database matching the `.env` above:

```bash
docker run --name shop-db \
  -e POSTGRES_USER=shop \
  -e POSTGRES_PASSWORD=shop_dev_password \
  -e POSTGRES_DB=shop \
  -p 5432:5432 \
  -d postgres:17
```

```bash
# verify it is running and connect to it:
docker ps                                    # shows the running container
docker exec -it shop-db psql -U shop -d shop # open a SQL prompt inside it
# at the psql prompt: \dt lists tables, \q quits
```

`psql` is PostgreSQL's command-line client — a shell for running SQL (Part 17 — SQL Mastery). You will use it constantly to inspect data and test queries.

#### Fail fast on missing config

Validate required configuration at startup, as Part 4 urged, so a missing value is caught immediately with a clear message rather than deep in a request later.

```ts
// A small check you can run in main.ts before listen():
const required = ['DATABASE_HOST', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}
```

#### How a Senior Backend Engineer thinks about this

A senior sets up configuration and a reproducible local database before writing feature code, because getting these foundations right prevents a category of "works on my machine" problems. They run the same PostgreSQL major version locally as in production (17 here) so they never hit a version-specific surprise at deploy time. They validate required config at startup. They keep `.env` gitignored and provide a `.env.example` so a new teammate can get running in minutes. These are small investments that pay off every day of the project's life.

#### Common mistakes

- Hardcoding the database connection in code instead of reading it from config.
- Running a different PostgreSQL version locally than in production, hitting version-specific bugs late.
- Not validating config at startup, getting confusing runtime failures.
- Committing `.env` with the database password.

#### Interview questions

1. **Why run the same database major version locally as in production?** To avoid version-specific behavior differences that would only surface at deploy time.
2. **Why validate configuration at startup?** A missing value caught at boot is a trivial, clear failure; the same value missing at runtime is a confusing production incident.
3. **What is `psql`?** PostgreSQL's command-line client for running SQL and inspecting the database.

#### Practical exercise

Install `@nestjs/config`, create a `.env` with the database settings, start PostgreSQL 17 in Docker, and connect to it with `psql` to confirm it works. Add a startup check that throws if `DATABASE_PASSWORD` is missing. Acceptance criteria: the app reads config from `.env`, you can open a `psql` prompt against the containerized database, and removing `DATABASE_PASSWORD` makes the app fail fast at startup.
