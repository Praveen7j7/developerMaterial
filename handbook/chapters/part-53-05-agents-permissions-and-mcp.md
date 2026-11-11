## 53.6 Agents and tools

### 53.6.1 Agentic coding in a terminal, and how much power to give it

#### Concept

An **agentic coding tool** runs the loop from 53.1.1 on your machine or in a cloud environment: it reads and searches files, edits them, and runs shell commands such as tests, linters, `git` and package managers. Each of those abilities is a **permission**. The central engineering decision is not which model to use; it is **what the agent may do without asking, what it may do only after asking, and what it may never do.**

#### Why does it exist?

Agents are useful precisely because they can act: run the test, read the failure, fix the code, run it again. But a tool that can run `npm test` can also run `npm install`, `curl`, `psql`, `git push --force` or `rm -rf`. It does so for plausible reasons ("let me check the database schema", "let me clean the build directory"), with the same credentials, network and file access as the user who started it. Permissions exist so that the agent's power matches the task, not the user's full account.

#### Mental model

Imagine giving a contractor access to your house. You can give them a key to the garage only, a key to the whole house, or a key plus your bank card. Most jobs need the garage key. Some need the house key while you are home. Almost none need the bank card. The trouble is that a terminal session, by default, is the bank card: your SSH keys, your cloud credentials, your production database URL in an environment variable.

#### How it works

Think of agent permissions as layers, from least to most dangerous:

| Level | The agent can | Typical use | Risk |
|---|---|---|---|
| 0. Read-only | Read and search files in the project | Explain code, plan a change, review a diff | Leaks what it reads into context (secrets in files) |
| 1. Edit | Change files in the working tree | Implement a planned step | Bad edits; easily undone with Git |
| 2. Run allowlisted commands | Run specific commands: tests, lint, typecheck, `git diff` | The edit-run-fix loop | Commands with side effects hidden inside (a test that hits a real API) |
| 3. Run arbitrary commands | Any shell command | Exploratory work in a sandbox | Installs, network calls, deletes, anything the user can do |
| 4. External access | Network, cloud CLIs, databases, pushing to remotes | Rarely justified for coding tasks | Data exfiltration, production changes |

```mermaid
flowchart LR
    ro["Read-only: default for planning and review"] --> ed["Edit files"]
    ed --> al["Allowlisted commands: default for implementation"]
    al --> any["Any command: only inside a sandbox"]
    any --> ext["Network, cloud, prod: almost never"]
```

