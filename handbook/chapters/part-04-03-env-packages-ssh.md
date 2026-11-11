## 4.5 Environment variables

### 4.5.1 Configuring programs from the outside

#### Concept

An **environment variable** is a named value that the shell and every program it launches can read. They are the standard way to pass configuration into a program without changing its code — database URLs, API keys, which environment it is running in (`development`, `production`), the port to listen on. Your backend reads them at startup.

#### Why does it exist?

The same code runs on your laptop, in staging and in production, but it must connect to a different database and use different secrets in each. You cannot hardcode those values — that would mean a different build per environment, and secrets committed to source control. Environment variables solve this: the code reads `process.env.DATABASE_URL`, and each environment supplies a different value from the outside. This separation of configuration from code is a core principle of well-built applications (the "twelve-factor app", Part 48 — Docker for Backend Engineers, 48.9).

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

The `.env` file must be in `.gitignore` so it is never committed — it contains secrets. A committed `.env.example` with placeholder values documents which variables are needed without leaking the real ones. In production, secrets usually come from a secret manager (AWS Secrets Manager, Part 50.11) rather than a file on disk.

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

#### Worked answer to the exercise

Set up a small folder that is a git repository, with a `.env` and a `.gitignore`:

```bash
mkdir -p ~/practice/config-demo && cd ~/practice/config-demo
git init -q
printf 'PORT=4000\nAPI_KEY=test-key-not-real-123\n' > .env
echo '.env' >> .gitignore
```

The script, `config-check.js`:

```js
// config-check.js: read and validate configuration once, at startup.
const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);                 // env values are always strings
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be a whole number from 1 to 65535, got "${rawPort}"`);
}

const apiKey = process.env.API_KEY;
if (!apiKey) {                                // missing OR empty: both are wrong here
  throw new Error('API_KEY is required: add it to .env or set it in the environment');
}

console.log(`config ok: PORT=${port} (${typeof port}), API_KEY=${apiKey.slice(0, 4)}...`);
```

Node 20.6 and later can load a `.env` file itself with `--env-file`, so no library is needed. Run it with the key present, then delete the `API_KEY` line and run it again:

```bash
node --env-file=.env config-check.js
sed -i.bak '/^API_KEY=/d' .env          # delete the line (works with GNU and macOS sed; leaves .env.bak)
node --env-file=.env config-check.js
echo $?
git check-ignore -v .env
git status --short
```

```text
config ok: PORT=4000 (number), API_KEY=test...
/home/alice/practice/config-demo/config-check.js:10
  throw new Error('API_KEY is required: add it to .env or set it in the environment');
  ^

