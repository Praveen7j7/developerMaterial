## 4.2 Permissions

### 4.2.1 Users, groups and file permissions

#### Concept

Linux controls who can read, change and run each file through **permissions**. Every file has an owner, a group, and three sets of permissions — for the owner, for the group, and for everyone else — each granting read, write and/or execute. This is why you sometimes get "Permission denied" and why servers are secure: not everyone can touch everything.

#### Why does it exist?

A server runs many programs for many purposes. You do not want your web application able to read every user's private files, or a compromised process able to rewrite system configuration. Permissions enforce the principle that each user and program can touch only what it needs. They are the first and most basic layer of security on a Linux system.

#### Mental model

Think of each file as a room with three kinds of visitor: the owner (you), members of a group (your team), and the general public (everyone else). For each kind, the room can allow looking (read), rearranging (write), or entering to use it (execute). Permissions are the sign on the door saying which visitors may do which of those three things.

#### How it works

Run `ls -l` and the first column shows the permissions:

```text
-rwxr-xr--  1 alice  devs  4096 Nov  4 09:30 deploy.sh
 \_/\_/\_/
  |  |  └── others: r-- (read only)
  |  └───── group (devs): r-x (read + execute)
  └──────── owner (alice): rwx (read + write + execute)
first char: - file, d directory, l symbolic link
```

Each triple is `r` (read), `w` (write), `x` (execute), or `-` if not granted. Read lets you see the contents; write lets you change them; execute lets you run the file as a program (for a directory, execute means "enter it").

Permissions also have a numeric form you will see everywhere: read is 4, write is 2, execute is 1, added together per triple. So `rwx` is 7, `r-x` is 5, `r--` is 4. The common sets:

```text
755  rwxr-xr-x   owner full, others read+execute  (scripts, programs, directories)
644  rw-r--r--   owner read+write, others read     (normal files, config)
600  rw-------    owner read+write, nobody else     (secrets like private keys, .env)
700  rwx------    owner full, nobody else           (private directories)
```

Changing permissions and ownership:

```bash
chmod +x deploy.sh      # add execute permission (so you can run ./deploy.sh)
chmod 644 config.json   # set exact permissions numerically
chmod 600 .env          # lock a secrets file to owner-only
chown alice:devs app.js # change owner to alice and group to devs
```

#### Root, sudo and least privilege

The `root` user can do anything, ignoring all permissions. You rarely log in as root; instead you run individual commands with `sudo` ("do this one thing as root"):

```bash
sudo systemctl restart myapp   # restart a service (needs root)
sudo apt install nginx          # install software (needs root)
```

The rule professionals live by is **least privilege**: run as a normal user, use `sudo` only for the specific commands that need it, and run your application as a dedicated non-root user. A backend process running as root means a bug in it can damage the whole server; the same bug in a locked-down `appuser` can damage only what that user owns.

#### Practical example — securing a secrets file

Your application reads database credentials from a `.env` file. That file must not be readable by other users on the server:

```bash
ls -l .env            # -rw-r--r--  -- BAD: others can read your DB password
chmod 600 .env        # fix: owner-only
ls -l .env            # -rw-------  -- now only the owner can read it
```

This one command is the difference between "our database password was in a file any process could read" and "it was locked down". Secrets files are always `600`.

#### Edge cases & failure modes

- **"Permission denied" running a script**: it lacks execute permission; `chmod +x script.sh`.
- **A world-readable secrets file** (`644`) leaks credentials to any user or process on the box; use `600`.
- **Running the app as root** so a compromise gives an attacker the whole machine; run as a dedicated user.
- **`chmod 777`** (everyone can do everything) is almost always wrong and a security red flag; it is a lazy "fix" that opens the file to all.
- **Ownership mismatches** after copying files as root, so the app user cannot read its own files; fix with `chown`.

#### How a Senior Backend Engineer thinks about this

A senior applies least privilege reflexively: the application runs as a non-root user, secrets files are `600`, and `sudo` is used only where genuinely required. They see `chmod 777` as a smell that someone did not understand the actual permission needed and papered over it. When a process gets "permission denied", they diagnose the exact missing permission rather than escalating to root, because escalating to root turns a small access problem into a large security problem. On any server, "who owns this and who can read it" is a question they ask about every sensitive file.

#### Common mistakes

- `chmod 777` to make an error go away, opening files to everyone.
- Leaving secrets files world-readable (`644` instead of `600`).
- Running the application as root.
- Fixing "permission denied" by prefixing everything with `sudo` instead of fixing ownership.

#### Interview questions