Most agentic tools let you configure this with allow and deny rules plus "ask me first" for anything not listed. As one concrete example, Claude Code reads project settings from `.claude/settings.json`; at the time of writing the format looks like this, and other tools have equivalents:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run typecheck)",
      "Bash(npm test:*)",
      "Bash(git diff:*)",
      "Bash(git status)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Bash(curl:*)",
      "Bash(git push:*)",
      "Bash(npm publish:*)"
    ]
  }
}
```

Two cautions about rules like these:

1. **Command rules are guardrails, not a sandbox.** A deny rule on `curl` does not stop `node -e "fetch(...)"`, `wget`, or a test file that makes an HTTP call. Pattern-matching on command strings is easy to route around, by an attacker or by a model trying to be helpful. The real boundary is the environment the agent runs in (53.6.2).
2. **"Auto-approve everything" turns a level-2 agent into a level-3 or level-4 agent.** Many tools offer a mode that skips permission prompts. It is reasonable inside a disposable container with no secrets and restricted network. It is not reasonable in your normal terminal with production credentials loaded.

#### Practical example

A sensible default for a NestJS service:

- **Planning and review sessions:** read-only. The agent may read code and propose a plan or review a diff.
- **Implementation sessions:** edit plus an allowlist of `npm run lint`, `npm run typecheck`, `npm test`, `git diff`, `git status`. Everything else prompts.
- **Exploratory or long autonomous sessions:** any command, but only inside a container or cloud sandbox with no production credentials, and network limited to the package registry.
- **Never:** pushing to protected branches, publishing packages, touching production databases or cloud accounts. Those go through CI/CD (Part 47 — CI/CD and Deployment Strategies) with human approval.

#### Production scenario

A forty-engineer organisation standardises on a checked-in settings file per repository with a shared allowlist, plus a team rule that "skip permissions" mode is only used inside the team's devcontainer image. Engineers report that the allowlist removes most of the annoying prompts (tests, lint) while the remaining prompts are rare enough that people actually read them. That last property is the goal: a prompt that appears forty times an hour gets approved without reading, which is the same as no prompt.

#### Failure scenario

An engineer runs an agent in auto-approve mode in a terminal where they had earlier exported a production `DATABASE_URL` to investigate a support ticket. They ask the agent to "fix the failing migration test". The agent, trying to understand the schema, runs the project's migration command, which reads `DATABASE_URL` and applies two pending migrations to production at 15:20, outside the deploy process and without the expand/contract sequencing they were designed for. One of them renames a column that the running application still uses. Orders fail for eleven minutes until the change is reversed by hand. The agent did nothing malicious. It had the bank card.

#### Edge cases & failure modes

- **Approval fatigue.** Too many prompts and people approve without reading. Allowlist the safe, frequent commands so the rare prompts get attention.
- **Inherited credentials.** Environment variables, cloud CLI profiles, SSH agents and Git credential helpers are all available to commands the agent runs.
- **Commands with hidden side effects.** `npm test` that includes an integration test hitting a shared staging API; `npm install` that runs install scripts.
- **Long autonomy.** The longer an agent runs without a checkpoint, the further a wrong early assumption propagates.

#### How a Senior Backend Engineer thinks about this

A senior applies least privilege to agents exactly as they would to a service account (Part 40, 40.10): give the minimum for the task, scope it to an environment with nothing valuable in it, and log what happens. They are relaxed about agents editing files, because Git makes edits cheap to undo, and strict about anything with effects outside the working tree: network, installs, databases, pushes. Their question is never "is the model trustworthy?" but "what is the worst thing this session can do if the model is wrong or manipulated?"

#### Common mistakes

- Running agents in the same terminal where production credentials are loaded.
- Using auto-approve outside a sandbox because prompts are annoying.
- Relying on deny rules as if they were a security boundary.
- Letting an agent push or merge.

#### Interview questions

1. **How do you set permissions for a coding agent?** Least privilege by task: read-only for planning and review, edit plus allowlisted verification commands for implementation, broad command access only inside a sandbox without secrets, and never production access. Follow-up: why are command deny rules not enough?
2. **What is the risk of auto-approve mode?** Every command the model decides to run executes with your credentials and network; acceptable only in a disposable environment with nothing valuable in it.
3. **An agent needs to look at the database schema. How do you give it that safely?** Give it the migration files or a schema dump, or a read-only role on a local or anonymised database; never production credentials.

#### Practical exercise

Write a permission configuration for an agent in one of your repositories. Acceptance criteria: an allowlist of verification commands checked against `package.json`; deny rules for secret files and network tools; a short note on three ways the deny rules could be bypassed and which environment control (53.6.2) closes each.

### 53.6.2 Sandboxes, worktrees and containers

#### Concept

Because permission rules can be bypassed, the strongest control is **where the agent runs**. Three common isolation tools, from lightest to strongest:

1. **Git worktree:** a second working directory for the same repository on its own branch, so the agent's edits never touch your main checkout.
2. **Container (or devcontainer):** the agent and its commands run inside a container with only the project mounted, no host credentials, and restricted or no network.
3. **Remote sandbox or VM:** an ephemeral cloud environment created for the task and destroyed afterwards; the agent opens a pull request as its only output.

#### Why does it exist?

Isolation turns "what could this agent do?" from "anything I can do" into "anything inside this box", and makes the box disposable. It also lets several agents work in parallel without colliding.

#### How it works

```bash
# 1. A worktree per agent task: separate directory, separate branch, same repository.
git worktree add ../orders-refunds-agent -b agent/partial-refunds
cd ../orders-refunds-agent && npm ci --ignore-scripts
# ... run the agent here; review with `git diff main...agent/partial-refunds`
git worktree remove ../orders-refunds-agent   # clean up when merged or abandoned

# 2. A container with no network: tests that need a DB run against a local container network only.
docker network create --internal agent-net
docker run -d --name agent-pg --network agent-net -e POSTGRES_PASSWORD=localdev postgres:16
docker run --rm -it --network agent-net \
  -v "$PWD":/work -w /work \
  -e DATABASE_URL=postgres://postgres:localdev@agent-pg:5432/postgres \
  node:22 bash
