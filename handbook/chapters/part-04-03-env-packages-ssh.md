## 4.5 Environment variables

### 4.5.1 Configuring programs from the outside

#### Concept

An **environment variable** is a named value that the shell and every program it launches can read. They are the standard way to pass configuration into a program without changing its code — database URLs, API keys, which environment it is running in (`development`, `production`), the port to listen on. Your backend reads them at startup.

#### Why does it exist?

The same code runs on your laptop, in staging and in production, but it must connect to a different database and use different secrets in each. You cannot hardcode those values — that would mean a different build per environment, and secrets committed to source control. Environment variables solve this: the code reads `process.env.DATABASE_URL`, and each environment supplies a different value from the outside. This separation of configuration from code is a core principle of well-built applications (the "twelve-factor app", Part 43 — Docker for Backend Engineers, 43.9).

#### Mental model

Environment variables are like the settings on the outside of a machine, set by whoever installs it, that the machine reads when it turns on. The machine's internals (your code) do not change between a home and a factory; only the external dial settings differ. The program asks "what database should I use?" and reads the answer off the dial, rather than having the answer welded inside.

#### How it works

```bash
echo $HOME                      # read a variable (note the $)
echo $PATH                      # the list of directories searched for commands
printenv                        # list all environment variables
export DATABASE_URL="postgres://localhost/app"   # set one for this shell and its children
export NODE_ENV=production        # common one: tells the app which environment

# Set a variable for just one command (not persisted):
PORT=4000 node dist/main.js
```

`export` makes a variable available to programs the shell launches. Without `export`, the variable exists only in the shell itself, not in programs it starts. Variables set with `export` last only for the current shell session; when you close the terminal, they are gone. To persist them, you put them in a shell startup file (`~/.bashrc`, `~/.zshrc`) or, for an application, use a `.env` file loaded at startup.

The `PATH` variable deserves special mention: it is a colon-separated list of directories the shell searches to find a command. When you type `node`, the shell looks through each directory in `PATH` for a program called `node`. "command not found" usually means the program is not in any `PATH` directory.

#### .env files

Backend projects keep their configuration in a `.env` file during development. A library (`dotenv`, built into NestJS via `@nestjs/config`, Part 6) reads it into `process.env` at startup.

```text
# .env  -- NEVER commit this file; it holds secrets
DATABASE_URL=postgres://user:password@localhost:5432/shop
REDIS_URL=redis://localhost:6379
JWT_SECRET=a-long-random-secret
NODE_ENV=development
PORT=3000
```

The `.env` file must be in `.gitignore` so it is never committed — it contains secrets. A committed `.env.example` with placeholder values documents which variables are needed without leaking the real ones. In production, secrets usually come from a secret manager (AWS Secrets Manager, Part 88.11) rather than a file on disk.

#### Reading them in Node

```ts
// In your code, environment variables are on process.env (all strings or undefined).
const port = Number(process.env.PORT ?? 3000);     // convert; env values are strings
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error('DATABASE_URL is required');       // fail fast at startup
}
```

Two habits here: every `process.env` value is a string or `undefined` (so convert numbers with `Number(...)`), and you should **fail fast** at startup if a required variable is missing, rather than crashing later mid-request when something tries to use it.

#### Edge cases & failure modes

- **Committing a `.env` file** leaks every secret into source control history, where it stays forever even if deleted later; rotate the secrets immediately if this happens.
- **Env values are strings**, so `process.env.PORT > 3000` compares strings, not numbers; convert first.
- **Missing required variable** causes a confusing runtime crash deep in the app; validate at startup instead.
- **`export` scope**: a variable set in one shell is not seen by another shell or by a process manager; configuration for a service must be set where the service is launched.
- **Precedence confusion**: a variable set inline, in `.env`, in the shell, and in the deploy system can conflict; know which wins (usually the one set closest to launch).

#### How a Senior Backend Engineer thinks about this

A senior keeps all configuration in environment variables and never hardcodes a URL, port or secret, so the same artifact runs in every environment. They validate required variables at startup and fail fast with a clear message, because a missing config caught at boot is a trivial fix while the same config missing at runtime is a production incident. They keep `.env` out of source control religiously and treat an accidentally committed secret as a security incident requiring rotation, not just a deletion. In production they prefer a secret manager over files on disk.