1. **What do the three permission triples represent?** Owner, group, others; each with read (4), write (2), execute (1).
2. **What permissions should a secrets file like a private key or `.env` have, and why?** `600` (owner read/write only), so no other user or process on the machine can read the credentials.
3. **What is least privilege and how does it apply to running a backend?** Grant only the access needed; run the app as a dedicated non-root user so a compromise is contained, and use `sudo` only for specific privileged commands.
4. **Why is `chmod 777` a red flag?** It grants everyone full access, usually masks a misunderstanding of the real permission needed, and is a security risk.

#### Practical exercise

Create a script `hello.sh` that echoes a message, try to run it (it fails without execute permission), add execute permission, and run it successfully. Then create a fake secrets file, set it to `600`, and verify with `ls -l` that only you can read it. Acceptance criteria: you can explain each permission bit in the `ls -l` output for both files.

## 4.3 Processes

### 4.3.1 Viewing and managing running programs

#### Concept

A **process** is a running program. Your backend server is a process; the database is a process; the shell itself is a process. Each has an id (a PID), an owner, and resource usage. Managing processes — seeing what is running, how much memory and CPU it uses, and stopping it — is core to operating a server. Part 9 covers processes and threads at the operating-system level; here we cover the day-to-day commands.

#### Why does it exist?

When your server misbehaves — using all the memory, stuck, or needing a restart — you work with it as a process. "Is it even running? What is its PID? How much memory is it using? Why is the CPU at 100 percent?" are questions you answer with process commands. Without them you are blind to what the machine is actually doing.

#### Mental model

A process is a worker the operating system hired to run one program. The OS keeps a roster of all its workers with id badges (PIDs), what each is doing, and how many resources (CPU time, memory) each is consuming. The process commands let you read that roster, find a specific worker, and, if one is misbehaving, tell it to stop — politely at first, forcefully if it ignores you.

#### How it works

```bash
ps aux                  # list all processes (user, PID, CPU%, MEM%, command)
ps aux | grep node      # find processes whose command mentions 'node'
top                     # live, updating view of processes by resource use (q to quit)
htop                    # a nicer top, if installed
```

A line from `ps aux`:

```text
USER   PID  %CPU %MEM    VSZ   RSS  STAT  START  TIME COMMAND
alice 4521  3.2  8.1  985000 332000  Sl   09:30  2:14 node dist/main.js
#     ^PID              ^virtual ^actual memory         ^the command
```

The **PID** (4521) is the id you use to signal the process. **%MEM** and **RSS** tell you memory use (RSS is the actual physical memory). **%CPU** tells you CPU use. For a Node process eating memory, this is where you see it.

**Signals** are how you communicate with a process. The main ones:

```bash
kill 4521            # send SIGTERM: "please shut down gracefully"
kill -9 4521         # send SIGKILL: "stop immediately, no cleanup" (last resort)
kill -HUP 4521       # send SIGHUP: often "reload your config"
```

The difference between `kill` (SIGTERM) and `kill -9` (SIGKILL) is important. SIGTERM asks the process to shut down cleanly — finish in-flight requests, close database connections, flush logs. A well-written server catches SIGTERM and does exactly that (graceful shutdown, Part 30 — Reliability Engineering, 30.13). SIGKILL cannot be caught; it stops the process instantly, mid-request, leaving connections dangling. Always try SIGTERM first; use SIGKILL only when a process ignores SIGTERM.

#### Foreground, background and jobs

```bash
node server.js          # runs in the foreground, ties up your terminal
node server.js &        # runs in the background, gives you the prompt back
jobs                    # list background jobs started in this shell
fg                      # bring the most recent background job to the foreground
nohup node server.js &  # keep running even after you log out
Ctrl+C                  # send SIGINT: stop the foreground process
Ctrl+Z                  # suspend the foreground process (resume with fg)
```

For real servers you do not run processes with `&`; you use a process manager (`systemd`, or `pm2` for Node, or a container orchestrator like Kubernetes, Part 44) that restarts them on crash and starts them on boot. But knowing the manual commands helps you understand what those managers do.

#### Practical example — diagnosing a stuck server

Your Node server is not responding. You investigate:

```bash
ps aux | grep node                     # is it running? what PID?
# alice 4521 99.0 8.1 ... node dist/main.js   <- 99% CPU, stuck in a loop
top                                     # confirm it is pegging a CPU
kill 4521                               # ask it to shut down gracefully
# if it does not stop within ~10 seconds:
kill -9 4521                            # force it
# then the process manager restarts it, or you restart it
```