# Inside: no host SSH keys, no cloud profiles, no route to the internet or production.
```

| Isolation | Protects against | Does not protect against | Cost |
|---|---|---|---|
| Worktree | Messing up your main checkout; parallel agents colliding | Network, credentials, side-effecting commands | Seconds; disk for a second checkout and `node_modules` |
| Container, restricted network | Credential theft, exfiltration, host damage | Bad code reaching the PR; secrets you mount in | Image maintenance; slower first start |
| Remote sandbox | All of the above, plus local machine exposure | Bad code reaching the PR | Vendor or platform cost; setup |

#### Edge cases & failure modes

- **Mounting the secrets in anyway.** A container that mounts `~/.aws` or the real `.env` is not a sandbox.
- **Allowing all network "for npm".** Allow the registry (or your internal mirror) only, not the whole internet.
- **Forgotten worktrees and containers.** Each worktree has its own `node_modules`; ten forgotten ones eat disk. Clean up as part of finishing the task.

#### How a Senior Backend Engineer thinks about this

The senior matches isolation to autonomy: a short, supervised session with an allowlist can run in a worktree; a long, auto-approved session belongs in a container or a remote sandbox whose only output is a pull request. They make the safe setup the easy one, for example a devcontainer definition in the repository, so engineers do not have to choose between safety and convenience.

#### Interview questions

1. **Why run an agent in a worktree?** Its edits live on a separate branch and directory, so your own checkout is untouched and several agents can work in parallel.
2. **What makes a container a real sandbox for an agent?** No host credentials mounted, network restricted to what the task needs, and disposable; otherwise it is just a different directory.

#### Practical exercise

Build a devcontainer or Docker setup for one repository in which an agent can run the full test suite (including a PostgreSQL container) with no access to the internet except the package registry and no host credentials. Acceptance criteria: the suite passes inside it; `curl https://example.com` fails inside it; `ls ~/.ssh ~/.aws` shows nothing inside it.

### 53.6.3 The Model Context Protocol (MCP)

#### Concept

The **Model Context Protocol (MCP)** is an open standard, introduced by Anthropic in late 2024 and since adopted by many AI tools, for connecting AI applications to external tools and data. Instead of every assistant building a custom integration for every system (the issue tracker, the database, the docs, the monitoring tool), a system exposes an **MCP server** once, and any MCP-capable application can connect to it as a **client**.

#### Why does it exist?

Before a standard, connecting M assistants to N systems needed M times N integrations, each with its own authentication and quirks. MCP turns that into M plus N: each tool speaks the protocol once. For an engineer, that means you can give your coding agent access to, say, your issue tracker, an internal docs search and a read-only view of a database with a few lines of configuration. That convenience is also the risk: each server is new power and new untrusted input.

#### Mental model

Imagine USB for AI tools. Before USB, every printer had its own cable and driver. With a standard plug, any device works with any computer. And just as with USB, plugging in a device you found in a car park is a security decision, not a convenience.

#### How it works

```mermaid
flowchart LR
    subgraph Host
        app["AI application: IDE, CLI agent, chat app"]
        c1["MCP client 1"]
        c2["MCP client 2"]
        app --> c1
        app --> c2
    end
    c1 -->|"stdio, local process"| s1["MCP server: orders read-only"]
    c2 -->|"HTTP, remote"| s2["MCP server: issue tracker"]
    s1 --> db["Postgres replica, read-only role"]
    s2 --> api["Tracker API, scoped token"]
```

The durable concepts:

1. **Host, client, server.** The *host* is the AI application. It runs one *client* per connected *server*. The server is a program that exposes capabilities.
2. **What servers expose.** Mainly three kinds of thing: **tools** (functions the model can call, such as `search_issues` or `get_order_status`), **resources** (data the application can read into context, such as a file or a record), and **prompts** (reusable templates).
3. **Wire format.** Messages are JSON-RPC 2.0. Local servers usually run as a subprocess talking over standard input and output (stdio); remote servers are reached over HTTP, with OAuth-based authorization defined for that case.
4. **Discovery.** On connect, the client asks the server what tools it offers, with names, descriptions and input schemas. Those descriptions go into the model's context so it knows when to call them.

#### Practical example: a least-privilege MCP server

A support team wants their coding agent to answer "what happened to order X?" while debugging. Rather than give it a database URL, they write a tiny MCP server with one narrow tool, backed by a read-only role on a replica:

