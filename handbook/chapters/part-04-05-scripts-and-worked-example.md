## 4.11 Your first shell script

### 4.11.1 Saving commands so you never type them twice

#### Concept

A **shell script** is a text file containing shell commands, run from top to bottom like a recipe. Anything you can type at the prompt can go in a script: `cd`, `curl`, `grep`, `if` checks, loops. Scripts turn a sequence you run often (check that the API is healthy, back up a database, deploy a build) into one command that does the same thing, the same way, every time.

#### Why does it exist?

Because people forget steps and make typos, especially at 2 a.m. A five-step manual check done from memory will eventually skip step three. A script never does. Scripts are also documentation: a new teammate can read `check-api.sh` and learn exactly how the team checks the API.

#### Mental model

Imagine a checklist taped inside a pilot's cockpit. The pilot knows how to fly, but before take-off they still read the list aloud, every item, every time. A shell script is a checklist that reads itself.

#### How it works

A minimal script, `check-api.sh`:

```bash
#!/usr/bin/env bash
# check-api.sh: is our API up, and is the products endpoint working?
set -euo pipefail                  # stop on errors, on unset variables, and on failures inside pipes

BASE_URL="${1:-http://localhost:3000}"   # first argument, or a default if none given

echo "Checking ${BASE_URL} ..."
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE_URL}/health")

if [ "$status" = "200" ]; then
  echo "health: OK"
else
  echo "health: FAILED with status ${status}" >&2   # >&2: print to stderr, the error stream
  exit 1                                           # non-zero exit code means failure
fi

count=$(curl -s --fail --max-time 5 "${BASE_URL}/products" | jq 'length')
echo "products: ${count} returned"
```

Line by line:

1. **`#!/usr/bin/env bash`** (the **shebang**) tells the system which program runs the file: bash, found on the `PATH`. It must be the very first line.
2. **`set -euo pipefail`** makes the script safe: `-e` stops at the first failing command, `-u` stops if you use a variable that was never set (a typo like `$BASEURL`), and `-o pipefail` makes a pipeline fail if any part of it fails, not only the last one.
3. **Variables**: `NAME="value"` with **no spaces around `=`**. Use them as `"$NAME"` or `"${NAME}"`, always in double quotes, so values with spaces stay in one piece.
4. **Arguments**: `$1`, `$2` are the first and second arguments; `${1:-default}` uses a default when the argument is missing; `$#` is the number of arguments.
5. **Command substitution**: `$(command)` runs a command and puts its output in a variable.
6. **`if [ ... ]; then ... fi`**: the spaces inside the brackets are required. `=` compares strings; `-eq`, `-gt`, `-lt` compare numbers; `-f file` tests whether a file exists; `-z "$x"` tests whether a string is empty.
7. **Exit codes**: every command returns a number when it finishes. `0` means success; anything else means failure. `exit 1` ends the script with failure, which CI systems and other scripts can detect. `echo $?` shows the exit code of the last command.

Run it:

```bash
chmod +x check-api.sh              # make it executable (72.2)
./check-api.sh                     # ./ means "the file in this directory"
./check-api.sh https://staging.shop.example
echo $?                            # 0 if all checks passed, 1 if health failed
```

A **loop** repeats commands, for example to wait until a server is up:

```bash
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s --fail --max-time 2 "${BASE_URL}/health" > /dev/null; then
    echo "up after ${attempt} attempt(s)"
    break
  fi
  echo "not up yet, waiting 3 s"
  sleep 3
done
```

#### Practical example — a log summary script

The pipeline from 4.4, saved so anyone on the team can run it:

```bash
#!/usr/bin/env bash
# top-errors.sh: the 10 most common error messages in a log file
set -euo pipefail

LOG_FILE="${1:?usage: top-errors.sh <log-file>}"   # :? stops with this message if no argument is given

if [ ! -f "$LOG_FILE" ]; then                       # ! means "not"
  echo "no such file: $LOG_FILE" >&2
  exit 1
fi

total=$(grep -c "ERROR" "$LOG_FILE" || true)        # grep exits 1 when nothing matches; || true keeps set -e happy
echo "errors in $LOG_FILE: $total"
grep "ERROR" "$LOG_FILE" | cut -d']' -f2 | sort | uniq -c | sort -rn | head -n 10
```

The `|| true` is worth understanding: `grep` returns exit code 1 when it finds nothing, which is not an error for this script, but `set -e` would stop the script there. `|| true` means "if the command on the left fails, run `true`, which always succeeds".

#### Edge cases & failure modes