The 99% CPU is the tell: the Node event loop is blocked by a synchronous computation (Part 2), so the process is alive but unresponsive. The process commands let you see it, confirm it, and recover it.

#### Edge cases & failure modes

- **A zombie or stuck process** that ignores SIGTERM needs SIGKILL, but SIGKILL skips cleanup (dangling connections, unflushed data).
- **`kill -9` on a database** can corrupt data by skipping its shutdown; always prefer graceful shutdown for stateful processes.
- **Orphaned background jobs** from `&` keep running after you log out only with `nohup` or a process manager; otherwise they may be killed when your session ends.
- **OOM killer**: when the server runs out of memory, Linux kills a process to survive, often your app; you find "Killed" in logs and an OOM message in `dmesg` (Part 9, Part 44).
- **High load average** (from `uptime`/`top`) means more work queued than CPUs can handle; a sustained load above the core count signals saturation.

#### How a Senior Backend Engineer thinks about this

A senior reaches for `ps`, `top` and `kill` as naturally as a mechanic reaches for a wrench. They always try SIGTERM before SIGKILL so processes shut down cleanly, and they design their own servers to handle SIGTERM gracefully (drain requests, close connections) because orchestrators send SIGTERM on every deploy and scale-down. They read `top` to tell apart a CPU problem (one core pegged, event loop blocked) from a memory problem (RSS climbing toward the limit) from a load problem (many processes queued). On production they rely on a process manager rather than manual `&`, but they understand the primitives underneath.

#### Common mistakes

- Reaching for `kill -9` first, skipping graceful shutdown and dropping in-flight work.
- `kill -9` on a database or other stateful process, risking corruption.
- Running production servers with `&` instead of a process manager, so they do not restart on crash or boot.
- Not implementing SIGTERM handling, so deploys kill requests mid-flight.

#### Interview questions

1. **What is the difference between SIGTERM and SIGKILL?** SIGTERM (`kill`) asks for a graceful shutdown and can be caught; SIGKILL (`kill -9`) stops the process instantly and cannot be caught. Always try SIGTERM first.
2. **How do you find which process is using all the CPU or memory?** `top`/`htop` for a live view, `ps aux` sorted or grepped for a specific program; read %CPU and RSS.
3. **Why should a backend handle SIGTERM?** Orchestrators and process managers send SIGTERM on deploy and scale-down; handling it lets the server finish in-flight requests and close connections cleanly instead of dropping them.
4. **What is the OOM killer?** When memory runs out, Linux kills a process to survive, often the app; you diagnose it from "Killed" in logs and OOM messages in the kernel log.

#### Practical exercise

Start a long-running command (for example a script that sleeps in a loop) in the foreground, suspend it with Ctrl+Z, resume it in the background, list jobs, then find its PID with `ps` and stop it with `kill` (SIGTERM). Acceptance criteria: you stop it with SIGTERM, not SIGKILL, and can explain when you would have needed SIGKILL instead.

## 4.4 Pipes, redirection and text tools

### 4.4.1 Composing commands

#### Concept

The real power of the command line is combining small commands into pipelines. A **pipe** (`|`) sends the output of one command as the input of the next. **Redirection** (`>`, `>>`, `<`) sends output to or input from a file. With a handful of text tools (`grep`, `sort`, `uniq`, `wc`, `cut`, `awk`) joined by pipes, you can answer questions about logs and data that would otherwise need a program.

#### Why does it exist?

Each Unix tool does one thing well: `grep` filters lines, `sort` orders them, `uniq` removes duplicates, `wc` counts. Rather than build one giant program, Unix lets you chain these small tools together so the combination does something none of them does alone. "How many unique IP addresses hit my error endpoint today?" is one pipeline of four tools, written in seconds. This composability is the core philosophy of the command line.

#### Mental model

Think of an assembly line where each station does one operation and passes the result to the next. Raw material (a log file) enters, `grep` filters out everything irrelevant, `cut` keeps one column, `sort` orders it, `uniq -c` counts duplicates, and the finished product (a count per value) comes out the end. The pipe `|` is the conveyor belt between stations. You build the line by naming the stations in order.

#### How it works

Every program has three standard streams: **stdin** (input), **stdout** (normal output), and **stderr** (error output). Pipes and redirection connect these.

```bash
command1 | command2        # stdout of command1 becomes stdin of command2
command > file.txt         # write stdout to a file (overwrites)
command >> file.txt        # append stdout to a file
command 2> errors.txt      # write stderr to a file
command > out.txt 2>&1      # write both stdout and stderr to one file
command < input.txt        # read stdin from a file
```