#### Common mistakes

- Committing `.env` and leaking secrets into git history.
- Hardcoding environment-specific values (URLs, ports, keys) in code.
- Forgetting env values are strings and comparing or using them as numbers.
- Not validating required config at startup, leading to confusing late crashes.

#### Interview questions

1. **Why configure a backend with environment variables instead of hardcoding?** So the same build runs in every environment with different config and secrets, keeping secrets out of source control (twelve-factor principle).
2. **What type are `process.env` values, and what follows from that?** Always strings (or `undefined`); you must convert numbers and booleans, and handle missing values.
3. **What is `PATH` and what does "command not found" usually mean?** The list of directories the shell searches for commands; the command is not in any of those directories.
4. **What do you do if a `.env` file is accidentally committed?** Treat it as a breach: rotate every secret it contained, because git history preserves it even after deletion.

#### Practical exercise

Create a `.env` file with `PORT` and a fake `API_KEY`, add it to a `.gitignore`, write a small Node script that reads both, converts `PORT` to a number, and throws a clear error if `API_KEY` is missing. Run it once with the variable present and once with it removed. Acceptance criteria: the missing-variable case fails fast at startup with a readable message, and `.env` is ignored by git.

## 4.6 Package managers

### 4.6.1 Installing software and dependencies

#### Concept

A **package manager** installs, updates and removes software, handling the dependencies each piece needs. There are two levels: the **system package manager** (`apt` on Debian/Ubuntu, `yum`/`dnf` on Red Hat) installs software on the whole machine; the **language package manager** (`npm`/`pnpm`/`yarn` for Node.js) installs the libraries your project depends on. A backend developer uses both.

#### Why does it exist?

Software is built from other software. Your Node backend uses dozens of libraries, each of which uses more. Installing them by hand — finding each, downloading it, finding what it needs, repeating — would be impossible to manage. A package manager automates it: you declare what you want, and it figures out and installs the whole dependency tree, in compatible versions, reproducibly.

#### Mental model

A package manager is like an app store with automatic dependency handling. You ask for one app (a library), and it quietly installs the ten other things that app needs to run, in versions that work together, and keeps a receipt (a lock file) so the exact same set can be installed again on another machine. Without it, you would be hunting down and installing each dependency by hand and hoping the versions matched.

#### How it works — system packages

```bash
sudo apt update                 # refresh the list of available packages
sudo apt install nginx          # install a package
sudo apt upgrade                # upgrade installed packages
sudo apt remove nginx           # remove a package
apt list --installed            # what is installed
```

(On Red Hat-family systems the same ideas use `dnf install`, `dnf update`, etc.)

#### How it works — Node packages

Node projects use `npm` (or `pnpm`/`yarn`). The project's dependencies are declared in `package.json`, and the exact installed versions are locked in `package-lock.json` (or `pnpm-lock.yaml`).

```bash
npm install                     # install everything in package.json (uses the lock file)
npm install express             # add a new dependency
npm install --save-dev jest     # add a development-only dependency (tests, build tools)
npm uninstall express           # remove a dependency
npm run build                   # run the "build" script defined in package.json
npm run start                   # run the "start" script
npm ci                          # clean install exactly from the lock file (used in CI)
```

Two directories and two files matter:

- `package.json` declares dependencies with version ranges (`"express": "^4.18.0"`).
- `package-lock.json` records the exact versions actually installed, so everyone gets the same ones.
- `node_modules/` is where the installed packages live; it is huge and never committed (it is in `.gitignore`).
- `npm ci` installs exactly what the lock file says, which is what you use in automated builds for reproducibility; `npm install` may update the lock file.

#### Semantic versioning

Versions follow `MAJOR.MINOR.PATCH` (for example `4.18.2`). A `MAJOR` bump may break compatibility; `MINOR` adds features compatibly; `PATCH` fixes bugs compatibly. The `^` in `^4.18.0` means "any `4.x.y` at or above this", allowing compatible updates but not a breaking major bump. Understanding this tells you how risky an upgrade is (Part 24 covers compatibility in depth).