```ts
// orders-mcp/server.ts -- one narrow, read-only tool; no free-form SQL
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.ORDERS_RO_URL, max: 2 }); // read-only role, replica

const server = new McpServer({ name: 'orders-readonly', version: '1.0.0' });

server.registerTool(
  'get_order_status',
  {
    title: 'Get order status',
    description: 'Status timeline for one order by id. Returns no customer personal data.',
    inputSchema: { orderId: z.string().uuid() },
  },
  async ({ orderId }) => {
    const { rows } = await pool.query(
      'SELECT status, changed_at, actor_type FROM order_status_history_support WHERE order_id = $1 ORDER BY changed_at',
      [orderId], // parameterised; the model never writes SQL
    );
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  },
);

await server.connect(new StdioServerTransport());
```

#### PostgreSQL example

The server's database role enforces the boundary even if the server code is wrong:

```sql
CREATE ROLE mcp_orders_ro LOGIN;                         -- password set from the secrets manager, not here
ALTER ROLE mcp_orders_ro SET default_transaction_read_only = on;
ALTER ROLE mcp_orders_ro SET statement_timeout = '3s';
ALTER ROLE mcp_orders_ro CONNECTION LIMIT 5;

-- A view that exposes only what support debugging needs: no names, emails, addresses.
CREATE VIEW order_status_history_support AS
  SELECT order_id, status, changed_at, actor_type FROM order_status_history;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_orders_ro;
GRANT USAGE ON SCHEMA public TO mcp_orders_ro;
GRANT SELECT ON order_status_history_support TO mcp_orders_ro;
```

The grants are the real boundary. `default_transaction_read_only` is a helpful second layer, but any session can switch it off with `SET`, so never rely on it alone. On PostgreSQL 14 and older, every role (`PUBLIC`) may also create tables in the `public` schema by default; there, add `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` (PostgreSQL 15 and later already ship this way).

#### The security model

MCP standardises the *connection*; it does not make any server safe. The questions to ask about every server:

| Question | Why |
|---|---|
| Who wrote it, and is the version pinned? | A local server runs as a process with your user's permissions; an update can change its behaviour |
| What credentials does it hold, and how broad are they? | The model can call any tool the server exposes, with the server's credentials |
| Does it read untrusted content (web pages, issues, emails, tickets)? | That content goes into the model's context and can carry injected instructions (53.6.4) |
| Can its tools write, send or delete? | Write tools need confirmation; prefer read-only |
| Are tool descriptions trustworthy? | Descriptions are text in the model's context; a malicious server can hide instructions in them |
| Is there an audit log of tool calls? | You will need it after an incident |

#### How a Senior Backend Engineer thinks about this

A senior treats an MCP server like any integration with a third-party service: vet it, pin it, give it its own narrowly scoped credentials, prefer read-only, and assume its output is untrusted. They favour narrow, purpose-built tools ("get order status") over general ones ("run SQL"), because the narrower the tool, the smaller the blast radius when the model is wrong or manipulated. Part 38 (38.3.1 and 38.7) applies the same principles to agents you ship to customers; the reasoning carries over unchanged.

#### Common mistakes

- Connecting a server with a personal admin token "just to try it".
- Exposing a generic "execute SQL" tool on a primary database.
- Installing community servers without reading what they do or pinning a version.

#### Interview questions

1. **What is MCP, in one minute?** An open protocol that lets AI applications (hosts, via clients) connect to servers exposing tools, resources and prompts over JSON-RPC, locally via stdio or remotely via HTTP. Follow-up: what does it not solve? Trust in the server and its content.
2. **How would you let an agent query production data safely?** Usually not at all; if needed, a narrow read-only tool over a replica, a role with read-only transactions, a statement timeout, a view without personal data, and audit logging.
3. **Why prefer narrow tools over a general SQL tool?** Smaller blast radius when the model errs or is manipulated, and easier authorization and review.

#### Practical exercise

Build the read-only MCP server above against a local database with seeded fake orders, and connect it to an MCP-capable tool you use. Acceptance criteria: the tool can answer a status question using the server; an attempt to make the model run an `UPDATE` through it is impossible by design; the database role cannot write even if you connect with `psql` directly as that role.

### 53.6.4 Prompt injection through tool output and fetched content