- **Spaces around `=`**: `NAME = value` runs a command called `NAME`; write `NAME=value`.
- **Unquoted variables**: `rm -rf $DIR/` with an empty `$DIR` becomes `rm -rf /` (4.1). `set -u` and quoting `"$DIR"` prevent it; for destructive commands, also check the variable is not empty.
- **Missing shebang or `chmod +x`**: "Permission denied" or the wrong shell running the file.
- **Scripts that depend on the current directory**: use absolute paths, or `cd "$(dirname "$0")"` at the top to run relative to the script's own folder.
- **Windows line endings** (`\r`) produce errors like `$'\r': command not found`; convert with `dos2unix` or your editor.
- **Secrets in scripts**: never write passwords into a script that is committed to Git (Part 5); read them from environment variables (4.5).
- **Scripts that keep growing**: past about 100 lines with complex logic, a small Node.js or TypeScript script is easier to test and maintain.

#### How a Senior Backend Engineer thinks about this

A senior scripts anything they do twice and anything that must be done the same way every time, and starts every script with `set -euo pipefail`. They quote every variable, give every script a usage message and a non-zero exit on failure, and commit useful scripts to the repository (a `scripts/` or `ci/` folder) so they are reviewed like code. They also know when to stop: shell is excellent glue between programs, and a poor language for business logic.

#### Common mistakes

- No `set -euo pipefail`, so the script keeps going after a failure and does damage.
- Unquoted variables in `rm` or `mv`.
- `curl` without `--fail`, so a `500` looks like success.
- Hard-coded secrets and server names.

#### Interview questions

1. **What does `set -euo pipefail` do and why use it?** Stop on the first error, treat unset variables as errors, and fail a pipeline if any command in it fails; it stops scripts from continuing in a broken state.
2. **What is an exit code, and how does a script report failure?** A number every command returns; 0 is success; `exit 1` (or any non-zero) reports failure to whoever ran the script.
3. **Why quote variables in shell scripts?** Unquoted values with spaces split into several arguments, and empty values disappear, which can turn `rm "$DIR/"` into `rm /`.

#### Practical exercise

Write `wait-for-api.sh` that takes a base URL as its first argument (default `http://localhost:3000`), tries `GET /health` up to 20 times with 2 seconds between tries, prints how many attempts it took, and exits `0` when the API answers `200` or `1` after the last attempt. Acceptance criteria: the script starts with a shebang and `set -euo pipefail`; running it while the API is stopped exits `1` after about 40 seconds; starting the API halfway through makes it exit `0`; `echo $?` shows the right code in both cases.

## 4.12 Worked example: a night on call with only a terminal

This example strings the whole Part together. Every command in it has appeared in 4.1 to 4.11.

#### The page

At 01:52 you are paged: "Orders API error rate above 20 % for 5 minutes". You have a laptop, a terminal and SSH access to the API server `orders-api-2`.

#### Step 1: get in, and know where you are (4.7, 4.1)

```bash
ssh alice@orders-api-2.internal
whoami && hostname && date            # alice, orders-api-2, 01:54 UTC: the right machine, the right user
```

#### Step 2: check the gauges (4.9)

```bash
df -h /            # Use% 41%: disk fine
free -h            # available 2.9Gi of 7.7Gi: memory fine
uptime             # load average: 1.92, 1.88, 1.10 on 2 cores (nproc): busy, not overloaded
```

The machine is not the problem.

#### Step 3: is the process alive, and what is it doing? (4.3)

```bash
ps aux | grep '[n]ode dist/main.js'   # the [n] trick stops grep from matching itself
# alice 1874 38.0 9.2 ... node dist/main.js     <- running, normal CPU
```

#### Step 4: ask the API directly (4.10)

```bash
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' http://localhost:3000/health
# 200 0.004s
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' http://localhost:3000/orders?limit=5
# 500 5.012s                         <- orders fail, and they take 5 seconds to fail
```

The API is up, but `/orders` fails after exactly 5 seconds. Exactly 5 seconds smells like a timeout.

#### Step 5: read the logs with a pipeline (4.4, 4.8)

```bash
tail -n 2000 /var/log/orders-api/application.log | grep ERROR | cut -d']' -f2 | sort | uniq -c | sort -rn | head -n 3
#  612  Connection terminated due to connection timeout
#    9  Request validation failed
#    2  Payment provider returned 502
```

612 of the recent errors are database connection timeouts.

#### Step 6: check the dependency (4.10, 4.5)