#### Edge cases & failure modes

- **Committing `node_modules`** bloats the repository enormously; it must be in `.gitignore` and rebuilt from the lock file.
- **Not committing the lock file** means different machines install different versions, causing "works on my machine" bugs; always commit the lock file.
- **`npm install` in CI** can quietly update the lock file; use `npm ci` for reproducible builds.
- **Supply-chain risk**: a dependency (or one of its dependencies) can be malicious or compromised; this is a real attack vector (Part 39 — Security, 39.28). Audit with `npm audit` and be cautious adding dependencies.
- **Global vs local installs**: `npm install -g` installs system-wide; prefer local project dependencies so each project pins its own versions.
- **Version conflicts** when two dependencies need incompatible versions of a third; package managers resolve most but not all.

#### How a Senior Backend Engineer thinks about this

A senior always commits the lock file and uses `npm ci` in automated builds, because reproducibility — the exact same dependency set on every machine and every deploy — eliminates a whole class of "works on my machine" failures. They are deliberately conservative about adding dependencies: every dependency is code they now run and must trust, update and secure, so a small utility they could write in ten lines is not worth a new dependency and its own dependency tree. They run `npm audit` and keep an eye on supply-chain risk, and they understand semantic versioning well enough to judge whether an upgrade is routine or risky.

#### Common mistakes

- Committing `node_modules` to the repository.
- Not committing the lock file, causing version drift between machines.
- Using `npm install` instead of `npm ci` in CI, getting non-reproducible builds.
- Adding heavy dependencies for trivial needs, growing the attack surface and maintenance load.

#### Interview questions

1. **What is the purpose of the lock file (`package-lock.json`)?** It records the exact installed versions of every dependency so the same set is reproducible across machines and deploys.
2. **What is the difference between `npm install` and `npm ci`?** `install` installs per `package.json` and may update the lock file; `ci` installs exactly from the lock file and is used in CI for reproducibility.
3. **What does `^4.18.0` allow?** Any compatible `4.x.y` version at or above `4.18.0`, but not a breaking `5.0.0`; based on semantic versioning.
4. **What is supply-chain risk and how do you mitigate it?** A dependency or transitive dependency can be malicious or compromised; mitigate by minimizing dependencies, pinning versions via the lock file, running `npm audit`, and vetting what you add.

#### Practical exercise

Initialize a new Node project with `npm init -y`, install `express` as a dependency and `jest` as a dev dependency, and inspect `package.json` to see where each landed. Then delete `node_modules` and restore it with `npm ci`. Acceptance criteria: you can explain why `node_modules` is gitignored, what the lock file guarantees, and the difference between a dependency and a dev dependency.

## 4.7 SSH: reaching a remote server

### 4.7.1 Connecting securely to a machine you cannot touch

#### Concept

SSH (Secure Shell) is how you log into a remote server's command line over an encrypted connection. The server is in a data center; your laptop is wherever you are; SSH gives you a shell on that server as if you were sitting at it, with everything encrypted in transit. Almost every interaction with a production Linux server starts with SSH.

#### Why does it exist?

Servers have no keyboard or screen you can reach. You need a secure way to run commands on them from across the internet. Doing this in plain text would expose your commands and credentials to anyone listening on the network. SSH provides an encrypted, authenticated channel so you can operate a remote machine safely. It is the backbone of server administration and the transport underneath `git push` to many git servers.

#### Mental model

SSH is a secure phone line into the server's control room. Once connected, you speak commands and hear the server's replies, with the whole conversation scrambled so eavesdroppers hear nothing useful. The server checks it is really you (authentication) before letting you in, and your SSH client checks it is really the server (so you are not tricked into connecting to an imposter).

#### How it works

```bash
ssh alice@web-prod-1.example.com        # log in as alice to that host
ssh -i ~/.ssh/deploy_key alice@1.2.3.4  # use a specific private key
ssh -p 2222 alice@host                   # connect on a non-default port

# Once connected, you are at a shell on the remote machine. Type 'exit' to leave.

# Copy files to/from a server:
scp local.txt alice@host:/home/alice/    # copy a file up to the server
scp alice@host:/var/log/app.log ./       # copy a file down from the server
rsync -avz ./dist/ alice@host:/var/www/app/  # efficient sync of a directory
```