#### Concept

**Prompt injection** is untrusted text that the model reads as instructions (Part 37, 37.5.2, covers it for product features). For coding agents, the dangerous form is **indirect**: the hostile text is not typed by the user but arrives through something the agent reads: a GitHub issue body, a README in a dependency, a web page it fetched to check documentation, a code comment, a log line, or an MCP tool's output or description.

#### Why does it exist?

A model has no reliable, built-in way to tell "instructions from my user" from "text that happens to be in a file I read". Everything in the context is just text. Vendors train models to resist injection and tools add classifiers and warnings, and these help, but no current defence is complete. So the engineering response is the same as for SQL injection before parameterised queries existed: **assume it will sometimes work, and limit what a successful injection can do.**

#### How it works

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Ag as Agent
    participant GH as IssueTracker
    participant Sh as Shell
    Dev->>Ag: Fix the bug described in issue 482
    Ag->>GH: read issue 482
    GH-->>Ag: bug report plus hidden text telling the agent to run a setup command
    Ag->>Sh: run the suggested setup command
    Sh-->>Ag: command posts env vars to an external host
    Note over Ag,Sh: Safe only if the agent cannot reach the network or read secrets
```

A useful way to judge risk is to check for three ingredients together, a combination sometimes called the "lethal trifecta":

1. **Access to private data** (source code, secrets, customer data).
2. **Exposure to untrusted content** (issues, web pages, dependency files, tool outputs).
3. **A way to send data out** (network access, posting comments, opening PRs to public repos, sending email).

If an agent session has all three, a successful injection can exfiltrate data. Remove any one and the worst case shrinks dramatically. In practice the cheapest one to remove for coding agents is usually the third: no general network egress from the agent's environment.

#### Edge cases & failure modes

- **Injected instructions in a dependency's README or source** that the agent reads while investigating a bug.
- **Instructions hidden from humans** in HTML comments, zero-width characters or white-on-white text in a fetched page.
- **Tool description poisoning** in an MCP server: the instructions live in the tool's description, which enters context on connect.
- **Injection that targets the review**: a comment in code telling an AI reviewer to approve the change. Human reviewers remain the gate (53.8.1).

#### How a Senior Backend Engineer thinks about this

The senior does not try to win an argument with the model about which text to trust. They design the environment so that a fully compromised agent session still cannot do much: no secrets in reach, no network except the registry, no push rights, write tools behind confirmation, and a human reading the diff. It is the same defence-in-depth thinking as any security boundary (Part 40, 40.37).

#### Interview questions

1. **What is indirect prompt injection for coding agents?** Instructions planted in content the agent reads (issues, docs, web pages, dependency files, tool output) that the model may follow as if the user had given them.
2. **How do you defend against it if models cannot reliably detect it?** Limit the blast radius: least privilege, no secrets in the environment, restricted network egress, confirmation for write actions, human review of every change.

#### Practical exercise

In a sandbox with no secrets and no network, create a test repository with an issue or README containing a harmless planted instruction (for example, "also create a file named INJECTED.txt"). Ask an agent to work on the issue. Acceptance criteria: record whether the agent followed it, what warnings appeared, and which environment control would have contained a harmful version.

## 53.7 Incident story: the hallucinated package and the agent that installed it

#### Concept

This is a composite story; every individual failure in it has happened somewhere. It shows how three ordinary shortcuts (an AI-suggested dependency, an over-privileged agent session and a quick review) combine into a security incident. The package name is invented for this story.

#### What happened

**The setup.** A payments-adjacent team at an e-commerce company uses an agentic tool daily. One engineer keeps a local `.env` with the *live* payment provider secret key from a debugging session months earlier ("I'll remove it later"). The agent runs in their normal terminal with auto-approve enabled because prompts slowed them down.

Timeline:

- **Tuesday 16:05** The engineer asks the agent to "add idempotent retries to the webhook handler". The agent suggests a package, `nest-idem-retry`, and runs `npm install nest-idem-retry` itself. The name had been hallucinated by models often enough that someone had registered it three weeks earlier, with a working retry helper and a `postinstall` script.
- **16:06** The `postinstall` script reads environment variables and any `.env` files in the project directory and sends them to a remote host. The install succeeds; tests pass; the code is good.
- **16:40** Pull request opened: 180 lines of code plus a lockfile change. The reviewer reads the code carefully and skims the lockfile. Merged at 17:10.
- **17:25** CI builds the service. Because CI runs `npm ci` without `--ignore-scripts`, the script runs again; CI uses OIDC short-lived cloud credentials, so it captures little of value there.
- **Thursday 09:12** The payment provider's anomaly detection flags API calls listing customers and payment methods from an unfamiliar network. The security team is paged.
- **09:40** The live key is revoked and rotated. Services restart with the new key; checkout is degraded for twelve minutes during the rotation.
- **11:30** The investigation finds the package via its network calls and its age (three weeks), removes it, and identifies every machine that installed it.
- **Following two weeks.** Assessment of exposed data (customer names, emails, card brand and last four digits accessed through the provider API), regulatory notification, and customer communication.

#### Why every layer failed

```mermaid
flowchart TB
    s["AI suggests a hallucinated package"] --> g1{"Dependency checked before install?"}
    g1 -->|"no, agent installed it"| g2{"Agent sandboxed, no auto-approve?"}
    g2 -->|"no, normal terminal"| g3{"Install scripts blocked?"}
    g3 -->|"no"| g4{"Live secrets kept out of laptops?"}
    g4 -->|"no, .env had live key"| g5{"Review covered the new dependency?"}
    g5 -->|"lockfile skimmed"| leak["Live key exfiltrated and used"]