Error: API_KEY is required: add it to .env or set it in the environment
    at Object.<anonymous> (/home/alice/practice/config-demo/config-check.js:10:9)
    (more stack lines from Node's module loader)
1
.gitignore:1:.env	.env
?? .env.bak
?? .gitignore
?? config-check.js
```

Why it is right: the checks run on the first lines of the program, before anything else starts, so a missing key stops the process in milliseconds with a sentence that says what is wrong and how to fix it. The exit code `1` tells a process manager or CI that start-up failed. `Number(rawPort)` turns the string `'4000'` into the number `4000`, and the range check also catches `PORT=abc` (`NaN`) and an empty `PORT=` (which `Number` turns into `0`). Here `!apiKey` is the right test, unlike the quantity example in 1.1.3, because an empty key is just as invalid as a missing one. `git check-ignore -v` names the `.gitignore` line that ignores `.env`, and `.env` is absent from `git status`.

Look again at the last `git status`: `.env.bak` is listed. The backup `sed` made still contains the key, and `.gitignore` only ignores the exact name `.env`. Delete the backup (`rm .env.bak`), or ignore the whole family with a `.env*` line followed by `!.env.example`, so the committed example file still shows.

The trap most learners fall into is a variable that is still exported in the shell. Node's `--env-file` does not override variables that already exist in the environment, so if you ran `export API_KEY=...` earlier, deleting the line from `.env` changes nothing and the script still says `config ok`. Run `unset API_KEY` and try again. The second trap: adding `.env` to `.gitignore` after it was committed does not untrack it; you need `git rm --cached .env`, and you must rotate every secret in it (4.5.1).

Check it yourself: you should see one `config ok` line, then the error and exit code `1`, and `.env` never appears in `git status`. Commit a `.env.example` with placeholder values so teammates know which variables exist.

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

Versions follow `MAJOR.MINOR.PATCH` (for example `4.18.2`). A `MAJOR` bump may break compatibility; `MINOR` adds features compatibly; `PATCH` fixes bugs compatibly. The `^` in `^4.18.0` means "any `4.x.y` at or above this", allowing compatible updates but not a breaking major bump. Understanding this tells you how risky an upgrade is (Part 28 covers compatibility in depth).

#### Edge cases & failure modes

- **Committing `node_modules`** bloats the repository enormously; it must be in `.gitignore` and rebuilt from the lock file.
- **Not committing the lock file** means different machines install different versions, causing "works on my machine" bugs; always commit the lock file.
- **`npm install` in CI** can quietly update the lock file; use `npm ci` for reproducible builds.
- **Supply-chain risk**: a dependency (or one of its dependencies) can be malicious or compromised; this is a real attack vector (Part 44 — Security, 44.28). Audit with `npm audit` and be cautious adding dependencies.
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

#### Worked answer to the exercise

```bash
mkdir -p ~/practice/npm-demo && cd ~/practice/npm-demo
npm init -y                       # creates package.json with default values
npm install express               # a runtime dependency
npm install --save-dev jest       # a development-only dependency
echo 'node_modules/' > .gitignore
cat package.json
```

The interesting part of `package.json` afterwards (trimmed; your version numbers will be newer):

```json
{
  "name": "npm-demo",
  "version": "1.0.0",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "dependencies": {
    "express": "^5.1.0"
  },
  "devDependencies": {
    "jest": "^30.2.0"
  }
}
```

Now throw `node_modules` away and rebuild it from the lock file. `rm -rf` has no undo, so run `pwd` first and make sure you are inside `npm-demo`:

```bash
pwd                               # must print .../practice/npm-demo
rm -rf node_modules               # relative path, inside the demo folder only
npm ci
npm ls --depth=0
```

```text
/home/alice/practice/npm-demo
added 268 packages, and audited 269 packages in 5s
npm-demo@1.0.0 /home/alice/practice/npm-demo
├── express@5.1.0
└── jest@30.2.0
```

(Package counts and versions are approximate; they change with every release.)

The three explanations the acceptance criteria ask for:

- **Why `node_modules` is gitignored**: it is large (tens of megabytes even for this tiny project, mostly `jest` and its dependencies), it can contain files compiled for your operating system, and it can be rebuilt exactly from `package.json` plus `package-lock.json`. Committing it bloats every clone forever and causes conflicts on every upgrade.
- **What the lock file guarantees**: the exact version of every package in the tree, including the dependencies of your dependencies, plus an integrity hash for each one. `package.json` says "`express` at `^5.1.0` or a compatible newer version"; the lock file says "exactly 5.1.0, and this is what its files must hash to". `npm ci` installs precisely that, so your laptop, CI and production get identical code.
- **Dependency vs dev dependency**: `express` runs in production, so it is a dependency. `jest` is only needed to run tests on a developer machine or in CI, so it is a dev dependency, and `npm ci --omit=dev` (what a production Docker image should run) leaves it out.

The trap most learners fall into is forgetting `--save-dev` for tools like `jest`, `typescript` or `eslint`. They land in `dependencies`, get installed into every production image, and enlarge both the image and the attack surface (Part 44 — Security, 44.28). The second trap: editing `package.json` by hand and then running `npm ci`, which refuses to continue because `package.json` and `package-lock.json` disagree. Run `npm install` once to update the lock file, commit both files, and use `npm ci` from then on.

Check it yourself: `npm ls --depth=0` lists both packages after `npm ci`, and `npm ls --omit=dev --depth=0` lists only `express`.

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

A simple manual deploy (real deploys use CI/CD, Part 51, but this shows the primitives):

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

#### Worked answer to the exercise

Give the practice key its own file name with `-f`, so you cannot overwrite a real key you already use:

```bash
ssh-keygen -t ed25519 -C "alice@laptop-practice" -f ~/.ssh/practice_ed25519
```

```text
Generating public/private ed25519 key pair.
Enter passphrase (empty for no passphrase):
Enter same passphrase again:
Your identification has been saved in /home/alice/.ssh/practice_ed25519
Your public key has been saved in /home/alice/.ssh/practice_ed25519.pub
The key fingerprint is:
SHA256:yH3kPp0ExampleFingerprintOnlyNotARealKey0000 alice@laptop-practice
```

(A random-art picture follows, and newer OpenSSH versions word the passphrase prompt slightly differently.)

```bash
ls -l ~/.ssh/practice_ed25519 ~/.ssh/practice_ed25519.pub
```

```text
-rw------- 1 alice alice 464 Nov 11 10:40 /home/alice/.ssh/practice_ed25519
-rw-r--r-- 1 alice alice 103 Nov 11 10:40 /home/alice/.ssh/practice_ed25519.pub
```

- **`practice_ed25519.pub` is the public key.** It is the one you put on a server (it ends up as a line in `~/.ssh/authorized_keys` there; `ssh-copy-id` does that for you). It is safe to share: it lets a server check your identity, not impersonate you.
- **`practice_ed25519`, with no extension, is the private key.** It never leaves your machine. `ssh-keygen` already created it as `-rw-------` (600): read and write for you, nothing for anyone else.

The single command that runs `uptime` on a remote host and returns, without an interactive session:

```bash
ssh -i ~/.ssh/practice_ed25519 alice@web-prod-1.example.com uptime
```

```text
 10:41:12 up 41 days,  3:51,  0 users,  load average: 0.31, 0.28, 0.25
```

Everything after the host name is run on the remote machine; quote it when it has several words or special characters, for example `ssh alice@host 'df -h / && free -h'`.

Why the private key's permissions matter: anyone who can read that file can log in to every server that trusts it, as you, with no password. If it were `644`, any other user or compromised process on your laptop could copy it. SSH itself enforces this: if the key is readable by others it prints `WARNING: UNPROTECTED PRIVATE KEY FILE!` and `This private key will be ignored`, and refuses to use it. A passphrase adds a second lock: a stolen copy of the file is useless without it.

The trap most learners fall into is running plain `ssh-keygen -t ed25519` on a machine that already has `~/.ssh/id_ed25519` and answering `y` to "Overwrite?". The old private key is gone, and so is your access to every server and Git host that only knew the old public key. That is why this answer uses `-f`.

Check it yourself: `ssh-keygen -y -f ~/.ssh/practice_ed25519` rebuilds the public key from the private one and must print the same line as `cat ~/.ssh/practice_ed25519.pub`, which proves which file is which. When you are done practising, delete exactly these two files: `rm ~/.ssh/practice_ed25519 ~/.ssh/practice_ed25519.pub`.