**Key-based authentication** is how SSH is done securely. Instead of a password, you generate a key pair: a **private key** that stays on your laptop (never shared) and a **public key** you put on the server. The server lets you in if you can prove you hold the matching private key. This is far more secure than passwords (which can be guessed or phished) and is the standard.

```bash
ssh-keygen -t ed25519 -C "alice@laptop"   # generate a key pair (ed25519 is modern, strong)
# This creates ~/.ssh/id_ed25519 (private, SECRET) and ~/.ssh/id_ed25519.pub (public, shareable)
ssh-copy-id alice@host                      # install your public key on the server
```

The private key is the most sensitive file you own — anyone with it can log in as you. It is stored `600` (owner-only, 4.2) and often protected with a passphrase. Never share it, never commit it, never email it.

#### Practical example — a deploy over SSH

A simple manual deploy (real deploys use CI/CD, Part 46, but this shows the primitives):

```bash
# Build locally, then copy the build up and restart the service on the server:
npm run build
rsync -avz ./dist/ alice@web-prod-1:/var/www/app/dist/
ssh alice@web-prod-1 "sudo systemctl restart myapp"
# One line that runs a command on the remote machine without an interactive session.
```

#### Edge cases & failure modes

- **Leaking the private key** (committing it, wrong permissions, sharing it) lets anyone impersonate you; treat it as the crown jewels, `600`, never shared.
- **"Host key verification failed"** means the server's identity changed since you last connected — either it was legitimately rebuilt, or you are being tricked (a man-in-the-middle). Investigate before blindly removing the old key.
- **Password authentication enabled** on a server invites brute-force attacks; production servers disable it and allow keys only.
- **Permissions too open on `~/.ssh`** (the key or the directory being group/world-readable) makes SSH refuse to use the key; it must be `600`/`700`.
- **Leaving sessions open** or using long-lived keys without rotation widens the window if a laptop is compromised.

#### How a Senior Backend Engineer thinks about this

A senior uses key-based SSH exclusively, protects the private key with a passphrase, and keeps `~/.ssh` locked down. They disable password authentication on servers they manage, because passwords are brute-forceable and keys are not. They treat the private key as the single most sensitive thing on their laptop and would rotate it immediately if the laptop were lost. They prefer deploying through automation (CI/CD) over manual SSH, reserving interactive SSH for investigation and emergencies, because manual steps are unrepeatable and error-prone, and every manual production action is a chance for a mistake. When they do SSH into production, they carry the same discipline from 4.1: check who and where they are first.

#### Common mistakes

- Committing or sharing a private key.
- Leaving password authentication enabled on production servers.
- Ignoring a "host key changed" warning that could signal an attack.
- Doing everything by hand over SSH instead of automating repeatable deploys.
- Wrong permissions on `~/.ssh` causing confusing authentication failures.

#### Interview questions

1. **How does key-based SSH authentication work and why is it better than passwords?** You hold a private key, the server has your public key, and you prove possession of the private key without sending it; it resists guessing, phishing and brute force in ways passwords do not.
2. **Which SSH key file is secret, and how is it protected?** The private key (`id_ed25519`); it stays on your machine only, with `600` permissions, ideally passphrase-protected.
3. **What does "host key verification failed" mean and why not ignore it?** The server's identity differs from what you recorded; it could be a legitimate rebuild or a man-in-the-middle attack, so investigate before trusting it.
4. **Why prefer automated deploys over manual SSH for production changes?** Automation is repeatable, reviewable and less error-prone; manual production steps are unrepeatable and a common source of mistakes.

#### Practical exercise

Generate an ed25519 SSH key pair, verify the private key has `600` permissions, and identify which of the two files you would put on a server and which you must keep secret. Then write the single `ssh` command that would run `uptime` on a remote host without opening an interactive session. Acceptance criteria: you correctly identify the public vs private key and can explain why the private key's permissions matter.