```

| Guardrail | Would it have prevented the install? | Would it have prevented the leak? |
|---|---|---|
| Policy: new dependencies need a check (existence, age, maintainers) before install (53.3.5) | Yes | Yes |
| Agent permissions: `npm install` requires approval, or runs only in a sandbox | Likely | Yes |
| `npm install --ignore-scripts` by default; allowlist for packages that need scripts (Part 40, 40.28) | No | Yes |
| Agent environment has no network except an internal registry mirror that quarantines new packages | Yes (package not mirrored) | Yes |
| No live secrets on laptops; test keys locally, secrets manager at runtime (Part 40, 40.32) | No | Yes (nothing valuable to steal) |
| CI dependency review that flags new packages younger than 30 days | No (already installed locally) | Partly (CI exposure) |
| Review checklist item: every new dependency justified in the PR description | No | Possibly (caught before merge) |

As with the database story in Part 52 — Infrastructure as Code, 52.15, any one of several independent guardrails would have stopped this. The team had none of them working that afternoon. Note what was *not* the cause: the code the agent wrote was fine. The failure was entirely in permissions, dependencies and secrets hygiene.

#### Postmortem actions

1. Agents run in the team devcontainer with network limited to the internal registry mirror; auto-approve is allowed only there.
2. The registry mirror holds back packages published in the last 14 days and blocks packages not on an allowlist without a ticket.
3. `ignore-scripts=true` in every repository's `.npmrc`, with a documented allowlist for packages that need native builds.
4. Live secrets removed from all developer machines; local development uses provider test keys only. Secret scanning on developer machines added.
5. The pull request template requires a "new dependencies" section; a CI job comments on any lockfile change that adds a package, with its age, maintainers and licence.
6. The instruction file for every repository gains: "Never install a dependency; propose it in the summary instead."

#### How a Senior Backend Engineer thinks about this

The senior's reading is the same as for any supply-chain incident: the attacker did not break anything, they waited for a predictable mistake. AI made the mistake more predictable (the same invented name, suggested to many people) and faster (the agent installed it without a human typing the command). The remedy is not to ban agents. It is to make sure that the agent's environment holds nothing worth stealing and that new code from the internet passes through a gate a human controls.

#### Interview questions

1. **Walk through how an AI-suggested dependency can lead to a data breach.** Hallucinated name, attacker registers it, agent or developer installs it, install script steals local secrets, attacker uses them. Follow-up: name three independent controls.
2. **The code in the PR was correct. Why was the review still a failure?** The risk was in the lockfile and the new dependency, not the code; review must cover dependencies explicitly.
3. **What single change gives the most protection here?** No valuable secrets in the agent's environment, combined with restricted network egress; then the worst case of any malicious package is small.

#### Practical exercise

Audit one repository and one developer machine against the guardrail table above. Acceptance criteria: a filled table with "present", "partial" or "missing" for each guardrail, evidence for each (config files, commands run), and a ranked list of the three fixes with the best risk reduction for the least effort.