The essential text tools:

```bash
grep "error" app.log            # lines containing "error"
grep -i "error" app.log         # case-insensitive
grep -v "health" app.log        # lines NOT containing "health" (invert)
grep -c "error" app.log         # count matching lines
sort                            # sort lines
sort -n                         # sort numerically
uniq                            # collapse adjacent duplicate lines
uniq -c                         # count occurrences (needs sorted input)
wc -l                           # count lines
cut -d',' -f2                   # the 2nd comma-separated field of each line
head -n 10 / tail -n 10         # first / last 10 lines
```

#### Practical example — analyzing a log file

These are real pipelines a backend engineer runs during an incident. Read each left to right as an assembly line.

```bash
# How many errors in the log today?
grep -c "ERROR" app.log

# Which error messages are most common? (top 10)
grep "ERROR" app.log | cut -d']' -f2 | sort | uniq -c | sort -rn | head -n 10

# How many requests per status code? (assuming status is field 9)
cut -d' ' -f9 access.log | sort | uniq -c | sort -rn

# Watch for errors live as they happen:
tail -f app.log | grep --line-buffered "ERROR"

# How many unique IPs hit the login endpoint? (field 1 is the IP)
grep "/login" access.log | cut -d' ' -f1 | sort | uniq | wc -l
```

The second pipeline is the pattern to internalize: `grep` to filter, `cut` to extract a field, `sort` then `uniq -c` to count occurrences, `sort -rn` to rank, `head` to take the top. That one pattern answers "what are the most common X" for almost any log. You will use it hundreds of times.

#### Searching the filesystem

```bash
find . -name "*.ts"             # all TypeScript files under the current dir
find . -name "*.log" -mtime +7  # .log files modified more than 7 days ago
find /var/log -size +100M       # files larger than 100 MB
grep -r "TODO" src/             # recursively search file contents for "TODO"
grep -rn "apiKey" .             # recursive, with line numbers (find leaked secrets!)
```

#### Edge cases & failure modes

- **`uniq` only collapses adjacent lines**, so you must `sort` first or it misses non-adjacent duplicates. This is the most common `uniq` mistake.
- **`>` overwrites** the target file immediately; `command > important.log` destroys `important.log` even if the command fails. Use `>>` to append when you mean to add.
- **Errors go to stderr**, so `command | grep ...` does not filter error messages unless you redirect `2>&1`.
- **Huge files**: a pipeline over a multi-gigabyte file is fine (it streams), but `sort` on a huge file uses a lot of memory and temp space.
- **Fields shift**: `cut -f` assumes a consistent delimiter; log lines with variable spacing break simple `cut`, where `awk` is more robust.

#### How a Senior Backend Engineer thinks about this

A senior treats the shell as a data-analysis tool, not just a way to launch programs. During an incident, instead of downloading logs and opening them in an editor, they answer the question in place with a pipeline — the most common error, the status-code breakdown, the top offending IPs — in seconds. They always `sort` before `uniq -c`, always use `>>` when they mean append, and reach for `awk` when `cut` is too fragile. This fluency is a genuine force multiplier: the engineer who can interrogate a log with a one-line pipeline diagnoses incidents far faster than one who cannot.

#### Common mistakes

- `uniq` without `sort` first, missing non-adjacent duplicates.
- `>` when you meant `>>`, overwriting a file you wanted to append to.
- Forgetting that errors go to stderr and are not caught by a plain pipe to `grep`.
- Opening a huge log in an editor instead of filtering it with a pipeline.

#### Interview questions

1. **What does a pipe (`|`) do?** Connects one command's stdout to the next command's stdin, letting you compose small tools into a pipeline.
2. **Why must you `sort` before `uniq -c`?** `uniq` only collapses adjacent duplicate lines; sorting groups all duplicates together so the count is correct.
3. **Write a pipeline to find the ten most common error messages in a log.** `grep ERROR app.log | sort | uniq -c | sort -rn | head -n 10` (extracting the message field with `cut`/`awk` as needed).
4. **What is the difference between `>` and `>>`?** `>` overwrites the file; `>>` appends to it.
5. **How do you capture both normal and error output to one file?** `command > out.txt 2>&1`.

#### Practical exercise

Given a web access log, write pipelines to answer: how many total requests, how many returned a `5xx` status, which three URLs were requested most often, and how many unique IP addresses appeared. Acceptance criteria: each is a single pipeline, you `sort` before any `uniq -c`, and you can explain what each stage of the pipeline does.