```bash
env | grep -i '^DB_HOST'              # DB_HOST=orders-db.internal (from the environment, 72.5)
nc -vz -w 3 orders-db.internal 5432   # nc: test a TCP connection; -z: just connect, -w 3: 3 s timeout
# nc: connect to orders-db.internal port 5432 (tcp) timed out
```

The API server cannot reach the database at all. That is a network or database problem, not a code problem, and now you know which team to wake and exactly what to tell them: "from orders-api-2, TCP to orders-db.internal:5432 times out since about 01:47; the API is healthy otherwise."

#### Step 7: write it down as you go

```bash
history | tail -n 15 > ~/incident-2026-11-05.txt    # the exact commands you ran, for the incident notes
```

In the morning, the database team finds that a security-group change at 01:46 removed the API servers' access to port 5432 (Part 88.9 covers VPC networking). The postmortem's action items include an alert on database connection errors and a script, `ci/check-db-reachability.sh`, that runs the `nc` check from every API server after each infrastructure change.

#### What made this fast

| Step | Time | Ruled out |
|---|---|---|
| Who and where | 10 s | Wrong machine |
| Gauges | 30 s | Disk, memory, CPU |
| Process | 10 s | Crashed process |
| `curl` | 20 s | Whole API down; found the failing endpoint and the 5 s pattern |
| Log pipeline | 30 s | Guessing; found the error that dominates |
| `nc` | 15 s | Our code; found the broken dependency |

About two minutes of commands, each one answering one question and ruling something out. That is what command-line fluency buys you.

#### Practical exercise

Rehearse this night on your own machine with the API from Part 6.

Acceptance criteria:

- Stop PostgreSQL (`docker stop` on its container, Part 6), then use only the terminal to show: the API process is running, `/health` answers, a data endpoint fails, the log's most common error is a database connection error, and `nc -vz localhost 5432` fails.
- Start PostgreSQL again and show that the same `curl` now succeeds.
- Save the commands you used with `history` into a notes file, and turn steps 4 to 6 into a script with `set -euo pipefail` that prints one line per check.

## Senior Checklist — Part 4

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
- [ ] I can navigate the filesystem and read logs with tail -f and less
- [ ] I understand file permissions and lock secrets files to 600
- [ ] I can find, inspect and signal processes, preferring SIGTERM over SIGKILL
- [ ] I can compose pipelines to analyze logs (grep | sort | uniq -c | sort -rn)
- [ ] I configure apps with environment variables and keep .env out of git
- [ ] I commit lock files and use npm ci for reproducible builds
- [ ] I use key-based SSH and protect the private key
- [ ] I use Tab completion, Ctrl+R and history instead of retyping long commands, and keep secrets out of history
- [ ] I can edit a config file on a server with nano, after making a backup
- [ ] I can check disk, memory and load in a minute with df -h, du, free -h and uptime, and read each correctly
- [ ] I know why deleting an open log file does not free space, and how to fix a full disk safely
- [ ] I can test an API with curl -i, read JSON with jq, and find which process owns a port
- [ ] I can write a small shell script with a shebang, set -euo pipefail, quoted variables and a meaningful exit code

## Part 4 — Key Takeaways

- The command line is where backend engineers operate servers; fluency in it separates writing code from running systems.
- Always know who you are, where you are and which machine you are on before acting; `rm -rf` has no undo.
- Permissions control read/write/execute per owner/group/others; secrets files are `600` and apps run as a non-root user (least privilege).
- A process has a PID; manage it with `ps`, `top` and `kill`, always trying SIGTERM (graceful) before SIGKILL (forceful).
- Pipes compose small tools into powerful pipelines; `grep | sort | uniq -c | sort -rn | head` answers "most common X" for any log, and always `sort` before `uniq -c`.
- Configure applications with environment variables so one build runs everywhere; validate required ones at startup and never commit `.env`.
- Package managers install dependency trees reproducibly; commit the lock file, use `npm ci` in CI, and be conservative about adding dependencies (supply-chain risk).
- SSH gives an encrypted shell on a remote server; use key-based authentication, guard the private key as your most sensitive file, and prefer automated deploys over manual SSH.
- Let the shell type for you: Tab, Ctrl+R and Alt+. are faster and make fewer typos than you do.
- Check the gauges before the engine: `df -h`, `free -h` and `uptime` rule out the most common non-code outages in a minute.
- `curl -i` shows exactly what an API sent; check health, then the failing endpoint, then the log.
- Script anything you do twice, start with `set -euo pipefail`, quote every variable, and exit non-zero on failure.
